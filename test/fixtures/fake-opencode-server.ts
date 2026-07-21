#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "node:fs";

let revertMessageID: string | undefined = "msg_003";
let createdSessions = 0;
let latestSessionId = "ses_created";
let retryHistoryAttempts = 0;
const fakeMessages = [
  { info: { id: "msg_001", role: "user" }, parts: [{ type: "text", text: "first" }] },
  {
    info: { id: "msg_002", role: "assistant", providerID: "openai", modelID: "gpt-5.6-sol" },
    parts: [],
  },
  { info: { id: "msg_003", role: "user" }, parts: [{ type: "text", text: "second" }] },
  {
    info: { id: "msg_004", role: "assistant", providerID: "openai", modelID: "gpt-5.6-sol" },
    parts: [],
  },
];
const recoveryFile = Bun.env.RELAY_TEST_RECOVERY_FILE;
const recoveryAttempts = () => {
  if (!recoveryFile) return 0;
  try {
    return Number(readFileSync(recoveryFile, "utf8"));
  } catch {
    return 0;
  }
};
if (Bun.argv[2] === "serve" && recoveryAttempts() >= 4 && !Bun.argv.includes("--pure")) {
  process.stderr.write("expected pure recovery server\n");
  process.exit(2);
}
const eventControllers = new Set<ReadableStreamDefaultController<Uint8Array>>();
const encoder = new TextEncoder();
const emitEvent = (event: unknown) => {
  const data = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
  for (const controller of eventControllers) controller.enqueue(data);
};

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const expected = `Basic ${Buffer.from(`opencode:${Bun.env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`;
    if (request.headers.get("authorization") !== expected)
      return new Response("unauthorized", { status: 401 });
    if (url.pathname === "/command") {
      if (Bun.env.RELAY_TEST_OPENCODE_INVALID_COMMANDS === "1") return Response.json(null);
      if (Bun.env.RELAY_TEST_OPENCODE_INVALID_COMMANDS === "field")
        return Response.json([{ name: 42 }]);
      return Response.json([
        { name: "commit", description: "Create a conventional commit", source: "command" },
        { name: "skill-command", source: "skill" },
      ]);
    }
    if (url.pathname === "/event") {
      let eventController: ReadableStreamDefaultController<Uint8Array> | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          eventController = controller;
          eventControllers.add(controller);
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`,
            ),
          );
        },
        cancel() {
          if (eventController) eventControllers.delete(eventController);
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }
    if (url.pathname === "/test/close-events" && request.method === "POST") {
      for (const controller of eventControllers) controller.close();
      eventControllers.clear();
      return Response.json(true);
    }
    if (url.pathname === "/test/message-event" && request.method === "POST") {
      emitEvent({
        type: "message.updated",
        properties: {
          sessionID: latestSessionId,
          info: {
            id: "msg_not_a_session",
            sessionID: latestSessionId,
            parentID: "ses_wrong_message_parent",
            role: "assistant",
          },
        },
      });
      return Response.json(true);
    }
    if (url.pathname === "/test/message-id-event" && request.method === "POST") {
      emitEvent({
        type: "message.updated",
        properties: { info: { id: "msg_not_a_session", role: "assistant" } },
      });
      return Response.json(true);
    }
    if (url.pathname === "/session" && request.method === "POST") {
      createdSessions += 1;
      const body = (await request.json()) as { parentID?: unknown; title?: unknown };
      if (body.title === "invalid-shape") return Response.json(null);
      if (body.title === "invalid-fields") return Response.json({ id: 42 });
      const id = createdSessions === 1 ? "ses_created" : `ses_native_${createdSessions}`;
      latestSessionId = id;
      emitEvent({
        type: "session.created",
        properties: {
          sessionID: id,
          info: {
            id,
            ...(typeof body.parentID === "string" ? { parentID: body.parentID } : {}),
          },
        },
      });
      return Response.json({ id });
    }
    if (url.pathname === "/session" && request.method === "GET") {
      return Response.json([
        { id: "ses_created", time: { created: 1, updated: 2 } },
        { id: "unrelated_newer", time: { created: 3, updated: 9_999 } },
      ]);
    }
    if (url.pathname === "/session/status" && request.method === "GET") {
      return Response.json({
        ses_busy: { type: "busy" },
        ses_retrying: { type: "retry" },
        ses_unknown: { type: "paused" },
      });
    }
    if (url.pathname.endsWith("/ses_paged") && request.method === "GET") return Response.json({});
    if (url.pathname.endsWith("/ses_grouped_undo") && request.method === "GET")
      return Response.json({ revert: { messageID: "undo-user-2" } });
    if (url.pathname.endsWith("/ses_invalid_session") && request.method === "GET")
      return Response.json(null);
    if (url.pathname.endsWith("/ses_invalid_session_fields") && request.method === "GET")
      return Response.json({ directory: 42 });
    if (
      url.pathname.includes("/ses_missing") &&
      request.method === "GET" &&
      recoveryAttempts() >= 4
    )
      return new Response("missing", { status: 404 });
    if (/\/session\/[^/]+$/.test(url.pathname) && request.method === "GET") {
      return Response.json({
        ...(revertMessageID ? { revert: { messageID: revertMessageID } } : {}),
      });
    }
    if (url.pathname.endsWith("/message") && request.method === "POST") {
      const body = (await request.json()) as {
        noReply?: unknown;
        parts?: Array<{ type?: unknown; text?: unknown; synthetic?: unknown }>;
      };
      const part = body.parts?.[0];
      if (
        body.noReply !== true ||
        part?.type !== "text" ||
        part.synthetic !== true ||
        typeof part.text !== "string" ||
        !part.text.includes('<relay_handoff version="1">') ||
        !part.text.includes("7 older messages")
      ) {
        return new Response("invalid hidden handoff", { status: 400 });
      }
      return Response.json({ info: { id: "hidden", role: "user" }, parts: body.parts });
    }
    if (url.pathname.endsWith("/message") && request.method === "GET") {
      if (url.pathname.includes("/ses_invalid_history/")) return Response.json(null);
      if (url.pathname.includes("/ses_invalid_history_fields/"))
        return Response.json([{ info: { id: 42, role: "user" } }]);
      if (url.pathname.includes("/ses_grouped_undo/")) {
        return Response.json([
          {
            info: { id: "undo-user-1", role: "user" },
            parts: [{ type: "text", text: "Keep this turn" }],
          },
          {
            info: {
              id: "undo-assistant-1a",
              role: "assistant",
              parentID: "undo-user-1",
              finish: "tool-calls",
              time: { completed: 2 },
            },
            parts: [{ type: "text", text: "Checking first." }],
          },
          {
            info: {
              id: "undo-assistant-1b",
              role: "assistant",
              parentID: "undo-user-1",
              finish: "stop",
              time: { completed: 3 },
            },
            parts: [{ type: "text", text: "Kept response." }],
          },
          {
            info: { id: "undo-user-2", role: "user" },
            parts: [{ type: "text", text: "Hide this turn" }],
          },
          {
            info: {
              id: "undo-assistant-2a",
              role: "assistant",
              parentID: "undo-user-2",
              finish: "tool-calls",
              time: { completed: 5 },
            },
            parts: [{ type: "text", text: "Hidden partial." }],
          },
          {
            info: {
              id: "undo-assistant-2b",
              role: "assistant",
              parentID: "undo-user-2",
              finish: "stop",
              time: { completed: 6 },
            },
            parts: [{ type: "text", text: "Hidden response." }],
          },
        ]);
      }
      if (url.pathname.includes("/ses_paged/")) {
        if (url.searchParams.get("limit") !== "20")
          return new Response("expected bounded page", { status: 400 });
        const older = [
          {
            info: { id: "page-user-1", role: "user" },
            parts: [{ type: "text", text: "older prompt" }],
          },
          {
            info: { id: "page-assistant-1", role: "assistant", time: { completed: 2 } },
            parts: [{ type: "text", text: "older response" }],
          },
        ];
        if (url.searchParams.get("before") === "older-page") return Response.json(older);
        return Response.json(
          [
            {
              info: { id: "page-user-2", role: "user" },
              parts: [{ type: "text", text: "newer prompt" }],
            },
            {
              info: { id: "page-assistant-2", role: "assistant", time: { completed: 4 } },
              parts: [
                { type: "tool", text: "ignored tool payload" },
                { type: "text", text: "newer response" },
              ],
            },
          ],
          { headers: { "x-next-cursor": "older-page" } },
        );
      }
      if (url.pathname.includes("/ses_retry/") && retryHistoryAttempts++ === 0)
        return new Response("transient", { status: 503 });
      if (
        (url.pathname.includes("/ses_recover/") || url.pathname.includes("/ses_missing/")) &&
        recoveryFile
      ) {
        const attempts = recoveryAttempts();
        writeFileSync(recoveryFile, String(attempts + 1));
        if (attempts < 4) return new Response("stuck attached server", { status: 503 });
      }
      return Response.json(fakeMessages);
    }
    if (url.pathname.endsWith("/command") && request.method === "POST") {
      const body = (await request.json()) as { command?: unknown; arguments?: unknown };
      if (
        body.command !== "commit" ||
        typeof body.arguments !== "string" ||
        !body.arguments.includes("prior Relay conversation") ||
        !body.arguments.includes("<relay_current_request>\nrelease-ready")
      ) {
        return new Response("command ran before its handoff", { status: 409 });
      }
      if (Bun.env.RELAY_TEST_OPENCODE_INVALID_RESPONSE === "1") return Response.json(null);
      if (Bun.env.RELAY_TEST_OPENCODE_INVALID_RESPONSE === "field")
        return Response.json({ parts: [{ type: "text", text: 42 }] });
      return Response.json({ parts: [{ type: "text", text: "Command response" }] });
    }
    if (url.pathname.endsWith("/summarize") && request.method === "POST")
      return Response.json(true);
    if (url.pathname.endsWith("/share") && request.method === "POST")
      return Response.json({ share: { url: "https://opncd.ai/s/test" } });
    if (url.pathname.endsWith("/share") && request.method === "DELETE")
      return Response.json({ share: null });
    if (url.pathname.endsWith("/revert") && request.method === "POST") {
      const body = (await request.json()) as { messageID: string };
      revertMessageID = body.messageID;
      return Response.json({ revert: { messageID: revertMessageID } });
    }
    if (url.pathname.endsWith("/unrevert") && request.method === "POST") {
      revertMessageID = undefined;
      return Response.json({});
    }
    return new Response("not found", { status: 404 });
  },
});

process.stdout.write(`opencode server listening on ${server.url.origin}\n`);
await new Promise(() => undefined);
