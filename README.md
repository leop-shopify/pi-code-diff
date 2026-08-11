# pi-code-diff

`/diff`, `/code`, and `/code-diff` open an interactive code diff editor for Pi with comments, editable line suggestions, AI-assisted review handoff, GitHub PR submission support, and local or remote diff review.

It is inspired by Mario Zechner's [pi-diff-review](https://github.com/badlogic/pi-diff-review).

It lets you stop after an agent turn, walk a local diff or remote PR inside Pi, add fast line/file/all-lines annotations, and route the result either back to the agent or into a GitHub PR review.

The goal is simple: keep terminal-based code review inside Pi, keep annotations precise, and make it easy to separate edits you want applied from comments you want posted and things you want explained.

## Summary

Use `/diff`, `/code`, or `/code-diff` when you want to review and annotate code changes before sending the agent another turn or posting GitHub PR feedback.

It supports local and remote review modes:

- `git diff`
- `last commit`
- `all files`
- custom `base..head` / `base...head` ranges
- remote branches
- GitHub or Graphite PR URLs

Inside the review UI you can:

- move through files and hunks quickly
- review changes in unified or side-by-side diff view
- annotate **added** and **deleted** lines, including multiline ranges on one diff side
- leave **file-level** annotations
- leave an **all-lines note** for the current file
- mark feedback as either:
  - `DISCUSS` — the agent explains, justifies, or proposes; it never edits code or touches GitHub to satisfy the note
  - `COMMENT` — a real GitHub PR comment when the review is remote; for a local review it becomes a local comment to the agent about the change
  - `MODIFY` — an exact edit you make in place on the line; the agent applies it locally
- insert the resulting local review prompt into Pi’s editor
- for GitHub PR reviews, run a grammar and semantic-safety pass with the active Pi model, automatically apply safe corrections, and submit the confirmed verdict directly

For local reviews, the UI stages the next message for you. For GitHub PR verdicts, the UI grammar-checks the confirmed text and submits automatically when every correction preserves meaning, intent, tone, and technical substance.

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

Agents can open the same UI with the `open_code_diff` tool. It accepts an `args` string using the same syntax as `/diff`, plus optional `cwd`. Empty `args` reviews local working-tree/uncommitted changes, including untracked files, so you do not need to commit before review.

Agents can also pass an optional `comments` array to prepopulate concrete review notes into the UI. Each entry needs a `path` matching a reviewed file and a `body`, plus optional `side` (`added` default, `deleted`, or `file`), `line` or `startLine`/`endLine`, and `intent` (`discuss`, `comment` default, or `modify`). Seeded comments are attached to the matching file and line, stay editable and deletable, and flow through the same review prompt as hand-written ones. Comments whose `path` does not match a reviewed file are surfaced as a warning instead of being dropped.

Or use the global shortcut, which defaults to:

```text
alt+s
```

Configure the shortcut with `globalShortcut` in `~/.pi/agent/extensions/code-diff.json`, then restart Pi or run `/reload`.

### Picking what to review

`/diff` (and `/code`, `/code-diff`) is the single entry point for every kind of review.

- `/diff` with no arguments reviews local working-tree/uncommitted changes, including untracked files. When Pi is inside a recognized monorepo workspace such as `packages/app`, review is scoped to that workspace; add `--whole-repo` to include the entire checkout.
- `/diff --include-generated` includes generated text such as `.rbi`, source maps, and minified JavaScript/CSS while still rejecting binary files.
- Review state is saved locally while the UI is open and restored for the same repository/range. `/diff --resume <session-id>` selects an explicit session; `/diff --discard-resume` discards the matching saved session before opening.
- `/diff remote <url | branch>` reviews a remote branch or GitHub PR. It accepts a remote branch, a GitHub or Graphite PR URL, or `owner/repo#123`.
- `/diff <base>..<head>` compares the two endpoints directly. `/diff <base>...<head>` compares the merge base with `head`.

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
   - `Enter` or `m` to edit the line in place as a `MODIFY` (the current source starts highlighted)
   - `c` for a line `COMMENT`
   - `d` for a line `DISCUSS`
   - `l` for a file annotation (a `COMMENT`)
   - `a` for an all-lines note on the current file (a `COMMENT`)
