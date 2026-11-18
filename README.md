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

- Click a folder to open it, a file to edit it. A folder opened once (and the
  folders inside the one you open) shows at once next time. `ctrl+s` saves, `←` closes it (it
  asks first when there are unsaved edits), `esc` goes to the chat.
  Files keep their line endings (CRLF stays CRLF). When the open file changes on disk
  (a discard in Changes, the chat editing it), it shows the new text, unless you
  have unsaved edits: Save then refuses, so nothing is overwritten. Files over 400 KB and files on
  other machines open read-only.
- `ctrl+f` finds in the file. `ctrl+h` (or **Replace**) adds a replace box:
  **Next** replaces the found text under the cursor and finds the next one,
  **All** replaces every one in the file (then Save).
- Tab-indented files (Go) show their tabs as 4 spaces (the editor draws a tab as
  nothing) and are saved with tabs again.
- **Search all files** (`/`): every text file, tracked or not; click a hit to open
  the file at that line.
- **Replace across files**: after a search, type the new text under it and
  **Replace all**, or **Replace** on one hit. It replaces the search text (any
  case) on the matched lines only, and skips a file that changed since the search
  or is over 400 KB.
- **Right-click** a file or folder: **@ chat**, **New file**, **New folder**,
  **Rename**, **Delete** (click twice). **+** in the header does New file / New
  folder in the top folder. On this computer only.
- **Blame**: who changed each line; click a line to see that commit's change.
- **History**: the file's commits; click one to see its change.
- **@ chat** types `@path ` into the chat (the agent in this tab, else the focused
  terminal) without Enter. It goes through the clipboard and puts your clipboard
  back. Dragging a file onto a terminal pastes its full path.
- A letter shows git status: `M` modified, `A` new, `D` deleted, `U` conflict.

### Changes (right)

- Stage, unstage and commit move the files at once, like Fork; git catches up
  behind (and puts them back if it refuses: a failed commit keeps its message).
  Every file's diff is read with the list, so clicking a file shows it at once.
- Two lists, like Fork: **Unstaged** and **Staged**. A file that is partly staged
  is in both. The box moves a file from one list to the other; **Stage all** /
  **Unstage all**.
- Click a file to see its diff: an unstaged file shows what isn't staged yet, a
  staged one shows what is. Each hunk has **Stage hunk** (or **Unstage hunk**).
  Click `+` / `-` lines to pick them: the button becomes **Stage 2 lines** and
  stages only those. **Discard hunk** (or **Discard 2 lines**, click twice) throws
  them out of the file; what is staged stays, and the file keeps its line endings.
- **Open** (or double-click the file) opens it in Files. **Discard** throws away
  the file's changes (click twice).
- Type a message and **Commit** (commits what is staged).
  - **Amend**: the next Commit rewrites the last commit; its message is filled in
    to edit, and whatever is staged goes into it too.
  - **Undo last commit** (click twice): the last commit's changes go back to
    Staged and its message back in the box. It warns when that commit is already
    pushed.
  - **Ask chat to write it**: types a request into the chat for the agent to read
    the staged diff and save a message to `.git/MY_HERDR_COMMIT_MSG`. Press Enter
    in the chat; the message shows up in the box when the agent saves it.
- **⎇ branch**: check out a local or remote branch, create one, or **Merge into
  current**. **Fetch**, **Pull**, **Push** (a new branch is pushed to `origin`),
  **Stash** (untracked files too), **Pop**.
- Conflicts (after a merge, pull, stash pop, cherry-pick or revert): the file shows
  `!` and its text with the conflict markers. Take **Ours** or **Theirs**, or edit
  it in Files and click **Mark resolved**; then Commit (an empty message uses
  git's). **Abort** undoes the whole operation.
- **History**: the graph of all branches, drawn like Fork: one color per line,
  curves where branches split and merge, branch labels (the current branch filled,
  remote branches outlined in the line's color, tags in yellow), a hollow dot for
  merge commits. The search box filters the last 500 commits by message, hash,
  author or branch. Click a commit for its actions: **View changes**, **Checkout**,
  **Merge … into** and **Delete** for each branch on it (a branch with commits no
  other branch has asks again as **Force delete**), **Checkout commit** / **Merge**
  for a commit with no branch, **Cherry-pick onto** the current branch, **Revert**,
  **Copy hash**. Double-click opens its changes.

Both panels update when files change in the folder (and after their own actions);
there is no timer. **Sync** reads everything again.

Keys when the panel has focus: `↑` `↓` select, `space` stage or unstage, `o` open
in Files, `c` commit message, `l` history, `s` send `@path`, `esc` back (or to the
chat).

### Commands

Both panels take commands, so you can bind keys in `~/.config/herdr-app/keys.json`
or script them: `herdr-app do my-changes.pull`.

- `my-files.<cmd>`: `sync`, `toggle:<folder>`, `open:<path>[:<line>]`, `save`, `close`, `find:<text>`,
  `replace-in-file:<text>|<new>`, `search:<text>`, `replace-all:<new>`, `blame`,
  `history`, `send[:<path>]`, `type:<text>`, `menu:<path>` then `new-file:<name>`,
  `new-folder:<name>`, `rename:<name>` or `delete` (twice)
- `my-changes.<cmd>`: `sync`, `select:<path>` (or `select:staged:<path>` /
  `select:unstaged:<path>`), `stage`, `stage-all`, `unstage-all`, `hunk:<n>`,
  `discard-hunk:<n>` (twice), `line:<hunk>:<line>`, `discard`, `open`, `ours`, `theirs`, `commit[:<message>]`,
  `amend`, `undo` (twice), `ask`, `fetch`, `pull`, `push`, `stash`, `pop`, `abort`,
  `branches`, `checkout:<branch>`, `merge:<branch>`, `new-branch:<name>`,
  `delete-branch:<name>` (twice), `history`, `log-search:<text>`, `pick:<hash>`,
  `show:<hash>`, `cherry-pick:<hash>`, `revert:<hash>`

Example `keys.json` section:

```json
"mod:my-changes": { "ctrl-enter": "my-changes.commit", "alt-p": "my-changes.push" }
```

## Known limits

- Staging hunks and lines, saving, file actions and sending `@path` work on this
  computer only (not in a space on another machine).
- git runs without a terminal: pull and push need credentials that don't prompt in
  a terminal (Git Credential Manager, ssh-agent).
- History shows the last 500 commits; its search looks in those.
- On Windows every git and folder listing starts a program, which costs 0.3 s to
  2 s on some machines: the panels show what they expect first and read in the
  background, but an action still waits for its own git.
## Code

| Path | What |
| --- | --- |
| `mods/my-files/main.js` | Files: tree, editor, search, blame, history, send |
| `mods/my-changes/main.js` | Changes: status, diff, stage, commit, branches, history |
| `mods/my-files/text.js` | tab ↔ space indents and replacing text (test: `node mods/my-files/text.test.mjs`) |
| `mods/my-changes/patch.js` | patches for staging hunks and single lines (test: `node mods/my-changes/patch.test.mjs`) |
| `mods/my-changes/graph.js` | history graph lanes (test: `node mods/my-changes/graph.test.mjs`) |
| `mods/*/common.js` | shared helpers (same file in both mods: a mod can't import another's) |
| `layouts/my-herdr.json` | herdr's `main` layout with Files left and Changes right |
| `install.ps1`, `uninstall.ps1` | copy into / remove from `~/.config/herdr-app` |

Check a mod after editing: `herdr-app check ~/.config/herdr-app/mods/my-files`.
