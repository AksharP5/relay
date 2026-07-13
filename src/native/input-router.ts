const relaySwitchByte = 0x12;
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

export interface RoutedInput {
  readonly forward: Uint8Array;
  readonly switchRequested: boolean;
}

/**
 * Removes Relay's switch chord without interpreting any other terminal input.
 * Bracketed paste contents are always passed through literally, including Ctrl+R.
 */
export class NativeInputRouter {
  readonly #recent: Array<number> = [];
  #insideBracketedPaste = false;

  route(chunk: Uint8Array): RoutedInput {
    const forward: Array<number> = [];

    for (const byte of chunk) {
      if (byte === relaySwitchByte && !this.#insideBracketedPaste) {
        return { forward: Uint8Array.from(forward), switchRequested: true };
      }

      forward.push(byte);
      this.#recent.push(byte);
      if (this.#recent.length > bracketedPasteStart.length) this.#recent.shift();

      if (endsWith(this.#recent, bracketedPasteStart)) {
        this.#insideBracketedPaste = true;
      } else if (endsWith(this.#recent, bracketedPasteEnd)) {
        this.#insideBracketedPaste = false;
      }
    }

    return { forward: Uint8Array.from(forward), switchRequested: false };
  }
}
