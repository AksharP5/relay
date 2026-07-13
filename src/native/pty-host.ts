import type { EventEmitter } from "node:events";

import { NativeInputRouter } from "./input-router.ts";

export interface NativeTuiCommand {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export type NativeTuiExit =
  | { readonly reason: "switch" }
  | { readonly reason: "exit"; readonly exitCode: number };

interface HostInput extends EventEmitter {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
  setRawMode?: (enabled: boolean) => unknown;
  resume: () => unknown;
}

interface HostOutput {
  readonly columns?: number;
  readonly rows?: number;
  write: (data: string | Uint8Array) => unknown;
}

interface ResizeSource extends EventEmitter {}

export interface NativePtyIo {
  readonly input: HostInput;
  readonly output: HostOutput;
  readonly resizeSource: ResizeSource;
}

const defaultIo = (): NativePtyIo => ({
  input: process.stdin,
  output: process.stdout,
  resizeSource: process,
});

const dimensions = (output: HostOutput) => ({
  cols: Math.max(1, output.columns ?? 80),
  rows: Math.max(1, output.rows ?? 24),
});

const killProcessGroup = (child: ReturnType<typeof Bun.spawn>, signal: NodeJS.Signals) => {
  if (child.exitCode !== null) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    child.kill(signal);
  }
};

const stopChild = async (child: ReturnType<typeof Bun.spawn>) => {
  if (child.exitCode !== null) return;
  killProcessGroup(child, "SIGTERM");
  await Promise.race([child.exited, Bun.sleep(1_000)]);
  if (child.exitCode === null) {
    killProcessGroup(child, "SIGKILL");
    await child.exited.catch(() => undefined);
  }
};

/**
 * Hosts an upstream TUI in a real PTY. Output is forwarded unchanged and all
 * input except Relay's Ctrl+R switch chord is written unchanged to the child.
 */
export const runNativeTui = async (
  command: NativeTuiCommand,
  io: NativePtyIo = defaultIo(),
): Promise<NativeTuiExit> => {
  if (!io.input.isTTY) throw new Error("Relay's native interface needs an interactive terminal");

  const router = new NativeInputRouter();
  const initialRawMode = io.input.isRaw === true;
  let switchRequested = false;
  let stopping: Promise<void> | undefined;

  const terminal = new Bun.Terminal({
    ...dimensions(io.output),
    name: process.env.TERM || "xterm-256color",
    data: (_terminal, data) => io.output.write(data),
  });
  const child = Bun.spawn([command.executable, ...command.args], {
    cwd: command.cwd,
    env: { ...Bun.env, ...command.env },
    terminal,
    detached: process.platform !== "win32",
  });

  const onInput = (chunk: Buffer | Uint8Array | string) => {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : new Uint8Array(chunk);
    const routed = router.route(bytes);
    if (routed.forward.byteLength > 0) terminal.write(routed.forward);
    if (!routed.switchRequested || switchRequested) return;
    switchRequested = true;
    stopping = stopChild(child);
  };
  const onResize = () => {
    const next = dimensions(io.output);
    terminal.resize(next.cols, next.rows);
  };

  io.input.setRawMode?.(true);
  io.input.resume();
  io.input.on("data", onInput);
  io.resizeSource.on("SIGWINCH", onResize);

  try {
    const exitCode = await child.exited;
    if (stopping) await stopping;
    return switchRequested ? { reason: "switch" } : { reason: "exit", exitCode };
  } finally {
    io.input.off("data", onInput);
    io.resizeSource.off("SIGWINCH", onResize);
    io.input.setRawMode?.(initialRawMode);
    if (!terminal.closed) terminal.close();
  }
};
