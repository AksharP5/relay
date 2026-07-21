import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "bun:test";

import { NativeInputRouter } from "../src/native/input-router.ts";
import { releaseNativeTuiInput, runNativeTui as runNativeTuiHost } from "../src/native/pty-host.ts";
import { legacySwitchSequences, parseSwitchKey } from "../src/switch-key.ts";

class TestInput extends EventEmitter {
  isTTY = true;
  isRaw = false;
  paused = false;
  readonly rawModes: Array<boolean> = [];
  readonly dataListenerCounts: Array<number> = [];
  pauseCalls = 0;

  setRawMode(enabled: boolean) {
    this.isRaw = enabled;
    this.rawModes.push(enabled);
  }

  resume() {
    this.paused = false;
  }
  pause() {
    this.paused = true;
    this.pauseCalls += 1;
  }

  override on(event: string | symbol, listener: (...args: Array<unknown>) => void) {
    super.on(event, listener);
    if (event === "data") this.dataListenerCounts.push(this.listenerCount("data"));
    return this;
  }

  override off(event: string | symbol, listener: (...args: Array<unknown>) => void) {
    super.off(event, listener);
    if (event === "data") this.dataListenerCounts.push(this.listenerCount("data"));
    return this;
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

class BlockedOutput extends TestOutput {
  override write(data: string | Uint8Array) {
    super.write(data);
    return false;
  }

  once(_event: "drain", _listener: () => void) {}
}

const running: Array<Promise<unknown>> = [];
const runningResizeSources = new Set<EventEmitter>();

const runNativeTui = (
  command: Parameters<typeof runNativeTuiHost>[0],
  io: NonNullable<Parameters<typeof runNativeTuiHost>[1]>,
  options: NonNullable<Parameters<typeof runNativeTuiHost>[2]> = {},
) => {
  runningResizeSources.add(io.resizeSource);
  return runNativeTuiHost(command, io, {
    ...options,
    onReady: () => {
      options.onReady?.();
      io.output.write("RELAY_HOST_READY");
    },
  });
};

const waitFor = async (
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 1_000,
) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await Bun.sleep(5);
  }
};

const waitForOutput = (output: TestOutput, expected: string, timeoutMs = 1_000) =>
  waitFor(
    () =>
      output.text().includes(expected) &&
      (expected !== "FAKE_NATIVE_READY:" || output.text().includes("RELAY_HOST_READY")),
    `native output: ${expected}`,
    timeoutMs,
  );

