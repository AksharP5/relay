import type { SelectOption, TextareaRenderable } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid";
import { For, Show, createMemo, createSignal } from "solid-js";
import { commandsFor, findCommand, type ResolvedCommand } from "../commands/registry.ts";
import type { Harness, HarnessCapabilities, RelayMessage, RelayThread, Skin } from "../domain.ts";
import type { TuiController, TuiSnapshot } from "./controller.ts";
import { harnessColor, harnessName, skinTheme, type RelayTheme } from "./theme.ts";

export interface RelayAppProps {
  readonly controller: TuiController;
  readonly initial: TuiSnapshot;
}

const selectorOptions: ReadonlyArray<SelectOption> = [
  {
    name: "Codex",
    description: "Continue the task with the Codex harness",
    value: "codex" satisfies Harness,
  },
  {
    name: "OpenCode",
    description: "Continue the task with the OpenCode harness",
    value: "opencode" satisfies Harness,
  },
];

const skinOptions: ReadonlyArray<SelectOption> = [
  {
    name: "Codex",
    description: "Use the Codex-compatible interface and command vocabulary",
    value: "codex" satisfies Skin,
  },
  {
    name: "OpenCode",
    description: "Use the OpenCode-compatible interface and command vocabulary",
    value: "opencode" satisfies Skin,
  },
];

const errorMessage = (cause: unknown) => {
  if (cause && typeof cause === "object" && "message" in cause) return String(cause.message);
  return String(cause);
};

type Overlay =
  | "harness"
  | "skin"
  | "model"
  | "commands"
  | "command-settings"
  | "command-implementation"
  | "tasks"
  | "status"
  | null;

const parseSlashCommand = (value: string) => {
  if (!value.startsWith("/")) return null;
  const [name = "", ...rest] = value.slice(1).trim().split(/\s+/);
  return { name, arguments: rest.join(" ") };
};

const Message = (props: {
  readonly message: RelayMessage;
  readonly palette: RelayTheme;
  readonly skin: Skin;
}) => {
  const label = () => (props.message.role === "user" ? "You" : harnessName(props.message.harness));
  const color = () =>
    props.message.role === "user"
      ? props.palette.text
      : harnessColor(props.message.harness, props.palette);

  return (
    <box flexDirection="column" paddingBottom={1}>
      <text fg={color()}>
        <strong>
          {props.skin === "codex"
            ? `${props.message.role === "user" ? "›" : "•"} ${label()}`
            : label()}
        </strong>
      </text>
      <text fg={props.palette.text} wrapMode="word">
        {props.message.content}
      </text>
    </box>
  );
};

