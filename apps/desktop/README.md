# apps/desktop — Tauri 2 shell

Placeholder (Sprint 4, task T-203). Until then this directory only pins the
layout: the pnpm workspace already globs `apps/*`, so a `package.json` dropped
here is picked up by `pnpm install` with no root changes.

Plan: wrap the web app (React + Vite) in Tauri 2 — window, menus,
auto-updater, tokens in the OS keychain. Owners: Deployment + Frontend.
See docs/TASKS.md T-203 for the done-when criteria.
