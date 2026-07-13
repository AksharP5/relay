import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NativeTranscriptTurn, RelayMessage } from "../domain.ts";
import { WebSocketAppServerConnection } from "../harnesses/codex-app-server.ts";
import { readStream } from "../services/process-runner.ts";
import type { NativeTuiCommand } from "./pty-host.ts";

type JsonObject = Record<string, unknown>;

const asObject = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === "object" ? (value as JsonObject) : undefined;

const stopChild = async (child: ReturnType<typeof Bun.spawn>) => {
  if (child.exitCode !== null) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await Promise.race([child.exited, Bun.sleep(1_000)]);
  if (child.exitCode === null) {
    try {
      if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
    await child.exited.catch(() => undefined);
  }
};

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
) => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
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

const handoffItems = (messages: ReadonlyArray<RelayMessage>): ReadonlyArray<JsonObject> =>
  messages.map((message) =>
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
  );

export class CodexNativeBackend {
  readonly #child: ReturnType<typeof Bun.spawn>;
  readonly #runtimeDirectory: string;
  readonly #remoteUrl: string;
  readonly #token: string;
  readonly #executable: string;
  readonly #cwd: string;
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

  static async start(executable: string, cwd: string) {
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
    let stderr = "";
    if (child.stdout instanceof ReadableStream) void readStream(child.stdout, { limit: 128_000 });
    if (child.stderr instanceof ReadableStream) {
      void readStream(child.stderr, { limit: 128_000 }).then((value) => (stderr = value));
    }

    try {
      await waitForServer(remoteUrl, token, child, () => stderr);
      return new CodexNativeBackend({
        child,
        runtimeDirectory,
        remoteUrl,
        token,
        executable,
        cwd,
      });
    } catch (cause) {
      await stopChild(child);
      await rm(runtimeDirectory, { recursive: true, force: true });
      throw cause;
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
    const connection = await this.#connect();
    try {
      const result = input.sessionId
        ? await connection.request("thread/resume", {
            threadId: input.sessionId,
            cwd: this.#cwd,
            ...(input.model ? { model: input.model } : {}),
          })
        : await connection.request("thread/start", {
            cwd: this.#cwd,
            ephemeral: false,
            ...(input.model ? { model: input.model } : {}),
          });
      return threadIdFrom(result);
    } finally {
      await connection.close();
    }
  }

  async inject(sessionId: string, messages: ReadonlyArray<RelayMessage>) {
    if (messages.length === 0) return;
    const connection = await this.#connect();
    try {
      await connection.request("thread/resume", { threadId: sessionId, cwd: this.#cwd });
      await connection.request("thread/inject_items", {
        threadId: sessionId,
        items: handoffItems(messages),
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
          throw cause;
        });
      return parseCodexNativeTurns(result);
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

  command(sessionId: string, model?: string): NativeTuiCommand {
    return {
      executable: this.#executable,
      args: [
        "resume",
        "--remote",
        this.remoteUrl,
        "--remote-auth-token-env",
        "RELAY_CODEX_AUTH_TOKEN",
        "-C",
        this.#cwd,
        ...(model ? ["--model", model] : []),
        sessionId,
      ],
      cwd: this.#cwd,
      env: { RELAY_CODEX_AUTH_TOKEN: this.#token },
    };
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    await stopChild(this.#child);
    await rm(this.#runtimeDirectory, { recursive: true, force: true });
  }
}
