import { describe, expect, it } from "vitest";

import {
  legacySwitchSequences,
  matchesEnhancedSwitchKey,
  parseSwitchKey,
  switchKeyWarning,
} from "../src/switch-key.ts";

const sequenceHex = (binding: string) =>
  legacySwitchSequences(parseSwitchKey(binding)).map((sequence) => sequence.toString("hex"));

describe("switch key bindings", () => {
  it("accepts arbitrary terminal-observable single-key chords", () => {
    expect(parseSwitchKey("Option+Shift+k").label).toBe("Alt+Shift+K");
    expect(parseSwitchKey("Command+Hyper+Meta+p").label).toBe("Super+Hyper+Meta+P");
    expect(parseSwitchKey("Ctrl+Alt+F35").label).toBe("Ctrl+Alt+F35");
    expect(parseSwitchKey("Shift+Media_Play_Pause").label).toBe("Shift+MediaPlayPause");
    expect(parseSwitchKey("Numpad7").label).toBe("KP7");
    expect(parseSwitchKey("PgDn").label).toBe("PageDown");
    expect(parseSwitchKey("Clear").label).toBe("KPBegin");
    expect(parseSwitchKey("Ctrl+λ").label).toBe("Ctrl+λ");
    expect(parseSwitchKey("Super+KeyCode:60000").label).toBe("Super+KeyCode:60000");
    expect(parseSwitchKey("none")).toEqual({ kind: "none", label: "none" });
  });

  it("rejects values that are not one key chord", () => {
    for (const value of ["", "Ctrl", "Ctrl+K+P", "F36", "Ctrl++K", "KeyCode:nope"]) {
      expect(() => parseSwitchKey(value)).toThrow("Unsupported switch key");
    }
  });

  it("recognizes legacy encodings whenever the terminal has one", () => {
    expect(sequenceHex("Ctrl+G")).toContain("07");
    expect(sequenceHex("Alt+Shift+K")).toContain("1b4b");
    expect(sequenceHex("λ")).toContain(Buffer.from("λ").toString("hex"));
    expect(sequenceHex("F2")).toEqual(expect.arrayContaining(["1b4f51", "1b5b31327e"]));
    expect(sequenceHex("Shift+Tab")).toContain("1b5b5a");
    expect(sequenceHex("Ctrl+Backspace")).toContain("08");
    expect(sequenceHex("Super+Left")).toContain("1b5b313b3944");
    expect(sequenceHex("Hyper+F2")).toContain("1b5b313b313751");
  });

  it("does not erase modifiers that legacy terminals cannot distinguish", () => {
    for (const binding of [
      "Shift+Return",
      "Ctrl+Return",
      "Ctrl+Tab",
      "Shift+Escape",
      "Shift+Backspace",
    ]) {
      expect(sequenceHex(binding)).toEqual(["1b5b31377e"]);
      expect(switchKeyWarning(parseSwitchKey(binding))).toContain("CSI-u/Kitty");
    }
  });

  it("always retains F6 as a fallback", () => {
    for (const binding of ["Ctrl+G", "Super+K", "KeyCode:60000", "none"]) {
      expect(sequenceHex(binding)).toContain("1b5b31377e");
      expect(matchesEnhancedSwitchKey(parseSwitchKey(binding), 57_369, 1)).toBe(true);
    }
  });

  it("matches enhanced key reports with all modifiers and ignores lock-state bits", () => {
    const ctrlShift = parseSwitchKey("Ctrl+Shift+K");
    expect(matchesEnhancedSwitchKey(ctrlShift, 107, 6)).toBe(true);
    expect(matchesEnhancedSwitchKey(ctrlShift, 107, 70)).toBe(true);
    expect(matchesEnhancedSwitchKey(ctrlShift, 107, 5)).toBe(false);

    const extended = parseSwitchKey("Super+Hyper+Meta+KeyCode:60000");
    expect(matchesEnhancedSwitchKey(extended, 60_000, 57)).toBe(true);
    expect(matchesEnhancedSwitchKey(parseSwitchKey("F35"), 57_398, 1)).toBe(true);
    expect(matchesEnhancedSwitchKey(parseSwitchKey("MediaPlay"), 57_428, 1)).toBe(true);
    expect(matchesEnhancedSwitchKey(parseSwitchKey("Super+Left"), 57_350, 9)).toBe(true);
    expect(matchesEnhancedSwitchKey(parseSwitchKey("Shift+Return"), 57_345, 2)).toBe(true);
  });

  it("warns without forbidding ambiguous or enhanced-only bindings", () => {
    expect(switchKeyWarning(parseSwitchKey("x"))).toContain("ordinary typing");
    expect(switchKeyWarning(parseSwitchKey("Enter"))).toContain("native editing key");
    expect(switchKeyWarning(parseSwitchKey("Super+K"))).toContain("CSI-u/Kitty");
    expect(switchKeyWarning(parseSwitchKey("none"))).toContain("F6 remains available");
    expect(switchKeyWarning(parseSwitchKey("Ctrl+G"))).toBeUndefined();
  });
});
