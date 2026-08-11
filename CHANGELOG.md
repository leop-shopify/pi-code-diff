# Changelog

## 0.3.4 - 2026-08-10

### Added

- Toggle Navigator, Diff, Comments, and PR context with `1` through `4`, preserving pane visibility across reviews.
- Expand up to 10 hidden file lines above or below the selected diff line with `k` or `j` (`K` and `J` remain aliases).

### Changed

- Move review-scope shortcuts from `1` through `3` to `Alt+1` through `Alt+3`.
- Reserve Up/Down for diff-line navigation and use `k`/`j` for contextual expansion.
- Wrap footer status and shortcut descriptions onto additional lines instead of truncating later actions.

## 0.3.3 - 2026-08-07

### Added

- Allow `Post Comments` to publish inline feedback and an optional general review comment together.

### Changed

- Rename the remote review action from `Comment` to `Post Comments`.
- Leave mouse selection and copying to the terminal or tmux instead of enabling extension-owned mouse reporting.

## 0.3.2 - 2026-07-29

### Added

- Resume remote PR reviews after agent-only `DISCUSS` conversations while preserving reviewer-facing `COMMENT` and `MODIFY` items.
- Prepopulate confirmed discussion findings as editable comments without replacing existing feedback.
- Remove the selected Comments-panel item with `r`, while retaining `d` as an existing shortcut.

### Changed

- Scope agent discussion prompts to `DISCUSS` items and reject saved review sessions when the pull request head changes.
