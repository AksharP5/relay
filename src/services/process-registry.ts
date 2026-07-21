import { Schema } from "effect";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { relayDataRoot } from "./data-root.ts";

interface ProcessLike {
  readonly pid: number;
}

const ProcessClaim = Schema.Struct({
  version: Schema.Literal(1),
  token: Schema.String,
  owner: Schema.Struct({ pid: Schema.Number, startedAt: Schema.String }),
  child: Schema.Struct({ pid: Schema.Number, pgid: Schema.Number, startedAt: Schema.String }),
  scope: Schema.optional(Schema.Literals(["group", "process"])),
  kind: Schema.String,
  createdAt: Schema.String,
});
interface ProcessClaim extends Schema.Schema.Type<typeof ProcessClaim> {}

const ProcessRecoveryFailureBase = {
  claimFile: Schema.String,
  claimToken: Schema.String,
  kind: Schema.String,
  pid: Schema.Number,
  startedAt: Schema.String,
};
export const ProcessRecoveryFailure = Schema.Union([
  Schema.Struct({
    ...ProcessRecoveryFailureBase,
    scope: Schema.Literal("process"),
  }),
  Schema.Struct({
    ...ProcessRecoveryFailureBase,
    scope: Schema.Literal("group"),
    pgid: Schema.Number,
  }),
]);
export type ProcessRecoveryFailure = typeof ProcessRecoveryFailure.Type;

export const ProcessRecoveryResult = Schema.Struct({
  terminated: Schema.Number,
  discarded: Schema.Number,
  quarantined: Schema.Number,
  failed: Schema.Number,
  failures: Schema.Array(ProcessRecoveryFailure),
});
export interface ProcessRecoveryResult extends Schema.Schema.Type<typeof ProcessRecoveryResult> {}

export class ProcessRecoveryError extends Schema.TaggedErrorClass<ProcessRecoveryError>()(
  "ProcessRegistry.RecoveryError",
  { failures: Schema.Array(ProcessRecoveryFailure) },
) {}

interface ProcessIdentity {
  readonly pgid: number;
  readonly startedAt: string;
}

export interface ProcessRecoveryOperations {
  readonly processSnapshot: (pid: number) => Promise<ProcessIdentity | undefined>;
  readonly signalGroup: (pgid: number, signal: NodeJS.Signals) => void;
  readonly signalProcess: (pid: number, signal: NodeJS.Signals) => void;
  readonly groupIsAlive: (pgid: number) => boolean;
  readonly waitForGroupExit: (pgid: number, timeoutMs: number) => Promise<boolean>;
  readonly waitForProcessExit: (
    pid: number,
    startedAt: string,
    timeoutMs: number,
  ) => Promise<boolean>;
}

const registrations = new WeakMap<object, string>();
const registryDirectory = () => `${relayDataRoot()}/processes`;
const quarantineDirectory = () => `${registryDirectory()}/quarantine`;

const ensureDirectory = async (path: string) => {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
};

const ensureRegistry = async () => {
  await ensureDirectory(relayDataRoot());
  await ensureDirectory(registryDirectory());
};

const writeClaim = async (path: string, claim: ProcessClaim) => {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(claim, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
  await chmod(path, 0o600);
};

const processSnapshot = async (pid: number) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (process.platform === "linux") {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const fields = stat
        .slice(stat.lastIndexOf(") ") + 2)
        .trim()
        .split(/\s+/);
      const pgid = Number(fields[2]);
      const startTicks = fields[19];
      if (Number.isSafeInteger(pgid) && pgid > 0 && startTicks) {
        return { pgid, startedAt: `linux:${startTicks}` };
      }
    } catch {
      return undefined;
    }
  }
  const ps = ["/bin/ps", "/usr/bin/ps"].find(existsSync);
  if (!ps) throw new Error("Relay requires ps to identify managed processes on this platform");
  const child = Bun.spawn([ps, "-o", "pgid=", "-o", "lstart=", "-p", String(pid)], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    env: {},
  });
  const [output, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (exitCode !== 0) return undefined;
  const match = output.trim().match(/^(\d+)\s+(.+)$/);
  if (!match) return undefined;
  return { pgid: Number(match[1]), startedAt: match[2]! };
};

const signalGroup = (pgid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(-pgid, signal);
  } catch {
    // ESRCH means the complete process group has already exited.
  }
};

const signalProcess = (pid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(pid, signal);
  } catch {
    // ESRCH means the process has already exited.
  }
};

const groupIsAlive = (pgid: number) => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitForGroupExit = async (pgid: number, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!groupIsAlive(pgid)) return true;
    await Bun.sleep(25);
  }
  return !groupIsAlive(pgid);
};

const waitForProcessExit = async (pid: number, startedAt: string, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await processSnapshot(pid))?.startedAt !== startedAt) return true;
    await Bun.sleep(25);
  }
  return (await processSnapshot(pid))?.startedAt !== startedAt;
};

