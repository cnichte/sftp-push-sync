export class SyncPlanner {
  static partition(source, target) {
    const add = [];
    const update = [];
    const compare = [];
    for (const [rel, entry] of source) {
      if (!target.has(rel)) add.push(rel);
      else if (entry.size !== target.get(rel).size) update.push(rel);
      else compare.push(rel);
    }
    return { add, update, compare };
  }

  static deletions(source, target, { mode = "mirror", owned = new Set() } = {}) {
    if (!["mirror", "managed"].includes(mode)) throw new Error(`Unknown sync mode: ${mode}`);
    return [...target.keys()].filter((rel) => !source.has(rel) && (mode === "mirror" || owned.has(rel)));
  }
}
