# Bundled skills

These are [pi agent skills](https://agentskills.io/specification) that pitm can load into
the worker, CI-fixer, and reviewer phases so the agent applies rigorous engineering
discipline instead of churning out slop. They are **opt-in**.

## Enable

```bash
pitm config set skills.enabled true
```

Or in `.pitm/config.json`:

```json
{
  "skills": {
    "enabled": true,
    "includeBundled": true,
    "paths": []
  }
}
```

- `enabled` — master switch (default `false`).
- `includeBundled` — load the skills shipped in this directory (default `true`).
- `paths` — extra skill directories (absolute, or relative to the target repo). A repo's
  own `.pitm/skills/` directory is always loaded when `enabled` is `true`.

When enabled, the pi SDK appends each model-invocable skill's name + description to the
phase system prompt and registers it as a `/skill:name` command. The agent reads the full
`SKILL.md` on demand (progressive disclosure), so the prompt stays small.

## What's bundled

| Skill | Role |
|-------|------|
| `pitm-rigor` | Router. Names the data shape first, smallest diff, prove it works, fix root causes. The only model-invocable skill; it points at the principle leaves below. |
| `principle-foundational-thinking` | Get the data structures right before writing logic. |
| `principle-laziness-protocol` | Prefer deletion; smallest change that solves the problem. |
| `principle-minimize-reader-load` | Collapse needless layers; shrink mutable state. |
| `principle-prove-it-works` | Verify against the real artifact, not "it compiles". |
| `principle-fix-root-causes` | Reproduce, trace to the root, don't silence symptoms. |

## Attribution

Adapted from [**pstack**](https://github.com/cursor/plugins/tree/main/pstack) by
Lauren Tan ([@poteto](https://x.com/poteto)), a Cursor plugin of rigorous agent
workflows. The bundled set is a curated, trimmed subset: pstack skills that assume
Cursor-only features (subagents, `/loop`, multi-model review panels, `cursor-team-kit`)
are intentionally omitted because a single pi session per pitm phase can't run them.
Drop your own `SKILL.md` directories into `.pitm/skills/` (or a `paths` entry) to extend.
