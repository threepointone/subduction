// Live workspace demo — Automerge documents synced over Subduction, persisted
// in the browser (IndexedDB), coordinated by the subduct.io Durable Object.
//
// A "workspace" is one Subduction room (`/sync/<workspace>`). Inside it:
//   * a **manifest** document (id derived from the workspace) lists the files
//   * each **file** is its own Automerge document (its own sedimentree)
// All of them multiplex over a single WebSocket via RoomClient, and every edit
// is an Automerge change stored as a Subduction commit (see synced-doc.js).

import init, {
  Subduction,
  MemorySigner,
  IndexedDbStorage,
  SedimentreeId,
} from "./pkg/subduction_wasm.js";
import { RoomClient } from "./room-client.js";
import { SyncedDoc } from "./synced-doc.js";

const AUTOMERGE_URL = "./automerge.js"; // self-hosted, same-origin (see scripts/vendor-automerge.mjs)
const SERVICE_NAME = "subduction-do";

// ── tiny helpers ──────────────────────────────────────────────────────────
const el = (id) => document.getElementById(id);
const enc = new TextEncoder();

function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function randomHex(nbytes) {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(nbytes)));
}
async function sha256(str) {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(str));
  return new Uint8Array(digest);
}

let toastTimer = null;
function toast(msg) {
  const t = el("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 1800);
}

// Minimal, safe-ish Markdown → HTML (escape first, then a few inline/block rules).
function renderMarkdown(src) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  const lines = (src || "").split("\n");
  let html = "";
  let i = 0;
  let list = null; // "ul" | "ol" | null
  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };

  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      closeList();
      i++;
      let code = "";
      while (i < lines.length && !/^```/.test(lines[i])) { code += lines[i] + "\n"; i++; }
      i++;
      html += `<pre><code>${esc(code.replace(/\n$/, ""))}</code></pre>`;
      continue;
    }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) { closeList(); html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`; i++; continue; }
    if (/^>\s?/.test(line)) { closeList(); html += `<blockquote>${inline(line.replace(/^>\s?/, ""))}</blockquote>`; i++; continue; }
    const ul = line.match(/^[-*]\s+(.*)$/);
    const ol = line.match(/^\d+\.\s+(.*)$/);
    if (ul) { if (list !== "ul") { closeList(); list = "ul"; html += "<ul>"; } html += `<li>${inline(ul[1])}</li>`; i++; continue; }
    if (ol) { if (list !== "ol") { closeList(); list = "ol"; html += "<ol>"; } html += `<li>${inline(ol[1])}</li>`; i++; continue; }
    if (line.trim() === "") { closeList(); i++; continue; }
    closeList();
    html += `<p>${inline(line)}</p>`;
    i++;
  }
  closeList();
  return html || '<p style="color:var(--muted)">Nothing here yet.</p>';
}

