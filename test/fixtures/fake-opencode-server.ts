#!/usr/bin/env bun

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
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
    if (url.pathname.endsWith("/message")) {
      return Response.json([
        { info: { role: "assistant", providerID: "openai", modelID: "gpt-5.6-sol" }, parts: [] },
      ]);
    }
    if (url.pathname.endsWith("/summarize") && request.method === "POST")
      return Response.json(true);
    if (url.pathname.endsWith("/share") && request.method === "POST")
      return Response.json({ share: { url: "https://opncd.ai/s/test" } });
    if (url.pathname.endsWith("/share") && request.method === "DELETE")
      return Response.json({ share: null });
    return new Response("not found", { status: 404 });
  },
});

process.stdout.write(`opencode server listening on ${server.url.origin}\n`);
await new Promise(() => undefined);
