import type { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { stopProcessTree } from "../services/process-runner.ts";
import { trackManagedProcess, untrackManagedProcess } from "../services/process-registry.ts";
import { NativeInputRouter } from "./input-router.ts";

export interface NativeTuiCommand {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export type NativeParentSignal = "SIGHUP" | "SIGINT" | "SIGTERM" | "SIGQUIT";

export type NativeTuiExit =
  | { readonly reason: "switch"; readonly sessionIdHint?: string }
  | { readonly reason: "exit"; readonly exitCode: number; readonly sessionIdHint?: string }
  | {
      readonly reason: "signal";
      readonly signal: NativeParentSignal;
      readonly sessionIdHint?: string;
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
  /** Prevent a just-submitted cold turn from being detached before backend status materializes. */
  readonly submitGraceMs?: number;
  /** Tell the switch guard that a recent Enter may still be materializing a native request. */
  readonly submitProtectionMs?: number;
  readonly now?: () => number;
  /** Keep the outer TTY flowing while Relay starts the next native harness. */
  readonly preserveInputOnSwitch?: boolean;
  /** Maximum input retained while the next harness starts. */
  readonly handoffInputLimitBytes?: number;
  /** Maximum queued input or output retained under PTY backpressure. */
  readonly ioQueueLimitBytes?: number;
  /** Return false to leave the native TUI running (for example, during an active turn). */
  readonly onSwitchRequest?: (recentSubmit?: boolean) => boolean | Promise<boolean>;
  /**
   * Extract a native session id from a bounded tail of graceful-exit output.
   * The tail exists only for this PTY run and is never persisted by Relay.
   */
  readonly sessionIdHint?: {
    readonly extract: (outputTail: string) => string | undefined;
    readonly maxBytes?: number;
  };
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

interface BoundedInputBuffer {
  buffered: Array<Uint8Array>;
  bufferedBytes: number;
  overflowed: boolean;
}

interface NativeInputPump extends BoundedInputBuffer {
  readonly initialRawMode: boolean;
  readonly limitBytes: number;
  readonly listener: (chunk: Buffer | Uint8Array | string) => void;
  readonly onStandbyInterrupt: () => void;
  stop: () => Promise<void>;
  consumer: ((chunk: Uint8Array) => void) | undefined;
}

const DEFAULT_HANDOFF_INPUT_LIMIT_BYTES = 256 * 1024;
const DEFAULT_IO_QUEUE_LIMIT_BYTES = 4 * 1024 * 1024;
const DEFAULT_SESSION_HINT_TAIL_BYTES = 8 * 1024;
const nativeInputPumps = new WeakMap<HostInput, NativeInputPump>();

const bytesFrom = (chunk: Buffer | Uint8Array | string) =>
  typeof chunk === "string" ? Buffer.from(chunk) : new Uint8Array(chunk);

const resetBufferedInput = (target: BoundedInputBuffer) => {
  target.buffered = [];
  target.bufferedBytes = 0;
  target.overflowed = false;
};

const bufferBoundedInput = (target: BoundedInputBuffer, input: Uint8Array, limitBytes: number) => {
  if (input.byteLength === 0 || target.overflowed) return;
  if (target.bufferedBytes + input.byteLength > limitBytes) {
    // Never replay a prefix: truncating bracketed paste or escape sequences can
    // leave the next native TUI in a corrupt input mode.
    resetBufferedInput(target);
    target.overflowed = true;
    return;
  }
  target.buffered.push(input.slice());
  target.bufferedBytes += input.byteLength;
};

const bufferStandbyInput = (pump: NativeInputPump, input: Uint8Array) => {
  let sawInterrupt = false;
  const filtered = input.filter((byte) => {
    if (byte !== 0x03) return true;
    sawInterrupt = true;
    return false;
  });
  if (sawInterrupt) pump.onStandbyInterrupt();
  bufferBoundedInput(pump, filtered, pump.limitBytes);
};

const releaseInputPump = async (input: HostInput) => {
  const pump = nativeInputPumps.get(input);
  if (!pump) return;
  pump.consumer = undefined;
  await pump.stop();
  input.pause?.();
  input.setRawMode?.(pump.initialRawMode);
  nativeInputPumps.delete(input);
};

/** Restores stdin if a switch was followed by a backend startup failure. */
export const releaseNativeTuiInput = (input: NativePtyIo["input"] = process.stdin) =>
  releaseInputPump(input);

/**
 * Hosts an upstream TUI in a real PTY. Output is forwarded unchanged and all
 * input except Relay's Ctrl+Q / F6 toggle is written unchanged to the child.
 */
export const runNativeTui = async (
  command: NativeTuiCommand,
  io: NativePtyIo = defaultIo(),
  options: NativePtyOptions = {},
): Promise<NativeTuiExit> => {
  if (!io.input.isTTY) throw new Error("Relay's native interface needs an interactive terminal");

  const preservedPump = nativeInputPumps.get(io.input);
  const router = new NativeInputRouter();
  const initialRawMode = preservedPump?.initialRawMode ?? io.input.isRaw === true;
  let inputPump: NativeInputPump | undefined;
  let switchRequested = false;
  let switchCheckPending = false;
  let parentSignal: NativeParentSignal | undefined;
  let hostFailure: Error | undefined;
  let stopping: Promise<void> | undefined;
  let sequenceTimer: ReturnType<typeof setTimeout> | undefined;
  let lastSubmitAt: number | undefined;
  const now = options.now ?? Date.now;
  const handoffInputLimitBytes = Math.max(
    0,
    options.handoffInputLimitBytes ?? DEFAULT_HANDOFF_INPUT_LIMIT_BYTES,
  );
  const ioQueueLimitBytes = Math.max(0, options.ioQueueLimitBytes ?? DEFAULT_IO_QUEUE_LIMIT_BYTES);
  const sessionHintTailLimitBytes = Math.max(
    0,
    options.sessionIdHint?.maxBytes ?? DEFAULT_SESSION_HINT_TAIL_BYTES,
  );
  let sessionHintTail = Buffer.alloc(0);
  const pendingSwitchInput: BoundedInputBuffer = {
    buffered: [],
    bufferedBytes: 0,
    overflowed: false,
  };
  let terminal: Bun.Terminal | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let resolvePtyEof: () => void;
  const ptyEof = new Promise<void>((resolve) => (resolvePtyEof = resolve));
  const inputQueue: Array<Uint8Array> = [];
  const outputQueue: Array<Uint8Array> = [];
  let inputQueueBytes = 0;
  let outputQueueBytes = 0;
  const outputDrainWaiters = new Set<() => void>();
  let outputBlocked = false;

  const failHost = (message: string) => {
    if (hostFailure || parentSignal) return;
    hostFailure = new Error(message);
    if (child) stopping = stopProcessTree(child);
  };

  const flushInput = () => {
    if (!terminal || terminal.closed) return;
    while (inputQueue.length > 0) {
      const next = inputQueue[0]!;
      const written = Math.max(0, Math.min(next.byteLength, terminal.write(next)));
      inputQueueBytes -= written;
      if (written >= next.byteLength) inputQueue.shift();
      else {
        inputQueue[0] = next.slice(written);
        return;
      }
    }
  };

  const writeInput = (data: Uint8Array) => {
    if (data.byteLength === 0) return;
    let remaining = data;
    if (inputQueue.length === 0 && terminal && !terminal.closed) {
      const written = Math.max(0, Math.min(data.byteLength, terminal.write(data)));
      if (written >= data.byteLength) return;
      remaining = data.slice(written);
    }
    if (inputQueueBytes + remaining.byteLength > ioQueueLimitBytes) {
      failHost("Relay input backpressure exceeded its memory limit");
      return;
    }
    inputQueue.push(remaining.slice());
    inputQueueBytes += remaining.byteLength;
    flushInput();
  };
  const flushOutput = () => {
    outputBlocked = false;
    while (outputQueue.length > 0) {
      const next = outputQueue.shift()!;
      outputQueueBytes -= next.byteLength;
      const accepted = io.output.write(next);
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
    if (options.sessionIdHint && sessionHintTailLimitBytes > 0) {
      const chunk = Buffer.from(data);
      sessionHintTail =
        chunk.byteLength >= sessionHintTailLimitBytes
          ? chunk.subarray(chunk.byteLength - sessionHintTailLimitBytes)
          : Buffer.concat([sessionHintTail, chunk]).subarray(-sessionHintTailLimitBytes);
    }
    if (outputBlocked) {
      if (outputQueueBytes + data.byteLength > ioQueueLimitBytes) {
        failHost("Relay output backpressure exceeded its memory limit");
        return;
      }
      outputQueue.push(data.slice());
      outputQueueBytes += data.byteLength;
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
    const bytes = bytesFrom(chunk);
    if (switchRequested) {
      if (inputPump) bufferStandbyInput(inputPump, bytes);
      return;
    }
    if (parentSignal) return;
    if (switchCheckPending) {
      let sawInterrupt = false;
      const filtered = bytes.filter((byte) => {
        if (byte !== 0x03) return true;
        sawInterrupt = true;
        return false;
      });
      if (sawInterrupt) io.resizeSource.emit("SIGINT");
      bufferBoundedInput(pendingSwitchInput, filtered, handoffInputLimitBytes);
      return;
    }
    const routed = router.route(bytes);
    writeInput(routed.forward);
    if (routed.submitObserved) lastSubmitAt = now();
    if (!routed.switchRequested) {
      if (router.hasPendingSequence)
        sequenceTimer = setTimeout(
          flushSequence,
          router.pendingTimeoutMs(options.sequenceTimeoutMs ?? 500),
        );
      return;
    }
    if (lastSubmitAt !== undefined && now() - lastSubmitAt < (options.submitGraceMs ?? 0)) {
      writeInput(routed.afterSwitch);
      writeOutput(Uint8Array.of(0x07));
      return;
    }
    const recentSubmit =
      lastSubmitAt !== undefined &&
      now() - lastSubmitAt < (options.submitProtectionMs ?? options.submitGraceMs ?? 0);
    bufferBoundedInput(pendingSwitchInput, routed.afterSwitch, handoffInputLimitBytes);
    switchCheckPending = true;
    void Promise.resolve(options.onSwitchRequest?.(recentSubmit) ?? true)
      .then((allowed) => {
        if (!allowed || switchRequested || parentSignal) {
          if (!allowed) {
            for (const buffered of pendingSwitchInput.buffered) writeInput(buffered);
            writeOutput(Uint8Array.of(0x07));
          }
          resetBufferedInput(pendingSwitchInput);
          switchCheckPending = false;
          return;
        }
        if (options.preserveInputOnSwitch && inputPump) {
          if (pendingSwitchInput.overflowed) {
            resetBufferedInput(inputPump);
            inputPump.overflowed = true;
          } else {
            for (const buffered of pendingSwitchInput.buffered)
              bufferStandbyInput(inputPump, buffered);
          }
        }
        resetBufferedInput(pendingSwitchInput);
        switchCheckPending = false;
        switchRequested = true;
        if (child) stopping = stopProcessTree(child);
      })
      .catch((cause) => {
        resetBufferedInput(pendingSwitchInput);
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
    // Relay owns one input listener for the entire native handoff sequence.
    // Replacing the final listener between TUIs can lose Bun's existing TTY
    // readiness edge when OpenTUI terminal capability replies are already queued.
    if (options.preserveInputOnSwitch) {
      inputPump = preservedPump;
      if (!inputPump) {
        const pump: NativeInputPump = {
          initialRawMode,
          limitBytes: handoffInputLimitBytes,
          listener: (chunk) => {
            const bytes = bytesFrom(chunk);
            if (pump.consumer) pump.consumer(bytes);
            else bufferStandbyInput(pump, bytes);
          },
          onStandbyInterrupt: () => io.resizeSource.emit("SIGINT"),
          stop: async () => undefined,
          consumer: onInput,
          buffered: [],
          bufferedBytes: 0,
          overflowed: false,
        };
        inputPump = pump;
        nativeInputPumps.set(io.input, pump);
        if (!io.input.isRaw) io.input.setRawMode?.(true);
        if (io.input === process.stdin) {
          // A tiny native reader owns fd 0 for Relay's lifetime. Bun's Node and
          // Web stdin bridges can both report a false EOF when child PTYs are
          // replaced; the pipe from cat remains stable and event-driven.
          const inputProxyExecutable = ["/bin/cat", "/usr/bin/cat"].find(existsSync);
          if (!inputProxyExecutable)
            throw new Error(
              "Relay could not find the system input reader at /bin/cat or /usr/bin/cat",
            );
          const inputProxy = spawn(inputProxyExecutable, ["/dev/tty"], {
            stdio: ["ignore", "pipe", "ignore"],
            env: {},
          });
          if (inputProxy.pid === undefined) throw new Error("Relay input reader did not start");
          await trackManagedProcess(
            inputProxy as typeof inputProxy & { readonly pid: number },
            "terminal-input-reader",
            { processOnly: true },
          );
          let reading = true;
          let proxyFailed = false;
          let proxyClosed = false;
          const closed = new Promise<void>((resolve) =>
            inputProxy.once("close", () => {
              proxyClosed = true;
              resolve();
            }),
          );
          const onProxyFailure = () => {
            if (!reading || proxyFailed) return;
            proxyFailed = true;
            io.resizeSource.emit("SIGHUP");
          };
          inputProxy.stdout.on("data", pump.listener);
          inputProxy.once("error", onProxyFailure);
          inputProxy.once("exit", onProxyFailure);
          pump.stop = async () => {
            reading = false;
            inputProxy.stdout.off("data", pump.listener);
            inputProxy.off("error", onProxyFailure);
            inputProxy.off("exit", onProxyFailure);
            if (inputProxy.exitCode === null && inputProxy.signalCode === null)
              inputProxy.kill("SIGTERM");
            const exited = await Promise.race([
              closed.then(() => true),
              Bun.sleep(250).then(() => false),
            ]);
            if (!exited && !proxyClosed) inputProxy.kill("SIGKILL");
            await Promise.race([closed, Bun.sleep(250)]);
            inputProxy.stdout.destroy();
            await untrackManagedProcess(inputProxy as typeof inputProxy & { readonly pid: number });
          };
        } else {
          io.input.on("data", pump.listener);
          io.input.resume();
          pump.stop = async () => void io.input.off("data", pump.listener);
        }
      } else {
        inputPump.consumer = onInput;
        const buffered = inputPump.buffered;
        const overflowed = inputPump.overflowed;
        resetBufferedInput(inputPump);
        for (const chunk of buffered) onInput(chunk);
        if (overflowed) writeOutput(Uint8Array.of(0x07));
      }
    } else {
      if (preservedPump) await releaseInputPump(io.input);
      if (!io.input.isRaw) io.input.setRawMode?.(true);
      io.input.on("data", onInput);
      io.input.resume();
    }
    io.resizeSource.on("SIGWINCH", onResize);
    io.resizeSource.on("SIGHUP", onHangup);
    io.resizeSource.on("SIGINT", onInterrupt);
    io.resizeSource.on("SIGTERM", onTerminate);
    io.resizeSource.on("SIGQUIT", onQuit);
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
    await trackManagedProcess(child, `${command.executable}-native-tui`);
    terminal = child.terminal;
    if (!terminal) throw new Error("Relay could not create a native pseudo-terminal");
    flushInput();
    if (parentSignal || switchRequested || hostFailure) stopping = stopProcessTree(child);

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
    const sessionIdHint = options.sessionIdHint?.extract(sessionHintTail.toString("utf8"));
    if (parentSignal)
      return {
        reason: "signal",
        signal: parentSignal,
        ...(sessionIdHint ? { sessionIdHint } : {}),
      };
    return switchRequested
      ? { reason: "switch", ...(sessionIdHint ? { sessionIdHint } : {}) }
      : { reason: "exit", exitCode, ...(sessionIdHint ? { sessionIdHint } : {}) };
  } finally {
    if (sequenceTimer) clearTimeout(sequenceTimer);
    io.resizeSource.off("SIGWINCH", onResize);
    io.resizeSource.off("SIGHUP", onHangup);
    io.resizeSource.off("SIGINT", onInterrupt);
    io.resizeSource.off("SIGTERM", onTerminate);
    io.resizeSource.off("SIGQUIT", onQuit);
    if (
      options.preserveInputOnSwitch &&
      inputPump &&
      switchRequested &&
      !parentSignal &&
      !hostFailure
    ) {
      inputPump.consumer = undefined;
    } else {
      if (inputPump) await releaseInputPump(io.input);
      else {
        io.input.off("data", onInput);
        io.input.pause?.();
        io.input.setRawMode?.(initialRawMode);
      }
    }
    if (child) await stopProcessTree(child);
    if (terminal && !terminal.closed) terminal.close();
  }
};
