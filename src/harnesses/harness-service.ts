import { Context, Effect, Layer } from "effect";
import type {
  Harness,
  HarnessCapabilities,
  HarnessCommand,
  HarnessControlInput,
  HarnessControlResult,
  HarnessModel,
  HarnessTurnInput,
  HarnessTurnResult,
} from "../domain.ts";
import { HarnessError, HarnessUnavailable } from "../errors.ts";
import { buildHandoff, composePrompt } from "../handoff.ts";
import { ProcessRunner } from "../services/process-runner.ts";
import { runCodexCommand } from "./codex-app-server.ts";
import {
  discoverOpenCodeCommands,
  runOpenCodeCommand,
  runOpenCodeControl,
} from "./opencode-server.ts";
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
const contextLimitPattern =
  /(context (?:window|length|limit)|maximum context|too many (?:input )?tokens|prompt is too long|input is too long)/i;
export const sessionStateForFailure = (cause: unknown): "preserve" | "uncertain" => {
  const diagnostic =
    cause instanceof Error ? `${cause.message}\n${cause.stack ?? ""}` : String(cause);
  return contextLimitPattern.test(diagnostic) ? "preserve" : "uncertain";
};

const relayCommands: ReadonlyArray<HarnessCommand> = [
  { name: "model", description: "Choose the model for this harness", source: "relay" },
  { name: "harness", description: "Switch between Codex and OpenCode", source: "relay" },
  { name: "help", description: "Show commands for the active harness", source: "relay" },
];

const codexCommands: ReadonlyArray<HarnessCommand> = [
  {
    name: "compact",
    description: "Compact the native Codex thread context",
    source: "native",
  },
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
      is_default?: unknown;
    }>;
  };
  return (value.models ?? [])
    .filter(
      (model): model is typeof model & { slug: string } =>
        typeof model.slug === "string" && model.visibility !== "hide",
    )
    .sort((left, right) => Number(left.priority ?? 1_000) - Number(right.priority ?? 1_000))
    .map((model) => ({
      id: model.slug,
      name: typeof model.display_name === "string" ? model.display_name : model.slug,
      ...(typeof model.description === "string" ? { description: model.description } : {}),
      ...(model.is_default === true ? { isDefault: true } : {}),
    }));
};

