import type { HarnessCommand } from "../domain.ts";
import { readStream } from "../services/process-runner.ts";

interface OpenCodeCommand {
  readonly name?: unknown;
  readonly description?: unknown;
}

const stopChild = async (child: ReturnType<typeof Bun.spawn>) => {
  if (child.exitCode !== null) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  } else {
    child.kill("SIGTERM");
  }
  await Promise.race([child.exited, Bun.sleep(1_000)]);
  if (child.exitCode === null) {
    if (process.platform !== "win32") {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    } else {
      child.kill("SIGKILL");
    }
    await child.exited.catch(() => undefined);
  }
};

export const discoverOpenCodeCommands = async (
  executable: string,
  cwd: string,
): Promise<ReadonlyArray<HarnessCommand>> => {
  const password = crypto.randomUUID();
  const child = Bun.spawn([executable, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd,
    env: { ...Bun.env, OPENCODE_SERVER_PASSWORD: password },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: process.platform !== "win32",
  });
  if (!(child.stdout instanceof ReadableStream) || !(child.stderr instanceof ReadableStream)) {
    await stopChild(child);
    throw new Error("OpenCode server output pipes are unavailable");
  }

  let resolveUrl: (value: string) => void;
  let rejectUrl: (cause: Error) => void;
  const url = new Promise<string>((resolve, reject) => {
    resolveUrl = resolve;
    rejectUrl = reject;
  });
  const inspectLine = (line: string) => {
    const match = line.match(/opencode server listening on (http:\/\/\S+)/i);
    if (match?.[1]) resolveUrl(match[1]);
  };
  void readStream(child.stdout, { onLine: inspectLine, lineLimit: 128_000 }).catch(rejectUrl!);
  void readStream(child.stderr, { onLine: inspectLine, lineLimit: 128_000 }).catch(rejectUrl!);
  void child.exited.then((code) =>
    rejectUrl!(new Error(`OpenCode server exited with code ${code}`)),
  );

  try {
    const baseUrl = await Promise.race([
      url,
      Bun.sleep(15_000).then(() => {
        throw new Error("Timed out starting the OpenCode command server");
      }),
    ]);
    const endpoint = new URL("/command", baseUrl);
    endpoint.searchParams.set("directory", cwd);
    const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
    const response = await fetch(endpoint, { headers: { authorization } });
    if (!response.ok)
      throw new Error(`OpenCode command discovery failed with HTTP ${response.status}`);
    const commands = (await response.json()) as Array<OpenCodeCommand>;
    return commands.flatMap((command) =>
      typeof command.name === "string"
        ? [
            {
              name: command.name,
              description:
                typeof command.description === "string"
                  ? command.description
                  : `Run OpenCode /${command.name}`,
              source: "native" as const,
              acceptsArguments: true,
            },
          ]
        : [],
    );
  } finally {
    await stopChild(child);
  }
};

