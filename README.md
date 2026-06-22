# pi-task-master

Autonomous task orchestration over the [pi](https://github.com/earendil-works/pi-coding-agent) agent SDK — **model-agnostic** and **PR-based**. Give it a goal; it plans, implements, commits, pushes, and opens a pull request. State persists between runs so it resumes where it left off.

Inspired by [`developerz-ai/claude-task-master`](https://github.com/developerz-ai/claude-task-master), but provider-neutral: the planner, worker, fixer, and reviewer can each run on a **different model** (Claude, GPT, GLM, DeepSeek, o3, …) routed per phase. That routing is the reason this exists — claude-task-master is Claude-only.

> **Status: Phase 1–4 complete.** `start` runs the full pipeline — plan → work → PR → CI fix loop → review loop → success-criteria verification → (opt-in) merge. `resume`/`status`/`doctor`/`steer`/`watch` all work. Auto-merge defaults **off**; human approval is still the recommended gate for real repos. Multi-instance concurrency is advisory (file lock + HTTP mailbox).

## Install

### Prerequisites

- **[Bun](https://bun.sh)** 1.3+ (runtime)
- **[pi](https://github.com/earendil-works/pi-coding-agent)** — the agent harness, authenticated with at least one model provider. Run `pi` once interactively and log in, or set provider API keys in `~/.pi/agent/auth.json`.
- **[GitHub CLI](https://cli.github.com)** (`gh`) — logged in via `gh auth login`.
- **git** — with push access to the repo you want the agent to work on.

### Get the code

```bash
git clone https://github.com/HustleCoding/pitm.git
cd pitm
bun install        # installs the pi SDK + types
bun link           # makes `pitm` available on your PATH
```

Verify it can run:

```bash
pitm --help
pitm doctor        # checks pi auth, gh, git, config, and model availability
```

`doctor` must pass before you run anything real. If it fails, it tells you exactly what's missing (e.g. `gh auth status` not logged in, a routed model not found).

### Where `pitm` reads auth from

`pitm` does **not** store API keys. It reuses your existing pi credentials at `~/.pi/agent/auth.json` and the models declared in `~/.pi/agent/models.json` / `~/.pi/agent/settings.json`. So you must have `pi` set up and working on that machine first.

## Configure (in the repo you want it to work on)

`pitm` is a tool you run **from inside a target repo** (the codebase you want changed). It does not modify itself. From that target repo:

```bash
mkdir -p .pitm
cat > .pitm/config.json <<'EOF'
{
  "models": {
    "planner":  "opencode-go/glm-5.2",
    "worker":   "opencode-go/glm-5.2",
    "fixer":    "openai-codex/gpt-5.4",
    "reviewer": "opencode-go/glm-5.2",
    "verifier": "opencode-go/glm-5.2"
  },
  "verifyCommand": "bun run verify",
  "git": { "targetBranch": "main", "autoPush": true, "autoMerge": false },
  "budget": { "maxTokensPerRun": 2000000, "maxCiFixRetries": 3 }
}
EOF
echo ".pitm/" >> .gitignore    # keep run state out of git
```

Full schema in [`config.example.json`](./config.example.json). The two fields you must set per repo:

- **`verifyCommand`** — the command that proves the work is correct (`bun run verify`, `npm test`, `cargo test`, …). The worker runs it after implementing each task; the verifier runs it again before declaring done.
- **`git.targetBranch`** — the branch PRs target (usually `main` or `master`).

Model refs are `"provider/modelId"` and must resolve via pi. Check what's available with `pitm doctor`, or look at `pi`'s model list. Pick API-key-authenticated providers; OAuth-only credentials can be rejected by some orgs.

## Use

From inside the target repo:

```bash
pitm doctor                 # check pi auth, gh, git, config, model availability
pitm start "Add a /healthz route to apps/api with a test" --dry-plan   # preview the plan, no side effects
pitm start "Add a /healthz route to apps/api with a test"              # real run: plan → work → PR → CI → review → verify
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

## Verify

The project's verify command is `bun run typecheck` (it runs `tsc --noEmit` via the `typecheck` package.json script). Workers and contributors **must** make this command pass before considering work done.

```bash
bun run typecheck
```

## First run (5 minutes)

```bash
# 1. one-time: install pitm
git clone https://github.com/HustleCoding/pitm.git && cd pitm && bun install && bun link

# 2. go to the repo you want changed
cd path/to/your-project
mkdir -p .pitm
# edit .pitm/config.json — set verifyCommand + git.targetBranch for THIS repo
# (see the Configure section above)
echo ".pitm/" >> .gitignore

# 3. sanity check
pitm doctor

# 4. preview what it would do — no branch, no PR, no tokens spent on execution
pitm start "Add a /healthz route that returns 200 OK with a test" --dry-plan

# 5. happy with the plan? run it for real
pitm start "Add a /healthz route that returns 200 OK with a test"

# 6. watch progress / resume after interruption
pitm status
pitm resume
```

What you'll see on a real run: a new `pitm/<date>-<slug>` branch, one commit per planned task, a push, a PR opened via `gh`, then CI polling → (fix attempts if CI fails) → review-comment handling → a verifier verdict. If anything fails past the PR, the run stops at `needs_human` and `pitm resume` picks it back up.

## When a run gets stuck

- **`needs_human`** — read `pitm status` → `Note:`. Fix the blocker (bad model auth, a test it can't pass, an environmental CI failure), then `pitm resume`.
- **You Ctrl-C'd mid-run** — state is saved; `pitm resume` continues from the saved phase.
- **You want to start over** — `rm .pitm/state.json` and run `pitm start` again.
- **Wrong repo / wrong goal** — delete `.pitm/state.json`, delete the stray `pitm/...` branch (`git branch -D pitm/...`), and start fresh.

## Costs

Every `pitm start` spends real tokens: a planner call plus one worker session per task (plus fixer/reviewer/verifier sessions if it reaches those phases). The `budget.maxTokensPerRun` cap (default 2,000,000) hard-stops runaway runs at `needs_human`. Use `--dry-plan` first to scope the work before spending on execution.

## Safety

- `autoMerge` defaults to **false**. The orchestrator never merges without explicit config, and only after CI + review + verification all pass.
- A per-run token `budget` cuts off runaway workers before `needs_human`.
- CI fix retries are bounded (`maxCiFixRetries`); environmental failures are detected and surfaced, not patched.
- The worker/fixer/reviewer are instructed never to run git/gh — only the orchestrator touches git.
- A file lock (`proper-lockfile`) prevents two orchestrators from racing on the same run.
- The HTTP mailbox binds to `127.0.0.1` by default; don't expose it publicly.

## License

MIT
