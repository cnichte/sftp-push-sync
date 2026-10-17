import { Minimatch } from "minimatch";

export class FileFilter {
  constructor({ include, exclude } = {}) {
    this.include = FileFilter.validatePatterns(include);
    this.exclude = FileFilter.validatePatterns(exclude);
    const options = { dot: true, nonegate: true, nocomment: true };
    this.included = this.include.map((pattern) => new Minimatch(pattern, options));
    this.excluded = this.exclude.map((pattern) => new Minimatch(pattern, options));
  }

  static validatePatterns(value) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((pattern) =>
      typeof pattern !== "string" || !pattern.trim() || pattern !== pattern.trim() ||
      pattern.startsWith("!") || pattern.startsWith("/") || /^[a-z]:/i.test(pattern) ||
      /[\\\x00-\x1f]/.test(pattern) ||
      pattern.split("/").some((segment) => segment === ".." || segment === "."))) {
      throw new Error("Patterns must be nonempty relative glob paths using /, without negation or ..");
    }
    return [...value];
  }

  excludesDirectory(rel) {
    return this.excluded.some((pattern) => pattern.match(rel) || pattern.match(`${rel}/`));
  }

  includesFile(rel) {
    return !this.excluded.some((pattern) => pattern.match(rel)) &&
      (!this.included.length || this.included.some((pattern) => pattern.match(rel)));
  }
}
