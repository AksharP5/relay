import type { Harness, Skin } from "../domain.ts";

export interface RelayTheme {
  readonly background: string;
  readonly panel: string;
  readonly panelRaised: string;
  readonly border: string;
  readonly text: string;
  readonly muted: string;
  readonly subtle: string;
  readonly error: string;
  readonly codex: string;
  readonly opencode: string;
}

const opencodeTheme: RelayTheme = {
  background: "#0b0d10",
  panel: "#13171c",
  panelRaised: "#1a2027",
  border: "#303842",
  text: "#e7e9ec",
  muted: "#87909b",
  subtle: "#59636f",
  error: "#ff6b6b",
  codex: "#68a7ff",
  opencode: "#c89bff",
};

const codexTheme: RelayTheme = {
  background: "#0d0d0d",
  panel: "#0d0d0d",
  panelRaised: "#171717",
  border: "#404040",
  text: "#e5e5e5",
  muted: "#a3a3a3",
  subtle: "#737373",
  error: "#ef4444",
  codex: "#d946ef",
  opencode: "#22d3ee",
};

export const skinTheme = (skin: Skin) => (skin === "opencode" ? opencodeTheme : codexTheme);
export const theme = opencodeTheme;

export const harnessColor = (harness: Harness, palette: RelayTheme = theme) => palette[harness];

export const harnessName = (harness: Harness) => (harness === "codex" ? "Codex" : "OpenCode");
