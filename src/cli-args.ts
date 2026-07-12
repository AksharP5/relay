import type { Harness } from "./domain.ts";
import { isHarness } from "./domain.ts";
import { CliError } from "./errors.ts";

export type CliCommand =
  | { readonly name: "help" }
  | { readonly name: "version" }
  | { readonly name: "doctor" }
  | { readonly name: "status" }
  | { readonly name: "list" }
  | { readonly name: "history" }
  | { readonly name: "new"; readonly title: string; readonly harness: Harness }
  | { readonly name: "use"; readonly harness: Harness }
  | { readonly name: "thread"; readonly threadId: string }
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

const parseAsk = (args: ReadonlyArray<string>): CliCommand => {
  let harness: Harness | undefined;
  let model: string | undefined;
  const words: Array<string> = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--with") {
      const value = valueAfter(args, index, "--with");
      if (!isHarness(value)) throw new CliError({ message: `Unknown harness: ${value}` });
      harness = value;
      index += 1;
      continue;
    }
    if (arg === "--model") {
      model = valueAfter(args, index, "--model");
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) throw new CliError({ message: `Unknown option: ${arg}` });
    words.push(arg);
  }

  const prompt = words.join(" ").trim();
  if (!prompt) throw new CliError({ message: "relay ask needs a message" });
  return { name: "ask", prompt, ...(harness ? { harness } : {}), ...(model ? { model } : {}) };
};

export const parseArgs = (args: ReadonlyArray<string>): CliCommand => {
  const [command, ...rest] = args;
  if (!command || command === "help" || command === "--help" || command === "-h")
    return { name: "help" };
  if (command === "--version" || command === "-v" || command === "version")
    return { name: "version" };
  if (command === "doctor" || command === "status" || command === "list" || command === "history") {
    return { name: command };
  }
  if (command === "ask") return parseAsk(rest);
  if (command === "native") {
    const harness = rest[0];
    if (!harness) return { name: "native" };
    if (!isHarness(harness)) {
      throw new CliError({ message: "Usage: relay native [codex|opencode]" });
    }
    return { name: "native", harness };
  }
  if (command === "use") {
    const harness = rest[0];
    if (!harness || !isHarness(harness))
      throw new CliError({ message: "Usage: relay use codex|opencode" });
    return { name: "use", harness };
  }
  if (command === "thread") {
    const threadId = rest[0];
    if (!threadId) throw new CliError({ message: "Usage: relay thread <id>" });
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
  throw new CliError({ message: `Unknown command: ${command}` });
};