afterEach(async () => {
  for (const resize of runningResizeSources) resize.emit("SIGTERM");
  runningResizeSources.clear();
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

  it("recognizes direct toggle keys without stealing native control keys", () => {
    for (const sequence of [
      Buffer.from([0x11]),
      Buffer.from("\u001b[113;5u"),
      Buffer.from("\u001b[81;5:1u"),
      Buffer.from("\u001b[113:81;5u"),
      Buffer.from("\u001b[27;5;81~"),
      Buffer.from("\u001b[17~"),
      Buffer.from("\u001b[57369;1:1u"),
    ]) {
      const routed = new NativeInputRouter().route(sequence);
      expect(routed.switchRequested).toBe(true);
      expect(routed.forward).toHaveLength(0);
    }

    const backspace = new NativeInputRouter().route(Buffer.from([0x08]));
    expect(Buffer.from(backspace.forward)).toEqual(Buffer.from([0x08]));
    expect(backspace.switchRequested).toBe(false);

    const retiredCtrlShiftH = "\u001b[104;6u";
    const retired = new NativeInputRouter().route(Buffer.from(retiredCtrlShiftH));
    expect(Buffer.from(retired.forward).toString()).toBe(retiredCtrlShiftH);
    expect(retired.switchRequested).toBe(false);

    for (const event of ["\u001b[113;5:2u", "\u001b[113;5:3u"]) {
      const routed = new NativeInputRouter().route(Buffer.from(event));
      expect(Buffer.from(routed.forward).toString()).toBe(event);
      expect(routed.switchRequested).toBe(false);
    }
  });

  it("recognizes fragmented direct toggles and forwards fragmented native CSI input", () => {
    for (const [first, second] of [
      ["\u001b", "[17~"],
      ["\u001b", "[113;5u"],
      ["\u001b", "[57369;1:1u"],
      ["\u001b[17", "~"],
      ["\u001b[113;", "5u"],
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

    const toggle = router.route(Buffer.concat([Buffer.from([0x11]), Buffer.from("/resume")]));
    expect(toggle.switchRequested).toBe(true);
    expect(Buffer.from(toggle.afterSwitch).toString()).toBe("/resume");
  });

  it("does not treat a pasted direct shortcut as a switch", () => {
    const router = new NativeInputRouter();
    const pastedToggle = new NativeInputRouter().route(
      Buffer.concat([
        Buffer.from("\u001b[200~"),
        Buffer.from([0x11]),
        Buffer.from("\u001b[113;5u\u001b[17~\u001b[201~"),
      ]),
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

    const sameChunk = new NativeInputRouter().route(
      Buffer.concat([Buffer.from("prompt\r"), Buffer.from([0x11])]),
    );
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

  it("routes user-selected keys while preserving the former default", () => {
    const ctrlG = new NativeInputRouter(parseSwitchKey("Ctrl+G"));
    expect(ctrlG.route(Buffer.from([0x11])).switchRequested).toBe(false);
    expect(ctrlG.route(Buffer.from([0x07])).switchRequested).toBe(true);

    const ctrlShiftK = new NativeInputRouter(parseSwitchKey("Ctrl+Shift+K"));
    expect(ctrlShiftK.route(Buffer.from("\u001b[107;6u")).switchRequested).toBe(true);
    for (const event of ["\u001b[107;6:2u", "\u001b[107;6:3u"]) {
      expect(
        new NativeInputRouter(parseSwitchKey("Ctrl+Shift+K")).route(Buffer.from(event))
          .switchRequested,
      ).toBe(false);
    }

    const alternateKey = new NativeInputRouter(parseSwitchKey("Ctrl+Shift+Plus"));
    expect(alternateKey.route(Buffer.from("\u001b[61:43;6u")).switchRequested).toBe(true);

    const altShiftK = new NativeInputRouter(parseSwitchKey("Alt+Shift+K"));
    expect(altShiftK.route(Buffer.from("\u001b")).forward).toHaveLength(0);
    expect(altShiftK.route(Buffer.from("K")).switchRequested).toBe(true);

    const altShiftTabBinding = parseSwitchKey("Alt+Shift+Tab");
    const [altShiftTabSequence] = legacySwitchSequences(altShiftTabBinding);
    expect(Buffer.from(altShiftTabSequence!).toString("hex")).toBe("1b1b5b5a");
    expect(
      new NativeInputRouter(altShiftTabBinding).route(altShiftTabSequence!).switchRequested,
    ).toBe(true);

    const ambiguousAlt = new NativeInputRouter(parseSwitchKey("Alt+["));
    expect(ambiguousAlt.route(Buffer.from("\u001b[")).switchRequested).toBe(false);
    expect(ambiguousAlt.pendingTimeoutMs(500)).toBe(25);
    expect(ambiguousAlt.flushPendingRoute().switchRequested).toBe(true);

    const f1 = new NativeInputRouter(parseSwitchKey("F1"));
    expect(f1.route(Buffer.from("\u001bO")).forward).toHaveLength(0);
    expect(f1.route(Buffer.from("P")).switchRequested).toBe(true);
  });

  it("matches only whole terminal tokens, never characters inside an escape sequence", () => {
    for (const [binding, sequence] of [
      ["Escape", "\u001b[A"],
      ["[", "\u001b[B"],
      ["Shift+A", "\u001b[A"],
      ["1", "\u001b[1;2A"],
    ] as const) {
      const routed = new NativeInputRouter(parseSwitchKey(binding)).route(Buffer.from(sequence));
      expect(routed.switchRequested, binding).toBe(false);
      expect(Buffer.from(routed.forward).toString(), binding).toBe(sequence);
    }

    expect(
      new NativeInputRouter(parseSwitchKey("Super+Left")).route(Buffer.from("\u001b[57350;9u"))
        .switchRequested,
    ).toBe(true);
    expect(
      new NativeInputRouter(parseSwitchKey("Super+Left")).route(Buffer.from("\u001b[1;9D"))
        .switchRequested,
    ).toBe(true);
  });

  it("requires enhanced reports for modified control keys that legacy input collapses", () => {
    for (const [binding, legacy, enhanced] of [
      ["Shift+Return", "\r", "\u001b[13;2u"],
      ["Ctrl+Return", "\r", "\u001b[13;5u"],
      ["Ctrl+Tab", "\t", "\u001b[9;5u"],
      ["Shift+Escape", "\u001b", "\u001b[27;2u"],
      ["Shift+Backspace", "\u007f", "\u001b[127;2u"],
    ] as const) {
      const legacyResult = new NativeInputRouter(parseSwitchKey(binding)).route(
        Buffer.from(legacy),
      );
      expect(legacyResult.switchRequested, binding).toBe(false);
      const resolvedLegacy = new NativeInputRouter(parseSwitchKey(binding));
      resolvedLegacy.route(Buffer.from(legacy));
      expect(resolvedLegacy.flushPendingRoute().switchRequested, binding).toBe(false);

      expect(
        new NativeInputRouter(parseSwitchKey(binding)).route(Buffer.from(enhanced)).switchRequested,
        binding,
      ).toBe(true);
    }
  });

  it("allows ordinary characters, raw enhanced key codes, and disabling the primary key", () => {
    const plain = new NativeInputRouter(parseSwitchKey("x")).route(Buffer.from("axb"));
    expect(Buffer.from(plain.forward).toString()).toBe("a");
    expect(Buffer.from(plain.afterSwitch).toString()).toBe("b");
    expect(plain.switchRequested).toBe(true);

    const raw = new NativeInputRouter(parseSwitchKey("Super+Hyper+Meta+KeyCode:60000"));
    expect(raw.route(Buffer.from("\u001b[60000;57u")).switchRequested).toBe(true);

    const disabled = new NativeInputRouter(parseSwitchKey("none"));
    expect(disabled.route(Buffer.from([0x11])).switchRequested).toBe(false);
    expect(disabled.route(Buffer.from("\u001b[17~")).switchRequested).toBe(true);
  });

  it("protects bracketed paste even when its wrapper contains the configured key", () => {
    for (const binding of ["Escape", "[", "2", "0", "~"]) {
      const whole = new NativeInputRouter(parseSwitchKey(binding)).route(
        Buffer.from("\u001b[200~[20~\u001b[201~"),
      );
      expect(whole.switchRequested, binding).toBe(false);

      const fragmented = new NativeInputRouter(parseSwitchKey(binding));
      expect(fragmented.route(Buffer.from("\u001b[20")).switchRequested).toBe(false);
      expect(fragmented.route(Buffer.from("0~[20~\u001b[201~")).switchRequested).toBe(false);
    }

    const escape = new NativeInputRouter(parseSwitchKey("Escape"));
    expect(escape.route(Buffer.from("\u001b")).switchRequested).toBe(false);
    expect(escape.flushPendingRoute().switchRequested).toBe(true);
  });
});

describe("native PTY host", () => {
  it("uses the configured switch key for a real hosted TUI", async () => {
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
      { switchKey: parseSwitchKey("Ctrl+G") },
    );
    running.push(result);

    await waitForOutput(output, "FAKE_NATIVE_READY:");
    input.emit("data", Buffer.from([0x11]));
    await waitForOutput(output, "INPUT:11");
    input.emit("data", Buffer.from([0x07]));
    expect(await result).toEqual({ reason: "switch" });
  });

  it("switches on a configured Escape after paste-sequence disambiguation", async () => {
    const input = new TestInput();
    const output = new TestOutput();
    const result = runNativeTui(
      {
        executable: process.execPath,
        args: [new URL("./fixtures/fake-native-tui.ts", import.meta.url).pathname],
        cwd: process.cwd(),
      },
      { input, output, resizeSource: new EventEmitter() },
      { switchKey: parseSwitchKey("Escape") },
    );
    running.push(result);

    await waitForOutput(output, "FAKE_NATIVE_READY:");
    input.emit("data", Buffer.from("\u001b"));
    expect(await result).toEqual({ reason: "switch" });
  });

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

    await waitForOutput(output, "FAKE_NATIVE_READY:");
    input.emit("data", Buffer.from("/resume"));
    await waitForOutput(output, `INPUT:${Buffer.from("/resume").toString("hex")}`);
    expect(output.text()).toContain("\u001b[2J\u001b[HFAKE_NATIVE_READY:");
    expect(output.text()).toContain(`INPUT:${Buffer.from("/resume").toString("hex")}`);

    input.emit("data", Buffer.from([0x11]));
    expect(await result).toEqual({ reason: "switch" });
    expect(output.text()).toContain(":TRAILING_OUTPUT");
    expect(input.rawModes).toEqual([true, false]);
    expect(input.pauseCalls).toBe(1);
    expect(input.listenerCount("data")).toBe(0);
    expect(resize.listenerCount("SIGWINCH")).toBe(0);
  });

  it("extracts a session hint from bounded graceful-exit output", async () => {
    const input = new TestInput();
    const output = new TestOutput();
    const result = runNativeTui(
      {
        executable: process.execPath,
        args: [new URL("./fixtures/fake-native-tui.ts", import.meta.url).pathname],
        cwd: process.cwd(),
        env: {
          FAKE_NATIVE_OUTPUT_BYTES: "4096",
          FAKE_NATIVE_TRAILING_OUTPUT: "\nContinue opencode -s ses_selected123\n",
        },
      },
      { input, output, resizeSource: new EventEmitter() },
      {
        sessionIdHint: {
          maxBytes: 128,
          extract: (tail) => tail.match(/opencode -s (ses_[A-Za-z0-9]+)/)?.[1],
        },
      },
    );
    running.push(result);

    await waitForOutput(output, "FAKE_NATIVE_READY:");
    await waitForOutput(output, "FAKE_NATIVE_OUTPUT_READY");
    input.emit("data", Buffer.from([0x11]));
    expect(await result).toEqual({ reason: "switch", sessionIdHint: "ses_selected123" });
  });

  it("keeps shared stdin flowing and buffers bytes between native harnesses", async () => {
    const input = new TestInput();
    const command = {
      executable: process.execPath,
      args: [new URL("./fixtures/fake-native-tui.ts", import.meta.url).pathname],
      cwd: process.cwd(),
    };

    const firstOutput = new TestOutput();
    const firstResize = new EventEmitter();
    const first = runNativeTui(
      command,
      {
        input,
        output: firstOutput,
        resizeSource: firstResize,
      },
      { preserveInputOnSwitch: true },
    );
    running.push(first);
    await waitForOutput(firstOutput, "FAKE_NATIVE_READY:");
    input.emit("data", Buffer.concat([Buffer.from([0x11]), Buffer.from("after-switch")]));
    expect(await first).toEqual({ reason: "switch" });
    expect(input.isRaw).toBe(true);
    expect(input.paused).toBe(false);
    expect(input.listenerCount("data")).toBe(1);

    input.emit("data", Buffer.from(" capability-reply"));
    const secondOutput = new TestOutput();
    const secondResize = new EventEmitter();
    const second = runNativeTui(
      command,
      {
        input,
        output: secondOutput,
        resizeSource: secondResize,
      },
      { preserveInputOnSwitch: true },
    );
    running.push(second);
    const bufferedInput = `INPUT:${Buffer.from("after-switch capability-reply").toString("hex")}`;
    await waitForOutput(secondOutput, bufferedInput);
    expect(secondOutput.text()).toContain(bufferedInput);
    secondResize.emit("SIGTERM");
    expect(await second).toEqual({ reason: "signal", signal: "SIGTERM" });
    expect(input.rawModes).toEqual([true, false]);
    expect(input.isRaw).toBe(false);
    expect(input.paused).toBe(true);
    expect(input.listenerCount("data")).toBe(0);
    expect(input.dataListenerCounts).toEqual([1, 0]);
  });

  it("turns standby Ctrl+C into an interrupt instead of replaying it", async () => {
    const input = new TestInput();
    const resize = new EventEmitter();
    let interrupts = 0;
    resize.on("SIGINT", () => (interrupts += 1));
    const command = {
      executable: process.execPath,
      args: [new URL("./fixtures/fake-native-tui.ts", import.meta.url).pathname],
      cwd: process.cwd(),
    };
    const firstOutput = new TestOutput();
    const first = runNativeTui(
      command,
      { input, output: firstOutput, resizeSource: resize },
      { preserveInputOnSwitch: true },
    );
    running.push(first);
    await waitForOutput(firstOutput, "FAKE_NATIVE_READY:");
    input.emit("data", Buffer.from("\u001b[17~"));
    expect(await first).toEqual({ reason: "switch" });

    input.emit("data", Buffer.from([0x03]));
    expect(interrupts).toBe(1);
    const secondOutput = new TestOutput();
    const second = runNativeTui(
      command,
      { input, output: secondOutput, resizeSource: resize },
      { preserveInputOnSwitch: true },
    );
    running.push(second);
    await waitForOutput(secondOutput, "FAKE_NATIVE_READY:");
    expect(secondOutput.text()).not.toContain("INPUT:03");
    resize.emit("SIGTERM");
    expect(await second).toEqual({ reason: "signal", signal: "SIGTERM" });
  });

  it("drops an overflowing standby sequence whole without corrupting the next router", async () => {
    const input = new TestInput();
    const resize = new EventEmitter();
    const command = {
      executable: process.execPath,
      args: [new URL("./fixtures/fake-native-tui.ts", import.meta.url).pathname],
      cwd: process.cwd(),
    };
    const firstOutput = new TestOutput();
    const first = runNativeTui(
      command,
      { input, output: firstOutput, resizeSource: resize },
      { preserveInputOnSwitch: true, handoffInputLimitBytes: 8 },
    );
    running.push(first);
    await waitForOutput(firstOutput, "FAKE_NATIVE_READY:");
    input.emit("data", Buffer.from("\u001b[17~"));
    expect(await first).toEqual({ reason: "switch" });
    input.emit("data", Buffer.from("\u001b[200~0123456789"));

    const secondOutput = new TestOutput();
    const second = runNativeTui(
      command,
      { input, output: secondOutput, resizeSource: resize },
      { preserveInputOnSwitch: true },
    );
    running.push(second);
    await waitForOutput(secondOutput, "FAKE_NATIVE_READY:");
    expect(secondOutput.text()).not.toContain("INPUT:");
    expect(secondOutput.chunks.some((chunk) => chunk.includes(0x07))).toBe(true);
    input.emit("data", Buffer.from("\u001b[17~"));
    expect(await second).toEqual({ reason: "switch" });

    const thirdOutput = new TestOutput();
    const third = runNativeTui(
      command,
      { input, output: thirdOutput, resizeSource: resize },
      { preserveInputOnSwitch: true },
    );
    running.push(third);
    await waitForOutput(thirdOutput, "FAKE_NATIVE_READY:");
    resize.emit("SIGTERM");
    expect(await third).toEqual({ reason: "signal", signal: "SIGTERM" });
  });

  it("can release an abandoned preserved custom input", async () => {
    const input = new TestInput();
    const resize = new EventEmitter();
    const output = new TestOutput();
    const first = runNativeTui(
      {
        executable: process.execPath,
        args: [new URL("./fixtures/fake-native-tui.ts", import.meta.url).pathname],
        cwd: process.cwd(),
      },
      { input, output, resizeSource: resize },
      { preserveInputOnSwitch: true },
    );
    running.push(first);
    await waitForOutput(output, "FAKE_NATIVE_READY:");
    input.emit("data", Buffer.from("\u001b[17~"));
    expect(await first).toEqual({ reason: "switch" });

    await releaseNativeTuiInput(input);
    expect(input.listenerCount("data")).toBe(0);
    expect(input.paused).toBe(true);
    expect(input.isRaw).toBe(false);
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

    await waitForOutput(output, "FAKE_NATIVE_READY:");
    input.emit("data", Buffer.from("\u001b"));
    await waitForOutput(output, "INPUT:1b");

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

    await waitForOutput(output, "FAKE_NATIVE_READY:");
    input.emit("data", Buffer.from("first prompt\r"));
    input.emit("data", Buffer.from([0x11]));
    await waitForOutput(output, "INPUT:66697273742070726f6d70740d");
    expect(statusChecks).toBe(0);
    expect(output.text()).toContain("INPUT:66697273742070726f6d70740d");
    expect(output.chunks.some((chunk) => chunk.includes(0x07))).toBe(true);

    clock = 1_100;
    input.emit("data", Buffer.from([0x11]));
    expect(await result).toEqual({ reason: "switch" });
    expect(statusChecks).toBe(1);
  });

  it("reports recent submits to the cold-session guard after the immediate grace window", async () => {
    const input = new TestInput();
    const output = new TestOutput();
    const resize = new EventEmitter();
    let clock = 100;
    const recentSubmits: Array<boolean | undefined> = [];
    let submitSnapshots = 0;
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
        onSubmitObserved: () => {
          submitSnapshots += 1;
        },
        onSwitchRequest: (recentSubmit) => {
          recentSubmits.push(recentSubmit);
          return recentSubmits.length > 1;
        },
      },
    );
    running.push(result);

    await waitForOutput(output, "FAKE_NATIVE_READY:");
    input.emit("data", Buffer.from("first prompt\r"));
    clock = 1_100;
    input.emit("data", Buffer.from([0x11]));
    await waitFor(() => recentSubmits.length === 1, "first cold-session guard result");
    clock = 10_100;
    input.emit("data", Buffer.from([0x11]));

    expect(await result).toEqual({ reason: "switch" });
    expect(recentSubmits).toEqual([true, false]);
    expect(submitSnapshots).toBe(1);
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

    await waitForOutput(output, "FAKE_NATIVE_READY:");
    input.emit("data", Buffer.from("warm prompt\r"));
    input.emit("data", Buffer.from([0x11]));

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

    await waitForOutput(output, "FAKE_NATIVE_READY:");
    input.emit("data", Buffer.concat([Buffer.from([0x11]), Buffer.from("/resume")]));
    const resumedInput = `INPUT:${Buffer.from("/resume").toString("hex")}`;
    await waitForOutput(output, resumedInput);
    expect(output.text()).toContain(resumedInput);

    idle = true;
    input.emit("data", Buffer.from([0x11]));
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

    await waitForOutput(output, "FAKE_NATIVE_READY:");
    input.emit("data", Buffer.concat([Buffer.from([0x11]), Buffer.from("abc")]));
    input.emit("data", Buffer.from("def"));
    await waitFor(() => resolveIdle !== undefined, "asynchronous switch guard");
    expect(output.text()).not.toContain(`INPUT:${Buffer.from("def").toString("hex")}`);

    resolveIdle?.(false);
    const readNativeInput = () =>
      output
        .text()
        .split("INPUT:")
        .slice(1)
        .join("")
        .replaceAll(/[^0-9a-f]/g, "");
    await waitFor(
      () => Buffer.from(readNativeInput(), "hex").toString() === "abcdef",
      "buffered input replay",
    );
    const nativeInput = readNativeInput();
    expect(Buffer.from(nativeInput, "hex").toString()).toBe("abcdef");

    resize.emit("SIGTERM");
    expect(await result).toEqual({ reason: "signal", signal: "SIGTERM" });
  });

  it("bounds input while an asynchronous switch guard is pending", async () => {
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
        handoffInputLimitBytes: 8,
        onSwitchRequest: () =>
          new Promise<boolean>((resolve) => {
            resolveIdle = resolve;
          }),
      },
    );
    running.push(result);

    await waitForOutput(output, "FAKE_NATIVE_READY:");
    input.emit("data", Buffer.concat([Buffer.from([0x11]), Buffer.from("\u001b[200~")]));
    input.emit("data", Buffer.alloc(1_000_000, "x"));
    await waitFor(() => resolveIdle !== undefined, "bounded asynchronous switch guard");
    resolveIdle?.(false);
    await waitFor(() => output.chunks.some((chunk) => chunk.includes(0x07)), "overflow bell");

    expect(output.text()).not.toContain(`INPUT:${Buffer.from("\u001b[200~").toString("hex")}`);
    expect(output.chunks.some((chunk) => chunk.includes(0x07))).toBe(true);
    resize.emit("SIGTERM");
    expect(await result).toEqual({ reason: "signal", signal: "SIGTERM" });
  });

  it("allows Ctrl+C to interrupt an asynchronous switch guard", async () => {
    const input = new TestInput();
    const resize = new EventEmitter();
    const output = new TestOutput();
    const result = runNativeTui(
      {
        executable: process.execPath,
        args: [new URL("./fixtures/fake-native-tui.ts", import.meta.url).pathname],
        cwd: process.cwd(),
      },
      { input, output, resizeSource: resize },
      { onSwitchRequest: () => new Promise<boolean>(() => undefined) },
    );
    running.push(result);

    await waitForOutput(output, "FAKE_NATIVE_READY:");
    input.emit("data", Buffer.from("\u001b[17~"));
    input.emit("data", Buffer.from([0x03]));
    expect(await result).toEqual({ reason: "signal", signal: "SIGINT" });
  });

  it("terminates instead of accumulating unbounded output under backpressure", async () => {
    const input = new TestInput();
    const output = new BlockedOutput();
    const result = runNativeTui(
      {
        executable: process.execPath,
        args: [new URL("./fixtures/fake-native-tui.ts", import.meta.url).pathname],
        cwd: process.cwd(),
        env: { FAKE_NATIVE_OUTPUT_BYTES: "32", FAKE_NATIVE_OUTPUT_ON_INPUT: "1" },
      },
      { input, output, resizeSource: new EventEmitter() },
      { ioQueueLimitBytes: 8 },
    );
    running.push(result);

    await waitForOutput(output, "FAKE_NATIVE_READY:");
    input.emit("data", Buffer.from("overflow"));
    await expect(result).rejects.toThrow("output backpressure exceeded");
    expect(input.isRaw).toBe(false);
    expect(input.listenerCount("data")).toBe(0);
  });
});
