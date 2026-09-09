/**
 * progress-constants.mjs
 * Central constants for progress and output formatting.
 * 
 * @author Carsten Nichte, 2025, https://carsten-nichte.de/
 * 
 */ 
// src/helpers/progress-constants.mjs
export const hr1 = () => "─".repeat(65); // horizontal line -
export const hr2 = () => "=".repeat(65); // horizontal line =

// Einrückungen (Tabs) für konsistente Ausgabe
export const TAB_A = "   ";   // 3 Spaces
export const TAB_B = "      "; // 6 Spaces

// Spinner-Frames für Progress-Anzeigen
export const SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
];

export const PROGRESS_STATUS_LABELS = {
  queued: "waiting",
  local: "comparing local",
  remote: "comparing remote",
  text: "comparing text",
  done: "identical",
  changed: "changed",
  error: "failed",
};