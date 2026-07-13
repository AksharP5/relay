import type { SelectOption, TextareaRenderable } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid";
import { For, Show, createMemo, createSignal } from "solid-js";
import type { Harness, HarnessCapabilities, HarnessCommand, RelayMessage } from "../domain.ts";
import type { TuiController, TuiSnapshot } from "./controller.ts";
import { harnessColor, harnessName, theme } from "./theme.ts";

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

const errorMessage = (cause: unknown) => {
  if (cause && typeof cause === "object" && "message" in cause) return String(cause.message);
  return String(cause);
};

type Overlay = "harness" | "model" | "commands" | null;

const parseSlashCommand = (value: string) => {
  if (!value.startsWith("/")) return null;
  const [name = "", ...rest] = value.slice(1).trim().split(/\s+/);
  return { name, arguments: rest.join(" ") };
};

const Message = (props: { readonly message: RelayMessage }) => {
  const label = () => (props.message.role === "user" ? "You" : harnessName(props.message.harness));
  const color = () =>
    props.message.role === "user" ? theme.text : harnessColor(props.message.harness);

  return (
    <box flexDirection="column" paddingBottom={1}>
      <text fg={color()}>
        <strong>{label()}</strong>
      </text>
      <text fg={theme.text} wrapMode="word">
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
  const [draft, setDraft] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [capabilitiesLoading, setCapabilitiesLoading] = createSignal(false);
  const [pendingPrompt, setPendingPrompt] = createSignal("");
  const [streamingResponse, setStreamingResponse] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  let composer: TextareaRenderable | undefined;

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
  const commandQuery = createMemo(() => {
    const parsed = parseSlashCommand(draft());
    return parsed && !draft().slice(1).includes(" ") ? parsed.name.toLowerCase() : null;
  });
  const visibleCommands = createMemo(() => {
    const query = commandQuery();
    if (query === null) return activeCapabilities().commands;
    return activeCapabilities().commands.filter((command) =>
      command.name.toLowerCase().startsWith(query),
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
      if (thread) setSnapshot((current) => ({ ...current, thread }));
      if (!capabilities().some((item) => item.harness === harness)) {
        setCapabilitiesLoading(true);
        const discovered = await props.controller.refreshCapabilities(harness);
        setCapabilities((current) => [
          ...current.filter((item) => item.harness !== harness),
          discovered,
        ]);
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setCapabilitiesLoading(false);
    }
  };

  const chooseModel = (model: string) => {
    setSelectedModels((current) => ({ ...current, [selectedHarness()]: model }));
    closeOverlay();
  };

  const insertCommand = (command: HarnessCommand) => {
    if (command.source === "relay") {
      composer?.clear();
      setDraft("");
      if (command.name === "model") setOverlay("model");
      else if (command.name === "harness") setOverlay("harness");
      else setOverlay("commands");
      return;
    }
    const value = `/${command.name}${command.acceptsArguments ? " " : ""}`;
    composer?.setText(value);
    setDraft(value);
    closeOverlay();
  };

  const runRelayCommand = (name: string) => {
    if (name === "model" || name === "models") {
      setOverlay("model");
      return true;
    }
    if (name === "harness") {
      setOverlay("harness");
      return true;
    }
    if (name === "help") {
      setOverlay("commands");
      return true;
    }
    return false;
  };

  const submit = async () => {
    const prompt = composer?.plainText.trim() ?? "";
    if (!prompt || busy()) return;

    const slash = parseSlashCommand(prompt);
    if (slash && runRelayCommand(slash.name)) {
      composer?.clear();
      setDraft("");
      return;
    }
    const nativeCommand = slash
      ? activeCapabilities().commands.find(
          (command) => command.source === "native" && command.name === slash.name,
        )
      : undefined;
    if (slash && !nativeCommand) {
      setError(`/${slash.name} is not available in ${harnessName(selectedHarness())}`);
      return;
    }

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
      backgroundColor={theme.background}
      paddingLeft={compact() ? 1 : 2}
      paddingRight={compact() ? 1 : 2}
    >
      <box height={3} flexDirection="row" justifyContent="space-between" alignItems="center">
        <box flexDirection="column">
          <text fg={theme.text}>
            <strong>{title()}</strong>
          </text>
          <text fg={theme.muted}>{cwd()}</text>
        </box>
        <text fg={theme.subtle}>relay</text>
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
              <text fg={theme.text}>One task. Any harness.</text>
              <text fg={theme.muted}>
                Write a message below, then switch between Codex and OpenCode whenever the work
                calls for it.
              </text>
            </box>
          }
        >
          <For each={snapshot().messages}>{(message) => <Message message={message} />}</For>
        </Show>
        <Show when={pendingPrompt().length > 0}>
          <box flexDirection="column" paddingBottom={1}>
            <text fg={theme.text}>
              <strong>You</strong>
            </text>
            <text fg={theme.text} wrapMode="word">
              {pendingPrompt()}
            </text>
          </box>
        </Show>
        <Show when={busy()}>
          <Show
            when={streamingResponse().length > 0}
            fallback={
              <text fg={harnessColor(selectedHarness())}>
                {harnessName(selectedHarness())} is working…
              </text>
            }
          >
            <box flexDirection="column" paddingBottom={1}>
              <text fg={harnessColor(selectedHarness())}>
                <strong>{harnessName(selectedHarness())}</strong>
              </text>
              <text fg={theme.text} wrapMode="word">
                {streamingResponse()}
              </text>
            </box>
          </Show>
        </Show>
      </scrollbox>

      <Show when={error()}>
        {(message) => (
          <box border={["left"]} borderColor={theme.error} paddingLeft={1}>
            <text fg={theme.error}>{message()}</text>
          </box>
        )}
      </Show>

      <Show when={overlay() === "harness"}>
        <box
          height={8}
          flexDirection="column"
          border
          borderColor={theme.border}
          backgroundColor={theme.panelRaised}
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
            backgroundColor={theme.panelRaised}
            focusedBackgroundColor={theme.panelRaised}
            selectedBackgroundColor={theme.border}
            selectedTextColor={theme.text}
            textColor={theme.muted}
            descriptionColor={theme.subtle}
            selectedDescriptionColor={theme.muted}
            onSelect={(_index, option) => {
              if (option?.value === "codex" || option?.value === "opencode") {
                void chooseHarness(option.value);
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
          borderColor={theme.border}
          backgroundColor={theme.panelRaised}
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
            backgroundColor={theme.panelRaised}
            focusedBackgroundColor={theme.panelRaised}
            selectedBackgroundColor={theme.border}
            selectedTextColor={theme.text}
            textColor={theme.muted}
            descriptionColor={theme.subtle}
            selectedDescriptionColor={theme.muted}
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
          borderColor={theme.border}
          backgroundColor={theme.panelRaised}
          paddingLeft={1}
          paddingRight={1}
          marginBottom={1}
          title={`${harnessName(selectedHarness())} commands`}
        >
          <select
            focused
            height={Math.min(7, Math.max(1, visibleCommands().length))}
            options={visibleCommands().map((command) => ({
              name: `/${command.name}`,
              description: `${command.description} · ${command.source}`,
              value: command.name,
            }))}
            backgroundColor={theme.panelRaised}
            focusedBackgroundColor={theme.panelRaised}
            selectedBackgroundColor={theme.border}
            selectedTextColor={theme.text}
            textColor={theme.muted}
            descriptionColor={theme.subtle}
            selectedDescriptionColor={theme.muted}
            onSelect={(_index, option) => {
              const command = activeCapabilities().commands.find(
                (item) => item.name === option?.value,
              );
              if (command) insertCommand(command);
            }}
          />
        </box>
      </Show>

      <box
        flexDirection="column"
        border={["left"]}
        borderColor={busy() ? harnessColor(selectedHarness()) : theme.border}
        backgroundColor={theme.panel}
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
          placeholderColor={theme.subtle}
          backgroundColor={theme.panel}
          focusedBackgroundColor={theme.panel}
          textColor={theme.text}
          focusedTextColor={theme.text}
          cursorColor={theme.text}
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
            fg={harnessColor(selectedHarness())}
            onMouseDown={() => {
              if (!busy()) setOverlay("harness");
            }}
          >
            {harnessName(selectedHarness())} ▾
          </text>
          <text
            fg={theme.muted}
            onMouseDown={() => {
              if (!busy()) setOverlay("model");
            }}
          >
            {capabilitiesLoading()
              ? "Loading capabilities…"
              : (selectedModel() ?? "Native default")}{" "}
            ▾
          </text>
          <text fg={theme.subtle}>
            {compact()
              ? "^R harness · ^O model"
              : "Ctrl+R harness · Ctrl+O model · / commands · Enter send"}
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
        backgroundColor: theme.background,
        exitOnCtrlC: true,
        screenMode: "alternate-screen",
        targetFps: 30,
        onDestroy: resolve,
      }).catch(reject);
    });
  });
