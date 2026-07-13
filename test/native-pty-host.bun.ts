import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "bun:test";

import { NativeInputRouter } from "../src/native/input-router.ts";
import { runNativeTui } from "../src/native/pty-host.ts";

class TestInput extends EventEmitter {
  isTTY = true;
  isRaw = false;
  readonly rawModes: Array<boolean> = [];

  setRawMode(enabled: boolean) {
    this.isRaw = enabled;
    this.rawModes.push(enabled);
  }

  resume() {}
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

    const prefix = router.route(Buffer.from([0x1d]));
    expect(prefix.forward).toHaveLength(0);
    expect(prefix.switchRequested).toBe(false);
    const chord = router.route(Buffer.from("r"));
    expect(chord.forward).toHaveLength(0);
    expect(chord.switchRequested).toBe(true);
  });

  it("does not treat a pasted Relay chord as a switch", () => {
    const router = new NativeInputRouter();
    const pasted = router.route(Buffer.from("\u001b[200~before\u001dr-after\u001b[201~"));
    expect(Buffer.from(pasted.forward).toString()).toBe(
      "\u001b[200~before\u001dr-after\u001b[201~",
    );
    expect(pasted.switchRequested).toBe(false);
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
    expect(router.route(Buffer.from("\u001b[93;")).forward).toHaveLength(0);
    expect(router.route(Buffer.from("5u")).forward).toHaveLength(0);
    expect(router.route(Buffer.from("r")).switchRequested).toBe(true);

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

    input.emit("data", Buffer.from([0x1d]));
    input.emit("data", Buffer.from("r"));
    expect(await result).toEqual({ reason: "switch" });
    expect(output.text()).toContain(":TRAILING_OUTPUT");
    expect(input.rawModes).toEqual([true, false]);
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

    resize.emit("SIGTERM");
    expect(await result).toEqual({ reason: "signal", signal: "SIGTERM" });
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
    input.emit("data", Buffer.from([0x1d]));
    input.emit("data", Buffer.from("r"));
    await Bun.sleep(25);
    input.emit("data", Buffer.from("/resume"));
    await Bun.sleep(25);
    expect(output.text()).toContain(`INPUT:${Buffer.from("/resume").toString("hex")}`);

    idle = true;
    input.emit("data", Buffer.from([0x1d]));
    input.emit("data", Buffer.from("r"));
    expect(await result).toEqual({ reason: "switch" });
  });
});
