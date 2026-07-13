import { Schema } from "effect";

export const Harness = Schema.Literals(["codex", "opencode"]);
export type Harness = typeof Harness.Type;

export const MessageRole = Schema.Literals(["user", "assistant"]);
export type MessageRole = typeof MessageRole.Type;

export const RelayMessage = Schema.Struct({
  id: Schema.String,
  seq: Schema.Number,
  role: MessageRole,
  content: Schema.String,
  harness: Harness,
  nativeId: Schema.optional(Schema.String),
  nativeSessionId: Schema.optional(Schema.String),
  createdAt: Schema.String,
});
export type RelayMessage = typeof RelayMessage.Type;

export const HarnessBinding = Schema.Struct({
  harness: Harness,
  sessionId: Schema.String,
  model: Schema.optional(Schema.String),
  lastSyncedSeq: Schema.Number,
  nativeCursor: Schema.optional(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type HarnessBinding = typeof HarnessBinding.Type;

export const PendingNativeHandoff = Schema.Struct({
  id: Schema.String,
  harness: Harness,
  sessionId: Schema.optional(Schema.String),
  fromSeq: Schema.Number,
  throughSeq: Schema.Number,
  createdAt: Schema.String,
});
export type PendingNativeHandoff = typeof PendingNativeHandoff.Type;

export const RelayThread = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  cwd: Schema.String,
  activeHarness: Harness,
  bindings: Schema.Struct({
    codex: Schema.optional(HarnessBinding),
    opencode: Schema.optional(HarnessBinding),
  }),
  preferredModels: Schema.optional(
    Schema.Struct({
      codex: Schema.optional(Schema.String),
      opencode: Schema.optional(Schema.String),
    }),
  ),
  pendingHandoffs: Schema.optional(
    Schema.Struct({
      codex: Schema.optional(PendingNativeHandoff),
      opencode: Schema.optional(PendingNativeHandoff),
    }),
  ),
  lastSeq: Schema.Number,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type RelayThread = typeof RelayThread.Type;

export const RelayIndex = Schema.Struct({
  currentThreadId: Schema.NullOr(Schema.String),
  threadIds: Schema.Array(Schema.String),
});
export type RelayIndex = typeof RelayIndex.Type;

export interface RelayTaskExport {
  readonly formatVersion: 1;
  readonly exportedAt: string;
  readonly task: {
    readonly id: string;
    readonly title: string;
    readonly cwd: string;
    readonly activeHarness: Harness;
    readonly createdAt: string;
    readonly updatedAt: string;
  };
  readonly messages: ReadonlyArray<{
    readonly seq: number;
    readonly role: MessageRole;
    readonly content: string;
    readonly harness: Harness;
    readonly createdAt: string;
  }>;
}

export interface HarnessTurnInput {
  readonly cwd: string;
  readonly prompt: string;
  readonly handoff: ReadonlyArray<RelayMessage>;
  readonly handoffOmittedMessages?: number;
  readonly sessionId?: string;
  readonly model?: string;
  readonly command?: string;
  readonly onProgress?: (progress: HarnessTurnProgress) => void;
}

export interface HarnessModel {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly isDefault?: boolean;
}

export interface HarnessCommand {
  readonly name: string;
  readonly description: string;
  readonly source: "relay" | "native";
  readonly acceptsArguments?: boolean;
}

export interface HarnessCapabilities {
  readonly harness: Harness;
  readonly models: ReadonlyArray<HarnessModel>;
  readonly commands: ReadonlyArray<HarnessCommand>;
}

export type HarnessTurnProgress =
  | { readonly type: "activity"; readonly label: string }
  | { readonly type: "text"; readonly text: string };

export interface HarnessTurnResult {
  readonly sessionId: string;
  readonly text: string;
}

export interface HarnessControlInput {
  readonly cwd: string;
  readonly sessionId: string;
  readonly action: "compact" | "share" | "unshare" | "undo" | "redo";
  readonly model?: string;
  readonly expectedPrompt?: string;
}

export interface HarnessControlResult {
  readonly message: string;
}

export interface NativeTranscriptTurn {
  readonly id: string;
  readonly prompt: string;
  readonly response: string;
}

export interface NativeTranscript {
  readonly turns: ReadonlyArray<NativeTranscriptTurn>;
  readonly hiddenTurnIds: ReadonlyArray<string>;
}

export const isHarness = (value: string): value is Harness =>
  value === "codex" || value === "opencode";
