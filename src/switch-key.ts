export interface SwitchModifiers {
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly super: boolean;
  readonly hyper: boolean;
  readonly meta: boolean;
}

const specialDefinitions = {
  enter: { label: "Enter", enhancedCodes: [13, 57_345] },
  tab: { label: "Tab", enhancedCodes: [9, 57_346] },
  escape: { label: "Escape", enhancedCodes: [27, 57_344] },
  backspace: { label: "Backspace", enhancedCodes: [127, 57_347] },
  delete: { label: "Delete", enhancedCodes: [57_349] },
  insert: { label: "Insert", enhancedCodes: [57_348] },
  up: { label: "Up", enhancedCodes: [57_352] },
  down: { label: "Down", enhancedCodes: [57_353] },
  left: { label: "Left", enhancedCodes: [57_350] },
  right: { label: "Right", enhancedCodes: [57_351] },
  home: { label: "Home", enhancedCodes: [57_356] },
  end: { label: "End", enhancedCodes: [57_357] },
  pageup: { label: "PageUp", enhancedCodes: [57_354] },
  pagedown: { label: "PageDown", enhancedCodes: [57_355] },
  capslock: { label: "CapsLock", enhancedCode: 57_358 },
  scrolllock: { label: "ScrollLock", enhancedCode: 57_359 },
  numlock: { label: "NumLock", enhancedCode: 57_360 },
  printscreen: { label: "PrintScreen", enhancedCode: 57_361 },
  pause: { label: "Pause", enhancedCode: 57_362 },
  menu: { label: "Menu", enhancedCode: 57_363 },
  kp0: { label: "KP0", enhancedCode: 57_399 },
  kp1: { label: "KP1", enhancedCode: 57_400 },
  kp2: { label: "KP2", enhancedCode: 57_401 },
  kp3: { label: "KP3", enhancedCode: 57_402 },
  kp4: { label: "KP4", enhancedCode: 57_403 },
  kp5: { label: "KP5", enhancedCode: 57_404 },
  kp6: { label: "KP6", enhancedCode: 57_405 },
  kp7: { label: "KP7", enhancedCode: 57_406 },
  kp8: { label: "KP8", enhancedCode: 57_407 },
  kp9: { label: "KP9", enhancedCode: 57_408 },
  kpdecimal: { label: "KPDecimal", enhancedCode: 57_409 },
  kpdivide: { label: "KPDivide", enhancedCode: 57_410 },
  kpmultiply: { label: "KPMultiply", enhancedCode: 57_411 },
  kpsubtract: { label: "KPSubtract", enhancedCode: 57_412 },
  kpadd: { label: "KPAdd", enhancedCode: 57_413 },
  kpenter: { label: "KPEnter", enhancedCode: 57_414 },
  kpequal: { label: "KPEqual", enhancedCode: 57_415 },
  kpseparator: { label: "KPSeparator", enhancedCode: 57_416 },
  kpleft: { label: "KPLeft", enhancedCode: 57_417 },
  kpright: { label: "KPRight", enhancedCode: 57_418 },
  kpup: { label: "KPUp", enhancedCode: 57_419 },
  kpdown: { label: "KPDown", enhancedCode: 57_420 },
  kppageup: { label: "KPPageUp", enhancedCode: 57_421 },
  kppagedown: { label: "KPPageDown", enhancedCode: 57_422 },
  kphome: { label: "KPHome", enhancedCode: 57_423 },
  kpend: { label: "KPEnd", enhancedCode: 57_424 },
  kpinsert: { label: "KPInsert", enhancedCode: 57_425 },
  kpdelete: { label: "KPDelete", enhancedCode: 57_426 },
  kpbegin: { label: "KPBegin", enhancedCode: 57_427 },
  mediaplay: { label: "MediaPlay", enhancedCode: 57_428 },
  mediapause: { label: "MediaPause", enhancedCode: 57_429 },
  mediaplaypause: { label: "MediaPlayPause", enhancedCode: 57_430 },
  mediareverse: { label: "MediaReverse", enhancedCode: 57_431 },
  mediastop: { label: "MediaStop", enhancedCode: 57_432 },
  mediafastforward: { label: "MediaFastForward", enhancedCode: 57_433 },
  mediarewind: { label: "MediaRewind", enhancedCode: 57_434 },
  medianext: { label: "MediaNext", enhancedCode: 57_435 },
  mediaprevious: { label: "MediaPrevious", enhancedCode: 57_436 },
  mediarecord: { label: "MediaRecord", enhancedCode: 57_437 },
  volumedown: { label: "VolumeDown", enhancedCode: 57_438 },
  volumeup: { label: "VolumeUp", enhancedCode: 57_439 },
  volumemute: { label: "VolumeMute", enhancedCode: 57_440 },
  leftshift: { label: "LeftShift", enhancedCode: 57_441 },
  leftcontrol: { label: "LeftControl", enhancedCode: 57_442 },
  leftalt: { label: "LeftAlt", enhancedCode: 57_443 },
  leftsuper: { label: "LeftSuper", enhancedCode: 57_444 },
  lefthyper: { label: "LeftHyper", enhancedCode: 57_445 },
  leftmeta: { label: "LeftMeta", enhancedCode: 57_446 },
  rightshift: { label: "RightShift", enhancedCode: 57_447 },
  rightcontrol: { label: "RightControl", enhancedCode: 57_448 },
  rightalt: { label: "RightAlt", enhancedCode: 57_449 },
  rightsuper: { label: "RightSuper", enhancedCode: 57_450 },
  righthyper: { label: "RightHyper", enhancedCode: 57_451 },
  rightmeta: { label: "RightMeta", enhancedCode: 57_452 },
  isolevel3shift: { label: "ISOLevel3Shift", enhancedCode: 57_453 },
  isolevel5shift: { label: "ISOLevel5Shift", enhancedCode: 57_454 },
} as const;

