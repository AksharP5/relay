import { Context, Effect, Layer, Schema } from "effect";
import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { NoCurrentThread, StoreError, ThreadBusy, ThreadNotFound } from "../errors.ts";
import {
  RelayIndex,
  RelayMessage,
  RelayThread,
  type Harness,
  type HarnessBinding,
  type NativeTranscriptTurn,
  type RelayTaskExport,
} from "../domain.ts";
import { RelayPaths, type RelayPathsShape } from "./data-root.ts";

const defaultIndex: RelayIndex = { currentThreadId: null, threadIds: [] };

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const threadDir = (paths: RelayPathsShape, id: string) => `${paths.root}/threads/${id}`;
const metadataPath = (paths: RelayPathsShape, id: string) => `${threadDir(paths, id)}/thread.json`;
const eventsPath = (paths: RelayPathsShape, id: string) => `${threadDir(paths, id)}/events.jsonl`;
const indexPath = (paths: RelayPathsShape) => `${paths.root}/index.json`;
const deletionPath = (paths: RelayPathsShape, id: string) => `${paths.root}/deletions/${id}.json`;
const pendingPath = (paths: RelayPathsShape, id: string) =>
  `${threadDir(paths, id)}/pending-turn.json`;
const undoPath = (paths: RelayPathsShape, id: string) => `${threadDir(paths, id)}/undo-stack.json`;
const visibilityPath = (paths: RelayPathsShape, id: string) =>
  `${threadDir(paths, id)}/native-visibility.json`;
const lockPath = (paths: RelayPathsShape, id: string) => `${paths.root}/locks/${id}`;
const runLockPath = (paths: RelayPathsShape, id: string) => `${paths.root}/run-locks/${id}`;
const checkoutLockPath = async (paths: RelayPathsShape, cwd: string) => {
  const absolute = resolve(cwd);
  let root = await realpath(absolute).catch(() => absolute);
  while (true) {
    const gitMarker = await stat(join(root, ".git")).catch(() => undefined);
    if (gitMarker) break;
    const parent = dirname(root);
    if (parent === root) {
      root = await realpath(absolute).catch(() => absolute);
      break;
    }
    root = parent;
  }
  return `${paths.root}/checkout-locks/${createHash("sha256").update(root).digest("hex")}`;
};
const maxEventLineChars = 4_000_000;
const NativeVisibility = Schema.Struct({
  hidden: Schema.Array(Schema.String),
  links: Schema.optional(
    Schema.Array(Schema.Struct({ messageId: Schema.String, key: Schema.String })),
  ),
});
type NativeVisibility = typeof NativeVisibility.Type;

const secureDirectory = async (path: string) => {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
};

const ensureBase = async (paths: RelayPathsShape) => {
  await secureDirectory(paths.root);
  await secureDirectory(`${paths.root}/threads`);
  await secureDirectory(`${paths.root}/locks`);
  await secureDirectory(`${paths.root}/run-locks`);
  await secureDirectory(`${paths.root}/checkout-locks`);
  await secureDirectory(`${paths.root}/deletions`);
};

const readJson = async <A>(path: string, schema: Schema.Decoder<A>): Promise<A | undefined> => {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  await chmod(path, 0o600);
  const value: unknown = await file.json();
  return Schema.decodeUnknownSync(schema)(value) as A;
};

const readVisibility = async (paths: RelayPathsShape, id: string): Promise<NativeVisibility> =>
  (await readJson(visibilityPath(paths, id), NativeVisibility)) ?? { hidden: [] };

const visibilityKey = (harness: Harness, sessionId: string, nativeId: string) =>
  `${harness}:${sessionId}:${nativeId}`;

const isVisible = (
  message: RelayMessage,
  hidden: ReadonlySet<string>,
  links: ReadonlyMap<string, string>,
) => {
  const key =
    message.nativeId && message.nativeSessionId
      ? visibilityKey(message.harness, message.nativeSessionId, message.nativeId)
      : links.get(message.id);
  return !key || !hidden.has(key);
};

const visibleMessages = (messages: ReadonlyArray<RelayMessage>, visibility: NativeVisibility) => {
  const hidden = new Set(visibility.hidden);
  const links = new Map((visibility.links ?? []).map((link) => [link.messageId, link.key]));
  return messages.filter((message) => isVisible(message, hidden, links));
};

const atomicTextWrite = async (paths: RelayPathsShape, path: string, value: string) => {
  await ensureBase(paths);
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  await secureDirectory(dirname(path));
  await writeFile(temp, value, { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
  await chmod(path, 0o600);
};

const atomicJsonWrite = (paths: RelayPathsShape, path: string, value: unknown) =>
  atomicTextWrite(paths, path, `${JSON.stringify(value, null, 2)}\n`);

const StoredIndexV1 = Schema.Struct({ version: Schema.Literal(1), ...RelayIndex.fields });
const StoredThreadV1 = Schema.Struct({ version: Schema.Literal(1), ...RelayThread.fields });

const hasVersion = (value: unknown): value is { readonly version: unknown } =>
  typeof value === "object" && value !== null && Object.hasOwn(value, "version");

const decodeStored = <A>(
  value: unknown,
  current: Schema.Decoder<A>,
  stored: Schema.Decoder<A & { readonly version: 1 }>,
  label: string,
): { readonly value: A; readonly legacy: boolean } => {
  if (!hasVersion(value)) return { value: Schema.decodeUnknownSync(current)(value), legacy: true };
  if (value.version !== 1) {
    const version = typeof value.version === "number" ? value.version : "unknown";
    throw new Error(
      `Relay ${label} storage format ${version} is not supported by this release (expected version 1)`,
    );
  }
  const decoded = Schema.decodeUnknownSync(stored)(value);
  const { version: _, ...runtime } = decoded;
  return { value: runtime as A, legacy: false };
};

const readIndexFile = async (paths: RelayPathsShape) => {
  const file = Bun.file(indexPath(paths));
  if (!(await file.exists())) return { value: defaultIndex, legacy: false };
  await chmod(indexPath(paths), 0o600);
  return decodeStored(await file.json(), RelayIndex, StoredIndexV1, "index");
};

const readThreadFile = async (paths: RelayPathsShape, id: string) => {
  const file = Bun.file(metadataPath(paths, id));
  if (!(await file.exists())) return undefined;
  await chmod(metadataPath(paths, id), 0o600);
  return decodeStored(await file.json(), RelayThread, StoredThreadV1, "task");
};

const writeIndex = (paths: RelayPathsShape, index: RelayIndex) =>
  atomicJsonWrite(paths, indexPath(paths), { version: 1, ...index });
const writeThread = (paths: RelayPathsShape, thread: RelayThread) =>
  atomicJsonWrite(paths, metadataPath(paths, thread.id), { version: 1, ...thread });

const DeletionJournal = Schema.Struct({
  version: Schema.Literal(1),
  threadId: Schema.String,
  createdAt: Schema.String,
});

const readDeletionJournals = async (paths: RelayPathsShape) => {
  const journals: Array<typeof DeletionJournal.Type> = [];
  for (const entry of await readdir(`${paths.root}/deletions`)) {
    if (!entry.endsWith(".json")) continue;
    const path = `${paths.root}/deletions/${entry}`;
    await chmod(path, 0o600);
    journals.push(
      Schema.decodeUnknownSync(DeletionJournal)(JSON.parse(await readFile(path, "utf8"))),
    );
  }
  return journals;
};

const readRawMessages = async (
  paths: RelayPathsShape,
  id: string,
  options: { readonly repairTail?: boolean } = {},
): Promise<Array<RelayMessage>> => {
  const file = Bun.file(eventsPath(paths, id));
  if (!(await file.exists())) return [];
  await chmod(eventsPath(paths, id), 0o600);
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
          paths,
          eventsPath(paths, id),
          messages.map((message) => JSON.stringify(message)).join("\n") + "\n",
        );
      }
    }
  }
  if (options.repairTail && !text.endsWith("\n")) {
    await atomicTextWrite(
      paths,
      eventsPath(paths, id),
      messages.map((message) => JSON.stringify(message)).join("\n") + "\n",
    );
  }
  return messages;
};

