# pi-task-master

Autonomous task orchestration over the [pi](https://github.com/earendil-works/pi-coding-agent) agent SDK — **model-agnostic** and **PR-based**. Give it a goal; it plans, implements, commits, pushes, and opens a pull request.

```
pitm start "Add a /healthz route that returns 200 OK with a test"
```

The planner, worker, fixer, reviewer, and verifier can each run on a **different model** (Claude, GPT, Gemini, DeepSeek, GLM, …) routed per phase. That routing is the reason this exists — most task orchestrators lock you into a single provider.

> **Status:** `start` runs the full pipeline — plan → work → PR → CI fix loop → review loop → success-criteria verification → (opt-in) merge. `resume`/`status`/`doctor`/`steer`/`watch` all work.

---

## Quick Start (5 minutes)

### 1. Install prerequisites

| Tool | Why | Install |
|------|-----|---------|
| [Bun](https://bun.sh) 1.3+ | Runtime | `curl -fsSL https://bun.sh/install \| bash` |
| [GitHub CLI](https://cli.github.com) (`gh`) | Creates PRs | `brew install gh` then `gh auth login` |
| git | Push access to target repo | (usually pre-installed) |

### 2. Install pitm

```bash
git clone https://github.com/HustleCoding/pitm.git
cd pitm
bun install
bun link            # makes `pitm` available globally on your PATH
```

### 3. Set up model access

pitm uses the **pi agent SDK** to talk to AI models. It supports 30+ providers. You need at least one API key.

**Easiest option — OpenRouter (one key, all models):**

```bash
export OPENROUTER_API_KEY="sk-or-v1-..."
```

The SDK picks it up automatically. With OpenRouter, use model refs like `openrouter/anthropic/claude-sonnet-4.6` in your config.

**Direct provider keys** (set any you have):

```bash
export ANTHROPIC_API_KEY="sk-ant-..."     # for anthropic/claude-*
export OPENAI_API_KEY="sk-..."            # for openai/gpt-*
export DEEPSEEK_API_KEY="sk-..."          # for deepseek/deepseek-*
export GEMINI_API_KEY="..."               # for google/gemini-*
```

Or store them permanently in `~/.pi/agent/auth.json`:

```json
{
  "anthropic": { "type": "api_key", "key": "sk-ant-..." },
  "openrouter": { "type": "api_key", "key": "sk-or-v1-..." }
}
```

<details>
<summary>Full provider table (click to expand)</summary>

| Provider | Env Variable | auth.json key |
|----------|-------------|---------------|
| Anthropic | `ANTHROPIC_API_KEY` | `anthropic` |
| OpenAI | `OPENAI_API_KEY` | `openai` |
| OpenRouter | `OPENROUTER_API_KEY` | `openrouter` |
| DeepSeek | `DEEPSEEK_API_KEY` | `deepseek` |
| Google Gemini | `GEMINI_API_KEY` | `google` |
| Mistral | `MISTRAL_API_KEY` | `mistral` |
| Groq | `GROQ_API_KEY` | `groq` |
| xAI | `XAI_API_KEY` | `xai` |
| Together AI | `TOGETHER_API_KEY` | `together` |
| Fireworks | `FIREWORKS_API_KEY` | `fireworks` |
| NVIDIA NIM | `NVIDIA_API_KEY` | `nvidia` |
| Cerebras | `CEREBRAS_API_KEY` | `cerebras` |
| Hugging Face | `HF_TOKEN` | `huggingface` |

</details>

### 4. Configure your target repo

Go to the repo you want pitm to work on and create a config:

```bash
cd path/to/your-project

mkdir -p .pitm
cat > .pitm/config.json <<'EOF'
{
  "models": {
    "planner":  "openrouter/anthropic/claude-sonnet-4.6",
    "worker":   "openrouter/anthropic/claude-sonnet-4.6",
    "fixer":    "openrouter/openai/gpt-5-mini",
    "reviewer": "openrouter/anthropic/claude-sonnet-4.6",
    "verifier": "openrouter/anthropic/claude-sonnet-4.6"
  },
  "verifyCommand": "npm test",
  "git": {
    "targetBranch": "main",
    "autoPush": true,
    "autoMerge": false
  }
}
EOF

echo ".pitm/" >> .gitignore
```

**You must set these two fields for each repo:**

- **`verifyCommand`** — the command that proves the work is correct (`npm test`, `bun run typecheck`, `cargo test`, `pytest`, …). The worker runs this after each task; the verifier runs it again at the end.
- **`git.targetBranch`** — the branch PRs merge into (usually `main` or `master`).

See [`config.example.json`](./config.example.json) for the full schema with all options.

### 5. Run it

```bash
# Check everything is set up correctly
pitm doctor

# Preview the plan (no branch, no PR, no tokens spent on execution)
pitm start "Add a /healthz route that returns 200 OK" --dry-plan

# Run the full pipeline
pitm start "Add a /healthz route that returns 200 OK"
```

That's it. pitm will:
1. **Plan** — read your codebase, produce a task list
2. **Work** — implement each task, run your verify command
3. **Commit & Push** — one commit per task, push to a `pitm/<date>-<slug>` branch
4. **Open a PR** — via `gh pr create`
5. **Fix CI** — if CI fails, a fixer agent reads the logs and pushes a fix
6. **Handle review** — if there are review comments, an agent addresses them
7. **Verify** — a verifier agent checks all success criteria pass
8. **Done** — or halts at `needs_human` if something needs your attention

---

## All Commands

```
pitm start "<goal>"                Full pipeline: plan → work → PR → CI → review → verify
pitm start "<goal>" --dry-plan     Preview the plan only (no side effects)
pitm start "<goal>" --force        Overwrite an existing run
pitm resume                        Continue from saved phase after interruption
pitm status                        Show phase, tasks, PR url, token budget
pitm status --json                 Same as above, structured JSON output
pitm reset                         Delete .pitm/state.json to start fresh
pitm doctor                        Check auth, config, models, gh, git
pitm steer "<message>"             Queue a steering message for the running worker
pitm watch [--port N]              Start HTTP mailbox endpoint (default :7331)
```

---

## Model Configuration Guide

Model refs use the format `"provider/modelId"`. The five phases can each use a different model:

| Phase | Role | Recommended |
|-------|------|-------------|
| `planner` | Reads codebase, produces task list (read-only) | Strong model (Sonnet, GPT-5) |
| `worker` | Implements tasks, runs verify command | Any capable coder |
| `fixer` | Reads CI failure logs, pushes fixes | Fast + cheap |
| `reviewer` | Addresses PR review comments | Strong model |
| `verifier` | Checks success criteria pass (read-only) | Strong model |

**Example configs:**

Using OpenRouter (recommended — one API key for everything):
```json
{
  "models": {
    "planner":  "openrouter/anthropic/claude-sonnet-4.6",
    "worker":   "openrouter/anthropic/claude-haiku-4.5",
    "fixer":    "openrouter/openai/gpt-5-mini",
    "reviewer": "openrouter/anthropic/claude-sonnet-4.6",
    "verifier": "openrouter/anthropic/claude-sonnet-4.6"
  }
}
```

Using direct Anthropic key:
```json
{
  "models": {
    "planner":  "anthropic/claude-sonnet-4-6",
    "worker":   "anthropic/claude-haiku-4-5",
    "fixer":    "anthropic/claude-haiku-4-5",
    "reviewer": "anthropic/claude-sonnet-4-6",
    "verifier": "anthropic/claude-sonnet-4-6"
  }
}
```

Run `pitm doctor` to verify all your model refs resolve correctly.

---

## The Pipeline

```
planning → working (per task) → pr_open → ci_pending → ci_fixing → review → verifying → (merging) → done
                                                                              ↘ needs_human
```

- **Planner** (read-only) explores the repo with `ls`, `read`, `grep`, `find` and emits a strict-JSON task list with success criteria.
- **Worker** (edit-capable) implements each task, runs `verifyCommand`, and the orchestrator commits per task. Mid-run steering messages from the mailbox are delivered via `session.steer()`.
- **CI loop** — `gh pr checks` is polled; on failure a **fixer** session gets the failing logs, pushes a fix, and CI re-runs. Bounded by `maxCiFixRetries`.
- **Review loop** — PR review comments are fetched; a **reviewer** session addresses each, commits, pushes, and CI re-runs. Bounded to 3 rounds.
- **Verifier** (read-only) checks every success criterion against the code + a local verify run, emitting a strict JSON verdict.
- **Merge** — only if `git.autoMerge` is `true`; squashes by default.

At any failing gate the run halts at `needs_human` with an actionable note; `pitm resume` continues once you've fixed the blocker.

---

## Troubleshooting

### `pitm doctor` fails

| Check | Fix |
|-------|-----|
| `pi auth.json` | Set an API key env var or create `~/.pi/agent/auth.json` |
| `model resolution` | Your config model refs don't match any known model. Run `pitm doctor` to see available models |
| `gh auth status` | Run `gh auth login` |
| `git repo` | You're not inside a git repository |
| `config model refs` | A model ref in `.pitm/config.json` is malformed (missing `/`) |

### Run gets stuck

- **`needs_human`** — read `pitm status` for the note. Fix the blocker, then `pitm resume`.
- **Ctrl-C'd mid-run** — state is saved; `pitm resume` continues from the saved phase.
- **Want to start over** — `pitm reset` (or `rm .pitm/state.json`) and run `pitm start` again.
- **Wrong goal** — `pitm reset`, delete the stray `pitm/...` branch, start fresh.

---

## Costs

Every `pitm start` spends real tokens: a planner call plus one worker session per task (plus fixer/reviewer/verifier if it reaches those phases). The `budget.maxTokensPerRun` cap (default 2,000,000) hard-stops runaway runs at `needs_human`.

**Use `--dry-plan` first** to scope the work before spending on execution.

Typical run for a small feature: 30–60k tokens total.

---

## Safety

- `autoMerge` defaults to **false**. Never merges without explicit config + CI + review + verification all passing.
- Per-run token `budget` cuts off runaway workers.
- CI fix retries are bounded (`maxCiFixRetries`); environmental failures are detected and surfaced, not patched.
- Worker/fixer/reviewer never run git/gh — only the orchestrator touches git.
- File lock (`proper-lockfile`) prevents two orchestrators from racing on the same run.
- HTTP mailbox binds to `127.0.0.1` by default; don't expose it publicly.

## Contributing

```bash
bun run typecheck     # must pass — runs tsc --noEmit
```

## License

MIT
