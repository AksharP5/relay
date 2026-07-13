import type { RelayMessage } from "../domain.ts";
import { buildHandoff } from "../handoff.ts";
import { startOpenCodeServer, type RunningOpenCodeServer } from "../harnesses/opencode-server.ts";
import type { NativeTranscriptTurn } from "./codex-backend.ts";
import type { NativeTuiCommand } from "./pty-host.ts";

type JsonObject = Record<string, unknown>;

const asObject = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === "object" ? (value as JsonObject) : undefined;

const visibleText = (parts: unknown) =>
  Array.isArray(parts)
    ? parts
        .flatMap((candidate) => {
          const part = asObject(candidate);
          return part?.type === "text" &&
            typeof part.text === "string" &&
            part.synthetic !== true &&
            part.ignored !== true
            ? [part.text]
            : [];
        })
        .join("")
        .trim()
    : "";

export const parseOpenCodeNativeTurns = (value: unknown): ReadonlyArray<NativeTranscriptTurn> => {
  if (!Array.isArray(value)) return [];
  const turns: Array<NativeTranscriptTurn> = [];
  let pending: { id: string; prompt: string } | undefined;

  for (const candidate of value) {
    const message = asObject(candidate);
    const info = asObject(message?.info);
    if (!info || typeof info.id !== "string") continue;
    if (info.role === "user") {
      const prompt = visibleText(message?.parts);
      pending = prompt ? { id: info.id, prompt } : undefined;
      continue;
    }
    if (
      info.role !== "assistant" ||
      !pending ||
      info.error !== undefined ||
      (asObject(info.time)?.completed === undefined && asObject(info.time) !== undefined)
    ) {
      continue;
    }
    const response = visibleText(message?.parts);
    if (!response) continue;
    turns.push({ id: pending.id, prompt: pending.prompt, response });
    pending = undefined;
  }
  return turns;
};

export class OpenCodeNativeBackend {
  readonly #server: RunningOpenCodeServer;
  readonly #executable: string;
  readonly #cwd: string;

  private constructor(server: RunningOpenCodeServer, executable: string, cwd: string) {
    this.#server = server;
    this.#executable = executable;
    this.#cwd = cwd;
  }

  static async start(executable: string, cwd: string) {
    return new OpenCodeNativeBackend(await startOpenCodeServer(executable, cwd), executable, cwd);
  }

  #url(path: string) {
    const url = new URL(path, this.#server.baseUrl);
    url.searchParams.set("directory", this.#cwd);
    return url;
  }

  #headers(json = false) {
    return {
      authorization: this.#server.authorization,
      ...(json ? { "content-type": "application/json" } : {}),
    };
  }

  async ensureSession(input: { sessionId?: string; title: string }) {
    if (input.sessionId) {
      const response = await fetch(this.#url(`/session/${encodeURIComponent(input.sessionId)}`), {
        headers: this.#headers(),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok)
        throw new Error(
          `OpenCode session ${input.sessionId} is unavailable (HTTP ${response.status})`,
        );
      return input.sessionId;
    }

    const response = await fetch(this.#url("/session"), {
      method: "POST",
      headers: this.#headers(true),
      body: JSON.stringify({ title: input.title }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok)
      throw new Error(`OpenCode session creation failed with HTTP ${response.status}`);
    const session = asObject(await response.json());
    if (typeof session?.id !== "string") throw new Error("OpenCode did not return a session id");
    return session.id;
  }

  async inject(sessionId: string, messages: ReadonlyArray<RelayMessage>) {
    if (messages.length === 0) return;
    const response = await fetch(this.#url(`/session/${encodeURIComponent(sessionId)}/message`), {
      method: "POST",
      headers: this.#headers(true),
      body: JSON.stringify({
        noReply: true,
        parts: [{ type: "text", text: buildHandoff(messages), synthetic: true }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`OpenCode handoff failed with HTTP ${response.status}`);
    await response.body?.cancel();
  }

  async read(sessionId: string) {
    const response = await fetch(this.#url(`/session/${encodeURIComponent(sessionId)}/message`), {
      headers: this.#headers(),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`OpenCode history failed with HTTP ${response.status}`);
    return parseOpenCodeNativeTurns(await response.json());
  }

  command(sessionId: string): NativeTuiCommand {
    return {
      executable: this.#executable,
      args: ["attach", this.#server.baseUrl, "--dir", this.#cwd, "--session", sessionId],
      cwd: this.#cwd,
      env: { OPENCODE_SERVER_PASSWORD: this.#server.password },
    };
  }

  close() {
    return this.#server.close();
  }
}