5. Press `s` to insert the review prompt into the editor
6. Read it, tweak it if you want, then send it normally

### Remote reviews

Use `/diff` directly, or have an agent call `open_code_diff` with the same target syntax:

- `/diff remote <branch | url>` or `open_code_diff({ args: "remote <branch | url>" })` accepts a plain remote branch, a GitHub PR URL, a Graphite PR URL, or `owner/repo#number`
- `/diff` with no args or `open_code_diff({ args: "" })` reviews local working-tree/uncommitted changes, including untracked files, against the configured or detected checkout
- `/diff base..head` or `open_code_diff({ args: "base..head" })` reviews a `base..head` or `base...head` custom range

Remote branch and GitHub PR reviews fetch with `--no-tags` and a 60 second timeout, then review the fetched base/head range in the `/diff` UI. GitHub PR reviews also show a `PR context` column with the exact title, URL, author, review status, problem summary, validation, open comments, files touched, and a compact `+added/-removed` line count. PR URLs and `owner/repo#number` do not require a checkout; if no matching local checkout is configured or detected, pi-code-diff uses a lightweight git cache under `~/.pi/agent/cache/pi-code-diff/remotes/`.

For monorepos or repos that should resolve to a specific local checkout, add a `repositories` mapping to `~/.pi/agent/extensions/code-diff.json`:

```json
{
  "repositories": {
    "owner/repo": {
      "cwd": "/absolute/path/to/local/checkout",
      "subdir": "packages/app",
      "pathspecs": ["packages/app", "shared/ui"],
      "importAliases": { "@workspace/shared": "shared/ui" }
    }
  }
}
```

### Approving and commenting on a PR

When the review is a GitHub PR, finishing the review opens an end-action menu:

- `Approve`
- `Request changes`
- `Post Comments`
- `Start discussion with agents` when at least one `DISCUSS` item exists

All three GitHub verdicts open an optional review-body editor, so `Post Comments` can publish inline comments and a general comment together.

The three GitHub verdicts use an extension-owned submission flow:

1. You pick a verdict in the review UI, confirming the review locations, verdict, and original text.
2. pi-code-diff asks the active Pi model to correct grammar, spelling, capitalization, punctuation, and awkward syntax without changing meaning.
3. A separate semantic-safety pass classifies every correction. Meaning-preserving grammar and clarity corrections are applied and submitted automatically without another approval screen.
4. Only corrections that may alter meaning, intent, tone, technical substance, or requested scope are shown for an exact use/edit/keep/remove decision. Safe corrections in the same review remain automatic, and there is no final confirmation after uncertain items are resolved.
5. Invalid model output fails closed and falls back to the agent-mediated submission prompt instead of posting unverified text.
6. `COMMENT` line items are posted as GitHub inline comments. `MODIFY` line edits are posted as inline comments containing a suggested diff. `COMMENT` file/all-lines items become the review body. `DISCUSS` items are never sent to GitHub.
7. Approval refuses self-approval with a clear message, and `request changes` requires a body or at least one inline comment.

`Start discussion with agents` skips GitHub entirely and stages only the `DISCUSS` items as the prompt for an agent conversation. When an agent opened the review with `open_code_diff`, that prompt returns to the waiting agent; after a direct `/diff remote`, it stays in Pi's editor for you to submit. The `DISCUSS` items are consumed when the discussion starts, while existing `COMMENT` and `MODIFY` items stay in the saved review for the PR author.

If the discussion produces material findings, the agent asks `Want me to prepopulate the findings as comments?` before adding any confirmed findings as editable `COMMENT` items. It then asks `Good to continue the review?`; only that confirmation reopens the saved review. If the PR head changed during the discussion, pi-code-diff starts a fresh review instead of applying saved comments to stale line mappings.

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

#### All-lines file notes

Use this when the feedback is about all lines in the current file, rather than one selected line.

Examples:

- `Explain this entire file change to me.`
- `What is the overall intention behind this file refactor?`

### DISCUSS vs COMMENT vs MODIFY