const parseOpenCodeModels = (stdout: string): ReadonlyArray<HarnessModel> =>
  stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((id) => ({ id, name: id }));

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
    readonly control: (
      harness: Harness,
      input: HarnessControlInput,
    ) => Effect.Effect<HarnessControlResult, HarnessUnavailable | HarnessError>;
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
              const discovered = yield* Effect.tryPromise({
                try: () => discoverOpenCodeCommands(command, cwd),
                catch: () => undefined,
              }).pipe(Effect.orElseSucceed(() => undefined));
              if (discovered) nativeCommands = [...nativeCommands, ...discovered];
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

          const commandPrefix = input.command ? `/${input.command}` : undefined;
          const nativePrompt =
            commandPrefix && input.prompt.startsWith(commandPrefix)
              ? input.prompt.slice(commandPrefix.length).trimStart()
              : input.prompt;
          const prompt = input.command
            ? nativePrompt
            : composePrompt(input.handoff, nativePrompt, input.handoffOmittedMessages);
          input.onProgress?.({ type: "activity", label: `Starting ${harness}` });

          if (harness === "codex" && (input.command === "compact" || input.command === "review")) {
            return yield* Effect.tryPromise({
              try: () =>
                runCodexCommand(command, {
                  command: input.command as "compact" | "review",
                  cwd: input.cwd,
                  arguments: nativePrompt,
                  ...(input.handoff.length || input.handoffOmittedMessages
                    ? {
                        handoffText: buildHandoff(input.handoff, input.handoffOmittedMessages),
                      }
                    : {}),
                  ...(input.sessionId ? { sessionId: input.sessionId } : {}),
                  ...(input.model ? { model: input.model } : {}),
                  ...(input.onProgress ? { onProgress: input.onProgress } : {}),
                }),
              catch: (cause) =>
                new HarnessError({
                  harness,
                  message: cause instanceof Error ? cause.message : String(cause),
                  stderr: cause instanceof Error ? cause.stack : String(cause),
                  sessionState: sessionStateForFailure(cause),
                }),
            });
          }

          if (harness === "opencode" && input.command) {
            return yield* Effect.tryPromise({
              try: () =>
                runOpenCodeCommand(command, {
                  cwd: input.cwd,
                  command: input.command!,
                  arguments: nativePrompt,
                  ...(input.handoff.length || input.handoffOmittedMessages
                    ? {
                        handoffText: buildHandoff(input.handoff, input.handoffOmittedMessages),
                      }
                    : {}),
                  ...(input.sessionId ? { sessionId: input.sessionId } : {}),
                  ...(input.model ? { model: input.model } : {}),
                }),
              catch: (cause) =>
                new HarnessError({
                  harness,
                  message: cause instanceof Error ? cause.message : String(cause),
                  sessionState: sessionStateForFailure(cause),
                }),
            });
          }
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
                    sessionState: sessionStateForFailure(cause),
                  }),
              ),
            );

          if (output.exitCode !== 0) {
            const diagnostic = `${output.stderr}\n${output.stdout}`.trim().slice(-8_000);
            const contextLimit = contextLimitPattern.test(diagnostic);
            return yield* new HarnessError({
              harness,
              message: contextLimit
                ? input.sessionId
                  ? `${harness} reached its context limit. Run /compact and retry, or choose a model with a larger context window.`
                  : `${harness} could not accept this new session because its initial context exceeds the model's limit. Choose a model with a larger context window, or start a new task with a concise summary.`
                : `${harness} exited before completing the turn`,
              exitCode: output.exitCode,
              stderr: diagnostic,
              sessionState: contextLimit ? "preserve" : "uncertain",
            });
          }

          publishText(true);

          const sessionId = parsedSessionId;
          if (!sessionId) {
            return yield* new HarnessError({
              harness,
              message: `Could not find a native ${harness} session id in the command output`,
              stderr: output.stderr.trim().slice(-8_000),
              sessionState: "uncertain",
            });
          }
          if (!parsedText.trim()) {
            return yield* new HarnessError({
              harness,
              message: `${harness} completed without a text response`,
              stderr: output.stderr.trim().slice(-8_000),
              sessionState: "uncertain",
            });
          }

          return { sessionId, text: parsedText.trim() };
        }),
      );

      const control = Effect.fn("HarnessService.control")(
        (harness: Harness, input: HarnessControlInput) =>
          Effect.gen(function* () {
            const command = yield* runner.which(executable(harness));
            if (!command)
              return yield* new HarnessUnavailable({
                harness,
                command: executable(harness),
                message: `${harness} was not found in PATH. Install it, then run relay doctor.`,
              });
            if (harness === "codex") {
              if (input.action !== "compact") {
                return yield* new HarnessError({
                  harness,
                  message: `${input.action} is native to OpenCode`,
                });
              }
              const result = yield* Effect.tryPromise({
                try: () =>
                  runCodexCommand(command, {
                    command: "compact",
                    cwd: input.cwd,
                    sessionId: input.sessionId,
                    arguments: "",
                    ...(input.model ? { model: input.model } : {}),
                  }),
                catch: (cause) =>
                  new HarnessError({
                    harness,
                    message: cause instanceof Error ? cause.message : String(cause),
                  }),
              });
              return { message: result.text };
            }
            const message = yield* Effect.tryPromise({
              try: () => runOpenCodeControl(command, input),
              catch: (cause) =>
                new HarnessError({
                  harness,
                  message: cause instanceof Error ? cause.message : String(cause),
                }),
            });
            return { message };
          }),
      );

      return { run, status, capabilities, control };
    }),
  );
}
