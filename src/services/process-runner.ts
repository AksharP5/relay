import { Context, Effect, Layer } from "effect";

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
  static readonly layer = Layer.succeed(ProcessRunner, {
    run: Effect.fn("ProcessRunner.run")((input: ProcessInput) =>
      Effect.tryPromise({
        try: async () => {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 30 * 60 * 1000);

          try {
            const process = Bun.spawn([input.command, ...(input.args ?? [])], {
              ...(input.cwd ? { cwd: input.cwd } : {}),
              env: { ...Bun.env, ...input.env },
              stdin: input.stdin === undefined ? "ignore" : "pipe",
              stdout: "pipe",
              stderr: "pipe",
              signal: controller.signal,
            });

            const stdin = process.stdin;
            if (input.stdin !== undefined && stdin && typeof stdin !== "number") {
              stdin.write(input.stdin);
              stdin.end();
            }

            const [stdout, stderr, exitCode] = await Promise.all([
              readStream(process.stdout, {
                ...(input.onStdoutLine ? { onLine: input.onStdoutLine } : {}),
                ...(input.captureLimitChars ? { limit: input.captureLimitChars } : {}),
                ...(input.lineLimitChars ? { lineLimit: input.lineLimitChars } : {}),
              }),
              readStream(process.stderr, {
                ...(input.captureLimitChars ? { limit: input.captureLimitChars } : {}),
              }),
              process.exited,
            ]);

            return { exitCode, stdout, stderr };
          } finally {
            clearTimeout(timeout);
          }
        },
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      }),
    ),
    which: Effect.fn("ProcessRunner.which")((command: string) =>
      Effect.tryPromise({
        try: async () => Bun.which(command) ?? undefined,
        catch: () => undefined,
      }).pipe(Effect.orElseSucceed(() => undefined)),
    ),
  });
}
