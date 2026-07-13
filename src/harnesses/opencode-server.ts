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
