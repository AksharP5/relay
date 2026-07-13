import { Context, Effect, Layer, Schema } from "effect";
import { appendFile, chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { NoCurrentThread, StoreError, ThreadBusy, ThreadNotFound } from "../errors.ts";
import {
  RelayIndex,
  RelayMessage,
  RelayThread,
  type Harness,
  type HarnessBinding,
} from "../domain.ts";

const defaultIndex: RelayIndex = { currentThreadId: null, threadIds: [] };

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const dataRoot = () => {
  const override = Bun.env.RELAY_DATA_DIR?.trim();
  if (override) return override;

  const home = Bun.env.HOME;
  if (!home) return `${process.cwd()}/.relay`;
  return `${home}/.local/share/relay`;
};

const threadDir = (id: string) => `${dataRoot()}/threads/${id}`;
const metadataPath = (id: string) => `${threadDir(id)}/thread.json`;
const eventsPath = (id: string) => `${threadDir(id)}/events.jsonl`;
const indexPath = () => `${dataRoot()}/index.json`;
const pendingPath = (id: string) => `${threadDir(id)}/pending-turn.json`;
const undoPath = (id: string) => `${threadDir(id)}/undo-stack.json`;
const lockPath = (id: string) => `${dataRoot()}/locks/${id}`;
const maxEventLineChars = 4_000_000;

const secureDirectory = async (path: string) => {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
};

const ensureBase = async () => {
  await secureDirectory(dataRoot());
  await secureDirectory(`${dataRoot()}/threads`);
  await secureDirectory(`${dataRoot()}/locks`);
};

const readJson = async <A>(path: string, schema: Schema.Decoder<A>): Promise<A | undefined> => {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  await chmod(path, 0o600);
  const value: unknown = await file.json();
  return Schema.decodeUnknownSync(schema)(value) as A;
};

const atomicTextWrite = async (path: string, value: string) => {
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  await ensureBase();
  await secureDirectory(dirname(path));
  await writeFile(temp, value, { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
  await chmod(path, 0o600);
};

const atomicJsonWrite = (path: string, value: unknown) =>
  atomicTextWrite(path, `${JSON.stringify(value, null, 2)}\n`);

const readMessages = async (
  id: string,
  options: { readonly repairTail?: boolean } = {},
): Promise<Array<RelayMessage>> => {
  const file = Bun.file(eventsPath(id));
  if (!(await file.exists())) return [];
  await chmod(eventsPath(id), 0o600);
  const text = await file.text();
  if (text.trim().length === 0) return [];
  const lines = text.trimEnd().split("\n");
  const messages: Array<RelayMessage> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    try {
      messages.push(Schema.decodeUnknownSync(RelayMessage)(JSON.parse(line)));
    } catch (cause) {
      if (index !== lines.length - 1) throw cause;
      if (options.repairTail) {
        await atomicTextWrite(
          eventsPath(id),
          messages.map((message) => JSON.stringify(message)).join("\n") + "\n",
        );
      }
    }
  }
  return messages;
};

const scanMessages = async (id: string, onMessage: (message: RelayMessage) => void) => {
  const file = Bun.file(eventsPath(id));
  if (!(await file.exists())) return;

  const reader = file.stream().getReader();
  const decoder = new TextDecoder();
  let pending = "";

  const consume = (line: string, final: boolean) => {
    if (!line.trim()) return;
    try {
      onMessage(Schema.decodeUnknownSync(RelayMessage)(JSON.parse(line)));
    } catch (cause) {
      if (!final) throw cause;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      consume(pending.slice(0, newline), false);
      pending = pending.slice(newline + 1);
      newline = pending.indexOf("\n");
    }
    if (pending.length > maxEventLineChars) {
      throw new Error(`Relay event exceeds ${maxEventLineChars} characters`);
    }
  }

  pending += decoder.decode();
  consume(pending, true);
};

const readMessagesSince = async (
  id: string,
  afterSeq: number,
  limits: { readonly maxMessages: number; readonly maxChars: number },
) => {
  const messages: Array<RelayMessage> = [];
  let chars = 0;
  let omittedMessages = 0;
  await scanMessages(id, (message) => {
    if (message.seq <= afterSeq) return;
    const truncation = "[Earlier content in this message was truncated by Relay.]\n";
    const retained =
      message.content.length > limits.maxChars
        ? {
            ...message,
            content: `${truncation}${message.content.slice(-(limits.maxChars - truncation.length))}`,
          }
        : message;
    if (retained !== message) omittedMessages += 1;
    messages.push(retained);
    chars += retained.content.length;
    while (messages.length > limits.maxMessages || chars > limits.maxChars) {
      chars -= messages.shift()?.content.length ?? 0;
      omittedMessages += 1;
    }
  });
  return { messages, omittedMessages };
};

const readRecentMessages = async (
  id: string,
  options: { readonly maxMessages: number; readonly maxChars: number },
) => {
  const messages: Array<RelayMessage> = [];
  let chars = 0;
  await scanMessages(id, (message) => {
    const retained =
      message.content.length > options.maxChars
        ? {
            ...message,
            content: `…${message.content.slice(-(options.maxChars - 1))}`,
          }
        : message;
    messages.push(retained);
    chars += retained.content.length;
    while (messages.length > options.maxMessages || chars > options.maxChars) {
      chars -= messages.shift()?.content.length ?? 0;
    }
  });
  return messages;
};

const loadIndex = async (): Promise<RelayIndex> => {
  await ensureBase();
  return (await readJson<RelayIndex>(indexPath(), RelayIndex)) ?? defaultIndex;
};

const PendingTurn = Schema.Struct({
  version: Schema.Literal(1),
  messages: Schema.Array(RelayMessage),
  thread: RelayThread,
});
type PendingTurn = typeof PendingTurn.Type;

interface UndoEntry {
  readonly messages: ReadonlyArray<RelayMessage>;
  readonly thread: RelayThread;
}

interface UndoState {
  readonly entries: ReadonlyArray<UndoEntry>;
}

const readUndoState = async (id: string): Promise<UndoState> => {
  const file = Bun.file(undoPath(id));
  if (!(await file.exists())) return { entries: [] };
  const value = (await file.json()) as { entries?: unknown };
  if (!Array.isArray(value.entries)) return { entries: [] };
  const entries = value.entries.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const candidate = entry as { messages?: unknown; thread?: unknown };
    try {
      if (!Array.isArray(candidate.messages)) return [];
      return [
        {
          messages: candidate.messages.map((message) =>
            Schema.decodeUnknownSync(RelayMessage)(message),
          ),
          thread: Schema.decodeUnknownSync(RelayThread)(candidate.thread),
        },
      ];
    } catch {
      return [];
    }
  });
  return { entries };
};

