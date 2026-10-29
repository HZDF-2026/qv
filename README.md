# qv — quick-experiment VCS

**Snapshot-model version control for fast, safe experimentation.** Single file, zero dependencies, SHA-256 content-addressed, tamper-detecting. Built for the workflow "snap before you edit, roll back in one second, hand off as one file."

```
$ qv snap -m "before refactor"      # incremental snapshot (hash only what changed)
$ ...edit...                         # break something?
$ qv switch <snapshot>               # back in one second, only touched files rewritten
$ qv export handoff.qvb              # whole project state as ONE file for a colleague
```

## Where qv shines — and where it doesn't (field-tested)

| Scenario | Use qv? |
|---|---|
| Put version control on an unversioned codebase (no git yet) | ✅ **Strongly recommended** — zero-config safety net |
| Snap before editing, one-second rollback when you break it | ✅ **Its strongest suit** |
| Hand current state to a colleague/customer as one file | ✅ `export` makes a single self-contained `.qvb` |
| Many parallel experiment lines touching the **same files**, batch-merged | ⚠️ v1.2 merges **different regions of the same file cleanly** (chunk-level 3-way); only genuinely overlapping edits (same region, both sides) conflict |
| Public release history / internet collaboration | ❌ Use git — qv deliberately doesn't do this |

## Why not just git

git is designed for human collaboration and public history; qv is designed for **throughput of local experiments**:

