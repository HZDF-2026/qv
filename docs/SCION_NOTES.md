# Design notes: qv vs Scion (Anthropic's in-house VCS)

Anthropic published the design and measured results of **Scion**, the in-house version control system behind their monorepo (Oct 2026: [Redesigning source control at Anthropic](https://www.anthropic.com/research/redesigning-source-control)). Scion is not open source, but the published numbers and principles make a rare, high-quality reference point. This page records an honest comparison — including where qv deliberately does *not* chase Scion — and what qv changed as a result.

## Scale disclaimer (read this first)

Scion: ~100 GB main-branch history, ~25 M checkouts/day, 30,000 merges/day, fleet of servers + Spanner + tiered caches. qv: a single-file, zero-dependency, single-machine tool for experiment-scale repos (≤ ~10k files). The two differ by roughly **four orders of magnitude** — what's comparable is the **design principles**, not absolute numbers.

## Where qv already agrees with Scion

| Scion principle | qv |
|---|---|
| Commits must be cheap, incremental, lock-free; branch refs are just a CAS, discouraged as global state | Branch = one pointer, zero-copy; snapshots append to a log, no locks |
| Content-addressed, immutable objects; no packfiles, no repository maintenance | Plaintext SHA-256 object store; `gc` is the only maintenance op |
| Checkout cost must track what you touch, not repo size | Incremental hashing (mtime+size cache); `switch` writes only differing files |
| Verified integrity end-to-end | qv goes further in the small: `verify --deep` re-hashes every object byte-for-byte — a property Scion doesn't publish |

## Scion's measured numbers, for calibration

- CI checkout: 31s → **3.5s**; fresh agent workspace: 7.1 min → **5.1s** (≈100× faster checkouts)
- 200× smaller CPU/memory footprint than their former git mirror fleet
- Cache hit rate > 99% on every tier; qv's equivalents at its own scale: 258-file clone 859ms, rollback 108ms, 10k-file init ~16s, incremental snap (20 edits) ~2s

## Gaps found, and what we did about them

1. **Queries as a first-class surface** — Scion exposes every source-control query via API so jobs don't need a checkout. qv only had `diff` against HEAD. → **Fixed in v1.3**: `qv diff <a> <b>` diffs any two branches/snapshots (`+`/`-`/`~` output). This is the one Scion lesson that clearly applies at qv's scale.

2. **Commit cost must scale with the change, not the repo** — Scion changesets store only files changed relative to the first parent; qv writes a **full manifest** per snapshot (~1MB JSON at 10k files). → **Recorded as an unmet point, deliberately not implemented.** Delta manifests would require chain reconstruction and touch every consumer (switch/merge/export/import/verify) for a benefit that only materializes far beyond qv's target scale. YAGNI until someone actually hits the wall — and if they do, the fix is known.

3. **Sparse / virtualized checkouts** — Scion materializes files on demand. qv restores full diffs. → Not implemented; at experiment scale the whole repo is wanted anyway.

4. **Constant background watching** — Scion's client monitors filesystem changes, so writes cost O(changes) with no scan. qv is a single-shot process; a scan is O(repo) stat, which is the floor for a stateless CLI. A daemon mode would break the zero-install single-file promise. Recorded, not built.

## The takeaway we kept

Scion's deepest lesson isn't any single feature — it's that **tooling built for human scale becomes the bottleneck when agents produce code at machine scale**, and that deleting the properties you don't need (offline autonomy, packfiles, ref ceremonies) is how the wins appear. qv applies the same deletion test at its own scale: no server, no daemon, no refs beyond pointers, no compression between you and your hashes.
