# CLAUDE.md

## Verify your checkout before making changes

At the start of every session — and again after any `/clear` — run
`git rev-parse --show-toplevel` and confirm it is the checkout you intend to work
in **before** editing, running, or committing anything.

Stale local copies of this repo can share the same git remote, so
`git remote get-url origin` alone will not distinguish them. Only the filesystem
path from `git rev-parse --show-toplevel` is authoritative.

(Machine-specific paths and quirks, if any, live in the gitignored
`CLAUDE.local.md`.)
