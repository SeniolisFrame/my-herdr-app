// Changes: git status of the focused pane's repo, Fork style. Unstaged and staged
// lists; stage files, hunks or single lines; discard, commit, amend, undo commit, ask
// the chat for a message; branches, merge, fetch/pull/push, stash; the history graph
// with checkout, merge, cherry-pick, revert and branch delete.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar } from "gpui-base";
import { exec, readTextFile, writeTextFile, watchFolder, theme, settings, appHome, nextCommand, setShared } from "herdr";
import { location, locationKey, git, READ, sendToChat, focusChat, diffRows, diffRow, button, untab } from "./common.js";
import { layoutGraph } from "./graph.js";
import { oneHunk, someLines, splitDiff, toCrlf } from "./patch.js";

const MAX_FILES = 1000, MAX_LINES = 3000, NET = 120000, PREFETCH_LINES = 20000;
const CONFLICTS = "Conflicts: fix each U file (Ours / Theirs, or edit it and Mark resolved), then Commit. Abort undoes it.";
// An operation that stopped half way, by the file git leaves for it.
const IN_PROGRESS = [["merge", "MERGE_HEAD"], ["cherry-pick", "CHERRY_PICK_HEAD"], ["revert", "REVERT_HEAD"]];
const ASK_FILE = "MY_HERDR_COMMIT_MSG"; // in .git: where the chat saves the message it wrote

// git log (LOG_FORMAT) → commits with their refs and graph lanes.
const LOG_FORMAT = "--format=%H%x01%P%x01%h%x01%D%x01%s%x01%an%x01%ar";
function parseLog(out) {
  const commits = out.split(/\r?\n/).filter(Boolean).map((l) => {
    const [hash, parents, short, decor, subject, author, when] = l.split("\x01");
    const refs = { head: false, local: [], remote: [], tags: [] };
    for (const d of (decor ?? "").split(", ").filter(Boolean)) {
      const name = d.replace(/^HEAD -> /, "");
      if (name !== d || d === "HEAD") refs.head = true;
      if (name.startsWith("refs/heads/")) refs.local.push(name.slice(11));
      else if (name.startsWith("refs/remotes/") && !name.endsWith("/HEAD")) refs.remote.push(name.slice(13));
      else if (name.startsWith("tag: refs/tags/")) refs.tags.push(name.slice(15));
    }
    return { hash, parents: parents ? parents.split(" ") : [], short, refs, subject, author, when };
  });
  const lanes = layoutGraph(commits);
  return commits.map((c, i) => ({ ...c, ...lanes[i] }));
}

// Graph drawing: lane width, row height, left padding (px).
const LANE = 14, ROW = 28, PAD = 8, HALF = ROW / 2;
const laneX = (k) => PAD + k * LANE + LANE / 2;

// One half-row line: straight down, or a rounded bend between two lanes.
function graphLine([from, to, color], half, paint) {
  const x1 = laneX(from), x2 = laneX(to), c = paint(color);
  if (from === to) return div().absolute().left(x1 - 1).top(half === "top" ? 0 : HALF).w(2).h(HALF).bg(c);
  const r = Math.min(8, Math.abs(x2 - x1), HALF);
  if (half === "top") { // from lane `from` at the top, bending into `to` at the middle
    return (x1 < x2 ? div().absolute().left(x1 - 1).w(x2 - x1 + 1).border_l(2).rounded_bl(r) : div().absolute().left(x2).w(x1 - x2 + 1).border_r(2).rounded_br(r))
      .top(0).h(HALF + 1).border_b(2).border_color(c);
  }
  // from the middle at `from`, bending down into lane `to`
  return (x2 > x1 ? div().absolute().left(x1).w(x2 - x1 + 1).border_r(2).rounded_tr(r) : div().absolute().left(x2 - 1).w(x1 - x2 + 1).border_l(2).rounded_tl(r))
    .top(HALF - 1).h(HALF + 1).border_t(2).border_color(c);
}

// A status entry → its place in the Unstaged list, the Staged list, or both.
function sides(f) {
  const out = [];
  if (f.fresh || f.conflict || f.y !== " ") out.push({ path: f.path, side: "unstaged", letter: f.conflict ? "U" : f.fresh ? "A" : f.y });
  if (!f.fresh && !f.conflict && f.x !== " ") out.push({ path: f.path, side: "staged", letter: f.x });
  return out;
}

// What git will make of a file once its unstaged side is staged (or staged side unstaged):
// shown at once, the refresh after git corrects any guess.
function moveSide(f, from) {
  if (from === "unstaged") Object.assign(f, { x: f.fresh ? "A" : f.x !== " " ? f.x : f.y, y: " ", fresh: false });
  else Object.assign(f, f.x === "A" ? { x: "?", y: "?", fresh: true } : { x: " ", y: f.x });
}

