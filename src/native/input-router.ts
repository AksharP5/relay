const legacyRelayPrefix = Uint8Array.of(0x1d);
const enhancedRelayPrefix = Buffer.from("\u001b[93;5u");
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

const matchesAt = (chunk: Uint8Array, offset: number, value: Uint8Array) => {
  if (chunk.length - offset < value.length) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (chunk[offset + index] !== value[index]) return false;
  }
  return true;
};

export interface RoutedInput {
  readonly forward: Uint8Array;
  readonly afterSwitch: Uint8Array;
  readonly switchRequested: boolean;
}

/**
 * Removes only Relay's Ctrl+] then R prefix chord without interpreting any
 * other terminal input. Both legacy control bytes and CSI-u keyboard encoding
 * are recognized. Bracketed paste contents are always passed through literally.
 */
export class NativeInputRouter {
  readonly #recent: Array<number> = [];
  #insideBracketedPaste = false;
  #pendingRelayPrefix: Uint8Array | undefined;

  get hasPendingPrefix() {
    return this.#pendingRelayPrefix !== undefined;
  }

  flushPending(): Uint8Array {
    const bytes = this.#pendingRelayPrefix ?? new Uint8Array();
    this.#pendingRelayPrefix = undefined;
    return bytes.slice();
  }

  route(chunk: Uint8Array): RoutedInput {
    const forward: Array<number> = [];

    for (let index = 0; index < chunk.length; index += 1) {
      const byte = chunk[index]!;
      if (this.#insideBracketedPaste) {
        this.#record(byte, forward);
        continue;
      }

      if (this.#pendingRelayPrefix) {
        const prefix = this.#pendingRelayPrefix;
        this.#pendingRelayPrefix = undefined;
        if (relaySwitchCommands.has(byte)) {
          return {
            forward: Uint8Array.from(forward),
            afterSwitch: chunk.slice(index + 1),
            switchRequested: true,
          };
        }
        forward.push(...prefix);
      }

      if (byte === legacyRelayPrefix[0]) {
        this.#pendingRelayPrefix = legacyRelayPrefix;
        continue;
      }

      // A plain Escape must reach the native TUI immediately. The enhanced
      // Ctrl+] encoding is therefore reserved only when its complete sequence
      // is present in this input chunk.
      if (byte === enhancedRelayPrefix[0] && matchesAt(chunk, index, enhancedRelayPrefix)) {
        this.#pendingRelayPrefix = enhancedRelayPrefix;
        index += enhancedRelayPrefix.length - 1;
        continue;
      }

      this.#record(byte, forward);
    }

    return {
      forward: Uint8Array.from(forward),
      afterSwitch: new Uint8Array(),
      switchRequested: false,
    };
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
