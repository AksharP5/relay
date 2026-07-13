#!/usr/bin/env bun

import { BunRuntime } from "@effect/platform-bun";
import { Console, Effect, Layer, ManagedRuntime, pipe } from "effect";
import pc from "picocolors";
import packageJson from "../package.json" with { type: "json" };
import { parseArgs } from "./cli-args.ts";
import type { Harness, RelayThread } from "./domain.ts";
import { HarnessService } from "./harnesses/harness-service.ts";
import { ProcessRunner } from "./services/process-runner.ts";
import { RelayService } from "./services/relay-service.ts";
import { PreferenceStore } from "./services/preference-store.ts";
import { ThreadStore } from "./services/thread-store.ts";
import { makeNativeRelayController } from "./native/controller.ts";
import { launchNativeRelay } from "./native/relay-host.ts";

const help = `
${pc.bold("Relay")} — carry one coding task between Codex and OpenCode

${pc.bold("Usage")}
  relay
  relay doctor
  relay new [name] [--with codex|opencode]
  relay ask [--with codex|opencode] [--model name] <message>
  relay use codex|opencode
  relay status
  relay history
  relay list
  relay thread <id>
  relay native [codex|opencode]

${pc.bold("Examples")}
  relay new "Fix the checkout flow" --with codex
  relay ask "Find the cause and implement a fix"
  relay ask --with opencode "Review the change and run the tests"

Relay creates a native session only when a harness first receives a turn.
Your current harness can also be changed without running a model using ${pc.cyan("relay use")}.
`.trim();

const shortId = (id: string) => id.slice(0, 8);
const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
const bindingLabel = (thread: RelayThread, harness: Harness) =>
  thread.bindings[harness]
    ? `${pc.green("ready")} ${pc.dim(shortId(thread.bindings[harness]!.sessionId))}`
    : pc.dim("not created");

const renderStatus = (thread: RelayThread, dataRoot: string) =>
  [
    `${pc.bold(thread.title)} ${pc.dim(`(${shortId(thread.id)})`)}`,
    `Active     ${pc.cyan(thread.activeHarness)}`,
    `Directory  ${thread.cwd}`,
    `Codex      ${bindingLabel(thread, "codex")}`,
    `OpenCode   ${bindingLabel(thread, "opencode")}`,
    `Messages   ${thread.lastSeq}`,
    `Data       ${pc.dim(dataRoot)}`,
  ].join("\n");

const renderError = (error: unknown) => {
  if (!error || typeof error !== "object") return `Relay failed: ${String(error)}`;
  const message = "message" in error ? String(error.message) : `Relay failed: ${String(error)}`;
  const detail = "stderr" in error && typeof error.stderr === "string" ? error.stderr.trim() : "";
  if (!detail) return message;
  return `${message}\n${pc.dim(detail.split("\n").slice(-6).join("\n"))}`;
};

export const program = (argv: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const relay = yield* RelayService;
    const command = yield* Effect.try({ try: () => parseArgs(argv), catch: (error) => error });

    switch (command.name) {
      case "help":
        yield* Console.log(help);
        return;
      case "version":
        yield* Console.log(packageJson.version);
        return;
      case "doctor": {
        const statuses = yield* relay.doctor();
        yield* Console.log(pc.bold("Relay doctor"));
        for (const status of statuses) {
          const result =
            status.installed && status.healthy
              ? `${pc.green("ready")} ${status.version ?? pc.dim("version unknown")}`
              : status.installed
                ? pc.red("unhealthy (--version failed)")
                : pc.red(`missing (${status.harness} was not found in PATH)`);
          yield* Console.log(`${status.harness.padEnd(10)} ${result}`);
        }
        return;
      }
      case "new": {
        const thread = yield* relay.newThread({
          title: command.title,
          cwd: process.cwd(),
          harness: command.harness,
        });
        yield* Console.log(
          `${pc.green("Created")} ${pc.bold(thread.title)} ${pc.dim(shortId(thread.id))}`,
        );
        yield* Console.log(`First turn: ${pc.cyan(`relay ask "..."`)}`);
        return;
      }
      case "ask": {
        yield* Console.error(pc.dim(`Running ${command.harness ?? "the active harness"}...`));
        const result = yield* relay.ask(command);
        yield* Console.log(result.response.content);
        const handoff =
          result.handedOffMessages > 0 ? ` · handed off ${result.handedOffMessages} messages` : "";
        const binding = result.createdBinding ? " · created native session" : "";
        yield* Console.error(pc.dim(`\n${result.thread.activeHarness}${binding}${handoff}`));
        return;
      }
      case "use": {
        const thread = yield* relay.switchHarness(command.harness);
        yield* Console.log(
          `${pc.green("Ready")} — the next turn will run in ${pc.cyan(thread.activeHarness)}`,
        );
        return;
      }
      case "thread": {
        const thread = yield* relay.useThread(command.threadId);
        yield* Console.log(
          `${pc.green("Selected")} ${pc.bold(thread.title)} ${pc.dim(shortId(thread.id))}`,
        );
        return;
      }
      case "native": {
        const thread = yield* relay.current();
        const harness = command.harness ?? thread.activeHarness;
        const binding = thread.bindings[harness];
        if (!binding) {
          return yield* Effect.fail(
            new Error(
              `No native ${harness} session exists yet. Run a turn with --with ${harness} first.`,
            ),
          );
        }
        const nativeCommand =
          harness === "codex"
            ? `codex -C ${shellQuote(thread.cwd)} resume ${shellQuote(binding.sessionId)}`
            : `opencode --session ${shellQuote(binding.sessionId)} ${shellQuote(thread.cwd)}`;
        yield* Console.log(nativeCommand);
        yield* Console.error(
          pc.dim(
            "Turns made directly in the native app are not imported into Relay automatically.",
          ),
        );
        return;
      }
      case "status": {
        const thread = yield* relay.current();
        yield* Console.log(renderStatus(thread, relay.dataRoot));
        return;
      }
      case "history": {
        const messages = yield* relay.history();
        for (const message of messages) {
          const label = message.role === "user" ? pc.cyan("you") : pc.green(message.harness);
          yield* Console.log(
            `${pc.bold(label)} ${pc.dim(`#${message.seq}`)}\n${message.content}\n`,
          );
        }
        return;
      }
      case "list": {
        const threads = yield* relay.list();
        if (threads.length === 0) {
          yield* Console.log(pc.dim("No Relay tasks yet."));
          return;
        }
        for (const thread of threads) {
          yield* Console.log(
            `${pc.dim(shortId(thread.id))}  ${thread.title}  ${pc.cyan(thread.activeHarness)}  ${pc.dim(`${thread.lastSeq} messages · ${thread.cwd}`)}`,
          );
        }
      }
    }
  });

const HarnessLayer = HarnessService.layer.pipe(Layer.provide(ProcessRunner.layer));
export const MainLayer = RelayService.layer.pipe(
  Layer.provide(Layer.mergeAll(ThreadStore.layer, HarnessLayer, PreferenceStore.layer)),
);

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    const runtime = ManagedRuntime.make(MainLayer);
    void launchNativeRelay(makeNativeRelayController(runtime))
      .catch((error) => {
        process.stderr.write(`${pc.red(renderError(error))}\n`);
        process.exitCode = 1;
      })
      .finally(() => runtime.dispose());
  } else {
    pipe(
      program(argv),
      Effect.provide(MainLayer),
      Effect.tapError((error) => Console.error(pc.red(renderError(error)))),
      Effect.catch(() => Effect.sync(() => (process.exitCode = 1))),
      BunRuntime.runMain,
    );
  }
}
