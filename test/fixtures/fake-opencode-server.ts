#!/usr/bin/env bun

let revertMessageID: string | undefined = "msg_003";

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const expected = `Basic ${Buffer.from(`opencode:${Bun.env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`;
    if (request.headers.get("authorization") !== expected)
      return new Response("unauthorized", { status: 401 });
    if (url.pathname === "/command") {
      return Response.json([
        { name: "commit", description: "Create a conventional commit", source: "command" },
        { name: "skill-command", source: "skill" },
      ]);
    }
    if (url.pathname === "/session" && request.method === "POST") {
      return Response.json({ id: "ses_created" });
    }
    if (url.pathname === "/session" && request.method === "GET") {
      return Response.json([{ id: "ses_created", time: { created: 1, updated: 2 } }]);
    }
    if (url.pathname === "/session/status" && request.method === "GET") {
      return Response.json({});
    }
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
      return Response.json([
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
      ]);
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