- Branches are pointers — creating/switching experiment lines is zero-copy and diffs-only.
- `snap` hashes only changed files (mtime+size cached), so snapshot cost tracks your edit size, not repo size.
- `batch-merge` cascades N experiment branches in one command; conflicting branches are skipped and reported.
- The object store is **plaintext, SHA-256 content-addressed**: `qv verify --deep` re-hashes snapshots/trees/blobs and catches **any byte-level tampering** (zlib-style stream-append tricks don't work here — that's why we don't compress objects).
- Appended-only `snapshots.jsonl` + reflog: `drop` is traceable, `gc` collects orphans.

## Quick start (Node >= 20, zero deps)

```bash
node qv.js init                       # initialize + baseline snapshot
node qv.js snap -m "msg"              # incremental snapshot
node qv.js branch exp1                # open an experiment line (zero-copy)
node qv.js switch exp1                # switch (branch name or snapshot short-hash)
node qv.js merge exp1 [--into=main]   # 3-way merge (LCA → file → line level)
node qv.js batch-merge [pattern...]   # cascade-merge all experiment branches
node qv.js verify --deep              # full Merkle audit
node qv.js export f.qvb / import f.qvb  # LAN handoff; import into empty dir = clone
node qv.js gc / drop <br> / log / diff / status
```

## LAN collaboration (v1.1) — bundle files as the protocol

```
Machine A:  qv export a.qvb
Machine B:  qv import a.qvb        # empty dir → clone (workdir auto-checked-out)
Machine B:  ...edit... qv snap; qv merge feature-a
```

Poison-proof: every object is re-hashed on import — a mismatched hash rejects the whole bundle. Unrelated histories merge as whole-file conflicts (like git). Branch name clashes auto-rename to `<branch>-peer`. Re-imports are idempotent.

## Benchmarks (Windows / Node 24 / NVMe, see test/)

| Operation | Time |
|---|---|
| init 2,000 files (~4MB) | 1.9s |
| incremental snap (10 files changed) | 0.35s |
| verify --deep (full re-hash) | 0.72s |
| batch-merge 30 branches | 0.93s |
| stress: init 10,000 files / 200-branch batch-merge | 16s / 3.2s |

## Tests — 36 green

```bash
node test/run-tests.js          # 15 e2e (conflicts, batch-merge, tamper detection, benchmarks)
node test/industrial-suite.js   # 21 industrial (units, cross-repo roundtrip, poison rejection,
                                #  path traversal, boundaries, 10k-file stress, 300-deep chains,
                                #  chunk-merge units, rename merge, .qvignore)
```

## v1.2 — merge & hygiene upgrades (from field feedback)

> The full sanitized field-trial record — an external AI agent's review, its reported defects, and the fixes — is in [docs/FIELD_TRIAL.md](docs/FIELD_TRIAL.md).

- **Chunk-level 3-way merge**: real conflicts require genuinely overlapping edits at the same region — same-file experiments touching different parts now merge cleanly (deletions no longer misalign into phantom conflicts).
- **Rename detection**: one side renames a file, the other edits it → the edit migrates to the new path instead of being lost.
- **`.qvignore`** (gitignore-style subset): keeps 46MB sqlite files, `dist/`, caches out of the object store. Built-in minimum defaults: `node_modules/`, `__pycache__/`. Ignored-but-previously-tracked files are never deleted from your workdir by `switch`.

Patch releases (same field-trial loop):
- **v1.2.1** — BOM stripped from `.qvignore` on load (PowerShell 5.1/Notepad UTF-8 trap disarmed at the read side).
- **v1.2.2** — real-deployment hardening: tolerant walk past permission-denied system dirs; restores stat-verify disk sizes instead of trusting the manifest cache (out-of-band edits can no longer survive `switch`). Single source of version truth: `qv --version`.

## v1.3 — any-snapshot diff (from Scion comparison)

`qv diff <a> <b>` now diffs any two branches/snapshots (`+`/`-`/`~`), filling qv's biggest query gap. Born from an honest comparison against Anthropic's internal VCS — the full analysis, including the unmet points we deliberately record instead of build (delta manifests, sparse checkouts, daemon mode), is in [docs/SCION_NOTES.md](docs/SCION_NOTES.md).

## v1.4 — big files & cross-machine sync

**Chunked storage for big files (>64MB auto-chunked at 8MB, for AI checkpoints / model weights up to ~100GB):**
- Byte-level dedup across snapshots — editing one byte of a 70MB file adds ~1 chunk instead of a whole new blob (measured: 3 objects).
- `verify --deep` audits every chunk; restores are streamed (big files never fully load into memory).
- Big-file merges are deliberately whole-file: both-sides edits conflict, ours kept (no in-memory line merge of a 10GB file).

**Cross-machine sync — `qv push / qv pull <user@host:dir>`:**
- Runs over the system `ssh`/`scp` (zero npm dependencies); if the remote has no qv, the tool pushes itself over first.
- Same-path local mode (`qv push ../other-repo`) covers same-machine repos and CI loops.
- Other transports stay available because the `.qvb` bundle is one portable file (rsync, HTTP, sneakernet all work).

## Honest limitations

- LAN bundle sync is **explicit** (no server, no auto-push) — a feature in hostile networks.
- Line merges use LCS; very large files (>5k lines both sides) degrade to whole-file conflict markers.
- No submodules, no packfile — the object store is plaintext to keep `verify` byte-exact.
- Note: `switch <old-snapshot>` followed by `snap` moves the branch head there (snapshot semantics, like git reset).

## Résumé (Français)

**qv** est un système de contrôle de versions à modèle d'instantanés, conçu pour l'expérimentation rapide : branches sans copie, instantanés incrémentaux (seuls les fichiers modifiés sont hachés), retour arrière en une seconde, fusion en cascade de multiples branches, et vérification d'intégrité SHA-256 qui détecte toute falsification au niveau de l'octet. Un seul fichier, zéro dépendance (Node ≥ 20). Pour la publication publique et la collaboration sur Internet, restez sur git — qv est fait pour l'expérimentation locale et la transmission par fichier unique sur le réseau local.

## License

MIT

---

<details>
<summary><b>中文说明（Chinese）</b></summary>

# qv — 快照模型 VCS

面向代码快速实验与安全回滚的快照模型版本控制——单文件、零依赖、SHA-256 内容寻址、可验证防篡改。

## 实测定位（来自外部 Agent 试驾反馈）

| 场景 | 用不用 qv |
|---|---|
| 给没有版本管理的仓库上保险（连 git 都没有的裸奔项目） | ✅ 强烈建议——零成本安全网 |
| 改前 snap、改坏 switch 秒回滚 | ✅ **最强场景** |
| 把当前状态 export 一个 .qvb 给客户/同事 | ✅ 单文件最方便 |
| 同一文件并行开多条实验线再批量合并 | ⚠️ v1.2 已支持**同文件不同区域干净合并**（chunk 级三方）；只有真重叠（同区域双侧都改）才冲突 |
| 对外发布历史 / 公网协作 | ❌ 仍用 git（qv 有意不做） |

## 快速开始（Node >= 20，零依赖）

```bash
node qv.js init                       # 初始化并打基线快照
node qv.js snap -m "msg"              # 增量快照（只哈希改动文件）
node qv.js branch exp1                # 零拷贝开实验线
node qv.js switch exp1                # 切换（分支名或快照短哈希均可）
node qv.js merge exp1 [--into=main]   # 三方合并（冲突写标记不阻塞）
node qv.js batch-merge [pattern...]   # 批量级联合并（冲突分支跳过并报告）
node qv.js verify --deep              # 全库 Merkle 校验（防篡改）
node qv.js export f.qvb / import f.qvb  # 局域网交付；空目录 import = clone
node qv.js gc / drop <br> / log / diff / status
```

## 安全设计

- 对象库**明文存储、SHA-256 内容寻址**：`verify --deep` 对快照/树/blob 全量重哈希，任何字节级篡改直接 FAIL（zlib 流尾部追加那类技巧在本库无效——这正是我们不压缩对象的原因）。
- bundle 导入对每个对象全量重哈希防投毒；路径穿越（`../`、盘符、空字节）全部拒绝。
- 追加式 `snapshots.jsonl` + reflog：drop 可追溯，gc 收孤儿。

## 实测基准（Windows / Node 24 / NVMe）

init 2000 文件 1.9s / 增量 snap 0.35s / verify --deep 0.72s / batch-merge 30 分支 0.93s；压力：万文件 init 16s、200 分支批量合并 3.2s。

## 测试：32 项全绿

`node test/run-tests.js`（15 项基础 e2e）+ `node test/industrial-suite.js`（17 项工业套件：单元、跨仓往返、防投毒、路径穿越、边界、压力、幂等）。

## 局限（诚实声明）

- 局域网 bundle 协作是显式动作（无服务器无自动推送——恶意内网中这是特性）。
- 行级合并用 LCS，超大文件退化为整文件冲突标记。
- 无 rename 检测/子模块/packfile——可验证性优先于磁盘占用。
- `switch 旧快照` 后 `snap` 会移动分支头（快照语义，类似 git reset）。

## License

MIT
</details>
