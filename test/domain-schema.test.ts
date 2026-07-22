import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { RelayMessage, RelayThread } from "../src/domain.ts";

describe("Relay domain schemas", () => {
  it("accepts omitted JSON optional keys and rejects present undefined values", () => {
    const message = {
      id: "message-1",
      seq: 1,
      role: "user",
      content: "hello",
      harness: "codex",
      createdAt: "2026-07-22T00:00:00.000Z",
    };
    const thread = {
      id: "thread-1",
      title: "Schema boundary",
      cwd: "/tmp/project",
      activeHarness: "codex",
      bindings: {},
      lastSeq: 0,
      createdAt: "2026-07-22T00:00:00.000Z",
      updatedAt: "2026-07-22T00:00:00.000Z",
    };

    expect(Schema.is(RelayMessage)(message)).toBe(true);
    expect(Schema.is(RelayMessage)({ ...message, nativeId: undefined })).toBe(false);
    expect(Schema.is(RelayThread)(thread)).toBe(true);
    expect(Schema.is(RelayThread)({ ...thread, bindings: { codex: undefined } })).toBe(false);
  });
});
