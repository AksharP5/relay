import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "bun:test";

import { OpenCodeNativeBackend, parseOpenCodeNativeTurns } from "../src/native/opencode-backend.ts";

const executable = fileURLToPath(new URL("./fixtures/fake-opencode-server.ts", import.meta.url));

beforeAll(() => chmod(executable, 0o755));

describe("OpenCode native backend", () => {
  it("imports only completed visible user/assistant turns", () => {
    expect(
      parseOpenCodeNativeTurns([
        {
          info: { id: "hidden", role: "user" },
          parts: [{ type: "text", text: "handoff", synthetic: true }],
        },
        {
          info: { id: "user-1", role: "user" },
          parts: [{ type: "text", text: "Fix checkout" }],
        },
        {
          info: { id: "assistant-1", role: "assistant", time: { completed: 2 } },
          parts: [
            { type: "reasoning", text: "hidden" },
            { type: "text", text: "Fixed checkout." },
          ],
        },
        {
          info: { id: "user-2", role: "user" },
          parts: [{ type: "text", text: "Incomplete" }],
        },
        {
          info: {
            id: "assistant-2a",
            role: "assistant",
            parentID: "user-2",
            finish: "tool-calls",
            time: { completed: 3 },
          },
          parts: [{ type: "text", text: "checking" }],
        },
        {
          info: { id: "assistant-2", role: "assistant", time: { created: 4 } },
          parts: [{ type: "text", text: "still streaming" }],
        },
      ]),
    ).toEqual([{ id: "user-1", prompt: "Fix checkout", response: "Fixed checkout." }]);
  });

  it("joins a tool-using OpenCode turn through its terminal assistant message", () => {
    expect(
      parseOpenCodeNativeTurns([
        {
          info: { id: "user-1", role: "user" },
          parts: [{ type: "text", text: "Run the suite" }],
        },
        {
          info: {
            id: "assistant-1",
            role: "assistant",
            parentID: "user-1",
            finish: "tool-calls",
            time: { completed: 2 },
          },
          parts: [{ type: "text", text: "I’ll inspect the change." }],
        },
        {
          info: {
            id: "assistant-2",
            role: "assistant",
            parentID: "user-1",
            finish: "stop",
            time: { completed: 3 },
          },
          parts: [{ type: "tool", tool: "bash", state: { status: "completed" } }],
        },
        {
          info: {
            id: "assistant-3",
            role: "assistant",
            parentID: "user-1",
            finish: "stop",
            time: { completed: 4 },
          },
          parts: [{ type: "text", text: "All tests pass.\n\nOPEN_DONE" }],
        },
      ]),
    ).toEqual([
      {
        id: "user-1",
        prompt: "Run the suite",
        response: "I’ll inspect the change.\n\nAll tests pass.\n\nOPEN_DONE",
      },
    ]);
  });

  it("does not import turns hidden by native OpenCode undo", () => {
    const messages = [
      { info: { id: "user-1", role: "user" }, parts: [{ type: "text", text: "Keep" }] },
      {
        info: { id: "assistant-1", role: "assistant", time: { completed: 2 } },
        parts: [{ type: "text", text: "Kept." }],
      },
      { info: { id: "user-2", role: "user" }, parts: [{ type: "text", text: "Undo" }] },
      {
        info: { id: "assistant-2", role: "assistant", time: { completed: 4 } },
        parts: [{ type: "text", text: "Undone." }],
      },
    ];
    expect(parseOpenCodeNativeTurns(messages, "user-2")).toEqual([
      { id: "user-1", prompt: "Keep", response: "Kept." },
    ]);
  });

  it("recovers detached history through a short-lived pure server", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relay-opencode-read-recovery-"));
    const marker = join(directory, "attempts");
    const previousMarker = Bun.env.RELAY_TEST_RECOVERY_FILE;
    Bun.env.RELAY_TEST_RECOVERY_FILE = marker;
    const backend = await OpenCodeNativeBackend.start(executable, process.cwd());
    try {
      await expect(backend.read("ses_recover")).resolves.toEqual({
        turns: [],
        hiddenTurnIds: [],
      });
    } finally {
      await backend.close();
      if (previousMarker === undefined) delete Bun.env.RELAY_TEST_RECOVERY_FILE;
      else Bun.env.RELAY_TEST_RECOVERY_FILE = previousMarker;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves a missing session after detached-history recovery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relay-opencode-read-missing-"));
    const marker = join(directory, "attempts");
    const previousMarker = Bun.env.RELAY_TEST_RECOVERY_FILE;
    Bun.env.RELAY_TEST_RECOVERY_FILE = marker;
    const backend = await OpenCodeNativeBackend.start(executable, process.cwd());
    try {
      await expect(backend.read("ses_missing")).rejects.toMatchObject({
        name: "NativeSessionUnavailable",
        harness: "opencode",
        sessionId: "ses_missing",
      });
    } finally {
      await backend.close();
      if (previousMarker === undefined) delete Bun.env.RELAY_TEST_RECOVERY_FILE;
      else Bun.env.RELAY_TEST_RECOVERY_FILE = previousMarker;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("creates authenticated sessions and returns the native attach command", async () => {
    const backend = await OpenCodeNativeBackend.start(executable, process.cwd());
    try {
      const coldCommand = backend.command();
      expect(coldCommand.args).toContain("attach");
      expect(coldCommand.args).not.toContain("--session");
      expect(await backend.resolveSession()).toBeUndefined();

      const sessionId = await backend.ensureSession({ title: "Relay task" });
      expect(sessionId).toBe("ses_created");
      const command = backend.command(sessionId);
      expect(command.args).toContain("attach");
      expect(command.args).toContain("--session");
      expect(command.args).toContain(sessionId);
      expect(command.args).not.toContain(command.env?.OPENCODE_SERVER_PASSWORD);
      expect(command.env?.OPENCODE_SERVER_PASSWORD).toBeTruthy();
      expect(await backend.isIdle(sessionId)).toBe(true);
      expect(await backend.resolveSession(sessionId)).toBe(sessionId);
      await expect(backend.read("ses_retry")).resolves.toEqual({
        turns: [],
        hiddenTurnIds: [],
      });
      await expect(backend.read("ses_paged")).resolves.toEqual({
        turns: [
          { id: "page-user-1", prompt: "older prompt", response: "older response" },
          { id: "page-user-2", prompt: "newer prompt", response: "newer response" },
        ],
        hiddenTurnIds: [],
      });
      await backend.inject(
        sessionId,
        [
          {
            id: "message-1",
            seq: 1,
            role: "user",
            content: "Inspect checkout",
            harness: "codex",
            createdAt: "2026-07-13T00:00:00.000Z",
          },
        ],
        7,
      );

      const baseUrl = command.args[1]!;
      const headers = {
        authorization: `Basic ${Buffer.from(`opencode:${command.env?.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`,
        "content-type": "application/json",
      };
      const nativeSession = await fetch(new URL(`/session?directory=${process.cwd()}`, baseUrl), {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });
      expect(nativeSession.ok).toBe(true);
      const created = (await nativeSession.json()) as { id: string };
      await Bun.sleep(10);
      expect(await backend.resolveSession()).toBe(created.id);

      const childSession = await fetch(new URL(`/session?directory=${process.cwd()}`, baseUrl), {
        method: "POST",
        headers,
        body: JSON.stringify({ parentID: created.id }),
      });
      expect(childSession.ok).toBe(true);
      await Bun.sleep(10);
      expect(await backend.resolveSession(sessionId)).toBe(created.id);

      const messageIdOnlyEvent = await fetch(new URL("/test/message-id-event", baseUrl), {
        method: "POST",
        headers,
      });
      expect(messageIdOnlyEvent.ok).toBe(true);
      await Bun.sleep(10);
      expect(await backend.resolveSession(sessionId)).toBe(created.id);

      const messageOnlyEvent = await fetch(new URL("/test/message-event", baseUrl), {
        method: "POST",
        headers,
      });
      expect(messageOnlyEvent.ok).toBe(true);
      await Bun.sleep(10);
      expect(await backend.resolveSession(sessionId)).toBe(created.id);

      const closeEvents = await fetch(new URL("/test/close-events", baseUrl), {
        method: "POST",
        headers,
      });
      expect(closeEvents.ok).toBe(true);
      const missedDuringGap = await fetch(new URL(`/session?directory=${process.cwd()}`, baseUrl), {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });
      expect(missedDuringGap.ok).toBe(true);
      await Bun.sleep(150);
      await expect(backend.resolveSession(sessionId, true)).rejects.toThrow("reconnecting");
      const afterReconnect = await fetch(new URL(`/session?directory=${process.cwd()}`, baseUrl), {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });
      const reconnectedSession = (await afterReconnect.json()) as { id: string };
      await Bun.sleep(50);
      expect(await backend.resolveSession(sessionId, true)).toBe(reconnectedSession.id);

      const closeAgain = await fetch(new URL("/test/close-events", baseUrl), {
        method: "POST",
        headers,
      });
      expect(closeAgain.ok).toBe(true);
      await Bun.sleep(250);
      const afterSecondReconnect = await fetch(
        new URL(`/session?directory=${process.cwd()}`, baseUrl),
        {
          method: "POST",
          headers,
          body: JSON.stringify({}),
        },
      );
      const secondReconnectedSession = (await afterSecondReconnect.json()) as { id: string };
      await Bun.sleep(50);
      expect(await backend.resolveSession(sessionId, true)).toBe(secondReconnectedSession.id);
    } finally {
      await backend.close();
    }
  });
});
