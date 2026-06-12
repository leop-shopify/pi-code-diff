# pi-code-diff

`/diff`, `/code`, and `/code-diff` open a terminal-native review and annotation surface for Pi.

It is inspired by Mario Zechner's [pi-diff-review](https://github.com/badlogic/pi-diff-review).

It lets you stop after an agent turn, walk the diff inside Pi, add fast line/file/whole-change annotations, and send that feedback back to the agent as a clean prompt in the editor.

The goal is simple: keep terminal-based review within Pi, keep annotations precise, and make it easy to separate edits you want applied from comments you want posted and things you want explained.

## Summary

Use `/diff`, `/code`, or `/code-diff` when you want to review and annotate work before sending the agent another turn.

It supports three review scopes:

- `git diff`
- `last commit`
- `all files`

Inside the review UI you can:

- move through files and hunks quickly
- review changes in unified or side-by-side diff view
- annotate **added** and **deleted** lines, including multiline ranges on one diff side
- leave **file-level** annotations
- leave a **whole-change** note
- mark feedback as either:
  - `DISCUSS` — the agent explains, justifies, or proposes; it never edits code or touches GitHub to satisfy the note
  - `COMMENT` — a real GitHub PR comment when the review is remote; for a local review it becomes a local comment to the agent about the change
  - `MODIFY` — an exact edit you make in place on the line; the agent applies it locally
- insert the resulting review prompt into Pi’s editor

The review UI does **not** auto-send the prompt. It stages the next message for you.

## Quickstart

### Install

```bash
pi install https://github.com/leop-shopify/pi-code-diff
```

Then restart Pi or run `/reload`.

<details>
<summary>Local development</summary>

While iterating on the extension itself, install from a local checkout path:

```bash
pi install /absolute/path/to/pi-code-diff
```

Run `/reload` after changes. Pi loads `src/index.ts` directly through jiti, so there is no build step.
</details>

### Run it

Inside a git repo in Pi:

```text
/diff
```

You can also use the explicit package commands:

```text
/code
/code-diff
```

Or use the global shortcut, which defaults to:

```text
alt+s
```

Configure the shortcut with `globalShortcut` in `~/.pi/agent/extensions/code-diff.json`, then restart Pi or run `/reload`.

### Picking what to review

`/diff` (and `/code`, `/code-diff`) is the single entry point for every kind of review.

- `/diff` with no arguments reviews local changes.
- `/diff remote <url | branch>` reviews a remote branch or GitHub PR. It accepts a remote branch, a GitHub or Graphite PR URL, or `owner/repo#123`.
- `/diff <base>..<head>` (or `base...head`) reviews that custom range.

Local changes open the in-UI scope switcher described below.

### Basic flow

1. Run `/diff`, `/code`, or `/code-diff` for local changes (or pass an argument)
2. Pick a scope:
   - `git diff` — review your current uncommitted working tree changes against `HEAD`
   - `last commit` — review the most recent commit against its parent
   - `all files` — review files changed on the current branch compared with the nearest local parent branch, falling back to the default branch; if there are no changed scopes, falls back to current file contents

   By default, the review UI opens the first scope that makes sense for the repo in this order:
   - `git diff` if there are uncommitted changes
   - otherwise `all files` if the current branch differs from its parent or default branch
   - otherwise `last commit` if there is a reviewable last commit
   - otherwise `all files` as a current-file fallback

   In the branch-level `all files` scope, files are compared against the nearest local ancestor branch when one exists, so stacked branches review only their own layer. If there is no local parent branch, it falls back to the repository default branch. Files are ordered for review priority: changed files referenced by more other changed files come first, then modified/renamed before added before deleted, then source files before tests/docs/changesets, then path order. The navigator can filter to files related to the active file with `r`. In related mode, `→` means the active file references that file, `←` means that file references the active file, and `↔` means both. Press `r` again to return to all files.
