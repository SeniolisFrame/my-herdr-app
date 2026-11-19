// Files: the open file (edit, save, find, replace), its blame and history.
import { EditorState } from "gpui-base";
import { readTextFile, writeTextFile, theme, settings } from "herdr";
import { READ, git, toLines, untab, diffRows, sendToChat } from "./common.js";
import { usesTabs, tabsToSpaces, spacesToTabs, replaceAll, snippet, parseCsv, guessSeparator } from "./text.js";

export const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
export const MAX_EDIT = 400000;

// git blame --porcelain → one row per line (a commit's author and date come once, on its first line).
export function parseBlame(out) {
  const rows = [], meta = {};
  let cur = null;
  for (const line of out.split(/\r?\n/)) { // a CRLF file keeps its \r in blame's text lines
    if (line.startsWith("\t")) { const m = meta[cur.hash]; rows.push({ ...cur, author: m.author, date: m.date, text: untab(line.slice(1)) || " " }); continue; }
    const head = /^([0-9a-f]{40}) \d+ (\d+)/.exec(line);
    if (head) { cur = { hash: head[1], line: +head[2] }; meta[cur.hash] ??= {}; continue; }
    if (!cur) continue;
    if (line.startsWith("author ")) meta[cur.hash].author = line.slice(7);
    if (line.startsWith("author-time ")) meta[cur.hash].date = new Date(+line.slice(12) * 1000).toISOString().slice(0, 10);
  }
  return rows;
}