This distinction is central to how `/diff` works.

#### DISCUSS

Use `DISCUSS` (`d` on a line, `a` for all lines in the current file) when you want explanation, rationale, tradeoffs, or a proposal. It is agent-only and never touches GitHub. In a remote PR review, `Start discussion with agents` consumes only these items, keeps `COMMENT` and `MODIFY` items in the saved review, and resumes that review only after you confirm the conversation is done. A fix can still come out of a discussion, but the agent answers in prose first rather than editing to satisfy the note.

Examples:

- why was this deleted?
- what is this code doing?
- is this approach intentional?

#### COMMENT

Use `COMMENT` (`c` on a line, `l` on a file) for review remarks. When the review is a remote GitHub PR, these post as real GitHub review comments, mirroring GitHub: inline on the line when the note has a line, or a general PR comment otherwise. For a local review there is nothing to post, so a `COMMENT` becomes actionable feedback to the agent: questions should be answered in prose, and comments that ask for changes or state a preferred implementation should be handled with local edits.

Examples:

- consider a clearer name here
- can this be simplified?
- add tests covering this change

#### MODIFY

Use `MODIFY` when you already know the exact code change you want. Press `Enter` or `m` on a line and the inline editor opens with that line's current code highlighted. Typing or pasting replaces the highlighted source; an arrow key keeps it and starts editing from that edge. Tabs, indentation, trailing whitespace, and large pastes are preserved. Press Enter to save. An unchanged edit is rejected instead of creating a no-op annotation. The annotation is tracked as a `LINE CHANGED` block that records the original line and your edited line:

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

- `1 / 2 / 3 / 4` — toggle Navigator, Diff, Comments, or PR context; pane visibility is restored in the next code-diff review
- `Alt+1 / Alt+2 / Alt+3` — switch scope
- mouse drag — use normal terminal/tmux text selection and copy behavior
- mouse wheel — scroll the pane under the cursor in Pi fullscreen mode
- `Tab` / `Shift+Tab` — cycle focus forward / backward
- `/` — search the focused pane: files in Navigator, code in Diff, comments in Comments
- `Esc` while searching — clear that pane's search
- `n / N` — jump to the next / previous search match in the focused pane
- `?` — toggle help in the right sidebar
- `w` — toggle wrapping
- `v` — toggle unified / side-by-side diff view
- `u` — toggle unchanged context in diff scopes
- `h` — hide/show the Comments pane as an alias for `3`
- `s` — insert the generated prompt into the editor
- `Esc` — request review exit; confirms before discarding draft feedback
- `Ctrl+C` — request review exit with the same confirmation flow

#### Navigator

New reviews select the first file in the visible Navigator order. Locale and translation directories show English variants and Brazilian Portuguese by default; other locales remain in the review and can be revealed at any time.

- `↑↓` or `j/k` — move between files, wrapping from top to bottom and bottom to top
- `T` — toggle package-grouped tree and flat review-priority order
- `L` — show/hide locale files other than English and Brazilian Portuguese
- `R` — mark the active file reviewed/unreviewed
- `] / [` — jump to the next / previous unreviewed file
- `Ctrl+d` / `Ctrl+u` — move down / up by half a pane
- `Ctrl+f` / `Ctrl+b` or `PageDown` / `PageUp` — move down / up by a full pane
- `gg / G` — jump to the top / bottom
- `r` — toggle related-files filter in `all files` scope
- `Enter / →` — open a changed submodule at its exact nested commit range; `b` returns to the parent review
- file rows show change counts as `+added -deleted`
- `Enter` — move focus to diff

#### Diff

