// Changes: git status of the focused pane's repo, Fork style. Stage files or single
// hunks, discard, commit; branches, merge, fetch/pull/push, stash; the history graph.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar } from "gpui-base";
import { exec, readTextFile, writeTextFile, watchFolder, theme, settings, appHome, nextCommand } from "herdr";
import { location, locationKey, git, READ, sendToChat, focusChat, diffRows, diffRow, button, untab } from "./common.js";

const MAX_FILES = 1000, MAX_LINES = 3000, NET = 120000;
const CONFLICTS = "Conflicts: fix each U file (Ours / Theirs, or edit it and Mark resolved), then Commit. Abort merge undoes it.";

// The file header and hunk n of a one-file diff, byte for byte (CRLF kept); "" if none.
export function oneHunk(diff, n) {
  let head = "", hunk = "", i = -1;
  for (const l of diff.split(/(?<=\n)/)) {
    if (l.startsWith("@@")) i++;
    if (i < 0) head += l; else if (i === n) hunk += l;
  }
  return hunk ? head + hunk : "";
}

// git log --graph lines → rows; the graph is redrawn with box lines.
const GRAPH = { "*": "●", "|": "│", "/": "╱", "\\": "╲", "_": "─" };
function parseLog(out) {
  return out.split("\n").filter(Boolean).map((l) => {
    const [graph, hash, refs, subject, author, when] = l.split("\x01");
    return { graph: graph.replace(/[*|/\\_]/g, (c) => GRAPH[c]), hash, refs: refs?.trim(), subject, author, when };
  });
}

