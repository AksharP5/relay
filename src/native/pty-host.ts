import type { EventEmitter } from "node:events";

import { stopProcessTree } from "../services/process-runner.ts";
import { NativeInputRouter } from "./input-router.ts";

export interface NativeTuiCommand {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export type NativeParentSignal = "SIGHUP" | "SIGINT" | "SIGTERM" | "SIGQUIT";

export type NativeTuiExit =
  | { readonly reason: "switch" }
  | { readonly reason: "exit"; readonly exitCode: number }
  | {
      readonly reason: "signal";
      readonly signal: NativeParentSignal;
    };

interface HostInput extends EventEmitter {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
  setRawMode?: (enabled: boolean) => unknown;
  resume: () => unknown;
  pause?: () => unknown;
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
  readonly sequenceTimeoutMs?: number;
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

/**
 * Hosts an upstream TUI in a real PTY. Output is forwarded unchanged and all
 * input except Relay's Ctrl+Shift+H / F6 toggle is written unchanged to the child.
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
  let parentSignal: NativeParentSignal | undefined;
  let hostFailure: Error | undefined;
  let stopping: Promise<void> | undefined;
  let sequenceTimer: ReturnType<typeof setTimeout> | undefined;
  const pendingSwitchInput: Array<Uint8Array> = [];
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
    if (sequenceTimer) {
      clearTimeout(sequenceTimer);
      sequenceTimer = undefined;
    }
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : new Uint8Array(chunk);
    if (switchRequested || parentSignal) return;
    if (switchCheckPending) {
      pendingSwitchInput.push(bytes.slice());
      return;
    }
    const routed = router.route(bytes);
    writeInput(routed.forward);
    if (!routed.switchRequested) {
      if (router.hasPendingSequence)
        sequenceTimer = setTimeout(
          flushSequence,
          router.pendingTimeoutMs(options.sequenceTimeoutMs ?? 500),
        );
      return;
    }
    pendingSwitchInput.push(routed.afterSwitch);
    switchCheckPending = true;
    void Promise.resolve(options.onSwitchRequest?.() ?? true)
      .then((allowed) => {
        if (!allowed || switchRequested || parentSignal) {
          if (!allowed) {
            for (const buffered of pendingSwitchInput.splice(0)) writeInput(buffered);
            writeOutput(Uint8Array.of(0x07));
          } else {
            pendingSwitchInput.length = 0;
          }
          switchCheckPending = false;
          return;
        }
        pendingSwitchInput.length = 0;
        switchCheckPending = false;
        switchRequested = true;
        if (child) stopping = stopProcessTree(child);
      })
      .catch((cause) => {
        pendingSwitchInput.length = 0;
        switchCheckPending = false;
        hostFailure = cause instanceof Error ? cause : new Error(String(cause));
        if (child) stopping = stopProcessTree(child);
      });
  };
  const flushSequence = () => {
    sequenceTimer = undefined;
    writeInput(router.flushPendingSequence());
  };
  const onResize = () => {
    const next = dimensions(io.output);
    terminal?.resize(next.cols, next.rows);
  };
  const onSignal = (signal: NativeParentSignal) => {
    if (parentSignal) return;
    parentSignal = signal;
    if (child) stopping = stopProcessTree(child);
  };
  const onHangup = () => onSignal("SIGHUP");
  const onInterrupt = () => onSignal("SIGINT");
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
    io.resizeSource.on("SIGINT", onInterrupt);
    io.resizeSource.on("SIGTERM", onTerminate);
    io.resizeSource.on("SIGQUIT", onQuit);

    const exitCode = await child.exited;
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
    if (sequenceTimer) clearTimeout(sequenceTimer);
    io.input.off("data", onInput);
    io.input.pause?.();
    io.resizeSource.off("SIGWINCH", onResize);
    io.resizeSource.off("SIGHUP", onHangup);
    io.resizeSource.off("SIGINT", onInterrupt);
    io.resizeSource.off("SIGTERM", onTerminate);
    io.resizeSource.off("SIGQUIT", onQuit);
    io.input.setRawMode?.(initialRawMode);
    if (child) await stopProcessTree(child);
    if (terminal && !terminal.closed) terminal.close();
  }
};
