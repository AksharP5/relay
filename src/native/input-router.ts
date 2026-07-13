const legacyRelayPrefix = Uint8Array.of(0x1d);
const enhancedRelayPrefix = Buffer.from("\u001b[93;5u");
const relaySwitchCommands = new Set(["r".charCodeAt(0), "R".charCodeAt(0)]);
const legacyF6 = Buffer.from("\u001b[17~");
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

const enhancedToggleLengthAt = (chunk: Uint8Array, offset: number) => {
  if (chunk[offset] !== 0x1b || chunk[offset + 1] !== 0x5b) return undefined;
  let final = offset + 2;
  while (final < chunk.length) {
    const byte = chunk[final]!;
    if (byte >= 0x40 && byte <= 0x7e) break;
    final += 1;
  }
  if (final >= chunk.length) return undefined;
  const terminator = String.fromCharCode(chunk[final]!);
  const body = Buffer.from(chunk.slice(offset + 2, final)).toString();
  const fields = body.split(";");

  if (terminator === "u") {
    const key = Number(fields[0]?.split(":", 1)[0]);
    const [modifierText = "1", eventText = "1"] = (fields[1] ?? "1").split(":");
    const modifier = Number(modifierText);
    const event = Number(eventText);
    const ctrlShiftH = (key === 72 || key === 104) && modifier === 6;
    const f6 = key === 57369 && modifier === 1;
    return event === 1 && (ctrlShiftH || f6) ? final - offset + 1 : undefined;
  }

  if (terminator === "~" && fields[0] === "27") {
    const modifier = Number(fields[1]);
    const key = Number(fields[2]);
    if (modifier === 6 && (key === 72 || key === 104)) return final - offset + 1;
  }
  return undefined;
};

const isIncompleteCsiAt = (chunk: Uint8Array, offset: number) => {
  if (chunk[offset] !== 0x1b || chunk[offset + 1] !== 0x5b) return false;
  for (let index = offset + 2; index < chunk.length; index += 1) {
    const byte = chunk[index]!;
    if (byte >= 0x40 && byte <= 0x7e) return false;
  }
  return true;
};

export interface RoutedInput {
  readonly forward: Uint8Array;
  readonly afterSwitch: Uint8Array;
  readonly switchRequested: boolean;
  readonly switchIntent: "toggle" | "selector" | undefined;
}

/**
 * Removes only Relay's enhanced Ctrl+Shift+H / F6 toggle or Ctrl+] then R
 * selector chord without interpreting any other terminal input. Legacy and
 * CSI-u encodings are recognized. Bracketed paste contents are always passed
 * through literally.
 */
export class NativeInputRouter {
  readonly #recent: Array<number> = [];
  #insideBracketedPaste = false;
  #pendingRelayPrefix: Uint8Array | undefined;
  #pendingCsi: Uint8Array | undefined;
  #pendingEscape: Uint8Array | undefined;

  get hasPendingPrefix() {
    return (
      this.#pendingRelayPrefix !== undefined ||
      this.#pendingCsi !== undefined ||
      this.#pendingEscape !== undefined
    );
  }

  pendingTimeoutMs(fallback: number) {
    return this.#pendingEscape ? 25 : fallback;
  }

  flushPending(): Uint8Array {
    const bytes =
      this.#pendingRelayPrefix ?? this.#pendingCsi ?? this.#pendingEscape ?? new Uint8Array();
    this.#pendingRelayPrefix = undefined;
    this.#pendingCsi = undefined;
    this.#pendingEscape = undefined;
    return bytes.slice();
  }

  route(chunk: Uint8Array): RoutedInput {
    const pendingSequence = this.#pendingCsi ?? this.#pendingEscape;
    const input = pendingSequence
      ? Buffer.concat([Buffer.from(pendingSequence), Buffer.from(chunk)])
      : chunk;
    this.#pendingCsi = undefined;
    this.#pendingEscape = undefined;
    const forward: Array<number> = [];

    for (let index = 0; index < input.length; index += 1) {
      const byte = input[index]!;
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
            afterSwitch: input.slice(index + 1),
            switchRequested: true,
            switchIntent: "selector",
          };
        }
        forward.push(...prefix);
      }

      const enhancedToggleLength = enhancedToggleLengthAt(input, index);
      const toggleLength = matchesAt(input, index, legacyF6)
        ? legacyF6.length
        : enhancedToggleLength;
      if (toggleLength) {
        return {
          forward: Uint8Array.from(forward),
          afterSwitch: input.slice(index + toggleLength),
          switchRequested: true,
          switchIntent: "toggle",
        };
      }

      if (byte === legacyRelayPrefix[0]) {
        this.#pendingRelayPrefix = legacyRelayPrefix;
        continue;
      }

      // Terminal key reports can be fragmented at arbitrary byte boundaries.
      // A lone Escape waits only 25 ms—short enough for native dialogs to feel
      // immediate, but long enough to join a CSI report split after ESC.
      if (byte === 0x1b && index + 1 === input.length) {
        this.#pendingEscape = input.slice(index);
        break;
      }
      if (isIncompleteCsiAt(input, index)) {
        this.#pendingCsi = input.slice(index);
        break;
      }

      // The enhanced Ctrl+] encoding is reserved only when complete.
      if (byte === enhancedRelayPrefix[0] && matchesAt(input, index, enhancedRelayPrefix)) {
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
      switchIntent: undefined,
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
