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
  createdAt: Schema.String,
});
export type RelayMessage = typeof RelayMessage.Type;

export const HarnessBinding = Schema.Struct({
  harness: Harness,
  sessionId: Schema.String,
  lastSyncedSeq: Schema.Number,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type HarnessBinding = typeof HarnessBinding.Type;

export const RelayThread = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  cwd: Schema.String,
  activeHarness: Harness,
  bindings: Schema.Struct({
    codex: Schema.optional(HarnessBinding),
    opencode: Schema.optional(HarnessBinding),
  }),
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

export interface HarnessTurnInput {
  readonly cwd: string;
  readonly prompt: string;
  readonly handoff: ReadonlyArray<RelayMessage>;
  readonly sessionId?: string;
  readonly model?: string;
}

export interface HarnessTurnResult {
  readonly sessionId: string;
  readonly text: string;
}

export const isHarness = (value: string): value is Harness =>
  value === "codex" || value === "opencode";
