import type { EventEmitter } from "node:events";

import type { Harness } from "../domain.ts";

interface SelectorInput extends EventEmitter {
  readonly isRaw?: boolean;
  setRawMode?: (enabled: boolean) => unknown;
  resume: () => unknown;
}

interface SelectorOutput {
  write: (data: string | Uint8Array) => unknown;
}

export interface SelectorIo {
  readonly input: SelectorInput;
  readonly output: SelectorOutput;
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
  let selected = Math.max(0, options.indexOf(current));

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
      io.input.off("data", onData);
      io.input.setRawMode?.(initialRawMode);
      io.output.write(restoreScreen);
      resolve(result);
    };
    const move = (offset: number) => {
      selected = (selected + offset + options.length) % options.length;
      render();
    };
    const onData = (chunk: Buffer | Uint8Array | string) => {
      const value = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      if (value === "\u0003" || value.toLowerCase() === "q") return finish(undefined);
      if (value === "\u001b") return finish(current);
      if (value === "\r" || value === "\n") return finish(options[selected]);
      if (value === "\u001b[A" || value === "\u001b[D") return move(-1);
      if (value === "\u001b[B" || value === "\u001b[C" || value === "\t") return move(1);
      if (value.toLowerCase() === "c") {
        selected = options.indexOf("codex");
        render();
      }
      if (value.toLowerCase() === "o") {
        selected = options.indexOf("opencode");
        render();
      }
    };

    io.output.write(alternateScreen);
    io.input.setRawMode?.(true);
    io.input.resume();
    io.input.on("data", onData);
    render();
  });
};
