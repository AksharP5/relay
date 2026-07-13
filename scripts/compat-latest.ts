#!/usr/bin/env bun

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexNativeBackend } from "../src/native/codex-backend.ts";
import { startOpenCodeServer } from "../src/harnesses/opencode-server.ts";

const run = async (command: string, args: ReadonlyArray<string>) => {
  const child = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${command} ${args.join(" ")} failed\n${stderr}`.trim());
  return `${stdout}\n${stderr}`.trim();
};

const requireText = (value: string, expected: ReadonlyArray<string>, label: string) => {
  for (const item of expected) {
    if (!value.includes(item)) throw new Error(`${label} is missing ${item}`);
  }
};

const artifacts = Bun.env.RELAY_COMPAT_ARTIFACTS
  ? Bun.env.RELAY_COMPAT_ARTIFACTS
  : await mkdtemp(join(tmpdir(), "relay-compat-"));
await mkdir(artifacts, { recursive: true });

const codex = Bun.which("codex");
const opencode = Bun.which("opencode");
if (!codex || !opencode) throw new Error("Install the latest Codex and OpenCode before checking");

const codexVersion = await run(codex, ["--version"]);
const openCodeVersion = await run(opencode, ["--version"]);
console.log(`Codex: ${codexVersion}`);
console.log(`OpenCode: ${openCodeVersion}`);

const codexHelp = await run(codex, ["--help"]);
const codexResumeHelp = await run(codex, ["resume", "--help"]);
const codexServerHelp = await run(codex, ["app-server", "--help"]);
requireText(codexHelp, ["--remote", "--remote-auth-token-env"], "Codex help");
requireText(
  codexResumeHelp,
  ["--remote", "--remote-auth-token-env", "--model"],
  "Codex resume help",
);
requireText(codexServerHelp, ["--listen", "--ws-auth", "--ws-token-file"], "Codex app-server help");

const modelCatalog = JSON.parse(await run(codex, ["debug", "models", "--bundled"])) as {
  models?: unknown;
};
if (!Array.isArray(modelCatalog.models)) throw new Error("Codex bundled model catalog changed");

const schemaDirectory = join(artifacts, "codex-schema");
await run(codex, [
  "app-server",
  "generate-json-schema",
  "--experimental",
  "--out",
  schemaDirectory,
]);
const schemaFiles = Array.from(
  new Bun.Glob("**/*.json").scanSync({ cwd: schemaDirectory, absolute: true }),
);
const schemas = (await Promise.all(schemaFiles.map((path) => Bun.file(path).text()))).join("\n");
requireText(
  schemas,
  [
    "thread/start",
    "thread/resume",
    "thread/read",
    "thread/delete",
    "thread/inject_items",
    "thread/loaded/list",
    "thread/list",
  ],
  "Codex app-server schema",
);

const codexBackend = await CodexNativeBackend.start(codex, process.cwd());
let codexSessionId: string | undefined;
try {
  const empty = await codexBackend.prepareSession({ handoff: [] });
  if (empty.sessionId || codexBackend.command().args.includes("resume")) {
    throw new Error("Codex cold startup tried to resume an empty thread");
  }
  const prepared = await codexBackend.prepareSession({
    handoff: [
      {
        id: "compat-user",
        seq: 1,
        role: "user",
        content: "Relay compatibility context",
        harness: "opencode",
        createdAt: new Date().toISOString(),
      },
    ],
  });
  if (!prepared.sessionId || !prepared.handoffInjected) {
    throw new Error("Codex cold handoff did not materialize on its starting connection");
  }
  codexSessionId = prepared.sessionId;
} finally {
  await codexBackend.close();
}

if (!codexSessionId) throw new Error("Codex compatibility session was not created");
const resumedCodex = await CodexNativeBackend.start(codex, process.cwd());
try {
  if ((await resumedCodex.ensureSession({ sessionId: codexSessionId })) !== codexSessionId) {
    throw new Error("Codex changed the resumed session id");
  }
  await resumedCodex.read(codexSessionId);
  await resumedCodex.delete(codexSessionId);
} finally {
  await resumedCodex.close();
}

const openCodeHelp = await run(opencode, ["--help"]);
const openCodeServeHelp = await run(opencode, ["serve", "--help"]);
const openCodeAttachHelp = await run(opencode, ["attach", "--help"]);
requireText(
  openCodeHelp,
  ["opencode attach", "opencode serve", "opencode models"],
  "OpenCode help",
);
requireText(openCodeServeHelp, ["--hostname", "--port"], "OpenCode serve help");
requireText(openCodeAttachHelp, ["--dir", "--session", "--password"], "OpenCode attach help");

const server = await startOpenCodeServer(opencode, process.cwd());
try {
  const url = (path: string) => {
    const value = new URL(path, server.baseUrl);
    value.searchParams.set("directory", process.cwd());
    return value;
  };
  const headers = { authorization: server.authorization, "content-type": "application/json" };
  const health = await fetch(url("/global/health"), { headers });
  if (!health.ok) throw new Error(`OpenCode health failed with HTTP ${health.status}`);
  const document = await fetch(url("/doc"), { headers });
  if (!document.ok) throw new Error(`OpenCode schema failed with HTTP ${document.status}`);
  const openApi = JSON.stringify(await document.json());
  requireText(
    openApi,
    ["/session", "/session/status", "/session/{sessionID}", "/session/{sessionID}/message"],
    "OpenCode schema",
  );

  const created = await fetch(url("/session"), {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "Relay compatibility probe" }),
  });
  if (!created.ok) throw new Error(`OpenCode create failed with HTTP ${created.status}`);
  const session = (await created.json()) as { id?: unknown };
  if (typeof session.id !== "string") throw new Error("OpenCode did not return a session id");
  const sessionId = session.id;

  const injected = await fetch(url(`/session/${encodeURIComponent(sessionId)}/message`), {
    method: "POST",
    headers,
    body: JSON.stringify({
      noReply: true,
      parts: [{ type: "text", text: "Relay compatibility context", synthetic: true }],
    }),
  });
  if (!injected.ok) throw new Error(`OpenCode injection failed with HTTP ${injected.status}`);
  await injected.body?.cancel();
  for (const path of [
    `/session/${encodeURIComponent(sessionId)}`,
    `/session/${encodeURIComponent(sessionId)}/message`,
    "/session/status",
    "/session",
  ]) {
    const response = await fetch(url(path), { headers });
    if (!response.ok) throw new Error(`OpenCode GET ${path} failed with HTTP ${response.status}`);
    await response.body?.cancel();
  }
  const deleted = await fetch(url(`/session/${encodeURIComponent(sessionId)}`), {
    method: "DELETE",
    headers,
  });
  if (!deleted.ok) throw new Error(`OpenCode delete failed with HTTP ${deleted.status}`);
  await deleted.body?.cancel();
} finally {
  await server.close();
}

console.log("Latest native compatibility contract passed");
if (!Bun.env.RELAY_COMPAT_ARTIFACTS) await rm(artifacts, { recursive: true, force: true });