export type SpecialSwitchKey = keyof typeof specialDefinitions;

export type SwitchKeyBinding =
  | {
      readonly kind: "character";
      readonly key: string;
      readonly modifiers: SwitchModifiers;
      readonly label: string;
    }
  | {
      readonly kind: "special";
      readonly key: SpecialSwitchKey;
      readonly modifiers: SwitchModifiers;
      readonly label: string;
    }
  | {
      readonly kind: "function";
      readonly number: number;
      readonly modifiers: SwitchModifiers;
      readonly label: string;
    }
  | {
      readonly kind: "keycode";
      readonly code: number;
      readonly modifiers: SwitchModifiers;
      readonly label: string;
    }
  | {
      readonly kind: "none";
      readonly label: "none";
    };

const noModifiers = (): SwitchModifiers => ({
  ctrl: false,
  alt: false,
  shift: false,
  super: false,
  hyper: false,
  meta: false,
});

const namedCharacters: Readonly<Record<string, string>> = {
  space: " ",
  plus: "+",
  minus: "-",
};

const specialAliases: Readonly<Record<string, SpecialSwitchKey>> = {
  ...Object.fromEntries(Object.keys(specialDefinitions).map((key) => [key, key])),
  return: "enter",
  esc: "escape",
  del: "delete",
  ins: "insert",
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
  pgup: "pageup",
  pgdown: "pagedown",
  pgdn: "pagedown",
  numpad0: "kp0",
  numpad1: "kp1",
  numpad2: "kp2",
  numpad3: "kp3",
  numpad4: "kp4",
  numpad5: "kp5",
  numpad6: "kp6",
  numpad7: "kp7",
  numpad8: "kp8",
  numpad9: "kp9",
  mediatracknext: "medianext",
  mediatrackprevious: "mediaprevious",
  kpminus: "kpsubtract",
  kpplus: "kpadd",
  clear: "kpbegin",
  mediaprev: "mediaprevious",
  mute: "volumemute",
  leftctrl: "leftcontrol",
  rightctrl: "rightcontrol",
  lowervolume: "volumedown",
  raisevolume: "volumeup",
  mutevolume: "volumemute",
};

