#!/usr/bin/env bun

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/command") return new Response("not found", { status: 404 });
    return Response.json([
      { name: "commit", description: "Create a conventional commit", source: "command" },
      { name: "skill-command", source: "skill" },
    ]);
  },
});

process.stdout.write(`opencode server listening on ${server.url.origin}\n`);
await new Promise(() => undefined);
