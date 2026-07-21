#!/usr/bin/env bun

import { BunRuntime } from "@effect/platform-bun";
import { Console, Effect, Layer, ManagedRuntime, pipe } from "effect";
import { chmod, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import pc from "picocolors";
import packageJson from "../package.json" with { type: "json" };
import { parseArgs, type CliCommand } from "./cli-args.ts";
import type { Harness, RelayThread } from "./domain.ts";
import { HarnessService } from "./harnesses/harness-service.ts";
import { resolveLaunchDirectory } from "./launch-directory.ts";
import { ProcessRunner } from "./services/process-runner.ts";
import { cleanupOrphanedProcesses } from "./services/process-registry.ts";
import { RelayService } from "./services/relay-service.ts";
import { ThreadStore } from "./services/thread-store.ts";
import {
  loadRelaySettings,
  relayConfigPath,
  resetRelaySettings,
  saveRelaySettings,
} from "./services/settings.ts";
import { parseSwitchKey, switchKeyWarning } from "./switch-key.ts";
import { makeNativeRelayController } from "./native/controller.ts";
import { launchNativeRelay } from "./native/relay-host.ts";

const help = `
${pc.bold("Relay")} — carry one coding task between Codex and OpenCode

${pc.bold("Usage")}
  relay
  relay [directory]
  relay -- <directory>
  relay help | --help | -h
  relay version | --version | -v
  relay doctor
  relay config
  relay config get switch-key
  relay config set switch-key <binding>
  relay config reset switch-key
  relay new [name] [--with codex|opencode]
  relay ask [--with codex|opencode] [--model name] <message>
  relay use codex|opencode
  relay status
  relay history
  relay list
  relay thread <id>
  relay export [id] [--out file]
  relay delete [id] --force
  relay native [codex|opencode]

${pc.bold("Examples")}
  relay .
  relay ../another-project
  relay -- native
  relay config set switch-key ctrl+g
  relay config set switch-key shift+return
  relay new "Fix the checkout flow" --with codex
  relay ask "Find the cause and implement a fix"
  relay ask --with opencode "Review the change and run the tests"

Bare ${pc.cyan("relay")} opens the selected harness's real native TUI.
Use ${pc.cyan("relay -- <directory>")} when a directory name matches a Relay command.
Press the configured switch key (${pc.cyan("Ctrl+Q")} by default) to move between harnesses.
${pc.cyan("F6")} is available as a fallback.
Run ${pc.cyan("relay config set switch-key ctrl+g")} to choose any terminal-observable key chord using OpenCode-style key names.
Your next harness can also be changed without running a model using ${pc.cyan("relay use")}.
`.trim();

const shortId = (id: string) => id.slice(0, 8);
const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
const bindingLabel = (thread: RelayThread, harness: Harness) =>
  thread.bindings[harness]
    ? `${pc.green("ready")} ${pc.dim(shortId(thread.bindings[harness]!.sessionId))}`
    : pc.dim("not created");
const activeMessageCount = (thread: RelayThread) =>
  Math.max(0, thread.lastSeq - (thread.contextStartSeq ?? 0));

const renderStatus = (thread: RelayThread, dataRoot: string) =>
  [
    `${pc.bold(thread.title)} ${pc.dim(`(${shortId(thread.id)})`)}`,
    `Active     ${pc.cyan(thread.activeHarness)}`,
    `Directory  ${thread.cwd}`,
    `Codex      ${bindingLabel(thread, "codex")}`,
    `OpenCode   ${bindingLabel(thread, "opencode")}`,
    `Messages   ${activeMessageCount(thread)}`,
    `Data       ${pc.dim(dataRoot)}`,
  ].join("\n");

const renderError = (error: unknown) => {
  if (!error || typeof error !== "object") return `Relay failed: ${String(error)}`;
  const message = "message" in error ? String(error.message) : `Relay failed: ${String(error)}`;
  const detail = "stderr" in error && typeof error.stderr === "string" ? error.stderr.trim() : "";
  if (!detail) return message;
  return `${message}\n${pc.dim(detail.split("\n").slice(-6).join("\n"))}`;
};

export const program = (command: Exclude<CliCommand, { readonly name: "open" }>) =>
  Effect.gen(function* () {
    const relay = yield* RelayService;

    switch (command.name) {
      case "help":
        yield* Console.log(help);
        return;
      case "version":
        yield* Console.log(packageJson.version);
        return;
      case "config": {
        if (command.action === "get") {
          const settings = yield* Effect.tryPromise({
            try: loadRelaySettings,
            catch: (cause) => cause,
          });
          yield* Console.log(`Switch key  ${pc.cyan(settings.switchKey.label)}`);
          yield* Console.log(`Fallback    ${pc.cyan("F6")}`);
          yield* Console.log(`Config      ${pc.dim(relayConfigPath())}`);
          return;
        }
        if (command.action === "reset") {
          yield* Effect.tryPromise({ try: resetRelaySettings, catch: (cause) => cause });
          yield* Console.log(`${pc.green("Reset")} switch key to ${pc.cyan("Ctrl+Q")}.`);
          yield* Console.log(pc.dim("F6 remains available. Applies on the next Relay launch."));
          return;
        }
        const switchKey = yield* Effect.try({
          try: () => parseSwitchKey(command.value),
          catch: (cause) => cause,
        });
        yield* Effect.tryPromise({
          try: () => saveRelaySettings({ switchKey }),
          catch: (cause) => cause,
        });
        yield* Console.log(`${pc.green("Saved")} switch key ${pc.cyan(switchKey.label)}.`);
        const warning = switchKeyWarning(switchKey);
        if (warning) yield* Console.log(pc.yellow(warning));
        yield* Console.log(pc.dim("F6 remains available. Applies on the next Relay launch."));
        return;
      }
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
      case "export": {
        const exported = yield* relay.exportTask(command.threadId);
        const json = `${JSON.stringify(exported, null, 2)}\n`;
        if (!command.output) {
          yield* Console.log(json.trimEnd());
          return;
        }
        const output = resolve(command.output);
        yield* Effect.tryPromise({
          try: async () => {
            await writeFile(output, json, { encoding: "utf8", mode: 0o600 });
            await chmod(output, 0o600);
          },
          catch: (cause) => new Error(`Could not write ${output}: ${String(cause)}`),
        });
        yield* Console.log(`${pc.green("Exported")} ${pc.bold(exported.task.title)} to ${output}`);
        return;
      }
      case "delete": {
        if (!command.force) {
          return yield* Effect.fail(
            new Error("Task deletion is permanent. Re-run with --force after exporting if needed."),
          );
        }
        const deleted = yield* relay.deleteTask(command.threadId);
        yield* Console.log(
          `${pc.green("Deleted")} ${pc.bold(deleted.title)} ${pc.dim(shortId(deleted.id))}`,
        );
        yield* Console.log(
          pc.dim("Workspace files and native Codex/OpenCode sessions were not deleted."),
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
            "Relay will attempt to import completed turns when it next attaches this binding.",
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
            `${pc.dim(shortId(thread.id))}  ${thread.title}  ${pc.cyan(thread.activeHarness)}  ${pc.dim(`${activeMessageCount(thread)} messages · ${thread.cwd}`)}`,
          );
        }
      }
    }
  });

