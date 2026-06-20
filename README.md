# pi-task-master

Autonomous task orchestration over the [pi](https://github.com/earendil-works/pi-coding-agent) agent SDK — **model-agnostic** and **PR-based**. Give it a goal; it plans, implements, commits, pushes, and opens a pull request. State persists between runs so it resumes where it left off.

Inspired by [`developerz-ai/claude-task-master`](https://github.com/developerz-ai/claude-task-master), but provider-neutral: the planner, worker, fixer, and reviewer can each run on a **different model** (Claude, GPT, GLM, DeepSeek, o3, …) routed per phase. That routing is the reason this exists — claude-task-master is Claude-only.

> **Status: Phase 1–4 complete.** `start` runs the full pipeline — plan → work → PR → CI fix loop → review loop → success-criteria verification → (opt-in) merge. `resume`/`status`/`doctor`/`steer`/`watch` all work. Auto-merge defaults **off**; human approval is still the recommended gate for real repos. Multi-instance concurrency is advisory (file lock + HTTP mailbox).

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
pitm steer "also cover the 503 case"   # queue a steering message for the running worker
pitm watch --port 7331      # start the HTTP mailbox endpoint for external injects
```

State lives at `.pitm/state.json` (one run per repo). Delete it to start over.

### The full pipeline

```
planning → working (per task) → pr_open → ci_pending → ci_fixing → review → verifying → (merging) → done
                                                                              ↘ needs_human
```

- **Planner** (strong model, read-only) explores the repo and emits a strict-JSON task list with success criteria.
- **Worker** (cheap model, edit-capable) implements each task, runs `verifyCommand`, and the orchestrator commits per task. Mid-run steering messages from the mailbox are delivered to the live session via `session.steer()`.
- **CI loop** — `gh pr checks` is polled; on failure a **fixer** session (multimodal by default) gets the failing logs, pushes a fix, and CI re-runs. Bounded by `maxCiFixRetries`; environmental failures (flaky tests, missing secrets) are detected and routed to `needs_human` instead of patched.
- **Review loop** — reviewer comments are fetched via `gh api`; a **reviewer** session addresses each, commits, pushes, and CI re-runs. Bounded to 3 rounds.
- **Verifier** (strong model, read-only) checks every recorded success criterion against the code + a local verify run, emitting a strict JSON verdict. A failed criterion halts at `needs_human`.
- **Merge** — only if `git.autoMerge` is `true`; squashes by default.

At any failing gate the run halts at `needs_human` with an actionable note; `pitm resume` continues once you've fixed the blocker.

## Safety

- `autoMerge` defaults to **false**. The orchestrator never merges without explicit config, and only after CI + review + verification all pass.
- A per-run token `budget` cuts off runaway workers before `needs_human`.
- CI fix retries are bounded (`maxCiFixRetries`); environmental failures are detected and surfaced, not patched.
- The worker/fixer/reviewer are instructed never to run git/gh — only the orchestrator touches git.
- A file lock (`proper-lockfile`) prevents two orchestrators from racing on the same run.
- The HTTP mailbox binds to `127.0.0.1` by default; don't expose it publicly.

## License

MIT
