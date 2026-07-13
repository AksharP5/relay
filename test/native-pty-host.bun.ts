import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "bun:test";

import { NativeInputRouter } from "../src/native/input-router.ts";
import { runNativeTui } from "../src/native/pty-host.ts";

class TestInput extends EventEmitter {
  isTTY = true;
  isRaw = false;
  readonly rawModes: Array<boolean> = [];
  pauseCalls = 0;

  setRawMode(enabled: boolean) {
    this.isRaw = enabled;
    this.rawModes.push(enabled);
  }

  resume() {}
  pause() {
    this.pauseCalls += 1;
  }
}

class QueuedResumeInput extends TestInput {
  resumeInput: Uint8Array | undefined;

  override resume() {
    const input = this.resumeInput;
    this.resumeInput = undefined;
    if (input) this.emit("data", input);
  }
}

class TestOutput {
  columns = 90;
  rows = 28;
  readonly chunks: Array<Buffer> = [];

  write(data: string | Uint8Array) {
    this.chunks.push(Buffer.from(data));
  }

  text() {
    return Buffer.concat(this.chunks).toString();
  }
}

const running: Array<Promise<unknown>> = [];

afterEach(async () => {
  await Promise.allSettled(running.splice(0));
});

describe("native input routing", () => {
  it("keeps slash commands and the retired prefix chord native", () => {
    const router = new NativeInputRouter();
    const slash = router.route(Buffer.from("/resume"));
    expect(Buffer.from(slash.forward).toString()).toBe("/resume");
    expect(slash.switchRequested).toBe(false);
    const relayLikeCommand = router.route(Buffer.from("/harness\r"));
    expect(Buffer.from(relayLikeCommand.forward).toString()).toBe("/harness\r");
    expect(relayLikeCommand.switchRequested).toBe(false);

    const retiredChord = Buffer.from([0x1d, "r".charCodeAt(0)]);
    const routed = router.route(retiredChord);
    expect(Buffer.from(routed.forward)).toEqual(retiredChord);
    expect(routed.switchRequested).toBe(false);
  });

  it("recognizes direct toggle keys without stealing legacy Backspace", () => {
    for (const sequence of [
      "\u001b[104;6u",
      "\u001b[72;6:1u",
      "\u001b[104:72;6u",
      "\u001b[27;6;72~",
      "\u001b[17~",
      "\u001b[57369;1:1u",
    ]) {
      const routed = new NativeInputRouter().route(Buffer.from(sequence));
      expect(routed.switchRequested).toBe(true);
      expect(routed.forward).toHaveLength(0);
    }

    const backspace = new NativeInputRouter().route(Buffer.from([0x08]));
    expect(Buffer.from(backspace.forward)).toEqual(Buffer.from([0x08]));
    expect(backspace.switchRequested).toBe(false);

    for (const event of ["\u001b[104;6:2u", "\u001b[104;6:3u"]) {
      const routed = new NativeInputRouter().route(Buffer.from(event));
      expect(Buffer.from(routed.forward).toString()).toBe(event);
      expect(routed.switchRequested).toBe(false);
    }
  });

  it("recognizes fragmented direct toggles and forwards fragmented native CSI input", () => {
    for (const [first, second] of [
      ["\u001b", "[17~"],
      ["\u001b", "[104;6u"],
      ["\u001b", "[57369;1:1u"],
      ["\u001b[17", "~"],
      ["\u001b[104;", "6u"],
      ["\u001b[57369;1:", "1u"],
    ] as const) {
      const router = new NativeInputRouter();
      expect(router.route(Buffer.from(first)).forward).toHaveLength(0);
      expect(router.hasPendingSequence).toBe(true);
      const routed = router.route(Buffer.from(second));
      expect(routed.switchRequested).toBe(true);
    }

    const arrow = new NativeInputRouter();
    expect(arrow.route(Buffer.from("\u001b[1;")).forward).toHaveLength(0);
    expect(Buffer.from(arrow.route(Buffer.from("2A")).forward).toString()).toBe("\u001b[1;2A");
  });

  it("preserves Escape and bytes after a direct switch", () => {
    const router = new NativeInputRouter();
    const escape = router.route(Buffer.from("\u001b"));
    expect(escape.forward).toHaveLength(0);
    expect(router.hasPendingSequence).toBe(true);
    expect(Buffer.from(router.flushPendingSequence())).toEqual(Buffer.from("\u001b"));

    const toggle = router.route(Buffer.from("\u001b[104;6u/resume"));
    expect(toggle.switchRequested).toBe(true);
    expect(Buffer.from(toggle.afterSwitch).toString()).toBe("/resume");
  });

  it("does not treat a pasted direct shortcut as a switch", () => {
    const router = new NativeInputRouter();
    const pastedToggle = new NativeInputRouter().route(
      Buffer.from("\u001b[200~\u001b[104;6u\u001b[17~\u001b[201~"),
    );
    expect(pastedToggle.switchRequested).toBe(false);
  });

  it("recognizes bracketed-paste markers split across input chunks", () => {
    const router = new NativeInputRouter();
    expect(router.route(Buffer.from("\u001b[20")).switchRequested).toBe(false);
    const middle = router.route(Buffer.from("0~x\u001dry\u001b[20"));
    expect(middle.switchRequested).toBe(false);
    expect(router.route(Buffer.from("1~")).switchRequested).toBe(false);
    expect(router.route(Buffer.from("\u001b[17~")).switchRequested).toBe(true);
  });

  it("observes real Enter presses without treating pasted newlines or key events as submits", () => {
    for (const input of ["prompt\r", "prompt\n", "prompt\r\n", "\u001b[13u", "\u001b[13;1:1u"]) {
      expect(new NativeInputRouter().route(Buffer.from(input)).submitObserved).toBe(true);
    }
    for (const input of [
      "\u001b[200~first\nsecond\u001b[201~",
      "\u001b[13;2:1u",
      "\u001b[13;3:1u",
      "\u001b[13;5:1u",
      "\u001b[13;1:2u",
      "\u001b[13;1:3u",
    ]) {
      expect(new NativeInputRouter().route(Buffer.from(input)).submitObserved).toBe(false);
    }

    const sameChunk = new NativeInputRouter().route(Buffer.from("prompt\r\u001b[104;6u"));
    expect(sameChunk.submitObserved).toBe(true);
    expect(sameChunk.switchRequested).toBe(true);

    const fragmentedPaste = new NativeInputRouter();
    expect(fragmentedPaste.route(Buffer.from("\u001b[20")).submitObserved).toBe(false);
    expect(fragmentedPaste.route(Buffer.from("0~first\nsecond\u001b[20")).submitObserved).toBe(
      false,
    );
    expect(fragmentedPaste.route(Buffer.from("1~")).submitObserved).toBe(false);
  });

  it("forwards the retired Ctrl+] encodings byte-for-byte", () => {
    const router = new NativeInputRouter();
    const complete = "\u001b[93;5ur";
    const routed = router.route(Buffer.from(complete));
    expect(Buffer.from(routed.forward).toString()).toBe(complete);
    expect(routed.switchRequested).toBe(false);

    const split = new NativeInputRouter();
    expect(split.route(Buffer.from("\u001b[93;")).forward).toHaveLength(0);
    expect(Buffer.from(split.route(Buffer.from("5ur")).forward).toString()).toBe("\u001b[93;5ur");
  });
});

