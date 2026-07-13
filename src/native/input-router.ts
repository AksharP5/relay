const relayPrefixSequences = [Uint8Array.of(0x1d), Buffer.from("\u001b[93;5u")];
const relaySwitchCommands = new Set(["r".charCodeAt(0), "R".charCodeAt(0)]);
const bracketedPasteStart = Buffer.from("\u001b[200~");
const bracketedPasteEnd = Buffer.from("\u001b[201~");

const endsWith = (value: ReadonlyArray<number>, suffix: Uint8Array) => {
  if (value.length < suffix.length) return false;
  const offset = value.length - suffix.length;
  for (let index = 0; index < suffix.length; index += 1) {
    if (value[offset + index] !== suffix[index]) return false;
  }
  return true;
};

const isPrefixOf = (candidate: ReadonlyArray<number>, value: Uint8Array) =>
  candidate.length <= value.length && candidate.every((byte, index) => value[index] === byte);

export interface RoutedInput {
  readonly forward: Uint8Array;
  readonly switchRequested: boolean;
}

/**
 * Removes only Relay's Ctrl+] then R prefix chord without interpreting any
 * other terminal input. Both legacy control bytes and CSI-u keyboard encoding
 * are recognized. Bracketed paste contents are always passed through literally.
 */
export class NativeInputRouter {
  readonly #recent: Array<number> = [];
  readonly #candidate: Array<number> = [];
  #insideBracketedPaste = false;
  #awaitingRelayCommand = false;

  get hasPendingPrefix() {
    return this.#awaitingRelayCommand || this.#candidate.length > 0;
  }

  flushPending(): Uint8Array {
    const bytes = this.#awaitingRelayCommand
      ? relayPrefixSequences[0]!
      : Uint8Array.from(this.#candidate);
    this.#candidate.length = 0;
    this.#awaitingRelayCommand = false;
    return Uint8Array.from(bytes);
  }

  route(chunk: Uint8Array): RoutedInput {
    const forward: Array<number> = [];

    for (const byte of chunk) {
      if (this.#insideBracketedPaste) {
        this.#record(byte, forward);
        continue;
      }

      if (this.#awaitingRelayCommand) {
        this.#awaitingRelayCommand = false;
        if (relaySwitchCommands.has(byte)) {
          return { forward: Uint8Array.from(forward), switchRequested: true };
        }
        forward.push(...relayPrefixSequences[0]!);
      }

      if (this.#candidate.length > 0 || relayPrefixSequences.some((value) => value[0] === byte)) {
        this.#candidate.push(byte);
        const exact = relayPrefixSequences.find(
          (value) => value.length === this.#candidate.length && isPrefixOf(this.#candidate, value),
        );
        if (exact) {
          this.#candidate.length = 0;
          this.#awaitingRelayCommand = true;
          continue;
        }
        if (relayPrefixSequences.some((value) => isPrefixOf(this.#candidate, value))) continue;
        for (const candidateByte of this.#candidate.splice(0)) this.#record(candidateByte, forward);
        continue;
      }

      this.#record(byte, forward);
    }

    return { forward: Uint8Array.from(forward), switchRequested: false };
  }

  #record(byte: number, forward: Array<number>) {
    forward.push(byte);
    this.#recent.push(byte);
    if (this.#recent.length > bracketedPasteStart.length) this.#recent.shift();

    if (endsWith(this.#recent, bracketedPasteStart)) {
      this.#insideBracketedPaste = true;
    } else if (endsWith(this.#recent, bracketedPasteEnd)) {
      this.#insideBracketedPaste = false;
    }
  }
}
