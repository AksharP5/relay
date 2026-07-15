import {
  DEFAULT_SWITCH_KEY,
  legacySwitchSequences,
  matchesEnhancedSwitchKey,
  type SwitchKeyBinding,
} from "../switch-key.ts";

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

const isPrefixAt = (chunk: Uint8Array, offset: number, value: Uint8Array) => {
  const remaining = chunk.length - offset;
  if (remaining >= value.length) return false;
  for (let index = 0; index < remaining; index += 1) {
    if (chunk[offset + index] !== value[index]) return false;
  }
  return true;
};

const enhancedToggleLengthAt = (chunk: Uint8Array, offset: number, switchKey: SwitchKeyBinding) => {
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
    const keys = (fields[0] ?? "").split(":").filter(Boolean).map(Number);
    const [modifierText = "1", eventText = "1"] = (fields[1] ?? "1").split(":");
    const modifier = Number(modifierText);
    const event = Number(eventText);
    return event === 1 && keys.some((key) => matchesEnhancedSwitchKey(switchKey, key, modifier))
      ? final - offset + 1
      : undefined;
  }

  if (terminator === "~" && fields[0] === "27") {
    const modifier = Number(fields[1]);
    const key = Number(fields[2]);
    if (matchesEnhancedSwitchKey(switchKey, key, modifier)) return final - offset + 1;
  }
  return undefined;
};

const enhancedSubmitAt = (chunk: Uint8Array, offset: number) => {
  if (chunk[offset] !== 0x1b || chunk[offset + 1] !== 0x5b) return false;
  let final = offset + 2;
  while (final < chunk.length) {
    const byte = chunk[final]!;
    if (byte >= 0x40 && byte <= 0x7e) break;
    final += 1;
  }
  if (final >= chunk.length || chunk[final] !== "u".charCodeAt(0)) return false;
  const fields = Buffer.from(chunk.slice(offset + 2, final))
    .toString()
    .split(";");
  const key = Number(fields[0]?.split(":", 1)[0]);
  const [modifierText = "1", eventText = "1"] = (fields[1] ?? "1").split(":");
  const modifier = Number(modifierText);
  const event = Number(eventText);
  return key === 13 && modifier === 1 && event === 1;
};

type EscapeToken =
  | { readonly complete: true; readonly length: number }
  | { readonly complete: false };

const stringTerminatedEscapeLengthAt = (chunk: Uint8Array, offset: number) => {
  for (let index = offset + 2; index < chunk.length; index += 1) {
    if (chunk[index] === 0x07) return index - offset + 1;
    if (chunk[index] === 0x1b && chunk[index + 1] === 0x5c) return index - offset + 2;
  }
  return undefined;
};

const utf8CharacterLength = (firstByte: number) => {
  if (firstByte < 0x80) return 1;
  if ((firstByte & 0xe0) === 0xc0) return 2;
  if ((firstByte & 0xf0) === 0xe0) return 3;
  if ((firstByte & 0xf8) === 0xf0) return 4;
  return 1;
};

/** Returns one complete terminal input token beginning with Escape, or an incomplete prefix. */
const escapeTokenAt = (chunk: Uint8Array, offset: number, allowNested = true): EscapeToken => {
  if (offset + 1 >= chunk.length) return { complete: false };
  const introducer = chunk[offset + 1]!;

  if (introducer === 0x5b) {
    for (let index = offset + 2; index < chunk.length; index += 1) {
      const byte = chunk[index]!;
      if (byte >= 0x40 && byte <= 0x7e) {
        return { complete: true, length: index - offset + 1 };
      }
    }
    return { complete: false };
  }

  if (introducer === 0x4f) {
    return offset + 2 < chunk.length ? { complete: true, length: 3 } : { complete: false };
  }

  // Alt can prefix an existing escape sequence, as with Alt+Shift+Tab
  // (`ESC` + `CSI Z`). Keep that nested report as one key token.
  if (introducer === 0x1b && allowNested) {
    const nested = escapeTokenAt(chunk, offset + 1, false);
    return nested.complete ? { complete: true, length: nested.length + 1 } : { complete: false };
  }

  if ([0x5d, 0x50, 0x58, 0x5e, 0x5f].includes(introducer)) {
    const length = stringTerminatedEscapeLengthAt(chunk, offset);
    return length === undefined ? { complete: false } : { complete: true, length };
  }

  if (introducer >= 0x20 && introducer <= 0x2f) {
    for (let index = offset + 2; index < chunk.length; index += 1) {
      const byte = chunk[index]!;
      if (byte >= 0x30 && byte <= 0x7e) {
        return { complete: true, length: index - offset + 1 };
      }
      if (byte < 0x20 || byte > 0x2f) return { complete: true, length: index - offset };
    }
    return { complete: false };
  }

  const length = 1 + utf8CharacterLength(introducer);
  return offset + length <= chunk.length ? { complete: true, length } : { complete: false };
};

export interface RoutedInput {
  readonly forward: Uint8Array;
  readonly afterSwitch: Uint8Array;
  readonly switchRequested: boolean;
  readonly submitObserved: boolean;
}

