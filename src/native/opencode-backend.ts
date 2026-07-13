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
  readonly #eventAbort = new AbortController();
  readonly #sessionParents = new Map<string, string>();
  #eventLoop: Promise<void> | undefined;
  #observeTui = false;
  #observedRoot: string | undefined;

  private constructor(server: RunningOpenCodeServer, executable: string, cwd: string) {
    this.#server = server;
    this.#executable = executable;
    this.#cwd = cwd;
  }

  static async start(executable: string, cwd: string) {
    const backend = new OpenCodeNativeBackend(
      await startOpenCodeServer(executable, cwd),
      executable,
      cwd,
    );
    try {
      await backend.#startEventObserver();
      return backend;
    } catch (cause) {
      await backend.close();
      throw cause;
    }
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

  async #startEventObserver() {
    const response = await fetch(this.#url("/event"), {
      headers: this.#headers(),
      signal: this.#eventAbort.signal,
    });
    if (!response.ok || !response.body)
      throw new Error(`OpenCode event stream failed with HTTP ${response.status}`);
    this.#eventLoop = this.#consumeEvents(response.body).catch(() => {
      if (!this.#eventAbort.signal.aborted) this.#observeTui = false;
    });
  }

  async #consumeEvents(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        let boundary = pending.indexOf("\n\n");
        while (boundary >= 0) {
          this.#consumeEventBlock(pending.slice(0, boundary));
          pending = pending.slice(boundary + 2);
          boundary = pending.indexOf("\n\n");
        }
      }
      pending += decoder.decode();
      if (pending.trim()) this.#consumeEventBlock(pending);
    } finally {
      reader.releaseLock();
    }
  }

  #consumeEventBlock(block: string) {
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      let event: JsonObject | undefined;
      try {
        event = asObject(JSON.parse(line.slice(5).trim()));
      } catch {
        continue;
      }
      const properties = asObject(event?.properties);
      const info = asObject(properties?.info);
      const sessionId =
        typeof properties?.sessionID === "string"
          ? properties.sessionID
          : typeof info?.sessionID === "string"
            ? info.sessionID
            : typeof info?.id === "string"
              ? info.id
              : undefined;
      if (!sessionId) continue;
      if (typeof info?.parentID === "string") this.#sessionParents.set(sessionId, info.parentID);
      if (!this.#observeTui) continue;
      if (
        event?.type === "tui.session.select" ||
        event?.type === "session.created" ||
        event?.type === "session.updated" ||
        event?.type === "session.status" ||
        event?.type === "session.idle" ||
        event?.type === "message.updated"
      ) {
        this.#observedRoot = this.#rootSession(sessionId);
      }
    }
  }

  #rootSession(sessionId: string) {
    const visited = new Set<string>();
    let current = sessionId;
    while (this.#sessionParents.has(current) && !visited.has(current)) {
      visited.add(current);
      current = this.#sessionParents.get(current)!;
    }
    return current;
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
    return this.#observedRoot ?? fallbackSessionId;
  }

  command(sessionId: string): NativeTuiCommand {
    this.#observeTui = true;
    this.#observedRoot = sessionId;
    return {
      executable: this.#executable,
      args: ["attach", this.#server.baseUrl, "--dir", this.#cwd, "--session", sessionId],
      cwd: this.#cwd,
      env: { OPENCODE_SERVER_PASSWORD: this.#server.password },
    };
  }

  async close() {
    this.#eventAbort.abort();
    await this.#eventLoop?.catch(() => undefined);
    await this.#server.close();
  }
}
