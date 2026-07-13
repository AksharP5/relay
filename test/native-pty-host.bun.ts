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
  it("keeps slash-command typing native and reserves only the Relay prefix chord", () => {
    const router = new NativeInputRouter();
    const slash = router.route(Buffer.from("/resume"));
    expect(Buffer.from(slash.forward).toString()).toBe("/resume");
    expect(slash.switchRequested).toBe(false);
    const relayLikeCommand = router.route(Buffer.from("/harness\r"));
    expect(Buffer.from(relayLikeCommand.forward).toString()).toBe("/harness\r");
    expect(relayLikeCommand.switchRequested).toBe(false);

    const prefix = router.route(Buffer.from([0x1d]));
    expect(prefix.forward).toHaveLength(0);
    expect(prefix.switchRequested).toBe(false);
    const chord = router.route(Buffer.from("r"));
    expect(chord.forward).toHaveLength(0);
    expect(chord.afterSwitch).toHaveLength(0);
    expect(chord.switchRequested).toBe(true);
    expect(chord.switchIntent).toBe("selector");
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
      expect(routed.switchIntent).toBe("toggle");
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

  it("forwards Escape immediately and preserves bytes after a switch chord", () => {
    const router = new NativeInputRouter();
    const escape = router.route(Buffer.from("\u001b"));
    expect(Buffer.from(escape.forward)).toEqual(Buffer.from("\u001b"));
    expect(router.hasPendingPrefix).toBe(false);

    const chord = router.route(Buffer.from([0x1d, ...Buffer.from("r/resume")]));
    expect(chord.switchRequested).toBe(true);
    expect(Buffer.from(chord.afterSwitch).toString()).toBe("/resume");
  });

  it("does not treat a pasted Relay chord as a switch", () => {
    const router = new NativeInputRouter();
    const pasted = router.route(Buffer.from("\u001b[200~before\u001dr-after\u001b[201~"));
    expect(Buffer.from(pasted.forward).toString()).toBe(
      "\u001b[200~before\u001dr-after\u001b[201~",
    );
    expect(pasted.switchRequested).toBe(false);
    const pastedToggle = new NativeInputRouter().route(
      Buffer.from("\u001b[200~\u001b[104;6u\u001b[17~\u001b[201~"),
    );
    expect(pastedToggle.switchRequested).toBe(false);
    router.route(Buffer.from([0x1d]));
    expect(router.route(Buffer.from("r")).switchRequested).toBe(true);
  });

  it("recognizes bracketed-paste markers split across input chunks", () => {
    const router = new NativeInputRouter();
    expect(router.route(Buffer.from("\u001b[20")).switchRequested).toBe(false);
    const middle = router.route(Buffer.from("0~x\u001dry\u001b[20"));
    expect(middle.switchRequested).toBe(false);
    expect(router.route(Buffer.from("1~")).switchRequested).toBe(false);
    router.route(Buffer.from([0x1d]));
    expect(router.route(Buffer.from("r")).switchRequested).toBe(true);
  });

  it("recognizes Codex CSI-u encoding and forwards an unused prefix", () => {
    const router = new NativeInputRouter();
    expect(router.route(Buffer.from("\u001b[93;5u")).forward).toHaveLength(0);
    expect(router.route(Buffer.from("r")).switchRequested).toBe(true);

    const split = new NativeInputRouter();
    expect(Buffer.from(split.route(Buffer.from("\u001b[93;")).forward).toString()).toBe(
      "\u001b[93;",
    );
    expect(Buffer.from(split.route(Buffer.from("5u")).forward).toString()).toBe("5u");

    const unused = new NativeInputRouter();
    unused.route(Buffer.from([0x1d]));
    expect(Buffer.from(unused.route(Buffer.from("x")).forward)).toEqual(
      Buffer.from([0x1d, "x".charCodeAt(0)]),
    );
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
    expect(await result).toEqual({ reason: "switch", intent: "toggle" });
    expect(output.text()).toContain(":TRAILING_OUTPUT");
    expect(input.rawModes).toEqual([true, false]);
    expect(input.pauseCalls).toBe(1);
    expect(input.listenerCount("data")).toBe(0);
    expect(resize.listenerCount("SIGWINCH")).toBe(0);
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

  it("forwards an unused Relay prefix after the bounded chord timeout", async () => {
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
      { prefixTimeoutMs: 10 },
    );
    running.push(result);

    await Bun.sleep(50);
    input.emit("data", Buffer.from([0x1d]));
    await Bun.sleep(40);
    expect(output.text()).toContain("INPUT:1d");

    resize.emit("SIGINT");
    expect(await result).toEqual({ reason: "signal", signal: "SIGINT" });
    expect(input.rawModes).toEqual([true, false]);
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
    input.emit("data", Buffer.from([0x1d, ...Buffer.from("r/resume")]));
    await Bun.sleep(25);
    expect(output.text()).toContain(`INPUT:${Buffer.from("/resume").toString("hex")}`);

    idle = true;
    input.emit("data", Buffer.from([0x1d]));
    input.emit("data", Buffer.from("r"));
    expect(await result).toEqual({ reason: "switch", intent: "selector" });
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
    input.emit("data", Buffer.from([0x1d, ...Buffer.from("rabc")]));
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