function serverBase() {
  const params = new URLSearchParams(location.search);
  let base = params.get("server");
  if (!base) {
    const localHost = /^(localhost|127\.|0\.0\.0\.0)/.test(location.hostname) || location.protocol === "file:";
    base = localHost ? "wss://subduct.io" : (location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host;
  }
  return base.replace(/\/+$/, "");
}
function withAuth(url) {
  const token = new URLSearchParams(location.search).get("auth");
  if (token) url.searchParams.set("auth", token);
  return url;
}

function loadSigner() {
  const KEY = "subduct.demo.seed";
  let hex = localStorage.getItem(KEY);
  if (!hex || hex.length !== 64) {
    hex = randomHex(32);
    localStorage.setItem(KEY, hex);
  }
  return MemorySigner.fromBytes(hexToBytes(hex));
}

// ── app state ───────────────────────────────────────────────────────────
let A; // the @automerge/automerge module
let subduction;
let room;
let manifest; // SyncedDoc for the file index
let manifestSedId;
const files = new Map(); // docIdHex -> { docIdHex, sedId, sedStr, doc: SyncedDoc, name, kind }
const bySed = new Map(); // sedStr -> docIdHex
let current = null; // open file entry
let pushTimer = null;

function bodyOf(entry) {
  const b = entry?.doc?.doc?.body;
  return typeof b === "string" ? b : "";
}

function setText(d, value) {
  if (typeof d.body !== "string") {
    d.body = value;
  } else if (typeof A.updateText === "function") {
    A.updateText(d, ["body"], value);
  } else {
    d.body = value;
  }
}

// ── rendering ─────────────────────────────────────────────────────────────
function renderFileList() {
  const list = el("file-list");
  const entries = [...files.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (entries.length === 0) {
    list.innerHTML = '<li class="empty-note">No files yet. Hit <b>+ New</b> to create one.</li>';
    return;
  }
  list.innerHTML = "";
  for (const entry of entries) {
    const li = document.createElement("li");
    if (current && current.docIdHex === entry.docIdHex) li.className = "active";
    li.innerHTML = `<span class="fi">📄</span><span class="fname"></span>`;
    li.querySelector(".fname").textContent = entry.name || "Untitled";
    li.addEventListener("click", () => openFile(entry.docIdHex));
    list.appendChild(li);
  }
}

function refreshPreview(value) {
  const tabPreview = el("preview");
  if (!tabPreview.hidden) tabPreview.innerHTML = renderMarkdown(value);
}

function openFile(docIdHex) {
  const entry = files.get(docIdHex);
  if (!entry) return;
  flushPush(); // persist the previously-open doc's pending edit before switching
  current = entry;
  el("empty").hidden = true;
  el("doc").hidden = false;
  el("doc-name").value = entry.name || "Untitled";
  el("editor").value = bodyOf(entry);
  refreshPreview(bodyOf(entry));
  renderFileList();
}

function closeEditor() {
  current = null;
  el("doc").hidden = true;
  el("empty").hidden = false;
}

// ── file operations ────────────────────────────────────────────────────────
async function createFile() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const docIdHex = bytesToHex(bytes);
  const sedId = SedimentreeId.fromBytes(bytes);
  const name = uniqueName("Untitled.md");

  const doc = new SyncedDoc({ subduction, A, sedId });
  const entry = { docIdHex, sedId, sedStr: sedId.toString(), doc, name, kind: "markdown" };
  files.set(docIdHex, entry);
  bySed.set(entry.sedStr, docIdHex);

  // Show it immediately; persist + broadcast happen after (network can be slow).
  renderFileList();
  openFile(docIdHex);
  el("editor").focus();

  await doc.change((d) => { d.body = ""; });
  await manifest.change((m) => {
    if (!m.files) m.files = {};
    m.files[docIdHex] = { name, kind: "markdown", createdAt: Date.now() };
  });
  if (room) await room.addDoc(sedId);
}

function uniqueName(base) {
  const names = new Set([...files.values()].map((f) => f.name));
  if (!names.has(base)) return base;
  const stem = base.replace(/\.md$/, "");
  for (let n = 2; ; n++) {
    const candidate = `${stem} ${n}.md`;
    if (!names.has(candidate)) return candidate;
  }
}

async function renameCurrent(newName) {
  if (!current) return;
  newName = (newName || "").trim() || "Untitled";
  if (newName === current.name) return;
  current.name = newName;
  await manifest.change((m) => {
    if (m.files && m.files[current.docIdHex]) m.files[current.docIdHex].name = newName;
  });
  renderFileList();
}

async function deleteCurrent() {
  if (!current) return;
  const entry = current;
  if (!confirm(`Delete “${entry.name}”? This removes it from the workspace.`)) return;
  await manifest.change((m) => {
    if (m.files) delete m.files[entry.docIdHex];
  });
  files.delete(entry.docIdHex);
  bySed.delete(entry.sedStr);
  if (room) room.removeDoc(entry.sedId);
  try { await subduction.removeSedimentree(entry.sedId); } catch (_) { /* best-effort */ }
  closeEditor();
  renderFileList();
}

function schedulePush() {
  clearTimeout(pushTimer);
  const entry = current;
  const value = el("editor").value;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    if (!entry) return;
    entry.doc.change((d) => setText(d, value)).catch((e) => console.error("push failed", e));
  }, 300);
}

/** Immediately persist+broadcast the currently-open doc's pending edit (if any). */
function flushPush() {
  if (!pushTimer) return;
  clearTimeout(pushTimer);
  pushTimer = null;
  const entry = current;
  if (!entry) return;
  const value = el("editor").value;
  entry.doc.change((d) => setText(d, value)).catch((e) => console.error("push failed", e));
}

// ── remote reconciliation ───────────────────────────────────────────────────
async function reconcileFiles() {
  const manifestFiles = manifest.doc.files || {};
  // Additions + name updates.
  for (const [docIdHex, meta] of Object.entries(manifestFiles)) {
    let entry = files.get(docIdHex);
    if (!entry) {
      const sedId = SedimentreeId.fromBytes(hexToBytes(docIdHex));
      const doc = new SyncedDoc({ subduction, A, sedId });
      entry = { docIdHex, sedId, sedStr: sedId.toString(), doc, name: meta.name, kind: meta.kind || "markdown" };
      files.set(docIdHex, entry);
      bySed.set(entry.sedStr, docIdHex);
      await doc.load();
      if (room) await room.addDoc(sedId);
    } else if (meta.name && meta.name !== entry.name) {
      entry.name = meta.name;
      if (current && current.docIdHex === docIdHex && document.activeElement !== el("doc-name")) {
        el("doc-name").value = meta.name;
      }
    }
  }
  // Removals.
  for (const docIdHex of [...files.keys()]) {
    if (!manifestFiles[docIdHex]) {
      const entry = files.get(docIdHex);
      files.delete(docIdHex);
      bySed.delete(entry.sedStr);
      if (room) room.removeDoc(entry.sedId);
      if (current && current.docIdHex === docIdHex) closeEditor();
    }
  }
  renderFileList();
}

