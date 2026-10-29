# Field Trial: qv reviewed and hardened with an external AI agent

qv's positioning claims are not written by its author — they were **field-tested by an independent AI coding agent** running in a different harness, which used qv on its own working project, reported real defects, and reviewed every fix. This page is the sanitized record of that loop (identities, paths and unrelated project details removed).

## Round 1 — v1.1 trial, honest positioning

The reviewing agent was given a tryout card (init → experiment lines → merge → batch-merge → verify → bundle) and asked to be blunt. Its verdict, quoted (sanitized):

> "Worth using, but the positioning must be accurate."

| Scenario | Use qv? (agent's own table) |
|---|---|
| Put version control on an unversioned codebase ("52 bare py files so far") | ✅ strongly recommended — zero-cost safety net |
| Snap before editing, switch back in one second | ✅ **its strongest suit** |
| Hand off current state as one `.qvb` file | ✅ most convenient |
| Parallel experiment lines touching the same files, batch-merged | ⚠️ frequent whole-file conflicts |
| Public release history / internet collaboration | ❌ stays with git |

Two hard defects were reported:

1. **Conflict granularity was whole-file, not line-level** — two branches editing different ends of the same file still conflicted, discounting the flagship batch-merge for its actual workflow (many experiments on shared files).
2. **No ignore rules** — no `.qvignore`, no built-in exclusions; a 46MB sqlite file and `dist/` would go straight into the object store.

## Round 2 — v1.2: both defects fixed at the root

- The 3-way merge was rewritten as **chunk-based diff** (LCS match pairs → gap chunks): deletions no longer misalign into phantom conflicts; same-file experiments in different regions merge cleanly; only genuinely overlapping edits conflict. A same-point-insertion bug that *silently concatenated* both sides (worse than a conflict) was found and pinned by a unit test.
- **`.qvignore`** (gitignore-style subset) plus built-in defaults (`node_modules/`, `__pycache__/`), with a guard so `switch` never deletes ignored-but-tracked files from the workdir.

The agent then reported a subtle trap from its own environment:

> "PS 5.1 `Set-Content -Encoding UTF8` prepends a BOM, which silently killed the first ignore rule."

Fixed at the read side (v1.2.1): qv strips the BOM on load, so *any* editor is safe — a writing convention alone would have left the trap armed for the next person.

## Round 3 — v1.2.3: real deployment finds what test suites miss

qv was then deployed on a real 258-file C++17 project (12.8MB). Despite a fully green 37-test suite, **the first live run surfaced two defects the tests never covered**:

1. Unreadable system directories (`System Volume Information`) crashed the scanner → replaced with a tolerant recursive walk.
2. **Out-of-band edits defeated the safety net**: an edit made outside qv survived `switch` (the manifest cache said "unchanged") and then poisoned the cache so `diff` reported "clean" on a broken workdir. Restores now stat-verify file sizes on disk instead of trusting the cache — pinned by regression test R2.

Live numbers from that deployment: init 258 files 3.7s · verify --deep 260 objects 136ms · rollback 108ms · 16.9MB bundle export 146ms / clone 859ms.

## Outcome

The reviewing agent confirmed the two reported shortfalls were eliminated in its own scenarios, adopted qv into its daily workflow (safety-net snapshots before risky edits), and expressed satisfaction with the fix loop — each of its three field reports became a shipped, test-pinned fix within the same day.

**The point of this record**: a green test suite is not the same as a safe tool. Everything on this page was found by *use*, not by us.
