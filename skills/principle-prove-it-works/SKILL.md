---
name: principle-prove-it-works
description: "Apply after completing a task, before declaring done. Verify against the real artifact (run the verify command, exercise the feature, read the actual value), not a proxy, self-report, or 'it compiles.'"
disable-model-invocation: true
---

# Prove It Works

Verify every task output by checking the real thing directly. Do not infer from proxies,
self-reports, or "it compiles."

**Why:** Unverified work has unknown correctness. Indirect verification (file mtimes, output
freshness, self-reports) feels cheaper than direct observation. Acting on a wrong inference
costs far more than checking the source.

**Pattern:** After completing any task, ask: "how do I prove this actually works?"

Code and features:
1. Build / typecheck it (necessary but not sufficient).
2. Run the project's verify command and exercise the actual changed path.
3. Check the full chain: does data flow from input to output?
4. For integrations, test the full communication path end-to-end.

When verification fails, suspect the observation method before suspecting the system.

## Script the check when you can

The strongest proof is a deterministic command that re-runs the same comparison, not a
one-time eyeball. The project's verify command is exactly that — run it and make it pass,
and keep its output as the artifact a reviewer can re-run instead of trusting your word.

---

Adapted from [pstack](https://github.com/cursor/plugins/tree/main/pstack) by Lauren Tan.
