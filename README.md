# pi-task-master

Autonomous task orchestration over the [pi](https://github.com/earendil-works/pi-coding-agent) agent SDK — **model-agnostic** and **PR-based**. Give it a goal; it plans, implements, commits, pushes, and opens a pull request. State persists between runs so it resumes where it left off.

Inspired by [`developerz-ai/claude-task-master`](https://github.com/developerz-ai/claude-task-master), but provider-neutral: the planner, worker, fixer, and reviewer can each run on a **different model** (Claude, GPT, GLM, DeepSeek, o3, …) routed per phase. That routing is the reason this exists — claude-task-master is Claude-only.

> **Status: Phase 1 (minimal slice).** `start`/`resume`/`status`/`doctor`/`steer` work. CI-fix, review-comment, auto-merge, and success-criteria-verification loops are **not yet built** — they route to a `needs_human` state with a clear note. Human PR review is the current quality gate.

## Install

Requires Bun, `pi` (authenticated), `gh` (logged in), and `git`.

```bash
cd pi-task-master
bun install
bun link   # makes `pitm` available on PATH
```

## Configure

Drop a `.pitm/config.json` in the **target repo** (the repo you want the agent to work on). See [`.pitm/config.example.json`](./.pitm/config.example.json). Model refs are `"provider/modelId"` and must resolve via `pi` (check `pi`'s model list / `~/.pi/agent/models.json`).

## Use

From inside the target repo:

```bash
pitm doctor                 # check pi auth, gh, git, config, model availability
pitm start "Add a /healthz route to apps/api with a test"
pitm status                 # phase, tasks, PR url, token budget
pitm resume                 # continue after a SIGINT or a failed run
pitm steer "also cover the 503 case"   # queue a steering message for the next worker turn
```

State lives at `.pitm/state.json` (one run per repo). Delete it to start over.

## How it works

```
planning → working (per task) → pr_open → done
                                       ↘ needs_human   (CI/review/merge not yet automated)
```

- **Planner** — read-only pi session (strong model) explores the repo and emits a strict-JSON task list.
- **Worker** — per task: an edit-capable pi session (cheap model) implements, runs the configured `verifyCommand`, and the orchestrator commits.
- **PR** — when all tasks are done, the orchestrator pushes (if `autoPush`) and opens a PR via `gh`.

Per-phase model routing, durable state, and a SIGINT-safe resume loop are the parts that matter; the CI/review/merge scar tissue is deferred (see [`docs/plans/2026-06-20-overview.md`](./docs/plans/2026-06-20-overview.md)).

## Safety

- `autoMerge` defaults to **false**. The orchestrator never merges without explicit config.
- A per-run token `budget` cuts off runaway workers before `needs_human`.
- The worker is instructed never to run git/gh — only the orchestrator touches git.

## License

MIT