const characterLabel = (key: string) => {
  if (key === " ") return "Space";
  if (key === "+") return "Plus";
  if (key === "-") return "Minus";
  return /^[a-z]$/i.test(key) ? key.toUpperCase() : key;
};

const bindingLabel = (modifiers: SwitchModifiers, key: string) =>
  [
    modifiers.ctrl ? "Ctrl" : undefined,
    modifiers.alt ? "Alt" : undefined,
    modifiers.shift ? "Shift" : undefined,
    modifiers.super ? "Super" : undefined,
    modifiers.hyper ? "Hyper" : undefined,
    modifiers.meta ? "Meta" : undefined,
    key,
  ]
    .filter(Boolean)
    .join("+");

const bindingError = (value: string) =>
  new Error(
    `Unsupported switch key: ${value}. Use any single key with optional modifiers, a named functional key, or KeyCode:<number>; use none to disable the primary shortcut.`,
  );

const isSinglePrintableCharacter = (value: string) => {
  const characters = Array.from(value);
  return characters.length === 1 && !/\p{Cc}|\p{Cs}/u.test(characters[0]!);
};

export const parseSwitchKey = (value: string): SwitchKeyBinding => {
  const trimmed = value.trim();
  if (trimmed.toLowerCase() === "none") return { kind: "none", label: "none" };
  if (!trimmed) throw bindingError(value);

  const parts = trimmed.split("+").map((part) => part.trim());
  if (parts.some((part) => !part)) throw bindingError(value);
  const modifiers = noModifiers();
  let keyToken: string | undefined;

  for (const rawPart of parts) {
    const lower = rawPart.toLowerCase();
    const modifier =
      lower === "control"
        ? "ctrl"
        : lower === "option" || lower === "opt"
          ? "alt"
          : lower === "cmd" || lower === "command"
            ? "super"
            : lower;
    if (["ctrl", "alt", "shift", "super", "hyper", "meta"].includes(modifier)) {
      const key = modifier as keyof SwitchModifiers;
      if (modifiers[key]) throw bindingError(value);
      (modifiers as Record<keyof SwitchModifiers, boolean>)[key] = true;
      continue;
    }
    if (keyToken) throw bindingError(value);
    keyToken = rawPart;
  }

  if (!keyToken) throw bindingError(value);
  const normalizedToken = keyToken.toLowerCase().replaceAll(/[\s_-]/g, "");
  const functionMatch = /^f([1-9]|[12][0-9]|3[0-5])$/.exec(normalizedToken);
  if (functionMatch) {
    const number = Number(functionMatch[1]);
    return {
      kind: "function",
      number,
      modifiers,
      label: bindingLabel(modifiers, `F${number}`),
    };
  }

  const codeMatch = /^keycode:(\d+)$/.exec(normalizedToken);
  if (codeMatch) {
    const code = Number(codeMatch[1]);
    if (!Number.isSafeInteger(code)) throw bindingError(value);
    return {
      kind: "keycode",
      code,
      modifiers,
      label: bindingLabel(modifiers, `KeyCode:${code}`),
    };
  }

  const special = specialAliases[normalizedToken];
  if (special) {
    return {
      kind: "special",
      key: special,
      modifiers,
      label: bindingLabel(modifiers, specialDefinitions[special].label),
    };
  }

  const character = namedCharacters[normalizedToken] ?? keyToken;
  if (!isSinglePrintableCharacter(character)) throw bindingError(value);
  const key = /^[a-z]$/i.test(character) ? character.toLowerCase() : character;
  return {
    kind: "character",
    key,
    modifiers,
    label: bindingLabel(modifiers, characterLabel(key)),
  };
};

export const DEFAULT_SWITCH_KEY = parseSwitchKey("Ctrl+Q");
export const FALLBACK_SWITCH_KEY = parseSwitchKey("F6");

const modifierValue = (modifiers: SwitchModifiers) =>
  1 +
  (modifiers.shift ? 1 : 0) +
  (modifiers.alt ? 2 : 0) +
  (modifiers.ctrl ? 4 : 0) +
  (modifiers.super ? 8 : 0) +
  (modifiers.hyper ? 16 : 0) +
  (modifiers.meta ? 32 : 0);

