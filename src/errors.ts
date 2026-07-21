import { Schema } from "effect";

export class StoreError extends Schema.TaggedErrorClass<StoreError>()("StoreError", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export class ThreadNotFound extends Schema.TaggedErrorClass<ThreadNotFound>()("ThreadNotFound", {
  threadId: Schema.String,
  message: Schema.String,
}) {}

export class ThreadBusy extends Schema.TaggedErrorClass<ThreadBusy>()("ThreadBusy", {
  threadId: Schema.String,
  message: Schema.String,
}) {}

export class NoCurrentThread extends Schema.TaggedErrorClass<NoCurrentThread>()("NoCurrentThread", {
  message: Schema.String,
}) {}

export class HarnessUnavailable extends Schema.TaggedErrorClass<HarnessUnavailable>()(
  "HarnessUnavailable",
  {
    harness: Schema.String,
    command: Schema.String,
    message: Schema.String,
  },
) {}

export class HarnessError extends Schema.TaggedErrorClass<HarnessError>()("HarnessError", {
  harness: Schema.String,
  message: Schema.String,
  exitCode: Schema.optional(Schema.Number),
  stderr: Schema.optional(Schema.String),
  sessionState: Schema.optional(Schema.Literals(["preserve", "uncertain"])),
}) {}

export class ProcessError extends Schema.TaggedErrorClass<ProcessError>()("ProcessError", {
  operation: Schema.Literal("run"),
  command: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export class SettingsError extends Schema.TaggedErrorClass<SettingsError>()("SettingsError", {
  operation: Schema.Literals(["load", "save", "reset"]),
  path: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export class CliError extends Schema.TaggedErrorClass<CliError>()("CliError", {
  message: Schema.String,
}) {}
