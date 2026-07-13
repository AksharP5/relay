import { describe, expect, it } from "vitest";
import { commandsFor, findCommand } from "../src/commands/registry.ts";
import type { RelayPreferences } from "../src/domain.ts";

const preferences: RelayPreferences = {
  skin: "opencode",
  switchSkinWithHarness: false,
  commandImplementations: {},
};

describe("semantic command registry", () => {
  it.each([
    ["codex", "codex", "resume", true],
    ["codex", "opencode", "compact", false],
    ["opencode", "codex", "sessions", true],
    ["opencode", "opencode", "share", true],
  ] as const)("%s skin over %s resolves /%s availability", (skin, harness, command, available) => {
    expect(findCommand(commandsFor({ skin, harness, preferences }), command)?.available).toBe(
      available,
    );
  });

  it("keeps OpenCode-native commands visible but disabled over Codex", () => {
    const commands = commandsFor({ skin: "opencode", harness: "codex", preferences });
    expect(findCommand(commands, "sessions")?.available).toBe(true);
    expect(findCommand(commands, "resume")?.action).toBe("session.open");
    expect(findCommand(commands, "share")).toMatchObject({
      available: false,
      implementation: "opencode",
      disabledReason:
        "share uses OpenCode native behavior. Switch the underlying harness to use it.",
    });
  });

  it("honors a per-command implementation override", () => {
    const commands = commandsFor({
      skin: "opencode",
      harness: "codex",
      preferences: {
        ...preferences,
        commandImplementations: { "context.compact": "codex" },
      },
    });
    expect(findCommand(commands, "compact")).toMatchObject({
      available: true,
      implementation: "codex",
    });
  });

  it("ignores an unsupported persisted override", () => {
    const commands = commandsFor({
      skin: "opencode",
      harness: "codex",
      preferences: {
        ...preferences,
        commandImplementations: { "session.share": "codex" },
      },
    });
    expect(findCommand(commands, "share")).toMatchObject({
      available: false,
      implementation: "opencode",
      allowedImplementations: ["opencode"],
    });
  });

  it("offers OpenCode review behavior only when /review was discovered", () => {
    const configured: RelayPreferences = {
      ...preferences,
      commandImplementations: { "review.start": "opencode" },
    };
    const unavailable = findCommand(
      commandsFor({ skin: "codex", harness: "opencode", preferences: configured }),
      "review",
    );
    expect(unavailable).toMatchObject({
      available: false,
      disabledReason:
        "This behavior needs an OpenCode /review command from your project or configuration.",
    });

    const available = findCommand(
      commandsFor({
        skin: "codex",
        harness: "opencode",
        preferences: configured,
        dynamic: [{ name: "review", description: "Project review", source: "native" }],
      }),
      "review",
    );
    expect(available).toMatchObject({ available: true, implementation: "opencode" });
  });

  it("does not pretend an OpenCode prompt command is portable", () => {
    const commands = commandsFor({
      skin: "opencode",
      harness: "codex",
      preferences,
      dynamic: [
        {
          name: "commit",
          description: "Create a commit",
          source: "native",
          acceptsArguments: true,
        },
      ],
    });
    expect(findCommand(commands, "commit")).toMatchObject({
      available: false,
      disabledReason:
        "/commit is provided by OpenCode. Switch the underlying harness to OpenCode to use it.",
    });
  });
});
