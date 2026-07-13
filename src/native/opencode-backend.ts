import type { NativeTranscriptTurn, RelayMessage } from "../domain.ts";
import { buildHandoff } from "../handoff.ts";
import { startOpenCodeServer, type RunningOpenCodeServer } from "../harnesses/opencode-server.ts";
import { NativeSessionUnavailable } from "./errors.ts";
import type { NativeTuiCommand } from "./pty-host.ts";

type JsonObject = Record<string, unknown>;

class OpenCodeReadError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const asObject = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === "object" ? (value as JsonObject) : undefined;

const asSessionId = (value: unknown) =>
  typeof value === "string" && value.startsWith("ses") ? value : undefined;

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

interface OpenCodeVisibleMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly parentId?: string;
  readonly complete: boolean;
  readonly continues: boolean;
  readonly failed: boolean;
}

const compactOpenCodeMessages = (value: unknown): ReadonlyArray<OpenCodeVisibleMessage> =>
  Array.isArray(value)
    ? value.flatMap((candidate) => {
        const message = asObject(candidate);
        const info = asObject(message?.info);
        if (typeof info?.id !== "string" || (info.role !== "user" && info.role !== "assistant"))
          return [];
        const time = asObject(info.time);
        const parentId = typeof info.parentID === "string" ? info.parentID : undefined;
        const hasPendingToolCall = Array.isArray(message?.parts)
          ? message.parts.some((candidate) => {
              const part = asObject(candidate);
              if (part?.type !== "tool") return false;
              const metadata = asObject(part.metadata);
              const state = asObject(part.state);
              const stateMetadata = asObject(state?.metadata);
              const interrupted = state?.status === "error" && stateMetadata?.interrupted === true;
              return metadata?.providerExecuted !== true && !interrupted;
            })
          : false;
        return [
          {
            id: info.id,
            role: info.role,
            text: visibleText(message?.parts),
            ...(parentId ? { parentId } : {}),
            complete: time === undefined || time.completed !== undefined,
            continues:
              info.finish === "tool-calls" ||
              (typeof info.finish === "string" && hasPendingToolCall),
            failed: info.error !== undefined,
          },
        ];
      })
    : [];

const parseCompactTurns = (
  messages: ReadonlyArray<OpenCodeVisibleMessage>,
  revertedMessageId?: string,
) => {
  const turns: Array<NativeTranscriptTurn> = [];
  let pending:
    | { id: string; prompt: string; responses: Array<string>; failed: boolean }
    | undefined;
  for (const message of messages) {
    if (message.id === revertedMessageId) break;
    if (message.role === "user") {
      pending = message.text
        ? { id: message.id, prompt: message.text, responses: [], failed: false }
        : undefined;
      continue;
    }
    if (!pending || (message.parentId && message.parentId !== pending.id)) continue;
    if (message.failed) {
      pending.failed = true;
      continue;
    }
    if (!message.complete) continue;
    if (message.text) pending.responses.push(message.text);
    if (message.continues) continue;
    const response = pending.responses.join("\n\n").trim();
    if (!pending.failed && response) {
      turns.push({ id: pending.id, prompt: pending.prompt, response });
    }
    pending = undefined;
  }
  return turns;
};

export const parseOpenCodeNativeTurns = (
  value: unknown,
  revertedMessageId?: string,
): ReadonlyArray<NativeTranscriptTurn> =>
  parseCompactTurns(compactOpenCodeMessages(value), revertedMessageId);

const transcriptFrom = (session: unknown, messages: ReadonlyArray<OpenCodeVisibleMessage>) => {
  const sessionObject = asObject(session);
  const revertedMessageId = asObject(sessionObject?.revert)?.messageID;
  const cwd = typeof sessionObject?.directory === "string" ? sessionObject.directory : undefined;
  const turns = parseCompactTurns(
    messages,
    typeof revertedMessageId === "string" ? revertedMessageId : undefined,
  );
  const visible = new Set(turns.map((turn) => turn.id));
  return {
    turns,
    hiddenTurnIds: parseCompactTurns(messages)
      .map((turn) => turn.id)
      .filter((id) => !visible.has(id)),
    ...(cwd ? { cwd } : {}),
  };
};

export class OpenCodeNativeBackend {
  readonly #server: RunningOpenCodeServer;
  readonly #executable: string;
  readonly #cwd: string;
  readonly #eventAbort = new AbortController();
  readonly #requestAbort = new AbortController();
  readonly #sessionParents = new Map<string, string>();
  #eventLoop: Promise<void> | undefined;
  #observeTui = false;
  #observerHealthy = false;
  #observerGap = false;
  #observedRoot: string | undefined;

  private constructor(server: RunningOpenCodeServer, executable: string, cwd: string) {
    this.#server = server;
    this.#executable = executable;
    this.#cwd = cwd;
  }

