import { Context, Effect, Layer } from "effect";
import type {
  Harness,
  HarnessCapabilities,
  HarnessCommand,
  HarnessModel,
  HarnessTurnInput,
  HarnessTurnResult,
} from "../domain.ts";
import { HarnessError, HarnessUnavailable } from "../errors.ts";
import { composePrompt } from "../handoff.ts";
import { ProcessRunner } from "../services/process-runner.ts";
import { parseCodexOutput, parseOpenCodeEvent } from "./parsing.ts";

export interface HarnessStatus {
  readonly harness: Harness;
  readonly installed: boolean;
  readonly healthy: boolean;
  readonly command?: string;
  readonly version?: string;
}

const executable = (harness: Harness) => harness;

const cleanVersion = (value: string) => value.trim().split("\n")[0] ?? value.trim();
const maxResponseChars = 2_000_000;

const relayCommands: ReadonlyArray<HarnessCommand> = [
  { name: "model", description: "Choose the model for this harness", source: "relay" },
  { name: "harness", description: "Switch between Codex and OpenCode", source: "relay" },
  { name: "help", description: "Show commands for the active harness", source: "relay" },
];

const codexCommands: ReadonlyArray<HarnessCommand> = [
  {
    name: "review",
    description: "Review the working tree with Codex",
    source: "native",
    acceptsArguments: true,
  },
];

const opencodeBuiltins: ReadonlyArray<HarnessCommand> = [
  {
    name: "init",
    description: "Create or update project instructions",
    source: "native",
    acceptsArguments: true,
  },
];

const parseCodexModels = (stdout: string): ReadonlyArray<HarnessModel> => {
  const value = JSON.parse(stdout) as {
    models?: Array<{
      slug?: unknown;
      display_name?: unknown;
      description?: unknown;
      visibility?: unknown;
      priority?: unknown;
    }>;
  };
  return (value.models ?? [])
    .filter(
      (model): model is typeof model & { slug: string } =>
        typeof model.slug === "string" && model.visibility !== "hide",
    )
    .sort((left, right) => Number(left.priority ?? 1_000) - Number(right.priority ?? 1_000))
    .map((model, index) => ({
      id: model.slug,
      name: typeof model.display_name === "string" ? model.display_name : model.slug,
      ...(typeof model.description === "string" ? { description: model.description } : {}),
      ...(index === 0 ? { isDefault: true } : {}),
    }));
};

const parseOpenCodeModels = (stdout: string): ReadonlyArray<HarnessModel> =>
  stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((id) => ({ id, name: id }));

const parseOpenCodeCommands = (stdout: string): ReadonlyArray<HarnessCommand> => {
  const value = JSON.parse(stdout) as {
    command?: Record<string, { description?: unknown }>;
  };
  return Object.entries(value.command ?? {}).map(([name, command]) => ({
    name,
    description:
      typeof command.description === "string" ? command.description : `Run OpenCode /${name}`,
    source: "native" as const,
    acceptsArguments: true,
  }));
};

export class HarnessService extends Context.Service<
  HarnessService,
  {
    readonly run: (
      harness: Harness,
      input: HarnessTurnInput,
    ) => Effect.Effect<HarnessTurnResult, HarnessUnavailable | HarnessError>;
    readonly status: (harness: Harness) => Effect.Effect<HarnessStatus>;
    readonly capabilities: (
      harness: Harness,
      cwd: string,
    ) => Effect.Effect<HarnessCapabilities, HarnessUnavailable | HarnessError>;
  }
