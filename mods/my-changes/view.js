// Changes: drawing the lists, the diff, the toolbar, the branch menu and the commit box.
import { div } from "gpui-kit";
import { v_flex, h_flex, Input, Scrollbar } from "gpui-base";
import { settings } from "herdr";
import { diffRow, button, iconButton, buttonGroup, textInput, lazyRows } from "./common.js";

export const viewMethods = {
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
  },

  // One list (Unstaged or Staged) with its header and all-button, at most 6 rows high.
  fileList(side, t) {
    const items = this.items().filter((x) => x.side === side), staged = side === "staged";
    return [
      h_flex().flex_none().px(10).pt(6).pb(2).gap(6).items_center().text_size(11).text_color(t.dim)
        .child(div().flex_1().font_semibold().child(`${staged ? "Staged" : "Unstaged"} · ${items.length}`))
        .child(staged ? button("unstage-all", "Unstage all", t, (_e, cx) => this.unstageAll(cx), { enabled: !this.busy && items.length > 0 })
          : h_flex().gap(6)
            .child(button("discard-all", this.confirm?.all ? "Discard all? click again" : "Discard all", t, (_e, cx) => this.discardAll(cx), { danger: true, enabled: !this.busy && items.length > 0 }))
            .child(button("stage-all", "Stage all", t, (_e, cx) => this.stageAll(cx), { enabled: !this.busy && items.length > 0 }))),
      div().flex_none().h(Math.min(Math.max(items.length, 1) * 26 + 4, 160)).relative()
        .child(v_flex().id(`list-${side}`).absolute().inset_0().overflow_y_scroll().px(6).children(items.map((x) => this.fileRow(x, t)))
          .when(!items.length, (e) => e.child(div().px(6).py(4).text_size(12).text_color(t.dim).child(staged ? "Nothing staged" : "No changes"))))
        .child(Scrollbar.vertical(`list-${side}`).absolute().inset_0()),
    ];
  },

  // "Stage hunk", "Unstage 2 lines": the hunk menu's first item for hunk n.
  hunkAction(n) {
    const lines = this.chosenIn(n).size, what = lines ? `${lines} line${lines > 1 ? "s" : ""}` : "hunk";
    return { what, stage: `${this.sel?.side === "staged" ? "Unstage" : "Stage"} ${what}` };
  },

  // A list builds only the rows on screen and a row takes one click: a click on a "+" or "-"
  // line picks it, a right-click there opens Stage / Discard for its hunk.
  diffView(id, rows, t, withHunks) {
    const font = settings().font_family ?? "JetBrains Mono";
    if (!withHunks || !this.raw) return lazyRows(id, rows.length, (i) => diffRow(rows[i], t), { font });
    const opts = { picked: (r) => this.chosen.has(`${r.hunk}:${r.pos}`) };
    const m = this.hunkMenu;
    return lazyRows(id, rows.length, (i) => diffRow(rows[i], t, opts), { font,
      // pickLine ignores all but "+" / "-" lines; an open menu closes itself on any press outside it.
      click: (i, cx) => this.pickLine(rows[i], cx),
      rightClick: (i, _e, cx) => { const r = rows[i]; this.confirm = null; this.hunkMenu = r.kind === "+" || r.kind === "-" ? { hunk: r.hunk } : null; cx.notify(); },
    })
      // The row's right-click comes first; this one, on the box, says where to open the menu.
      .on_mouse_down("right", (e, cx) => {
        const h = this.hunkMenu, p = e.local_position, b = e.bounds;
        if (h && h.x === undefined && p && b) { h.x = Math.max(0, Math.min(p.x, b.width - 200)); h.y = Math.max(0, Math.min(p.y, b.height - 64)); cx.notify(); }
      })
      .when(Boolean(m && m.x !== undefined), (e) => e.child(this.hunkMenuView(m, t)));
  },

  hunkMenuView(m, t) {
    const a = this.hunkAction(m.hunk), asking = this.confirm?.hunk === m.hunk;
    return v_flex().id("hunk-menu").absolute().left(m.x).top(m.y).p(4).gap(2).items_start().rounded(6).bg(t.raised).border_1().border_color(t.border)
      .on_mouse_down_out((_e, cx) => { this.hunkMenu = null; this.confirm = null; cx.notify(); })
      .child(button("hunk-stage", a.stage, t, (_e, cx) => { this.hunkMenu = null; this.applyHunk(m.hunk, cx); }).w_full())
      // Asks twice, as before: the first click turns it into "click again".
      .when(this.sel?.side !== "staged", (e) => e.child(button("hunk-discard", asking ? `Discard ${a.what}? click again` : `Discard ${a.what}`, t,
        (_e, cx) => { if (asking) this.hunkMenu = null; this.discardHunk(m.hunk, cx); }, { danger: true }).w_full()));
  },

  // Changes | History, side by side across the whole panel; the picked one underlined.
  tabs(t) {
    const count = this.items().length;
    const tab = (id, label, active, onClick, badge) => div().id(`tab-${id}`).flex_1().h_full().flex().items_center().justify_center().gap(6)
      .cursor_pointer().border_b(2).border_color(active ? t.accent : t.background).text_color(active ? t.foreground : t.dim)
      .when(active, (e) => e.font_semibold()).when(!active, (e) => e.hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .on_click(onClick).child(label)
      .when(Boolean(badge), (e) => e.child(div().px(6).rounded(8).bg(t.raised).text_size(11).text_color(t.muted).child(String(badge))));
    const onLog = this.view !== "changes" && !this.menu;
    return h_flex().h(40).flex_none().border_b(1).border_color(t.border)
      .child(tab("changes", "Changes", !onLog, (_e, cx) => { this.view = "changes"; this.menu = null; cx.notify(); }, count))
      .child(tab("history", "History", onLog, (_e, cx) => { this.menu = null; if (this.view === "changes") this.openLog(cx); else { this.view = "log"; cx.notify(); } }));
  },

  toolbar(t) {
    const tool = (id, name, onClick, opts) => iconButton(id, `mods/my-changes/icon-${id}.svg`, name, t, onClick, { iconOnly: !this.wide, ...opts });
    const busy = Boolean(this.busy), track = this.track ? ` ${this.track.replace(/ahead /, "↑").replace(/behind /, "↓").replace(", ", " ")}` : "";
    return h_flex().flex_none().px(10).py(6).gap(5).items_center().border_b(1).border_color(t.border).flex_wrap()
      .child(button("branch", `⎇ ${this.branch ?? "…"}${track} ▾`, t, (_e, cx) => this.openBranches(cx), { active: Boolean(this.menu) }))
      .when(Boolean(this.inProgress), (e) => e.child(div().px(6).rounded(4).bg(t.blocked).text_color(t.background).text_size(11).child(this.inProgress.toUpperCase()))
        .child(button("abort", `Abort ${this.inProgress}`, t, (_e, cx) => this.abort(cx), { danger: true })))
      .child(div().flex_1())
      .when(busy, (e) => e.child(div().text_size(11).text_color(t.dim).child(`${this.busy}…`)))
      .child(tool("sync", "Sync", (_e, cx) => this.sync(cx), { enabled: !this.loading, iconOnly: true }))
      .child(buttonGroup(t, [
        tool("fetch", "Fetch", (_e, cx) => this.fetch(cx), { enabled: !busy }),
        tool("pull", "Pull", (_e, cx) => this.pull(cx), { enabled: !busy }),
        tool("push", "Push", (_e, cx) => this.push(cx), { enabled: !busy })]))
      .child(buttonGroup(t, [
        tool("stash", "Stash", (_e, cx) => this.stash(cx), { enabled: !busy && this.files.length > 0 }),
        tool("pop", "Pop", (_e, cx) => this.pop(cx), { enabled: !busy })]))
      // Too narrow for the names: icons only (each keeps its name as a tooltip).
      .id("toolbar").on_size_change(({ width }, cx) => { const wide = width >= 520; if (wide !== this.wide) { this.wide = wide; cx.notify(); } });
  },

  branchMenu(t) {
    const m = this.menu, row = (name, isRemote) => h_flex().id(`br-${isRemote ? "r" : "l"}-${name}`).h(26).flex_none().px(8).gap(6).items_center().rounded(6)
      .hover((s) => s.bg(t.hover)).cursor_pointer().on_click((_e, cx) => name !== this.branch && this.checkout(name, isRemote, cx))
      .child(div().flex_1().min_w(0).truncate().text_color(name === this.branch ? t.accent : t.foreground).child(`${name === this.branch ? "● " : ""}${name}`))
      // Merge only after a right-click on the row, never one click from a checkout.
      .on_mouse_down("right", (_e, cx) => { this.mergeFor = name; cx.notify(); })
      .when(name !== this.branch && this.mergeFor === name, (e) => e.child(button(`merge-${name}`, "Merge into current", t, (_e, cx) => this.merge(name, cx))
        .on_mouse_down_out((_e, cx) => { this.mergeFor = null; cx.notify(); }))); // a press anywhere else hides it
    return v_flex().id("branch-menu").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(2)
      .child(h_flex().gap(6).pb(4).child(textInput("branch-input", this.branchName, this.typing === "branch", t))
        .child(button("branch-create", "Create", t, (_e, cx) => this.newBranch(cx), { primary: true })))
      .child(div().px(8).pt(4).text_size(11).text_color(t.dim).child("Local — click to check out"))
      .children(m.local.map((b) => row(b, false)))
      .when(m.remote.length > 0, (e) => e.child(div().px(8).pt(8).text_size(11).text_color(t.dim).child("Remote")).children(m.remote.map((b) => row(b, true))));
  },

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
  },
};
