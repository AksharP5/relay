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
  | { readonly reason: "exit"; readonly exitCode: number }
  | { readonly reason: "signal"; readonly signal: "SIGHUP" | "SIGTERM" | "SIGQUIT" };

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
  once?: (event: "drain", listener: () => void) => unknown;
}

interface ResizeSource extends EventEmitter {}

export interface NativePtyIo {
  readonly input: HostInput;
  readonly output: HostOutput;
  readonly resizeSource: ResizeSource;
}

export interface NativePtyOptions {
  readonly prefixTimeoutMs?: number;
  /** Return false to leave the native TUI running (for example, during an active turn). */
  readonly onSwitchRequest?: () => boolean | Promise<boolean>;
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
 * input except Relay's Ctrl+] then R switch chord is written unchanged to the child.
 */
export const runNativeTui = async (
  command: NativeTuiCommand,
  io: NativePtyIo = defaultIo(),
  options: NativePtyOptions = {},
): Promise<NativeTuiExit> => {
  if (!io.input.isTTY) throw new Error("Relay's native interface needs an interactive terminal");

  const router = new NativeInputRouter();
  const initialRawMode = io.input.isRaw === true;
  let switchRequested = false;
  let switchCheckPending = false;
  let parentSignal: "SIGHUP" | "SIGTERM" | "SIGQUIT" | undefined;
  let hostFailure: Error | undefined;
  let stopping: Promise<void> | undefined;
  let prefixTimer: ReturnType<typeof setTimeout> | undefined;
  let terminal: Bun.Terminal | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let resolvePtyEof: () => void;
  const ptyEof = new Promise<void>((resolve) => (resolvePtyEof = resolve));
  const inputQueue: Array<Uint8Array> = [];
  const outputQueue: Array<Uint8Array> = [];
  const outputDrainWaiters = new Set<() => void>();
  let outputBlocked = false;

  const flushInput = () => {
    if (!terminal || terminal.closed) return;
    while (inputQueue.length > 0) {
      const next = inputQueue[0]!;
      const written = terminal.write(next);
      if (written >= next.byteLength) inputQueue.shift();
      else {
        inputQueue[0] = next.slice(Math.max(0, written));
        return;
      }
    }
  };

  const writeInput = (data: Uint8Array) => {
    if (data.byteLength === 0) return;
    inputQueue.push(data.slice());
    flushInput();
  };
  const flushOutput = () => {
    outputBlocked = false;
    while (outputQueue.length > 0) {
      const accepted = io.output.write(outputQueue.shift()!);
      if (accepted === false) {
        outputBlocked = true;
        io.output.once?.("drain", flushOutput);
        return;
      }
    }
    for (const resolve of outputDrainWaiters) resolve();
    outputDrainWaiters.clear();
  };
  const writeOutput = (data: Uint8Array) => {
    if (outputBlocked) {
      outputQueue.push(data.slice());
      return;
    }
    const accepted = io.output.write(data);
    if (accepted === false) {
      outputBlocked = true;
      io.output.once?.("drain", flushOutput);
    }
  };

  const onInput = (chunk: Buffer | Uint8Array | string) => {
    if (prefixTimer) clearTimeout(prefixTimer);
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : new Uint8Array(chunk);
    const routed = router.route(bytes);
    writeInput(routed.forward);
    if (!routed.switchRequested || switchRequested || switchCheckPending) return;
    switchCheckPending = true;
    void Promise.resolve(options.onSwitchRequest?.() ?? true)
      .then((allowed) => {
        switchCheckPending = false;
        if (!allowed || switchRequested || parentSignal) {
          if (!allowed) writeOutput(Uint8Array.of(0x07));
          return;
        }
        switchRequested = true;
        if (child) stopping = stopChild(child);
      })
      .catch((cause) => {
        switchCheckPending = false;
        hostFailure = cause instanceof Error ? cause : new Error(String(cause));
        if (child) stopping = stopChild(child);
      });
  };
  const flushPrefix = () => {
    prefixTimer = undefined;
    writeInput(router.flushPending());
  };
  const onResize = () => {
    const next = dimensions(io.output);
    terminal?.resize(next.cols, next.rows);
  };
  const onSignal = (signal: "SIGHUP" | "SIGTERM" | "SIGQUIT") => {
    if (parentSignal) return;
    parentSignal = signal;
    if (child) stopping = stopChild(child);
  };
  const onHangup = () => onSignal("SIGHUP");
  const onTerminate = () => onSignal("SIGTERM");
  const onQuit = () => onSignal("SIGQUIT");

  try {
    const size = dimensions(io.output);
    child = Bun.spawn([command.executable, ...command.args], {
      cwd: command.cwd,
      env: {
        ...Bun.env,
        TERM: process.env.TERM || "xterm-256color",
        ...command.env,
      },
      terminal: {
        ...size,
        name: process.env.TERM || "xterm-256color",
        data: (_terminal, data) => writeOutput(data),
        exit: () => resolvePtyEof(),
        drain: flushInput,
      },
      detached: process.platform !== "win32",
    });
    terminal = child.terminal;
    if (!terminal) throw new Error("Relay could not create a native pseudo-terminal");

    io.input.setRawMode?.(true);
    io.input.resume();
    io.input.on("data", onInput);
    io.resizeSource.on("SIGWINCH", onResize);
    io.resizeSource.on("SIGHUP", onHangup);
    io.resizeSource.on("SIGTERM", onTerminate);
    io.resizeSource.on("SIGQUIT", onQuit);

    const prefixPoll = setInterval(() => {
      if (router.hasPendingPrefix && !prefixTimer)
        prefixTimer = setTimeout(flushPrefix, options.prefixTimeoutMs ?? 500);
    }, 25);
    prefixPoll.unref?.();

    const exitCode = await child.exited;
    clearInterval(prefixPoll);
    if (stopping) await stopping;
    await Promise.race([ptyEof, Bun.sleep(250)]);
    if (outputQueue.length > 0 || outputBlocked) {
      let cancelWait: (() => void) | undefined;
      const drained = new Promise<void>((resolve) => {
        const done = () => resolve();
        cancelWait = () => outputDrainWaiters.delete(done);
        outputDrainWaiters.add(done);
        flushOutput();
      });
      await Promise.race([drained, Bun.sleep(250)]);
      cancelWait?.();
    }
    if (hostFailure) throw hostFailure;
    if (parentSignal) return { reason: "signal", signal: parentSignal };
    return switchRequested ? { reason: "switch" } : { reason: "exit", exitCode };
  } finally {
    if (prefixTimer) clearTimeout(prefixTimer);
    io.input.off("data", onInput);
    io.resizeSource.off("SIGWINCH", onResize);
    io.resizeSource.off("SIGHUP", onHangup);
    io.resizeSource.off("SIGTERM", onTerminate);
    io.resizeSource.off("SIGQUIT", onQuit);
    io.input.setRawMode?.(initialRawMode);
    if (child && child.exitCode === null) await stopChild(child);
    if (terminal && !terminal.closed) terminal.close();
  }
};
