# Decisions

## 2026-06-10: Formal Project Root

Decision:

- `$HOME/Downloads/自媒体开发` is the formal workspace root.
- `$HOME/Downloads/自媒体开发/topic-radar` is the formal source Git repository.
- The old root was archived and recreated.

Reason:

The previous root had unrelated Git history and many non-source materials. A clean nested source repo avoids mixing project code with archives, deployment handoff folders, and reference material.

## 2026-06-10: Split Deployment Packages

Decision:

- Keep `topic-collector` and `topic-vertical` as separate deployment packages.

Reason:

The user needs intuitive deployable tools with separate responsibilities: concrete data collection versus vertical strategy and analysis.

## 2026-06-10: Runtime Data Outside Git

Decision:

- Runtime data, local downloads, generated package tarballs, and local key files are ignored by Git.

Reason:

They are machine-specific or generated artifacts and should not become source history.
