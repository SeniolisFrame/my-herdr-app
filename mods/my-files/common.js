// Shared by my-files and my-changes: keep mods/my-files/common.js and mods/my-changes/common.js identical
// (a mod can't import from another mod's folder).
import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, focused, agents, exec, run } from "herdr";

// Where the panels look: the focused pane's live folder (as the shipped panels do).
export function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
export const locationKey = () => JSON.stringify(location());

// git that throws with git's own message; READ writes nothing under .git, so the
// folder watch doesn't wake itself up.
export const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
export async function git(root, on, args, timeout) {
  const r = await exec("git", args, { cwd: root, on, timeout });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `git ${args[0]} failed`);
  return r.stdout;
}

// The chat: the agent in the shown tab, else the focused terminal.
export function chatTerminal() {
  const f = focused();
  return agents().find(a => a.tab === f?.tab)?.address ?? f?.terminal ?? null;
}

// Types text into the chat without Enter: through the clipboard (hc send presses
// Enter), which is put back afterwards.
export async function sendToChat(text, cx) {
  const term = chatTerminal();
  if (!term) throw new Error("no chat terminal in this tab");
  const old = cx.read_from_clipboard();
  cx.write_to_clipboard(text);
  run("pane.focus", { terminal: term });
  run("terminal.paste");
  await cx.sleep(300);
  if (old !== undefined) cx.write_to_clipboard(old);
}

// Back to the chat pane (Esc).
export function focusChat() {
  const term = chatTerminal();
  if (term) run("pane.focus", { terminal: term });
}

// Text draws a tab as nothing: pad each to the next 4-column stop.
export const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));

// Numbers each diff line; `hunk` is the hunk's index within its file.
export function diffRows(lines) {
  let old = 0, next = 0, hunk = -1, inHunk = false;
  return lines.map((line) => {
    if (line.startsWith("diff --git ")) { hunk = -1; inHunk = false; return { kind: "file", text: line.replace(/^diff --git a\/(.*) b\/.*$/, "$1") }; }
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; hunk++; inHunk = true; return { kind: "@", hunk, text: line }; }
    const kind = line[0];
    if (!inHunk) return { kind: "", text: line };
    if (kind === "-") return { kind, number: old++, text: untab(line.slice(1)) || " " };
    if (kind === "+") return { kind, number: next++, text: untab(line.slice(1)) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: untab(line.slice(1)) || " " }; }
    return { kind: "", text: line };
  });
}

// One diff row, 20px high; `hunkButton(row)` adds a control on hunk headers.
export function diffRow(row, t, hunkButton) {
  const { kind, number, text } = row;
  if (kind === "file") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.selected).font_semibold().child(text);
  if (kind === "@") return h_flex().w_full().h(20).flex_none().px(12).gap(8).items_center().bg(t.raised).text_color(t.dim)
    .when(Boolean(hunkButton), e => e.child(hunkButton(row))).child(div().flex_1().min_w(0).truncate().child(text));
  return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "22")).when(kind === "-", (e) => e.bg(t.ansi1 + "22"))
    .child(div().w(36).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
    .child(div().flex_1().min_w(0).truncate().text_color(kind === "" ? t.dim : t.foreground).child(text));
}

// A small text button.
export function button(id, label, t, onClick, opts = {}) {
  const on = opts.enabled !== false;
  return div().id(id).h(24).px(8).flex().flex_none().items_center().rounded(6).text_size(12)
    .bg(opts.primary && on ? t.solid : opts.active ? t.selected : t.raised)
    .text_color(!on ? t.dim : opts.primary ? t.solid_foreground : opts.danger ? t.ansi1 : t.foreground)
    .when(on, e => e.cursor_pointer().hover(s => s.bg(opts.primary ? t.solid : t.hover)).on_click((ev, cx) => { cx.stop_propagation(); onClick(ev, cx); }))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .child(label);
}
