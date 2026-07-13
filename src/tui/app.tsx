import type { SelectOption, TextareaRenderable } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid";
import { For, Show, createMemo, createSignal } from "solid-js";
import type { Harness, RelayMessage } from "../domain.ts";
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
  const [pickerOpen, setPickerOpen] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [pendingPrompt, setPendingPrompt] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  let composer: TextareaRenderable | undefined;

  const title = createMemo(() => snapshot().thread?.title ?? "New Relay task");
  const cwd = createMemo(() => snapshot().thread?.cwd ?? process.cwd());
  const compact = createMemo(() => dimensions().width < 72);
  const harnessStatus = (harness: Harness) =>
    snapshot().harnesses.find((status) => status.harness === harness);

  const focusComposer = () => setTimeout(() => composer?.focus(), 0);

  const closePicker = () => {
    setPickerOpen(false);
    focusComposer();
  };

  const chooseHarness = async (harness: Harness) => {
    setSelectedHarness(harness);
    closePicker();
    setError(null);
    try {
      const thread = await props.controller.switchHarness(harness);
      if (thread) setSnapshot((current) => ({ ...current, thread }));
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const submit = async () => {
    const prompt = composer?.plainText.trim() ?? "";
    if (!prompt || busy()) return;

    composer?.clear();
    setPendingPrompt(prompt);
    setBusy(true);
    setError(null);
    try {
      const next = await props.controller.ask({ prompt, harness: selectedHarness() });
      setSnapshot((current) => ({ ...current, ...next }));
      setSelectedHarness(next.thread?.activeHarness ?? selectedHarness());
      setPendingPrompt("");
    } catch (cause) {
      setError(errorMessage(cause));
      composer?.setText(prompt);
      setPendingPrompt("");
    } finally {
      setBusy(false);
      focusComposer();
    }
  };

  useKeyboard((key) => {
    if (key.ctrl && key.name === "r") {
      key.preventDefault();
      if (!busy()) setPickerOpen((open) => !open);
      return;
    }
    if (pickerOpen() && key.name === "escape") {
      key.preventDefault();
      closePicker();
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
          <text fg={harnessColor(selectedHarness())}>
            {harnessName(selectedHarness())} is working…
          </text>
        </Show>
      </scrollbox>

      <Show when={error()}>
        {(message) => (
          <box border={["left"]} borderColor={theme.error} paddingLeft={1}>
            <text fg={theme.error}>{message()}</text>
          </box>
        )}
      </Show>

      <Show when={pickerOpen()}>
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
          focused={!pickerOpen()}
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
          onKeyDown={(key) => {
            if (busy()) key.preventDefault();
          }}
        />
        <box flexDirection="row" justifyContent="space-between" paddingTop={1}>
          <text
            fg={harnessColor(selectedHarness())}
            onMouseDown={() => {
              if (!busy()) setPickerOpen(true);
            }}
          >
            {harnessName(selectedHarness())} ▾
          </text>
          <text fg={theme.subtle}>
            {compact() ? "^R switch" : "Ctrl+R switch · Enter send · Shift+Enter newline"}
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
