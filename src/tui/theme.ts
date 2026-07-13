import type { Harness } from "../domain.ts";

export const theme = {
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
} as const;

export const harnessColor = (harness: Harness) => theme[harness];

export const harnessName = (harness: Harness) => (harness === "codex" ? "Codex" : "OpenCode");