3. Move to the file and line you care about; press `v` when you want side-by-side diff view
4. Add annotations:
   - `m` to edit the line in place as a `MODIFY` (the editor opens seeded with the line's code)
   - `c` for a line `COMMENT`
   - `d` for a line `DISCUSS`
   - `l` for a file annotation (a `COMMENT`)
   - `a` for a whole-change note (a `DISCUSS`)
5. Press `s` to insert the review prompt into the editor
6. Read it, tweak it if you want, then send it normally

### Agent tool and remote reviews

There is no separate `/interactive-review` command; everything is `/diff`. Agents launch the same review surface through the `interactive_review` tool (the name is kept for Commander and existing prompts):

- `remote` accepts a plain remote branch, a GitHub PR URL, a Graphite PR URL, or `owner/repo#number`
- `cwd` points at an explicit local checkout for non-world repos
- `ref` accepts a `base..head` or `base...head` custom range

Remote branch and same-repo GitHub PR reviews fetch with `--no-tags` and a 15 second timeout, then review the fetched base/head range in the `/diff` UI. Cross-repo PRs still need a local checkout; pi-code-diff reports a clear unsupported message instead of pretending the review opened.

### Approving and commenting on a PR

When the review is a GitHub PR, finishing the review opens an end-action menu:

- `Approve`
- `Request changes`
- `Comment`
- `Send feedback to the agent (no GitHub post)`

The three GitHub verdicts go through a deliberate, gated path so nothing is posted by accident:

1. You pick a verdict and confirm it in a UI dialog. Nothing is posted yet.
2. pi-code-diff prepares a handoff in the editor: the verdict, the review body, and your `COMMENT` items mapped to GitHub inline comments (path, line, and side; `RIGHT` for added lines, `LEFT` for deleted, with `start_line` for ranges). `DISCUSS` and `MODIFY` items are never sent to GitHub.
3. The agent fixes only grammar and English in the text, shows you the final version, asks you to confirm, then calls the `submit_pr_review` tool.
4. `submit_pr_review` posts through `gh api repos/:owner/:repo/pulls/:number/reviews`. It refuses to approve a PR you authored (GitHub does not allow self-approval) with a clear message, and `request changes` requires a body or at least one inline comment.

`Send feedback to the agent` skips GitHub entirely and inserts the normal local review prompt instead.

### Fastest path

If you want speed, use template shortcuts on a selected diff line:

- press `t`
- press a shortcut key from the right panel

That creates a templated annotation instantly. If you want to refine it afterwards, press `e` on that same line.

## Deep dive

### Annotation model

The review UI treats feedback as one of three scopes:

#### Line comments

Use these for precise feedback tied to a specific added or deleted line. Hold `Shift+↑↓` in the diff to extend the selection into a multiline range on the same diff side.

Examples:

- `Why was this deleted?`
- `What is this code doing?`
- `Consider a clearer name here.`

#### File comments

Use these when the feedback applies to the whole file change rather than one line.

Examples:

- `Explain this file-level refactor.`
- `This file now does too much.`

#### Whole-change note

Use this when the feedback is about the change as a whole.

Examples:

- `Explain this entire diff to me.`
- `What is the overall intention behind this change?`

### DISCUSS vs COMMENT vs MODIFY

This distinction is central to how `/diff` works.

#### DISCUSS

Use `DISCUSS` (`d` on a line, `a` for the whole change) when you want explanation, rationale, tradeoffs, or a proposal. It is agent-only and never touches GitHub. A fix can still come out of a discussion, but the agent answers in prose first rather than editing to satisfy the note.

Examples:

- why was this deleted?
- what is this code doing?
- is this approach intentional?

#### COMMENT

Use `COMMENT` (`c` on a line, `l` on a file) for review remarks. When the review is a remote GitHub PR, these post as real GitHub review comments, mirroring GitHub: inline on the line when the note has a line, or a general PR comment otherwise. For a local review there is nothing to post, so a `COMMENT` becomes a local comment to the agent about the change.

Examples:

- consider a clearer name here
- can this be simplified?
- add tests covering this change

#### MODIFY

Use `MODIFY` when you already know the exact code change you want. Press `m` on a line and the inline editor opens pre-filled with that line's current code. You edit it in place, like a tiny code editor, and press Enter. The annotation is tracked as a `LINE CHANGED` block that records the original line and your edited line:

```text
LINE CHANGED
- const x = compute(1)
+ const x = compute(1, { cached: true })
```

The agent applies that exact edit locally inside Pi. Ranges work too: select multiple lines, edit them all, and every original and replacement line is recorded.

The manual companion to `MODIFY` is `o`, which opens the selected file at that line in your `$EDITOR` inside the same Pi shell, then returns to the review UI. Use `o` to hand-edit the file directly, or `MODIFY` to let the agent apply the edit you typed.

When the review UI generates the local prompt, it uses different wording depending on whether your review is `DISCUSS` only, `COMMENT` only, `MODIFY` only, or any mix. That keeps prose-only prompts strict, tells the agent to apply `MODIFY` items exactly as written, and avoids unnecessary instructions when you only want edits.

### Navigation and commenting

#### Global

- `1 / 2 / 3` — switch scope
- mouse wheel — scroll the pane under the cursor
- `Tab` / `Shift+Tab` — cycle focus forward / backward
- `/` — search files in the navigator
- `?` — toggle help in the right sidebar
- `w` — toggle wrapping
- `v` — toggle unified / side-by-side diff view
- `u` — toggle unchanged context in diff scopes
- `h` — hide/show the comments pane
- `s` — insert the generated prompt into the editor
- `Esc` — request review exit; confirms before discarding draft feedback
- `Ctrl+C` — request review exit with the same confirmation flow

#### Navigator

- `↑↓` or `j/k` — move between files
- `Ctrl+d` / `Ctrl+u` — move down / up by half a pane
- `gg / G` — jump to the top / bottom
- `r` — toggle related-files filter in `all files` scope
- file rows show change counts as `+added -deleted`
- `Enter` — move focus to diff

#### Diff

- `↑↓` or `j/k` — move between selectable added/deleted lines
- `Shift+↑↓` — extend the selection into a multiline range on the current side
- `← / →` — choose the old/deleted or new/added side on replacement rows in side-by-side view
- `Ctrl+d` / `Ctrl+u` — move down / up by half a pane
- `gg / G` — jump to the top / bottom
- `n / p` — next / previous hunk
- `o` — open the selected source location in `$EDITOR` inside the same Pi shell, then return to the review UI when the editor exits
- `m` — edit the line in place as a `MODIFY`; the editor opens seeded with the line's code and saves a `LINE CHANGED` edit
- `c` — line `COMMENT`
- `d` — line `DISCUSS`
- `e` — edit the existing line comment on the selected line
- `x` — delete the existing line comment on the selected line
- `l` — file comment (a `COMMENT`)
- `a` — whole-change note (a `DISCUSS`)
- `t` — open template shortcut mode for the selected line

Opening a source location in `$EDITOR` returns you to the review UI when the editor exits and keeps your draft feedback available for submission. The editor command comes from your local `$EDITOR` or `$VISUAL` and is run through your shell, so configure those variables only to commands you trust.

Side-by-side diff view keeps review in one Diff panel. The left column shows deleted/old lines, the right column shows added/new lines, and replacement rows align old and new text on the same visual row. The active side is shown with the selected cell highlight, the active column header, and the selected-side status text. Line comments attach to the selected side and line number.

Line comment markers in the diff gutter:

- accent `●` = `MODIFY`
- green `■` = `COMMENT`
- `◆` = `DISCUSS`

#### Comments panel

- `↑↓` or `j/k` — move through saved comments
- `Ctrl+d` / `Ctrl+u` — move down / up by half a pane
- `gg / G` — jump to the top / bottom
- `e` or `Enter` — edit selected comment
- `d` — delete selected comment

#### Editor

The note editor opens inline in the diff, directly under the line you are annotating, so you type your note in place instead of in the comments panel. File and whole-change notes open the editor at the top of the diff pane.

- `Tab` — cycle `DISCUSS` / `COMMENT` / `MODIFY`
- `Enter` — save
- `Shift+Enter` — newline
- `Esc` — cancel editor

### Template shortcut mode

Template shortcut mode is for very fast line comments.

When you press `t` on a selected diff line:

- the right sidebar switches to a shortcut panel
- shortcuts are grouped under `MODIFY`, `COMMENT`, and `DISCUSS` (templates are `COMMENT` or `DISCUSS`)
- pressing one shortcut key applies that comment immediately

This is designed for repetitive review patterns like:

- explain this
- why was this added?
- why was this deleted?
- what problem is this solving?
- simplify this
- add tests

If you want to refine the templated text after applying it, press `e` on that line.

### Shortcut configuration

Optional user-level config file:

- `~/.pi/agent/extensions/code-diff.json`

Example:

```json
{
  "version": 1,
  "globalShortcut": "ctrl+alt+r",
  "builtins": {
    "disable": ["restore-deleted"]
  },
  "shortcuts": [
    {
      "id": "trace-added",
      "key": "x",
      "label": "trace",
      "intent": "discuss",
      "side": "added",
      "text": "Explain how execution reaches this line."
    }
  ]
}
```

#### Fields

- `version` — schema version, currently `1`
- `globalShortcut` — global Pi shortcut that opens the review UI, defaults to `alt+s`. Use Pi key identifiers such as `alt+s`, `ctrl+alt+r`, `shift+f5`, or `f5`. Single printable characters require a modifier, so normal typing stays in the editor. Bare special keys such as `f5`, `home`, and `pageUp` are supported. Escape is supported as `escape` or `esc` without modifiers. The shortcut is registered when the extension loads; restart Pi or run `/reload` after changing it. If the configured shortcut is invalid, pi-code-diff uses `alt+s` and shows a config warning.
- `builtins.disable` — built-in shortcut ids to turn off
- `shortcuts` — your custom shortcuts

Each shortcut has:

- `id` — stable identifier
- `key` — one-character trigger after opening template shortcut mode with `t`
- `label` — short label shown in the UI
- `intent` — `discuss` or `comment` (templates cannot be `modify`, which needs the line's code)
- `side` — `added`, `deleted`, or `both`
- `text` — the comment text to apply

### Prompt generation

When you submit, `/diff` builds a prompt that matches the kind of review you created.

It groups feedback naturally into sections like:

- review-wide note
- file comments
- line comments

and uses stricter instructions when `DISCUSS` or `COMMENT` items are present, so the model is less likely to turn explanatory notes into accidental edits. `MODIFY` items are presented as exact `LINE CHANGED` edits to apply.

### What it is good at

`/diff` is especially good when you want to:

- pause after an agent turn and inspect the change carefully
- ask for explanation without losing the exact line you are looking at
- separate exact edits from comments and discussion
- review deleted lines, not just added ones
- stay inside Pi instead of switching to a browser or external review tool