const shiftedCharacters: Readonly<Record<string, string>> = {
  "1": "!",
  "2": "@",
  "3": "#",
  "4": "$",
  "5": "%",
  "6": "^",
  "7": "&",
  "8": "*",
  "9": "(",
  "0": ")",
  "-": "_",
  "=": "+",
  "[": "{",
  "]": "}",
  "\\": "|",
  ";": ":",
  "'": '"',
  ",": "<",
  ".": ">",
  "/": "?",
  "`": "~",
};

const renderedCharacter = (key: string, shift: boolean) => {
  if (!shift) return key;
  if (/^[a-z]$/.test(key)) return key.toUpperCase();
  return shiftedCharacters[key] ?? key;
};

const controlByte = (key: string) => {
  const upper = key.toUpperCase();
  if (/^[A-Z]$/.test(upper)) return upper.charCodeAt(0) - 64;
  if (key === " " || key === "@") return 0;
  if (key === "[") return 27;
  if (key === "\\") return 28;
  if (key === "]") return 29;
  if (key === "^") return 30;
  if (key === "_" || key === "/") return 31;
  if (key === "?") return 127;
  return undefined;
};

const hasEnhancedOnlyModifier = (modifiers: SwitchModifiers) =>
  modifiers.super || modifiers.hyper || modifiers.meta;

const withAlt = (bytes: ReadonlyArray<number>, alt: boolean) =>
  Buffer.from(alt ? [0x1b, ...bytes] : bytes);

const functionCode = (number: number) =>
  [11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 23, 24][number - 1];

const functionSequences = (number: number, modifiers: SwitchModifiers) => {
  if (number > 12) return [];
  const modifier = modifierValue(modifiers);
  const code = functionCode(number);
  if (code === undefined) return [];
  if (modifier === 1 && number <= 4) {
    return [
      Buffer.from(`\u001bO${String.fromCharCode("P".charCodeAt(0) + number - 1)}`),
      Buffer.from(`\u001b[${code}~`),
    ];
  }
  if (number <= 4) {
    return [
      Buffer.from(`\u001b[1;${modifier}${String.fromCharCode("P".charCodeAt(0) + number - 1)}`),
    ];
  }
  return [Buffer.from(`\u001b[${code}${modifier === 1 ? "" : `;${modifier}`}~`)];
};

const specialSequences = (binding: Extract<SwitchKeyBinding, { readonly kind: "special" }>) => {
  const { ctrl, alt, shift } = binding.modifiers;
  const modifier = modifierValue(binding.modifiers);
  const final: Partial<Record<SpecialSwitchKey, string>> = {
    up: "A",
    down: "B",
    right: "C",
    left: "D",
    home: "H",
    end: "F",
  };
  const tildeCode: Partial<Record<SpecialSwitchKey, number>> = {
    insert: 2,
    delete: 3,
    pageup: 5,
    pagedown: 6,
  };
  const navigationFinal = final[binding.key];
  if (navigationFinal) {
    return modifier === 1
      ? [Buffer.from(`\u001b[${navigationFinal}`), Buffer.from(`\u001bO${navigationFinal}`)]
      : [Buffer.from(`\u001b[1;${modifier}${navigationFinal}`)];
  }
  const code = tildeCode[binding.key];
  if (code) {
    return [Buffer.from(`\u001b[${code}${modifier === 1 ? "" : `;${modifier}`}~`)];
  }
  if (hasEnhancedOnlyModifier(binding.modifiers)) return [];
  if (binding.key === "tab" && shift) {
    if (ctrl) return [];
    return [Buffer.from(alt ? "\u001b\u001b[Z" : "\u001b[Z")];
  }
  if (!["enter", "tab", "escape", "backspace"].includes(binding.key)) return [];
  if ((binding.key === "enter" || binding.key === "escape") && (ctrl || shift)) return [];
  if (binding.key === "tab" && ctrl) return [];
  if (binding.key === "backspace" && shift) return [];
  const byte =
    binding.key === "enter"
      ? 13
      : binding.key === "tab"
        ? 9
        : binding.key === "escape"
          ? 27
          : ctrl
            ? 8
            : 127;
  return [withAlt([byte], alt)];
};

