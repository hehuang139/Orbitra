# Orbitra Agent Instructions

## Roadmap feature workflow

When implementing any new feature listed in `ROADMAP.md` or `docs/roadmaps/`, always start from the latest default branch:

1. Switch to `main` with `git switch main`.
2. Pull the latest remote changes with `git pull --ff-only origin main`.
3. Create a dedicated `codex/<feature-name>` branch from the updated `main`.
4. Implement and verify only the scoped roadmap feature on that branch.
5. Commit the changes, push the feature branch, and open a pull request targeting `main`.
6. Merge only after the required checks pass.

Do not start roadmap feature work from an old, merged, or unrelated feature branch, and do not commit roadmap features directly to `main`.