export const editorMethods = {
  dirty() { return Boolean(this.code && !this.readonly && this.code.value() !== this.shown); },

  close() {
    this.code?.release(); this.code = null; this.file = null; this.fileError = null; this.mode = "edit";
    this.rows = null; this.note = null; this.confirmClose = false; this.codeMenu = null;
    this.table = null; this.sepIn.set_value(""); // the next CSV finds its own separator
  },

  // CSV / TSV: the open file as a table (Find filters its rows, Separator splits it).
  isTable() { return /\.(csv|tsv)$/i.test(this.file ?? ""); },

  showTable(cx) {
    if (this.mode === "table" || !this.code) { this.mode = "edit"; cx?.notify(); return; }
    this.mode = "table"; this.makeTable(); cx?.notify();
  },

  // Parses the text as it is now (unsaved edits too). An empty Separator box guesses one and
  // shows it; "tab" (or \t) is a tab.
  makeTable() {
    const text = this.tabs ? spacesToTabs(this.code.value()) : this.code.value(), typed = this.sepIn.value();
    const sep = typed === "tab" || typed === "\\t" ? "\t" : typed ? typed[0] : guessSeparator(text), named = sep === "\t" ? "tab" : sep;
    const rows = parseCsv(text, sep), head = rows.slice(0, 200);
    let cols = 0;
    for (const r of rows) if (r.length > cols) cols = r.length; // a later row may have more cells
    // Sized by the first 200 rows: about 7px a character in the 12px code font, 40 to 320.
    const longest = (j) => Math.max(0, ...head.map((r) => (r[j] ?? "").length));
    const widths = Array.from({ length: cols }, (_, j) => { const n = longest(j); return n ? Math.min(320, Math.max(40, 14 + 7 * n)) : 120; });
    // sep: what the box shows for it, so the box's change event (main.js) knows this one is made.
    this.table = { rows, widths, q: null, shown: [], sep: named };
    if (!typed) this.sepIn.set_value(named);
  },

  // Files under the tree's folder are kept relative; Changes may send a repo file
  // outside it (the tree shows a subfolder of the repo), which stays absolute.
  full(path) { return /^([A-Za-z]:)?[\\/]/.test(path) ? path : `${this.root}/${path}`; },

  rel(path) {
    const root = this.root.replace(/\\/g, "/").replace(/\/$/, ""), p = path.replace(/\\/g, "/");
    return p.toLowerCase().startsWith(root.toLowerCase() + "/") ? p.slice(root.length + 1) : p;
  },

  // pos: { line } (1-based); { line, word } also selects that word on the line.
  open(path, pos, cx) {
    this.close(); this.file = path;
    if (!cx) return;
    const context = this.context, full = this.full(path), on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(full, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        const t = theme(), ext = path.includes(".") ? path.split(".").pop().toLowerCase() : "txt";
        // Big files and other machines' files open read-only (writeTextFile is local only).
        this.readonly = text.length > MAX_EDIT || Boolean(on);
        this.disk = text; this.crlf = text.includes("\r\n");
        const plain = text.replace(/\r\n/g, "\n");
        this.tabs = text.length <= MAX_EDIT && usesTabs(plain);
        this.shown = text.length > MAX_EDIT ? text.slice(0, MAX_EDIT) + "\n… (file truncated, read-only)"
          : this.tabs ? tabsToSpaces(plain) : plain;
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: this.readonly, value: this.shown,
          font_family: settings().font_family, font_size: 13,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
        this.shown = this.code.value(); // as the editor holds it, so "changed" compares like with like
        this.code.on("change", (_e, cx) => { const d = this.dirty(); if (d !== this.wasDirty) { this.wasDirty = d; cx.notify(); } });
        this.wasDirty = false;
        if (pos) this.goTo(pos);
        else if (this.isTable()) this.showTable();
      } catch (e) { if (this.file === path && this.current(context)) this.fileError = `Cannot open this file: ${e}`; }
      finally { cx.notify(); }
    });
  },

  // The open file changed on disk (Changes discarded lines, the chat edited it): show the
  // new text, cursor kept. Not over unsaved edits here: Save then says the file changed.
  async reloadOpen(context) {
    const path = this.file, code = this.code;
    if (!code || this.readonly || this.dirty()) return;
    const text = await readTextFile(this.full(path), { on: this.on });
    if (this.file !== path || this.code !== code || !this.current(context) || this.dirty()) return;
    if (text === null || text === this.disk || text.length > MAX_EDIT || text.includes("\0")) return;
    const at = code.selected_range(), plain = text.replace(/\r\n/g, "\n");
    this.disk = text; this.crlf = text.includes("\r\n"); this.tabs = usesTabs(plain);
    code.set_value(this.tabs ? tabsToSpaces(plain) : plain);
    this.shown = code.value(); this.wasDirty = false;
    const n = this.shown.length;
    code.set_selected_range({ start: Math.min(at.start, n), end: Math.min(at.end, n) });
    if (this.mode === "table") this.makeTable();
  },

  // Puts the cursor at the start of { line }, selecting { word } on it.
  goTo({ line, word }) {
    const text = this.code.value();
    let start = 0;
    for (let i = 1; i < line && start >= 0; i++) start = text.indexOf("\n", start) + 1 || -1;
    if (start < 0) return;
    const eol = text.indexOf("\n", start), w = word ? text.indexOf(word, start) : -1;
    const hit = w >= 0 && (eol < 0 || w < eol);
    this.code.set_selected_range({ start: hit ? w : start, end: hit ? w + word.length : start });
    this.code.focus();
  },

  save(cx) {
    if (!this.dirty()) return;
    const full = this.full(this.file), path = this.file;
    let text = this.code.value();
    if (this.tabs) text = spacesToTabs(text);
    if (this.crlf) text = text.replace(/\r?\n/g, "\r\n");
    cx.spawn(async cx => {
      try {
        await writeTextFile(full, text, this.disk);
        if (this.file !== path) return;
        this.disk = text; this.shown = this.code.value(); this.wasDirty = false; this.note = "Saved";
        this.refresh(cx);
      } catch (e) { this.note = `Not saved: ${String(e).includes("stale") || String(e).includes("match") ? "the file changed on disk; close it without saving and open it again" : e}`; }
      cx.notify();
    });
  },

  // The selected code to the chat, with its file and lines (right-click in the file).
  sendCode(cx) {
    this.codeMenu = null;
    const r = this.code?.selected_range();
    if (!r || r.start === r.end) { this.note = "Select some code first"; cx.notify(); return; }
    const message = snippet(this.file, this.code.value(), r.start, r.end);
    cx.spawn(async (cx) => {
      try { await sendToChat(this.tabs ? spacesToTabs(message) : message, cx); this.note = null; }
      catch (e) { this.note = `Not sent: ${e.message ?? e}`; }
      cx.notify();
    });
    cx.notify();
  },

  // ctrl+h: Replace swaps the found text under the cursor and finds the next one;
  // All swaps every one in the file (the file then needs saving).
  replaceOne(cx) {
    const q = this.find.value(), r = this.code?.selected_range();
    if (!q || !r || this.readonly) return;
    if (this.code.value().slice(r.start, r.end).toLowerCase() === q.toLowerCase()) this.code.replace(this.replaceIn.value());
    if (this.mode === "table") this.makeTable(); // the table shows the text as it is now
    this.findNext(cx);
  },

  replaceEvery(cx) {
    const q = this.find.value();
    if (!q || !this.code || this.readonly) return;
    const { text, n } = replaceAll(this.code.value(), q, this.replaceIn.value());
    if (n) this.code.set_value(text);
    if (n && this.mode === "table") this.makeTable();
    this.wasDirty = this.dirty(); this.note = n ? `Replaced ${n} in this file: save to keep it` : `“${q}” not found`;
    cx.notify();
  },

  findNext(cx) {
    const q = this.find.value().toLowerCase();
    if (!q || !this.code || this.mode === "table") return; // a table: Find filters its rows instead
    const text = this.code.value(), low = text.toLowerCase(), from = this.code.selected_range().end;
    let at = low.indexOf(q, from);
    if (at < 0) at = low.indexOf(q);
    this.note = at < 0 ? `“${this.find.value()}” not found` : null;
    if (at >= 0) this.code.set_selected_range({ start: at, end: at + q.length });
    cx.notify();
  },

  // Blame and history of the open file, as rows under the header.
  showBlame(cx) {
    if (this.mode === "blame") { this.mode = "edit"; cx.notify(); return; }
    this.loadRows("blame", async () => parseBlame(await git(this.root, this.on, [...READ, "blame", "--porcelain", "--", this.file])), cx);
  },

  showHistory(cx) {
    if (this.mode === "history") { this.mode = "edit"; cx.notify(); return; }
    this.loadRows("history", async () => (await git(this.root, this.on, [...READ, "log", "--follow", "-n", "300", "--date=short", "--format=%h%x09%ad%x09%an%x09%s", "--", this.file]))
      .split("\n").filter(Boolean).map(l => { const [hash, date, author, ...s] = l.split("\t"); return { hash, date, author, subject: s.join("\t") }; }), cx);
  },

  showCommit(hash, cx) {
    this.commit = hash;
    this.loadRows("commit", async () => diffRows(toLines(await git(this.root, this.on, [...READ, "show", "--format=%h %an, %ad%n%n%s%n", "--date=short", "--no-color", "--no-ext-diff", hash, "--", this.file]))), cx);
  },

  loadRows(mode, load, cx) {
    const path = this.file;
    this.mode = mode; this.rows = null; this.note = null;
    cx.spawn(async cx => {
      try { const rows = await load(); if (this.file === path && this.mode === mode) this.rows = rows; }
      catch (e) { if (this.file === path) { this.note = String(e.message ?? e); this.mode = "edit"; } }
      cx.notify();
    });
    cx.notify();
  },
};