export const runOpenCodeControl = async (
  executable: string,
  input: {
    readonly cwd: string;
    readonly sessionId: string;
    readonly action: "compact" | "share" | "unshare" | "undo" | "redo";
    readonly model?: string;
  },
) => {
  const password = crypto.randomUUID();
  const child = Bun.spawn([executable, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: input.cwd,
    env: { ...Bun.env, OPENCODE_SERVER_PASSWORD: password },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: process.platform !== "win32",
  });
  if (!(child.stdout instanceof ReadableStream) || !(child.stderr instanceof ReadableStream)) {
    await stopChild(child);
    throw new Error("OpenCode server output pipes are unavailable");
  }

  let resolveUrl: (value: string) => void;
  let rejectUrl: (cause: Error) => void;
  const serverUrl = new Promise<string>((resolve, reject) => {
    resolveUrl = resolve;
    rejectUrl = reject;
  });
  const inspectLine = (line: string) => {
    const match = line.match(/opencode server listening on (http:\/\/\S+)/i);
    if (match?.[1]) resolveUrl(match[1]);
  };
  void readStream(child.stdout, { onLine: inspectLine, lineLimit: 128_000 }).catch(rejectUrl!);
  void readStream(child.stderr, { onLine: inspectLine, lineLimit: 128_000 }).catch(rejectUrl!);
  void child.exited.then((code) =>
    rejectUrl!(new Error(`OpenCode server exited with code ${code}`)),
  );

  try {
    const baseUrl = await Promise.race([
      serverUrl,
      Bun.sleep(15_000).then(() => {
        throw new Error("Timed out starting OpenCode");
      }),
    ]);
    const headers = {
      authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
      "content-type": "application/json",
    };
    let body: string | undefined;
    if (input.action === "compact") {
      let model = input.model;
      if (!model) {
        const messagesUrl = new URL(
          `/session/${encodeURIComponent(input.sessionId)}/message`,
          baseUrl,
        );
        messagesUrl.searchParams.set("directory", input.cwd);
        const messagesResponse = await fetch(messagesUrl, { headers });
        if (messagesResponse.ok) {
          const messages = (await messagesResponse.json()) as Array<{
            info?: { role?: unknown; providerID?: unknown; modelID?: unknown };
          }>;
          const latest = messages.findLast(
            (item) =>
              typeof item.info?.providerID === "string" && typeof item.info?.modelID === "string",
          );
          if (latest?.info) model = `${latest.info.providerID}/${latest.info.modelID}`;
        }
      }
      const [providerID, ...modelParts] = model?.split("/") ?? [];
      const modelID = modelParts.join("/");
      if (!providerID || !modelID) throw new Error("Choose an OpenCode model before compacting");
      body = JSON.stringify({ providerID, modelID });
    }
    let path = input.action === "compact" ? "summarize" : "share";
    if (input.action === "undo" || input.action === "redo") {
      const sessionUrl = new URL(`/session/${encodeURIComponent(input.sessionId)}`, baseUrl);
      sessionUrl.searchParams.set("directory", input.cwd);
      const messagesUrl = new URL(
        `/session/${encodeURIComponent(input.sessionId)}/message`,
        baseUrl,
      );
      messagesUrl.searchParams.set("directory", input.cwd);
      const [sessionResponse, messagesResponse] = await Promise.all([
        fetch(sessionUrl, { headers }),
        fetch(messagesUrl, { headers }),
      ]);
      if (!sessionResponse.ok || !messagesResponse.ok)
        throw new Error("Could not read the OpenCode undo state");
      const session = (await sessionResponse.json()) as { revert?: { messageID?: unknown } };
      const messages = (await messagesResponse.json()) as Array<{
        info?: { id?: unknown; role?: unknown };
      }>;
      const users = messages
        .map((item) => item.info)
        .filter(
          (info): info is { id: string; role?: unknown } =>
            typeof info?.id === "string" && info.role === "user",
        );
      const current =
        typeof session.revert?.messageID === "string" ? session.revert.messageID : undefined;
      if (input.action === "undo") {
        const target = users.findLast((message) => !current || message.id < current);
        if (!target) throw new Error("There is no OpenCode turn to undo");
        path = "revert";
        body = JSON.stringify({ messageID: target.id });
      } else {
        if (!current) throw new Error("There is no OpenCode turn to redo");
        const target = users.find((message) => message.id > current);
        path = target ? "revert" : "unrevert";
        if (target) body = JSON.stringify({ messageID: target.id });
      }
    }
    const endpoint = new URL(`/session/${encodeURIComponent(input.sessionId)}/${path}`, baseUrl);
    endpoint.searchParams.set("directory", input.cwd);
    const response = await fetch(endpoint, {
      method: input.action === "unshare" ? "DELETE" : "POST",
      headers,
      ...(body ? { body } : {}),
    });
    if (!response.ok) {
      throw new Error(`OpenCode ${input.action} failed with HTTP ${response.status}`);
    }
    if (input.action === "share") {
      const session = (await response.json()) as { share?: { url?: unknown } };
      return typeof session.share?.url === "string"
        ? `OpenCode shared this session: ${session.share.url}`
        : "OpenCode shared this session.";
    }
    if (input.action === "undo") return "OpenCode undid the previous turn and file changes.";
    if (input.action === "redo") return "OpenCode restored the previously undone turn.";
    return input.action === "compact"
      ? "OpenCode compacted its native context."
      : "OpenCode stopped sharing this session.";
  } finally {
    await stopChild(child);
  }
};

