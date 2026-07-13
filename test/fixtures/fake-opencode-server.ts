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
    if (/\/session\/[^/]+$/.test(url.pathname)) {
      return Response.json({
        ...(revertMessageID ? { revert: { messageID: revertMessageID } } : {}),
      });
    }
    if (url.pathname.endsWith("/message")) {
      return Response.json([
        { info: { id: "msg_001", role: "user" }, parts: [] },
        {
          info: { id: "msg_002", role: "assistant", providerID: "openai", modelID: "gpt-5.6-sol" },
          parts: [],
        },
        { info: { id: "msg_003", role: "user" }, parts: [] },
        {
          info: { id: "msg_004", role: "assistant", providerID: "openai", modelID: "gpt-5.6-sol" },
          parts: [],
        },
      ]);
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