  static async start(executable: string, cwd: string, signal?: AbortSignal) {
    const backend = new OpenCodeNativeBackend(
      await startOpenCodeServer(executable, cwd, signal),
      executable,
      cwd,
    );
    const onAbort = () => backend.#eventAbort.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      signal?.throwIfAborted();
      await backend.#startEventObserver();
      signal?.throwIfAborted();
      return backend;
    } catch (cause) {
      await backend.close();
      throw cause;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  #url(path: string, server: RunningOpenCodeServer = this.#server) {
    const url = new URL(path, server.baseUrl);
    url.searchParams.set("directory", this.#cwd);
    return url;
  }

  #headers(json = false, server: RunningOpenCodeServer = this.#server) {
    return {
      authorization: server.authorization,
      ...(json ? { "content-type": "application/json" } : {}),
    };
  }

  async #openEventStream() {
    const response = await fetch(this.#url("/event"), {
      headers: this.#headers(),
      signal: this.#eventAbort.signal,
    });
    if (!response.ok || !response.body)
      throw new Error(`OpenCode event stream failed with HTTP ${response.status}`);
    return response.body;
  }

  async #startEventObserver() {
    const firstStream = await this.#openEventStream();
    this.#observerHealthy = true;
    this.#eventLoop = this.#observeEvents(firstStream);
  }

  async #observeEvents(firstStream: ReadableStream<Uint8Array>) {
    let stream = firstStream;
    let retryMs = 50;
    while (!this.#eventAbort.signal.aborted) {
      const connectedAt = Date.now();
      try {
        await this.#consumeEvents(stream);
      } catch {
        // Reconnect below unless close() deliberately aborted the stream.
      }
      this.#observerHealthy = false;
      this.#observerGap = true;
      if (this.#eventAbort.signal.aborted) return;
      retryMs =
        Date.now() - connectedAt >= 1_000 ? 50 : Math.min(1_000, Math.max(100, retryMs * 2));
      while (!this.#eventAbort.signal.aborted) {
        await Bun.sleep(retryMs);
        try {
          stream = await this.#openEventStream();
          this.#observerHealthy = true;
          break;
        } catch {
          if (this.#eventAbort.signal.aborted) return;
          retryMs = Math.min(1_000, retryMs * 2);
        }
      }
    }
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
      const eventType = typeof event?.type === "string" ? event.type : undefined;
      const sessionId = asSessionId(properties?.sessionID) ?? asSessionId(info?.sessionID);
      if (!sessionId) continue;
      const parentId = asSessionId(info?.parentID);
      if ((eventType === "session.created" || eventType === "session.updated") && parentId)
        this.#sessionParents.set(sessionId, parentId);
      if (!this.#observeTui) continue;
      if (
        eventType === "tui.session.select" ||
        eventType === "session.created" ||
        eventType === "session.updated" ||
        eventType === "session.status" ||
        eventType === "session.idle" ||
        eventType === "message.updated"
      ) {
        this.#observedRoot = this.#rootSession(sessionId);
        this.#observerGap = false;
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

  async #get(path: string, timeoutMs: number, server: RunningOpenCodeServer = this.#server) {
    let lastFailure: unknown;
    const deadline = Date.now() + timeoutMs;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw lastFailure ?? new DOMException("The operation timed out", "TimeoutError");
      try {
        const response = await fetch(this.#url(path, server), {
          headers: this.#headers(false, server),
          signal: AbortSignal.any([
            this.#requestAbort.signal,
            AbortSignal.timeout(Math.max(1, remaining)),
          ]),
        });
        const retryable = response.status >= 500 && response.status <= 504;
        if (!retryable || attempt === 3) return response;
        const retryDelay = [100, 250, 500][attempt] ?? 500;
        if (Date.now() + retryDelay >= deadline) {
          await response.body?.cancel();
          return response;
        }
        await response.body?.cancel();
      } catch (cause) {
        lastFailure = cause;
        if (this.#requestAbort.signal.aborted || attempt === 3 || Date.now() >= deadline)
          throw cause;
      }
      await Bun.sleep(
        Math.max(0, Math.min([100, 250, 500][attempt] ?? 500, deadline - Date.now())),
      );
    }
    throw lastFailure;
  }

  async ensureSession(input: { sessionId?: string; title: string }) {
    if (input.sessionId) {
      const response = await this.#get(`/session/${encodeURIComponent(input.sessionId)}`, 15_000);
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
      signal: AbortSignal.any([this.#requestAbort.signal, AbortSignal.timeout(15_000)]),
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
      signal: AbortSignal.any([this.#requestAbort.signal, AbortSignal.timeout(30_000)]),
    });
    if (!response.ok) throw new Error(`OpenCode handoff failed with HTTP ${response.status}`);
    await response.body?.cancel();
  }

  async #readMessagesFrom(server: RunningOpenCodeServer, sessionId: string) {
    const pages: Array<ReadonlyArray<OpenCodeVisibleMessage>> = [];
    const seenCursors = new Set<string>();
    let before: string | undefined;
    while (true) {
      const query = new URLSearchParams({ limit: "20" });
      if (before) query.set("before", before);
      const response = await this.#get(
        `/session/${encodeURIComponent(sessionId)}/message?${query}`,
        30_000,
        server,
      );
      if (response.status === 404 || response.status === 410) {
        await response.body?.cancel();
        throw new NativeSessionUnavailable("opencode", sessionId);
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new OpenCodeReadError(
          `OpenCode history failed with HTTP ${response.status}`,
          response.status,
        );
      }
      const cursor = response.headers.get("x-next-cursor") ?? undefined;
      pages.unshift(compactOpenCodeMessages(await response.json()));
      if (!cursor) return pages.flat();
      if (seenCursors.has(cursor)) throw new Error("OpenCode history pagination repeated a cursor");
      seenCursors.add(cursor);
      before = cursor;
    }
  }

  async #readFrom(server: RunningOpenCodeServer, sessionId: string) {
    const [messages, sessionResponse] = await Promise.all([
      this.#readMessagesFrom(server, sessionId),
      this.#get(`/session/${encodeURIComponent(sessionId)}`, 30_000, server),
    ]);
    if (sessionResponse.status === 404 || sessionResponse.status === 410) {
      await sessionResponse.body?.cancel();
      throw new NativeSessionUnavailable("opencode", sessionId);
    }
    if (!sessionResponse.ok) {
      await sessionResponse.body?.cancel();
      throw new OpenCodeReadError(
        `OpenCode session state failed with HTTP ${sessionResponse.status}`,
        sessionResponse.status,
      );
    }
    const session: unknown = await sessionResponse.json();
    return transcriptFrom(session, messages);
  }

  async read(sessionId: string) {
    try {
      return await this.#readFrom(this.#server, sessionId);
    } catch (cause) {
      if (!(cause instanceof OpenCodeReadError) || cause.status < 500 || cause.status > 504)
        throw cause;
      // OpenCode can leave the server that hosted an attached TUI unable to
      // read history just after detach. A short-lived pure server reads the
      // persisted session without external plugins, mutation, or model work.
      const recovery = await startOpenCodeServer(
        this.#executable,
        this.#cwd,
        this.#requestAbort.signal,
        { pure: true },
      );
      try {
        return await this.#readFrom(recovery, sessionId);
      } finally {
        await recovery.close();
      }
    }
  }

  async isIdle(sessionId?: string) {
    const response = await this.#get("/session/status", 2_000);
    if (!response.ok) throw new Error(`OpenCode status failed with HTTP ${response.status}`);
    const statuses = asObject(await response.json());
    const types = sessionId
      ? [asObject(statuses?.[sessionId])?.type]
      : Object.values(statuses ?? {}).map((status) => asObject(status)?.type);
    return types.every((type) => type === undefined || type === "idle");
  }

  async sessionCwd(sessionId: string) {
    const response = await this.#get(`/session/${encodeURIComponent(sessionId)}`, 2_000);
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`OpenCode session lookup failed with HTTP ${response.status}`);
    }
    const session = asObject(await response.json());
    return typeof session?.directory === "string" ? session.directory : undefined;
  }

  async deleteSession(sessionId: string) {
    const response = await fetch(this.#url(`/session/${encodeURIComponent(sessionId)}`), {
      method: "DELETE",
      headers: this.#headers(),
      signal: AbortSignal.any([this.#requestAbort.signal, AbortSignal.timeout(15_000)]),
    });
    if (!response.ok)
      throw new Error(`OpenCode session deletion failed with HTTP ${response.status}`);
    await response.body?.cancel();
  }

  /** Detects sessions created or used through native /new and /sessions commands. */
  async resolveSession(fallbackSessionId?: string, requireCurrentObservation = false) {
    if ((!this.#observerHealthy || this.#observerGap) && requireCurrentObservation)
      throw new Error("OpenCode session observation is reconnecting");
    return this.#observedRoot ?? fallbackSessionId;
  }

  command(sessionId?: string): NativeTuiCommand {
    this.#observeTui = true;
    this.#observedRoot = sessionId;
    if (this.#observerHealthy) this.#observerGap = false;
    return {
      executable: this.#executable,
      args: [
        "attach",
        this.#server.baseUrl,
        "--dir",
        this.#cwd,
        ...(sessionId ? ["--session", sessionId] : []),
      ],
      cwd: this.#cwd,
      env: { OPENCODE_SERVER_PASSWORD: this.#server.password },
    };
  }

  async close() {
    this.#eventAbort.abort();
    this.#requestAbort.abort();
    await this.#eventLoop?.catch(() => undefined);
    await this.#server.close();
  }
}
