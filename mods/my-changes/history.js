// Changes: the History graph and a commit's changes.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { settings } from "herdr";
import { READ, git, toLines, diffRows, button, textInput } from "./common.js";
import { layoutGraph } from "./graph.js";
import { MAX_LINES, LOG_PAGE } from "./status.js";

// git log (LOG_FORMAT) → commits with their refs and graph lanes.
export const LOG_FORMAT = "--format=%H%x01%P%x01%h%x01%D%x01%s%x01%an%x01%ar";
export function parseLog(out) {
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
export const LANE = 14, ROW = 28, PAD = 8, HALF = ROW / 2, MAX_LANES = 12;
export const laneX = (k) => PAD + k * LANE + LANE / 2;

// One half-row line: straight down, or a rounded bend between two lanes.
export function graphLine([from, to, color], half, paint) {
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

export const historyMethods = {
  // The history is read ahead (when the repo first shows) and kept: opening it reads
  // nothing. It is read again after an action that changes it, and on Sync.
  openLog(cx) {
    if (this.view !== "changes") { this.view = "changes"; cx.notify(); return; }
    if (!this.root) return;
    this.view = "log"; this.picked = null; this.logShown = LOG_PAGE;
    if (this.logRoot !== this.root) this.loadLog(cx);
    cx.notify();
  },

  // The newest read wins: one started before a commit must not land after the one started after it.
  loadLog(cx) {
    const root = this.root, on = this.on, token = this.logToken = {};
    if (!root) return;
    cx.spawn(async (cx) => {
      let log;
      try { log = parseLog(await git(root, on, [...READ, "log", "--all", "--date-order", "--decorate=full", "-n", "500", LOG_FORMAT])); }
      catch (e) { log = []; if (this.root === root) this.note = { text: String(e.message ?? e), error: true }; }
      if (this.logToken === token && this.root === root) { this.log = log; this.logRoot = root; } // else newer read, or another repo now
      cx.notify();
    });
  },

  sync(cx) { this.refresh(cx); this.loadLog(cx); },

  // What the picked commit offers, only after a right-click: none sit one stray click away.
  logActions(c, t) {
    const out = [], danger = [];
    const branches = [...c.refs.local.map((b) => [b, false]), ...c.refs.remote.filter((r) => !c.refs.local.includes(r.replace(/^[^/]+\//, ""))).map((b) => [b, true])];
    for (const [b, remote] of branches) {
      if (b === this.branch) continue;
      out.push(button(`log-co-${b}`, `Checkout ${b}`, t, (_e, cx) => this.checkout(b, remote, cx)));
      danger.push(button(`log-merge-${b}`, `Merge ${b} into ${this.branch}`, t, (_e, cx) => this.merge(b, cx)));
      const del = this.confirm?.branch === b ? (this.confirm.force ? `Force delete ${b}` : `Delete ${b}? click again`) : `Delete ${b}`;
      if (!remote) danger.push(button(`log-del-${b}`, del, t, (_e, cx) => this.deleteBranch(b, cx), { danger: true }));
    }
    if (!branches.length && !c.refs.head) {
      out.push(button("log-co-commit", "Checkout commit", t, (_e, cx) => this.act("Checkout", async () => { await this.git(["switch", "--detach", c.hash]); return `On ${c.short} (no branch)`; }, cx)));
      danger.push(button("log-merge-commit", `Merge into ${this.branch}`, t, (_e, cx) => this.merge(c.hash, cx)));
    }
    if (!c.refs.head) danger.push(button("log-cherry", `Cherry-pick onto ${this.branch}`, t, (_e, cx) => this.cherryPick(c.hash, cx)));
    danger.push(button("log-revert", "Revert", t, (_e, cx) => this.revert(c, cx)));
    // Not mid merge/cherry-pick/revert: a reset there drops it and leaves the conflict markers.
    if (!c.refs.head && this.branch && !this.inProgress) danger.push(button("log-reset", this.confirm?.reset === c.hash ? `Reset ${this.branch} here? click again` : `Reset ${this.branch} here`, t,
      (_e, cx) => this.reset(c, cx), { danger: true }));
    return [button("log-view", "View changes", t, (_e, cx) => this.showCommit(c.hash, cx)), ...out,
      button("log-copy", "Copy hash", t, (_e, cx) => { cx.write_to_clipboard(c.hash); this.note = { text: `Copied ${c.short}` }; cx.notify(); }), ...danger];
  },

  showCommit(hash, cx) {
    this.view = "commit"; this.shown = hash; this.commitRows = this.commits.get(hash) ?? null;
    if (!this.commitRows) this.readCommit(hash, cx);
    cx.notify();
  },

  // A commit never changes: each one is read once (the last 50 kept). Picking a commit
  // reads it ahead, so View changes shows at once.
  readCommit(hash, cx) {
    if (this.commits.has(hash) || this.reading === hash) return;
    const commits = this.commits, root = this.root, on = this.on;
    this.reading = hash;
    cx.spawn(async (cx) => {
      let rows;
      try {
        const out = await git(root, on, [...READ, "show", "--format=%h  %an, %ar%n%n%B", "--no-color", "--no-ext-diff", "-M", "-m", "--first-parent", hash]);
        rows = diffRows(toLines(out).slice(0, MAX_LINES * 3));
        commits.set(hash, rows);
        if (commits.size > 50) commits.delete(commits.keys().next().value);
      } catch (e) { rows = diffRows([String(e.message ?? e)]); }
      if (this.reading === hash) this.reading = null;
      if (this.shown === hash && this.commits === commits) this.commitRows = rows;
      cx.notify();
    });
  },

  logView(t) {
    if (!this.log) return [div().p(12).text_color(t.dim).child("Loading history…")];
    const palette = [t.ansi4, t.ansi2, t.ansi5, t.ansi3, t.ansi6, t.ansi1, t.ansi12, t.ansi10], paint = (n) => palette[n % palette.length];
    const q = this.logQuery;
    // A search shows the matching commits only, so their lines would join the wrong rows: no graph then.
    const rows = q ? this.log.filter((r) => [r.subject, r.hash, r.author, ...r.refs.local, ...r.refs.remote, ...r.refs.tags].some((s) => s.toLowerCase().includes(q))) : this.log;
    const width = q ? 0 : PAD * 2 + LANE * Math.min(MAX_LANES, Math.max(1, ...this.log.map((r) => r.width)));
    const shown = (l) => Math.min(l[0], l[1]) < MAX_LANES; // lines further right are cut off: not built
    const picked = this.log.find((r) => r.hash === this.picked);
    const pill = (id, text, fg, bg, border) => div().id(id).flex_none().h(18).px(6).flex().items_center().rounded(9).text_size(11)
      .text_color(fg).bg(bg).when(Boolean(border), (e) => e.border_1().border_color(border)).child(text);
    const row = (r) => {
      const c = paint(r.color), x = laneX(r.col), merge = r.parents.length > 1;
      return h_flex().id(`log-${r.hash}`).w_full().h(ROW).flex_none().pr(10).gap(6).items_center().cursor_pointer()
        .when(this.picked === r.hash, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
        .on_click((e, cx) => { if (e.click_count > 1) this.showCommit(r.hash, cx); else { this.picked = r.hash; this.riskyFor = null; this.confirm = null; this.readCommit(r.hash, cx); cx.notify(); } })
        .on_mouse_down("right", (_e, cx) => { this.picked = this.riskyFor = r.hash; this.confirm = null; cx.notify(); })
        .when(!q, (e) => e.child(div().relative().flex_none().w(width).h(ROW).overflow_hidden()
          .children(r.top.filter(shown).map((l) => graphLine(l, "top", paint)))
          .children(r.bottom.filter(shown).map((l) => graphLine(l, "bottom", paint)))
          .child(div().absolute().left(x - 5).top(HALF - 5).w(10).h(10).rounded(5).border_2().border_color(r.refs.head ? t.foreground : c).bg(merge ? t.background : c))))
        .when(Boolean(q), (e) => e.child(div().flex_none().pl(10).text_color(t.dim).font_family(settings().font_family ?? "JetBrains Mono").child(r.short)))
        .children(r.refs.local.map((b) => pill(`ref-${r.hash}-${b}`, b, b === this.branch ? t.background : c, b === this.branch ? c : c + "26")))
        .children(r.refs.remote.map((b) => pill(`ref-${r.hash}-${b}`, b, c, c + "14", c + "80")))
        .children(r.refs.tags.map((b) => pill(`tag-${r.hash}-${b}`, b, t.ansi3, t.ansi3 + "1f")))
        .child(div().flex_1().min_w(0).truncate().text_color(merge ? t.muted : t.foreground).child(r.subject))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(`${r.author} · ${r.when}`));
    };
    return [
      h_flex().flex_none().px(10).pt(6).child(textInput("log-search", this.logSearch, this.typing === "log", t)),
      h_flex().flex_none().px(10).py(6).gap(5).items_center().flex_wrap().border_b(1).border_color(t.border).text_size(12)
        .child(div().text_color(t.dim).child(q ? `${rows.length} of the last 500 commits` : "Right-click a commit for its actions · double-click: its changes")),
      // A page at a time: every row and graph line is drawn again on each redraw of the window.
      // The right-clicked commit's actions open in a row just under it, like the Files menu.
      v_flex().id("log").flex_1().min_h(0).overflow_y_scrollbar().text_size(12)
        .children(rows.slice(0, this.logShown).flatMap((r) => r.hash === this.riskyFor && picked?.hash === r.hash
          ? [row(r), v_flex().id("log-menu").flex_none().mx(6).px(8).py(4).gap(2).items_start().rounded(6).bg(t.raised)
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).children(this.logActions(r, t))]
          : [row(r)]))
        .when(rows.length > this.logShown, (e) => e.child(h_flex().flex_none().p(8).justify_center()
          .child(button("log-more", `Show ${Math.min(LOG_PAGE, rows.length - this.logShown)} more (${rows.length - this.logShown} left)`, t,
            (_e, cx) => { this.logShown += LOG_PAGE; cx.notify(); })))),
    ];
  },
};
