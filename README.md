# qv — quick-experiment VCS

**Snapshot-model version control for AI-scale experimentation.** 面向代码快速实验与大批量合并的快照模型版本控制——单文件、零依赖、SHA-256 内容寻址、可验证安全。

```
$ qv branch exp42          # 零拷贝开实验线
$ qv switch exp42          # 只写差异，秒切
$ ... 改代码 ...
$ qv snap -m "尝试A"        # 增量快照（只哈希改动过的文件）
$ qv switch main
$ qv batch-merge           # 一条命令级联合并所有实验分支，冲突自动跳过留报告
批量合并 30 个分支: ...  耗时 933ms
```

## 为什么不是 git

git 为人类协作设计；qv 为 **AI agent 级别的实验吞吐**设计：

| 痛点 | git | qv |
|---|---|---|
| 开 30 条实验线 | worktree 重量级/分支切换全树 IO | `branch` 零拷贝（分支=指针） |
| 切换实验 | 重写整个工作区 | 只写差异文件 |
| 大批量合并 | 逐个 rebase/merge 手工操作 | `batch-merge` 级联+冲突跳过+报告 |
| 存储完整性 | zlib 对象流，尾部垃圾可被静默忽略 | **明文内容寻址：sha256(文件字节)==键，`verify` 检出任何字节篡改** |
| 哈希 | SHA-1（迁移中） | SHA-256，全套（快照/树/blob） |
| 丢弃实验 | ref+reflog 结构纠缠 | `drop` 一条引用，reflog 可追溯，`gc` 收孤儿 |
| 上手 | 概念多 | 单文件 ~400 行核心，读得完 |

## 设计

- **快照模型**：每次 `snap` 把工作区 manifest（路径→内容哈希）存为不可变对象；分支只是指向快照的指针——实验成本 O(1)。
- **增量哈希**：mtime+size 未变的文件沿用缓存哈希，快照开销正比于改动量而非仓库规模。
- **三方合并**：LCA → 文件级（单侧改动自动采纳）→ 行级（双侧改动 LCS 三方，冲突写 `<<<<<<<` 标记不阻塞）。
- **安全**：对象库明文存储，`verify [--deep]` 对快照/树/blob 全量重哈希——任何存储层篡改（哪怕 zlib 时代的"尾部追加"技巧）直接 FAIL。追加式 snapshots.jsonl + reflog，drop 可追溯。
- **低开销**：对象去重（相同内容全局只存一份）、并发哈希（32 路）、restore 只写差异。

## 快速开始（Node >= 20，无依赖）

```bash
node qv.js init                       # 初始化并打基线快照
node qv.js snap -m "msg"              # 增量快照
node qv.js branch exp1                # 开实验线（零拷贝）
node qv.js switch exp1                # 切换（分支名或快照短哈希均可）
node qv.js merge exp1 [--into=main]   # 三方合并（冲突标记制）
node qv.js batch-merge [pattern...]   # 批量级联合并（冲突分支跳过并列出）
node qv.js verify --deep              # 全库 Merkle 校验
node qv.js gc / drop <br> / log / diff / status
```

## 实测基准（Windows / Node 24 / NVMe，见 test/run-tests.js）

| 操作 | 耗时 |
|---|---|
| init 2000 文件（~4MB） | 1.9s |
| 增量 snap（10 文件改动） | 0.35s |
| verify --deep（全库重哈希） | 0.72s |
| batch-merge 30 分支 | 0.93s |

## 测试

```bash
node test/run-tests.js   # 15 项 e2e：含冲突合并、批量合并、篡改检测、基准
```

## 诚实的局限（v1 有意不做）

- **单机工具**：无远端同步/网络协作——要协作的地方仍然是 git 的地盘（qv 与 git 可共存，qv 管实验，git 管对外历史）。
- 行级合并用 LCS，超大文件（>5k 行双侧）退化为整文件冲突标记。
- 无 rename 检测、无子模块、无 packfile——对象库明文优先保证可验证性，牺牲磁盘占用。
- 适合：AI agent 并行实验区、个人快速原型场、大批量自动化变更线。不适合：团队协作仓库、巨型二进制资产库。

## License

MIT