const characterSequences = (binding: Extract<SwitchKeyBinding, { readonly kind: "character" }>) => {
  const { ctrl, alt, shift } = binding.modifiers;
  if (hasEnhancedOnlyModifier(binding.modifiers)) return [];
  if (ctrl) {
    if (shift) return [];
    const byte = controlByte(binding.key);
    return byte === undefined ? [] : [withAlt([byte], alt)];
  }
  const bytes = Buffer.from(renderedCharacter(binding.key, shift));
  return [Buffer.from(alt ? [0x1b, ...bytes] : bytes)];
};

const legacySequencesFor = (binding: SwitchKeyBinding): ReadonlyArray<Buffer> => {
  if (binding.kind === "none" || binding.kind === "keycode") return [];
  if (binding.kind === "function") return functionSequences(binding.number, binding.modifiers);
  if (binding.kind === "special") return specialSequences(binding);
  return characterSequences(binding);
};

export const legacySwitchSequences = (binding: SwitchKeyBinding) => {
  const sequences = [...legacySequencesFor(binding), ...legacySequencesFor(FALLBACK_SWITCH_KEY)];
  return sequences.filter(
    (sequence, index) => sequences.findIndex((candidate) => candidate.equals(sequence)) === index,
  );
};

const enhancedKeyCodes = (binding: SwitchKeyBinding) => {
  if (binding.kind === "none") return [];
  if (binding.kind === "keycode") return [binding.code];
  if (binding.kind === "function") return [57_364 + binding.number - 1];
  if (binding.kind === "special") {
    const definition = specialDefinitions[binding.key];
    if ("enhancedCodes" in definition) return [...definition.enhancedCodes];
    return "enhancedCode" in definition ? [definition.enhancedCode] : [];
  }
  const code = binding.key.codePointAt(0);
  if (code === undefined) return [];
  const codes = [code];
  if (/^[a-z]$/.test(binding.key)) codes.push(binding.key.toUpperCase().codePointAt(0)!);
  return codes;
};

const normalizedModifier = (modifier: number) => 1 + ((modifier - 1) & ~(64 | 128));

const matchesEnhancedBinding = (binding: SwitchKeyBinding, key: number, modifier: number) =>
  binding.kind !== "none" &&
  normalizedModifier(modifier) === modifierValue(binding.modifiers) &&
  enhancedKeyCodes(binding).includes(key);

export const matchesEnhancedSwitchKey = (
  binding: SwitchKeyBinding,
  key: number,
  modifier: number,
) =>
  matchesEnhancedBinding(binding, key, modifier) ||
  matchesEnhancedBinding(FALLBACK_SWITCH_KEY, key, modifier);

export const switchKeyWarning = (binding: SwitchKeyBinding) => {
  if (binding.kind === "none") return "The primary switch key is disabled; F6 remains available.";
  if (legacySequencesFor(binding).length === 0) {
    return `${binding.label} requires a terminal that reports this key with CSI-u/Kitty keyboard events.`;
  }
  if (
    binding.kind === "character" &&
    !binding.modifiers.ctrl &&
    !binding.modifiers.alt &&
    !binding.modifiers.super &&
    !binding.modifiers.hyper &&
    !binding.modifiers.meta
  ) {
    return `${binding.label} is ordinary typing, so Relay will consume it whenever the native TUI is open.`;
  }
  if (
    binding.kind === "special" &&
    !binding.modifiers.ctrl &&
    !binding.modifiers.alt &&
    !binding.modifiers.shift &&
    !binding.modifiers.super &&
    !binding.modifiers.hyper &&
    !binding.modifiers.meta
  ) {
    return `${binding.label} is a native editing key, so Relay will consume it whenever the native TUI is open.`;
  }
  return undefined;
};
