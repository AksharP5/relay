import type { EventEmitter } from "node:events";

import type { Harness } from "../domain.ts";

interface SelectorInput extends EventEmitter {
  readonly isRaw?: boolean;
  setRawMode?: (enabled: boolean) => unknown;
  resume: () => unknown;
  pause?: () => unknown;
}

interface SelectorOutput {
  write: (data: string | Uint8Array) => unknown;
}

export interface SelectorIo {
  readonly input: SelectorInput;
  readonly output: SelectorOutput;
  readonly signalSource?: EventEmitter;
}

const defaultIo = (): SelectorIo => ({ input: process.stdin, output: process.stdout });
const alternateScreen = "\u001b[?1049h\u001b[2J\u001b[H\u001b[?25l";
const restoreScreen = "\u001b[?25h\u001b[?1049l";
const options: ReadonlyArray<Harness> = ["opencode", "codex"];

const label = (harness: Harness) => (harness === "opencode" ? "OpenCode" : "Codex");

/** A brief Relay-owned screen. The selected harness's real TUI renders everything else. */
export const selectHarness = (
  current: Harness,
  io: SelectorIo = defaultIo(),
): Promise<Harness | undefined> => {
  const initialRawMode = io.input.isRaw === true;
  const signalSource = io.signalSource ?? process;
  let selected = Math.max(0, options.indexOf(current));
  let pending = "";
  let escapeTimer: ReturnType<typeof setTimeout> | undefined;

  const render = () => {
    const rows = options
      .map((harness, index) => `${index === selected ? "›" : " "} ${label(harness)}`)
      .join("\r\n");
    io.output.write(
      `\u001b[2J\u001b[H\r\n  Relay\r\n\r\n  Switch native harness\r\n\r\n  ${rows}\r\n\r\n  ↑/↓ choose · Enter open · Esc cancel · q quit\r\n`,
    );
  };

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: Harness | undefined) => {
      if (settled) return;
      settled = true;
      if (escapeTimer) clearTimeout(escapeTimer);
      io.input.off("data", onData);
      signalSource.off("SIGHUP", onHangup);
      signalSource.off("SIGINT", onInterrupt);
      signalSource.off("SIGTERM", onTerminate);
      signalSource.off("SIGQUIT", onQuit);
      io.input.pause?.();
      io.input.setRawMode?.(initialRawMode);
      io.output.write(restoreScreen);
      resolve(result);
    };
    const move = (offset: number) => {
      selected = (selected + offset + options.length) % options.length;
      render();
    };
    const consume = () => {
      while (pending.length > 0 && !settled) {
        if (pending.startsWith("\u001b[")) {
          if (pending.length < 3) return;
          const sequence = pending.slice(0, 3);
          pending = pending.slice(3);
          if (sequence === "\u001b[A" || sequence === "\u001b[D") move(-1);
          else if (sequence === "\u001b[B" || sequence === "\u001b[C") move(1);
          else finish(current);
          continue;
        }
        if (pending[0] === "\u001b") {
          if (pending.length === 1) {
            escapeTimer = setTimeout(() => finish(current), 30);
            return;
          }
          pending = pending.slice(1);
          finish(current);
          continue;
        }

        const value = pending[0]!;
        pending = pending.slice(1);
        if (value === "\u0003" || value.toLowerCase() === "q") finish(undefined);
        else if (value === "\r" || value === "\n") finish(options[selected]);
        else if (value === "\t") move(1);
        else if (value.toLowerCase() === "c") {
          selected = options.indexOf("codex");
          render();
        } else if (value.toLowerCase() === "o") {
          selected = options.indexOf("opencode");
          render();
        }
      }
    };
    const onData = (chunk: Buffer | Uint8Array | string) => {
      if (escapeTimer) {
        clearTimeout(escapeTimer);
        escapeTimer = undefined;
      }
      pending += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      consume();
    };
    const onSignal = (signal: "SIGHUP" | "SIGINT" | "SIGTERM" | "SIGQUIT") => {
      if (signalSource === process)
        process.exitCode = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143, SIGQUIT: 131 }[signal];
      finish(undefined);
    };
    const onHangup = () => onSignal("SIGHUP");
    const onInterrupt = () => onSignal("SIGINT");
    const onTerminate = () => onSignal("SIGTERM");
    const onQuit = () => onSignal("SIGQUIT");

    io.output.write(alternateScreen);
    io.input.setRawMode?.(true);
    io.input.resume();
    io.input.on("data", onData);
    signalSource.on("SIGHUP", onHangup);
    signalSource.on("SIGINT", onInterrupt);
    signalSource.on("SIGTERM", onTerminate);
    signalSource.on("SIGQUIT", onQuit);
    render();
  });
};
