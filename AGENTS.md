# AGENTS.md

## Project overview

`pi-code-diff` is a local Pi coding-agent extension that adds the `/diff`, `/code`, and `/code-diff` terminal review UI (same command, multiple aliases). It lets users review diffs, annotate lines/files/whole changes, and insert a follow-up prompt back into Pi.

The package is local-only for Leo and is loaded by Pi from `./src/index.ts`.

## Git guidance

Use Conventional Commits for commit messages, for example `feat: add shortcut customization`, `fix: handle empty diffs`, or `docs: update install instructions`.

