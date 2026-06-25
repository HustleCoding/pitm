---
name: principle-foundational-thinking
description: "Apply before writing logic: choosing core types and data structures, sequencing scaffold-vs-feature work, asking what concurrent actors share. Get the data structures right so downstream code becomes obvious."
disable-model-invocation: true
---

# Foundational Thinking

**Structural decisions** protect option value. **Code-level decisions** protect simplicity.
Over-engineering is often a premature decision that closes doors. The right foundational
data structure keeps doors open.

**Data structures first.** Get the data shape right before writing logic. The right shape
makes downstream code obvious. Define core types early, trace every access pattern, and
choose structures that match the dominant paths. A data-structure change late is a rewrite.
Early, it is often a one-line diff.

At code level, DRY the structure, not every line. Types and data models should converge.
Three similar statements still beat a premature abstraction. Prefer explicit over clever.
Test behavior and edge cases, not line counts.

**Concurrency corollary.** Before sharing state between actors, ask "what happens if another
actor modifies this concurrently?" If not "nothing", isolate.

**Scaffold first.** If something helps every later step, do it first. Ask "does every
subsequent step benefit from this existing?" Shared types and test infrastructure are
scaffold. Sequence for option value: setup before features, tests before fixes.

Subtraction comes before scaffolding: remove dead weight first, then lay foundations.

---

Adapted from [pstack](https://github.com/cursor/plugins/tree/main/pstack) by Lauren Tan.
