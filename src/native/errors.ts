import type { Harness } from "../domain.ts";

export class NativeSessionUnavailable extends Error {
  readonly harness: Harness;
  readonly sessionId: string;

  constructor(harness: Harness, sessionId: string, detail?: string) {
    super(detail ?? `${harness} session ${sessionId} is unavailable`);
    this.name = "NativeSessionUnavailable";
    this.harness = harness;
    this.sessionId = sessionId;
  }
}
