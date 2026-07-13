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
  readonly timeoutMs?: number;
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

export class AppServerConnection {
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

  static async #start(
    command: string,
    args: ReadonlyArray<string>,
    cwd: string,
    timeoutMs: number,
  ) {
    const child = Bun.spawn([command, ...args], {
      cwd,
      env: Bun.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: process.platform !== "win32",
    });
    const connection = new AppServerConnection(child);
    try {
      await connection.#requestRaw(
        "initialize",
        {
          clientInfo: { name: "relay", title: "Relay", version: "0.1.0" },
          capabilities: null,
        },
        Math.min(timeoutMs, 15_000),
      );
      connection.#write({ method: "initialized" });
      return connection;
    } catch (cause) {
      await connection.close();
      throw cause;
    }
  }

  static start(command: string, cwd: string, timeoutMs: number) {
    return AppServerConnection.#start(command, ["app-server", "--stdio"], cwd, timeoutMs);
  }

  static connectSocket(command: string, cwd: string, socketPath: string, timeoutMs: number) {
    return AppServerConnection.#start(
      command,
      ["app-server", "proxy", "--sock", socketPath],
      cwd,
      timeoutMs,
    );
  }

  #write(message: JsonObject) {
    if (this.#closed) throw new Error("codex app-server connection is closed");
    const stdin = this.#child.stdin;
    if (!stdin || typeof stdin === "number")
      throw new Error("codex app-server stdin is unavailable");
    stdin.write(`${JSON.stringify(message)}\n`);
    stdin.flush();
  }

  #requestRaw(method: string, params: JsonObject, timeoutMs = 30 * 60 * 1_000) {
    const id = this.#nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Timed out waiting for Codex ${method}`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (cause) => {
          clearTimeout(timeout);
          reject(cause);
        },
      });
      try {
        this.#write({ id, method, params });
      } catch (cause) {
        clearTimeout(timeout);
        this.#pending.delete(id);
        reject(cause);
      }
    });
  }

  request(method: string, params: JsonObject, timeoutMs?: number) {
    return this.#requestRaw(method, params, timeoutMs);
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
    this.#closed = true;
    if (this.#child.exitCode !== null) return;
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

export class WebSocketAppServerConnection {
  readonly #socket: WebSocket;
  readonly #pending = new Map<number, PendingRequest>();
  #nextId = 1;
  #closed = false;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => this.#handleMessage(String(event.data)));
    socket.addEventListener("close", () => this.#fail(new Error("Codex websocket closed")));
    socket.addEventListener("error", () => this.#fail(new Error("Codex websocket failed")));
  }

  static async connect(url: string, token: string, timeoutMs = 15_000) {
    const BunWebSocket = WebSocket as unknown as new (
      url: string,
      options: Bun.WebSocketOptions,
    ) => WebSocket;
    const socket = new BunWebSocket(url, {
      headers: { authorization: `Bearer ${token}` },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out connecting to Codex")), timeoutMs);
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error("Could not connect to Codex")), {
          once: true,
        });
      });
    } catch (cause) {
      socket.close();
      throw cause;
    } finally {
      if (timer) clearTimeout(timer);
    }

    const connection = new WebSocketAppServerConnection(socket);
    try {
      await connection.request(
        "initialize",
        {
          clientInfo: { name: "relay", title: "Relay", version: "0.1.0" },
          capabilities: null,
        },
        timeoutMs,
      );
      connection.#write({ method: "initialized" });
      return connection;
    } catch (cause) {
      await connection.close();
      throw cause;
    }
  }

  #write(message: JsonObject) {
    if (this.#closed || this.#socket.readyState !== WebSocket.OPEN)
      throw new Error("Codex websocket is closed");
    this.#socket.send(JSON.stringify(message));
  }

  request(method: string, params: JsonObject, timeoutMs = 30 * 60 * 1_000) {
    const id = this.#nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Timed out waiting for Codex ${method}`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (cause) => {
          clearTimeout(timeout);
          reject(cause);
        },
      });
      try {
        this.#write({ id, method, params });
      } catch (cause) {
        clearTimeout(timeout);
        this.#pending.delete(id);
        reject(cause);
      }
    });
  }

  #handleMessage(raw: string) {
    let message: JsonObject;
    try {
      message = JSON.parse(raw) as JsonObject;
    } catch {
      this.#fail(new Error("Codex websocket returned invalid JSON"));
      return;
    }

    if ((typeof message.id === "number" || typeof message.id === "string") && message.method) {
      this.#write({
        id: message.id,
        error: { code: -32601, message: "Relay is not the interactive Codex client" },
      });
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    if (message.error !== undefined) pending.reject(new Error(errorMessage(message.error)));
    else pending.resolve(message.result);
  }

  #fail(cause: Error) {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.reject(cause);
    this.#pending.clear();
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise<void>((resolve) =>
      this.#socket.addEventListener("close", () => resolve(), { once: true }),
    );
    this.#socket.close();
    await Promise.race([closed, Bun.sleep(250)]);
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
  timeoutMs = 30 * 60 * 1_000,
) => {
  let text = "";
  let review = "";
  let settled = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe = () => false;

  const promise = new Promise<string>((resolve, reject) => {
    timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("Timed out waiting for the Codex command to finish"));
    }, timeoutMs);

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

  const cancel = () => {
    settled = true;
    unsubscribe();
    if (timeout) clearTimeout(timeout);
  };
  return { promise, cancel };
};

export const runCodexCommand = async (
  executable: string,
  input: CodexCommandInput,
): Promise<CodexCommandResult> => {
  const timeoutMs = input.timeoutMs ?? 30 * 60 * 1_000;
  const connection = await AppServerConnection.start(executable, input.cwd, timeoutMs);
  try {
    const threadResult = input.sessionId
      ? await connection.request(
          "thread/resume",
          {
            threadId: input.sessionId,
            cwd: input.cwd,
            ...(input.model ? { model: input.model } : {}),
          },
          timeoutMs,
        )
      : await connection.request(
          "thread/start",
          {
            cwd: input.cwd,
            ephemeral: false,
            ...(input.model ? { model: input.model } : {}),
          },
          timeoutMs,
        );
    const sessionId = threadIdFrom(threadResult);
    const completion = waitForCommand(
      connection,
      sessionId,
      input.onProgress,
      timeoutMs + Math.min(timeoutMs, 1_000),
    );

    try {
      if (input.command === "compact") {
        await connection.request("thread/compact/start", { threadId: sessionId }, timeoutMs);
      } else {
        await connection.request(
          "review/start",
          {
            threadId: sessionId,
            delivery: "inline",
            target:
              input.arguments || input.handoffText
                ? {
                    type: "custom",
                    instructions: input.handoffText
                      ? `${input.handoffText}\n\n<relay_current_request>\n${input.arguments}\n</relay_current_request>`
                      : input.arguments,
                  }
                : { type: "uncommittedChanges" },
          },
          timeoutMs,
        );
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
