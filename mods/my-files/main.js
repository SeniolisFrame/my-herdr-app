// Files: the focused pane's folder as a tree. Open a file to edit it (ctrl+s saves),
// search every file, see blame and history, and send @path to the chat.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, InputState, Input } from "gpui-base";
import { exec, readTextFile, writeTextFile, watchFolder, theme, settings, window, nextCommand, shared } from "herdr";
import { location, locationKey, git, READ, sendToChat, focusChat, diffRows, diffRow, button, untab } from "./common.js";
import { usesTabs, tabsToSpaces, spacesToTabs, replaceOnLines, replaceAll } from "./text.js";

const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000, MAX_EDIT = 400000;

// PowerShell takes a 'single-quoted' string with its quote marks (curly ones too) doubled.
const psQuote = (s) => "'" + s.replace(/['‘’‚‛]/g, "$&$&") + "'";

// Same listing as the shipped Files panel (UTF-8 output, links checked), for several
// folders in one PowerShell: starting it costs 0.3s to 2s here. `deep` lists each
// folder's subfolders too (the first 40), so opening one of them shows at once.
async function windowsDirectories(root, rels, on, deep) {
  const script = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($root, $deep, [string[]]$rels) "
    + "function L($p) { ,@(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) } "
    + "$out = @{}; foreach ($r in $rels) { $full = if ($r) { Join-Path $root $r } else { $root }; "
    + "try { $e = L $full; $out[$r] = $e } catch { $out[$r] = $null; continue }; "
    + "if ($deep -eq 1) { foreach ($d in @($e | Where-Object { $_.dir } | Select-Object -First 40)) { $k = if ($r) { $r + '/' + $d.name } else { $d.name }; try { $out[$k] = L (Join-Path $full $d.name) } catch {} } } }; "
    + "ConvertTo-Json -InputObject $out -Depth 4 -Compress } "
    + `${psQuote(root)} ${deep ? 1 : 0} ${rels.map(psQuote).join(",")}`;
  const r = await exec("powershell", ["-NoProfile", "-Command", script], { on });
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  return new Map(Object.entries(JSON.parse(r.stdout || "{}")).map(([k, v]) => [k, v === null ? null : Array.isArray(v) ? v : [v]]));
}

// Folders under root, by path from root ("" is root) → their entries, or null when gone.
async function directories(root, rels, on, deep) {
  if (!on && window()?.platform === "windows") return windowsDirectories(root, rels, on, deep);
  const out = new Map();
  for (const rel of rels) {
    try { out.set(rel, await directory(rel ? `${root}/${rel}` : root, on)); }
    catch (e) {
      if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectories(root, rels, on, deep);
      out.set(rel, null);
    }
  }
  return out;
}

async function directory(path, on) {
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  const r = await exec("sh", ["-c", script, "files", path], { on });
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
    this.replaceWith = InputState.new({ placeholder: "Replace with" });
    this.replaceWith.on("submit", (_e, cx) => this.results?.rows.length && this.replaceHits(this.results.rows, cx));
    this.replaceWith.on("focus", (_e, cx) => { this.typing = "replace"; cx.notify(); });
    this.replaceWith.on("blur", (_e, cx) => { this.typing = null; cx.notify(); });
    this.find = InputState.new({ placeholder: "Find in file" });
    this.find.on("submit", (_e, cx) => this.findNext(cx));
    this.find.on("focus", (_e, cx) => { this.typing = "find"; cx.notify(); });
    this.find.on("blur", (_e, cx) => { this.typing = null; cx.notify(); });
    this.replaceIn = InputState.new({ placeholder: "Replace with" });
    this.replaceIn.on("submit", (_e, cx) => this.replaceOne(cx));
    this.nameInput = InputState.new({ placeholder: "Name" });
    this.nameInput.on("submit", (_e, cx) => this.fileOp(this.nameAction, cx));
    for (const [state, name] of [[this.replaceIn, "replace-in"], [this.nameInput, "name"]]) {
      state.on("focus", (_e, cx) => { this.typing = name; cx.notify(); });
      state.on("blur", (_e, cx) => { this.typing = null; cx.notify(); });
    }
    this.openRequest = shared("my-files.open")?.n; // an old request from Changes stays done
    // No timer (each refresh starts PowerShell and git): the folder watch and Sync do it.
    this.refresh(cx);
    cx.spawn(async cx => { for (;;) { this.command(await nextCommand(), cx); cx.notify(); } });
  }

  // Commands from keys.json ("my-files.save") or `herdr-app do my-files.save`;
  // "name:value" passes a value (open:src/a.go:12, search:text, type:text).
  command(c, cx) {
    const i = c.indexOf(":"), name = i < 0 ? c : c.slice(0, i), arg = i < 0 ? "" : c.slice(i + 1);
    const run = {
      focus: () => this.handle.focus(),
      sync: () => this.refresh(cx),
      toggle: () => arg && this.toggle(arg, cx), // open or close a folder
      open: () => { const m = /^(.*?)(?::(\d+))?$/.exec(arg); this.open(m[1], m[2] ? { line: +m[2] } : null, cx); },
      close: () => this.close(),
      save: () => this.save(cx),
      type: () => this.code && !this.readonly && this.code.replace(arg),
      find: () => { this.find.set_value(arg); this.findNext(cx); },
      search: () => { this.search.set_value(arg); this.runSearch(cx); },
      "replace-all": () => { this.replaceWith.set_value(arg); if (this.results?.rows.length) this.replaceHits(this.results.rows, cx); },
      blame: () => this.file && this.showBlame(cx),
      history: () => this.file && this.showHistory(cx),
      send: () => (arg || this.file) && this.send(arg || this.file, cx),
      "replace-in-file": () => { const [q, to] = arg.split("|"); this.find.set_value(q); this.replaceIn.set_value(to ?? ""); this.replaceEvery(cx); },
      menu: () => this.openMenu(arg, cx),
      "new-file": () => this.nameThen("new-file", arg, cx),
      "new-folder": () => this.nameThen("new-folder", arg, cx),
      rename: () => this.nameThen("rename", arg, cx),
      delete: () => { this.menu && (this.menu.confirm = true); this.fileOp("delete", cx); },
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

  // Lists folders (with `deep`, their subfolders too) into this.entries; a listed folder that
  // is gone closes. Closed folders keep their entries, so opening one again shows at once.
  async loadFolders(paths, context, deep) {
    const lists = await directories(context.cwd, paths, context.on, deep);
    if (!this.current(context)) return;
    for (const [path, entries] of lists) {
      if (entries) { this.store(path, entries); continue; }
      if (!path) throw new Error("Cannot list this folder");
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) this.folders.delete(folder);
      this.entries.delete(path);
    }
  }

  store(path, entries) {
    const shown = (p) => !p || this.folders.has(p);
    const used = [...this.entries.entries()].filter(([p]) => p !== path && shown(p)).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (shown(path) && (entries.length > PER_FOLDER || used + entries.length > TOTAL)) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = locationKey();
    if (next !== this.context?.key) {
      if (this.dirty()) return; // keep unsaved edits: follow the chat once they're saved or dropped
      // Each workspace's last tree and marks show at once when it comes back; the refresh below updates them.
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file, entries: this.entries, marks: this.marks, isRepo: this.isRepo, top: this.context.top });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on, top: saved?.top }; this.root = cwd; this.on = on; this.entries = saved?.entries ?? new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = saved?.marks ?? {}; this.close(); this.watched = null; this.error = null; this.limited = false;
      this.loading = false; this.results = null; this.isRepo = saved?.isRepo ?? false; this.menu = null;
      if (saved?.file) this.open(saved.file, null, cx);
    }
    if (!cwd) return;
    if (this.loading) { this.again = true; return; } // a change mid-refresh: once more after it
    const context = this.context;
    this.loading = true; this.again = false;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        // The folders and git's marks load side by side; the repo's top is asked once per location.
        const marksOf = async () => {
          if (!context.top) { // not a repo yet is asked again: a `git init` may come later
            const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
            context.top = top?.code === 0 ? top.stdout.trim() : null;
          }
          if (!context.top) return null;
          const status = await exec("git", [...READ, "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          const marks = {};
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${context.top}/${entry.slice(3)}`.toLowerCase()] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
          return marks;
        };
        // An open folder that is gone (deleted, renamed) just closes; only the top one is an error.
        // The first listing of a folder also reads the top level's subfolders.
        const [, marks] = await Promise.all([this.loadFolders(["", ...this.folders], context, !this.entries.size), marksOf(), this.reloadOpen(context)]);
        if (!this.current(context)) return;
        this.isRepo = Boolean(context.top); this.marks = marks ?? {}; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally {
        if (this.context === context) { this.loading = false; if (this.again) this.refresh(cx); }
        cx.notify();
      }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) this.folders.delete(folder);
    } else {
      this.folders.add(path);
      // Shown at once when listed before; read again (with its subfolders) meanwhile.
      if (!this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolders([path], context, true); }
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

  // Files under the tree's folder are kept relative; Changes may send a repo file
  // outside it (the tree shows a subfolder of the repo), which stays absolute.
  full(path) { return /^([A-Za-z]:)?[\\/]/.test(path) ? path : `${this.root}/${path}`; }
  rel(path) {
    const root = this.root.replace(/\\/g, "/").replace(/\/$/, ""), p = path.replace(/\\/g, "/");
    return p.toLowerCase().startsWith(root.toLowerCase() + "/") ? p.slice(root.length + 1) : p;
  }

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
      } catch (e) { if (this.file === path && this.current(context)) this.fileError = `Cannot open this file: ${e}`; }
      finally { cx.notify(); }
    });
  }

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
  }

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
  }

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
  }

  // ctrl+h: Replace swaps the found text under the cursor and finds the next one;
  // All swaps every one in the file (the file then needs saving).
  replaceOne(cx) {
    const q = this.find.value(), r = this.code?.selected_range();
    if (!q || !r || this.readonly) return;
    if (this.code.value().slice(r.start, r.end).toLowerCase() === q.toLowerCase()) this.code.replace(this.replaceIn.value());
    this.findNext(cx);
  }

  replaceEvery(cx) {
    const q = this.find.value();
    if (!q || !this.code || this.readonly) return;
    const { text, n } = replaceAll(this.code.value(), q, this.replaceIn.value());
    if (n) this.code.set_value(text);
    this.wasDirty = this.dirty(); this.note = n ? `Replaced ${n} in this file: save to keep it` : `“${q}” not found`;
    cx.notify();
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

  // Replaces the search text (any case, as the search matched it) on the hit lines
  // only, file by file; a file changed since the search is skipped, not overwritten.
  replaceHits(hits, cx) {
    const q = this.results?.q, to = this.replaceWith.value();
    if (!q || this.replacing) return;
    const byFile = new Map();
    for (const h of hits) byFile.set(h.path, [...(byFile.get(h.path) ?? []), h.line]);
    this.replacing = true; this.note = null;
    cx.spawn(async (cx) => {
      let count = 0, files = 0;
      const skipped = [];
      try {
        for (const [path, lines] of byFile) {
          try {
            const full = this.full(path), text = await readTextFile(full);
            if (text === null) { skipped.push(`${path} (gone)`); continue; }
            // readTextFile stops at 1 MiB: never write back a file that may be cut short.
            if (text.length > MAX_EDIT) { skipped.push(`${path} (too big)`); continue; }
            const { text: next, n } = replaceOnLines(text, lines, q, to);
            if (!n) continue;
            await writeTextFile(full, next, text);
            count += n; files++;
          } catch (e) { skipped.push(`${path} (${e.message ?? e})`); }
        }
        this.note = `Replaced ${count} in ${files} file${files === 1 ? "" : "s"}${skipped.length ? ` · skipped ${skipped.join(", ")}` : ""}${this.results?.more ? " · only the first 500 matches: search again for more" : ""}`;
      } catch (e) { this.note = `Replace failed: ${e.message ?? e}`; }
      finally { this.replacing = false; this.runSearch(cx); this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

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

  // --- file actions (right-click a row, or + for the folder itself) -------------------

  // menu: { path, dir } of that row ("" = the tree's folder); confirm: Delete was clicked once.
  openMenu(path, cx) {
    const i = path.lastIndexOf("/"), entry = (this.entries.get(i < 0 ? "" : path.slice(0, i)) ?? []).find((e) => e.name === path.slice(i + 1));
    this.menu = this.menu?.path === path ? null : { path, dir: path === "" || Boolean(entry?.dir) };
    this.nameAction = null;
    cx.notify();
  }

  // New file / New folder / Rename ask for a name first (a command can pass it).
  nameThen(action, name, cx) {
    if (!this.menu) return;
    if (name) { this.nameInput.set_value(name); return this.fileOp(action, cx); }
    this.nameAction = action;
    this.nameInput.set_value(action === "rename" ? this.menu.path.split("/").pop() : "");
    this.nameInput.focus();
    cx.notify();
  }

  fileOp(action, cx) {
    const m = this.menu;
    if (!m || !action || (m.path === "" && (action === "rename" || action === "delete"))) return;
    if (this.on) { this.note = "File actions work on this computer only"; cx.notify(); return; }
    if (action === "delete" && !m.confirm) { m.confirm = true; cx.notify(); return; }
    const name = this.nameInput.value().trim();
    if (action !== "delete" && (!name || /[\\/]/.test(name) || name === "." || name === "..")) { this.note = "Type a name (without / or \\)"; cx.notify(); return; }
    const parentOf = (p) => p.replace(/\/?[^/]*$/, ""), join = (dir, n) => (dir ? `${dir}/${n}` : n);
    const where = action === "rename" || action === "delete" ? parentOf(m.path) : m.dir ? m.path : parentOf(m.path);
    const target = action === "delete" ? m.path : join(where, name);
    this.menu = null; this.nameAction = null;
    cx.spawn(async (cx) => {
      try {
        if (action === "new-file") await writeTextFile(this.full(target), "", null);
        else await this.shell(action, this.full(action === "new-folder" ? target : m.path), this.full(target));
        if (where) this.folders.add(where); // show where it went
        if (this.file && (action === "delete" || action === "rename") && (this.file === m.path || this.file.startsWith(m.path + "/"))) this.close();
        this.note = { "new-file": `Created ${target}`, "new-folder": `Created ${target}/`, rename: `Renamed to ${target}`, delete: `Deleted ${m.path}` }[action];
        this.refresh(cx);
        if (action === "new-file") this.open(target, null, cx);
      } catch (e) { this.note = `Not done: ${e.message ?? e}`; }
      cx.notify();
    });
    cx.notify();
  }

  // mkdir, move (never over an existing file) and delete: PowerShell on Windows, else sh.
  async shell(action, a, b) {
    const q = (s) => "'" + s.replace(/['‘’‚‛]/g, "$&$&") + "'";
    const [ps, sh] = {
      "new-folder": ["New-Item -ItemType Directory -Path $a | Out-Null", 'mkdir -- "$1"'],
      rename: ["Move-Item -LiteralPath $a -Destination $b", '[ -e "$2" ] && { echo "$2 already exists" >&2; exit 1; }; mv -- "$1" "$2"'],
      delete: ["Remove-Item -LiteralPath $a -Recurse -Force", 'rm -rf -- "$1"'],
    }[action];
    const r = window()?.platform === "windows"
      ? await exec("powershell", ["-NoProfile", "-Command", `& { param($a, $b) $ErrorActionPreference = 'Stop'; ${ps} } ${q(a)} ${q(b)}`])
      : await exec("sh", ["-c", sh, "files", a, b]);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split(/\r?\n/)[0] || `${action} failed`);
  }

  menuRow(depth, t) {
    const m = this.menu, isRoot = m.path === "";
    return h_flex().id("file-menu").flex_none().pl(8 + depth * 16).pr(8).py(4).gap(4).items_center().flex_wrap().rounded(6).bg(t.raised)
      .children(this.nameAction ? [
        this.input("file-name", this.nameInput, this.typing === "name", t),
        button("file-name-ok", { "new-file": "Create file", "new-folder": "Create folder", rename: "Rename" }[this.nameAction], t, (_e, cx) => this.fileOp(this.nameAction, cx), { primary: true }),
        button("file-name-cancel", "Cancel", t, (_e, cx) => { this.nameAction = null; cx.notify(); }),
      ] : [
        ...(isRoot ? [] : [button("file-send", "@ chat", t, (_e, cx) => { this.menu = null; this.send(m.path, cx); })]),
        button("file-new", "New file", t, (_e, cx) => this.nameThen("new-file", "", cx)),
        button("file-new-dir", "New folder", t, (_e, cx) => this.nameThen("new-folder", "", cx)),
        ...(isRoot ? [] : [
          button("file-rename", "Rename", t, (_e, cx) => this.nameThen("rename", "", cx)),
          button("file-delete", m.confirm ? "Delete? click again" : "Delete", t, (_e, cx) => this.fileOp("delete", cx), { danger: true }),
        ]),
      ]);
  }

  // --- keys ----------------------------------------------------------------------

  key(e, cx) {
    const k = e.key, ctrl = e.modifiers.control || e.modifiers.platform;
    if (ctrl && k === "s") { this.save(cx); cx.stop_propagation(); return; }
    if (ctrl && k === "f" && this.code) { this.find.focus(); cx.stop_propagation(); return; }
    if (ctrl && k === "h" && this.code && !this.readonly) { this.showReplace = true; this.replaceIn.focus(); cx.stop_propagation(); cx.notify(); return; }
    if (k === "escape") {
      cx.stop_propagation();
      if (this.typing) { this.typing = null; this.handle.focus(); }
      else if (this.menu) { this.menu = null; this.nameAction = null; }
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
        .on_click((_e, cx) => { if (entry.dir) this.toggle(path, cx); else this.open(path, null, cx); })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.openMenu(path, cx); })
        .child(entry.dir ? svg(`mods/files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/files/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark))));
      if (this.menu?.path === path) out.push(this.menuRow(depth, t));
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
    // Changes asked to open a file (its Open button, a double-click there).
    const asked = shared("my-files.open");
    if (asked?.n && asked.n !== this.openRequest && this.root) {
      this.openRequest = asked.n;
      if (this.dirty()) this.note = "Save or close the open file first";
      else this.open(this.rel(asked.path), null, cx);
    }
    const t = theme(), file = this.file, dirty = this.dirty();
    const header = h_flex().h(42).flex_none().px(12).gap(6).items_center().border_b(1).border_color(t.border)
      .when(Boolean(file), el => el.child(button("files-back", "←", t, (_e, cx) => {
        if (this.mode !== "edit") { this.mode = "edit"; cx.notify(); return; }
        if (dirty && !this.confirmClose) { this.confirmClose = true; cx.notify(); return; }
        this.close(); cx.notify();
      })))
      .child(div().font_semibold().child("Files"))
      .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(dirty ? t.blocked : t.dim)
        .child(file ? `${file}${dirty ? " ●" : ""}` : this.root?.split(/[\\/]/).pop() ?? ""))
      .when(!file && Boolean(this.root), el => el.child(button("files-sync", "Sync", t, (_e, cx) => this.refresh(cx), { enabled: !this.loading }))
        .child(button("files-new", "+", t, (_e, cx) => this.openMenu("", cx), { active: this.menu?.path === "" })));
    // Buttons wrap and the find box gets a row of its own, so a narrow panel still fits.
    const fileBar = file && v_flex().flex_none().px(10).py(6).gap(6).when(!this.showReplace, el => el.border_b(1).border_color(t.border))
      .child(h_flex().gap(6).items_center().flex_wrap()
        .when(this.isRepo, el => el.child(button("files-blame", "Blame", t, (_e, cx) => this.showBlame(cx), { active: this.mode === "blame" }))
          .child(button("files-history", "History", t, (_e, cx) => this.showHistory(cx), { active: this.mode === "history" || this.mode === "commit" })))
        .child(button("files-send", "@ chat", t, (_e, cx) => this.send(file, cx)))
        .when(!this.readonly && Boolean(this.code), el => el.child(button("files-replace-toggle", "Replace", t, (_e, cx) => { this.showReplace = !this.showReplace; cx.notify(); }, { active: this.showReplace }))
          .child(button("files-save", "Save", t, (_e, cx) => this.save(cx), { primary: true, enabled: dirty }))))
      .child(h_flex().child(this.input("files-find", this.find, this.typing === "find", t)));
    const replaceInBar = file && this.showReplace && !this.readonly && Boolean(this.code) && h_flex().flex_none().px(10).pb(6).gap(6).items_center().border_b(1).border_color(t.border)
      .child(this.input("files-replace-in", this.replaceIn, this.typing === "replace-in", t))
      .child(button("files-replace-one", "Next", t, (_e, cx) => this.replaceOne(cx)))
      .child(button("files-replace-every", "All", t, (_e, cx) => this.replaceEvery(cx)))
      .child(button("files-replace-close", "×", t, (_e, cx) => { this.showReplace = false; cx.notify(); }));
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
        .on_click((_e, cx) => this.open(r.path, { line: r.line, word: this.results.q }, cx))
        .child(h_flex().gap(6).items_center().child(div().flex_1().min_w(0).text_size(11).text_color(t.muted).truncate().child(`${r.path}:${r.line}`))
          .child(button(`hit-replace-${i}`, "Replace", t, (_e, cx) => this.replaceHits([r], cx), { enabled: !this.replacing })))
        .child(div().text_size(12).truncate().font_family(settings().font_family ?? "JetBrains Mono").child(r.text))));
    const replaceBar = this.results && !this.results.loading && this.results.rows.length > 0 && h_flex().flex_none().px(10).pb(6).gap(6).items_center().border_b(1).border_color(t.border)
      .child(this.input("files-replace", this.replaceWith, this.typing === "replace", t))
      .child(button("files-replace-all", this.replacing ? "Replacing…" : `Replace all (${new Set(this.results.rows.map((r) => r.path)).size} files)`, t,
        (_e, cx) => this.replaceHits(this.results.rows, cx), { primary: true, enabled: !this.replacing }));
    const tree = v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6)
      .when(this.menu?.path === "", el => el.child(this.menuRow(0, t))).children(this.treeRows("", 0, [], t))
      .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
      .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")));
    return v_flex().id("my-files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .child(header)
      .when(!file, el => el.child(h_flex().flex_none().px(10).py(6).when(!replaceBar, e => e.border_b(1).border_color(t.border)).child(this.input("files-search", this.search, this.typing === "search", t))))
      .when(!file && Boolean(replaceBar), el => el.child(replaceBar))
      .when(Boolean(fileBar), el => el.child(fileBar))
      .when(Boolean(replaceInBar), el => el.child(replaceInBar))
      .when(Boolean(confirm), el => el.child(confirm))
      .when(Boolean(this.note), el => el.child(div().px(12).py(4).text_size(11).text_color(/^(Saved|Replaced|Created|Renamed|Deleted)/.test(this.note) ? t.ansi2 : this.note.endsWith("…") ? t.dim : t.ansi1).child(this.note)))
      .child(file ? this.fileBody(t) : results || tree)
      .child(div().flex_none().px(12).py(4).border_t(1).border_color(t.border).text_size(11).text_color(t.dim).truncate()
        .child(file ? "ctrl+s save · ctrl+f find · ctrl+h replace · esc chat" : "click: open · right-click: @chat, new, rename, delete · drag: path to a terminal · / search"));
  }
}