async function liveLockExists(id: string) {
  const path = lockPath(id);
  try {
    const owner = JSON.parse(await readFile(`${path}/owner.json`, "utf8")) as { pid?: unknown };
    return typeof owner.pid === "number" && processIsAlive(owner.pid);
  } catch {
    try {
      return Date.now() - (await stat(path)).mtimeMs < 5 * 60 * 1000;
    } catch {
      return false;
    }
  }
}

const recoverThread = async (thread: RelayThread): Promise<RelayThread> => {
  if (await liveLockExists(thread.id)) return thread;

  let lock: Awaited<ReturnType<typeof acquireThreadLock>>;
  try {
    lock = await acquireThreadLock(thread.id);
  } catch (cause) {
    if (cause instanceof ThreadBusy) return thread;
    throw cause;
  }

  try {
    const latest = (await readJson<RelayThread>(metadataPath(thread.id), RelayThread)) ?? thread;
    const latestPending = await readJson<PendingTurn>(pendingPath(thread.id), PendingTurn);
    const latestMessages = await readMessages(thread.id, { repairTail: true });
    if (latestPending) {
      const existingIds = new Set(latestMessages.map((message) => message.id));
      const missing = latestPending.messages.filter((message) => !existingIds.has(message.id));
      if (missing.length > 0) {
        await appendFile(
          eventsPath(thread.id),
          `${missing.map((message) => JSON.stringify(message)).join("\n")}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
      }
      await atomicJsonWrite(metadataPath(thread.id), latestPending.thread);
      await rm(pendingPath(thread.id), { force: true });
      return latestPending.thread;
    }

    const repairedSeq = latestMessages.at(-1)?.seq ?? 0;
    if (repairedSeq === latest.lastSeq) return latest;
    const repaired = { ...latest, lastSeq: repairedSeq };
    await atomicJsonWrite(metadataPath(thread.id), repaired);
    return repaired;
  } finally {
    await lock.release();
  }
};

const readThread = async (id: string): Promise<RelayThread | undefined> => {
  const thread = await readJson<RelayThread>(metadataPath(id), RelayThread);
  return thread ? recoverThread(thread) : undefined;
};

function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireThreadLock(id: string) {
  await ensureBase();
  const path = lockPath(id);

  const acquire = async (allowStaleRemoval: boolean): Promise<void> => {
    try {
      await mkdir(path, { mode: 0o700 });
      await writeFile(
        `${path}/owner.json`,
        `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
        {
          encoding: "utf8",
          mode: 0o600,
        },
      );
    } catch (cause) {
      const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
      if (code !== "EEXIST" || !allowStaleRemoval) throw cause;

      let ownerPid: number | undefined;
      try {
        const owner = JSON.parse(await readFile(`${path}/owner.json`, "utf8")) as { pid?: unknown };
        if (typeof owner.pid === "number") ownerPid = owner.pid;
      } catch {
        // A process can crash between creating the directory and writing its owner file.
      }
      if (ownerPid !== undefined && processIsAlive(ownerPid)) {
        throw new ThreadBusy({
          threadId: id,
          message: "This Relay task already has a turn running",
        });
      }
      if (ownerPid === undefined) {
        const ageMs = Date.now() - (await stat(path)).mtimeMs;
        if (ageMs < 5 * 60 * 1000) {
          throw new ThreadBusy({
            threadId: id,
            message: "This Relay task already has a turn starting",
          });
        }
      }
      await rm(path, { recursive: true, force: true });
      await acquire(false);
    }
  };

  await acquire(true);
  return { release: () => rm(path, { recursive: true, force: true }) };
}

export interface CreateThreadInput {
  readonly title: string;
  readonly cwd: string;
  readonly harness: Harness;
}

export interface CommitTurnInput {
  readonly harness: Harness;
  readonly prompt: string;
  readonly response: string;
  readonly sessionId: string;
  readonly bindingCreatedAt: string;
  readonly model?: string;
}

export class ThreadStore extends Context.Service<
  ThreadStore,
  {
    readonly create: (input: CreateThreadInput) => Effect.Effect<RelayThread, StoreError>;
    readonly current: () => Effect.Effect<
      RelayThread,
      StoreError | NoCurrentThread | ThreadNotFound
    >;
    readonly get: (id: string) => Effect.Effect<RelayThread, StoreError | ThreadNotFound>;
    readonly list: () => Effect.Effect<ReadonlyArray<RelayThread>, StoreError>;
    readonly messages: (id: string) => Effect.Effect<ReadonlyArray<RelayMessage>, StoreError>;
    readonly messagesSince: (
      id: string,
      afterSeq: number,
    ) => Effect.Effect<
      { readonly messages: ReadonlyArray<RelayMessage>; readonly omittedMessages: number },
      StoreError
    >;
    readonly recentMessages: (
      id: string,
      options: { readonly maxMessages: number; readonly maxChars: number },
    ) => Effect.Effect<ReadonlyArray<RelayMessage>, StoreError>;
    readonly acquireLock: (
      id: string,
    ) => Effect.Effect<{ readonly release: () => Promise<void> }, StoreError | ThreadBusy>;
    readonly canUndoLastTurn: (
      thread: RelayThread,
      harness: Harness,
    ) => Effect.Effect<boolean, StoreError>;
    readonly canRedoLastTurn: (
      thread: RelayThread,
      harness: Harness,
    ) => Effect.Effect<boolean, StoreError>;
    readonly commitTurn: (
      thread: RelayThread,
      input: CommitTurnInput,
    ) => Effect.Effect<
      { readonly thread: RelayThread; readonly response: RelayMessage },
      StoreError
    >;
    readonly setCurrent: (id: string) => Effect.Effect<void, StoreError | ThreadNotFound>;
    readonly setHarness: (
      thread: RelayThread,
      harness: Harness,
    ) => Effect.Effect<RelayThread, StoreError>;
    readonly dropBinding: (
      thread: RelayThread,
      harness: Harness,
    ) => Effect.Effect<RelayThread, StoreError>;
    readonly undoLastTurn: (
      thread: RelayThread,
      harness: Harness,
    ) => Effect.Effect<RelayThread, StoreError | NoCurrentThread>;
    readonly redoLastTurn: (
      thread: RelayThread,
      harness: Harness,
    ) => Effect.Effect<RelayThread, StoreError | NoCurrentThread>;
    readonly root: string;
  }
>()("@relay/ThreadStore") {
  static readonly layer = Layer.succeed(ThreadStore, {
    root: dataRoot(),

    create: Effect.fn("ThreadStore.create")((input: CreateThreadInput) =>
      Effect.tryPromise({
        try: async () => {
          const now = new Date().toISOString();
          const thread: RelayThread = {
            id: crypto.randomUUID(),
            title: input.title,
            cwd: input.cwd,
            activeHarness: input.harness,
            bindings: {},
            lastSeq: 0,
            createdAt: now,
            updatedAt: now,
          };
          await atomicJsonWrite(metadataPath(thread.id), thread);
          await secureDirectory(threadDir(thread.id));
          await writeFile(eventsPath(thread.id), "", { encoding: "utf8", mode: 0o600 });

          const indexLock = await acquireThreadLock("__index__");
          try {
            const index = await loadIndex();
            await atomicJsonWrite(indexPath(), {
              currentThreadId: thread.id,
              threadIds: [thread.id, ...index.threadIds.filter((id) => id !== thread.id)],
            } satisfies RelayIndex);
          } finally {
            await indexLock.release();
          }
          return thread;
        },
        catch: (cause) =>
          new StoreError({ operation: "create thread", message: errorMessage(cause), cause }),
      }),
    ),

    current: Effect.fn("ThreadStore.current")(function* () {
      const index = yield* Effect.tryPromise({
        try: loadIndex,
        catch: (cause) =>
          new StoreError({ operation: "read index", message: errorMessage(cause), cause }),
      });
      if (index.currentThreadId === null) {
        return yield* new NoCurrentThread({
          message: "No Relay task is selected. Run relay new first.",
        });
      }

      return yield* Effect.tryPromise({
        try: async () => {
          const thread = await readThread(index.currentThreadId!);
          if (!thread) {
            throw new ThreadNotFound({
              threadId: index.currentThreadId!,
              message: `Relay task ${index.currentThreadId!} was not found`,
            });
          }
          return thread;
        },
        catch: (cause) =>
          cause instanceof ThreadNotFound
            ? cause
            : new StoreError({
                operation: "read current thread",
                message: errorMessage(cause),
                cause,
              }),
      });
    }),

    get: Effect.fn("ThreadStore.get")((id: string) =>
      Effect.tryPromise({
        try: async () => {
          const thread = await readThread(id);
          if (!thread)
            throw new ThreadNotFound({ threadId: id, message: `Relay task ${id} was not found` });
          return thread;
        },
        catch: (cause) =>
          cause instanceof ThreadNotFound
            ? cause
            : new StoreError({ operation: "read thread", message: errorMessage(cause), cause }),
      }),
    ),

    list: Effect.fn("ThreadStore.list")(() =>
      Effect.tryPromise({
        try: async () => {
          const index = await loadIndex();
          const threads = await Promise.all(index.threadIds.map((id) => readThread(id)));
          return threads.filter((thread): thread is RelayThread => thread !== undefined);
        },
        catch: (cause) =>
          new StoreError({ operation: "list threads", message: errorMessage(cause), cause }),
      }),
    ),

    messages: Effect.fn("ThreadStore.messages")((id: string) =>
      Effect.tryPromise({
        try: () => readMessages(id),
        catch: (cause) =>
          new StoreError({ operation: "read messages", message: errorMessage(cause), cause }),
      }),
    ),

    messagesSince: Effect.fn("ThreadStore.messagesSince")((id: string, afterSeq: number) =>
      Effect.tryPromise({
        try: () => readMessagesSince(id, afterSeq, { maxMessages: 200, maxChars: 120_000 }),
        catch: (cause) =>
          new StoreError({ operation: "read message delta", message: errorMessage(cause), cause }),
      }),
    ),

    recentMessages: Effect.fn("ThreadStore.recentMessages")(
      (id: string, options: { readonly maxMessages: number; readonly maxChars: number }) =>
        Effect.tryPromise({
          try: () => readRecentMessages(id, options),
          catch: (cause) =>
            new StoreError({
              operation: "read recent messages",
              message: errorMessage(cause),
              cause,
            }),
        }),
    ),

    acquireLock: Effect.fn("ThreadStore.acquireLock")((id: string) =>
      Effect.tryPromise({
        try: () => acquireThreadLock(id),
        catch: (cause) =>
          cause instanceof ThreadBusy
            ? cause
            : new StoreError({ operation: "lock thread", message: errorMessage(cause), cause }),
      }),
    ),

    canUndoLastTurn: Effect.fn("ThreadStore.canUndoLastTurn")(
      (thread: RelayThread, harness: Harness) =>
        Effect.tryPromise({
          try: async () => {
            const messages = await readMessages(thread.id);
            const latest = messages.slice(-2);
            return (
              latest.length === 2 &&
              latest[0]?.role === "user" &&
              latest[1]?.role === "assistant" &&
              latest[1].harness === harness
            );
          },
          catch: (cause) =>
            new StoreError({ operation: "check undo state", message: errorMessage(cause), cause }),
        }),
    ),

    canRedoLastTurn: Effect.fn("ThreadStore.canRedoLastTurn")(
      (thread: RelayThread, harness: Harness) =>
        Effect.tryPromise({
          try: async () => {
            const entry = (await readUndoState(thread.id)).entries.at(-1);
            return entry?.thread.activeHarness === harness;
          },
          catch: (cause) =>
            new StoreError({ operation: "check redo state", message: errorMessage(cause), cause }),
        }),
    ),

    commitTurn: Effect.fn("ThreadStore.commitTurn")((thread: RelayThread, input: CommitTurnInput) =>
      Effect.tryPromise({
        try: async () => {
          const now = new Date().toISOString();
          const user: RelayMessage = {
            id: crypto.randomUUID(),
            seq: thread.lastSeq + 1,
            role: "user",
            content: input.prompt,
            harness: input.harness,
            createdAt: now,
          };
          const response: RelayMessage = {
            id: crypto.randomUUID(),
            seq: thread.lastSeq + 2,
            role: "assistant",
            content: input.response,
            harness: input.harness,
            createdAt: now,
          };
          const binding: HarnessBinding = {
            harness: input.harness,
            sessionId: input.sessionId,
            ...(input.model ? { model: input.model } : {}),
            lastSyncedSeq: response.seq,
            createdAt: input.bindingCreatedAt,
            updatedAt: now,
          };
          const updated: RelayThread = {
            ...thread,
            activeHarness: input.harness,
            bindings: { ...thread.bindings, [input.harness]: binding },
            preferredModels: {
              ...thread.preferredModels,
              ...(input.model ? { [input.harness]: input.model } : {}),
            },
            lastSeq: response.seq,
            updatedAt: now,
          };
          const pending: PendingTurn = { version: 1, messages: [user, response], thread: updated };

          await atomicJsonWrite(pendingPath(thread.id), pending);
          await appendFile(
            eventsPath(thread.id),
            `${JSON.stringify(user)}\n${JSON.stringify(response)}\n`,
            {
              encoding: "utf8",
              mode: 0o600,
            },
          );
          await chmod(eventsPath(thread.id), 0o600);
          await atomicJsonWrite(metadataPath(thread.id), updated);
          await rm(pendingPath(thread.id), { force: true });
          await rm(undoPath(thread.id), { force: true });
          return { thread: updated, response };
        },
        catch: (cause) =>
          new StoreError({ operation: "commit turn", message: errorMessage(cause), cause }),
      }),
    ),

    setCurrent: Effect.fn("ThreadStore.setCurrent")((id: string) =>
      Effect.tryPromise({
        try: async () => {
          if (!(await Bun.file(metadataPath(id)).exists()))
            throw new ThreadNotFound({ threadId: id, message: `Relay task ${id} was not found` });
          const indexLock = await acquireThreadLock("__index__");
          try {
            const index = await loadIndex();
            await atomicJsonWrite(indexPath(), {
              currentThreadId: id,
              threadIds: [id, ...index.threadIds.filter((threadId) => threadId !== id)],
            } satisfies RelayIndex);
          } finally {
            await indexLock.release();
          }
        },
        catch: (cause) =>
          cause instanceof ThreadNotFound
            ? cause
            : new StoreError({
                operation: "set current thread",
                message: errorMessage(cause),
                cause,
              }),
      }),
    ),

    setHarness: Effect.fn("ThreadStore.setHarness")((thread: RelayThread, harness: Harness) =>
      Effect.tryPromise({
        try: async () => {
          const updated: RelayThread = {
            ...thread,
            activeHarness: harness,
            updatedAt: new Date().toISOString(),
          };
          await atomicJsonWrite(metadataPath(thread.id), updated);
          return updated;
        },
        catch: (cause) =>
          new StoreError({ operation: "set harness", message: errorMessage(cause), cause }),
      }),
    ),

    dropBinding: Effect.fn("ThreadStore.dropBinding")((thread: RelayThread, harness: Harness) =>
      Effect.tryPromise({
        try: async () => {
          const bindings = { ...thread.bindings };
          delete bindings[harness];
          const updated: RelayThread = {
            ...thread,
            bindings,
            preferredModels: {
              ...thread.preferredModels,
              ...(thread.bindings[harness]?.model
                ? { [harness]: thread.bindings[harness].model }
                : {}),
            },
            updatedAt: new Date().toISOString(),
          };
          await atomicJsonWrite(metadataPath(thread.id), updated);
          return updated;
        },
        catch: (cause) =>
          new StoreError({
            operation: "drop uncertain binding",
            message: errorMessage(cause),
            cause,
          }),
      }),
    ),

    undoLastTurn: Effect.fn("ThreadStore.undoLastTurn")((thread: RelayThread, harness: Harness) =>
      Effect.tryPromise({
        try: async () => {
          const messages = await readMessages(thread.id);
          const removed = messages.slice(-2);
          if (
            removed.length !== 2 ||
            removed[0]?.role !== "user" ||
            removed[1]?.role !== "assistant" ||
            removed[1].harness !== harness
          ) {
            throw new NoCurrentThread({
              message: `There is no latest ${harness} turn to undo safely`,
            });
          }
          const remaining = messages.slice(0, -2);
          const lastSeq = remaining.at(-1)?.seq ?? 0;
          const lastHarnessSeq =
            remaining.findLast(
              (message) => message.role === "assistant" && message.harness === harness,
            )?.seq ?? 0;
          const binding = thread.bindings[harness];
          const bindings = { ...thread.bindings };
          if (binding) {
            bindings[harness] = {
              ...binding,
              lastSyncedSeq: Math.min(binding.lastSyncedSeq, lastHarnessSeq),
              updatedAt: new Date().toISOString(),
            };
          }
          const other = harness === "codex" ? "opencode" : "codex";
          if (bindings[other] && bindings[other]!.lastSyncedSeq > lastSeq) delete bindings[other];
          const updated: RelayThread = {
            ...thread,
            bindings,
            lastSeq,
            updatedAt: new Date().toISOString(),
          };
          const state = await readUndoState(thread.id);
          await atomicJsonWrite(undoPath(thread.id), {
            entries: [...state.entries, { messages: removed, thread }],
          });
          await atomicTextWrite(
            eventsPath(thread.id),
            remaining.map((message) => JSON.stringify(message)).join("\n") +
              (remaining.length ? "\n" : ""),
          );
          await atomicJsonWrite(metadataPath(thread.id), updated);
          return updated;
        },
        catch: (cause) =>
          cause instanceof NoCurrentThread
            ? cause
            : new StoreError({ operation: "undo turn", message: errorMessage(cause), cause }),
      }),
    ),

    redoLastTurn: Effect.fn("ThreadStore.redoLastTurn")((thread: RelayThread, harness: Harness) =>
      Effect.tryPromise({
        try: async () => {
          const state = await readUndoState(thread.id);
          const entry = state.entries.at(-1);
          if (!entry || entry.thread.activeHarness !== harness) {
            throw new NoCurrentThread({ message: "There is no turn to redo" });
          }
          const messages = await readMessages(thread.id);
          const restored = [...messages, ...entry.messages];
          await atomicTextWrite(
            eventsPath(thread.id),
            `${restored.map((message) => JSON.stringify(message)).join("\n")}\n`,
          );
          await atomicJsonWrite(metadataPath(thread.id), entry.thread);
          const entries = state.entries.slice(0, -1);
          if (entries.length) await atomicJsonWrite(undoPath(thread.id), { entries });
          else await rm(undoPath(thread.id), { force: true });
          return entry.thread;
        },
        catch: (cause) =>
          cause instanceof NoCurrentThread
            ? cause
            : new StoreError({ operation: "redo turn", message: errorMessage(cause), cause }),
      }),
    ),
  });
}
