import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NativeTranscriptTurn, RelayMessage } from "../domain.ts";
import { AppServerError, WebSocketAppServerConnection } from "../harnesses/codex-app-server.ts";
import { readStream, stopProcessTree } from "../services/process-runner.ts";
import { trackManagedProcess } from "../services/process-registry.ts";
import { NativeSessionUnavailable } from "./errors.ts";
import type { NativeTuiCommand } from "./pty-host.ts";

type JsonObject = Record<string, unknown>;

const asObject = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === "object" ? (value as JsonObject) : undefined;

const reservePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a Codex loopback port"));
        return;
      }
      server.close((cause) => (cause ? reject(cause) : resolve(address.port)));
    });
  });

const waitForServer = async (
  remoteUrl: string,
  token: string,
  child: ReturnType<typeof Bun.spawn>,
  stderr: () => string,
  signal?: AbortSignal,
) => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (child.exitCode !== null) {
      throw new Error(`Codex app-server exited with code ${child.exitCode}\n${stderr()}`.trim());
    }
    const connection = await WebSocketAppServerConnection.connect(remoteUrl, token, 250).catch(
      () => undefined,
    );
    if (connection) {
      await connection.close();
      return;
    }
    await Bun.sleep(25);
  }
  throw new Error("Timed out starting the Codex app-server websocket");
};

const threadIdFrom = (value: unknown) => {
  const thread = asObject(asObject(value)?.thread);
  if (typeof thread?.id !== "string") throw new Error("Codex did not return a thread id");
  return thread.id;
};

const threadStatusFrom = (value: unknown) => {
  const status = asObject(asObject(asObject(value)?.thread)?.status);
  return typeof status?.type === "string" ? status.type : undefined;
};

export const codexThreadAllowsDetach = (value: unknown) => {
  const status = threadStatusFrom(value);
  return status === "idle" || status === "notLoaded" || status === "systemError";
};

const threadCwdFrom = (value: unknown) => {
  const cwd = asObject(asObject(value)?.thread)?.cwd;
  return typeof cwd === "string" ? cwd : undefined;
};

const stringDataFrom = (value: unknown) => {
  const data = asObject(value)?.data;
  return Array.isArray(data) ? data.filter((item): item is string => typeof item === "string") : [];
};

const listedThreadIdsFrom = (value: unknown) => {
  const data = asObject(value)?.data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((item) => {
    const thread = asObject(item);
    return typeof thread?.id === "string" ? [thread.id] : [];
  });
};

export const selectResolvedCodexSession = (input: {
  readonly loaded: ReadonlyArray<string>;
  readonly baseline: ReadonlySet<string>;
  readonly recency: ReadonlyArray<string>;
  readonly fallback?: string;
}) => {
  const eligible = new Set(
    input.loaded.filter((id) => !input.baseline.has(id) || id === input.fallback),
  );
  return input.recency.find((id) => eligible.has(id)) ?? [...eligible].at(-1) ?? input.fallback;
};

const isMissingCodexSession = (cause: unknown, sessionId: string) =>
  cause instanceof AppServerError &&
  cause.code === -32600 &&
  cause.message === `no rollout found for thread id ${sessionId}`;

const extractText = (content: unknown) =>
  Array.isArray(content)
    ? content
        .flatMap((item) => {
          const value = asObject(item);
          return value?.type === "text" && typeof value.text === "string" ? [value.text] : [];
        })
        .join("")
        .trim()
    : "";

export const parseCodexNativeTurns = (value: unknown): ReadonlyArray<NativeTranscriptTurn> => {
  const thread = asObject(asObject(value)?.thread);
  if (!Array.isArray(thread?.turns)) return [];

  return thread.turns.flatMap((candidate) => {
    const turn = asObject(candidate);
    if (typeof turn?.id !== "string" || turn.status !== "completed" || !Array.isArray(turn.items))
      return [];
    let prompt = "";
    let response = "";
    for (const candidateItem of turn.items) {
      const item = asObject(candidateItem);
      if (item?.type === "userMessage") prompt = extractText(item.content);
      if (
        item?.type === "agentMessage" &&
        typeof item.text === "string" &&
        item.phase !== "commentary"
      ) {
        response = item.text.trim();
      }
    }
    return prompt && response ? [{ id: turn.id, prompt, response }] : [];
  });
};

const handoffItems = (
  messages: ReadonlyArray<RelayMessage>,
  omittedMessages = 0,
): ReadonlyArray<JsonObject> => [
  ...(omittedMessages > 0
    ? [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Relay omitted or truncated ${omittedMessages} older message${omittedMessages === 1 ? "" : "s"} to keep this handoff within its context budget. The complete canonical transcript is available through \`relay history\` if the retained context and current workspace are insufficient.`,
            },
          ],
        },
      ]
    : []),
  ...messages.map((message) =>
    message.role === "user"
      ? {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: message.content }],
        }
      : {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: message.content }],
        },
  ),
];

