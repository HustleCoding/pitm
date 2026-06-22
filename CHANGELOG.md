# Changelog

All notable changes to this project will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

- **Mailbox server data corruption** — `appendFileSync` replaced with `writeFileSync` in `mailbox-server.ts`; previously, writing to `mailbox.json` more than once produced invalid JSON by appending a full array to existing content.
- **Worker prompt showed task ID instead of title** — `worker.ts` template duplicated `input.task.id` where the second occurrence should have been `input.task.title`.
- **Double lock release in orchestrator** — four `fail()` call sites in `afterPr()` released the file lock, then the caller released it again. Removed the duplicate releases.
- **`proper-lockfile` missing as direct dependency** — was only available as a transitive dep; added to `package.json` explicitly.
- **SIGINT handler indentation** — `cli.ts` error handler had misaligned `s.humanNote` and `saveState(s)` lines.
- **Loose `byPhase` type** — `RunContext.byPhase` changed from `Record<string, ...>` to `Record<PhaseName, ...>` in `orchestrator.ts`.
- **Planner JSON extraction broke on nested code blocks** — `extractJson()` regex in `planner.ts` used non-greedy `*?` which stopped at the first inner triple-backtick inside JSON string values; changed to greedy `*`.

### Added

- `config.example.json` at repo root — annotated configuration template with OpenRouter model refs, verify command, git settings, and budget defaults.

### Changed

- **README rewritten** — structured quick-start guide (5 steps), model configuration guide with per-phase recommendations, provider table with env vars and auth.json keys, troubleshooting section, all-commands reference.
