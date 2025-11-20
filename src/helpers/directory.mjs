/**
 * directory.mjs
 * 
 * @author Carsten Nichte, 2025 / https://carsten-nichte.de/
 * 
 */
// src/helpers/directory.mjs
import path from "path";

/**
 * Konvertiert einen Pfad in POSIX-Notation (immer /)
 */
export function toPosix(p) {
  return p.split(path.sep).join("/");
}

/**
 * Kürzt einen Pfad für die Progressanzeige:
 * …/parent/file.ext
 */
export function shortenPathForProgress(rel) {
  if (!rel) return "";
  const parts = rel.split("/");
  if (parts.length <= 2) return rel;

  const last = parts[parts.length - 1];
  const prev = parts[parts.length - 2];
  return `…/${prev}/${last}`;
}