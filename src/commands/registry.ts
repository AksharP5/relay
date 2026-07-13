import type {
  CommandImplementation,
  Harness,
  HarnessCommand,
  RelayPreferences,
  Skin,
} from "../domain.ts";

export type CommandAction =
  | "app.exit"
  | "command.configure"
  | "context.compact"
  | "harness.select"
  | "help.show"
  | "history.redo"
  | "history.undo"
  | "model.select"
  | "review.start"
  | "session.new"
  | "session.open"
  | "session.share"
  | "session.unshare"
  | "skin.select"
  | "status.show"
  | "theme.select";

interface CommandSpec {
  readonly action: CommandAction;
  readonly name: string;
  readonly aliases?: ReadonlyArray<string>;
  readonly description: string;
  readonly implementation: CommandImplementation;
  readonly acceptsArguments?: boolean;
}

export interface ResolvedCommand extends CommandSpec {
  readonly defaultImplementation: CommandImplementation;
  readonly allowedImplementations: ReadonlyArray<CommandImplementation>;
  readonly source: "relay" | "native";
  readonly available: boolean;
  readonly disabledReason?: string;
}

const shared: ReadonlyArray<CommandSpec> = [
  {
    action: "harness.select",
    name: "harness",
    description: "Choose the underlying coding harness",
    implementation: "relay",
  },
  {
    action: "skin.select",
    name: "skin",
    description: "Choose the Codex or OpenCode interface",
    implementation: "relay",
  },
  {
    action: "command.configure",
    name: "commands",
    description: "Customize command behavior",
    implementation: "relay",
  },
  {
    action: "help.show",
    name: "help",
    description: "Show commands for this interface",
    implementation: "relay",
  },
];

const codex: ReadonlyArray<CommandSpec> = [
  {
    action: "model.select",
    name: "model",
    description: "Choose a model and reasoning effort",
    implementation: "relay",
  },
  {
    action: "session.open",
    name: "resume",
    aliases: ["session", "sessions"],
    description: "Resume a saved task",
    implementation: "relay",
  },
  {
    action: "session.new",
    name: "new",
    description: "Start a new task",
    implementation: "relay",
  },
  {
    action: "context.compact",
    name: "compact",
    description: "Compact the current context",
    implementation: "codex",
  },
  {
    action: "review.start",
    name: "review",
    description: "Review the working tree",
    implementation: "codex",
    acceptsArguments: true,
  },
  {
    action: "status.show",
    name: "status",
    description: "Show task and harness status",
    implementation: "relay",
  },
  {
    action: "theme.select",
    name: "theme",
    description: "Choose the interface theme",
    implementation: "relay",
  },
  {
    action: "app.exit",
    name: "quit",
    aliases: ["exit"],
    description: "Exit Relay",
    implementation: "relay",
  },
];

const opencode: ReadonlyArray<CommandSpec> = [
  {
    action: "model.select",
    name: "models",
    aliases: ["model", "mo"],
    description: "Switch model",
    implementation: "relay",
  },
  {
    action: "session.open",
    name: "sessions",
    aliases: ["session", "resume", "continue"],
    description: "Switch session",
    implementation: "relay",
  },
  {
    action: "session.new",
    name: "new",
    aliases: ["clear"],
    description: "Start a new session",
    implementation: "relay",
  },
  {
    action: "context.compact",
    name: "compact",
    aliases: ["summarize"],
    description: "Compact session",
    implementation: "opencode",
  },
  {
    action: "history.undo",
    name: "undo",
    description: "Undo the previous message and file changes",
    implementation: "opencode",
  },
  {
    action: "history.redo",
    name: "redo",
    description: "Redo the previously undone message",
    implementation: "opencode",
  },
  {
    action: "session.share",
    name: "share",
    description: "Share the current OpenCode session",
    implementation: "opencode",
  },
  {
    action: "session.unshare",
    name: "unshare",
    description: "Stop sharing the OpenCode session",
    implementation: "opencode",
  },
  {
    action: "status.show",
    name: "status",
    description: "View task and harness status",
    implementation: "relay",
  },
  {
    action: "theme.select",
    name: "themes",
    aliases: ["theme"],
    description: "Switch theme",
    implementation: "relay",
  },
  {
    action: "app.exit",
    name: "exit",
    aliases: ["quit", "q"],
    description: "Exit Relay",
    implementation: "relay",
  },
];