async function onRemote(sedId) {
  const s = sedId.toString();
  if (s === manifestSedId.toString()) {
    await manifest.pull();
    await reconcileFiles();
    return;
  }
  const docIdHex = bySed.get(s);
  if (!docIdHex) return;
  const entry = files.get(docIdHex);
  if (!entry) return;
  const changed = await entry.doc.pull();
  if (changed && current && current.docIdHex === docIdHex) {
    const value = bodyOf(entry);
    // Don't clobber the caret while the author is actively typing here.
    if (document.activeElement !== el("editor")) {
      el("editor").value = value;
      refreshPreview(value);
    } else {
      refreshPreview(value);
      toast("Merged a remote edit");
    }
  }
}

// ── connection status ───────────────────────────────────────────────────────
function setPill(state) {
  const pill = el("conn-pill");
  pill.hidden = false;
  pill.className = "pill " + state;
  pill.textContent = state === "connected" ? "live" : state;
}

// ── boot ────────────────────────────────────────────────────────────────────
function showGate() {
  el("gate").hidden = false;
  el("app").hidden = true;
  el("create-ws").addEventListener("click", () => {
    location.search = "?w=" + randomHex(8);
  });
  el("join-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const id = el("join-id").value.trim();
    if (id) location.search = "?w=" + encodeURIComponent(id);
  });
}

async function start(workspace) {
  el("gate").hidden = true;
  el("app").hidden = false;
  el("ws-info").hidden = false;
  el("ws-id").textContent = workspace.length > 16 ? workspace.slice(0, 8) + "…" : workspace;
  setPill("connecting");

  // Load Automerge + the wasm engine in parallel.
  const [automerge] = await Promise.all([import(AUTOMERGE_URL), init()]);
  A = automerge;

  const signer = loadSigner();
  const storage = await IndexedDbStorage.setup(indexedDB, "subduct.demo:" + workspace);
  subduction = new Subduction({ signer, storage, onRemoteHeads: onRemote });

  manifestSedId = SedimentreeId.fromBytes(await sha256("subduct.io/demo/manifest/v1:" + workspace));
  manifest = new SyncedDoc({ subduction, A, sedId: manifestSedId });
  await manifest.load();
  await reconcileFiles(); // hydrate file docs from local storage first

  room = new RoomClient({
    subduction,
    signer,
    url: withAuth(new URL(serverBase() + "/sync/" + encodeURIComponent(workspace))),
    serviceName: SERVICE_NAME,
    SubductionWebSocket: (await import("./pkg/subduction_wasm.js")).SubductionWebSocket,
    onStatus: (state) => setPill(state),
    onError: (e) => console.warn("room:", e?.message || e),
  });

  await room.open();
  await room.addDoc(manifestSedId);
  for (const entry of files.values()) await room.addDoc(entry.sedId);

  // Pull anything the server had that we didn't (first-time join / other device).
  if (await manifest.pull()) await reconcileFiles();
  for (const entry of files.values()) {
    if (await entry.doc.pull()) {
      if (current && current.docIdHex === entry.docIdHex && document.activeElement !== el("editor")) {
        el("editor").value = bodyOf(entry);
        refreshPreview(bodyOf(entry));
      }
    }
  }

  wireEditor();
  if (files.size > 0 && !current) {
    openFile([...files.values()].sort((a, b) => a.name.localeCompare(b.name))[0].docIdHex);
  }
}

function wireEditor() {
  el("new-file").addEventListener("click", () => createFile().catch((e) => console.error(e)));
  el("del-file").addEventListener("click", () => deleteCurrent().catch((e) => console.error(e)));
  el("editor").addEventListener("input", () => { refreshPreview(el("editor").value); schedulePush(); });
  el("editor").addEventListener("blur", () => flushPush());
  window.addEventListener("beforeunload", () => flushPush());
  el("doc-name").addEventListener("change", () => renameCurrent(el("doc-name").value));
  el("doc-name").addEventListener("keydown", (e) => { if (e.key === "Enter") el("doc-name").blur(); });

  for (const tab of document.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const preview = tab.dataset.tab === "preview";
      el("preview").hidden = !preview;
      el("editor").hidden = preview;
      if (preview) refreshPreview(el("editor").value);
    });
  }

  el("copy-link").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(location.href); toast("Share link copied"); }
    catch (_) { toast("Copy failed"); }
  });
}

async function boot() {
  const workspace = new URLSearchParams(location.search).get("w");
  if (!workspace) { showGate(); return; }
  try {
    await start(workspace);
  } catch (e) {
    console.error(e);
    setPill("closed");
    toast("Failed to start: " + (e?.message || e));
  }
}

boot();
