// Files: the focused pane's folder as a tree. Open a file to edit it (ctrl+s saves),
// search every file, see blame and history, and send @path to the chat.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, InputState, Input } from "gpui-base";
import { exec, readTextFile, writeTextFile, watchFolder, theme, settings, window, nextCommand } from "herdr";
import { location, locationKey, git, READ, sendToChat, focusChat, diffRows, diffRow, button, untab } from "./common.js";

const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000, MAX_EDIT = 400000;

async function directory(path, on) {
  const windowsDirectory = async () => {
    // Same listing as the shipped Files panel: UTF-8 output, links checked, curly quotes doubled.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

// git blame --line-porcelain → one row per line.
function parseBlame(out) {
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

export default class Files extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.search = InputState.new({ placeholder: "Search all files  ( / )" });
    this.search.on("submit", (_e, cx) => this.runSearch(cx));
    this.search.on("focus", (_e, cx) => { this.typing = "search"; cx.notify(); });
    this.search.on("blur", (_e, cx) => { this.typing = null; cx.notify(); });
    this.find = InputState.new({ placeholder: "Find in file" });
    this.find.on("submit", (_e, cx) => this.findNext(cx));
    this.find.on("focus", (_e, cx) => { this.typing = "find"; cx.notify(); });
    this.find.on("blur", (_e, cx) => { this.typing = null; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
    cx.spawn(async cx => { for (;;) { this.command(await nextCommand(), cx); cx.notify(); } });
  }

  // Commands from keys.json ("my-files.save") or `herdr-app do my-files.save`;
  // "name:value" passes a value (open:src/a.go:12, search:text, type:text).
  command(c, cx) {
    const i = c.indexOf(":"), name = i < 0 ? c : c.slice(0, i), arg = i < 0 ? "" : c.slice(i + 1);
    const run = {
      focus: () => this.handle.focus(),
      open: () => { const m = /^(.*?)(?::(\d+))?$/.exec(arg); this.open(m[1], Number(m[2]) || 0, cx); },
      close: () => this.close(),
      save: () => this.save(cx),
      type: () => this.code && !this.readonly && this.code.replace(arg),
      find: () => { this.find.set_value(arg); this.findNext(cx); },
      search: () => { this.search.set_value(arg); this.runSearch(cx); },
      blame: () => this.file && this.showBlame(cx),
      history: () => this.file && this.showHistory(cx),
      send: () => (arg || this.file) && this.send(arg || this.file, cx),
    }[name];
    run?.();
  }

  // --- the tree --------------------------------------------------------------

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) { return this.context === context && locationKey() === context.key; }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = locationKey();
    if (next !== this.context?.key) {
      if (this.dirty()) return; // keep unsaved edits: follow the chat once they're saved or dropped
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.close(); this.watched = null; this.error = null; this.limited = false;
      this.loading = false; this.results = null; this.isRepo = false;
      if (saved?.file) this.open(saved.file, 0, cx);
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          const status = await exec("git", [...READ, "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`.toLowerCase()] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.isRepo = top?.code === 0; this.marks = marks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) { this.folders.delete(folder); this.entries.delete(folder); }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  mark(path) {
    return this.marks[`${this.root}/${path}`.replace(/\\/g, "/").toLowerCase()];
  }

  // --- the open file -----------------------------------------------------------

  dirty() { return Boolean(this.code && !this.readonly && this.code.value() !== this.shown); }

  close() {
    this.code?.release(); this.code = null; this.file = null; this.fileError = null; this.mode = "edit";
    this.rows = null; this.note = null; this.confirmClose = false;
  }

  open(path, line, cx) {
    this.close(); this.file = path;
    if (!cx) return;
    const context = this.context, full = `${this.root}/${path}`, on = this.on;
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
        this.shown = text.length > MAX_EDIT ? text.slice(0, MAX_EDIT) + "\n… (file truncated, read-only)" : text.replace(/\r\n/g, "\n");
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: this.readonly, value: this.shown,
          font_family: settings().font_family, font_size: 13,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
        this.shown = this.code.value(); // as the editor holds it, so "changed" compares like with like
        this.code.on("change", (_e, cx) => { const d = this.dirty(); if (d !== this.wasDirty) { this.wasDirty = d; cx.notify(); } });
        this.wasDirty = false;
        if (line > 0) this.goToLine(line);
      } catch (e) { if (this.file === path && this.current(context)) this.fileError = `Cannot open this file: ${e}`; }
      finally { cx.notify(); }
    });
  }

  // Puts the cursor at the start of line n (1-based).
  goToLine(n) {
    const text = this.code.value();
    let at = 0;
    for (let i = 1; i < n && at >= 0; i++) at = text.indexOf("\n", at) + 1 || -1;
    if (at < 0) return;
    this.code.set_selected_range({ start: at, end: at });
    this.code.focus();
  }

  save(cx) {
    if (!this.dirty()) return;
    const full = `${this.root}/${this.file}`, path = this.file;
    let text = this.code.value();
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
  }

  findNext(cx) {
    const q = this.find.value().toLowerCase();
    if (!q || !this.code) return;
    const text = this.code.value(), low = text.toLowerCase(), from = this.code.selected_range().end;
    let at = low.indexOf(q, from);
    if (at < 0) at = low.indexOf(q);
    this.note = at < 0 ? `“${this.find.value()}” not found` : null;
    if (at >= 0) this.code.set_selected_range({ start: at, end: at + q.length });
    cx.notify();
  }

  // Blame and history of the open file, as rows under the header.
  showBlame(cx) {
    if (this.mode === "blame") { this.mode = "edit"; cx.notify(); return; }
    this.loadRows("blame", async () => parseBlame(await git(this.root, this.on, [...READ, "blame", "--line-porcelain", "--", this.file])), cx);
  }

  showHistory(cx) {
    if (this.mode === "history") { this.mode = "edit"; cx.notify(); return; }
    this.loadRows("history", async () => (await git(this.root, this.on, [...READ, "log", "--follow", "-n", "300", "--date=short", "--format=%h%x09%ad%x09%an%x09%s", "--", this.file]))
      .split("\n").filter(Boolean).map(l => { const [hash, date, author, ...s] = l.split("\t"); return { hash, date, author, subject: s.join("\t") }; }), cx);
  }

  showCommit(hash, cx) {
    this.commit = hash;
    this.loadRows("commit", async () => diffRows((await git(this.root, this.on, [...READ, "show", "--format=%h %an, %ad%n%n%s%n", "--date=short", "--no-color", "--no-ext-diff", hash, "--", this.file]))
      .replace(/\n$/, "").split("\n")), cx);
  }

  loadRows(mode, load, cx) {
    const path = this.file;
    this.mode = mode; this.rows = null; this.note = null;
    cx.spawn(async cx => {
      try { const rows = await load(); if (this.file === path && this.mode === mode) this.rows = rows; }
      catch (e) { if (this.file === path) { this.note = String(e.message ?? e); this.mode = "edit"; } }
      cx.notify();
    });
    cx.notify();
  }

  // --- search all files --------------------------------------------------------

  runSearch(cx) {
    const q = this.search.value().trim();
    if (!q || !this.root) { this.results = null; cx.notify(); return; }
    const root = this.root, on = this.on;
    this.results = { q, rows: [], loading: true };
    cx.spawn(async cx => {
      // git grep also searches untracked files; outside a repo it reads the folder as is.
      const args = [...READ, "grep", "-n", "-I", "-i", "-F", "--no-color", ...(this.isRepo ? ["--untracked"] : ["--no-index"]), "-e", q];
      const r = await exec("git", args, { cwd: root, on }).catch(e => ({ code: 2, stderr: String(e) }));
      if (this.results?.q !== q) return;
      const rows = r.code === 0 ? r.stdout.split(/\r?\n/).filter(Boolean).slice(0, 500).map(l => {
        const m = /^(.*?):(\d+):(.*)$/.exec(l);
        return m && { path: m[1], line: +m[2], text: untab(m[3]).trim() };
      }).filter(Boolean) : [];
      this.results = { q, rows, error: r.code > 1 ? (r.stderr || "search failed").trim() : null, more: r.stdout?.split("\n").length > 501 };
      cx.notify();
    });
    cx.notify();
  }

  // --- sending to the chat -------------------------------------------------------

  send(path, cx) {
    cx.spawn(async cx => {
      try { await sendToChat(`@${path} `, cx); this.note = null; }
      catch (e) { this.note = `Not sent: ${e.message ?? e}`; }
      cx.notify();
    });
  }

  // --- keys ----------------------------------------------------------------------

  key(e, cx) {
    const k = e.key, ctrl = e.modifiers.control || e.modifiers.platform;
    if (ctrl && k === "s") { this.save(cx); cx.stop_propagation(); return; }
    if (ctrl && k === "f" && this.code) { this.find.focus(); cx.stop_propagation(); return; }
    if (k === "escape") {
      cx.stop_propagation();
      if (this.typing) { this.typing = null; this.handle.focus(); }
      else if (this.mode !== "edit") this.mode = "edit";
      else focusChat();
      cx.notify();
      return;
    }
    if (this.typing || (this.code && !this.readonly && this.mode === "edit") || ctrl || e.modifiers.alt) return; // typing text
    if (k === "/" ) { this.search.focus(); cx.stop_propagation(); }
    else if (k === "s" && this.file) { this.send(this.file, cx); cx.stop_propagation(); }
    else if (k === "b" && this.file) { this.showBlame(cx); cx.stop_propagation(); }
    else if (k === "l" && this.file) { this.showHistory(cx); cx.stop_propagation(); }
  }

  // --- drawing -------------------------------------------------------------------

  treeRows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.mark(path);
      out.push(h_flex().id(`file-${path}`).h(26).flex_none().pl(8 + depth * 16).pr(8).gap(7).items_center().rounded(6).cursor_pointer().hover(s => s.bg(t.hover))
        .drag_paths([`${this.root}/${path}`], { on: this.on })
        .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : this.open(path, 0, cx))
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.send(path, cx); })
        .child(entry.dir ? svg(`mods/files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/files/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark))));
      if (entry.dir && open) this.treeRows(path, depth + 1, out, t);
    }
    return out;
  }

  input(id, state, focusedNow, t) {
    return div().id(id).flex_1().min_w(0).h(28).px(8).flex().items_center().rounded(7).border_1().border_color(focusedNow ? t.accent : t.border).cursor_text()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(state).h_full().text_size(12).text_color(t.foreground));
  }

  // A scrolling list that fills what's left of the panel (rows capped by the callers).
  lazy(id, count, row) {
    const out = [];
    for (let i = 0; i < Math.min(count, 5000); i++) out.push(row(i));
    return v_flex().id(id).flex_1().min_h(0).overflow_y_scrollbar().font_family(settings().font_family ?? "JetBrains Mono").text_size(12).children(out);
  }

  fileBody(t) {
    if (!this.code) return div().p(12).text_color(t.dim).child(this.fileError || "Loading file…");
    if (this.mode === "edit") return Editor.new(this.code).flex_1().min_h(0);
    if (!this.rows) return div().p(12).text_color(t.dim).child("Loading…");
    if (this.mode === "blame") {
      return this.lazy("files-blame", this.rows.length, (i) => {
        const r = this.rows[i], first = this.rows[i - 1]?.hash !== r.hash;
        return h_flex().id(`blame-${i}`).w_full().h(20).flex_none().gap(8).px(6).cursor_pointer().hover(s => s.bg(t.hover))
          .on_click((_e, cx) => { if (!/^0+$/.test(r.hash)) this.showCommit(r.hash, cx); })
          .child(div().w(160).flex_none().truncate().text_color(first ? t.muted : t.background).child(/^0+$/.test(r.hash) ? "not committed" : `${r.hash.slice(0, 7)} ${r.date} ${r.author}`))
          .child(div().w(36).flex_none().text_right().text_color(t.dim).child(String(r.line)))
          .child(div().flex_1().min_w(0).truncate().child(r.text));
      });
    }
    if (this.mode === "history") {
      if (!this.rows.length) return div().p(12).text_color(t.dim).child("No commits for this file yet");
      return v_flex().id("files-history").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows.map((r) =>
        v_flex().id(`hist-${r.hash}`).flex_none().px(8).py(5).rounded(6).cursor_pointer().hover(s => s.bg(t.hover)).on_click((_e, cx) => this.showCommit(r.hash, cx))
          .child(div().truncate().child(r.subject))
          .child(div().text_size(11).text_color(t.dim).truncate().child(`${r.hash} · ${r.date} · ${r.author}`))));
    }
    // a commit's change to this file
    return this.lazy("files-commit", this.rows.length, (i) => diffRow(this.rows[i], t));
  }

  render(cx) {
    if (locationKey() !== this.context?.key) this.refresh(cx);
    const t = theme(), file = this.file, dirty = this.dirty();
    const header = h_flex().h(42).flex_none().px(12).gap(6).items_center().border_b(1).border_color(t.border)
      .when(Boolean(file), el => el.child(button("files-back", "←", t, (_e, cx) => {
        if (this.mode !== "edit") { this.mode = "edit"; cx.notify(); return; }
        if (dirty && !this.confirmClose) { this.confirmClose = true; cx.notify(); return; }
        this.close(); cx.notify();
      })))
      .child(div().font_semibold().child("Files"))
      .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(dirty ? t.blocked : t.dim)
        .child(file ? `${file}${dirty ? " ●" : ""}` : this.root?.split(/[\\/]/).pop() ?? ""));
    const fileBar = file && h_flex().flex_none().px(10).py(6).gap(6).items_center().border_b(1).border_color(t.border)
      .child(this.input("files-find", this.find, this.typing === "find", t))
      .when(this.isRepo, el => el.child(button("files-blame", "Blame", t, (_e, cx) => this.showBlame(cx), { active: this.mode === "blame" }))
        .child(button("files-history", "History", t, (_e, cx) => this.showHistory(cx), { active: this.mode === "history" || this.mode === "commit" })))
      .child(button("files-send", "@ chat", t, (_e, cx) => this.send(file, cx)))
      .when(!this.readonly && Boolean(this.code), el => el.child(button("files-save", "Save", t, (_e, cx) => this.save(cx), { primary: true, enabled: dirty })));
    const confirm = this.confirmClose && dirty && h_flex().flex_none().px(10).py(6).gap(6).items_center().bg(t.raised)
      .child(div().flex_1().text_size(12).child("Unsaved changes."))
      .child(button("files-save-close", "Save", t, (_e, cx) => { this.save(cx); this.confirmClose = false; }, { primary: true }))
      .child(button("files-drop", "Don't save", t, (_e, cx) => { this.close(); cx.notify(); }, { danger: true }))
      .child(button("files-keep", "Cancel", t, (_e, cx) => { this.confirmClose = false; cx.notify(); }));
    const results = this.results && v_flex().id("files-results").flex_1().min_h(0).overflow_y_scrollbar().p(6)
      .child(h_flex().px(6).pb(4).gap(6).text_size(11).text_color(t.dim)
        .child(div().flex_1().child(this.results.loading ? "Searching…" : this.results.error ?? `${this.results.rows.length}${this.results.more ? "+" : ""} matches for “${this.results.q}”`))
        .child(button("files-results-close", "×", t, (_e, cx) => { this.results = null; this.search.set_value(""); cx.notify(); })))
      .children(this.results.rows.map((r, i) => v_flex().id(`hit-${i}`).flex_none().px(8).py(3).rounded(6).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => this.open(r.path, r.line, cx))
        .child(div().text_size(11).text_color(t.muted).truncate().child(`${r.path}:${r.line}`))
        .child(div().text_size(12).truncate().font_family(settings().font_family ?? "JetBrains Mono").child(r.text))));
    const tree = v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.treeRows("", 0, [], t))
      .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
      .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")));
    return v_flex().id("my-files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .child(header)
      .when(!file, el => el.child(h_flex().flex_none().px(10).py(6).border_b(1).border_color(t.border).child(this.input("files-search", this.search, this.typing === "search", t))))
      .when(Boolean(fileBar), el => el.child(fileBar))
      .when(Boolean(confirm), el => el.child(confirm))
      .when(Boolean(this.note), el => el.child(div().px(12).py(4).text_size(11).text_color(this.note === "Saved" ? t.ansi2 : t.ansi1).child(this.note)))
      .child(file ? this.fileBody(t) : results || tree)
      .child(div().flex_none().px(12).py(4).border_t(1).border_color(t.border).text_size(11).text_color(t.dim).truncate()
        .child(file ? "ctrl+s save · ctrl+f find · esc back" : "click: open · right-click or drag: @path to chat · / search · esc: chat"));
  }
}
