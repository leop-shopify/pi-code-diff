# pi-code-diff

Review diffs and edit source without leaving Pi.

- `/diff` opens a focused code-review UI for local changes, revision ranges, and remote pull requests.
- `/code` opens an experimental two-pane workbench for browsing, searching, and editing files.
- Pi’s footer tracks local changes and points you back to `/diff`.

`/diff` is the only review command. `/code` is for source, not reviews.

## Install

```bash
pi install https://github.com/leop-example/pi-code-diff
```

Restart Pi or run `/reload`, then:

```text
/diff
/code
```

The default global review shortcut is `Alt+S`.

## Review with `/diff`

Run `/diff` with no arguments to review the current working tree, including untracked files.

```text
/diff                         # local changes
/diff --whole-repo            # ignore monorepo workspace scoping
/diff --include-generated     # include generated text
/diff main..HEAD              # direct revision range
/diff main...HEAD             # merge-base revision range
/diff remote owner/repo#123   # remote pull request
/diff remote feature-branch   # remote branch
```

<!-- GIF 1: Record the /diff review and annotation workflow here. -->

Choose a scope, move through the files, and leave the right kind of feedback:

| Intent | Use it for | Result |
| --- | --- | --- |
| `DISCUSS` | Questions, rationale, and tradeoffs | Goes to the agent only. It never posts or requests an edit. |
| `COMMENT` | Review feedback | Goes to the agent locally or becomes a remote review comment. |
| `MODIFY` | An exact replacement you already know | Records the source change precisely for the agent or a suggestion. |

A normal local flow is:

1. Run `/diff`.
2. Navigate to the line you care about.
3. Press `d`, `c`, or `m` to discuss, comment, or modify.
4. Press `s` to place the review prompt in Pi’s editor.
5. Read it, adjust it if needed, and send it.

For local working-tree reviews, press `o` on an eligible current-side line to open `/code`. Closing `/code` safely rematerializes the diff and returns to the saved review. Press `e` to use `$EDITOR` instead.

### Review keys

| Key | Action |
| --- | --- |
| `↑/↓` or `j/k` | Move through files, lines, or comments |
| `Tab` / `Shift+Tab` | Change pane |
| `1` / `2` / `3` / `4` | Toggle Navigator, Diff, Comments, or PR context |
| `v` | Toggle unified and side-by-side diff |
| `/`, then `n` / `N` | Search and move between matches |
| `Shift+↑/↓` | Select a multiline range on one diff side |
| `d` / `c` / `m` | Add a DISCUSS, COMMENT, or MODIFY annotation |
| `l` / `a` | Add a file or all-lines annotation |
| `o` / `e` | Open the location in `/code` or `$EDITOR` |
| `s` | Finish a local review and stage its prompt |
| `?` | Show the complete in-app help |
| `Esc` or `Ctrl+C` | Close safely; unsaved feedback is confirmed first |

## Browse and edit with `/code`

`/code` works inside or outside Git repositories. Git adds read-only context when available, but Git failure never blocks the workbench.

The Explorer is on the left. Source is on the right. Open a file, edit the complete buffer, and save it as an ordinary working-tree change. `/code` never stages, commits, pushes, or mutates Git refs.

<!-- GIF 2: Record the /code browse, edit, save, and return-to-diff workflow here. -->

### Workbench keys

| Key | Action |
| --- | --- |
| `↑/↓` or `j/k` | Move through Explorer rows or source lines |
| `Enter` | Open a file, toggle a folder, or enter INSERT from SOURCE |
| `←/→` or `h/l` | Collapse or expand folders |
| `Tab` / `Shift+Tab` | Switch between Explorer and Source |
| `Command+P` | Find a file (`Shift+Command+P` is also accepted when forwarded) |
| `/` | Find a file from Explorer or text in the open buffer from Source |
| `Ctrl+F` | Search workspace text |
| `@` | Search heuristic symbols |
| `Ctrl+G` | Toggle read-only Git context |
| `i`, `I`, or `Ctrl+E` | Enter INSERT |
| `Shift+arrows` | Select text in INSERT |
| `Option+←/→` | Move by word; add `Shift` to select by word |
| `Command+A/C/X/V` | Select all, copy, cut, and paste |
| `Ctrl+Z` | Undo |
| `Ctrl+S` | Save |
| `Esc` | INSERT → NORMAL → Explorer → safe close |

Clipboard shortcuts work when the terminal forwards them; `Ctrl+Shift+C` is the copy fallback.

Edits preserve line endings, literal tabs, trailing newlines, and untouched bytes. Switching files or closing with a dirty buffer asks you to **Save**, **Discard**, or **Cancel**.

The detailed workbench reference lives in [`docs/workbench.md`](docs/workbench.md).

## Remote reviews

`/diff remote` accepts GitHub, stack-host, and review-host pull-request URLs, `owner/repo#number`, or a remote branch.

GitHub and provider reviews can be submitted from the UI as:

- **Approve**
- **Request changes**
- **Post Comments**
- **Start discussion with agents**

The confirmed review text receives a grammar pass. Meaning-preserving corrections can be applied automatically; anything that may alter intent, tone, technical meaning, or scope requires an explicit decision. Invalid model output fails closed.

`DISCUSS` items never post remotely. Self-approval is refused. provider verifies the reviewed base and head immediately before its atomic submission. If a remote target changes during an agent discussion, the old line mappings are not reused.

A remote URL does not require an existing checkout. pi-code-diff can use its global cache, or you can map the repository to a local workspace in configuration.

## Agent tools

Agents can open the same interfaces directly:

- `open_code_diff` is the agent-facing review tool for `/diff` targets. Empty arguments review uncommitted local changes; you do not need to commit first.
- `open_code` is the agent-facing workbench tool. It accepts structured `cwd`, an optional `{ path, range, anchor }` target, and ordered code stories; it is a tool schema, not a documentation skill.
- `submit_pr_review` submits a confirmed GitHub or provider review.

Direct commands may stage the next prompt in Pi’s editor. Tool calls return their result to the waiting agent instead.

## Configuration

Optional configuration lives at:

```text
~/.pi/agent/extensions/code-diff.json
```

Example:

```json
{
  "version": 1,
  "globalShortcut": "ctrl+alt+r",
  "repositories": {
    "owner/repo": {
      "cwd": "/absolute/path/to/checkout",
      "subdir": "packages/app",
      "pathspecs": ["packages/app", "shared/ui"],
      "importAliases": {
        "@workspace/shared": "shared/ui"
      }
    }
  }
}
```

Run `/reload` after changing the global shortcut.

## Standalone workbench

The experimental workbench can run outside Pi with Node 22.19 or newer. The package installation supplies the dependencies used by the standalone build:

```bash
pnpm workbench:build
pnpm workbench:start /path/to/workspace
```

The build installs the launcher at `~/.pi/agent/bin/pi-code-workbench` and keeps generated runtime files under `~/.pi/agent/cache/pi-code-diff/workbench/`. It does not create build or cache directories inside this checkout or an opened workspace.

## Local development

```bash
pi install /absolute/path/to/pi-code-diff
pnpm typecheck
pnpm test
```

Pi loads `src/index.ts` directly, so extension changes only need `/reload`.

Inspired by Mario Zechner’s [pi-diff-review](https://github.com/badlogic/pi-diff-review).
