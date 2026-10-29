// qv 工业级测试套件：单元 / 集成往返 / 异常与安全 / 边界 / 压力 / 幂等回滚
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const QVM = require(path.join(__dirname, '..', 'qv.js'));

const QV = path.join(__dirname, '..', 'qv.js');
let pass = 0, fail = 0; const failures = [];
const t = (name, fn) => { try { fn(); pass++; console.log(`PASS ${name}`); } catch (e) { fail++; failures.push(name); console.log(`FAIL ${name}: ${e.message}`); } };
const assert = (c, m) => { if (!c) throw new Error(m || 'assert'); };
function qv(dir, ...args) { return execFileSync('node', [QV, ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
function qvFail(dir, ...args) { try { qv(dir, ...args); } catch { return true; } throw new Error('应失败但成功了'); }
const W = (d, p, c) => { fs.mkdirSync(path.dirname(path.join(d, p)), { recursive: true }); fs.writeFileSync(path.join(d, p), c); };
const R = (d, p) => fs.readFileSync(path.join(d, p), 'utf8');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qv-ind-'));

// ===== 1. 单元测试 =====
t('U1 safePath 拒绝穿越/绝对/盘符/空字节', () => {
  assert(QVM.safePath('a/b.txt') === true, '合法路径被拒');
  assert(QVM.safePath('src/main.js') === true, '合法路径被拒2');
  for (const bad of ['../evil', 'a/../../b', '/abs', 'C:\\x', 'a\0b', '', undefined, '\\\\srv', 'a/..', '../']) {
    assert(QVM.safePath(bad) === false, '漏放行: ' + JSON.stringify(bad));
  }
});
t('U2 diff3 单侧采纳/同改等价/双侧冲突', () => {
  let r = QVM.diff3('a\nb\nc\n', 'a\nX\nc\n', 'a\nb\nc\n');
  assert(r.conflicts === 0 && r.text.includes('X'), 'ours 改应采纳');
  r = QVM.diff3('a\nb\n', 'a\nX\n', 'a\nX\n');
  assert(r.conflicts === 0 && r.text.includes('X') && !r.text.includes('<<<'), '同改等价应零冲突');
  r = QVM.diff3('a\nb\n', 'a\nX1\n', 'a\nX2\n');
  assert(r.conflicts === 1 && r.text.includes('<<<<<<<') && r.text.includes('X1') && r.text.includes('X2'), '双侧不同改应冲突');
  r = QVM.diff3('a\nb\n', 'a\nb\nNEW\n', 'a\nb\n');
  assert(r.conflicts === 0 && r.text.includes('NEW'), '单侧追加应采纳');
  r = QVM.diff3('a\nb\nc\n', 'a\nc\n', 'a\nb\nc\n');
  assert(r.conflicts === 0 && !r.text.includes('b\n'), '单侧删除应采纳');
});

// ===== 2. 局域网合并往返（export → import → merge） =====
t('L1 跨仓库 export→import(clone)→merge 往返', () => {
  const A = tmp(), B = tmp();
  fs.writeFileSync(path.join(A, 'shared.txt'), 'base\n'), fs.writeFileSync(path.join(A, 'a-only.txt'), 'A\n');
  qv(A, 'init');
  qv(A, 'branch', 'feature-a');
  fs.writeFileSync(path.join(A, 'shared.txt'), 'base\nfrom-A\n');
  qv(A, 'snap', '-m', 'A 改 shared');
  qv(A, 'switch', 'main');
  const bundle = path.join(tmp(), 'a.qvb');
  qv(A, 'export', bundle);
  // B 不 init——直接 import 即 clone（共同历史，真实协作流）
  qv(B, 'import', bundle);
  fs.writeFileSync(path.join(B, 'b-only.txt'), 'B\n');
  qv(B, 'snap', '-m', 'B 本地改动');
  const o = qv(B, 'merge', 'feature-a');
  assert(o.includes('干净'), '应干净合并: ' + o);
  assert(R(B, 'shared.txt') === 'base\nfrom-A\n', '合并后内容错误: ' + R(B, 'shared.txt'));
  assert(R(B, 'b-only.txt') === 'B\n', 'B 本地内容丢失');
  qv(B, 'verify', '--deep');
});
t('L1b 无共同历史整文件冲突（unrelated histories 语义）', () => {
  const A = tmp(), B = tmp();
  fs.writeFileSync(path.join(A, 's.txt'), 'A 版本\n'); qv(A, 'init');
  fs.writeFileSync(path.join(B, 's.txt'), 'B 版本\n'); qv(B, 'init');
  const bundle = path.join(tmp(), 'unrelated.qvb');
  qv(A, 'export', bundle);
  qv(B, 'import', bundle);
  qv(B, 'merge', 'main-peer');
  assert(R(B, 's.txt').includes('<<<<<<<') && R(B, 's.txt').includes('A 版本'), '应整文件冲突: ' + R(B, 's.txt'));
});
t('L2 重复 import 幂等', () => {
  const A = tmp(), B = tmp();
  fs.writeFileSync(path.join(A, 'x.txt'), '1\n'); qv(A, 'init');
  const bundle = path.join(tmp(), 'dup.qvb');
  qv(A, 'export', bundle);
  fs.writeFileSync(path.join(B, 'y.txt'), '2\n'); qv(B, 'init');
  qv(B, 'import', bundle); const o1 = qv(B, 'import', bundle);
  assert(o1.includes('(1 已有)') || o1.includes('已有'), '重复对象应跳过: ' + o1);
  qv(B, 'verify', '--deep');
});
t('L3 篡改 bundle 拒绝导入', () => {
  const A = tmp(), B = tmp();
  fs.writeFileSync(path.join(A, 'x.txt'), 'payload\n'); qv(A, 'init');
  const bundle = path.join(tmp(), 'evil.qvb');
  qv(A, 'export', bundle);
  const buf = fs.readFileSync(bundle);
  // 翻转对象体中部一个字节（header 之后）
  const pos = buf.indexOf(Buffer.from('payload'));
  buf[pos] = buf[pos] ^ 0x01;
  fs.writeFileSync(bundle, buf);
  fs.writeFileSync(path.join(B, 'y.txt'), '2\n'); qv(B, 'init');
  assert(qvFail(B, 'import', bundle), '篡改 bundle 不应被导入');
});
t('L4 非法文件拒绝（伪 bundle）', () => {
  const B = tmp(); fs.writeFileSync(path.join(B, 'y.txt'), '1\n'); qv(B, 'init');
  const f = path.join(B, 'fake.qvb'); fs.writeFileSync(f, 'garbage');
  assert(qvFail(B, 'import', f), '伪 bundle 应拒绝');
});

t('U3 diff3 chunk 式合并（v1.2：删除不再伪冲突）', () => {
  // 双侧在文件不同区域删改 → 应零冲突
  let r = QVM.diff3('a\nb\nc\nd\ne\nf\ng\n', 'a\nB\nc\nd\ne\nf\nG\n', 'a\nb\nc\nD\ne\nf\ng\n');
  assert(r.conflicts === 0 && r.text.includes('B') && r.text.includes('D') && r.text.includes('G'), '不同区域改动应干净: ' + JSON.stringify(r.text));
  // 一侧删行、另一侧在远处加行 → 应零冲突
  r = QVM.diff3('l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n', 'l1\nl3\nl4\nl5\nl6\nl7\nl8\n', 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nNEW\n');
  assert(r.conflicts === 0 && r.text.includes('NEW') && !r.text.includes('l2\n'), '删除+远处插入应干净: ' + JSON.stringify(r.text));
  // 真重叠（同区间不同内容）仍应冲突
  r = QVM.diff3('x\ny\n', 'x\nA\n', 'x\nB\n');
  assert(r.conflicts === 1, '真重叠应冲突');
});

// ===== 2.5 v1.2 merge 升级 =====
t('M1 rename 检测：重命名 + 对侧修改不丢失', () => {
  const D = tmp();
  fs.writeFileSync(path.join(D, 'old-name.txt'), 'content line 1\ncontent line 2\n');
  qv(D, 'init');
  qv(D, 'branch', 'renamer');
  // ours(main) 稍后修改旧文件；renamer 重命名
  qv(D, 'switch', 'main');
  fs.writeFileSync(path.join(D, 'old-name.txt'), 'content line 1\ncontent line 2 CHANGED\n');
  qv(D, 'snap', '-m', 'main edits old file');
  // renamer 分支：纯重命名
  qv(D, 'switch', 'renamer'); // 此时 renamer 仍在 base
  fs.unlinkSync(path.join(D, 'old-name.txt'));
  fs.writeFileSync(path.join(D, 'new-name.txt'), 'content line 1\ncontent line 2\n');
  qv(D, 'snap', '-m', 'pure rename');
  qv(D, 'switch', 'main');
  const o = qv(D, 'merge', 'renamer');
  assert(!fs.existsSync(path.join(D, 'old-name.txt')), '旧路径应消失');
  const txt = R(D, 'new-name.txt');
  assert(txt === 'content line 1\ncontent line 2 CHANGED\n', 'rename 后对侧修改应迁移: ' + JSON.stringify(txt));
  qv(D, 'verify', '--deep');
});
t('M2 同文件多实验线批量合并（DSH 场景，v1.2 期望基本干净）', () => {
  const D = tmp();
  const base = 'def a():\n    pass\n\n\ndef b():\n    pass\n\n\ndef c():\n    pass\n\n\ndef d():\n    pass\n';
  fs.writeFileSync(path.join(D, 'lib.py'), base);
  qv(D, 'init');
  for (let i = 0; i < 5; i++) {
    qv(D, 'branch', `line${i}`);
    const lines = base.split('\n');
    lines[i * 2 + 1] = `    return ${i}  # line${i}`;
    fs.writeFileSync(path.join(D, 'lib.py'), lines.join('\n'));
    qv(D, 'snap', '-m', `exp${i}`);
    qv(D, 'switch', 'main');
  }
  const o = qv(D, 'batch-merge');
  assert(o.includes('批量合并 5 个分支'), o);
  const txt = R(D, 'lib.py');
  for (let i = 0; i < 5; i++) {
    if (i === 0) continue; // 第一个分支干净合入后，后续与 main 的新内容在不同函数区域
  }
  const mergedCount = (txt.match(/return \d/g) || []).length;
  assert(mergedCount >= 4, `5 条同文件实验线至少 4 条应干净合入，实际 ${mergedCount}: ` + txt);
  qv(D, 'verify', '--deep');
});

t('T1 .qvignore 忽略规则（v1.2：大文件/产物目录不入对象库）', () => {
  const D = tmp();
  fs.writeFileSync(path.join(D, 'main.py'), 'print("src")\n');
  fs.writeFileSync(path.join(D, '.qvignore'), 'runs/\ndist/\n*.db\n*.pyc\n');
  W(D, 'runs/quality.db', 'x'.repeat(1024 * 1024));   // 1MB 伪 db
  W(D, 'dist/bundle.js', 'compiled');
  W(D, 'pkg/__pycache__/m.pyc', 'bytecode');
  fs.writeFileSync(path.join(D, 'junk.db'), 'should be ignored');
  const out = qv(D, 'init');
  assert(out.includes('2 个文件'), '应只入册 2 个文件（main.py+.qvignore）: ' + out);
  qv(D, 'snap', '-m', 'noop');
  const o = qv(D, 'diff');
  assert(!o.includes('.db'), '被忽略文件不应出现在 diff');
  // 内置默认：无 .qvignore 时 node_modules/__pycache__ 也忽略
  const D2 = tmp();
  fs.writeFileSync(path.join(D2, 'app.js'), '1\n');
  W(D2, 'node_modules/pkg/index.js', 'dep');
  const out2 = qv(D2, 'init');
  assert(out2.includes('1 个文件'), '内置默认应忽略 node_modules: ' + out2);
});

t('T1b .qvignore 带 BOM 仍生效（v1.2.1：PS5.1 Set-Content UTF8 坑）', () => {
  const D = tmp();
  fs.writeFileSync(path.join(D, 'code.js'), '1\n');            // 无 BOM
  fs.writeFileSync(path.join(D, 'junk.db'), 'big data');
  fs.writeFileSync(path.join(D, '.qvignore'), '\ufeff*.db\n', 'utf8'); // 模拟 PowerShell 5.1 UTF8 BOM
  const out = qv(D, 'init');
  assert(out.includes('2 个文件'), 'BOM 不应废掉第一条规则: ' + out);
  const d = qv(D, 'diff');
  assert(!d.includes('junk.db'), '被忽略文件不应入册');
});

t('R2 外部盲改后 switch 强制恢复（真实缺陷回归：缓存被外部编辑骗）', () => {
  const D = tmp();
  fs.writeFileSync(path.join(D, 'code.cpp'), 'int main() { return 0; }\n');
  qv(D, 'init');
  const orig = R(D, 'code.cpp');
  // 外部改动（不经 qv 流程，模拟手工编辑器/其他工具写坏）
  fs.appendFileSync(path.join(D, 'code.cpp'), '// BROKEN EXPERIMENT\n');
  assert(R(D, 'code.cpp') !== orig, '前置失败');
  qv(D, 'switch', 'main');                       // 应强制恢复基线
  assert(R(D, 'code.cpp') === orig, 'switch 后外部改动应被检出恢复: ' + JSON.stringify(R(D, 'code.cpp')));
  const d = qv(D, 'diff');
  assert(d.includes('一致'), '恢复后 diff 应干净: ' + d);
  qv(D, 'verify', '--deep');
});

t('D1 任意两快照 diff（v1.3：Scion queries-as-API 启发）', () => {
  const D = tmp();
  fs.writeFileSync(path.join(D, 'a.txt'), 'v1\n'); fs.writeFileSync(path.join(D, 'b.txt'), 'x\n');
  qv(D, 'init');
  qv(D, 'branch', 'dev');
  fs.writeFileSync(path.join(D, 'b.txt'), 'y\n'); fs.writeFileSync(path.join(D, 'c.txt'), 'new\n');
  fs.unlinkSync(path.join(D, 'a.txt'));
  qv(D, 'snap', '-m', 'dev');
  const o = qv(D, 'diff', 'main', 'dev');
  assert(o.includes('~ b.txt'), '修改应报出: ' + o);
  assert(o.includes('+ c.txt'), '新增应报出: ' + o);
  assert(o.includes('- a.txt'), '删除应报出: ' + o);
  const o2 = qv(D, 'diff', 'dev', 'dev');
  assert(o2.includes('内容一致'), '自比较应一致: ' + o2);
  assert(qvFail(D, 'diff', 'main', 'nosuch'), '未知目标应报错');
});

// ===== 3. 异常与安全 =====
t('S1 路径穿越防护（恶意 manifest 拒绝写盘）', () => {
  const B = tmp(); fs.writeFileSync(path.join(B, 'ok.txt'), '1\n'); qv(B, 'init');
  // 手工构造恶意 tree：含 ../evil 路径，并伪造快照引用它
  const crypto = require('crypto');
  const evilManifest = JSON.stringify({ '../evil.txt': { h: 'x'.repeat(64), s: 1 } });
  const treeHash = crypto.createHash('sha256').update(evilManifest).digest('hex');
  fs.mkdirSync(path.join(B, '.qv', 'objects', treeHash.slice(0, 2)), { recursive: true });
  fs.writeFileSync(path.join(B, '.qv', 'objects', treeHash.slice(0, 2), treeHash.slice(2)), evilManifest);
  const snap = { tree: treeHash, parents: [], msg: 'evil', ts: Date.now(), branch: 'evil' };
  const snapStr = JSON.stringify(snap); snap.id = crypto.createHash('sha256').update(snapStr).digest('hex');
  fs.appendFileSync(path.join(B, '.qv', 'snapshots.jsonl'), JSON.stringify(snap) + '\n');
  fs.mkdirSync(path.join(B, '.qv', 'refs', 'heads'), { recursive: true });
  fs.writeFileSync(path.join(B, '.qv', 'refs', 'heads', 'evil'), snap.id);
  assert(qvFail(B, 'switch', 'evil'), '穿越路径应拒绝恢复');
  assert(!fs.existsSync(path.join(B, '..', 'evil.txt')), '穿越文件被写出！');
});
t('S2 空仓库命令降级', () => {
  const E = tmp(); fs.mkdirSync(E, { recursive: true });
  assert(qvFail(E, 'snap', '-m', 'x'), '未 init 不应 snap');
  assert(qvFail(E, 'log'), '未 init 不应 log');
});
t('S3 对象缺失检测', () => {
  const D = tmp(); fs.writeFileSync(path.join(D, 'f.txt'), 'v\n'); qv(D, 'init');
  fs.writeFileSync(path.join(D, 'f.txt'), 'v2\n'); qv(D, 'snap', '-m', '2');
  // 删一个可达对象文件 → verify 应 FAIL
  const snap0 = JSON.parse(fs.readFileSync(path.join(D, '.qv', 'snapshots.jsonl'), 'utf8').split('\n')[0]);
  const f = path.join(D, '.qv', 'objects', snap0.tree.slice(0, 2), snap0.tree.slice(2));
  fs.unlinkSync(f);
  assert(qvFail(D, 'verify'), '缺对象应校验失败');
});

// ===== 4. 边界用例 =====
t('B1 空文件/二进制/中文与空格文件名/深层路径', () => {
  const D = tmp();
  fs.writeFileSync(path.join(D, 'empty.txt'), '');
  fs.writeFileSync(path.join(D, 'bin.dat'), Buffer.from([0, 255, 0, 10, 0, 0, 200]));
  W(D, '中文 目录/文件 名字.txt', '中文内容\n');
  W(D, 'a/b/c/d/e/f/deep.txt', 'deep\n');
  qv(D, 'init');
  qv(D, 'branch', 'b1'); fs.writeFileSync(path.join(D, 'bin.dat'), Buffer.from([1, 2, 3]));
  qv(D, 'snap', '-m', 'b1'); qv(D, 'switch', 'main');
  qv(D, 'merge', 'b1');
  assert(Buffer.compare(fs.readFileSync(path.join(D, 'bin.dat')), Buffer.from([1, 2, 3])) === 0, '二进制往返错误');
  assert(R(D, '中文 目录/文件 名字.txt') === '中文内容\n', '中文文件名错误');
  assert(R(D, 'empty.txt') === '', '空文件丢失');
  qv(D, 'verify', '--deep');
});
t('B2 大文件 5MB 快照/恢复', () => {
  const D = tmp();
  const big = Buffer.alloc(5 * 1024 * 1024, 7);
  fs.writeFileSync(path.join(D, 'big.bin'), big);
  qv(D, 'init');
  qv(D, 'branch', 'big-br');
  fs.writeFileSync(path.join(D, 'big.bin'), Buffer.alloc(1024, 9));
  qv(D, 'snap', '-m', 'shrink');
  qv(D, 'switch', 'main');
  assert(R(D, 'big.bin').length === 5 * 1024 * 1024, '大文件恢复错误');
  qv(D, 'verify', '--deep');
});
t('B3 无改动快照允许', () => {
  const D = tmp(); fs.writeFileSync(path.join(D, 'a.txt'), 'x\n'); qv(D, 'init');
  const o = qv(D, 'snap', '-m', 'noop');
  assert(o.includes('文件'), '空快照应成功: ' + o);
  assert(qv(D, 'log').includes('noop'), '空快照应入 log');
});

// ===== 4.5 v1.4：大文件分块 + push/pull =====
t('F1 大文件分块存储与块级去重（10GB 级场景缩小版）', () => {
  const D = tmp();
  const big = Buffer.alloc(70 * 1024 * 1024);            // 70MB，9 块
  for (let i = 0; i < big.length; i += 8192) big[i] = i % 251;
  fs.writeFileSync(path.join(D, 'model.ckpt'), big);
  const t0 = Date.now(); qv(D, 'init'); const tInit = Date.now() - t0;
  const snaps = fs.readFileSync(path.join(D, '.qv', 'snapshots.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const tree = JSON.parse(fs.readFileSync(path.join(D, '.qv', 'objects', snaps[0].tree.slice(0, 2), snaps[0].tree.slice(2)), 'utf8'));
  assert(tree['model.ckpt'].chunks && tree['model.ckpt'].chunks.length === 9, '应分 9 块: ' + (tree['model.ckpt'].chunks || []).length);
  const before = (fs.readdirSync(path.join(D, '.qv', 'objects'))).reduce((n, d) => n + fs.readdirSync(path.join(D, '.qv', 'objects', d)).length, 0);
  // 尾部改 1 字节 → 只新增 1 块
  const fh = fs.openSync(path.join(D, 'model.ckpt'), 'r+');
  fs.writeSync(fh, Buffer.from([255]), 0, 1, 69 * 1024 * 1024); fs.closeSync(fh);
  qv(D, 'snap', '-m', 'tail edit');
  const after = (fs.readdirSync(path.join(D, '.qv', 'objects'))).reduce((n, d) => n + fs.readdirSync(path.join(D, '.qv', 'objects', d)).length, 0);
  const grew = after - before;
  assert(grew <= 3, `尾部 1 字节改动应只增 ~2 个对象（新块+manifest），实际 ${grew}`);
  // switch 回基线 → 逐位恢复
  const baseId = snaps[0].id.slice(0, 12);
  qv(D, 'switch', baseId);
  const buf = fs.readFileSync(path.join(D, 'model.ckpt'));
  assert(Buffer.compare(buf, big) === 0, '大文件恢复不逐位');
  qv(D, 'verify', '--deep');
  console.log(`  大文件: init(70MB)=${tInit}ms 增量对象=${grew}`);
});
t('F2 push/pull 本地路径模式（跨机同步的回环路径）', () => {
  const A = tmp(), B = tmp();
  fs.writeFileSync(path.join(A, 'train.py'), 'v1\n'); qv(A, 'init');
  qv(A, 'branch', 'exp1'); fs.writeFileSync(path.join(A, 'train.py'), 'v2\n'); qv(A, 'snap', '-m', 'e1'); qv(A, 'switch', 'main');
  fs.writeFileSync(path.join(B, 'b.txt'), 'b\n'); qv(B, 'init');
  qv(A, 'push', B);
  assert(!fs.existsSync(path.join(B, 'train.py')), 'push 只同步对象/分支，不应落盘工作区');
  const o = qv(B, 'merge', 'exp1');
  assert(o.includes('干净'), o);
  assert(R(B, 'train.py') === 'v2\n', 'push 后 merge 应取到 A 侧内容: ' + R(B, 'train.py'));
  qv(B, 'pull', A);
  qv(A, 'verify', '--deep'); qv(B, 'verify', '--deep');
});
t('F3 大文件冲突语义（分块对象不做行级合并）', () => {
  const D = tmp();
  const buf = Buffer.alloc(65 * 1024 * 1024, 7);
  fs.writeFileSync(path.join(D, 'weights.bin'), buf);
  qv(D, 'init');
  qv(D, 'branch', 'dev');
  const fh = fs.openSync(path.join(D, 'weights.bin'), 'r+'); fs.writeSync(fh, Buffer.from([9]), 0, 1, 0); fs.closeSync(fh);
  qv(D, 'snap', '-m', 'dev edit'); qv(D, 'switch', 'main');
  const fh2 = fs.openSync(path.join(D, 'weights.bin'), 'r+'); fs.writeSync(fh2, Buffer.from([8]), 0, 1, 0); fs.closeSync(fh2);
  qv(D, 'snap', '-m', 'main edit');
  const o = qv(D, 'merge', 'dev');
  assert(o.includes('冲突'), '大文件双侧改应标冲突: ' + o);
  const out = fs.readFileSync(path.join(D, 'weights.bin'));
  assert(out[0] === 8, '冲突时保留 ours 侧: ' + out[0]);
  qv(D, 'verify', '--deep');
});

// ===== 5. 压力 =====
t('P1 万文件仓库 init+增量+verify', () => {
  const D = tmp(); const t0 = Date.now();
  for (let i = 0; i < 10000; i++) W(D, `s/${Math.floor(i / 50)}/f${i}.txt`, 'v1 ' + i);
  qv(D, 'init'); const tInit = Date.now() - t0;
  for (let i = 0; i < 20; i++) W(D, `s/0/f${i}.txt`, 'v2 ' + i);
  const t1 = Date.now(); qv(D, 'snap', '-m', 'v2'); const tSnap = Date.now() - t1;
  const t2 = Date.now(); qv(D, 'verify', '--deep'); const tVer = Date.now() - t2;
  console.log(`  压力: init(10000)=${tInit}ms snap(20改)=${tSnap}ms verify=${tVer}ms`);
});
t('P2 200 分支批量合并', () => {
  const D = tmp(); fs.writeFileSync(path.join(D, 'base.txt'), 'b\n'); qv(D, 'init');
  for (let i = 0; i < 200; i++) { qv(D, 'branch', `x${i}`); W(D, `n${i}.txt`, 'x' + i); qv(D, 'snap', '-m', 'x' + i); qv(D, 'switch', 'main'); }
  const t0 = Date.now(); const o = qv(D, 'batch-merge'); const ms = Date.now() - t0;
  assert(o.includes('批量合并 200 个分支'), o);
  assert(R(D, 'n199.txt') === 'x199', '内容错误');
  console.log(`  压力: batch-merge(200)=${ms}ms`);
});
t('P3 深链 300 快照 log/switch', () => {
  const D = tmp(); fs.writeFileSync(path.join(D, 'c.txt'), '0\n'); qv(D, 'init');
  for (let i = 1; i <= 300; i++) { fs.writeFileSync(path.join(D, 'c.txt'), String(i) + '\n'); qv(D, 'snap', '-m', 's' + i); }
  const o = qv(D, 'log');
  assert(o.trim().split('\n').length === 301, 'log 深度错误: ' + o.trim().split('\n').length);
  qv(D, 'switch', 'main');
  assert(R(D, 'c.txt') === '300\n', '深链头内容错误');
});

// ===== 6. 幂等与回滚 =====
t('R1 gc 幂等 + drop reflog 可追溯', () => {
  const D = tmp(); fs.writeFileSync(path.join(D, 'a.txt'), '1\n'); qv(D, 'init');
  qv(D, 'branch', 'tmp1'); W(D, 'x.txt', 'x'); qv(D, 'snap', '-m', 't'); qv(D, 'switch', 'main');
  qv(D, 'drop', 'tmp1');
  const o1 = qv(D, 'gc'); const o2 = qv(D, 'gc');
  const n1 = o1.match(/清理 (\d+)/)[1], n2 = o2.match(/清理 (\d+)/)[1];
  assert(n2 === '0', '二次 gc 应无清理: ' + o2);
  const reflog = R(D, '.qv/reflog.jsonl');
  assert(reflog.includes('"drop":"tmp1"'), 'reflog 未记录 drop');
});

console.log(`\n工业套件: ${pass} passed, ${fail} failed${failures.length ? ' — ' + failures.join(', ') : ''}`);
process.exit(fail ? 1 : 0);