>()("@relay/HarnessService") {
  static readonly layer = Layer.effect(
    HarnessService,
    Effect.gen(function* () {
      const runner = yield* ProcessRunner;

      const status = Effect.fn("HarnessService.status")((harness: Harness) =>
        Effect.gen(function* () {
          const command = yield* runner.which(executable(harness));
          if (!command) return { harness, installed: false, healthy: false };
          const output = yield* runner
            .run({ command, args: ["--version"], timeoutMs: 10_000 })
            .pipe(Effect.orElseSucceed(() => ({ exitCode: 1, stdout: "", stderr: "" })));
          const rawVersion = output.stdout.trim() || output.stderr.trim();
          return {
            harness,
            installed: true,
            healthy: output.exitCode === 0,
            command,
            ...(rawVersion ? { version: cleanVersion(rawVersion) } : {}),
          };
        }),
      );

      const capabilities = Effect.fn("HarnessService.capabilities")(
        (harness: Harness, cwd: string) =>
          Effect.gen(function* () {
            const command = yield* runner.which(executable(harness));
            if (!command)
              return yield* new HarnessUnavailable({
                harness,
                command: executable(harness),
                message: `${harness} was not found in PATH. Install it, then run relay doctor.`,
              });

            const modelsOutput = yield* runner
              .run({
                command,
                args: harness === "codex" ? ["debug", "models"] : ["models"],
                cwd,
                timeoutMs: 30_000,
                captureLimitChars: 4_000_000,
                lineLimitChars: 4_000_000,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new HarnessError({
                      harness,
                      message: `Could not load ${harness} models: ${cause.message}`,
                      stderr: cause.stack ?? cause.message,
                    }),
                ),
              );
            if (modelsOutput.exitCode !== 0) {
              return yield* new HarnessError({
                harness,
                message: `Could not load ${harness} models`,
                exitCode: modelsOutput.exitCode,
                stderr: modelsOutput.stderr.trim().slice(-8_000),
              });
            }

            let models: ReadonlyArray<HarnessModel>;
            try {
              models =
                harness === "codex"
                  ? parseCodexModels(modelsOutput.stdout)
                  : parseOpenCodeModels(modelsOutput.stdout);
            } catch (cause) {
              return yield* new HarnessError({
                harness,
                message: `Could not understand ${harness}'s model catalog`,
                stderr: cause instanceof Error ? cause.message : String(cause),
              });
            }

            let nativeCommands = harness === "codex" ? codexCommands : opencodeBuiltins;
            if (harness === "opencode") {
              const configOutput = yield* runner
                .run({
                  command,
                  args: ["debug", "config"],
                  cwd,
                  timeoutMs: 30_000,
                  captureLimitChars: 4_000_000,
                  lineLimitChars: 4_000_000,
                })
                .pipe(Effect.orElseSucceed(() => ({ exitCode: 1, stdout: "", stderr: "" })));
              if (configOutput.exitCode === 0) {
                try {
                  nativeCommands = [
                    ...nativeCommands,
                    ...parseOpenCodeCommands(configOutput.stdout),
                  ];
                } catch {
                  // Custom command discovery is additive; built-ins still work if config is invalid.
                }
              }
            }

            const commands = [...relayCommands, ...nativeCommands].filter(
              (item, index, all) =>
                all.findIndex((candidate) => candidate.name === item.name) === index,
            );
            return { harness, models, commands };
          }),
      );

      const run = Effect.fn("HarnessService.run")((harness: Harness, input: HarnessTurnInput) =>
        Effect.gen(function* () {
          const command = yield* runner.which(executable(harness));
          if (!command)
            return yield* new HarnessUnavailable({
              harness,
              command: executable(harness),
              message: `${harness} was not found in PATH. Install it, then run relay doctor.`,
            });

          const prompt = composePrompt(input.handoff, input.prompt);
          input.onProgress?.({ type: "activity", label: `Starting ${harness}` });
          let parsedSessionId = input.sessionId;
          let parsedText = "";
          let lastPublishedChars = 0;
          let lastPublishedAt = 0;
          const publishText = (force = false) => {
            if (parsedText.length > maxResponseChars) {
              throw new Error(`Harness response exceeds ${maxResponseChars} characters`);
            }
            if (force && parsedText.length === lastPublishedChars) return;
            const now = Date.now();
            if (
              !force &&
              parsedText.length - lastPublishedChars < 1_024 &&
              now - lastPublishedAt < 50
            )
              return;
            input.onProgress?.({ type: "text", text: parsedText });
            lastPublishedChars = parsedText.length;
            lastPublishedAt = now;
          };
          const onStdoutLine = (line: string) => {
            if (harness === "codex") {
              const event = parseCodexOutput(line);
              parsedSessionId = event.sessionId ?? parsedSessionId;
              if (event.text) {
                parsedText = event.text;
                publishText();
              }
              return;
            }
            const event = parseOpenCodeEvent(line);
            parsedSessionId = event.sessionId ?? parsedSessionId;
            if (event.textPart !== undefined) {
              parsedText += event.textPart;
              publishText();
            }
          };
          const args =
            harness === "codex"
              ? input.sessionId
                ? [
                    "exec",
                    "resume",
                    "--json",
                    "--skip-git-repo-check",
                    ...(input.model ? ["--model", input.model] : []),
                    input.sessionId,
                    "-",
                  ]
                : [
                    "exec",
                    "--json",
                    "--skip-git-repo-check",
                    ...(input.model ? ["--model", input.model] : []),
                    "-",
                  ]
              : [
                  "run",
                  "--format",
                  "json",
                  "--dir",
                  input.cwd,
                  ...(input.sessionId ? ["--session", input.sessionId] : ["--title", "Relay task"]),
                  ...(input.model ? ["--model", input.model] : []),
                  ...(input.command ? ["--command", input.command] : []),
                ];

          const output = yield* runner
            .run({
              command,
              args,
              cwd: input.cwd,
              stdin: prompt,
              onStdoutLine,
              captureLimitChars: 128_000,
              lineLimitChars: 2_000_000,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new HarnessError({
                    harness,
                    message: cause.message,
                    stderr: cause.stack ?? cause.message,
                  }),
              ),
            );

          if (output.exitCode !== 0) {
            return yield* new HarnessError({
              harness,
              message: `${harness} exited before completing the turn`,
              exitCode: output.exitCode,
              stderr: `${output.stderr}\n${output.stdout}`.trim().slice(-8_000),
            });
          }

          publishText(true);

          const sessionId = parsedSessionId;
          if (!sessionId) {
            return yield* new HarnessError({
              harness,
              message: `Could not find a native ${harness} session id in the command output`,
              stderr: output.stderr.trim().slice(-8_000),
            });
          }
          if (!parsedText.trim()) {
            return yield* new HarnessError({
              harness,
              message: `${harness} completed without a text response`,
              stderr: output.stderr.trim().slice(-8_000),
            });
          }

          return { sessionId, text: parsedText.trim() };
        }),
      );

      return { run, status, capabilities };
    }),
  );
}