export class CodexNativeBackend {
  readonly #child: ReturnType<typeof Bun.spawn>;
  readonly #runtimeDirectory: string;
  readonly #remoteUrl: string;
  readonly #token: string;
  readonly #executable: string;
  readonly #cwd: string;
  #baselineLoaded = new Set<string>();
  #closed = false;

  private constructor(input: {
    child: ReturnType<typeof Bun.spawn>;
    runtimeDirectory: string;
    remoteUrl: string;
    token: string;
    executable: string;
    cwd: string;
  }) {
    this.#child = input.child;
    this.#runtimeDirectory = input.runtimeDirectory;
    this.#remoteUrl = input.remoteUrl;
    this.#token = input.token;
    this.#executable = input.executable;
    this.#cwd = input.cwd;
  }

  static async start(executable: string, cwd: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "relay-codex-"));
    await chmod(runtimeDirectory, 0o700);
    const token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    const tokenPath = join(runtimeDirectory, "token");
    await writeFile(tokenPath, token, { encoding: "utf8", mode: 0o600 });
    const remoteUrl = `ws://127.0.0.1:${await reservePort()}`;
    const child = Bun.spawn(
      [
        executable,
        "app-server",
        "--listen",
        remoteUrl,
        "--ws-auth",
        "capability-token",
        "--ws-token-file",
        tokenPath,
      ],
      {
        cwd,
        env: Bun.env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        detached: process.platform !== "win32",
      },
    );
    await trackManagedProcess(child, "codex-native-backend");
    let stderr = "";
    if (child.stdout instanceof ReadableStream) void readStream(child.stdout, { limit: 128_000 });
    if (child.stderr instanceof ReadableStream) {
      void readStream(child.stderr, { limit: 128_000 }).then((value) => (stderr = value));
    }
    let terminating: Promise<void> | undefined;
    const terminate = () => (terminating ??= stopProcessTree(child));
    const onAbort = () => void terminate();
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      signal?.throwIfAborted();
      await waitForServer(remoteUrl, token, child, () => stderr, signal);
      return new CodexNativeBackend({
        child,
        runtimeDirectory,
        remoteUrl,
        token,
        executable,
        cwd,
      });
    } catch (cause) {
      await terminate();
      await rm(runtimeDirectory, { recursive: true, force: true });
      throw cause;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  get remoteUrl() {
    return this.#remoteUrl;
  }

  async #connect() {
    if (this.#closed) throw new Error("Codex native backend is closed");
    return WebSocketAppServerConnection.connect(this.#remoteUrl, this.#token, 30_000);
  }

  async ensureSession(input: { sessionId?: string; model?: string }) {
    if (!input.sessionId) {
      throw new Error(
        "An empty Codex thread cannot be resumed; use prepareSession so the native TUI creates it",
      );
    }
    const connection = await this.#connect();
    try {
      const result = await connection
        .request("thread/resume", {
          threadId: input.sessionId,
          cwd: this.#cwd,
          ...(input.model ? { model: input.model } : {}),
        })
        .catch((cause) => {
          if (isMissingCodexSession(cause, input.sessionId!)) {
            throw new NativeSessionUnavailable("codex", input.sessionId!, cause.message);
          }
          throw cause;
        });
      const sessionId = threadIdFrom(result);
      const loaded = await connection.request("thread/loaded/list", {});
      this.#baselineLoaded = new Set(stringDataFrom(loaded));
      return sessionId;
    } finally {
      await connection.close();
    }
  }

  /**
   * Codex does not persist a newly started empty thread. A cold handoff must be
   * injected on the same connection; a truly empty task must be created by the
   * native TUI itself.
   */
  async prepareSession(input: {
    sessionId?: string;
    model?: string;
    handoff: ReadonlyArray<RelayMessage>;
    handoffOmittedMessages?: number;
  }): Promise<{ sessionId?: string; handoffInjected: boolean }> {
    if (input.sessionId) {
      return {
        sessionId: await this.ensureSession({
          sessionId: input.sessionId,
          ...(input.model ? { model: input.model } : {}),
        }),
        handoffInjected: false,
      };
    }

    const connection = await this.#connect();
    try {
      const loaded = await connection.request("thread/loaded/list", {});
      this.#baselineLoaded = new Set(stringDataFrom(loaded));
      if (input.handoff.length === 0) return { handoffInjected: false };

      const result = await connection.request("thread/start", {
        cwd: this.#cwd,
        ephemeral: false,
        ...(input.model ? { model: input.model } : {}),
      });
      const sessionId = threadIdFrom(result);
      await connection.request("thread/inject_items", {
        threadId: sessionId,
        items: handoffItems(input.handoff, input.handoffOmittedMessages),
      });
      this.#baselineLoaded.add(sessionId);
      return { sessionId, handoffInjected: true };
    } finally {
      await connection.close();
    }
  }

  async inject(sessionId: string, messages: ReadonlyArray<RelayMessage>, omittedMessages = 0) {
    if (messages.length === 0) return;
    const connection = await this.#connect();
    try {
      await connection.request("thread/resume", { threadId: sessionId, cwd: this.#cwd });
      await connection.request("thread/inject_items", {
        threadId: sessionId,
        items: handoffItems(messages, omittedMessages),
      });
    } finally {
      await connection.close();
    }
  }

  async read(sessionId: string) {
    const connection = await this.#connect();
    try {
      const result = await connection
        .request("thread/read", {
          threadId: sessionId,
          includeTurns: true,
        })
        .catch((cause) => {
          if (cause instanceof Error && cause.message.includes("is not materialized yet")) {
            return { thread: { turns: [] } };
          }
          if (isMissingCodexSession(cause, sessionId)) {
            throw new NativeSessionUnavailable("codex", sessionId, cause.message);
          }
          throw cause;
        });
      const cwd = threadCwdFrom(result);
      return {
        turns: parseCodexNativeTurns(result),
        hiddenTurnIds: [],
        ...(cwd ? { cwd } : {}),
      };
    } finally {
      await connection.close();
    }
  }

  async sessionCwd(sessionId: string) {
    const connection = await this.#connect();
    try {
      const result = await connection.request("thread/read", {
        threadId: sessionId,
        includeTurns: false,
      });
      return threadCwdFrom(result);
    } finally {
      await connection.close();
    }
  }

  async isIdle(sessionId?: string) {
    const connection = await this.#connect();
    try {
      if (!sessionId) {
        const loaded = stringDataFrom(await connection.request("thread/loaded/list", {}));
        for (const threadId of loaded) {
          const result = await connection.request("thread/read", {
            threadId,
            includeTurns: false,
          });
          if (!codexThreadAllowsDetach(result)) return false;
        }
        return true;
      }
      const result = await connection
        .request("thread/read", {
          threadId: sessionId,
          includeTurns: false,
        })
        .catch((cause) => {
          if (cause instanceof Error && cause.message.includes("is not materialized yet")) {
            return { thread: { status: { type: "idle" } } };
          }
          throw cause;
        });
      return codexThreadAllowsDetach(result);
    } finally {
      await connection.close();
    }
  }

  async isMaterialized(sessionId: string) {
    const connection = await this.#connect();
    try {
      await connection.request("thread/read", {
        threadId: sessionId,
        includeTurns: false,
      });
      return true;
    } catch (cause) {
      if (cause instanceof Error && cause.message.includes("is not materialized yet")) return false;
      throw cause;
    } finally {
      await connection.close();
    }
  }

  /** Detects /new or /resume inside the native TUI without intercepting either command. */
  async resolveSession(fallbackSessionId?: string) {
    const connection = await this.#connect();
    try {
      const loaded = stringDataFrom(await connection.request("thread/loaded/list", {}));
      const listed = await connection.request("thread/list", {
        cwd: [this.#cwd],
        limit: 100,
        sortKey: "recency_at",
        sortDirection: "desc",
      });
      return selectResolvedCodexSession({
        loaded,
        baseline: this.#baselineLoaded,
        recency: listedThreadIdsFrom(listed),
        ...(fallbackSessionId ? { fallback: fallbackSessionId } : {}),
      });
    } finally {
      await connection.close();
    }
  }

  async delete(sessionId: string) {
    const connection = await this.#connect();
    try {
      await connection.request("thread/delete", { threadId: sessionId });
    } finally {
      await connection.close();
    }
  }

  command(sessionId?: string, model?: string): NativeTuiCommand {
    return {
      executable: this.#executable,
      args: sessionId
        ? [
            "resume",
            "--remote",
            this.remoteUrl,
            "--remote-auth-token-env",
            "RELAY_CODEX_AUTH_TOKEN",
            "-C",
            this.#cwd,
            ...(model ? ["--model", model] : []),
            sessionId,
          ]
        : [
            "--remote",
            this.remoteUrl,
            "--remote-auth-token-env",
            "RELAY_CODEX_AUTH_TOKEN",
            "-C",
            this.#cwd,
            ...(model ? ["--model", model] : []),
          ],
      cwd: this.#cwd,
      env: { RELAY_CODEX_AUTH_TOKEN: this.#token },
    };
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    await stopProcessTree(this.#child);
    await rm(this.#runtimeDirectory, { recursive: true, force: true });
  }
}
