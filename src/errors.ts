import { Schema } from "effect";

export class StoreError extends Schema.TaggedError<StoreError>()("StoreError", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class ThreadNotFound extends Schema.TaggedError<ThreadNotFound>()("ThreadNotFound", {
  threadId: Schema.String,
  message: Schema.String,
}) {}

export class ThreadBusy extends Schema.TaggedError<ThreadBusy>()("ThreadBusy", {
  threadId: Schema.String,
  message: Schema.String,
}) {}

export class NoCurrentThread extends Schema.TaggedError<NoCurrentThread>()("NoCurrentThread", {
  message: Schema.String,
}) {}

export class HarnessUnavailable extends Schema.TaggedError<HarnessUnavailable>()(
  "HarnessUnavailable",
  {
    harness: Schema.String,
    command: Schema.String,
    message: Schema.String,
  },
) {}

export class HarnessError extends Schema.TaggedError<HarnessError>()("HarnessError", {
  harness: Schema.String,
  message: Schema.String,
  exitCode: Schema.optional(Schema.Number),
  stderr: Schema.optional(Schema.String),
  sessionState: Schema.optional(Schema.Literals(["preserve", "uncertain"])),
}) {}

export class ProcessError extends Schema.TaggedError<ProcessError>()("ProcessError", {
  operation: Schema.Literal("run"),
  command: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class SettingsError extends Schema.TaggedError<SettingsError>()("SettingsError", {
  operation: Schema.Literals(["load", "save", "reset"]),
  path: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class CliError extends Schema.TaggedError<CliError>()("CliError", {
  message: Schema.String,
}) {}
