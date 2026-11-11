/**
 * Maps MTP objects found on the device back to ZMDB atom IDs.
 *
 * ZMDB atom IDs aren't always valid MTP handles, so before pulling a file we
 * walk the device and match each MTP object to a ZMDB entry. Matching by
 * basename alone is wrong for real libraries: names like "01 Intro.wma" or
 * "Track 01.wma" repeat across albums, so several ZMDB entries share a name.
 * Each MTP object therefore claims at most one entry, preferring one whose
 * size also matches, and each entry is claimed at most once.
 */

function baseNameOf(filename) {
  return String(filename || '').split(/[/\\]/).pop().toLowerCase();
}

class HandleIndex {
  /** @param {Array<{atomId:number, filename:string, size?:number}>} entries */
  constructor(entries) {
    this._byName = new Map();
    this.total = 0;
    for (const e of entries) {
      if (e == null || e.atomId == null || !e.filename) continue;
      const key = baseNameOf(e.filename);
      if (!key) continue;
      if (!this._byName.has(key)) this._byName.set(key, []);
      this._byName.get(key).push({ atomId: e.atomId, size: e.size || 0 });
      this.total++;
    }
  }

  /**
   * Claim the best unclaimed ZMDB entry for an MTP object.
   * @returns {number|null} the atom ID, or null if nothing matches.
   */
  claim(filename, size, { exactOnly = false } = {}) {
    const key = baseNameOf(filename);
    const candidates = this._byName.get(key);
    if (!candidates || candidates.length === 0) return null;

    let idx = size > 0 ? candidates.findIndex(c => c.size === size) : -1;
    if (idx === -1) {
      if (exactOnly) return null;
      // No exact size match: take an entry with an unknown size first, then any.
      idx = candidates.findIndex(c => !c.size);
      if (idx === -1) idx = 0;
    }
    const [hit] = candidates.splice(idx, 1);
    if (candidates.length === 0) this._byName.delete(key);
    return hit.atomId;
  }

  /**
   * Match a whole device listing. Exact name+size matches are claimed first so
   * a same-named file of a different size can't steal another file's entry.
   * @param {Array<{handle:number, filename:string, size?:number}>} objects
   * @returns {Map<number, number>} atomId -> MTP handle
   */
  matchAll(objects) {
    const result = new Map();
    const leftovers = [];
    for (const o of objects) {
      const aId = this.claim(o.filename, o.size, { exactOnly: true });
      if (aId != null) result.set(aId, o.handle);
      else leftovers.push(o);
    }
    for (const o of leftovers) {
      const aId = this.claim(o.filename, o.size);
      if (aId != null) result.set(aId, o.handle);
    }
    return result;
  }
}

module.exports = { HandleIndex, baseNameOf };
