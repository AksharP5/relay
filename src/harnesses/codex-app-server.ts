import type { HarnessTurnProgress } from "../domain.ts";
import { readStream } from "../services/process-runner.ts";

type JsonObject = Record<string, unknown>;

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (cause: Error) => void;
}

interface CodexCommandInput {
  readonly command: "compact" | "review";
  readonly cwd: string;
  readonly sessionId?: string;
  readonly model?: string;
  readonly arguments: string;
  readonly handoffText?: string;
  readonly onProgress?: (progress: HarnessTurnProgress) => void;
}

export interface CodexCommandResult {
  readonly sessionId: string;
  readonly text: string;
}

const asObject = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === "object" ? (value as JsonObject) : undefined;

const errorMessage = (value: unknown) => {
  const object = asObject(value);
  return typeof object?.message === "string" ? object.message : JSON.stringify(value);
};

class AppServerConnection {
  readonly #child: ReturnType<typeof Bun.spawn>;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #listeners = new Set<(message: JsonObject) => void>();
  #nextId = 1;
  #closed = false;
  #stderr = "";

  private constructor(child: ReturnType<typeof Bun.spawn>) {
    this.#child = child;
    if (!(child.stdout instanceof ReadableStream) || !(child.stderr instanceof ReadableStream)) {
      throw new Error("codex app-server output pipes are unavailable");
    }
    void readStream(child.stdout, {
      onLine: (line) => this.#handleLine(line),
      lineLimit: 8_000_000,
    }).catch((cause) => this.#fail(cause instanceof Error ? cause : new Error(String(cause))));
    void readStream(child.stderr, { limit: 128_000 }).then((value) => (this.#stderr = value));
    void child.exited.then((code) => {
      if (!this.#closed) this.#fail(new Error(`codex app-server exited with code ${code}`));
    });
  }

  static async start(command: string, cwd: string) {
    const child = Bun.spawn([command, "app-server", "--stdio"], {
      cwd,
      env: Bun.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: process.platform !== "win32",
    });
    const connection = new AppServerConnection(child);
    await connection.#requestRaw("initialize", {
      clientInfo: { name: "relay", title: "Relay", version: "0.1.0" },
      capabilities: null,
    });
    connection.#write({ method: "initialized" });
    return connection;
  }

  #write(message: JsonObject) {
    if (this.#closed) throw new Error("codex app-server connection is closed");
    const stdin = this.#child.stdin;
    if (!stdin || typeof stdin === "number")
      throw new Error("codex app-server stdin is unavailable");
    stdin.write(`${JSON.stringify(message)}\n`);
    stdin.flush();
  }

  #requestRaw(method: string, params: JsonObject) {
    const id = this.#nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        this.#write({ id, method, params });
      } catch (cause) {
        this.#pending.delete(id);
        reject(cause);
      }
    });
  }

  request(method: string, params: JsonObject) {
    return this.#requestRaw(method, params);
  }

  subscribe(listener: (message: JsonObject) => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #handleLine(line: string) {
    if (!line.trim()) return;
    let message: JsonObject;
    try {
      message = JSON.parse(line) as JsonObject;
    } catch {
      this.#fail(new Error("codex app-server returned invalid JSON"));
      return;
    }

    if ((typeof message.id === "number" || typeof message.id === "string") && message.method) {
      this.#write({
        id: message.id,
        error: {
          code: -32601,
          message: "Relay cannot handle this interactive Codex request yet",
        },
      });
      return;
    }

    if (typeof message.id === "number") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error !== undefined) pending.reject(new Error(errorMessage(message.error)));
      else pending.resolve(message.result);
      return;
    }

    if (typeof message.method === "string") {
      for (const listener of this.#listeners) listener(message);
    }
  }

  #fail(cause: Error) {
    if (this.#closed) return;
    this.#closed = true;
    const detail = this.#stderr.trim();
    const error = detail ? new Error(`${cause.message}\n${detail.slice(-8_000)}`) : cause;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    try {
      if (process.platform !== "win32") process.kill(-this.#child.pid, "SIGTERM");
      else this.#child.kill("SIGTERM");
    } catch {
      this.#child.kill("SIGTERM");
    }
    await Promise.race([this.#child.exited, Bun.sleep(1_000)]);
    if (this.#child.exitCode === null) {
      try {
        if (process.platform !== "win32") process.kill(-this.#child.pid, "SIGKILL");
        else this.#child.kill("SIGKILL");
      } catch {
        this.#child.kill("SIGKILL");
      }
      await this.#child.exited.catch(() => undefined);
    }
  }
}

const threadIdFrom = (value: unknown) => {
  const result = asObject(value);
  const thread = asObject(result?.thread);
  if (typeof thread?.id !== "string") throw new Error("Codex did not return a thread id");
  return thread.id;
};

const waitForCommand = (
  connection: AppServerConnection,
  threadId: string,
  onProgress?: (progress: HarnessTurnProgress) => void,
) => {
  let text = "";
  let review = "";
  let settled = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe = () => false;

  const promise = new Promise<string>((resolve, reject) => {
    timeout = setTimeout(
      () => {
        unsubscribe();
        reject(new Error("Timed out waiting for the Codex command to finish"));
      },
      30 * 60 * 1_000,
    );

    unsubscribe = connection.subscribe((message) => {
      const params = asObject(message.params);
      if (params?.threadId !== threadId) return;
      if (message.method === "item/agentMessage/delta" && typeof params.delta === "string") {
        text += params.delta;
        onProgress?.({ type: "text", text });
        return;
      }
      if (message.method === "item/completed") {
        const item = asObject(params.item);
        if (item?.type === "exitedReviewMode" && typeof item.review === "string") {
          review = item.review;
          onProgress?.({ type: "text", text: review });
        }
        return;
      }
      if (message.method !== "turn/completed" || settled) return;
      settled = true;
      unsubscribe();
      if (timeout) clearTimeout(timeout);
      const turn = asObject(params.turn);
      if (turn?.status === "failed") {
        reject(new Error(errorMessage(turn.error)));
      } else if (turn?.status === "interrupted") {
        reject(new Error("Codex command was interrupted"));
      } else {
        resolve((review || text).trim());
      }
    });
  });

  return { promise, cancel: unsubscribe };
};

export const runCodexCommand = async (
  executable: string,
  input: CodexCommandInput,
): Promise<CodexCommandResult> => {
  const connection = await AppServerConnection.start(executable, input.cwd);
  try {
    const threadResult = input.sessionId
      ? await connection.request("thread/resume", {
          threadId: input.sessionId,
          cwd: input.cwd,
          ...(input.model ? { model: input.model } : {}),
        })
      : await connection.request("thread/start", {
          cwd: input.cwd,
          ephemeral: false,
          ...(input.model ? { model: input.model } : {}),
        });
    const sessionId = threadIdFrom(threadResult);
    if (input.handoffText) {
      await connection.request("thread/inject_items", {
        threadId: sessionId,
        items: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: input.handoffText }],
          },
        ],
      });
    }
    const completion = waitForCommand(connection, sessionId, input.onProgress);

    try {
      if (input.command === "compact") {
        await connection.request("thread/compact/start", { threadId: sessionId });
      } else {
        await connection.request("review/start", {
          threadId: sessionId,
          delivery: "inline",
          target: input.arguments
            ? { type: "custom", instructions: input.arguments }
            : { type: "uncommittedChanges" },
        });
      }
      const response = await completion.promise;
      return {
        sessionId,
        text:
          response ||
          (input.command === "compact"
            ? "Codex compacted its native context."
            : "Codex completed the review."),
      };
    } catch (cause) {
      completion.cancel();
      throw cause;
    }
  } finally {
    await connection.close();
  }
};