export default class Changes extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.files = []; this.rows = []; this.raw = ""; this.view = "changes"; this.chosen = new Set();
    this.message = InputState.new({ placeholder: "Commit message" });
    this.message.on("submit", (_e, cx) => this.commit(cx));
    this.message.on("change", (_e, cx) => { const has = Boolean(this.message.value().trim()); if (has !== this.hasMessage) { this.hasMessage = has; cx.notify(); } });
    this.branchName = InputState.new({ placeholder: "New branch name" });
    this.branchName.on("submit", (_e, cx) => this.newBranch(cx));
    this.logSearch = InputState.new({ placeholder: "Search commits (message, hash, author, branch)" });
    this.logSearch.on("change", (_e, cx) => { this.logQuery = this.logSearch.value().trim().toLowerCase(); cx.notify(); });
    for (const [state, name] of [[this.message, "message"], [this.branchName, "branch"], [this.logSearch, "log"]]) {
      state.on("focus", (_e, cx) => { this.typing = name; cx.notify(); });
      state.on("blur", (_e, cx) => { this.typing = null; cx.notify(); });
    }
    // No timer (each refresh starts git several times): the folder watch and Sync do it.
    this.refresh(cx);
    cx.spawn(async (cx) => { for (;;) { this.command(await nextCommand(), cx); cx.notify(); } });
  }

  // Commands from keys.json ("my-changes.pull") or `herdr-app do my-changes.pull`;
  // "name:value" passes a value (a path, a branch, a commit message, a hash).
  command(c, cx) {
    const i = c.indexOf(":"), name = i < 0 ? c : c.slice(0, i), arg = i < 0 ? "" : c.slice(i + 1);
    const f = this.selected(), item = this.sel;
    const run = {
      focus: () => this.handle.focus(),
      // select:<path>, or select:staged:<path> / select:unstaged:<path> for one list
      select: () => {
        const m = /^(staged|unstaged):(.*)$/.exec(arg), p = m ? m[2] : arg;
        const it = this.items().find((x) => x.path === p && (!m || x.side === m[1]));
        if (it) this.pick(it, cx);
      },
      stage: () => item && this.toggleFile(item, cx),
      sync: () => this.refresh(cx), "stage-all": () => this.stageAll(cx), "unstage-all": () => this.unstageAll(cx),
      hunk: () => this.applyHunk(Number(arg) || 0, cx),
      "discard-hunk": () => this.discardHunk(Number(arg) || 0, cx), // twice

      line: () => { const [h, p] = arg.split(":").map(Number); this.pickLine({ hunk: h, pos: p }, cx); },
      discard: () => f && this.discard(f, cx),
      ours: () => f && this.resolve(f, "ours", cx), theirs: () => f && this.resolve(f, "theirs", cx),
      open: () => item && this.openInFiles(item.path),
      commit: () => { if (arg) this.message.set_value(arg); this.hasMessage = Boolean(this.message.value().trim()); this.commit(cx); },
      amend: () => this.toggleAmend(cx),
      undo: () => this.undoCommit(cx),
      ask: () => this.askChat(cx),
      fetch: () => this.fetch(cx), pull: () => this.pull(cx), push: () => this.push(cx),
      stash: () => this.stash(cx), pop: () => this.pop(cx), abort: () => this.abort(cx),
      branches: () => this.openBranches(cx),
      checkout: () => this.checkout(arg, undefined, cx),
      merge: () => this.merge(arg, cx),
      "new-branch": () => { this.branchName.set_value(arg); this.newBranch(cx); },
      "delete-branch": () => this.deleteBranch(arg, cx),
      "cherry-pick": () => this.cherryPick(arg, cx),
      revert: () => { const c = this.log?.find((r) => r.hash.startsWith(arg)); if (c) this.revert(c, cx); },
      history: () => this.openLog(cx),
      "log-search": () => { this.logSearch.set_value(arg); this.logQuery = arg.toLowerCase(); },
      show: () => this.showCommit(arg, cx),
      pick: () => { this.picked = this.log?.find((r) => r.hash.startsWith(arg))?.hash ?? null; },
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

  // Unstaged first, then staged; a partly staged file is in both.
  items() { return this.files.flatMap(sides); }
  selected() { return this.files.find((f) => f.path === this.sel?.path); }

  // --- status ------------------------------------------------------------------

  refresh(cx) {
    if (this.loading || this.busy) { this.again = true; return; }
    const { cwd, on } = location(), context = locationKey();
    if (context !== this.context) {
      this.context = context; this.root = null; this.files = []; this.sel = null; this.setLines([], "");
      this.error = null; this.note = null; this.watched = null; this.view = "changes"; this.menu = null; this.confirm = null;
      this.amend = false; this.askFile = null; this.diffs = null; this.changed = 0; this.branches = null; this.commits = new Map();
    }
    if (!cwd) return;
    this.loading = true; this.again = false;
    cx.spawn(async (cx) => {
      try {
        // The repo folders only change with the location: asked once per location, not every refresh.
        if (this.top?.context !== context) {
          const top = await exec("git", ["rev-parse", "--show-toplevel", "--absolute-git-dir"], { cwd, on });
          if (locationKey() !== context) return;
          if (top.code !== 0) { this.top = null; this.root = null; this.files = []; this.setLines([], ""); this.error = "Not a git repository"; return; }
          this.top = { context, dirs: top.stdout.trim().split(/\r?\n/) };
        }
        const [root, gitDir] = this.top.dirs, g = (args) => git(root, on, [...READ, ...args]);
        // All at once: each git start costs 40ms to 1s on Windows. The in-progress refs are plain files in .git.
        // Every file's diff comes too, so clicking a file shows it at once; not when the last
        // refresh saw a huge change (then each file loads on its own).
        const whole = (cached) => this.changed > PREFETCH_LINES ? Promise.resolve(null)
          : g(["diff", ...(cached ? ["--cached"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames"]).then(splitDiff, () => null);
        const [status, staged, unstaged, diffStaged, diffUnstaged, ...marks] = await Promise.all([
          g(["status", "--porcelain=v1", "-b", "-z", "--no-renames", "--untracked-files=all"]),
          g(["diff", "--cached", "--numstat", "-z", "--no-renames"]), g(["diff", "--numstat", "-z", "--no-renames"]),
          whole(true), whole(false),
          ...IN_PROGRESS.map(([, ref]) => readTextFile(`${gitDir}/${ref}`, { on }).then((t) => t !== null, () => false)),
        ]);
        const inProgress = IN_PROGRESS.find((_, i) => marks[i])?.[0] ?? null;
        const stats = { staged: {}, unstaged: {} };
        let changed = 0;
        for (const [side, out] of [["staged", staged], ["unstaged", unstaged]]) {
          for (const entry of out.split("\0")) {
            const [a, d, ...parts] = entry.split("\t");
            if (parts.length) stats[side][parts.join("\t")] = { add: Number(a) || 0, del: Number(d) || 0, binary: a === "-" };
            changed += (Number(a) || 0) + (Number(d) || 0);
          }
        }
        const entries = status.split("\0").filter(Boolean);
        const branchLine = entries[0]?.startsWith("## ") ? entries.shift().slice(3) : "";
        const files = entries.slice(0, MAX_FILES).map((entry) => {
          const x = entry[0], y = entry[1], path = entry.slice(3);
          const conflict = x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D");
          return { path, x, y, fresh: x === "?", conflict, stats: { staged: stats.staged[path], unstaged: stats.unstaged[path] } };
        });
        if (locationKey() !== context) return;
        this.root = root; this.gitDir = gitDir; this.on = on; this.hasHead = !/^(No commits yet|Initial commit) on /.test(branchLine); this.inProgress = inProgress; this.files = files;
        this.changed = changed; this.diffs = { staged: diffStaged, unstaged: diffUnstaged };
        if (inProgress) this.amend = false; // a merge started meanwhile: Commit must not rewrite the last commit
        this.limited = entries.length > MAX_FILES; this.error = null;
        // "main...origin/main [ahead 1, behind 2]" or "No commits yet on main"
        const b = /^(?:No commits yet on |Initial commit on )?(.+?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/.exec(branchLine) ?? [];
        this.branch = b[1] === "HEAD (no branch)" ? "detached HEAD" : b[1]; this.upstream = b[2]; this.track = b[3];
        this.watch(root, cx);
        await this.takeAskedMessage();
        const items = this.items();
        if (this.sel && !items.some((x) => x.path === this.sel.path && x.side === this.sel.side)) {
          this.sel = items.find((x) => x.path === this.sel.path) ?? null; // staged all of it: follow it to the other list
        }
        this.sel ??= items[0] ?? null;
        if (this.sel) await this.load(this.sel, context).catch((e) => { if (locationKey() === context) this.setLines([`Cannot show this diff: ${e.message ?? e}`], ""); });
        else this.setLines([], "");
      } catch (e) { this.top = null; if (locationKey() === context) this.error = String(e.message ?? e); } // the repo may be gone: ask again
      finally { this.loading = false; cx.notify(); if (this.again) this.refresh(cx); }
    });
  }

  // The diff a hunk or line button acts on: index → worktree (unstaged) or HEAD → index (staged).
  diffArgs(item) {
    return [...READ, "diff", ...(item.side === "staged" ? ["--cached"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", item.path];
  }

  async load(item, context) {
    const file = this.files.find((f) => f.path === item.path), root = this.root, on = this.on, same = () => locationKey() === context && this.sel === item;
    if (!file) return;
    if (file.conflict || (file.fresh && item.side === "unstaged")) {
      const text = await readTextFile(`${root}/${item.path}`, { on }).catch(() => null);
      if (!same()) return;
      if (text === null) return this.setLines(["Cannot show this file (deleted, binary, too large, or unreadable)"], "");
      if (text.includes("\0")) return this.setLines(["Binary file"], "");
      const lines = text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
      if (file.conflict) return this.setConflict(lines);
      return this.setLines(["@@ -0,0 +1 @@ new file: stage it with its box", ...lines.map((l) => `+${l}`)], "");
    }
    const raw = this.diffs?.[item.side]?.get(item.path) ?? await git(root, on, this.diffArgs(item));
    if (!same()) return;
    const all = raw.replace(/\r/g, "").replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
    if (first < 0) this.setLines([file.stats[item.side]?.binary ? "Binary file changed" : "No text change (mode or line endings only)"], "");
    else this.setLines(all.slice(first), raw);
  }

  setConflict(lines) {
    this.raw = ""; this.chosen = new Set();
    this.rows = lines.slice(0, MAX_LINES).map((text, i) => /^(<<<<<<<|=======|>>>>>>>)/.test(text) ? { kind: "@", text } : { kind: " ", number: i + 1, text: untab(text) || " " });
  }

  // A refresh that finds the same diff keeps the lines chosen in it.
  setLines(lines, raw) {
    if (!raw || raw !== this.raw) this.chosen = new Set();
    this.raw = raw;
    this.rows = diffRows(lines.slice(0, MAX_LINES).map((l) => l.length > 4000 ? l.slice(0, 4000) + "… (line truncated)" : l));
  }

  pick(item, cx) {
    this.sel = item; this.confirm = null; this.setLines([], "");
    const context = this.context;
    cx.spawn(async (cx) => {
      try { await this.load(item, context); }
      catch (e) { if (this.sel === item) this.setLines([`Cannot show this diff: ${e.message ?? e}`], ""); }
      cx.notify();
    });
    cx.notify();
  }

  // Click a "+" or "-" line to choose it; the hunk's button then stages only the chosen lines.
  pickLine(row, cx) {
    const line = this.rows.find((r) => r.hunk === row.hunk && r.pos === row.pos);
    if (!this.raw || (line?.kind !== "+" && line?.kind !== "-")) return; // only changed lines
    const key = `${row.hunk}:${row.pos}`;
    if (this.chosen.has(key)) this.chosen.delete(key); else this.chosen.add(key);
    cx.notify();
  }

  // --- actions -----------------------------------------------------------------

  // Runs one git job at a time, shows its result, then refreshes.
  // Says whether the job started (one at a time).
  act(label, job, cx, done) {
    if (this.busy || !this.root) return false;
    this.busy = label; this.note = null; this.confirm = null;
    let ok = false;
    cx.spawn(async (cx) => {
      try { this.note = { text: (await job()) ?? null }; ok = true; }
      catch (e) {
        let text = String(e.message ?? e);
        if (/merge|pull|stash pop|cherry|revert/i.test(label)) {
          const unmerged = await this.git([...READ, "diff", "--name-only", "--diff-filter=U"]).catch(() => "");
          if (unmerged.trim()) text = CONFLICTS;
        }
        this.note = { text, error: true };
      }
      finally { this.busy = null; done?.(ok); this.refresh(cx); if (this.view === "log") this.loadLog(cx); cx.notify(); }
    });
    cx.notify();
    return true;
  }

  toggleFile(item, cx) {
    const f = this.files.find((x) => x.path === item.path);
    if (!f) return;
    if (f.conflict) return this.act("Resolve", async () => { await this.git(["add", "--", f.path]); return `${f.path} marked resolved`; }, cx);
    const started = this.act(item.side === "staged" ? "Unstage" : "Stage", async () => {
      if (item.side === "unstaged") await this.git(["add", "-A", "--", f.path]);
      else await this.git(this.hasHead ? ["restore", "--staged", "--", f.path] : ["rm", "--cached", "-q", "--", f.path]);
    }, cx);
    if (started) this.moved([f], item.side);
  }

  stageAll(cx) {
    if (this.act("Stage all", () => this.git(["add", "-A"]), cx)) this.moved(this.files.filter((f) => !f.conflict && sides(f).some((x) => x.side === "unstaged")), "unstaged");
  }
  unstageAll(cx) {
    if (this.act("Unstage all", () => this.git(this.hasHead ? ["reset", "-q"] : ["rm", "-r", "--cached", "-q", "."]), cx)) this.moved(this.files.filter((f) => sides(f).some((x) => x.side === "staged")), "staged");
  }

  // Moves files to the other list now, as Fork does, while git runs.
  moved(files, from) {
    for (const f of files) moveSide(f, from);
    // The shown diff is of the old side: cleared, so no hunk button can apply it to the new one.
    const f = files.find((x) => x.path === this.sel?.path);
    if (f) { this.sel = sides(f).find((x) => x.side !== from) ?? this.sel; this.setLines([], ""); }
  }

  // Stages hunk n of the selected unstaged file (or unstages it from the staged one);
  // with lines chosen in that hunk, only those lines.
  applyHunk(n, cx) {
    const item = this.sel, unstage = item?.side === "staged";
    if (!item) return;
    const lines = this.chosenIn(n), shown = this.raw;
    this.act(unstage ? "Unstage" : "Stage", async () => {
      const patch = await this.patch(item, n, lines, unstage, shown);
      await this.git(["apply", "--cached", "--recount", ...(unstage ? ["-R"] : []), patch]);
      return `${lines.size ? `${lines.size} line${lines.size > 1 ? "s" : ""}` : "Hunk"} ${unstage ? "unstaged" : "staged"}`;
    }, cx);
  }

  // Throws hunk n of the selected unstaged file (or only its chosen lines) out of the file
  // itself; what is staged stays. Asks twice.
  discardHunk(n, cx) {
    const item = this.sel;
    if (item?.side !== "unstaged" || !this.raw) return;
    if (this.confirm?.hunk !== n) { this.confirm = { hunk: n }; cx.notify(); return; }
    const lines = this.chosenIn(n), shown = this.raw;
    this.act("Discard", async () => {
      // The patch with a chosen line's change only, as for unstaging, applied in reverse to the file.
      const crlf = (await readTextFile(`${this.root}/${item.path}`, { on: this.on }))?.includes("\r\n");
      const patch = await this.patch(item, n, lines, true, shown, crlf);
      // autocrlf off: git would otherwise rewrite every line ending of the file.
      await this.git(["-c", "core.autocrlf=false", "apply", "--recount", "-R", patch]);
      return `${lines.size ? `${lines.size} line${lines.size > 1 ? "s" : ""}` : "Hunk"} discarded`;
    }, cx);
  }

  chosenIn(n) { return new Set([...this.chosen].filter((k) => k.startsWith(`${n}:`)).map((k) => Number(k.split(":")[1]))); }

  // Writes hunk n (or its chosen lines) of the item's diff as a patch file; its path.
  async patch(item, n, lines, reverse, shown, crlf) {
    const raw = await this.git(this.diffArgs(item));
    // The diff on screen may be from the last refresh: its hunk and line numbers must still fit.
    if (raw !== shown) throw new Error("The file changed: wait for the refresh and try again");
    let patch = lines.size ? someLines(raw, n, lines, reverse) : oneHunk(raw, n);
    if (!patch) throw new Error("The file changed: wait for the refresh and try again");
    if (crlf) patch = toCrlf(patch);
    const file = `${appHome()}/data/my-changes.patch`;
    await writeTextFile(file, patch, await readTextFile(file));
    return file;
  }

  discard(f, cx) {
    if (this.confirm?.path !== f.path) { this.confirm = { path: f.path }; cx.notify(); return; }
    this.act("Discard", async () => {
      if (f.conflict) throw new Error("Conflicted file: use Ours / Theirs, or edit it");
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

  // Files opens the file (my-files watches this shared value).
  openInFiles(path) { setShared("my-files.open", { path: `${this.root}/${path}`, n: Date.now() }); }

  // --- commit ------------------------------------------------------------------

  commit(cx) {
    const message = this.message.value().trim(), staged = this.files.some((f) => sides(f).some((x) => x.side === "staged"));
    if (this.amend) {
      if (!message) { this.message.focus(); return; }
      return this.act("Amend", async () => { await this.git(["commit", "-q", "--amend", "-m", message]); return "Last commit amended"; },
        cx, (ok) => { if (ok) { this.message.set_value(""); this.hasMessage = false; this.amend = false; } });
    }
    if (!staged && !this.inProgress) { this.note = { text: "Nothing staged: tick files (or Stage all) first", error: true }; cx.notify(); return; }
    if (!message && !this.inProgress) { this.message.focus(); return; }
    // A failed commit (a hook said no) keeps the message to fix and retry.
    const started = this.act("Commit", async () => {
      await this.git(message ? ["commit", "-q", "-m", message] : ["commit", "-q", "--no-edit"]);
      return "Committed";
    }, cx, (ok) => { if (ok) { this.message.set_value(""); this.hasMessage = false; } });
    if (!started) return;
    // The staged files leave the list now; the refresh brings them back if git refused.
    this.files = this.files.filter((f) => f.fresh || f.conflict || f.y !== " ").map((f) => f.fresh || f.conflict ? f : { ...f, x: " " });
    if (this.sel?.side === "staged") { this.sel = null; this.setLines([], ""); }
  }

  // Amend: the next Commit rewrites the last commit (its message is filled in to edit).
  // Not during a merge, cherry-pick or revert: the commit being made there is git's.
  toggleAmend(cx) {
    if (!this.hasHead || this.inProgress) return;
    this.amend = !this.amend;
    if (!this.amend) { this.message.set_value(""); this.hasMessage = false; cx.notify(); return; }
    cx.spawn(async (cx) => {
      const last = await this.git([...READ, "log", "-1", "--format=%B"]).catch(() => "");
      if (this.amend) { this.message.set_value(last.trim()); this.hasMessage = Boolean(last.trim()); }
      cx.notify();
    });
    cx.notify();
  }

  // Undo commit: the last commit's changes go back to staged and its message back in
  // the box. Asks twice; says so when the commit is already pushed.
  undoCommit(cx) {
    if (!this.hasHead || this.inProgress) return;
    if (this.confirm?.undo === undefined) {
      this.confirm = { undo: false };
      cx.spawn(async (cx) => {
        const remote = await this.git([...READ, "branch", "-r", "--contains", "HEAD"]).catch(() => "");
        if (this.confirm?.undo !== undefined) this.confirm = { undo: Boolean(remote.trim()) };
        cx.notify();
      });
      cx.notify();
      return;
    }
    this.act("Undo commit", async () => {
      const last = await this.git([...READ, "log", "-1", "--format=%B"]);
      const parent = await exec("git", ["rev-parse", "--verify", "-q", "HEAD~1"], { cwd: this.root, on: this.on });
      await this.git(parent.code === 0 ? ["reset", "-q", "--soft", "HEAD~1"] : ["update-ref", "-d", "HEAD"]);
      this.message.set_value(last.trim()); this.hasMessage = Boolean(last.trim());
      return "Last commit undone: its changes are staged again";
    }, cx);
  }

  // Asks the chat's agent to write the message into .git/MY_HERDR_COMMIT_MSG; the next
  // refresh (the folder watch sees the file) puts it in the box.
  askChat(cx) {
    if (!this.gitDir) return;
    const file = `${this.gitDir}/${ASK_FILE}`.replace(/\//g, this.gitDir.includes("\\") ? "\\" : "/");
    this.askFile = file;
    cx.spawn(async (cx) => {
      try {
        this.askLast = await readTextFile(file, { on: this.on }).catch(() => null);
        await sendToChat(`Write a git commit message for the staged changes (git diff --cached). Save only the message to ${file}, replacing that file. Don't commit.`, cx);
        this.note = { text: "Asked the chat: press Enter there. The message shows up here when it's saved." };
      } catch (e) { this.note = { text: `Not sent: ${e.message ?? e}`, error: true }; }
      cx.notify();
    });
  }

  async takeAskedMessage() {
    if (!this.askFile) return;
    const text = await readTextFile(this.askFile, { on: this.on }).catch(() => null);
    if (!text?.trim() || text === this.askLast) return;
    this.askLast = text; this.message.set_value(text.trim()); this.hasMessage = true;
    this.note = { text: "The chat wrote a commit message: check it, then Commit" };
  }

  // --- remote and stash ------------------------------------------------------------

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
  abort(cx) {
    const kind = this.inProgress;
    if (kind) this.act(`Abort ${kind}`, async () => { await this.git([kind, "--abort"]); return `${kind} aborted`; }, cx);
  }

  // --- branches ------------------------------------------------------------------

  openBranches(cx) {
    if (this.menu) { this.menu = null; cx.notify(); return; }
    this.menu = this.branches ?? { local: [], remote: [] }; // the last list at once, then the current one
    cx.spawn(async (cx) => {
      const refs = async (where) => (await this.git([...READ, "for-each-ref", "--format=%(refname:short)", where]).catch(() => "")).split(/\r?\n/).filter(Boolean);
      const [local, remotes] = await Promise.all([refs("refs/heads"), refs("refs/remotes")]);
      this.branches = { local, remote: remotes.filter((r) => r.includes("/") && !r.endsWith("/HEAD")) };
      if (this.menu) this.menu = this.branches;
      cx.notify();
    });
    cx.notify();
  }

  // isRemote undefined (a command): a local branch of that name wins, else it's a remote one.
  checkout(branch, isRemote, cx) {
    this.menu = null;
    const hasLocal = async (name) => (await exec("git", ["show-ref", "--verify", "-q", `refs/heads/${name}`], { cwd: this.root, on: this.on })).code === 0;
    this.act("Checkout", async () => {
      isRemote ??= !(await hasLocal(branch));
      // origin/x with a local x already (usually behind it): switch to x, then Pull.
      const local = branch.replace(/^[^/]+\//, "");
      if (isRemote && await hasLocal(local)) { await this.git(["switch", local]); return `On ${local}: Pull to bring in ${branch}`; }
      await this.git(isRemote ? ["switch", "--track", branch] : ["switch", branch]);
      return `On ${branch}`;
    }, cx);
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

  // Asks first. A branch with commits no other branch has is refused; its button then
  // turns into Force delete, which drops those commits.
  deleteBranch(name, cx) {
    const c = this.confirm;
    if (c?.branch !== name) { this.confirm = { branch: name }; cx.notify(); return; }
    let unmerged = false;
    this.act("Delete branch", async () => {
      try { await this.git(["branch", c.force ? "-D" : "-d", name]); }
      catch (e) {
        if (c.force || !/not fully merged/.test(e.message)) throw e;
        unmerged = true;
        throw new Error(`${name} has commits no other branch has. Force delete drops them.`);
      }
      return `Deleted ${name}`;
    }, cx, () => { if (unmerged) this.confirm = { branch: name, force: true }; });
  }

  cherryPick(hash, cx) { this.act("Cherry-pick", async () => { await this.git(["cherry-pick", hash]); return `Cherry-picked ${hash.slice(0, 7)}`; }, cx); }

  // A merge commit is reverted against its first parent (the branch it was merged into).
  revert(c, cx) {
    this.act("Revert", async () => { await this.git(["revert", "--no-edit", ...(c.parents.length > 1 ? ["-m", "1"] : []), c.hash]); return `Reverted ${c.short}`; }, cx);
  }

  // --- history -------------------------------------------------------------------

  openLog(cx) {
    if (this.view !== "changes") { this.view = "changes"; cx.notify(); return; }
    if (!this.root) return;
    // The last history shows at once while it reloads.
    if (this.logRoot !== this.root) { this.log = null; this.logRoot = this.root; }
    this.view = "log"; this.picked = null;
    this.loadLog(cx);
  }

  loadLog(cx) {
    cx.spawn(async (cx) => {
      try { this.log = parseLog(await this.git([...READ, "log", "--all", "--date-order", "--decorate=full", "-n", "500", LOG_FORMAT])); }
      catch (e) { this.log = []; this.note = { text: String(e.message ?? e), error: true }; }
      cx.notify();
    });
    cx.notify();
  }

  // What the picked commit offers: its branches to check out, merge or delete, the
  // commit itself to cherry-pick or revert.
  logActions(c, t) {
    const out = [button("log-view", "View changes", t, (_e, cx) => this.showCommit(c.hash, cx))];
    const branches = [...c.refs.local.map((b) => [b, false]), ...c.refs.remote.filter((r) => !c.refs.local.includes(r.replace(/^[^/]+\//, ""))).map((b) => [b, true])];
    for (const [b, remote] of branches) {
      if (b === this.branch) continue;
      out.push(button(`log-co-${b}`, `Checkout ${b}`, t, (_e, cx) => this.checkout(b, remote, cx)));
      out.push(button(`log-merge-${b}`, `Merge ${b} into ${this.branch}`, t, (_e, cx) => this.merge(b, cx)));
      const del = this.confirm?.branch === b ? (this.confirm.force ? `Force delete ${b}` : `Delete ${b}? click again`) : `Delete ${b}`;
      if (!remote) out.push(button(`log-del-${b}`, del, t, (_e, cx) => this.deleteBranch(b, cx), { danger: true }));
    }
    if (!branches.length && !c.refs.head) {
      out.push(button("log-co-commit", "Checkout commit", t, (_e, cx) => this.act("Checkout", async () => { await this.git(["switch", "--detach", c.hash]); return `On ${c.short} (no branch)`; }, cx)));
      out.push(button("log-merge-commit", `Merge into ${this.branch}`, t, (_e, cx) => this.merge(c.hash, cx)));
    }
    if (!c.refs.head) out.push(button("log-cherry", `Cherry-pick onto ${this.branch}`, t, (_e, cx) => this.cherryPick(c.hash, cx)));
    out.push(button("log-revert", "Revert", t, (_e, cx) => this.revert(c, cx)));
    out.push(button("log-copy", "Copy hash", t, (_e, cx) => { cx.write_to_clipboard(c.hash); this.note = { text: `Copied ${c.short}` }; cx.notify(); }));
    return out;
  }

  // A commit never changes: each one is read once (the last 50 kept).
  showCommit(hash, cx) {
    this.commits ??= new Map();
    this.view = "commit"; this.shown = hash; this.commitRows = this.commits.get(hash) ?? null;
    if (this.commitRows) { cx.notify(); return; }
    cx.spawn(async (cx) => {
      try {
        const out = await this.git([...READ, "show", "--format=%h  %an, %ar%n%n%B", "--no-color", "--no-ext-diff", "-M", "-m", "--first-parent", hash]);
        const rows = diffRows(out.replace(/\r/g, "").replace(/\n$/, "").split("\n").slice(0, MAX_LINES * 3));
        this.commits.set(hash, rows);
        if (this.commits.size > 50) this.commits.delete(this.commits.keys().next().value);
        if (this.shown === hash) this.commitRows = rows;
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
    const items = this.items(), i = items.findIndex((x) => x.path === this.sel?.path && x.side === this.sel?.side);
    const act = {
      up: () => i > 0 && this.pick(items[i - 1], cx),
      down: () => i < items.length - 1 && this.pick(items[i + 1], cx),
      space: () => this.sel && this.toggleFile(this.sel, cx),
      c: () => this.message.focus(),
      l: () => this.openLog(cx),
      s: () => this.sel && this.send(this.sel.path, cx),
      o: () => this.sel && this.openInFiles(this.sel.path),
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

  fileRow(item, t) {
    const f = this.files.find((x) => x.path === item.path), parts = item.path.split("/"), name = parts.pop();
    const sel = this.sel?.path === item.path && this.sel?.side === item.side, staged = item.side === "staged", st = f.stats[item.side];
    const color = item.letter === "A" || item.letter === "?" ? t.ansi2 : item.letter === "D" || item.letter === "U" ? t.ansi1 : t.blocked;
    return h_flex().id(`change-${item.side}-${item.path}`).h(26).flex_none().px(6).gap(7).items_center().rounded(6).cursor_pointer()
      .when(sel, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_click((e, cx) => { if (e.click_count > 1) this.openInFiles(item.path); else this.pick(item, cx); })
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.send(item.path, cx); })
      .child(div().id(`box-${item.side}-${item.path}`).w(16).h(16).flex_none().flex().items_center().justify_center().rounded(4).border_1()
        .border_color(f.conflict ? t.ansi1 : t.accent).bg(staged ? t.accent : t.background)
        .text_size(11).text_color(staged ? t.accent_foreground : t.ansi1)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); this.toggleFile(item, cx); }).child(staged ? "✓" : f.conflict ? "!" : ""))
      .child(div().w(12).flex_none().text_size(11).text_color(color).child(item.letter === "?" ? "A" : item.letter))
      .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().flex_none().max_w(260).truncate().child(name)))
      .when(st?.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${st.add}`)))
      .when(st?.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${st.del}`)));
  }

  // One list (Unstaged or Staged) with its header and all-button, at most 6 rows high.
  fileList(side, t) {
    const items = this.items().filter((x) => x.side === side), staged = side === "staged";
    return [
      h_flex().flex_none().px(10).pt(6).pb(2).gap(6).items_center().text_size(11).text_color(t.dim)
        .child(div().flex_1().font_semibold().child(`${staged ? "Staged" : "Unstaged"} · ${items.length}`))
        .child(staged ? button("unstage-all", "Unstage all", t, (_e, cx) => this.unstageAll(cx), { enabled: !this.busy && items.length > 0 })
          : button("stage-all", "Stage all", t, (_e, cx) => this.stageAll(cx), { enabled: !this.busy && items.length > 0 })),
      div().flex_none().h(Math.min(Math.max(items.length, 1) * 26 + 4, 160)).relative()
        .child(v_flex().id(`list-${side}`).absolute().inset_0().overflow_y_scroll().px(6).children(items.map((x) => this.fileRow(x, t)))
          .when(!items.length, (e) => e.child(div().px(6).py(4).text_size(12).text_color(t.dim).child(staged ? "Nothing staged" : "No changes"))))
        .child(Scrollbar.vertical(`list-${side}`).absolute().inset_0()),
    ];
  }

  hunkButton(row, t) {
    if (!this.raw || row.hunk === undefined) return div();
    const n = [...this.chosen].filter((k) => k.startsWith(`${row.hunk}:`)).length, unstage = this.sel?.side === "staged";
    const what = n ? `${n} line${n > 1 ? "s" : ""}` : "hunk";
    const stage = div().id(`hunk-${row.hunk}`).flex_none().px(6).rounded(4).bg(n ? t.accent : t.background).text_color(n ? t.accent_foreground : t.accent)
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.applyHunk(row.hunk, cx)).child(`${unstage ? "Unstage" : "Stage"} ${what}`);
    if (unstage) return stage;
    const asking = this.confirm?.hunk === row.hunk;
    return h_flex().flex_none().gap(4).child(stage)
      .child(div().id(`discard-hunk-${row.hunk}`).flex_none().px(6).rounded(4).bg(asking ? t.ansi1 : t.background).text_color(asking ? t.background : t.ansi1)
        .cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.discardHunk(row.hunk, cx)).child(asking ? `Discard ${what}? click again` : `Discard ${what}`));
  }

  diffView(id, rows, t, withHunks) {
    const opts = withHunks && this.raw ? {
      hunkButton: (r) => this.hunkButton(r, t),
      onPick: (r, cx) => this.pickLine(r, cx),
      picked: (r) => this.chosen.has(`${r.hunk}:${r.pos}`),
    } : {};
    return v_flex().id(id).flex_1().min_h(0).overflow_y_scrollbar().py(2).font_family(settings().font_family ?? "JetBrains Mono").text_size(12)
      .children(rows.map((row) => diffRow(row, t, opts)));
  }

  toolbar(t) {
    const busy = Boolean(this.busy), track = this.track ? ` ${this.track.replace(/ahead /, "↑").replace(/behind /, "↓").replace(", ", " ")}` : "";
    return h_flex().flex_none().px(10).py(6).gap(5).items_center().border_b(1).border_color(t.border).flex_wrap()
      .child(button("branch", `⎇ ${this.branch ?? "…"}${track} ▾`, t, (_e, cx) => this.openBranches(cx), { active: Boolean(this.menu) }))
      .child(div().flex_1())
      .child(button("sync", "Sync", t, (_e, cx) => this.refresh(cx), { enabled: !this.loading }))
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
      .child(h_flex().gap(6).pb(4).child(this.input("branch-input", this.branchName, "branch", t))
        .child(button("branch-create", "Create", t, (_e, cx) => this.newBranch(cx), { primary: true })))
      .child(div().px(8).pt(4).text_size(11).text_color(t.dim).child("Local — click to check out"))
      .children(m.local.map((b) => row(b, false)))
      .when(m.remote.length > 0, (e) => e.child(div().px(8).pt(8).text_size(11).text_color(t.dim).child("Remote")).children(m.remote.map((b) => row(b, true))));
  }

  input(id, state, name, t) {
    return div().id(id).flex_1().min_w(0).h(28).px(8).flex().items_center().rounded(7).border_1()
      .border_color(this.typing === name ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(Input.new(state).h_full().text_size(12).text_color(t.foreground));
  }

  logView(t) {
    if (!this.log) return [div().p(12).text_color(t.dim).child("Loading history…")];
    const palette = [t.ansi4, t.ansi2, t.ansi5, t.ansi3, t.ansi6, t.ansi1, t.ansi12, t.ansi10], paint = (n) => palette[n % palette.length];
    const q = this.logQuery;
    // A search shows the matching commits only, so their lines would join the wrong rows: no graph then.
    const rows = q ? this.log.filter((r) => [r.subject, r.hash, r.author, ...r.refs.local, ...r.refs.remote, ...r.refs.tags].some((s) => s.toLowerCase().includes(q))) : this.log;
    const width = q ? 0 : PAD * 2 + LANE * Math.min(12, Math.max(1, ...this.log.map((r) => r.width)));
    const picked = this.log.find((r) => r.hash === this.picked);
    const pill = (id, text, fg, bg, border) => div().id(id).flex_none().h(18).px(6).flex().items_center().rounded(9).text_size(11)
      .text_color(fg).bg(bg).when(Boolean(border), (e) => e.border_1().border_color(border)).child(text);
    const row = (r) => {
      const c = paint(r.color), x = laneX(r.col), merge = r.parents.length > 1;
      return h_flex().id(`log-${r.hash}`).w_full().h(ROW).flex_none().pr(10).gap(6).items_center().cursor_pointer()
        .when(this.picked === r.hash, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
        .on_click((e, cx) => { if (e.click_count > 1) this.showCommit(r.hash, cx); else { this.picked = r.hash; this.confirm = null; cx.notify(); } })
        .when(!q, (e) => e.child(div().relative().flex_none().w(width).h(ROW).overflow_hidden()
          .children(r.top.map((l) => graphLine(l, "top", paint)))
          .children(r.bottom.map((l) => graphLine(l, "bottom", paint)))
          .child(div().absolute().left(x - 5).top(HALF - 5).w(10).h(10).rounded(5).border_2().border_color(r.refs.head ? t.foreground : c).bg(merge ? t.background : c))))
        .when(Boolean(q), (e) => e.child(div().flex_none().pl(10).text_color(t.dim).font_family(settings().font_family ?? "JetBrains Mono").child(r.short)))
        .children(r.refs.local.map((b) => pill(`ref-${r.hash}-${b}`, b, b === this.branch ? t.background : c, b === this.branch ? c : c + "26")))
        .children(r.refs.remote.map((b) => pill(`ref-${r.hash}-${b}`, b, c, c + "14", c + "80")))
        .children(r.refs.tags.map((b) => pill(`tag-${r.hash}-${b}`, b, t.ansi3, t.ansi3 + "1f")))
        .child(div().flex_1().min_w(0).truncate().text_color(merge ? t.muted : t.foreground).child(r.subject))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(`${r.author} · ${r.when}`));
    };
    return [
      h_flex().flex_none().px(10).pt(6).child(this.input("log-search", this.logSearch, "log", t)),
      h_flex().flex_none().px(10).py(6).gap(5).items_center().flex_wrap().border_b(1).border_color(t.border).text_size(12)
        .children(picked ? [div().text_color(t.dim).font_family(settings().font_family ?? "JetBrains Mono").child(picked.short), ...this.logActions(picked, t)]
          : [div().text_color(t.dim).child(q ? `${rows.length} of the last 500 commits` : "Click a commit for its actions · double-click to see its changes")]),
      v_flex().id("log").flex_1().min_h(0).overflow_y_scrollbar().text_size(12).children(rows.map(row)),
    ];
  }

  commitBox(t) {
    const staged = this.items().filter((x) => x.side === "staged").length;
    const canCommit = !this.busy && (this.amend ? this.hasMessage : this.inProgress || (staged > 0 && this.hasMessage));
    const undo = this.confirm?.undo;
    const label = this.busy === "Commit" || this.busy === "Amend" ? "Committing…" : this.amend ? "Amend" : this.inProgress && !this.hasMessage ? `Commit ${this.inProgress}` : `Commit ${staged || ""}`.trim();
    return v_flex().flex_none().p(10).gap(6).border_t(1).border_color(t.border)
      .child(h_flex().gap(6).items_center()
        .child(button("amend", `${this.amend ? "☑" : "☐"} Amend`, t, (_e, cx) => this.toggleAmend(cx), { active: this.amend, enabled: this.hasHead && !this.inProgress }))
        .child(button("undo", undo === undefined ? "Undo last commit" : undo ? "Already pushed! Undo anyway? click again" : "Undo last commit? click again", t,
          (_e, cx) => this.undoCommit(cx), { enabled: this.hasHead && !this.busy && !this.inProgress, danger: undo !== undefined }))
        .child(div().flex_1())
        .child(button("ask", "Ask chat to write it", t, (_e, cx) => this.askChat(cx), { enabled: staged > 0 })))
      .child(h_flex().gap(8)
        .child(div().id("commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1()
          .border_color(this.typing === "message" ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Input.new(this.message).h_full().text_size(12).text_color(t.foreground)))
        .child(div().id("commit").h(32).px(14).flex().items_center().rounded(8).bg(canCommit ? t.solid : t.raised)
          .text_color(canCommit ? t.solid_foreground : t.dim).text_size(12).when(canCommit, (e) => e.cursor_pointer())
          .on_click((_e, cx) => this.commit(cx)).child(label)));
  }

  render(cx) {
    if (locationKey() !== this.context) this.refresh(cx);
    const t = theme(), f = this.selected(), item = this.sel;
    // Lists that fill the panel stay direct children of the root: one more flex level
    // and they lay out at zero height.
    const body = this.menu ? this.branchMenu(t)
      : this.view === "log" ? this.logView(t)
      : this.view === "commit" ? [
        h_flex().flex_none().px(10).py(4).gap(6).items_center().child(button("commit-back", "← History", t, (_e, cx) => { this.view = "log"; cx.notify(); })),
        this.commitRows ? this.diffView("commit-diff", this.commitRows, t, false) : div().p(12).text_color(t.dim).child("Loading commit…")]
      : !this.root ? div().p(12).text_color(t.dim).child(this.error ?? (this.loading ? "Loading…" : "No folder"))
      : [
        ...this.fileList("unstaged", t),
        ...this.fileList("staged", t),
        f ? h_flex().flex_none().px(10).py(4).gap(6).items_center().border_t(1).border_b(1).border_color(t.border)
          .child(div().flex_1().min_w(0).truncate().text_size(12).font_semibold().child(`${f.path}${item.side === "staged" ? " (staged)" : ""}`))
          .child(button("open", "Open", t, () => this.openInFiles(f.path)))
          .when(f.conflict, (e) => e.child(button("ours", "Ours", t, (_e, cx) => this.resolve(f, "ours", cx)))
            .child(button("theirs", "Theirs", t, (_e, cx) => this.resolve(f, "theirs", cx)))
            .child(button("resolved", "Mark resolved", t, (_e, cx) => this.toggleFile(item, cx))))
          .when(!f.conflict, (e) => e.child(button("discard", this.confirm?.path === f.path ? "Discard? click again" : "Discard", t, (_e, cx) => this.discard(f, cx), { danger: true })))
          : div().flex_1(),
        this.diffView("changes-diff", this.rows, t, true)];
    return v_flex().id("my-changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .child(h_flex().h(42).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Changes"))
        .when(Boolean(this.inProgress), (e) => e.child(div().px(6).rounded(4).bg(t.blocked).text_color(t.background).text_size(11).child(this.inProgress.toUpperCase())))
        .child(div().flex_1())
        .when(Boolean(this.busy), (e) => e.child(div().text_size(11).text_color(t.dim).child(`${this.busy}…`)))
        .when(Boolean(this.inProgress), (e) => e.child(button("abort", `Abort ${this.inProgress}`, t, (_e, cx) => this.abort(cx), { danger: true }))))
      .when(Boolean(this.root), (e) => e.child(this.toolbar(t)))
      .when(Boolean(this.note?.text), (e) => e.child(h_flex().flex_none().px(12).py(4).gap(6).text_size(11).text_color(this.note.error ? t.ansi1 : t.ansi2)
        .child(div().flex_1().child(this.note.text)).child(button("note-close", "×", t, (_e, cx) => { this.note = null; cx.notify(); }))))
      .children([body].flat())
      .when(this.view === "changes" && !this.menu && Boolean(this.root), (e) => e.child(this.commitBox(t)));
  }
}