const HarnessLayer = HarnessService.layer.pipe(Layer.provide(ProcessRunner.layer));
export const MainLayer = RelayService.layer.pipe(
  Layer.provide(Layer.mergeAll(ThreadStore.layer, HarnessLayer)),
);

if (import.meta.main) {
  const argv = process.argv.slice(2);
  let command: CliCommand | undefined;
  try {
    if (argv.length > 0) {
      command = parseArgs(argv);
      if (command.name === "open") process.chdir(await resolveLaunchDirectory(command.directory));
    }
    const recovery = await cleanupOrphanedProcesses();
    if (recovery.failed > 0) {
      throw new Error(
        `Relay could not stop ${recovery.failed} process group${recovery.failed === 1 ? "" : "s"} left by an interrupted run`,
      );
    }
    if (recovery.quarantined > 0) {
      process.stderr.write(
        `${pc.yellow(`Relay quarantined ${recovery.quarantined} invalid process ownership record${recovery.quarantined === 1 ? "" : "s"}.`)}\n`,
      );
    }
  } catch (error) {
    process.stderr.write(`${pc.red(renderError(error))}\n`);
    process.exitCode = 1;
  }

  if (process.exitCode !== 1) {
    if (!command || command.name === "open") {
      const runtime = ManagedRuntime.make(MainLayer);
      void loadRelaySettings()
        .then((settings) =>
          launchNativeRelay(
            makeNativeRelayController(runtime),
            {},
            {
              switchKey: settings.switchKey,
            },
          ),
        )
        .catch((error) => {
          process.stderr.write(`${pc.red(renderError(error))}\n`);
          process.exitCode = 1;
        })
        .finally(() => runtime.dispose());
    } else {
      pipe(
        program(command),
        Effect.provide(MainLayer),
        Effect.tapError((error) => Console.error(pc.red(renderError(error)))),
        Effect.catch(() => Effect.sync(() => (process.exitCode = 1))),
        BunRuntime.runMain,
      );
    }
  }
}
