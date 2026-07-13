import type { NativeTranscriptTurn, RelayMessage } from "../domain.ts";
import { buildHandoff } from "../handoff.ts";
import { startOpenCodeServer, type RunningOpenCodeServer } from "../harnesses/opencode-server.ts";
import { NativeSessionUnavailable } from "./errors.ts";
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

export const parseOpenCodeNativeTurns = (
  value: unknown,
  revertedMessageId?: string,
): ReadonlyArray<NativeTranscriptTurn> => {
  if (!Array.isArray(value)) return [];
  const turns: Array<NativeTranscriptTurn> = [];
  let pending: { id: string; prompt: string } | undefined;

  for (const candidate of value) {
    const message = asObject(candidate);
    const info = asObject(message?.info);
    if (!info || typeof info.id !== "string") continue;
    if (info.id === revertedMessageId) break;
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
  #baselineSessions = new Map<string, number>();

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

  async #sessions() {
    const response = await fetch(this.#url("/session?limit=100"), {
      headers: this.#headers(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`OpenCode session list failed with HTTP ${response.status}`);
    const value: unknown = await response.json();
    if (!Array.isArray(value)) return [];
    return value.flatMap((candidate) => {
      const session = asObject(candidate);
      const time = asObject(session?.time);
      return typeof session?.id === "string"
        ? [{ id: session.id, updated: typeof time?.updated === "number" ? time.updated : 0 }]
        : [];
    });
  }

  async ensureSession(input: { sessionId?: string; title: string }) {
    if (input.sessionId) {
      const response = await fetch(this.#url(`/session/${encodeURIComponent(input.sessionId)}`), {
        headers: this.#headers(),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok)
        if (response.status === 404 || response.status === 410)
          throw new NativeSessionUnavailable(
            "opencode",
            input.sessionId,
            `OpenCode session ${input.sessionId} is unavailable (HTTP ${response.status})`,
          );
        else
          throw new Error(
            `OpenCode session lookup failed for ${input.sessionId} (HTTP ${response.status})`,
          );
      this.#baselineSessions = new Map(
        (await this.#sessions()).map((session) => [session.id, session.updated]),
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
    this.#baselineSessions = new Map(
      (await this.#sessions()).map((candidate) => [candidate.id, candidate.updated]),
    );
    return session.id;
  }

  async inject(sessionId: string, messages: ReadonlyArray<RelayMessage>, omittedMessages = 0) {
    if (messages.length === 0) return;
    const response = await fetch(this.#url(`/session/${encodeURIComponent(sessionId)}/message`), {
      method: "POST",
      headers: this.#headers(true),
      body: JSON.stringify({
        noReply: true,
        parts: [{ type: "text", text: buildHandoff(messages, omittedMessages), synthetic: true }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`OpenCode handoff failed with HTTP ${response.status}`);
    await response.body?.cancel();
  }

  async read(sessionId: string) {
    const [messagesResponse, sessionResponse] = await Promise.all([
      fetch(this.#url(`/session/${encodeURIComponent(sessionId)}/message`), {
        headers: this.#headers(),
        signal: AbortSignal.timeout(30_000),
      }),
      fetch(this.#url(`/session/${encodeURIComponent(sessionId)}`), {
        headers: this.#headers(),
        signal: AbortSignal.timeout(30_000),
      }),
    ]);
    if (messagesResponse.status === 404 || messagesResponse.status === 410)
      throw new NativeSessionUnavailable("opencode", sessionId);
    if (!messagesResponse.ok)
      throw new Error(`OpenCode history failed with HTTP ${messagesResponse.status}`);
    if (sessionResponse.status === 404 || sessionResponse.status === 410)
      throw new NativeSessionUnavailable("opencode", sessionId);
    if (!sessionResponse.ok)
      throw new Error(`OpenCode session state failed with HTTP ${sessionResponse.status}`);
    const session = asObject(await sessionResponse.json());
    const revertedMessageId = asObject(session?.revert)?.messageID;
    return parseOpenCodeNativeTurns(
      await messagesResponse.json(),
      typeof revertedMessageId === "string" ? revertedMessageId : undefined,
    );
  }

  async isIdle(sessionId: string) {
    const response = await fetch(this.#url("/session/status"), {
      headers: this.#headers(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`OpenCode status failed with HTTP ${response.status}`);
    const statuses = asObject(await response.json());
    const type = asObject(statuses?.[sessionId])?.type;
    return type !== "busy" && type !== "retry";
  }

  /** Detects sessions created or used through native /new and /sessions commands. */
  async resolveSession(fallbackSessionId: string) {
    const sessions = await this.#sessions();
    const changed = sessions
      .filter((session) => session.updated > (this.#baselineSessions.get(session.id) ?? -1))
      .sort((left, right) => right.updated - left.updated);
    return changed[0]?.id ?? fallbackSessionId;
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
