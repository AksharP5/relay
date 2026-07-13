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
    readonly action: "compact" | "share" | "unshare";
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
    const endpoint = new URL(
      `/session/${encodeURIComponent(input.sessionId)}/${
        input.action === "compact" ? "summarize" : "share"
      }`,
      baseUrl,
    );
    endpoint.searchParams.set("directory", input.cwd);
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
    return input.action === "compact"
      ? "OpenCode compacted its native context."
      : "OpenCode stopped sharing this session.";
  } finally {
    await stopChild(child);
  }
};