export const RelayApp = (props: RelayAppProps) => {
  const renderer = useRenderer();
  const dimensions = useTerminalDimensions();
  const [snapshot, setSnapshot] = createSignal(props.initial);
  const [selectedHarness, setSelectedHarness] = createSignal<Harness>(
    props.initial.thread?.activeHarness ?? "codex",
  );
  const [capabilities, setCapabilities] = createSignal(props.initial.capabilities);
  const [selectedModels, setSelectedModels] = createSignal<Partial<Record<Harness, string>>>({
    ...(props.initial.thread?.bindings.codex?.model
      ? { codex: props.initial.thread.bindings.codex.model }
      : {}),
    ...(props.initial.thread?.bindings.opencode?.model
      ? { opencode: props.initial.thread.bindings.opencode.model }
      : {}),
  });
  const [overlay, setOverlay] = createSignal<Overlay>(null);
  const [configuredCommand, setConfiguredCommand] = createSignal<ResolvedCommand | null>(null);
  const [tasks, setTasks] = createSignal<ReadonlyArray<RelayThread>>([]);
  const [draft, setDraft] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [capabilitiesLoading, setCapabilitiesLoading] = createSignal(false);
  const [pendingPrompt, setPendingPrompt] = createSignal("");
  const [streamingResponse, setStreamingResponse] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [notice, setNotice] = createSignal<string | null>(null);
  let composer: TextareaRenderable | undefined;

  const skin = createMemo<Skin>(() =>
    snapshot().preferences.switchSkinWithHarness ? selectedHarness() : snapshot().preferences.skin,
  );
  const palette = createMemo(() => skinTheme(skin()));
  const title = createMemo(() => snapshot().thread?.title ?? "New Relay task");
  const cwd = createMemo(() => snapshot().thread?.cwd ?? process.cwd());
  const compact = createMemo(() => dimensions().width < 72);
  const harnessStatus = (harness: Harness) =>
    snapshot().harnesses.find((status) => status.harness === harness);
  const activeCapabilities = createMemo<HarnessCapabilities>(
    () =>
      capabilities().find((item) => item.harness === selectedHarness()) ?? {
        harness: selectedHarness(),
        models: [],
        commands: [],
      },
  );
  const selectedModel = createMemo(
    () =>
      selectedModels()[selectedHarness()] ??
      activeCapabilities().models.find((model) => model.isDefault)?.id,
  );
  const commandCapabilities = createMemo(() =>
    capabilities().find((item) => item.harness === skin()),
  );
  const activeCommands = createMemo(() => {
    const dynamic = commandCapabilities()?.commands.filter(
      (command) => command.source === "native",
    );
    return commandsFor({
      skin: skin(),
      harness: selectedHarness(),
      preferences: snapshot().preferences,
      ...(skin() === "opencode" && dynamic ? { dynamic } : {}),
    });
  });
  const commandQuery = createMemo(() => {
    const parsed = parseSlashCommand(draft());
    return parsed && !draft().slice(1).includes(" ") ? parsed.name.toLowerCase() : null;
  });
  const visibleCommands = createMemo(() => {
    const query = commandQuery();
    if (query === null) return activeCommands();
    return activeCommands().filter(
      (command) =>
        command.name.toLowerCase().startsWith(query) ||
        command.aliases?.some((alias) => alias.toLowerCase().startsWith(query)) ||
        command.description.toLowerCase().includes(query),
    );
  });

  const focusComposer = () => setTimeout(() => composer?.focus(), 0);

  const closeOverlay = () => {
    setOverlay(null);
    focusComposer();
  };

  const chooseHarness = async (harness: Harness) => {
    setSelectedHarness(harness);
    closeOverlay();
    setError(null);
    try {
      const thread = await props.controller.switchHarness(harness);
      if (thread)
        setSnapshot((current) => ({
          ...current,
          thread: thread.thread,
          preferences: thread.preferences,
        }));
      const nextPreferences = thread?.preferences ?? snapshot().preferences;
      const desiredSkin = nextPreferences.switchSkinWithHarness ? harness : nextPreferences.skin;
      const needed = [...new Set([harness, desiredSkin])];
      const missing = needed.filter(
        (neededHarness) => !capabilities().some((item) => item.harness === neededHarness),
      );
      if (missing.length > 0) {
        setCapabilitiesLoading(true);
        const discovered = await Promise.all(
          missing.map((neededHarness) => props.controller.refreshCapabilities(neededHarness)),
        );
        setCapabilities((current) => {
          const names = new Set(discovered.map((item) => item.harness));
          return [...current.filter((item) => !names.has(item.harness)), ...discovered];
        });
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setCapabilitiesLoading(false);
    }
  };

  const chooseSkin = async (nextSkin: Skin) => {
    closeOverlay();
    setError(null);
    try {
      const preferences = await props.controller.setSkin(nextSkin);
      setSnapshot((current) => ({ ...current, preferences }));
      if (!capabilities().some((item) => item.harness === nextSkin)) {
        setCapabilitiesLoading(true);
        const discovered = await props.controller.refreshCapabilities(nextSkin);
        setCapabilities((current) => [
          ...current.filter((item) => item.harness !== nextSkin),
          discovered,
        ]);
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setCapabilitiesLoading(false);
    }
  };

  const toggleSkinSwitching = async () => {
    setError(null);
    try {
      const preferences = await props.controller.setSwitchSkinWithHarness(
        !snapshot().preferences.switchSkinWithHarness,
      );
      setSnapshot((current) => ({ ...current, preferences }));
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const chooseCommandImplementation = async (value: string) => {
    const command = configuredCommand();
    if (!command) return;
    setError(null);
    try {
      const implementation =
        value === "default"
          ? undefined
          : value === "relay" || value === "codex" || value === "opencode"
            ? value
            : undefined;
      const preferences = await props.controller.setCommandImplementation(
        command.action,
        implementation,
      );
      setSnapshot((current) => ({ ...current, preferences }));
      setConfiguredCommand(null);
      closeOverlay();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const openTasks = async () => {
    setError(null);
    try {
      setTasks(await props.controller.listTasks());
      setOverlay("tasks");
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const selectTask = async (threadId: string) => {
    setError(null);
    try {
      const next = await props.controller.selectTask(threadId);
      setSnapshot((current) => ({ ...current, ...next }));
      setSelectedHarness(next.thread?.activeHarness ?? selectedHarness());
      closeOverlay();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const createTask = async () => {
    setError(null);
    try {
      const thread = await props.controller.newTask(selectedHarness());
      setSnapshot((current) => ({ ...current, thread, messages: [] }));
      closeOverlay();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const executeControl = async (command: ResolvedCommand) => {
    const action =
      command.action === "context.compact"
        ? "compact"
        : command.action === "session.share"
          ? "share"
          : command.action === "session.unshare"
            ? "unshare"
            : undefined;
    if (!action) return false;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setNotice(await props.controller.control(action, selectedHarness()));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
      focusComposer();
    }
    return true;
  };

  const chooseModel = (model: string) => {
    setSelectedModels((current) => ({ ...current, [selectedHarness()]: model }));
    closeOverlay();
  };

  const insertCommand = (command: ResolvedCommand) => {
    if (!command.available) {
      setError(command.disabledReason ?? `/${command.name} is not available`);
      closeOverlay();
      return;
    }
    if (command.source === "relay") {
      composer?.clear();
      setDraft("");
      if (command.action === "model.select") setOverlay("model");
      else if (command.action === "harness.select") setOverlay("harness");
      else if (command.action === "skin.select" || command.action === "theme.select")
        setOverlay("skin");
      else if (command.action === "command.configure") setOverlay("command-settings");
      else if (command.action === "app.exit") renderer.destroy();
      else if (command.action === "help.show") setOverlay("commands");
      else if (command.action === "session.open") void openTasks();
      else if (command.action === "session.new") void createTask();
      else if (command.action === "status.show") setOverlay("status");
      else setError(`/${command.name} is not implemented yet`);
      return;
    }
    if (
      command.action === "context.compact" ||
      command.action === "session.share" ||
      command.action === "session.unshare"
    ) {
      composer?.clear();
      setDraft("");
      closeOverlay();
      void executeControl(command);
      return;
    }
    const value = `/${command.name}${command.acceptsArguments ? " " : ""}`;
    composer?.setText(value);
    setDraft(value);
    closeOverlay();
  };

  const submit = async () => {
    const prompt = composer?.plainText.trim() ?? "";
    if (!prompt || busy()) return;

    const slash = parseSlashCommand(prompt);
    const resolvedCommand = slash ? findCommand(activeCommands(), slash.name) : undefined;
    if (slash && !resolvedCommand) {
      setError(`/${slash.name} is not available in the ${harnessName(skin())} interface`);
      return;
    }
    if (resolvedCommand && !resolvedCommand.available) {
      setError(resolvedCommand.disabledReason ?? `/${resolvedCommand.name} is not available`);
      return;
    }
    if (resolvedCommand?.source === "relay") {
      composer?.clear();
      setDraft("");
      insertCommand(resolvedCommand);
      return;
    }
    if (
      resolvedCommand &&
      (resolvedCommand.action === "context.compact" ||
        resolvedCommand.action === "session.share" ||
        resolvedCommand.action === "session.unshare")
    ) {
      composer?.clear();
      setDraft("");
      await executeControl(resolvedCommand);
      return;
    }
    const nativeCommand = resolvedCommand?.source === "native" ? resolvedCommand : undefined;

    composer?.clear();
    setDraft("");
    const model = selectedModel();
    setPendingPrompt(prompt);
    setStreamingResponse("");
    setBusy(true);
    setError(null);
    try {
      const next = await props.controller.ask({
        prompt,
        harness: selectedHarness(),
        ...(model ? { model } : {}),
        ...(nativeCommand ? { command: nativeCommand.name } : {}),
        onProgress: (progress) => {
          if (progress.type === "text") setStreamingResponse(progress.text);
        },
      });
      setSnapshot((current) => ({ ...current, ...next }));
      setSelectedHarness(next.thread?.activeHarness ?? selectedHarness());
      const binding = next.thread?.bindings[selectedHarness()];
      if (binding?.model) {
        setSelectedModels((current) => ({ ...current, [selectedHarness()]: binding.model }));
      }
      setPendingPrompt("");
      setStreamingResponse("");
    } catch (cause) {
      setError(errorMessage(cause));
      composer?.setText(prompt);
      setDraft(prompt);
      setPendingPrompt("");
      setStreamingResponse("");
    } finally {
      setBusy(false);
      focusComposer();
    }
  };

  useKeyboard((key) => {
    if (key.ctrl && key.name === "r") {
      key.preventDefault();
      if (!busy()) setOverlay((current) => (current === "harness" ? null : "harness"));
      return;
    }
    if (key.ctrl && key.name === "o") {
      key.preventDefault();
      if (!busy()) setOverlay((current) => (current === "model" ? null : "model"));
      return;
    }
    if (key.ctrl && key.name === "t") {
      key.preventDefault();
      if (!busy()) setOverlay((current) => (current === "skin" ? null : "skin"));
      return;
    }
    if (overlay() === "skin" && key.ctrl && key.name === "l") {
      key.preventDefault();
      void toggleSkinSwitching();
      return;
    }
    if (overlay() && key.name === "escape") {
      key.preventDefault();
      closeOverlay();
    }
  });

  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      backgroundColor={palette().background}
      paddingLeft={compact() ? 1 : 2}
      paddingRight={compact() ? 1 : 2}
    >
      <box height={3} flexDirection="row" justifyContent="space-between" alignItems="center">
        <box flexDirection="column">
          <text fg={palette().text}>
            <strong>{title()}</strong>
          </text>
          <text fg={palette().muted}>{cwd()}</text>
        </box>
        <text fg={palette().subtle}>
          {harnessName(selectedHarness())} engine · {harnessName(skin())} skin
        </text>
      </box>

      <scrollbox
        flexGrow={1}
        flexShrink={1}
        flexBasis={0}
        minHeight={1}
        width="100%"
        paddingTop={1}
        stickyScroll
        stickyStart="bottom"
      >
        <Show
          when={snapshot().messages.length > 0}
          fallback={
            <box flexDirection="column" paddingTop={2}>
              <text fg={palette().text}>
                {skin() === "opencode" ? "Build something great." : "What do you want to build?"}
              </text>
              <text fg={palette().muted}>
                Write a message below, then switch between Codex and OpenCode whenever the work
                calls for it.
              </text>
            </box>
          }
        >
          <For each={snapshot().messages}>
            {(message) => <Message message={message} palette={palette()} skin={skin()} />}
          </For>
        </Show>
        <Show when={pendingPrompt().length > 0}>
          <box flexDirection="column" paddingBottom={1}>
            <text fg={palette().text}>
              <strong>You</strong>
            </text>
            <text fg={palette().text} wrapMode="word">
              {pendingPrompt()}
            </text>
          </box>
        </Show>
        <Show when={busy()}>
          <Show
            when={streamingResponse().length > 0}
            fallback={
              <text fg={harnessColor(selectedHarness(), palette())}>
                {harnessName(selectedHarness())} is working…
              </text>
            }
          >
            <box flexDirection="column" paddingBottom={1}>
              <text fg={harnessColor(selectedHarness(), palette())}>
                <strong>{harnessName(selectedHarness())}</strong>
              </text>
              <text fg={palette().text} wrapMode="word">
                {streamingResponse()}
              </text>
            </box>
          </Show>
        </Show>
      </scrollbox>

      <Show when={error()}>
        {(message) => (
          <box border={["left"]} borderColor={palette().error} paddingLeft={1}>
            <text fg={palette().error}>{message()}</text>
          </box>
        )}
      </Show>
      <Show when={notice()}>
        {(message) => (
          <box border={["left"]} borderColor={palette().border} paddingLeft={1}>
            <text fg={palette().muted}>{message()}</text>
          </box>
        )}
      </Show>

      <Show when={overlay() === "harness"}>
        <box
          height={8}
          flexDirection="column"
          border
          borderColor={palette().border}
          backgroundColor={palette().panelRaised}
          paddingLeft={1}
          paddingRight={1}
          marginBottom={1}
          title="Select harness"
        >
          <select
            focused
            height={5}
            options={selectorOptions.map((option) => {
              const harness = option.value as Harness;
              const status = harnessStatus(harness);
              const readiness = status?.installed && status.healthy ? "ready" : "not available";
              return { ...option, description: `${option.description} · ${readiness}` };
            })}
            selectedIndex={selectedHarness() === "codex" ? 0 : 1}
            backgroundColor={palette().panelRaised}
            focusedBackgroundColor={palette().panelRaised}
            selectedBackgroundColor={palette().border}
            selectedTextColor={palette().text}
            textColor={palette().muted}
            descriptionColor={palette().subtle}
            selectedDescriptionColor={palette().muted}
            onSelect={(_index, option) => {
              if (option?.value === "codex" || option?.value === "opencode") {
                void chooseHarness(option.value);
              }
            }}
          />
        </box>
      </Show>

      <Show when={overlay() === "skin"}>
        <box
          height={8}
          flexDirection="column"
          border
          borderColor={palette().border}
          backgroundColor={palette().panelRaised}
          paddingLeft={1}
          paddingRight={1}
          marginBottom={1}
          title="Select interface"
        >
          <text fg={palette().muted}>
            Ctrl+L: switch with harness{" "}
            {snapshot().preferences.switchSkinWithHarness ? "on" : "off"}
          </text>
          <select
            focused
            height={4}
            options={[...skinOptions]}
            selectedIndex={skin() === "codex" ? 0 : 1}
            backgroundColor={palette().panelRaised}
            focusedBackgroundColor={palette().panelRaised}
            selectedBackgroundColor={palette().border}
            selectedTextColor={palette().text}
            textColor={palette().muted}
            descriptionColor={palette().subtle}
            selectedDescriptionColor={palette().muted}
            onSelect={(_index, option) => {
              if (option?.value === "codex" || option?.value === "opencode") {
                void chooseSkin(option.value);
              }
            }}
          />
        </box>
      </Show>

      <Show when={overlay() === "model"}>
        <box
          height={10}
          flexDirection="column"
          border
          borderColor={palette().border}
          backgroundColor={palette().panelRaised}
          paddingLeft={1}
          paddingRight={1}
          marginBottom={1}
          title={`${harnessName(selectedHarness())} model`}
        >
          <select
            focused
            height={7}
            options={activeCapabilities().models.map((model) => ({
              name: model.name,
              description: model.description ?? model.id,
              value: model.id,
            }))}
            selectedIndex={Math.max(
              0,
              activeCapabilities().models.findIndex((model) => model.id === selectedModel()),
            )}
            backgroundColor={palette().panelRaised}
            focusedBackgroundColor={palette().panelRaised}
            selectedBackgroundColor={palette().border}
            selectedTextColor={palette().text}
            textColor={palette().muted}
            descriptionColor={palette().subtle}
            selectedDescriptionColor={palette().muted}
            onSelect={(_index, option) => {
              if (typeof option?.value === "string") chooseModel(option.value);
            }}
          />
        </box>
      </Show>

      <Show when={overlay() === "commands" || commandQuery() !== null}>
        <box
          height={Math.min(10, Math.max(4, visibleCommands().length + 3))}
          flexDirection="column"
          border
          borderColor={palette().border}
          backgroundColor={palette().panelRaised}
          paddingLeft={1}
          paddingRight={1}
          marginBottom={1}
          title={`${harnessName(selectedHarness())} commands`}
        >
          <select
            focused
            height={Math.min(7, Math.max(1, visibleCommands().length))}
            options={visibleCommands().map((command) => ({
              name: `${command.available ? "" : "× "}/${command.name}`,
              description: command.available
                ? `${command.description} · ${command.implementation}`
                : (command.disabledReason ?? command.description),
              value: command.name,
            }))}
            backgroundColor={palette().panelRaised}
            focusedBackgroundColor={palette().panelRaised}
            selectedBackgroundColor={palette().border}
            selectedTextColor={palette().text}
            textColor={palette().muted}
            descriptionColor={palette().subtle}
            selectedDescriptionColor={palette().muted}
            onSelect={(_index, option) => {
              const command = activeCommands().find((item) => item.name === option?.value);
              if (command) insertCommand(command);
            }}
          />
        </box>
      </Show>

      <Show when={overlay() === "command-settings"}>
        <box
          height={Math.min(12, activeCommands().length + 4)}
          flexDirection="column"
          border
          borderColor={palette().border}
          backgroundColor={palette().panelRaised}
          paddingLeft={1}
          paddingRight={1}
          marginBottom={1}
          title="Command behavior"
        >
          <text fg={palette().muted}>
            Commands use the selected interface by default. Native-only behavior is identified in
            the palette.
          </text>
          <select
            focused
            height={Math.min(8, activeCommands().length)}
            options={activeCommands().map((command) => ({
              name: `/${command.name}`,
              description: `${command.implementation}${command.available ? "" : " · unavailable on this harness"}`,
              value: command.name,
            }))}
            backgroundColor={palette().panelRaised}
            focusedBackgroundColor={palette().panelRaised}
            selectedBackgroundColor={palette().border}
            selectedTextColor={palette().text}
            textColor={palette().muted}
            descriptionColor={palette().subtle}
            selectedDescriptionColor={palette().muted}
            onSelect={(_index, option) => {
              const command = activeCommands().find((item) => item.name === option?.value);
              if (command) {
                setConfiguredCommand(command);
                setOverlay("command-implementation");
              }
            }}
          />
        </box>
      </Show>

      <Show when={overlay() === "command-implementation" && configuredCommand()}>
        <box
          height={9}
          flexDirection="column"
          border
          borderColor={palette().border}
          backgroundColor={palette().panelRaised}
          paddingLeft={1}
          paddingRight={1}
          marginBottom={1}
          title={`/${configuredCommand()?.name ?? "command"} behavior`}
        >
          <select
            focused
            height={6}
            options={[
              {
                name: `Interface default (${configuredCommand()?.defaultImplementation ?? "relay"})`,
                description: "Use the behavior provided by the selected interface",
                value: "default",
              },
              ...(configuredCommand()?.allowedImplementations ?? []).map((implementation) => ({
                name: `${harnessName(implementation === "relay" ? selectedHarness() : implementation)}${implementation === "relay" ? " translation" : " native"}`,
                description:
                  implementation === "relay"
                    ? "Relay-owned portable behavior"
                    : `Requires the ${harnessName(implementation)} harness`,
                value: implementation,
              })),
            ]}
            backgroundColor={palette().panelRaised}
            focusedBackgroundColor={palette().panelRaised}
            selectedBackgroundColor={palette().border}
            selectedTextColor={palette().text}
            textColor={palette().muted}
            descriptionColor={palette().subtle}
            selectedDescriptionColor={palette().muted}
            onSelect={(_index, option) => {
              if (typeof option?.value === "string") void chooseCommandImplementation(option.value);
            }}
          />
        </box>
      </Show>

      <Show when={overlay() === "tasks"}>
        <box
          height={Math.min(12, Math.max(5, tasks().length + 3))}
          flexDirection="column"
          border
          borderColor={palette().border}
          backgroundColor={palette().panelRaised}
          paddingLeft={1}
          paddingRight={1}
          marginBottom={1}
          title={skin() === "opencode" ? "Sessions" : "Resume task"}
        >
          <select
            focused
            height={Math.min(9, Math.max(2, tasks().length))}
            options={tasks().map((task) => ({
              name: task.title,
              description: `${harnessName(task.activeHarness)} · ${task.lastSeq} messages`,
              value: task.id,
            }))}
            backgroundColor={palette().panelRaised}
            focusedBackgroundColor={palette().panelRaised}
            selectedBackgroundColor={palette().border}
            selectedTextColor={palette().text}
            textColor={palette().muted}
            descriptionColor={palette().subtle}
            selectedDescriptionColor={palette().muted}
            onSelect={(_index, option) => {
              if (typeof option?.value === "string") void selectTask(option.value);
            }}
          />
        </box>
      </Show>

      <Show when={overlay() === "status"}>
        <box
          height={9}
          flexDirection="column"
          border
          borderColor={palette().border}
          backgroundColor={palette().panelRaised}
          paddingLeft={2}
          paddingRight={2}
          marginBottom={1}
          title="Relay status"
        >
          <text fg={palette().text}>Harness: {harnessName(selectedHarness())}</text>
          <text fg={palette().text}>Interface: {harnessName(skin())}</text>
          <text fg={palette().muted}>
            Skin switching: {snapshot().preferences.switchSkinWithHarness ? "linked" : "pinned"}
          </text>
          <text fg={palette().muted}>Model: {selectedModel() ?? "native default"}</text>
          <text fg={palette().muted}>Messages: {snapshot().thread?.lastSeq ?? 0}</text>
        </box>
      </Show>

      <box
        flexDirection="column"
        border={["left"]}
        borderColor={busy() ? harnessColor(selectedHarness(), palette()) : palette().border}
        backgroundColor={palette().panel}
        paddingLeft={1}
        paddingRight={1}
        paddingTop={1}
        paddingBottom={1}
      >
        <textarea
          ref={(value) => (composer = value)}
          focused={!overlay() && commandQuery() === null}
          minHeight={1}
          maxHeight={Math.max(4, Math.floor(dimensions().height / 3))}
          placeholder={busy() ? `${harnessName(selectedHarness())} is working…` : "Message Relay"}
          placeholderColor={palette().subtle}
          backgroundColor={palette().panel}
          focusedBackgroundColor={palette().panel}
          textColor={palette().text}
          focusedTextColor={palette().text}
          cursorColor={palette().text}
          keyBindings={[
            { name: "return", action: "submit" },
            { name: "kpenter", action: "submit" },
            { name: "return", shift: true, action: "newline" },
          ]}
          onSubmit={() => void submit()}
          onContentChange={() => {
            const value = composer?.plainText ?? "";
            setDraft(value);
            if (!value.startsWith("/") && overlay() === "commands") setOverlay(null);
          }}
          onKeyDown={(key) => {
            if (busy()) key.preventDefault();
          }}
        />
        <box flexDirection="row" justifyContent="space-between" paddingTop={1}>
          <text
            fg={harnessColor(selectedHarness(), palette())}
            onMouseDown={() => {
              if (!busy()) setOverlay("harness");
            }}
          >
            {harnessName(selectedHarness())} ▾
          </text>
          <text
            fg={palette().muted}
            onMouseDown={() => {
              if (!busy()) setOverlay("skin");
            }}
          >
            {harnessName(skin())} skin
            {snapshot().preferences.switchSkinWithHarness ? " · linked" : ""} ▾
          </text>
          <text
            fg={palette().muted}
            onMouseDown={() => {
              if (!busy()) setOverlay("model");
            }}
          >
            {capabilitiesLoading()
              ? "Loading capabilities…"
              : (selectedModel() ?? "Native default")}{" "}
            ▾
          </text>
          <text fg={palette().subtle}>
            {compact()
              ? "^R harness · ^T skin · ^O model"
              : "Ctrl+R harness · Ctrl+T skin · Ctrl+O model · / commands"}
          </text>
        </box>
      </box>
    </box>
  );
};

export const launchTui = (controller: TuiController) =>
  controller.load().then(async (initial) => {
    const { render } = await import("@opentui/solid");
    await new Promise<void>((resolve, reject) => {
      void render(() => <RelayApp controller={controller} initial={initial} />, {
        backgroundColor: skinTheme(initial.preferences.skin).background,
        exitOnCtrlC: true,
        screenMode: "alternate-screen",
        targetFps: 30,
        onDestroy: resolve,
      }).catch(reject);
    });
  });