- `↑↓` — move between changed lines; press `C` to include selectable unchanged context lines
- `k` / `j` — reveal up to 10 hidden file lines above / below the selected line; repeat to continue expanding (`K` / `J` are aliases)
- `Shift+↑↓` — extend the selection into a multiline range on the current side
- `← / →` — choose the old/deleted or new/added side on replacement rows in side-by-side view
- `Ctrl+d` / `Ctrl+u` — move down / up by half a pane
- `Ctrl+f` / `Ctrl+b` or `PageDown` / `PageUp` — move down / up by a full pane
- `gg / G` — jump to the top / bottom
- `n / N` — next / previous code search match when diff search is active
- `n / p` — next / previous hunk when there is no active diff search
- `o` — open the selected source location in `$EDITOR` inside the same Pi shell, then return to the review UI when the editor exits
- `Enter` or `m` — edit the line in place as a `MODIFY`; the source starts highlighted, and typing or pasting replaces it
- `y` — copy the selected source, or the selected comment when Comments is focused
- `Y` — copy `path:start-end` for the selected source
- `P` — copy a unified patch snippet, using the saved `MODIFY` replacement when present
- `S` — copy a GitHub suggestion block, using the saved `MODIFY` replacement when present
- `c` — line `COMMENT`
- `d` — line `DISCUSS`
- `e` — edit the existing line comment on the selected line
- `x` — delete the existing line comment on the selected line
- `l` — file comment (a `COMMENT`)
- `a` — all-lines note for the current file (a `COMMENT`)
- `t` — open template shortcut mode for the selected line

In Pi's regular TUI mode, pi-code-diff leaves mouse handling to the terminal so tmux selection works normally without an in-app key, mode, or automatic copy. In Pi fullscreen mode, Pi owns drag selection and mouse-wheel scrolling.

Opening a source location in `$EDITOR` returns you to the review UI when the editor exits and keeps your draft feedback available for submission. The editor command comes from your local `$EDITOR` or `$VISUAL` and is run through your shell, so configure those variables only to commands you trust.

Side-by-side diff view keeps review in one Diff panel. The left column shows deleted/old lines, the right column shows added/new lines, and replacement rows align old and new text on the same visual row. The active side is shown with the selected cell highlight, the active column header, and the selected-side status text. Line comments attach to the selected side and line number.

Line comment markers in the diff gutter:

- accent `●` = `MODIFY`
- green `■` = `COMMENT`
- `◆` = `DISCUSS`

#### Comments panel

- `↑↓` or `j/k` — move through saved comments
- `Ctrl+d` / `Ctrl+u` — move down / up by half a pane
- `Ctrl+f` / `Ctrl+b` or `PageDown` / `PageUp` — move down / up by a full pane
- `gg / G` — jump to the top / bottom
- `e` or `Enter` — edit selected comment
- `d` or `r` — delete selected comment
- `y` — copy selected comment
- `A` — toggle active-file comments and the cross-file comments overview

#### Editor

The note editor opens inline in the diff, directly under the line you are annotating, so you type your note in place instead of in the comments panel. File and all-lines notes open the editor at the top of the diff pane.

- `Tab` — cycle `DISCUSS` / `COMMENT` / `MODIFY` for line annotations; file annotations cycle `DISCUSS` / `COMMENT`
- `Enter` — save; unchanged `MODIFY` input stays open with an explanation
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
  "repositories": {
    "example/widgets": {
      "cwd": "/absolute/path/to/monorepo",
      "subdir": "packages/widgets",
      "pathspecs": ["packages/widgets", "shared/ui"],
      "importAliases": {
        "@workspace/shared": "shared/ui"
      }
    }
  },
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
- `repositories` — optional remote repository profiles. Each entry accepts a checkout `cwd` or `path`, a default workspace `subdir`, review `pathspecs`, and JavaScript/TypeScript `importAliases`. Configured checkouts are validated against their `origin` before use.
- Review display preferences are stored in `code-diff-preferences.json`; in-progress versioned sessions are stored under Pi's local `cache/pi-code-diff/sessions` directory and removed after submit or explicit discard.
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

- file/all-lines comments
- line comments

and uses stricter instructions when `DISCUSS` or `COMMENT` items are present, so the model is less likely to turn explanatory notes into accidental edits. `MODIFY` items are presented as exact `LINE CHANGED` edits to apply.

### What it is good at

`/diff` is especially good when you want to:

- pause after an agent turn and inspect the change carefully
- ask for explanation without losing the exact line you are looking at
- separate exact edits from comments and discussion
- review deleted lines, not just added ones
- stay inside Pi instead of switching to a browser or external review tool


