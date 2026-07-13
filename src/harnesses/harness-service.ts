import { Context, Effect, Layer } from "effect";
import type { Harness, HarnessTurnInput, HarnessTurnResult } from "../domain.ts";
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

export class HarnessService extends Context.Service<
  HarnessService,
  {
    readonly run: (
      harness: Harness,
      input: HarnessTurnInput,
    ) => Effect.Effect<HarnessTurnResult, HarnessUnavailable | HarnessError>;
    readonly status: (harness: Harness) => Effect.Effect<HarnessStatus>;
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
          const onStdoutLine = (line: string) => {
            if (harness === "codex") {
              const event = parseCodexOutput(line);
              parsedSessionId = event.sessionId ?? parsedSessionId;
              if (event.text) {
                parsedText = event.text;
                input.onProgress?.({ type: "text", text: parsedText });
              }
              return;
            }
            const event = parseOpenCodeEvent(line);
            parsedSessionId = event.sessionId ?? parsedSessionId;
            if (event.textPart !== undefined) {
              parsedText += event.textPart;
              input.onProgress?.({ type: "text", text: parsedText });
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

      return { run, status };
    }),
  );
}
