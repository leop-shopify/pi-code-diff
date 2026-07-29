# Changelog

## 0.3.2 - 2026-07-29

### Added

- Resume remote PR reviews after agent-only `DISCUSS` conversations while preserving reviewer-facing `COMMENT` and `MODIFY` items.
- Prepopulate confirmed discussion findings as editable comments without replacing existing feedback.
- Remove the selected Comments-panel item with `r`, while retaining `d` as an existing shortcut.

### Changed

- Scope agent discussion prompts to `DISCUSS` items and reject saved review sessions when the pull request head changes.
