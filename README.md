# my-herdr-app

A layout for [herdr-app](https://herdr.dev) (the desktop app) that works like the
Fork git client around your chat pane. It is the desktop version of
[my-herdr](https://github.com/SeniolisFrame/my-herdr), the plugin for the herdr TUI:

```
 Files            │ chat (your agent) │ Changes
 file tree, edit, │                   │ stage files or hunks, commit,
 search, blame,   │                   │ branches, merge, pull, push,
 history          │                   │ stash, history graph
```

Both panels follow the focused pane's folder. These are native herdr-app panels
(GPUI), so Thai text renders correctly, the mouse works everywhere, and files open
in a real editor.

## Install

You need herdr-app (0.1.16 or newer) and git. On Windows:

```
git clone https://github.com/SeniolisFrame/my-herdr-app
cd my-herdr-app
powershell -ExecutionPolicy Bypass -File install.ps1
```

`install.ps1` copies `mods/my-files` and `mods/my-changes` into
`~/.config/herdr-app/mods`, copies `layouts/my-herdr.json`, checks both mods and
switches to the layout. Your own layouts stay as they were: `ctrl+shift+L` cycles
layouts. Run `install.ps1` again after a pull or an edit (herdr-app reloads the
copied files at once). `uninstall.ps1` removes everything and goes back to `main`.

## Use

### Files (left)

- Click a folder to open it, a file to edit it. `ctrl+s` saves, `ctrl+f` finds in
  the file, `←` closes it (it asks first when there are unsaved edits), `esc`
  goes to the chat.
  Files keep their line endings (CRLF stays CRLF). Files over 400 KB and files on
  other machines open read-only.
- Tab-indented files (Go) show their tabs as 4 spaces (the editor draws a tab as
  nothing) and are saved with tabs again.
- **Search all files** (`/`): every text file, tracked or not; click a hit to open
  the file at that line.
- **Replace**: after a search, type the new text under it and **Replace all**, or
  **Replace** on one hit. It replaces the search text (any case) on the matched
  lines only, and skips a file that changed since the search.
- **Blame**: who changed each line; click a line to see that commit's change.
- **History**: the file's commits; click one to see its change.
- **@ chat** or right-click a file: types `@path ` into the chat (the agent in
  this tab, else the focused terminal) without Enter. It goes through the
  clipboard and puts your clipboard back. Dragging a file onto a terminal pastes
  its full path.
- A letter shows git status: `M` modified, `A` new, `D` deleted, `U` conflict.

### Changes (right)

- Tick the box of a file to stage or unstage it (`✓` staged, `~` partly staged).
  **Stage all** / **Unstage all**.
- Click a file to see its diff. Each hunk has a **Stage hunk** / **Unstage hunk**
  button.
- **Discard** throws away the file's changes (click twice).
- Type a message and **Commit** (commits what is staged). During a merge an empty
  message uses git's merge message.
- **⎇ branch**: check out a local or remote branch, create one, or **Merge into
  current**. **Fetch**, **Pull**, **Push** (a new branch is pushed to `origin`),
  **Stash** (untracked files too), **Pop**.
- Conflicts: the file shows `!` and its text with the conflict markers. Take
  **Ours** or **Theirs**, or edit it in Files and click **Mark resolved**; then
  Commit. **Abort merge** undoes the merge.
- **History**: the graph of all branches, drawn like Fork: one color per line,
  curves where branches split and merge, branch labels (the current branch filled,
  remote branches outlined in the line's color, tags in yellow), a hollow dot for merge commits. Click
  a commit for its actions: **View changes**, **Checkout** or **Merge into
  current** for each branch on it (a commit with no branch: check it out without a
  branch, or merge it), **Copy hash**. Double-click opens its changes.

Keys when the panel has focus: `↑` `↓` select, `space` stage, `c` commit message,
`l` history, `s` send `@path`, `esc` back (or to the chat).

### Commands

Both panels take commands, so you can bind keys in `~/.config/herdr-app/keys.json`
or script them: `herdr-app do my-changes.pull`.

- `my-files.<cmd>`: `open:<path>[:<line>]`, `save`, `close`, `find:<text>`, `search:<text>`, `replace-all:<text>`, `blame`,
  `history`, `send[:<path>]`, `type:<text>`
- `my-changes.<cmd>`: `select:<path>`, `stage`, `stage-all`, `unstage-all`,
  `hunk:<n>`, `discard`, `ours`, `theirs`, `commit[:<message>]`, `fetch`, `pull`,
  `push`, `stash`, `pop`, `abort`, `branches`, `checkout:<branch>`,
  `merge:<branch>`, `new-branch:<name>`, `history`, `pick:<hash>`, `show:<hash>`

Example `keys.json` section:

```json
"mod:my-changes": { "ctrl-enter": "my-changes.commit", "alt-p": "my-changes.push" }
```

## Known limits

- Hunk staging works on files that already have a commit; a hunk that is only
  partly staged can't be toggled (stage or unstage the whole file instead).
- git runs without a terminal: pull and push need credentials that don't prompt in
  a terminal (Git Credential Manager, ssh-agent).
- Sending `@path` and saving files work on this computer only.

## Code

| Path | What |
| --- | --- |
| `mods/my-files/main.js` | Files: tree, editor, search, blame, history, send |
| `mods/my-changes/main.js` | Changes: status, diff, stage, commit, branches, history |
| `mods/my-files/text.js` | tab ↔ space indents and replace-on-lines (test: `node mods/my-files/text.test.mjs`) |
| `mods/my-changes/graph.js` | history graph lanes (test: `node mods/my-changes/graph.test.mjs`) |
| `mods/*/common.js` | shared helpers (same file in both mods: a mod can't import another's) |
| `layouts/my-herdr.json` | herdr's `main` layout with Files left and Changes right |
| `install.ps1`, `uninstall.ps1` | copy into / remove from `~/.config/herdr-app` |

Check a mod after editing: `herdr-app check ~/.config/herdr-app/mods/my-files`.