/**
 * Removes only Relay's configured toggle and F6 fallback without interpreting other input.
 * Legacy control-byte, function-key, and enhanced-keyboard encodings are recognized.
 * Bracketed paste contents are always passed through literally.
 */
export class NativeInputRouter {
  readonly #recent: Array<number> = [];
  readonly #switchKey: SwitchKeyBinding;
  readonly #legacyToggleSequences: ReadonlyArray<Uint8Array>;
  #insideBracketedPaste = false;
  #pendingSequence: Uint8Array | undefined;

  constructor(switchKey: SwitchKeyBinding = DEFAULT_SWITCH_KEY) {
    this.#switchKey = switchKey;
    this.#legacyToggleSequences = legacySwitchSequences(switchKey);
  }

  get hasPendingSequence() {
    return this.#pendingSequence !== undefined;
  }

  pendingTimeoutMs(fallback: number) {
    const pending = this.#pendingSequence;
    if (!pending || pending[0] !== 0x1b) return fallback;
    const isCompleteConfiguredSequence = this.#legacyToggleSequences.some(
      (sequence) => sequence.length === pending.length && matchesAt(pending, 0, sequence),
    );
    return pending.length === 1 || isCompleteConfiguredSequence ? 25 : fallback;
  }

  flushPendingSequence(): Uint8Array {
    const bytes = this.#pendingSequence ?? new Uint8Array();
    this.#pendingSequence = undefined;
    return bytes.slice();
  }

  route(chunk: Uint8Array): RoutedInput {
    return this.#route(chunk, false);
  }

  /** Resolves an ambiguous timed-out prefix as input instead of buffering it again. */
  flushPendingRoute(): RoutedInput {
    const bytes = this.#pendingSequence ?? new Uint8Array();
    this.#pendingSequence = undefined;
    return this.#route(bytes, true);
  }

  #route(chunk: Uint8Array, resolveAmbiguousPrefix: boolean): RoutedInput {
    const pendingSequence = this.#pendingSequence;
    const input = pendingSequence
      ? Buffer.concat([Buffer.from(pendingSequence), Buffer.from(chunk)])
      : chunk;
    this.#pendingSequence = undefined;
    const forward: Array<number> = [];
    let submitObserved = false;

    for (let index = 0; index < input.length; index += 1) {
      const byte = input[index]!;
      if (this.#insideBracketedPaste) {
        this.#record(byte, forward);
        continue;
      }

      // The paste wrapper itself wins over a user binding that happens to be
      // one of its bytes (for example Escape, "[", "2", or "~").
      if (matchesAt(input, index, bracketedPasteStart)) {
        for (const markerByte of bracketedPasteStart) this.#record(markerByte, forward);
        index += bracketedPasteStart.length - 1;
        continue;
      }
      if (!resolveAmbiguousPrefix && isPrefixAt(input, index, bracketedPasteStart)) {
        this.#pendingSequence = input.slice(index);
        break;
      }

      if (byte === 0x1b) {
        const token = escapeTokenAt(input, index);
        const available = input.length - index;
        if (!token.complete && !resolveAmbiguousPrefix) {
          this.#pendingSequence = input.slice(index);
          break;
        }

        const tokenLength = token.complete ? token.length : available;
        if (enhancedSubmitAt(input, index)) submitObserved = true;
        const legacyToggleLength = this.#legacyToggleSequences.find(
          (sequence) => sequence.length === tokenLength && matchesAt(input, index, sequence),
        )?.length;
        const enhancedToggleLength = enhancedToggleLengthAt(input, index, this.#switchKey);
        const toggleLength = legacyToggleLength ?? enhancedToggleLength;
        if (toggleLength === tokenLength) {
          return {
            forward: Uint8Array.from(forward),
            afterSwitch: input.slice(index + toggleLength),
            switchRequested: true,
            submitObserved,
          };
        }

        for (const tokenByte of input.slice(index, index + tokenLength)) {
          this.#record(tokenByte, forward);
        }
        index += tokenLength - 1;
        continue;
      }

      const legacyToggleLength = this.#legacyToggleSequences.find(
        (sequence) => sequence[0] !== 0x1b && matchesAt(input, index, sequence),
      )?.length;
      const toggleLength = legacyToggleLength;
      if (toggleLength) {
        return {
          forward: Uint8Array.from(forward),
          afterSwitch: input.slice(index + toggleLength),
          switchRequested: true,
          submitObserved,
        };
      }

      if (
        !resolveAmbiguousPrefix &&
        this.#legacyToggleSequences.some(
          (sequence) => sequence[0] !== 0x1b && isPrefixAt(input, index, sequence),
        )
      ) {
        this.#pendingSequence = input.slice(index);
        break;
      }

      if (byte === 0x0a || byte === 0x0d) submitObserved = true;
      this.#record(byte, forward);
    }

    return {
      forward: Uint8Array.from(forward),
      afterSwitch: new Uint8Array(),
      switchRequested: false,
      submitObserved,
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
