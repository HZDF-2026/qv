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

## 局域网协作（v1.1）

无服务器设计——bundle 文件即传输协议，SMB/scp/U 盘都行：

```
机器 A:  qv export a.qvb              # 打包全部可达对象+快照+分支
机器 B:  qv import a.qvb              # 空目录导入 = clone（自动检出工作区）
机器 B:  ...改代码...  qv snap
机器 B:  qv merge feature-a            # 共同历史 → 正常三方合并
```

- **防投毒**：import 对每个对象全量重哈希，声称哈希≠实际内容直接拒绝整个 bundle。
- **无关历史**：两个独立 `init` 的仓库合并（无共同祖先）按整文件冲突处理（同 git unrelated histories 语义），有测试钉死该行为。
- **幂等**：重复 import 相同对象自动跳过；分支名冲突自动改名 `<branch>-peer`。

## 实测基准（Windows / Node 24 / NVMe，见 test/）

| 操作 | 耗时 |
|---|---|
| init 2000 文件（~4MB） | 1.9s |
| 增量 snap（10 文件改动） | 0.35s |
| verify --deep（全库重哈希） | 0.72s |
| batch-merge 30 分支 | 0.93s |

## 测试

```bash
node test/run-tests.js          # 15 项基础 e2e（含冲突/批量合并/篡改检测/基准）
node test/industrial-suite.js   # 17 项工业套件（单元/跨仓往返/安全/边界/压力/幂等）
```

工业套件覆盖：diff3 与路径穿越**单元测试**、export/import 往返与 clone、篡改 bundle 拒绝、伪 bundle 拒绝、恶意 manifest 路径穿越防护、空文件/二进制/中文名/5MB 大文件/深层目录边界、**万文件仓库**、**200 分支批量合并**、300 深链、gc 幂等与 drop 可追溯。全部 32 项绿。

## 诚实的局限（v1.1 有意不做）

- **局域网 bundle 协作**而非常驻服务器：无自动同步/推送钩子——bundle 导出导入是显式动作（这在恶意内网中是特性不是缺陷）。
- 行级合并用 LCS，超大文件（>5k 行双侧）退化为整文件冲突标记。
- 无 rename 检测、无子模块、无 packfile——对象库明文优先保证可验证性，牺牲磁盘占用。
- 适合：AI agent 并行实验区、个人快速原型场、大批量自动化变更线、小团队局域网协作。不适合：公网分布式团队协作（那仍然是 git 的地盘）。

## License

MIT