export default class Changes extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.files = []; this.rows = []; this.raw = ""; this.view = "changes";
    this.message = InputState.new({ placeholder: "Commit message" });
    this.message.on("submit", (_e, cx) => this.commit(cx));
    this.message.on("change", (_e, cx) => { const has = Boolean(this.message.value().trim()); if (has !== this.hasMessage) { this.hasMessage = has; cx.notify(); } });
    this.branchName = InputState.new({ placeholder: "New branch name" });
    this.branchName.on("submit", (_e, cx) => this.newBranch(cx));
    for (const [state, name] of [[this.message, "message"], [this.branchName, "branch"]]) {
      state.on("focus", (_e, cx) => { this.typing = name; cx.notify(); });
      state.on("blur", (_e, cx) => { this.typing = null; cx.notify(); });
    }
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
    cx.spawn(async (cx) => { for (;;) { this.command(await nextCommand(), cx); cx.notify(); } });
  }

  // Commands from keys.json ("my-changes.pull") or `herdr-app do my-changes.pull`;
  // "name:value" passes a value (a path, a branch, a commit message).
  command(c, cx) {
    const i = c.indexOf(":"), name = i < 0 ? c : c.slice(0, i), arg = i < 0 ? "" : c.slice(i + 1);
    const f = this.files.find((x) => x.path === this.sel);
    const run = {
      focus: () => this.handle.focus(),
      select: () => this.pick(arg, cx),
      stage: () => this.toggleFile(f, cx),
      "stage-all": () => this.stageAll(cx), "unstage-all": () => this.unstageAll(cx),
      hunk: () => this.toggleHunk(Number(arg) || 0, cx),
      discard: () => f && this.discard(f, cx),
      ours: () => f && this.resolve(f, "ours", cx), theirs: () => f && this.resolve(f, "theirs", cx),
      commit: () => { if (arg) this.message.set_value(arg); this.hasMessage = Boolean(this.message.value().trim()); this.commit(cx); },
      fetch: () => this.fetch(cx), pull: () => this.pull(cx), push: () => this.push(cx),
      stash: () => this.stash(cx), pop: () => this.pop(cx), abort: () => this.abortMerge(cx),
      branches: () => this.openBranches(cx),
      checkout: () => this.checkout(arg, arg.includes("/") && !this.menu?.local.includes(arg), cx),
      merge: () => this.merge(arg, cx),
      "new-branch": () => { this.branchName.set_value(arg); this.newBranch(cx); },
      history: () => this.openLog(cx),
      show: () => this.showCommit(arg, cx),
    }[name];
    run?.();
  }

  git(args, timeout) { return git(this.root, this.on, args, timeout); }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try { while (this.watched === root) { await watchFolder(root); if (this.watched === root) this.refresh(cx); } }
      catch { this.watched = null; }
    });
  }

  // --- status ------------------------------------------------------------------

  refresh(cx) {
    if (this.loading || this.busy) { this.again = true; return; }
    const { cwd, on } = location(), context = locationKey();
    if (context !== this.context) {
      this.context = context; this.root = null; this.files = []; this.sel = null; this.setLines([], "");
      this.error = null; this.note = null; this.watched = null; this.view = "changes"; this.menu = null; this.confirm = null;
    }
    if (!cwd) return;
    this.loading = true; this.again = false;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (locationKey() !== context) return;
        if (top.code !== 0) { this.root = null; this.files = []; this.setLines([], ""); this.error = "Not a git repository"; return; }
        const root = top.stdout.trim(), g = (args) => git(root, on, [...READ, ...args]);
        const status = await g(["status", "--porcelain=v1", "-b", "-z", "--no-renames", "--untracked-files=all"]);
        const head = await exec("git", ["rev-parse", "--verify", "-q", "HEAD"], { cwd: root, on });
        const merging = (await exec("git", ["rev-parse", "--verify", "-q", "MERGE_HEAD"], { cwd: root, on })).code === 0;
        const stats = {};
        for (const out of head.code === 0 ? [await g(["diff", "HEAD", "--numstat", "-z", "--no-renames"])] : [await g(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await g(["diff", "--numstat", "-z", "--no-renames"])]) {
          for (const entry of out.split("\0")) {
            const [a, d, ...parts] = entry.split("\t");
            if (!parts.length) continue;
            const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
            stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
          }
        }
        const entries = status.split("\0").filter(Boolean);
        const branchLine = entries[0]?.startsWith("## ") ? entries.shift().slice(3) : "";
        const files = entries.slice(0, MAX_FILES).map((entry) => {
          const x = entry[0], y = entry[1], path = entry.slice(3), fresh = x === "?";
          const conflict = x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D");
          const status = conflict ? "U" : x === "D" || y === "D" ? "D" : fresh || x === "A" ? "A" : "M";
          const staged = fresh || conflict || x === " " ? "none" : y === " " ? "all" : "some";
          return { path, x, y, fresh, status, staged, ...(stats[path] ?? { add: 0, del: 0 }) };
        });
        if (locationKey() !== context) return;
        this.root = root; this.on = on; this.hasHead = head.code === 0; this.merging = merging; this.files = files;
        this.limited = entries.length > MAX_FILES; this.error = null;
        // "main...origin/main [ahead 1, behind 2]" or "No commits yet on main"
        const b = /^(?:No commits yet on |Initial commit on )?(.+?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/.exec(branchLine) ?? [];
        this.branch = b[1] === "HEAD (no branch)" ? "detached HEAD" : b[1]; this.upstream = b[2]; this.track = b[3];
        this.watch(root, cx);
        if (this.sel && !files.some((f) => f.path === this.sel)) this.sel = null;
        if (!this.sel && files.length) this.sel = files[0].path;
        if (this.sel) await this.load(this.sel, context).catch((e) => { if (locationKey() === context) this.setLines([`Cannot show this diff: ${e.message ?? e}`], ""); });
        else this.setLines([], "");
      } catch (e) { if (locationKey() === context) this.error = String(e.message ?? e); }
      finally { this.loading = false; cx.notify(); if (this.again) this.refresh(cx); }
    });
  }

  // The selected file's change: HEAD → working tree (what the hunk buttons stage).
  async load(path, context) {
    const file = this.files.find((f) => f.path === path), root = this.root, on = this.on;
    if (!file) return;
    let lines, raw = "";
    if (file.status === "U" || file.fresh || !this.hasHead) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
      if (text === null) lines = [file.status === "D" ? "Deleted" : "Cannot show this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file"];
      else if (file.status === "U") return this.setConflict(text.replace(/\r\n/g, "\n").split("\n"), context, path);
      else lines = [`@@ -0,0 +1 @@ new file`, ...text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").map((l) => `+${l}`)];
    } else {
      raw = await git(root, on, [...READ, "diff", "HEAD", "--no-ext-diff", "--no-textconv", "--no-color", "--", path]);
      const all = raw.replace(/\r/g, "").replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text change (mode or line endings only)"] : all.slice(first);
    }
    if (locationKey() === context && this.sel === path) this.setLines(lines, raw);
  }

  setConflict(lines, context, path) {
    if (locationKey() !== context || this.sel !== path) return;
    this.raw = "";
    this.rows = lines.slice(0, MAX_LINES).map((text, i) => /^(<<<<<<<|=======|>>>>>>>)/.test(text) ? { kind: "@", text } : { kind: " ", number: i + 1, text: untab(text) || " " });
  }

  setLines(lines, raw) {
    this.raw = raw;
    this.rows = diffRows(lines.slice(0, MAX_LINES).map((l) => l.length > 4000 ? l.slice(0, 4000) + "… (line truncated)" : l));
  }

  pick(path, cx) {
    this.sel = path; this.confirm = null; this.setLines([], "");
    const context = this.context;
    cx.spawn(async (cx) => {
      try { await this.load(path, context); }
      catch (e) { if (this.sel === path) this.setLines([`Cannot show this diff: ${e.message ?? e}`], ""); }
      cx.notify();
    });
    cx.notify();
  }

  // --- actions -----------------------------------------------------------------

  // Runs one git job at a time, shows its result, then refreshes.
  act(label, job, cx, done) {
    if (this.busy || !this.root) return;
    this.busy = label; this.note = null; this.confirm = null;
    cx.spawn(async (cx) => {
      try { this.note = { text: (await job()) ?? null }; }
      catch (e) {
        let text = String(e.message ?? e);
        if (/merge|pull|stash pop/i.test(label)) {
          const unmerged = await this.git([...READ, "diff", "--name-only", "--diff-filter=U"]).catch(() => "");
          if (unmerged.trim()) text = CONFLICTS;
        }
        this.note = { text, error: true };
      }
      finally { this.busy = null; done?.(); this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  toggleFile(f, cx) {
    if (!f) return;
    if (f.status === "U") return this.act("Resolve", async () => { await this.git(["add", "--", f.path]); return `${f.path} marked resolved`; }, cx);
    this.act("Stage", async () => {
      if (f.staged === "all") await this.git(this.hasHead ? ["restore", "--staged", "--", f.path] : ["rm", "--cached", "-q", "--", f.path]);
      else await this.git(["add", "-A", "--", f.path]);
    }, cx);
  }

  stageAll(cx) { this.act("Stage all", () => this.git(["add", "-A"]), cx); }
  unstageAll(cx) { this.act("Unstage all", () => this.git(this.hasHead ? ["reset", "-q"] : ["rm", "-r", "--cached", "-q", "."]), cx); }

  // Stages hunk n of the selected file, or unstages it when the index already has it.
  // shortcut: a hunk that is only partly staged can't be toggled; stage or unstage the whole file instead.
  toggleHunk(n, cx) {
    const path = this.sel;
    this.act("Hunk", async () => {
      const raw = await this.git([...READ, "diff", "HEAD", "--no-ext-diff", "--no-textconv", "--no-color", "--", path]);
      const patch = oneHunk(raw, n);
      if (!patch) throw new Error("The file changed: wait for the refresh and try again");
      const file = `${appHome()}/data/my-changes.patch`;
      await writeTextFile(file, patch, await readTextFile(file));
      if ((await exec("git", ["apply", "--cached", "--check", "-R", file], { cwd: this.root })).code === 0) {
        await this.git(["apply", "--cached", "-R", file]);
        return "Hunk unstaged";
      }
      await this.git(["apply", "--cached", file]);
      return "Hunk staged";
    }, cx);
  }

  discard(f, cx) {
    if (this.confirm?.path !== f.path) { this.confirm = { path: f.path }; cx.notify(); return; }
    this.act("Discard", async () => {
      if (f.status === "U") throw new Error("Conflicted file: use Ours / Theirs, or edit it");
      if (f.fresh) await this.git(["clean", "-f", "-q", "--", f.path]);
      else if (f.x === "A") { await this.git(["rm", "-q", "--cached", "--", f.path]); await this.git(["clean", "-f", "-q", "--", f.path]); }
      else await this.git(["restore", "--source=HEAD", "--staged", "--worktree", "--", f.path]);
      return `Discarded ${f.path}`;
    }, cx);
  }

  resolve(f, side, cx) {
    this.act("Resolve", async () => {
      await this.git(["checkout", `--${side}`, "--", f.path]);
      await this.git(["add", "--", f.path]);
      return `${f.path}: took ${side}`;
    }, cx);
  }

  commit(cx) {
    const message = this.message.value().trim();
    if (!this.files.some((f) => f.staged !== "none") && !this.merging) { this.note = { text: "Nothing staged: tick files (or Stage all) first", error: true }; cx.notify(); return; }
    if (!message && !this.merging) { this.message.focus(); return; }
    this.act("Commit", async () => {
      await this.git(message ? ["commit", "-q", "-m", message] : ["commit", "-q", "--no-edit"]);
      return "Committed";
    }, cx, () => { this.message.set_value(""); this.hasMessage = false; });
  }

  pull(cx) { this.act("Pull", async () => { await this.git(["pull", "--no-edit"], NET); return "Pulled"; }, cx); }
  fetch(cx) { this.act("Fetch", async () => { await this.git(["fetch", "--all", "--prune"], NET); return "Fetched"; }, cx); }
  push(cx) {
    this.act("Push", async () => {
      const upstream = await exec("git", ["rev-parse", "--abbrev-ref", "@{upstream}"], { cwd: this.root, on: this.on });
      await this.git(upstream.code === 0 ? ["push"] : ["push", "-u", "origin", "HEAD"], NET);
      return "Pushed";
    }, cx);
  }
  stash(cx) { this.act("Stash", async () => { await this.git(["stash", "push", "-u"]); return "Stashed"; }, cx); }
  pop(cx) { this.act("Stash pop", async () => { await this.git(["stash", "pop"]); return "Stash applied"; }, cx); }
  abortMerge(cx) { this.act("Abort merge", async () => { await this.git(["merge", "--abort"]); return "Merge aborted"; }, cx); }

  // --- branches ------------------------------------------------------------------

  openBranches(cx) {
    if (this.menu) { this.menu = null; cx.notify(); return; }
    this.menu = { local: [], remote: [] };
    cx.spawn(async (cx) => {
      const refs = async (where) => (await this.git([...READ, "for-each-ref", "--format=%(refname:short)", where]).catch(() => "")).split("\n").filter(Boolean);
      const local = await refs("refs/heads"), remote = (await refs("refs/remotes")).filter((r) => r.includes("/") && !r.endsWith("/HEAD"));
      if (this.menu) this.menu = { local, remote };
      cx.notify();
    });
    cx.notify();
  }

  checkout(branch, isRemote, cx) {
    this.menu = null;
    this.act("Checkout", async () => { await this.git(isRemote ? ["switch", "--track", branch] : ["switch", branch]); return `On ${branch}`; }, cx);
  }

  merge(branch, cx) {
    this.menu = null;
    this.act("Merge", async () => { await this.git(["merge", "--no-edit", branch], NET); return `Merged ${branch}`; }, cx);
  }

  newBranch(cx) {
    const name = this.branchName.value().trim();
    if (!name) return;
    this.menu = null;
    this.act("New branch", async () => { await this.git(["switch", "-c", name]); return `Created ${name}`; }, cx, () => this.branchName.set_value(""));
  }

  // --- history -------------------------------------------------------------------

  openLog(cx) {
    if (this.view !== "changes") { this.view = "changes"; cx.notify(); return; }
    this.view = "log"; this.log = null;
    cx.spawn(async (cx) => {
      try { this.log = parseLog(await this.git([...READ, "log", "--graph", "--all", "--date-order", "-n", "500", "--format=%x01%h%x01%d%x01%s%x01%an%x01%ar"])); }
      catch (e) { this.log = []; this.note = { text: String(e.message ?? e), error: true }; }
      cx.notify();
    });
    cx.notify();
  }

  showCommit(hash, cx) {
    this.view = "commit"; this.shown = hash; this.commitRows = null;
    cx.spawn(async (cx) => {
      try {
        const out = await this.git([...READ, "show", "--format=%h  %an, %ar%n%n%B", "--no-color", "--no-ext-diff", "-M", "-m", "--first-parent", hash]);
        if (this.shown === hash) this.commitRows = diffRows(out.replace(/\r/g, "").replace(/\n$/, "").split("\n").slice(0, MAX_LINES * 3));
      } catch (e) { this.commitRows = diffRows([String(e.message ?? e)]); }
      cx.notify();
    });
    cx.notify();
  }

  // --- keys ----------------------------------------------------------------------

  key(e, cx) {
    const k = e.key;
    if (k === "escape") {
      cx.stop_propagation();
      if (this.typing) { this.typing = null; this.handle.focus(); }
      else if (this.menu || this.confirm) { this.menu = null; this.confirm = null; }
      else if (this.view === "commit") this.view = "log";
      else if (this.view === "log") this.view = "changes";
      else focusChat();
      cx.notify();
      return;
    }
    if (this.typing || e.modifiers.control || e.modifiers.alt || e.modifiers.platform) return;
    const i = this.files.findIndex((f) => f.path === this.sel), f = this.files[i];
    const act = {
      up: () => i > 0 && this.pick(this.files[i - 1].path, cx),
      down: () => i < this.files.length - 1 && this.pick(this.files[i + 1].path, cx),
      space: () => this.toggleFile(f, cx),
      c: () => this.message.focus(),
      l: () => this.openLog(cx),
      s: () => f && this.send(f.path, cx),
    }[k];
    if (act && this.view === "changes") { cx.stop_propagation(); act(); cx.notify(); }
  }

  send(path, cx) {
    const rel = this.relative(path);
    cx.spawn(async (cx) => {
      try { await sendToChat(`@${rel} `, cx); }
      catch (e) { this.note = { text: `Not sent: ${e.message ?? e}`, error: true }; }
      cx.notify();
    });
  }

  // A repo path as the chat sees it (relative to the chat's folder when inside it).
  relative(path) {
    const cwd = (location().cwd ?? "").replace(/\\/g, "/").replace(/\/$/, ""), full = `${this.root}/${path}`;
    return cwd && full.toLowerCase().startsWith(cwd.toLowerCase() + "/") ? full.slice(cwd.length + 1) : full;
  }

  // --- drawing -------------------------------------------------------------------

  fileRow(f, t) {
    const parts = f.path.split("/"), name = parts.pop(), sel = this.sel === f.path;
    const box = f.status === "U" ? "!" : f.staged === "all" ? "✓" : f.staged === "some" ? "~" : "";
    return h_flex().id(`change-${f.path}`).h(26).flex_none().px(6).gap(7).items_center().rounded(6).cursor_pointer()
      .when(sel, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.pick(f.path, cx))
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.send(f.path, cx); })
      .child(div().id(`stage-${f.path}`).w(16).h(16).flex_none().flex().items_center().justify_center().rounded(4).border_1()
        .border_color(box && box !== "!" ? t.accent : t.input).bg(box === "✓" ? t.accent : t.background)
        .text_size(11).text_color(box === "✓" ? t.accent_foreground : box === "!" ? t.ansi1 : t.accent)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); this.toggleFile(f, cx); }).child(box))
      .child(div().w(12).flex_none().text_size(11).text_color(f.status === "A" ? t.ansi2 : f.status === "D" || f.status === "U" ? t.ansi1 : t.blocked).child(f.status))
      .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().flex_none().max_w(260).truncate().child(name)))
      .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`)))
      .when(f.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
  }

  hunkButton(row, t) {
    const f = this.files.find((x) => x.path === this.sel);
    if (!f || !this.raw || row.hunk === undefined) return null;
    const label = f.staged === "all" ? "Unstage hunk" : f.staged === "none" ? "Stage hunk" : "Stage / unstage hunk";
    return div().id(`hunk-${row.hunk}`).flex_none().px(6).rounded(4).bg(t.background).text_color(t.accent).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.toggleHunk(row.hunk, cx)).child(label);
  }

  diffView(id, rows, t, withHunks) {
    return v_flex().id(id).flex_1().min_h(0).overflow_y_scrollbar().py(2).font_family(settings().font_family ?? "JetBrains Mono").text_size(12)
      .children(rows.map((row) => diffRow(row, t, withHunks ? (r) => this.hunkButton(r, t) ?? div() : null)));
  }

  toolbar(t) {
    const busy = Boolean(this.busy), track = this.track ? ` ${this.track.replace(/ahead /, "↑").replace(/behind /, "↓").replace(", ", " ")}` : "";
    return h_flex().flex_none().px(10).py(6).gap(5).items_center().border_b(1).border_color(t.border).flex_wrap()
      .child(button("branch", `⎇ ${this.branch ?? "…"}${track} ▾`, t, (_e, cx) => this.openBranches(cx), { active: Boolean(this.menu) }))
      .child(div().flex_1())
      .child(button("fetch", "Fetch", t, (_e, cx) => this.fetch(cx), { enabled: !busy }))
      .child(button("pull", "Pull", t, (_e, cx) => this.pull(cx), { enabled: !busy }))
      .child(button("push", "Push", t, (_e, cx) => this.push(cx), { enabled: !busy }))
      .child(button("stash", "Stash", t, (_e, cx) => this.stash(cx), { enabled: !busy && this.files.length > 0 }))
      .child(button("pop", "Pop", t, (_e, cx) => this.pop(cx), { enabled: !busy }))
      .child(button("log", "History", t, (_e, cx) => this.openLog(cx), { active: this.view !== "changes" }));
  }

  branchMenu(t) {
    const m = this.menu, row = (name, isRemote) => h_flex().id(`br-${isRemote ? "r" : "l"}-${name}`).h(26).flex_none().px(8).gap(6).items_center().rounded(6)
      .hover((s) => s.bg(t.hover)).cursor_pointer().on_click((_e, cx) => name !== this.branch && this.checkout(name, isRemote, cx))
      .child(div().flex_1().min_w(0).truncate().text_color(name === this.branch ? t.accent : t.foreground).child(`${name === this.branch ? "● " : ""}${name}`))
      .when(name !== this.branch, (e) => e.child(button(`merge-${name}`, "Merge into current", t, (_e, cx) => this.merge(name, cx))));
    return v_flex().id("branch-menu").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(2)
      .child(h_flex().gap(6).pb(4).child(div().id("branch-input").flex_1().h(28).px(8).flex().items_center().rounded(7).border_1()
        .border_color(this.typing === "branch" ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Input.new(this.branchName).h_full().text_size(12)))
        .child(button("branch-create", "Create", t, (_e, cx) => this.newBranch(cx), { primary: true })))
      .child(div().px(8).pt(4).text_size(11).text_color(t.dim).child("Local — click to check out"))
      .children(m.local.map((b) => row(b, false)))
      .when(m.remote.length > 0, (e) => e.child(div().px(8).pt(8).text_size(11).text_color(t.dim).child("Remote")).children(m.remote.map((b) => row(b, true))));
  }

  logView(t) {
    if (!this.log) return div().p(12).text_color(t.dim).child("Loading history…");
    return v_flex().id("log").flex_1().min_h(0).overflow_y_scrollbar().text_size(12).children(this.log.map((r, j) =>
        h_flex().id(`log-${j}`).w_full().h(22).flex_none().px(8).gap(6).items_center()
          .when(Boolean(r.hash), (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.showCommit(r.hash, cx)))
          .child(div().flex_none().font_family(settings().font_family ?? "JetBrains Mono").text_color(t.accent).child(r.graph))
          .when(Boolean(r.hash), (e) => e.child(div().flex_none().text_color(t.dim).font_family(settings().font_family ?? "JetBrains Mono").child(r.hash))
            .when(Boolean(r.refs), (e) => e.child(div().flex_none().px(4).rounded(4).bg(t.selected).text_size(11).text_color(t.ansi3).child(r.refs.replace(/^\(|\)$/g, ""))))
            .child(div().flex_1().min_w(0).truncate().child(r.subject))
            .child(div().flex_none().text_size(11).text_color(t.dim).child(`${r.author}, ${r.when}`)))));
  }

  render(cx) {
    if (locationKey() !== this.context) this.refresh(cx);
    const t = theme(), f = this.files.find((x) => x.path === this.sel), staged = this.files.filter((x) => x.staged !== "none").length;
    const canCommit = !this.busy && (this.merging || (staged > 0 && this.hasMessage));
    const body = this.menu ? this.branchMenu(t)
      : this.view === "log" ? this.logView(t)
      // Lists that fill the panel stay direct children of the root: one more flex level
      // and the virtual list lays out at zero height.
      : this.view === "commit" ? [
        h_flex().flex_none().px(10).py(4).gap(6).items_center().child(button("commit-back", "← History", t, (_e, cx) => { this.view = "log"; cx.notify(); })),
        this.commitRows ? this.diffView("commit-diff", this.commitRows, t, false) : div().p(12).text_color(t.dim).child("Loading commit…")]
      : !this.root ? div().p(12).text_color(t.dim).child(this.error ?? (this.loading ? "Loading…" : "No folder"))
      : [
        h_flex().flex_none().px(10).py(4).gap(6).items_center().text_size(11).text_color(t.dim)
          .child(div().flex_1().child(`${this.files.length} changed · ${staged} staged`))
          .child(button("stage-all", "Stage all", t, (_e, cx) => this.stageAll(cx), { enabled: !this.busy && this.files.length > 0 }))
          .child(button("unstage-all", "Unstage all", t, (_e, cx) => this.unstageAll(cx), { enabled: !this.busy && staged > 0 })),
        div().flex_none().h(Math.min(Math.max(this.files.length, 1) * 26 + 10, 240)).relative().border_b(1).border_color(t.border)
          .child(v_flex().id("changes-list").absolute().inset_0().overflow_y_scroll().px(6).pb(4).children(this.files.map((x) => this.fileRow(x, t)))
            .when(!this.files.length, (e) => e.child(div().p(6).text_color(t.dim).child("No uncommitted changes"))))
          .child(Scrollbar.vertical("changes-list").absolute().inset_0()),
        f ? h_flex().flex_none().px(10).py(4).gap(6).items_center().border_b(1).border_color(t.border)
          .child(div().flex_1().min_w(0).truncate().text_size(12).font_semibold().child(f.path))
          .when(f.status === "U", (e) => e.child(button("ours", "Ours", t, (_e, cx) => this.resolve(f, "ours", cx)))
            .child(button("theirs", "Theirs", t, (_e, cx) => this.resolve(f, "theirs", cx)))
            .child(button("resolved", "Mark resolved", t, (_e, cx) => this.toggleFile(f, cx))))
          .when(f.status !== "U", (e) => e.child(button("discard", this.confirm?.path === f.path ? "Discard? click again" : "Discard", t, (_e, cx) => this.discard(f, cx), { danger: true })))
          : div().flex_1(),
        this.diffView("changes-diff", this.rows, t, true)];
    return v_flex().id("my-changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .child(h_flex().h(42).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Changes"))
        .when(this.merging, (e) => e.child(div().px(6).rounded(4).bg(t.blocked).text_color(t.background).text_size(11).child("MERGING")))
        .child(div().flex_1())
        .when(Boolean(this.busy), (e) => e.child(div().text_size(11).text_color(t.dim).child(`${this.busy}…`)))
        .when(this.merging, (e) => e.child(button("abort", "Abort merge", t, (_e, cx) => this.abortMerge(cx), { danger: true }))))
      .when(Boolean(this.root), (e) => e.child(this.toolbar(t)))
      .when(Boolean(this.note?.text), (e) => e.child(h_flex().flex_none().px(12).py(4).gap(6).text_size(11).text_color(this.note.error ? t.ansi1 : t.ansi2)
        .child(div().flex_1().child(this.note.text)).child(button("note-close", "×", t, (_e, cx) => { this.note = null; cx.notify(); }))))
      .children([body].flat())
      .when(this.view === "changes" && !this.menu && Boolean(this.root),(e) => e.child(h_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
        .child(div().id("commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1()
          .border_color(this.typing === "message" ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Input.new(this.message).h_full().text_size(12).text_color(t.foreground)))
        .child(div().id("commit").h(32).px(14).flex().items_center().rounded(8).bg(canCommit ? t.solid : t.raised)
          .text_color(canCommit ? t.solid_foreground : t.dim).text_size(12).when(canCommit, (e) => e.cursor_pointer())
          .on_click((_e, cx) => this.commit(cx)).child(this.busy === "Commit" ? "Committing…" : this.merging && !this.hasMessage ? "Commit merge" : `Commit ${staged || ""}`.trim()))));
  }
}