const liveRecoveryOperations: ProcessRecoveryOperations = {
  processSnapshot,
  signalGroup,
  signalProcess,
  groupIsAlive,
  waitForGroupExit,
  waitForProcessExit,
};

export const trackManagedProcess = async (
  child: ProcessLike,
  kind: string,
  options: { readonly processOnly?: boolean } = {},
) => {
  if (process.platform === "win32") return;
  const [owner, spawned] = await Promise.all([
    processSnapshot(process.pid),
    processSnapshot(child.pid),
  ]);
  if (!spawned) return;
  if (!owner) {
    if (options.processOnly) signalProcess(child.pid, "SIGKILL");
    else signalGroup(spawned.pgid, "SIGKILL");
    throw new Error(`Relay could not identify the owner of its ${kind} process`);
  }
  await ensureRegistry();
  const token = crypto.randomUUID();
  const path = `${registryDirectory()}/${token}.json`;
  try {
    await writeClaim(path, {
      version: 1,
      token,
      owner: { pid: process.pid, startedAt: owner.startedAt },
      child: { pid: child.pid, pgid: spawned.pgid, startedAt: spawned.startedAt },
      scope: options.processOnly ? "process" : "group",
      kind,
      createdAt: new Date().toISOString(),
    });
    registrations.set(child as object, path);
  } catch (cause) {
    if (options.processOnly) signalProcess(child.pid, "SIGKILL");
    else signalGroup(spawned.pgid, "SIGKILL");
    throw cause;
  }
};

export const untrackManagedProcess = async (child: ProcessLike) => {
  const path = registrations.get(child as object);
  if (!path) return;
  registrations.delete(child as object);
  await rm(path, { force: true });
};

export const cleanupOrphanedProcesses = async (
  options: { readonly operations?: ProcessRecoveryOperations } = {},
): Promise<ProcessRecoveryResult> => {
  const operations = options.operations ?? liveRecoveryOperations;
  if (process.platform === "win32")
    return ProcessRecoveryResult.make({
      terminated: 0,
      discarded: 0,
      quarantined: 0,
      failed: 0,
      failures: [],
    });
  await ensureRegistry();
  await ensureDirectory(quarantineDirectory());
  let terminated = 0;
  let discarded = 0;
  let quarantined = 0;
  const failures: Array<ProcessRecoveryFailure> = [];

  for (const entry of await readdir(registryDirectory())) {
    if (!entry.endsWith(".json")) continue;
    const path = `${registryDirectory()}/${entry}`;
    let claim: ProcessClaim;
    try {
      await chmod(path, 0o600);
      claim = Schema.decodeUnknownSync(ProcessClaim)(JSON.parse(await readFile(path, "utf8")));
    } catch {
      await rename(path, `${quarantineDirectory()}/${entry}.${Date.now()}.invalid`);
      quarantined += 1;
      continue;
    }

    const owner = await operations.processSnapshot(claim.owner.pid);
    if (owner?.startedAt === claim.owner.startedAt) continue;
    const child = await operations.processSnapshot(claim.child.pid);
    const scope = claim.scope ?? "group";
    const matchingLeader =
      child?.startedAt === claim.child.startedAt && child.pgid === claim.child.pgid;
    const leaderExitedWithLiveGroup =
      scope === "group" && child === undefined && operations.groupIsAlive(claim.child.pgid);
    if (matchingLeader || leaderExitedWithLiveGroup) {
      if (scope === "group" && claim.child.pgid <= 1) {
        discarded += 1;
        await rm(path, { force: true });
        continue;
      }
      const signal = (value: NodeJS.Signals) =>
        scope === "group"
          ? operations.signalGroup(claim.child.pgid, value)
          : operations.signalProcess(claim.child.pid, value);
      const waitForExit = (timeoutMs: number) =>
        scope === "group"
          ? operations.waitForGroupExit(claim.child.pgid, timeoutMs)
          : operations.waitForProcessExit(claim.child.pid, claim.child.startedAt, timeoutMs);
      signal("SIGTERM");
      if (!(await waitForExit(750))) {
        signal("SIGKILL");
        if (!(await waitForExit(750))) {
          const identity = {
            claimFile: entry,
            claimToken: claim.token,
            kind: claim.kind,
            pid: claim.child.pid,
            startedAt: claim.child.startedAt,
          };
          failures.push(
            scope === "group"
              ? ProcessRecoveryFailure.make({
                  ...identity,
                  scope,
                  pgid: claim.child.pgid,
                })
              : ProcessRecoveryFailure.make({ ...identity, scope }),
          );
          continue;
        }
      }
      terminated += 1;
    } else {
      discarded += 1;
    }
    await rm(path, { force: true });
  }
  return ProcessRecoveryResult.make({
    terminated,
    discarded,
    quarantined,
    failed: failures.length,
    failures,
  });
};