const readMessages = async (
  paths: RelayPathsShape,
  id: string,
  options: { readonly repairTail?: boolean } = {},
) => {
  const [messages, visibility] = await Promise.all([
    readRawMessages(paths, id, options),
    readVisibility(paths, id),
  ]);
  return visibleMessages(messages, visibility);
};

const scanMessages = async (
  paths: RelayPathsShape,
  id: string,
  onMessage: (message: RelayMessage) => void,
) => {
  const file = Bun.file(eventsPath(paths, id));
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
  paths: RelayPathsShape,
  id: string,
  afterSeq: number,
  limits: { readonly maxMessages: number; readonly maxChars: number },
) => {
  const messages: Array<RelayMessage> = [];
  let chars = 0;
  let omittedMessages = 0;
  const visibility = await readVisibility(paths, id);
  const hidden = new Set(visibility.hidden);
  const links = new Map((visibility.links ?? []).map((link) => [link.messageId, link.key]));
  await scanMessages(paths, id, (message) => {
    if (!isVisible(message, hidden, links)) return;
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
  paths: RelayPathsShape,
  id: string,
  options: { readonly maxMessages: number; readonly maxChars: number },
) => {
  const messages: Array<RelayMessage> = [];
  let chars = 0;
  const visibility = await readVisibility(paths, id);
  const hidden = new Set(visibility.hidden);
  const links = new Map((visibility.links ?? []).map((link) => [link.messageId, link.key]));
  await scanMessages(paths, id, (message) => {
    if (!isVisible(message, hidden, links)) return;
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

const loadIndex = async (
  paths: RelayPathsShape,
  options: { readonly lockHeld?: boolean } = {},
): Promise<RelayIndex> => {
  await ensureBase(paths);
  const stored = await readIndexFile(paths);
  const journals = await readDeletionJournals(paths);
  if (!stored.legacy && journals.length === 0) return stored.value;
  if (options.lockHeld) {
    const deleted = new Set(journals.map((journal) => journal.threadId));
    const threadIds = stored.value.threadIds.filter((id) => !deleted.has(id));
    const value: RelayIndex = {
      currentThreadId:
        stored.value.currentThreadId && deleted.has(stored.value.currentThreadId)
          ? (threadIds[0] ?? null)
          : stored.value.currentThreadId,
      threadIds,
    };
    await writeIndex(paths, value);
    for (const journal of journals) {
      await rm(threadDir(paths, journal.threadId), { recursive: true, force: true });
      await rm(deletionPath(paths, journal.threadId), { force: true });
    }
    return value;
  }
  const lock = await acquireIndexLock(paths);
  try {
    return await loadIndex(paths, { lockHeld: true });
  } finally {
    await lock.release();
  }
};

const PendingTurn = Schema.Struct({
  version: Schema.Literal(1),
  messages: Schema.Array(RelayMessage),
  thread: RelayThread,
  replaceEvents: Schema.optional(Schema.Boolean),
  visibility: Schema.optional(NativeVisibility),
});
type PendingTurn = typeof PendingTurn.Type;

interface UndoEntry {
  readonly messages: ReadonlyArray<RelayMessage>;
  readonly thread: RelayThread;
}

interface UndoState {
  readonly entries: ReadonlyArray<UndoEntry>;
}

const readUndoState = async (paths: RelayPathsShape, id: string): Promise<UndoState> => {
  const file = Bun.file(undoPath(paths, id));
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

const claimState = async (path: string): Promise<"live" | "starting" | "stale"> => {
  try {
    const owner = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown };
    return typeof owner.pid === "number" && processIsAlive(owner.pid) ? "live" : "stale";
  } catch {
    try {
      return Date.now() - (await stat(path)).mtimeMs < 5 * 60 * 1000 ? "starting" : "stale";
    } catch {
      return "stale";
    }
  }
};

async function liveLockExists(paths: RelayPathsShape, id: string) {
  const path = lockPath(paths, id);
  try {
    for (const entry of await readdir(path)) {
      if (!entry.endsWith(".json")) continue;
      const claim = `${path}/${entry}`;
      const state = await claimState(claim);
      if (state !== "stale") return true;
      await rm(claim, { force: true });
    }
  } catch (cause) {
    const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
    if (code !== "ENOENT") throw cause;
  }
  return false;
}

interface RecoveredThread {
  readonly thread: RelayThread;
  readonly messages: ReadonlyArray<RelayMessage>;
}

const recoverThreadLocked = async (
  paths: RelayPathsShape,
  thread: RelayThread,
): Promise<RecoveredThread> => {
  const latest = (await readThreadFile(paths, thread.id))?.value ?? thread;
  const latestPending = await readJson<PendingTurn>(pendingPath(paths, thread.id), PendingTurn);
  const latestMessages = await readRawMessages(paths, thread.id, { repairTail: true });
  if (latestPending) {
    if (latestPending.replaceEvents) {
      const eventText =
        latestPending.messages.length > 0
          ? `${latestPending.messages.map((message) => JSON.stringify(message)).join("\n")}\n`
          : "";
      await atomicTextWrite(paths, eventsPath(paths, thread.id), eventText);
      await atomicJsonWrite(
        paths,
        visibilityPath(paths, thread.id),
        latestPending.visibility ?? { hidden: [], links: [] },
      );
      await writeThread(paths, latestPending.thread);
      await rm(undoPath(paths, thread.id), { force: true });
      await rm(pendingPath(paths, thread.id), { force: true });
      return { thread: latestPending.thread, messages: [...latestPending.messages] };
    }
    const existingIds = new Set(latestMessages.map((message) => message.id));
    const missing = latestPending.messages.filter((message) => !existingIds.has(message.id));
    if (missing.length > 0) {
      await appendFile(
        eventsPath(paths, thread.id),
        `${missing.map((message) => JSON.stringify(message)).join("\n")}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    }
    await writeThread(paths, latestPending.thread);
    await rm(pendingPath(paths, thread.id), { force: true });
    return {
      thread: latestPending.thread,
      messages: [...latestMessages, ...missing],
    };
  }

  // A native-context adoption compacts the superseded event prefix while
  // retaining its sequence boundary. If Relay stops before importing the
  // selected transcript, an empty active log must not rewind that boundary.
  const repairedSeq = Math.max(latest.contextStartSeq ?? 0, latestMessages.at(-1)?.seq ?? 0);
  if (repairedSeq === latest.lastSeq) return { thread: latest, messages: latestMessages };
  const repaired = { ...latest, lastSeq: repairedSeq };
  await writeThread(paths, repaired);
  return { thread: repaired, messages: latestMessages };
};

const recoverThread = async (paths: RelayPathsShape, thread: RelayThread): Promise<RelayThread> => {
  if (await liveLockExists(paths, thread.id)) return thread;

  let lock: Awaited<ReturnType<typeof acquireThreadLock>>;
  try {
    lock = await acquireThreadLock(paths, thread.id);
  } catch (cause) {
    if (cause instanceof ThreadBusy) return thread;
    throw cause;
  }

  try {
    return (await recoverThreadLocked(paths, thread)).thread;
  } finally {
    await lock.release();
  }
};

const readThreadMetadata = async (
  paths: RelayPathsShape,
  id: string,
): Promise<RelayThread | undefined> => {
  const stored = await readThreadFile(paths, id);
  if (!stored) return undefined;
  if (stored.legacy && !(await liveLockExists(paths, id))) {
    let lock: Awaited<ReturnType<typeof acquireThreadLock>> | undefined;
    try {
      lock = await acquireThreadLock(paths, id);
      const latest = await readThreadFile(paths, id);
      if (latest?.legacy) await writeThread(paths, latest.value);
    } catch (cause) {
      if (!(cause instanceof ThreadBusy)) throw cause;
    } finally {
      await lock?.release();
    }
  }
  return stored.value;
};

const readThread = async (paths: RelayPathsShape, id: string): Promise<RelayThread | undefined> => {
  const thread = await readThreadMetadata(paths, id);
  return thread ? recoverThread(paths, thread) : undefined;
};

function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireLockAt(
  paths: RelayPathsShape,
  id: string,
  path: string,
  busyMessage: string,
  startingMessage: string,
) {
  await ensureBase(paths);
  const token = crypto.randomUUID();
  await secureDirectory(path);
  const claim = `${path}/${token}.json`;
  await atomicJsonWrite(paths, claim, {
    pid: process.pid,
    token,
    createdAt: new Date().toISOString(),
  });

  let conflict: "live" | "starting" | undefined;
  for (const entry of await readdir(path)) {
    if (!entry.endsWith(".json") || entry === `${token}.json`) continue;
    const otherClaim = `${path}/${entry}`;
    const state = await claimState(otherClaim);
    if (state === "stale") await rm(otherClaim, { force: true });
    else conflict ??= state;
  }
  if (conflict) {
    await rm(claim, { force: true });
    throw new ThreadBusy({
      threadId: id,
      message: conflict === "live" ? busyMessage : startingMessage,
    });
  }

  return { release: () => rm(claim, { force: true }) };
}

const acquireThreadLock = (paths: RelayPathsShape, id: string) =>
  acquireLockAt(
    paths,
    id,
    lockPath(paths, id),
    "This Relay task already has a turn running",
    "This Relay task already has a turn starting",
  );

let indexQueue = Promise.resolve();

const acquireLocalIndexLock = async () => {
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = indexQueue;
  indexQueue = previous.then(() => current);
  await previous;
  return release;
};

const acquireIndexLock = async (paths: RelayPathsShape) => {
  const releaseLocal = await acquireLocalIndexLock();
  try {
    const deadline = Date.now() + 5_000;
    while (true) {
      try {
        const lock = await acquireThreadLock(paths, "__index__");
        return {
          release: async () => {
            try {
              await lock.release();
            } finally {
              releaseLocal();
            }
          },
        };
      } catch (cause) {
        if (!(cause instanceof ThreadBusy) || Date.now() >= deadline) throw cause;
        await Bun.sleep(5 + Math.floor(Math.random() * 15));
      }
    }
  } catch (cause) {
    releaseLocal();
    throw cause;
  }
};

const acquireTaskRunLease = (paths: RelayPathsShape, id: string) =>
  acquireLockAt(
    paths,
    id,
    runLockPath(paths, id),
    "This Relay task is already open or running a turn",
    "This Relay task is already starting elsewhere",
  );

const acquireExecutionLease = async (paths: RelayPathsShape, thread: RelayThread) => {
  const task = await acquireTaskRunLease(paths, thread.id);
  try {
    const checkout = await acquireLockAt(
      paths,
      thread.id,
      await checkoutLockPath(paths, thread.cwd),
      `This checkout is already active in another Relay task. Use a separate git worktree for concurrent agents.`,
      `This checkout is already starting in another Relay task. Try again, or use a separate git worktree.`,
    );
    return {
      release: async () => {
        await checkout.release();
        await task.release();
      },
    };
  } catch (cause) {
    await task.release();
    throw cause;
  }
};

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

export interface BindNativeSessionInput {
  readonly harness: Harness;
  readonly sessionId: string;
  readonly lastSyncedSeq: number;
  readonly nativeCursor?: string;
  readonly model?: string;
}

export interface ResetNativeContextInput {
  readonly harness: Harness;
  readonly sessionId: string;
  readonly nativeCursor?: string;
  readonly model?: string;
  readonly turns: ReadonlyArray<NativeTranscriptTurn>;
  readonly hiddenTurnIds?: ReadonlyArray<string>;
}

export interface ImportNativeTurnsInput {
  readonly harness: Harness;
  readonly sessionId: string;
  readonly turns: ReadonlyArray<NativeTranscriptTurn>;
  readonly hiddenTurnIds?: ReadonlyArray<string>;
  readonly model?: string;
}

export interface BeginNativeHandoffInput {
  readonly harness: Harness;
  readonly sessionId?: string;
  readonly fromSeq: number;
  readonly throughSeq: number;
}

export class ThreadStore extends Context.Service<
  ThreadStore,
  {
    readonly create: (input: CreateThreadInput) => Effect.Effect<RelayThread, StoreError>;
    readonly current: () => Effect.Effect<
      RelayThread,
      StoreError | NoCurrentThread | ThreadNotFound
    >;
    readonly currentMetadata: () => Effect.Effect<
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
    readonly exportTask: (thread: RelayThread) => Effect.Effect<RelayTaskExport, StoreError>;
    readonly deleteTask: (
      thread: RelayThread,
    ) => Effect.Effect<RelayThread, StoreError | ThreadBusy>;
    readonly acquireLock: (
      id: string,
    ) => Effect.Effect<{ readonly release: () => Promise<void> }, StoreError | ThreadBusy>;
    readonly acquireRunLease: (
      id: string,
    ) => Effect.Effect<{ readonly release: () => Promise<void> }, StoreError | ThreadBusy>;
    readonly acquireExecutionLease: (
      thread: RelayThread,
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
    readonly bindNativeSession: (
      thread: RelayThread,
      input: BindNativeSessionInput,
    ) => Effect.Effect<RelayThread, StoreError>;
    readonly resetNativeContext: (
      thread: RelayThread,
      input: ResetNativeContextInput,
    ) => Effect.Effect<RelayThread, StoreError>;
    readonly beginNativeHandoff: (
      thread: RelayThread,
      input: BeginNativeHandoffInput,
    ) => Effect.Effect<RelayThread, StoreError>;
    readonly abandonNativeHandoff: (
      thread: RelayThread,
      harness: Harness,
    ) => Effect.Effect<RelayThread, StoreError>;
    readonly importNativeTurns: (
      thread: RelayThread,
      input: ImportNativeTurnsInput,
    ) => Effect.Effect<RelayThread, StoreError>;
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
  static readonly configuredLayer = Layer.effect(
    ThreadStore,
    Effect.gen(function* () {
      const paths = yield* RelayPaths;
      return ThreadStore.of({
        root: paths.root,

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
              const indexLock = await acquireIndexLock(paths);
              try {
                try {
                  await writeThread(paths, thread);
                  await secureDirectory(threadDir(paths, thread.id));
                  await writeFile(eventsPath(paths, thread.id), "", {
                    encoding: "utf8",
                    mode: 0o600,
                  });
                  const index = await loadIndex(paths, { lockHeld: true });
                  await writeIndex(paths, {
                    currentThreadId: thread.id,
                    threadIds: [thread.id, ...index.threadIds.filter((id) => id !== thread.id)],
                  } satisfies RelayIndex);
                } catch (cause) {
                  await rm(threadDir(paths, thread.id), { recursive: true, force: true });
                  throw cause;
                }
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
            try: () => loadIndex(paths),
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
              const thread = await readThread(paths, index.currentThreadId!);
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

        currentMetadata: Effect.fn("ThreadStore.currentMetadata")(function* () {
          const index = yield* Effect.tryPromise({
            try: () => loadIndex(paths),
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
              const thread = await readThreadMetadata(paths, index.currentThreadId!);
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
                    operation: "read current thread metadata",
                    message: errorMessage(cause),
                    cause,
                  }),
          });
        }),

        get: Effect.fn("ThreadStore.get")((id: string) =>
          Effect.tryPromise({
            try: async () => {
              const thread = await readThread(paths, id);
              if (!thread)
                throw new ThreadNotFound({
                  threadId: id,
                  message: `Relay task ${id} was not found`,
                });
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
              const index = await loadIndex(paths);
              const threads = await Promise.all(
                index.threadIds.map((id) => readThreadMetadata(paths, id)),
              );
              return threads.filter((thread): thread is RelayThread => thread !== undefined);
            },
            catch: (cause) =>
              new StoreError({ operation: "list threads", message: errorMessage(cause), cause }),
          }),
        ),

        messages: Effect.fn("ThreadStore.messages")((id: string) =>
          Effect.tryPromise({
            try: () => readMessages(paths, id),
            catch: (cause) =>
              new StoreError({ operation: "read messages", message: errorMessage(cause), cause }),
          }),
        ),

        messagesSince: Effect.fn("ThreadStore.messagesSince")((id: string, afterSeq: number) =>
          Effect.tryPromise({
            try: () =>
              readMessagesSince(paths, id, afterSeq, { maxMessages: 200, maxChars: 120_000 }),
            catch: (cause) =>
              new StoreError({
                operation: "read message delta",
                message: errorMessage(cause),
                cause,
              }),
          }),
        ),

        recentMessages: Effect.fn("ThreadStore.recentMessages")(
          (id: string, options: { readonly maxMessages: number; readonly maxChars: number }) =>
            Effect.tryPromise({
              try: () => readRecentMessages(paths, id, options),
              catch: (cause) =>
                new StoreError({
                  operation: "read recent messages",
                  message: errorMessage(cause),
                  cause,
                }),
            }),
        ),

        exportTask: Effect.fn("ThreadStore.exportTask")((thread: RelayThread) =>
          Effect.tryPromise({
            try: async () => {
              const runLease = await acquireTaskRunLease(paths, thread.id);
              try {
                const lock = await acquireThreadLock(paths, thread.id);
                try {
                  const current = await readThreadFile(paths, thread.id);
                  if (!current) throw new Error(`Relay task ${thread.id} no longer exists`);
                  const recovered = await recoverThreadLocked(paths, current.value);
                  const contextStartSeq = recovered.thread.contextStartSeq ?? 0;
                  const messages = visibleMessages(
                    recovered.messages,
                    await readVisibility(paths, thread.id),
                  ).filter((message) => message.seq > contextStartSeq);
                  return {
                    formatVersion: 1 as const,
                    exportedAt: new Date().toISOString(),
                    task: {
                      id: recovered.thread.id,
                      title: recovered.thread.title,
                      cwd: recovered.thread.cwd,
                      activeHarness: recovered.thread.activeHarness,
                      createdAt: recovered.thread.createdAt,
                      updatedAt: recovered.thread.updatedAt,
                    },
                    messages: messages.map((message) => ({
                      seq: message.seq,
                      role: message.role,
                      content: message.content,
                      harness: message.harness,
                      createdAt: message.createdAt,
                    })),
                  };
                } finally {
                  await lock.release();
                }
              } finally {
                await runLease.release();
              }
            },
            catch: (cause) =>
              new StoreError({ operation: "export task", message: errorMessage(cause), cause }),
          }),
        ),

        deleteTask: Effect.fn("ThreadStore.deleteTask")((thread: RelayThread) =>
          Effect.tryPromise({
            try: async () => {
              const runLease = await acquireTaskRunLease(paths, thread.id);
              try {
                const lock = await acquireThreadLock(paths, thread.id);
                try {
                  const indexLock = await acquireIndexLock(paths);
                  try {
                    const index = await loadIndex(paths, { lockHeld: true });
                    const remaining = index.threadIds.filter((id) => id !== thread.id);
                    await atomicJsonWrite(paths, deletionPath(paths, thread.id), {
                      version: 1,
                      threadId: thread.id,
                      createdAt: new Date().toISOString(),
                    });
                    await writeIndex(paths, {
                      currentThreadId:
                        index.currentThreadId === thread.id
                          ? (remaining[0] ?? null)
                          : index.currentThreadId,
                      threadIds: remaining,
                    } satisfies RelayIndex);
                    await rm(threadDir(paths, thread.id), { recursive: true, force: true });
                    await rm(deletionPath(paths, thread.id), { force: true });
                  } finally {
                    await indexLock.release();
                  }
                } finally {
                  await lock.release();
                }
              } finally {
                await runLease.release();
              }
              return thread;
            },
            catch: (cause) =>
              cause instanceof ThreadBusy
                ? cause
                : new StoreError({ operation: "delete task", message: errorMessage(cause), cause }),
          }),
        ),

        acquireLock: Effect.fn("ThreadStore.acquireLock")((id: string) =>
          Effect.tryPromise({
            try: () => acquireThreadLock(paths, id),
            catch: (cause) =>
              cause instanceof ThreadBusy
                ? cause
                : new StoreError({ operation: "lock thread", message: errorMessage(cause), cause }),
          }),
        ),

        acquireRunLease: Effect.fn("ThreadStore.acquireRunLease")((id: string) =>
          Effect.tryPromise({
            try: () => acquireTaskRunLease(paths, id),
            catch: (cause) =>
              cause instanceof ThreadBusy
                ? cause
                : new StoreError({
                    operation: "own task run",
                    message: errorMessage(cause),
                    cause,
                  }),
          }),
        ),

        acquireExecutionLease: Effect.fn("ThreadStore.acquireExecutionLease")(
          (thread: RelayThread) =>
            Effect.tryPromise({
              try: () => acquireExecutionLease(paths, thread),
              catch: (cause) =>
                cause instanceof ThreadBusy
                  ? cause
                  : new StoreError({
                      operation: "own checkout run",
                      message: errorMessage(cause),
                      cause,
                    }),
            }),
        ),

        canUndoLastTurn: Effect.fn("ThreadStore.canUndoLastTurn")(
          (thread: RelayThread, harness: Harness) =>
            Effect.tryPromise({
              try: async () => {
                const messages = (await readMessages(paths, thread.id)).filter(
                  (message) => message.seq > (thread.contextStartSeq ?? 0),
                );
                const latest = messages.slice(-2);
                return (
                  latest.length === 2 &&
                  latest[0]?.role === "user" &&
                  latest[1]?.role === "assistant" &&
                  latest[1].harness === harness
                );
              },
              catch: (cause) =>
                new StoreError({
                  operation: "check undo state",
                  message: errorMessage(cause),
                  cause,
                }),
            }),
        ),

        canRedoLastTurn: Effect.fn("ThreadStore.canRedoLastTurn")(
          (thread: RelayThread, harness: Harness) =>
            Effect.tryPromise({
              try: async () => {
                const entry = (await readUndoState(paths, thread.id)).entries.at(-1);
                return entry?.thread.activeHarness === harness;
              },
              catch: (cause) =>
                new StoreError({
                  operation: "check redo state",
                  message: errorMessage(cause),
                  cause,
                }),
            }),
        ),

        commitTurn: Effect.fn("ThreadStore.commitTurn")(
          (thread: RelayThread, input: CommitTurnInput) =>
            Effect.tryPromise({
              try: async () => {
                const now = new Date().toISOString();
                const user: RelayMessage = {
                  id: crypto.randomUUID(),
                  seq: thread.lastSeq + 1,
                  role: "user",
                  content: input.prompt,
                  harness: input.harness,
                  nativeSessionId: input.sessionId,
                  createdAt: now,
                };
                const response: RelayMessage = {
                  id: crypto.randomUUID(),
                  seq: thread.lastSeq + 2,
                  role: "assistant",
                  content: input.response,
                  harness: input.harness,
                  nativeSessionId: input.sessionId,
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
                const pending: PendingTurn = {
                  version: 1,
                  messages: [user, response],
                  thread: updated,
                };

                await atomicJsonWrite(paths, pendingPath(paths, thread.id), pending);
                await appendFile(
                  eventsPath(paths, thread.id),
                  `${JSON.stringify(user)}\n${JSON.stringify(response)}\n`,
                  {
                    encoding: "utf8",
                    mode: 0o600,
                  },
                );
                await chmod(eventsPath(paths, thread.id), 0o600);
                await writeThread(paths, updated);
                await rm(pendingPath(paths, thread.id), { force: true });
                await rm(undoPath(paths, thread.id), { force: true });
                return { thread: updated, response };
              },
              catch: (cause) =>
                new StoreError({ operation: "commit turn", message: errorMessage(cause), cause }),
            }),
        ),

        bindNativeSession: Effect.fn("ThreadStore.bindNativeSession")(
          (thread: RelayThread, input: BindNativeSessionInput) =>
            Effect.tryPromise({
              try: async () => {
                const now = new Date().toISOString();
                const existing = thread.bindings[input.harness];
                const binding: HarnessBinding = {
                  harness: input.harness,
                  sessionId: input.sessionId,
                  ...(input.model
                    ? { model: input.model }
                    : existing?.model
                      ? { model: existing.model }
                      : {}),
                  lastSyncedSeq: input.lastSyncedSeq,
                  ...(input.nativeCursor
                    ? { nativeCursor: input.nativeCursor }
                    : existing?.nativeCursor
                      ? { nativeCursor: existing.nativeCursor }
                      : {}),
                  createdAt: existing?.createdAt ?? now,
                  updatedAt: now,
                };
                const updated: RelayThread = {
                  ...thread,
                  activeHarness: input.harness,
                  bindings: { ...thread.bindings, [input.harness]: binding },
                  preferredModels: {
                    ...thread.preferredModels,
                    ...(binding.model ? { [input.harness]: binding.model } : {}),
                  },
                  pendingHandoffs: {
                    ...thread.pendingHandoffs,
                    [input.harness]: undefined,
                  },
                  updatedAt: now,
                };
                await writeThread(paths, updated);
                return updated;
              },
              catch: (cause) =>
                new StoreError({
                  operation: "bind native session",
                  message: errorMessage(cause),
                  cause,
                }),
            }),
        ),

        resetNativeContext: Effect.fn("ThreadStore.resetNativeContext")(
          (thread: RelayThread, input: ResetNativeContextInput) =>
            Effect.tryPromise({
              try: async () => {
                const now = new Date().toISOString();
                let nextSeq = thread.lastSeq;
                const messages = input.turns.flatMap((turn): ReadonlyArray<RelayMessage> => {
                  const user: RelayMessage = {
                    id: crypto.randomUUID(),
                    seq: ++nextSeq,
                    role: "user",
                    content: turn.prompt,
                    harness: input.harness,
                    nativeId: turn.id,
                    nativeSessionId: input.sessionId,
                    createdAt: now,
                  };
                  const assistant: RelayMessage = {
                    id: crypto.randomUUID(),
                    seq: ++nextSeq,
                    role: "assistant",
                    content: turn.response,
                    harness: input.harness,
                    nativeId: turn.id,
                    nativeSessionId: input.sessionId,
                    createdAt: now,
                  };
                  return [user, assistant];
                });
                const binding: HarnessBinding = {
                  harness: input.harness,
                  sessionId: input.sessionId,
                  ...(input.model ? { model: input.model } : {}),
                  lastSyncedSeq: nextSeq,
                  ...(input.nativeCursor ? { nativeCursor: input.nativeCursor } : {}),
                  createdAt: now,
                  updatedAt: now,
                };
                const bindings: RelayThread["bindings"] =
                  input.harness === "codex" ? { codex: binding } : { opencode: binding };
                const updated: RelayThread = {
                  ...thread,
                  activeHarness: input.harness,
                  bindings,
                  pendingHandoffs: {},
                  contextStartSeq: thread.lastSeq,
                  preferredModels: {
                    ...thread.preferredModels,
                    ...(binding.model ? { [input.harness]: binding.model } : {}),
                  },
                  lastSeq: nextSeq,
                  ...(input.turns.length > 0 &&
                  (thread.title === "New Relay task" || thread.title === "Untitled task")
                    ? {
                        title:
                          input.turns[0]!.prompt.length <= 64
                            ? input.turns[0]!.prompt
                            : `${input.turns[0]!.prompt.slice(0, 61)}...`,
                      }
                    : {}),
                  updatedAt: now,
                };
                const visibility: NativeVisibility = {
                  hidden: (input.hiddenTurnIds ?? []).map((nativeId) =>
                    visibilityKey(input.harness, input.sessionId, nativeId),
                  ),
                  links: [],
                };
                const pending: PendingTurn = {
                  version: 1,
                  messages: [...messages],
                  thread: updated,
                  replaceEvents: true,
                  visibility,
                };
                // The replacement journal is written before any part of the old
                // context is removed. Recovery replays this exact event set and
                // metadata, so a crash cannot let a newer turn overtake adoption.
                await atomicJsonWrite(paths, pendingPath(paths, thread.id), pending);
                await rm(undoPath(paths, thread.id), { force: true });
                await atomicTextWrite(
                  paths,
                  eventsPath(paths, thread.id),
                  messages.length > 0
                    ? `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`
                    : "",
                );
                await atomicJsonWrite(paths, visibilityPath(paths, thread.id), visibility);
                await writeThread(paths, updated);
                await rm(pendingPath(paths, thread.id), { force: true });
                return updated;
              },
              catch: (cause) =>
                new StoreError({
                  operation: "reset native context",
                  message: errorMessage(cause),
                  cause,
                }),
            }),
        ),

        beginNativeHandoff: Effect.fn("ThreadStore.beginNativeHandoff")(
          (thread: RelayThread, input: BeginNativeHandoffInput) =>
            Effect.tryPromise({
              try: async () => {
                const now = new Date().toISOString();
                const updated: RelayThread = {
                  ...thread,
                  pendingHandoffs: {
                    ...thread.pendingHandoffs,
                    [input.harness]: {
                      id: crypto.randomUUID(),
                      harness: input.harness,
                      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
                      fromSeq: input.fromSeq,
                      throughSeq: input.throughSeq,
                      createdAt: now,
                    },
                  },
                  updatedAt: now,
                };
                await writeThread(paths, updated);
                return updated;
              },
              catch: (cause) =>
                new StoreError({
                  operation: "journal native handoff",
                  message: errorMessage(cause),
                  cause,
                }),
            }),
        ),

        abandonNativeHandoff: Effect.fn("ThreadStore.abandonNativeHandoff")(
          (thread: RelayThread, harness: Harness) =>
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
                  pendingHandoffs: {
                    ...thread.pendingHandoffs,
                    [harness]: undefined,
                  },
                  updatedAt: new Date().toISOString(),
                };
                await writeThread(paths, updated);
                return updated;
              },
              catch: (cause) =>
                new StoreError({
                  operation: "recover uncertain native handoff",
                  message: errorMessage(cause),
                  cause,
                }),
            }),
        ),

        importNativeTurns: Effect.fn("ThreadStore.importNativeTurns")(
          (thread: RelayThread, input: ImportNativeTurnsInput) =>
            Effect.tryPromise({
              try: async () => {
                const existingMessages = await readRawMessages(paths, thread.id);
                const contextMessages = existingMessages.filter(
                  (message) => message.seq > (thread.contextStartSeq ?? 0),
                );
                const visibility = await readVisibility(paths, thread.id);
                const links = new Map(
                  (visibility.links ?? []).map((link) => [link.messageId, link.key]),
                );
                const sessionPrefix = `${input.harness}:${input.sessionId}:`;
                const contextMessageIds = new Set(contextMessages.map((message) => message.id));
                const importedIds = new Set([
                  ...contextMessages.flatMap((message) =>
                    message.harness === input.harness &&
                    message.nativeSessionId === input.sessionId &&
                    message.nativeId
                      ? [message.nativeId]
                      : [],
                  ),
                  ...(visibility.links ?? []).flatMap((link) =>
                    contextMessageIds.has(link.messageId) && link.key.startsWith(sessionPrefix)
                      ? [link.key.slice(sessionPrefix.length)]
                      : [],
                  ),
                ]);
                const linkedMessageIds = new Set(
                  [...links.keys()].filter((messageId) => contextMessageIds.has(messageId)),
                );
                const linkablePairs = contextMessages.flatMap((user, index) => {
                  const assistant = contextMessages[index + 1];
                  return user.role === "user" &&
                    assistant?.role === "assistant" &&
                    user.harness === input.harness &&
                    assistant.harness === input.harness &&
                    user.nativeSessionId === input.sessionId &&
                    assistant.nativeSessionId === input.sessionId &&
                    !user.nativeId &&
                    !assistant.nativeId &&
                    !linkedMessageIds.has(user.id) &&
                    !linkedMessageIds.has(assistant.id)
                    ? [{ user, assistant, used: false }]
                    : [];
                });
                const fresh: Array<NativeTranscriptTurn> = [];
                for (const turn of input.turns) {
                  if (importedIds.has(turn.id)) continue;
                  const pair = linkablePairs.find(
                    (candidate) =>
                      !candidate.used &&
                      candidate.user.content === turn.prompt &&
                      candidate.assistant.content === turn.response,
                  );
                  if (!pair) {
                    fresh.push(turn);
                    continue;
                  }
                  pair.used = true;
                  const key = visibilityKey(input.harness, input.sessionId, turn.id);
                  links.set(pair.user.id, key);
                  links.set(pair.assistant.id, key);
                }
                const now = new Date().toISOString();
                let nextSeq = thread.lastSeq;
                const messages = fresh.flatMap((turn): ReadonlyArray<RelayMessage> => {
                  const user: RelayMessage = {
                    id: crypto.randomUUID(),
                    seq: ++nextSeq,
                    role: "user",
                    content: turn.prompt,
                    harness: input.harness,
                    nativeId: turn.id,
                    nativeSessionId: input.sessionId,
                    createdAt: now,
                  };
                  const assistant: RelayMessage = {
                    id: crypto.randomUUID(),
                    seq: ++nextSeq,
                    role: "assistant",
                    content: turn.response,
                    harness: input.harness,
                    nativeId: turn.id,
                    nativeSessionId: input.sessionId,
                    createdAt: now,
                  };
                  return [user, assistant];
                });
                const existingBinding = thread.bindings[input.harness];
                const binding: HarnessBinding = {
                  harness: input.harness,
                  sessionId: input.sessionId,
                  ...(input.model
                    ? { model: input.model }
                    : existingBinding?.model
                      ? { model: existingBinding.model }
                      : {}),
                  lastSyncedSeq:
                    messages.length > 0 ? nextSeq : (existingBinding?.lastSyncedSeq ?? 0),
                  ...(input.turns.at(-1)?.id
                    ? { nativeCursor: input.turns.at(-1)!.id }
                    : existingBinding?.nativeCursor
                      ? { nativeCursor: existingBinding.nativeCursor }
                      : {}),
                  createdAt: existingBinding?.createdAt ?? now,
                  updatedAt: now,
                };
                const updateTitle =
                  fresh.length > 0 &&
                  (thread.title === "New Relay task" || thread.title === "Untitled task");
                const hiddenBefore = new Set(visibility.hidden);
                const hidden = new Set(visibility.hidden);
                const hiddenIds = new Set(input.hiddenTurnIds ?? []);
                const currentIds = new Set([...input.turns.map((turn) => turn.id), ...hiddenIds]);
                // Reconcile the native transcript itself, not only messages that
                // were already present in the current Relay context. Otherwise a
                // tombstone from an older adopted context can hide a freshly
                // re-imported OpenCode turn after native redo.
                for (const nativeId of currentIds) {
                  const key = visibilityKey(input.harness, input.sessionId, nativeId);
                  if (hiddenIds.has(nativeId)) hidden.add(key);
                  else hidden.delete(key);
                }
                for (const message of contextMessages) {
                  if (message.harness !== input.harness) continue;
                  const key =
                    message.nativeSessionId === input.sessionId && message.nativeId
                      ? visibilityKey(input.harness, input.sessionId, message.nativeId)
                      : links.get(message.id);
                  if (!key || !key.startsWith(sessionPrefix)) continue;
                  const nativeId = key.slice(sessionPrefix.length);
                  if (!currentIds.has(nativeId)) continue;
                  if (hiddenIds.has(nativeId)) hidden.add(key);
                  else hidden.delete(key);
                }
                const visibilityChanged =
                  hidden.size !== hiddenBefore.size ||
                  [...hidden].some((key) => !hiddenBefore.has(key));
                const bindings = { ...thread.bindings, [input.harness]: binding };
                if (visibilityChanged) {
                  const other = input.harness === "codex" ? "opencode" : "codex";
                  delete bindings[other];
                }
                const updated: RelayThread = {
                  ...thread,
                  ...(updateTitle
                    ? {
                        title:
                          fresh[0]!.prompt.length <= 64
                            ? fresh[0]!.prompt
                            : `${fresh[0]!.prompt.slice(0, 61)}...`,
                      }
                    : {}),
                  activeHarness: input.harness,
                  bindings,
                  preferredModels: {
                    ...thread.preferredModels,
                    ...(binding.model ? { [input.harness]: binding.model } : {}),
                  },
                  lastSeq: nextSeq,
                  updatedAt: now,
                };

                if (messages.length > 0) {
                  const pending: PendingTurn = {
                    version: 1,
                    messages: [...messages],
                    thread: updated,
                  };
                  await atomicJsonWrite(paths, pendingPath(paths, thread.id), pending);
                  await appendFile(
                    eventsPath(paths, thread.id),
                    `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
                    { encoding: "utf8", mode: 0o600 },
                  );
                  await chmod(eventsPath(paths, thread.id), 0o600);
                }
                if (
                  hidden.size !== hiddenBefore.size ||
                  [...hidden].some((key) => !hiddenBefore.has(key))
                ) {
                  await atomicJsonWrite(paths, visibilityPath(paths, thread.id), {
                    hidden: [...hidden],
                    links: [...links].map(([messageId, key]) => ({ messageId, key })),
                  });
                } else if (links.size !== (visibility.links?.length ?? 0)) {
                  await atomicJsonWrite(paths, visibilityPath(paths, thread.id), {
                    hidden: [...hidden],
                    links: [...links].map(([messageId, key]) => ({ messageId, key })),
                  });
                }
                await writeThread(paths, updated);
                if (messages.length > 0) await rm(pendingPath(paths, thread.id), { force: true });
                await rm(undoPath(paths, thread.id), { force: true });
                return updated;
              },
              catch: (cause) =>
                new StoreError({
                  operation: "import native turns",
                  message: errorMessage(cause),
                  cause,
                }),
            }),
        ),

        setCurrent: Effect.fn("ThreadStore.setCurrent")((id: string) =>
          Effect.tryPromise({
            try: async () => {
              const indexLock = await acquireIndexLock(paths);
              try {
                if (!(await Bun.file(metadataPath(paths, id)).exists())) {
                  throw new ThreadNotFound({
                    threadId: id,
                    message: `Relay task ${id} was not found`,
                  });
                }
                const index = await loadIndex(paths, { lockHeld: true });
                await writeIndex(paths, {
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
              await writeThread(paths, updated);
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
                pendingHandoffs: {
                  ...thread.pendingHandoffs,
                  [harness]: undefined,
                },
                updatedAt: new Date().toISOString(),
              };
              await writeThread(paths, updated);
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

        undoLastTurn: Effect.fn("ThreadStore.undoLastTurn")(
          (thread: RelayThread, harness: Harness) =>
            Effect.tryPromise({
              try: async () => {
                const [messages, rawMessages] = await Promise.all([
                  readMessages(paths, thread.id),
                  readRawMessages(paths, thread.id),
                ]);
                const contextMessages = messages.filter(
                  (message) => message.seq > (thread.contextStartSeq ?? 0),
                );
                const removed = contextMessages.slice(-2);
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
                const removedIds = new Set(removed.map((message) => message.id));
                const remaining = messages.filter((message) => !removedIds.has(message.id));
                const remainingRaw = rawMessages.filter((message) => !removedIds.has(message.id));
                const lastSeq = remainingRaw.at(-1)?.seq ?? 0;
                const lastVisibleSeq = remaining.at(-1)?.seq ?? 0;
                const lastHarnessSeq =
                  remaining.findLast(
                    (message) =>
                      message.seq > (thread.contextStartSeq ?? 0) &&
                      message.role === "assistant" &&
                      message.harness === harness,
                  )?.seq ??
                  thread.contextStartSeq ??
                  0;
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
                if (bindings[other] && bindings[other]!.lastSyncedSeq > lastVisibleSeq)
                  delete bindings[other];
                const updated: RelayThread = {
                  ...thread,
                  bindings,
                  lastSeq,
                  updatedAt: new Date().toISOString(),
                };
                const state = await readUndoState(paths, thread.id);
                await atomicJsonWrite(paths, undoPath(paths, thread.id), {
                  entries: [...state.entries, { messages: removed, thread }],
                });
                await atomicTextWrite(
                  paths,
                  eventsPath(paths, thread.id),
                  remainingRaw.map((message) => JSON.stringify(message)).join("\n") +
                    (remainingRaw.length ? "\n" : ""),
                );
                await writeThread(paths, updated);
                return updated;
              },
              catch: (cause) =>
                cause instanceof NoCurrentThread
                  ? cause
                  : new StoreError({ operation: "undo turn", message: errorMessage(cause), cause }),
            }),
        ),

        redoLastTurn: Effect.fn("ThreadStore.redoLastTurn")(
          (thread: RelayThread, harness: Harness) =>
            Effect.tryPromise({
              try: async () => {
                const state = await readUndoState(paths, thread.id);
                const entry = state.entries.at(-1);
                if (!entry || entry.thread.activeHarness !== harness) {
                  throw new NoCurrentThread({ message: "There is no turn to redo" });
                }
                const messages = await readRawMessages(paths, thread.id);
                const restored = [...messages, ...entry.messages].sort(
                  (left, right) => left.seq - right.seq,
                );
                await atomicTextWrite(
                  paths,
                  eventsPath(paths, thread.id),
                  `${restored.map((message) => JSON.stringify(message)).join("\n")}\n`,
                );
                await writeThread(paths, entry.thread);
                const visibility = await readVisibility(paths, thread.id);
                const links = new Map(
                  (visibility.links ?? []).map((link) => [link.messageId, link.key]),
                );
                const restoredKeys = new Set(
                  entry.messages.flatMap((message) => {
                    const key =
                      message.nativeId && message.nativeSessionId
                        ? visibilityKey(message.harness, message.nativeSessionId, message.nativeId)
                        : links.get(message.id);
                    return key ? [key] : [];
                  }),
                );
                const hidden = visibility.hidden.filter((key) => !restoredKeys.has(key));
                if (hidden.length !== visibility.hidden.length) {
                  await atomicJsonWrite(paths, visibilityPath(paths, thread.id), {
                    hidden,
                    ...(visibility.links ? { links: visibility.links } : {}),
                  });
                }
                const entries = state.entries.slice(0, -1);
                if (entries.length)
                  await atomicJsonWrite(paths, undoPath(paths, thread.id), { entries });
                else await rm(undoPath(paths, thread.id), { force: true });
                return entry.thread;
              },
              catch: (cause) =>
                cause instanceof NoCurrentThread
                  ? cause
                  : new StoreError({ operation: "redo turn", message: errorMessage(cause), cause }),
            }),
        ),
      });
    }),
  );

  static readonly layer = ThreadStore.configuredLayer.pipe(Layer.provide(RelayPaths.layer));

  static readonly layerFromRoot = (root: string) =>
    ThreadStore.configuredLayer.pipe(Layer.provide(RelayPaths.layerFromRoot(root)));
}