describe("native PTY host", () => {
  it("forwards native ANSI output and slash-command input without re-rendering", async () => {
    const input = new TestInput();
    const output = new TestOutput();
    const resize = new EventEmitter();
    const result = runNativeTui(
      {
        executable: process.execPath,
        args: [new URL("./fixtures/fake-native-tui.ts", import.meta.url).pathname],
        cwd: process.cwd(),
      },
      { input, output, resizeSource: resize },
    );
    running.push(result);

    await Bun.sleep(50);
    input.emit("data", Buffer.from("/resume"));
    await Bun.sleep(50);
    expect(output.text()).toContain("\u001b[2J\u001b[HFAKE_NATIVE_READY:");
    expect(output.text()).toContain(`INPUT:${Buffer.from("/resume").toString("hex")}`);

    input.emit("data", Buffer.from("\u001b[104;6u"));
    expect(await result).toEqual({ reason: "switch" });
    expect(output.text()).toContain(":TRAILING_OUTPUT");
    expect(input.rawModes).toEqual([true, false]);
    expect(input.pauseCalls).toBe(1);
    expect(input.listenerCount("data")).toBe(0);
    expect(resize.listenerCount("SIGWINCH")).toBe(0);
  });

  it("reattaches input before resuming the shared terminal for the next harness", async () => {
    const input = new QueuedResumeInput();
    const command = {
      executable: process.execPath,
      args: [new URL("./fixtures/fake-native-tui.ts", import.meta.url).pathname],
      cwd: process.cwd(),
    };

    const firstResize = new EventEmitter();
    const first = runNativeTui(command, {
      input,
      output: new TestOutput(),
      resizeSource: firstResize,
    });
    running.push(first);
    await Bun.sleep(50);
    input.emit("data", Buffer.from("\u001b[104;6u"));
    expect(await first).toEqual({ reason: "switch" });

    const secondResize = new EventEmitter();
    input.resumeInput = Buffer.from("\u001b[17~");
    const second = runNativeTui(command, {
      input,
      output: new TestOutput(),
      resizeSource: secondResize,
    });
    running.push(second);
    void Bun.sleep(150).then(() => secondResize.emit("SIGTERM"));

    expect(await second).toEqual({ reason: "switch" });
  });

  it("rejects non-interactive input before starting a child", async () => {
    const input = new TestInput();
    input.isTTY = false;
    await expect(
      runNativeTui(
        { executable: "unused", args: [], cwd: process.cwd() },
        { input, output: new TestOutput(), resizeSource: new EventEmitter() },
      ),
    ).rejects.toThrow("interactive terminal");
  });

  it("forwards a lone Escape after low-latency sequence disambiguation", async () => {
    const input = new TestInput();
    const output = new TestOutput();
    const resize = new EventEmitter();
    const result = runNativeTui(
      {
        executable: process.execPath,
        args: [new URL("./fixtures/fake-native-tui.ts", import.meta.url).pathname],
        cwd: process.cwd(),
      },
      { input, output, resizeSource: resize },
    );
    running.push(result);

    await Bun.sleep(50);
    input.emit("data", Buffer.from("\u001b"));
    await Bun.sleep(60);
    expect(output.text()).toContain("INPUT:1b");

    resize.emit("SIGTERM");
    expect(await result).toEqual({ reason: "signal", signal: "SIGTERM" });
  });

  it("keeps a just-submitted cold turn attached until backend status can materialize", async () => {
    const input = new TestInput();
    const output = new TestOutput();
    const resize = new EventEmitter();
    let clock = 100;
    let statusChecks = 0;
    const result = runNativeTui(
      {
        executable: process.execPath,
        args: [new URL("./fixtures/fake-native-tui.ts", import.meta.url).pathname],
        cwd: process.cwd(),
      },
      { input, output, resizeSource: resize },
      {
        now: () => clock,
        submitGraceMs: 1_000,
        onSwitchRequest: () => {
          statusChecks += 1;
          return true;
        },
      },
    );
    running.push(result);

    await Bun.sleep(50);
    input.emit("data", Buffer.from("first prompt\r"));
    input.emit("data", Buffer.from("\u001b[104;6u"));
    await Bun.sleep(25);
    expect(statusChecks).toBe(0);
    expect(output.text()).toContain("INPUT:66697273742070726f6d70740d");
    expect(output.chunks.some((chunk) => chunk.includes(0x07))).toBe(true);

    clock = 1_100;
    input.emit("data", Buffer.from("\u001b[104;6u"));
    expect(await result).toEqual({ reason: "switch" });
    expect(statusChecks).toBe(1);
  });

  it("reports recent submits to the cold-session guard after the immediate grace window", async () => {
    const input = new TestInput();
    const output = new TestOutput();
    const resize = new EventEmitter();
    let clock = 100;
    const recentSubmits: Array<boolean | undefined> = [];
    const result = runNativeTui(
      {
        executable: process.execPath,
        args: [new URL("./fixtures/fake-native-tui.ts", import.meta.url).pathname],
        cwd: process.cwd(),
      },
      { input, output, resizeSource: resize },
      {
        now: () => clock,
        submitGraceMs: 1_000,
        submitProtectionMs: 10_000,
        onSwitchRequest: (recentSubmit) => {
          recentSubmits.push(recentSubmit);
          return recentSubmits.length > 1;
        },
      },
    );
    running.push(result);

    await Bun.sleep(50);
    input.emit("data", Buffer.from("first prompt\r"));
    clock = 1_100;
    input.emit("data", Buffer.from("\u001b[104;6u"));
    await Bun.sleep(25);
    clock = 10_100;
    input.emit("data", Buffer.from("\u001b[104;6u"));

    expect(await result).toEqual({ reason: "switch" });
    expect(recentSubmits).toEqual([true, false]);
  });

  it("does not delay switching after Enter when cold-session protection is disabled", async () => {
    const input = new TestInput();
    const output = new TestOutput();
    const resize = new EventEmitter();
    const recentSubmits: Array<boolean | undefined> = [];
    const result = runNativeTui(
      {
        executable: process.execPath,
        args: [new URL("./fixtures/fake-native-tui.ts", import.meta.url).pathname],
        cwd: process.cwd(),
      },
      { input, output, resizeSource: resize },
      {
        onSwitchRequest: (recentSubmit) => {
          recentSubmits.push(recentSubmit);
          return true;
        },
      },
    );
    running.push(result);

    await Bun.sleep(50);
    input.emit("data", Buffer.from("warm prompt\r"));
    input.emit("data", Buffer.from("\u001b[104;6u"));

    expect(await result).toEqual({ reason: "switch" });
    expect(recentSubmits).toEqual([false]);
  });

  it("keeps the native frontend alive when an active turn vetoes switching", async () => {
    const input = new TestInput();
    const output = new TestOutput();
    const resize = new EventEmitter();
    let idle = false;
    const result = runNativeTui(
      {
        executable: process.execPath,
        args: [new URL("./fixtures/fake-native-tui.ts", import.meta.url).pathname],
        cwd: process.cwd(),
      },
      { input, output, resizeSource: resize },
      { onSwitchRequest: () => idle },
    );
    running.push(result);

    await Bun.sleep(50);
    input.emit("data", Buffer.from("\u001b[104;6u/resume"));
    await Bun.sleep(25);
    expect(output.text()).toContain(`INPUT:${Buffer.from("/resume").toString("hex")}`);

    idle = true;
    input.emit("data", Buffer.from("\u001b[104;6u"));
    expect(await result).toEqual({ reason: "switch" });
  });

  it("buffers post-chord input while checking and restores its order after a veto", async () => {
    const input = new TestInput();
    const output = new TestOutput();
    const resize = new EventEmitter();
    let resolveIdle: ((idle: boolean) => void) | undefined;
    const result = runNativeTui(
      {
        executable: process.execPath,
        args: [new URL("./fixtures/fake-native-tui.ts", import.meta.url).pathname],
        cwd: process.cwd(),
      },
      { input, output, resizeSource: resize },
      {
        onSwitchRequest: () =>
          new Promise<boolean>((resolve) => {
            resolveIdle = resolve;
          }),
      },
    );
    running.push(result);

    await Bun.sleep(50);
    input.emit("data", Buffer.from("\u001b[104;6uabc"));
    input.emit("data", Buffer.from("def"));
    await Bun.sleep(20);
    expect(output.text()).not.toContain(`INPUT:${Buffer.from("def").toString("hex")}`);

    resolveIdle?.(false);
    await Bun.sleep(30);
    const nativeInput = output
      .text()
      .split("INPUT:")
      .slice(1)
      .join("")
      .replaceAll(/[^0-9a-f]/g, "");
    expect(Buffer.from(nativeInput, "hex").toString()).toBe("abcdef");

    resize.emit("SIGTERM");
    expect(await result).toEqual({ reason: "signal", signal: "SIGTERM" });
  });
});