const requiredHarness = (implementation: CommandImplementation) =>
  implementation === "codex" || implementation === "opencode" ? implementation : undefined;

const allowedByAction: Readonly<Record<CommandAction, ReadonlyArray<CommandImplementation>>> = {
  "app.exit": ["relay"],
  "command.configure": ["relay"],
  "context.compact": ["codex", "opencode"],
  "harness.select": ["relay"],
  "help.show": ["relay"],
  "history.redo": ["opencode"],
  "history.undo": ["opencode"],
  "model.select": ["relay"],
  "review.start": ["codex", "opencode"],
  "session.new": ["relay"],
  "session.open": ["relay"],
  "session.share": ["opencode"],
  "session.unshare": ["opencode"],
  "skin.select": ["relay"],
  "status.show": ["relay"],
  "theme.select": ["relay"],
};

const resolve = (
  spec: CommandSpec,
  harness: Harness,
  preferences: RelayPreferences,
  dynamicNames: ReadonlySet<string>,
): ResolvedCommand => {
  const allowedImplementations = allowedByAction[spec.action];
  const override = preferences.commandImplementations[spec.action];
  const implementation =
    override && allowedImplementations.includes(override) ? override : spec.implementation;
  const required = requiredHarness(implementation);
  const harnessAvailable = required === undefined || required === harness;
  const nativeCommandAvailable =
    implementation !== "opencode" || spec.action !== "review.start" || dynamicNames.has("review");
  const available = harnessAvailable && nativeCommandAvailable;
  return {
    ...spec,
    defaultImplementation: spec.implementation,
    allowedImplementations,
    implementation,
    source: implementation === "relay" ? "relay" : "native",
    available,
    ...(!harnessAvailable
      ? {
          disabledReason: `${spec.name} uses ${required === "codex" ? "Codex" : "OpenCode"} native behavior. Switch the underlying harness to use it.`,
        }
      : !nativeCommandAvailable
        ? {
            disabledReason:
              "This behavior needs an OpenCode /review command from your project or configuration.",
          }
        : {}),
  };
};

export const commandsFor = (input: {
  readonly skin: Skin;
  readonly harness: Harness;
  readonly preferences: RelayPreferences;
  readonly dynamic?: ReadonlyArray<HarnessCommand>;
}): ReadonlyArray<ResolvedCommand> => {
  const specs = [...shared, ...(input.skin === "codex" ? codex : opencode)];
  const dynamicNames = new Set((input.dynamic ?? []).map((command) => command.name));
  const resolved = specs.map((spec) =>
    resolve(spec, input.harness, input.preferences, dynamicNames),
  );
  const names = new Set(resolved.flatMap((command) => [command.name, ...(command.aliases ?? [])]));
  const dynamic = (input.skin === "opencode" ? (input.dynamic ?? []) : [])
    .filter((command) => !names.has(command.name))
    .map(
      (command): ResolvedCommand => ({
        action: `dynamic.${command.name}` as CommandAction,
        name: command.name,
        description: command.description,
        implementation: "opencode",
        defaultImplementation: "opencode",
        allowedImplementations: ["opencode"],
        source: "native",
        ...(command.acceptsArguments ? { acceptsArguments: true } : {}),
        available: input.harness === "opencode",
        ...(input.harness !== "opencode"
          ? {
              disabledReason: `/${command.name} is provided by OpenCode. Switch the underlying harness to OpenCode to use it.`,
            }
          : {}),
      }),
    );
  return [...resolved, ...dynamic];
};

export const findCommand = (commands: ReadonlyArray<ResolvedCommand>, name: string) =>
  commands.find((command) => command.name === name || command.aliases?.includes(name));