export const runOpenCodeCommand = async (
  executable: string,
  input: {
    readonly cwd: string;
    readonly command: string;
    readonly arguments: string;
    readonly handoffText?: string;
    readonly sessionId?: string;
    readonly model?: string;
  },
) => {
  const password = crypto.randomUUID();
  const child = Bun.spawn([executable, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: input.cwd,
    env: { ...Bun.env, OPENCODE_SERVER_PASSWORD: password },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: process.platform !== "win32",
  });
  if (!(child.stdout instanceof ReadableStream) || !(child.stderr instanceof ReadableStream)) {
    await stopChild(child);
    throw new Error("OpenCode server output pipes are unavailable");
  }
  let resolveUrl: (value: string) => void;
  let rejectUrl: (cause: Error) => void;
  const serverUrl = new Promise<string>((resolve, reject) => {
    resolveUrl = resolve;
    rejectUrl = reject;
  });
  const inspectLine = (line: string) => {
    const match = line.match(/opencode server listening on (http:\/\/\S+)/i);
    if (match?.[1]) resolveUrl(match[1]);
  };
  void readStream(child.stdout, { onLine: inspectLine, lineLimit: 128_000 }).catch(rejectUrl!);
  void readStream(child.stderr, { onLine: inspectLine, lineLimit: 128_000 }).catch(rejectUrl!);
  void child.exited.then((code) =>
    rejectUrl!(new Error(`OpenCode server exited with code ${code}`)),
  );

  try {
    const baseUrl = await Promise.race([
      serverUrl,
      Bun.sleep(15_000).then(() => {
        throw new Error("Timed out starting OpenCode");
      }),
    ]);
    const headers = {
      authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
      "content-type": "application/json",
    };
    let sessionId = input.sessionId;
    if (!sessionId) {
      const createUrl = new URL("/session", baseUrl);
      createUrl.searchParams.set("directory", input.cwd);
      const createResponse = await fetch(createUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ title: "Relay task" }),
      });
      if (!createResponse.ok)
        throw new Error(`OpenCode session creation failed with HTTP ${createResponse.status}`);
      const session = (await createResponse.json()) as { id?: unknown };
      if (typeof session.id !== "string") throw new Error("OpenCode did not return a session id");
      sessionId = session.id;
    }
    if (input.handoffText) {
      const handoffUrl = new URL(`/session/${encodeURIComponent(sessionId)}/message`, baseUrl);
      handoffUrl.searchParams.set("directory", input.cwd);
      const handoffResponse = await fetch(handoffUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          noReply: true,
          parts: [{ type: "text", text: input.handoffText }],
        }),
      });
      if (!handoffResponse.ok)
        throw new Error(`OpenCode handoff failed with HTTP ${handoffResponse.status}`);
    }
    const commandUrl = new URL(`/session/${encodeURIComponent(sessionId)}/command`, baseUrl);
    commandUrl.searchParams.set("directory", input.cwd);
    const commandResponse = await fetch(commandUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        command: input.command,
        arguments: input.arguments,
        ...(input.model ? { model: input.model } : {}),
      }),
    });
    if (!commandResponse.ok)
      throw new Error(`OpenCode /${input.command} failed with HTTP ${commandResponse.status}`);
    const message = (await commandResponse.json()) as {
      parts?: Array<{ type?: unknown; text?: unknown }>;
    };
    const text = (message.parts ?? [])
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("")
      .trim();
    if (!text) throw new Error(`OpenCode /${input.command} completed without a text response`);
    return { sessionId, text };
  } finally {
    await stopChild(child);
  }
};
