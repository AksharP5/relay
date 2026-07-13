import type { EventEmitter } from "node:events";

import type { Harness } from "../domain.ts";

interface SelectorInput extends EventEmitter {
  readonly isRaw?: boolean;
  setRawMode?: (enabled: boolean) => unknown;
  resume: () => unknown;
  pause?: () => unknown;
}

interface SelectorOutput {
  readonly columns?: number;
  readonly rows?: number;
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
const clearScreen = "\u001b[2J\u001b[H";
const options: ReadonlyArray<Harness> = ["codex", "opencode"];

const label = (harness: Harness) => (harness === "opencode" ? "OpenCode" : "Codex");
const fit = (value: string, width: number) => value.slice(0, Math.max(1, width));

interface SelectorFrameInput {
  readonly current: Harness;
  readonly selected: Harness;
  readonly columns?: number | undefined;
  readonly rows?: number | undefined;
}

interface FrameLine {
  readonly text: string;
  readonly selected?: boolean;
  readonly bold?: boolean;
  readonly dim?: boolean;
}

/** Produces an ASCII-width-safe frame so both native harness labels share a column. */
export const renderSelectorFrame = (input: SelectorFrameInput) => {
  const columns = Math.max(1, input.columns ?? 80);
  const rows = Math.max(1, input.rows ?? 24);
  const labelWidth = Math.max(...options.map((harness) => label(harness).length));
  const optionLines: Array<FrameLine> = options.map((harness) => ({
    text: `${harness === input.selected ? ">" : " "} ${label(harness).padEnd(labelWidth)}${
      harness === input.current ? "  current" : ""
    }`,
    selected: harness === input.selected,
  }));
  const help =
    columns >= 48
      ? "Up/Down select   Enter switch   Esc cancel"
      : columns >= 26
        ? "Up/Down   Enter   Esc"
        : "Enter / Esc";
  const spacious: Array<FrameLine> = [
    { text: "Relay", bold: true },
    { text: "" },
    { text: "Switch harness" },
    { text: "" },
    ...optionLines,
    { text: "" },
    { text: help, dim: true },
  ];
  const compact: Array<FrameLine> = [
    { text: "Relay", bold: true },
    { text: "Switch harness" },
    ...optionLines,
    { text: help, dim: true },
  ];
  const lines = rows >= spacious.length + 2 ? spacious : compact;
  const fitted = lines.map((line) => ({ ...line, text: fit(line.text, columns) }));
  const contentWidth = Math.max(...fitted.map((line) => line.text.length), 1);
  const left = Math.max(0, Math.floor((columns - contentWidth) / 2));
  const top = rows > fitted.length ? Math.floor((rows - fitted.length) / 2) : 0;
  const indent = " ".repeat(left);
  const rendered = fitted.map((line) => {
    const value = `${indent}${line.text}`;
    if (line.selected) return `\u001b[7m${value}\u001b[0m`;
    if (line.bold) return `\u001b[1m${value}\u001b[0m`;
    if (line.dim) return `\u001b[2m${value}\u001b[0m`;
    return value;
  });
  return `${clearScreen}${"\r\n".repeat(top)}${rendered.join("\r\n")}\r\n`;
};

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

  const render = () =>
    io.output.write(
      renderSelectorFrame({
        current,
        selected: options[selected]!,
        columns: io.output.columns,
        rows: io.output.rows,
      }),
    );

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
      signalSource.off("SIGWINCH", onResize);
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
        if (pending.startsWith("\u001b[") || pending.startsWith("\u001bO")) {
          const start = 2;
          let final = -1;
          for (let index = start; index < pending.length; index += 1) {
            const code = pending.charCodeAt(index);
            if (code >= 0x40 && code <= 0x7e) {
              final = index;
              break;
            }
          }
          if (final === -1) return;
          const sequence = pending.slice(0, final + 1);
          pending = pending.slice(final + 1);
          const direction = sequence.at(-1);
          if (direction === "A" || direction === "D") move(-1);
          else if (direction === "B" || direction === "C") move(1);
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
    const onResize = () => render();

    io.output.write(alternateScreen);
    io.input.setRawMode?.(true);
    io.input.resume();
    io.input.on("data", onData);
    signalSource.on("SIGHUP", onHangup);
    signalSource.on("SIGINT", onInterrupt);
    signalSource.on("SIGTERM", onTerminate);
    signalSource.on("SIGQUIT", onQuit);
    signalSource.on("SIGWINCH", onResize);
    render();
  });
};
