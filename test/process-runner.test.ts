import { describe, expect, it } from "vitest";
import { readStream } from "../src/services/process-runner.ts";

describe("ProcessRunner", () => {
  it("streams lines while retaining only a bounded diagnostic tail", async () => {
    let lines = 0;
    const encoded = new TextEncoder().encode(`${"x".repeat(100_000)}\n`);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.subarray(0, 50_000));
        controller.enqueue(encoded.subarray(50_000));
        controller.close();
      },
    });
    const output = await readStream(stream, {
      limit: 1_024,
      onLine: () => {
        lines += 1;
      },
    });

    expect(lines).toBe(1);
    expect(output.length).toBeLessThanOrEqual(1_024);
  });

  it("drops an oversized JSONL event instead of retaining it", async () => {
    let lines = 0;
    const encoded = new TextEncoder().encode(`${"x".repeat(10_000)}\nsmall\n`);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < encoded.length; offset += 512) {
          controller.enqueue(encoded.subarray(offset, offset + 512));
        }
        controller.close();
      },
    });
    await readStream(stream, { lineLimit: 1_024, onLine: () => (lines += 1) });
    expect(lines).toBe(1);
  });
});
