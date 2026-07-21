import { Context, Effect, Layer } from "effect";
import { RelayPaths } from "./data-root.ts";
import { trackManagedProcess, untrackManagedProcess } from "./process-registry.ts";

export interface ProcessInput {
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly stdin?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly onStdoutLine?: (line: string) => void;
  readonly captureLimitChars?: number;
  readonly lineLimitChars?: number;
}

export interface ProcessOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const signalProcessTree = (child: ReturnType<typeof Bun.spawn>, signal: NodeJS.Signals) => {
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through when the process group has already exited.
    }
  }
  if (child.exitCode !== null) return;
  try {
    child.kill(signal);
  } catch {
    // The child may have exited between the status check and signal.
  }
};

export const stopProcessTree = async (child: ReturnType<typeof Bun.spawn>, graceMs = 1_000) => {
  try {
    signalProcessTree(child, "SIGTERM");
    const leaderExited = await Promise.race([
      child.exited.then(() => true),
      Bun.sleep(graceMs).then(() => false),
    ]);
    // On POSIX, descendants retain the detached process-group id after the
    // leader exits. Always escalate the group; ESRCH is safely ignored.
    if (process.platform !== "win32" || !leaderExited) signalProcessTree(child, "SIGKILL");
    if (child.exitCode === null) await child.exited.catch(() => undefined);
  } finally {
    await untrackManagedProcess(child);
  }
};

const makeTerminator = (child: ReturnType<typeof Bun.spawn>) => {
  let terminating: Promise<void> | undefined;
  return () => {
    terminating ??= stopProcessTree(child);
    return terminating;
  };
};

export const readStream = async (
  stream: ReadableStream<Uint8Array>,
  options: {
    readonly onLine?: (line: string) => void;
    readonly limit?: number;
    readonly lineLimit?: number;
  } = {},
) => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let captured = "";
  let droppingLine = false;
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const lineLimit = options.lineLimit ?? Number.POSITIVE_INFINITY;

  const capture = (text: string) => {
    captured += text;
    if (captured.length > limit) captured = captured.slice(-limit);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    capture(text);
    if (!options.onLine) continue;

    pending += text;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (droppingLine) {
        droppingLine = false;
      } else if (line.length <= lineLimit) {
        options.onLine(line);
      }
    }
    if (pending.length > lineLimit) {
      pending = "";
      droppingLine = true;
    }
  }

  const final = decoder.decode();
  if (final) {
    capture(final);
    pending += final;
  }
  if (options.onLine && pending && !droppingLine && pending.length <= lineLimit)
    options.onLine(pending);
  return captured;
};

export class ProcessRunner extends Context.Service<
  ProcessRunner,
  {
    readonly run: (input: ProcessInput) => Effect.Effect<ProcessOutput, Error>;
    readonly which: (command: string) => Effect.Effect<string | undefined>;
  }
>()("@relay/ProcessRunner") {
  static readonly configuredLayer = Layer.effect(
    ProcessRunner,
    Effect.gen(function* () {
      const paths = yield* RelayPaths;
      return ProcessRunner.of({
        run: Effect.fn("ProcessRunner.run")((input: ProcessInput) => {
          let terminate: (() => Promise<void>) | undefined;
          const operation = Effect.tryPromise({
            try: async (signal) => {
              let onAbort: (() => void) | undefined;
              let timeout: ReturnType<typeof setTimeout> | undefined;

              try {
                const child = Bun.spawn([input.command, ...(input.args ?? [])], {
                  ...(input.cwd ? { cwd: input.cwd } : {}),
                  env: { ...Bun.env, ...input.env },
                  stdin: input.stdin === undefined ? "ignore" : "pipe",
                  stdout: "pipe",
                  stderr: "pipe",
                  detached: process.platform !== "win32",
                });
                await trackManagedProcess(paths.root, child, "command");
                terminate = makeTerminator(child);
                onAbort = () => void terminate?.();
                signal.addEventListener("abort", onAbort, { once: true });
                timeout = setTimeout(() => void terminate?.(), input.timeoutMs ?? 30 * 60 * 1000);

                const stdin = child.stdin;
                try {
                  if (input.stdin !== undefined && stdin && typeof stdin !== "number") {
                    stdin.write(input.stdin);
                    stdin.end();
                  }
                } catch (cause) {
                  await terminate();
                  throw cause;
                }

                let result: [string, string, number];
                try {
                  result = await Promise.all([
                    readStream(child.stdout, {
                      ...(input.onStdoutLine ? { onLine: input.onStdoutLine } : {}),
                      ...(input.captureLimitChars ? { limit: input.captureLimitChars } : {}),
                      ...(input.lineLimitChars ? { lineLimit: input.lineLimitChars } : {}),
                    }),
                    readStream(child.stderr, {
                      ...(input.captureLimitChars ? { limit: input.captureLimitChars } : {}),
                    }),
                    child.exited,
                  ]);
                } catch (cause) {
                  await terminate();
                  throw cause;
                }
                const [stdout, stderr, exitCode] = result;
                await stopProcessTree(child);

                return { exitCode, stdout, stderr };
              } finally {
                if (timeout) clearTimeout(timeout);
                if (onAbort) signal.removeEventListener("abort", onAbort);
              }
            },
            catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
          });

          return operation.pipe(
            Effect.onInterrupt(() =>
              terminate ? Effect.promise(() => terminate!()) : Effect.void,
            ),
          );
        }),
        which: Effect.fn("ProcessRunner.which")((command: string) =>
          Effect.tryPromise({
            try: async () => Bun.which(command) ?? undefined,
            catch: () => undefined,
          }).pipe(Effect.orElseSucceed(() => undefined)),
        ),
      });
    }),
  );

  static readonly layer = ProcessRunner.configuredLayer.pipe(Layer.provide(RelayPaths.layer));
}
