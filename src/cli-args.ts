import type { Harness } from "./domain.ts";
import { isHarness } from "./domain.ts";
import { CliError } from "./errors.ts";

export type CliCommand =
  | { readonly name: "open"; readonly directory: string }
  | { readonly name: "help" }
  | { readonly name: "version" }
  | { readonly name: "doctor" }
  | { readonly name: "status" }
  | { readonly name: "list" }
  | { readonly name: "history" }
  | { readonly name: "config"; readonly action: "get" }
  | { readonly name: "config"; readonly action: "set"; readonly value: string }
  | { readonly name: "config"; readonly action: "reset" }
  | { readonly name: "new"; readonly title: string; readonly harness: Harness }
  | { readonly name: "use"; readonly harness: Harness }
  | { readonly name: "thread"; readonly threadId: string }
  | { readonly name: "export"; readonly threadId?: string; readonly output?: string }
  | { readonly name: "delete"; readonly threadId?: string; readonly force: boolean }
  | { readonly name: "native"; readonly harness?: Harness }
  | {
      readonly name: "ask";
      readonly prompt: string;
      readonly harness?: Harness;
      readonly model?: string;
    };

const valueAfter = (args: ReadonlyArray<string>, index: number, flag: string) => {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new CliError({ message: `${flag} needs a value` });
  return value;
};

const expectNoArguments = (args: ReadonlyArray<string>, usage: string) => {
  if (args.length > 0) throw new CliError({ message: `Usage: ${usage}` });
};

const parseAsk = (args: ReadonlyArray<string>): CliCommand => {
  let harness: Harness | undefined;
  let model: string | undefined;
  let parsingOptions = true;
  const words: Array<string> = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (parsingOptions && arg === "--") {
      parsingOptions = false;
      continue;
    }
    if (parsingOptions && arg === "--with") {
      const value = valueAfter(args, index, "--with");
      if (!isHarness(value)) throw new CliError({ message: `Unknown harness: ${value}` });
      harness = value;
      index += 1;
      continue;
    }
    if (parsingOptions && arg === "--model") {
      model = valueAfter(args, index, "--model");
      index += 1;
      continue;
    }
    if (parsingOptions && arg.startsWith("--")) {
      throw new CliError({ message: `Unknown option: ${arg}` });
    }
    words.push(arg);
  }

  const prompt = words.join(" ").trim();
  if (!prompt) throw new CliError({ message: "relay ask needs a message" });
  return { name: "ask", prompt, ...(harness ? { harness } : {}), ...(model ? { model } : {}) };
};

const parseTaskFileCommand = (
  command: "export" | "delete",
  args: ReadonlyArray<string>,
): CliCommand => {
  let threadId: string | undefined;
  let output: string | undefined;
  let force = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--out" && command === "export") {
      output = valueAfter(args, index, "--out");
      index += 1;
      continue;
    }
    if (arg === "--force" && command === "delete") {
      force = true;
      continue;
    }
    if (arg.startsWith("--")) throw new CliError({ message: `Unknown option: ${arg}` });
    if (threadId) throw new CliError({ message: `Usage: relay ${command} [task-id]` });
    threadId = arg;
  }
  if (command === "export") {
    return {
      name: "export",
      ...(threadId ? { threadId } : {}),
      ...(output ? { output } : {}),
    };
  }
  return { name: "delete", ...(threadId ? { threadId } : {}), force };
};

const parseConfig = (args: ReadonlyArray<string>): CliCommand => {
  if (args.length === 0 || (args.length === 2 && args[0] === "get" && args[1] === "switch-key")) {
    return { name: "config", action: "get" };
  }
  if (args.length === 3 && args[0] === "set" && args[1] === "switch-key") {
    return { name: "config", action: "set", value: args[2]! };
  }
  if (args.length === 2 && args[0] === "reset" && args[1] === "switch-key") {
    return { name: "config", action: "reset" };
  }
  throw new CliError({
    message: "Usage: relay config [get switch-key | set switch-key <binding> | reset switch-key]",
  });
};

export const parseArgs = (args: ReadonlyArray<string>): CliCommand => {
  const [command, ...rest] = args;
  if (!command) return { name: "help" };
  if (command === "--") {
    const directory = rest[0];
    if (rest.length !== 1 || directory === undefined) {
      throw new CliError({ message: "Usage: relay -- <directory>" });
    }
    return { name: "open", directory };
  }
  if (command === "help" || command === "--help" || command === "-h") {
    expectNoArguments(rest, "relay help | --help | -h");
    return { name: "help" };
  }
  if (command === "--version" || command === "-v" || command === "version") {
    expectNoArguments(rest, "relay version | --version | -v");
    return { name: "version" };
  }
  if (command === "doctor" || command === "status" || command === "list" || command === "history") {
    expectNoArguments(rest, `relay ${command}`);
    return { name: command };
  }
  if (command === "ask") return parseAsk(rest);
  if (command === "config") return parseConfig(rest);
  if (command === "export" || command === "delete") return parseTaskFileCommand(command, rest);
  if (command === "native") {
    if (rest.length > 1) {
      throw new CliError({ message: "Usage: relay native [codex|opencode]" });
    }
    const harness = rest[0];
    if (!harness) return { name: "native" };
    if (!isHarness(harness)) {
      throw new CliError({ message: "Usage: relay native [codex|opencode]" });
    }
    return { name: "native", harness };
  }
  if (command === "use") {
    const harness = rest[0];
    if (rest.length !== 1 || !harness || !isHarness(harness))
      throw new CliError({ message: "Usage: relay use codex|opencode" });
    return { name: "use", harness };
  }
  if (command === "thread") {
    const threadId = rest[0];
    if (rest.length !== 1 || !threadId) {
      throw new CliError({ message: "Usage: relay thread <id>" });
    }
    return { name: "thread", threadId };
  }
  if (command === "new") {
    let harness: Harness = "codex";
    const titleWords: Array<string> = [];
    for (let index = 0; index < rest.length; index += 1) {
      const arg = rest[index]!;
      if (arg === "--with") {
        const value = valueAfter(rest, index, "--with");
        if (!isHarness(value)) throw new CliError({ message: `Unknown harness: ${value}` });
        harness = value;
        index += 1;
      } else if (arg.startsWith("--")) {
        throw new CliError({ message: `Unknown option: ${arg}` });
      } else {
        titleWords.push(arg);
      }
    }
    return { name: "new", title: titleWords.join(" ").trim() || "Untitled task", harness };
  }
  if (command.startsWith("-")) throw new CliError({ message: `Unknown option: ${command}` });
  if (rest.length === 0) return { name: "open", directory: command };
  throw new CliError({
    message: `Unknown command or invalid directory arguments: ${args.join(" ")}`,
  });
};
