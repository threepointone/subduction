// SyncedDoc — bridges a single Automerge document to a Subduction sedimentree.
//
// The mapping (identical to the `automerge_subduction_ingest` crate):
//   * every Automerge *change* becomes one Subduction *loose commit*
//   * the change's hash (32 bytes) is the commit's `CommitId`
//   * the change's deps are the commit's parents
//   * the raw change bytes are the commit's blob
//
// Because a change's identity is its content hash, the same edit produces the
// same commit on every peer — so Subduction dedupes and merges histories for
// free, and Automerge reassembles a document from whatever set of change blobs
// it has (in any order; missing deps are buffered by `applyChanges`).

import { CommitId } from "./pkg/subduction_wasm.js";

export class SyncedDoc {
  /**
   * @param {object}  opts
   * @param {any}     opts.subduction  Subduction instance (owns storage + connections).
   * @param {any}     opts.A           The `@automerge/automerge` module.
   * @param {any}     opts.sedId       SedimentreeId this doc lives under.
   */
  constructor({ subduction, A, sedId }) {
    this.subduction = subduction;
    this.A = A;
    this.sedId = sedId;
    this.doc = A.init();
    /** change hashes already written to Subduction, so we never re-push. */
    this._pushed = new Set();
  }

  /** Hydrate `this.doc` from whatever is already in local storage. */
  async load() {
    const blobs = await this.subduction.getBlobs(this.sedId);
    this._applyBlobs(blobs);
    return this.doc;
  }

  /**
   * Re-read local storage and fold any newly-arrived changes into `this.doc`.
   * Call this after the server pushes updates (see `onRemoteHeads`).
   * @returns {boolean} whether the document's heads changed.
   */
  async pull() {
    const before = this.A.getHeads(this.doc).join(",");
    const blobs = await this.subduction.getBlobs(this.sedId);
    this._applyBlobs(blobs);
    return this.A.getHeads(this.doc).join(",") !== before;
  }

  /**
   * Mutate the document with an Automerge change function and propagate the
   * resulting change(s) to peers.
   * @param {(doc: any) => void} fn  Automerge change callback.
   * @param {object} [opts]
   * @param {boolean} [opts.broadcast=true]  Push to peers (vs. store locally only).
   */
  async change(fn, { broadcast = true } = {}) {
    const next = this.A.change(this.doc, fn);
    const changes = this.A.getChanges(this.doc, next);
    this.doc = next;
    await this._push(changes, broadcast);
    return this.doc;
  }

  // --- internals ---------------------------------------------------------

  _applyBlobs(blobs) {
    if (!blobs || blobs.length === 0) return;
    const changes = blobs.map((b) => (b instanceof Uint8Array ? b : new Uint8Array(b)));
    try {
      const [next] = this.A.applyChanges(this.doc, changes);
      this.doc = next;
    } catch (e) {
      // Fall back to applying changes individually so one undecodable blob
      // (e.g. a server-side fragment bundle) can't poison the whole doc.
      for (const ch of changes) {
        try {
          const [next] = this.A.applyChanges(this.doc, [ch]);
          this.doc = next;
        } catch (_) {
          /* skip */
        }
      }
    }
    for (const ch of this.A.getAllChanges(this.doc)) {
      this._pushed.add(this.A.decodeChange(ch).hash);
    }
  }

  async _push(changes, broadcast) {
    for (const ch of changes) {
      const decoded = this.A.decodeChange(ch);
      if (this._pushed.has(decoded.hash)) continue;
      const head = CommitId.fromHexString(decoded.hash);
      const parents = (decoded.deps || []).map((d) => CommitId.fromHexString(d));
      const blob = ch instanceof Uint8Array ? ch : new Uint8Array(ch);
      if (broadcast) {
        await this.subduction.addCommit(this.sedId, head, parents, blob);
      } else {
        await this.subduction.storeCommit(this.sedId, head, parents, blob);
      }
      this._pushed.add(decoded.hash);
    }
  }
}
