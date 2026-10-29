// qv e2e 测试套件：核心命令全链路 + 冲突 + 批量合并 + 篡改检测 + 性能基准
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const QV = path.join(__dirname, '..', 'qv.js');
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`PASS ${name}`); } catch (e) { fail++; console.log(`FAIL ${name}: ${e.message}`); } };
const assert = (c, m) => { if (!c) throw new Error(m || 'assert'); };

function qv(dir, ...args) {
  return execFileSync('node', [QV, ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function qvFail(dir, ...args) {
  try { qv(dir, ...args); } catch { return true; } throw new Error('应失败但成功了');
}
const W = (d, p, c) => { fs.mkdirSync(path.dirname(path.join(d, p)), { recursive: true }); fs.writeFileSync(path.join(d, p), c); };
const R = (d, p) => fs.readFileSync(path.join(d, p), 'utf8');

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'qv-test-'));
fs.writeFileSync(path.join(repo, 'a.txt'), 'line1\nline2\n');
fs.writeFileSync(path.join(repo, 'b.txt'), 'hello\n');

t('init', () => { const o = qv(repo, 'init'); assert(o.includes('已初始化'), o); });
t('snap 基线', () => { const o = qv(repo, 'snap', '-m', 'base'); assert(o.includes('文件'), o); });
t('log 记录', () => { const o = qv(repo, 'log'); assert(o.includes('base') && o.includes('init'), o); });

t('修改+snap', () => { W(repo, 'a.txt', 'line1\nline2-changed\n'); qv(repo, 'snap', '-m', 'edit-a'); const o = qv(repo, 'log'); assert(o.includes('edit-a'), o); });
t('switch 回旧快照恢复内容', () => {
  const log = qv(repo, 'log').split('\n');
  const baseId = log.find(l => l.includes('base')).split(' ')[0];
  qv(repo, 'switch', baseId);
  assert(R(repo, 'a.txt') === 'line1\nline2\n', '内容未恢复: ' + JSON.stringify(R(repo, 'a.txt')));
});
t('diff 检出修改', () => { W(repo, 'd.txt', 'new watch\n'); const o = qv(repo, 'diff'); assert(o.includes('新增') && o.includes('d.txt'), o); });
t('switch 分支名回最新', () => { qv(repo, 'switch', 'main'); assert(R(repo, 'a.txt').includes('line2-changed'), R(repo, 'a.txt')); });

t('branch 零拷贝 + 干净合并', () => {
  qv(repo, 'branch', 'exp1');
  W(repo, 'c.txt', 'new file\n');
  qv(repo, 'snap', '-m', 'exp1-add-c');
  qv(repo, 'switch', 'main');
  assert(!fs.existsSync(path.join(repo, 'c.txt')), 'c.txt 应不存在于 main');
  const o = qv(repo, 'merge', 'exp1');
  assert(o.includes('干净'), o);
  assert(R(repo, 'c.txt') === 'new file\n', '合并后 c.txt 缺失');
});
t('冲突标记合并', () => {
  qv(repo, 'branch', 'exp-conf');
  W(repo, 'b.txt', 'hello\nfrom-exp-conf\n');
  qv(repo, 'snap', '-m', 'conf-edit');
  qv(repo, 'switch', 'main');
  W(repo, 'b.txt', 'hello\nfrom-main\n');
  qv(repo, 'snap', '-m', 'main-edit');
  const o = qv(repo, 'merge', 'exp-conf');
  assert(o.includes('冲突') || o.includes('CONFLICT'), o);
  const txt = R(repo, 'b.txt');
  assert(txt.includes('<<<<<<<') && txt.includes('from-main') && txt.includes('from-exp-conf'), '冲突块缺失: ' + txt);
});

t('batch-merge 批量（20 干净 + 2 冲突）', () => {
  for (let i = 1; i <= 20; i++) {
    qv(repo, 'branch', `exp${i}`);
    W(repo, `f${i}.txt`, `content ${i}\n`);
    qv(repo, 'snap', '-m', `exp${i}`);
    qv(repo, 'switch', 'main');
  }
  for (const c of ['conf1', 'conf2']) {
    qv(repo, 'branch', c);
    W(repo, 'b.txt', `hello\nfrom-${c}\n`);
    qv(repo, 'snap', '-m', c);
    qv(repo, 'switch', 'main');
  }
  const o = qv(repo, 'batch-merge');
  assert(o.includes('批量合并 22 个分支'), o);
  assert(o.includes('跳过(冲突): conf2') && !o.includes('conf2('), 'conf2 应跳过且其余干净: ' + o);
  assert(R(repo, 'f7.txt') === 'content 7\n', '批量合并内容错误');
  assert(R(repo, 'b.txt').includes('from-conf1'), 'conf1 应干净采纳: ' + R(repo, 'b.txt'));
});

t('verify 通过', () => { const o = qv(repo, 'verify', '--deep'); assert(o.includes('OK'), o); });
t('篡改检测（安全）', () => {
  const snaps = fs.readFileSync(path.join(repo, '.qv', 'snapshots.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const tree = snaps[snaps.length - 1].tree;
  const f = path.join(repo, '.qv', 'objects', tree.slice(0, 2), tree.slice(2));
  const backup = fs.readFileSync(f);
  fs.writeFileSync(f, Buffer.concat([backup, Buffer.from('tampered')]));
  const okFail = qvFail(repo, 'verify', '--deep');
  fs.writeFileSync(f, backup);
  qv(repo, 'verify', '--deep');
  assert(okFail, '篡改未检出');
});
t('drop + gc', () => {
  qv(repo, 'drop', 'exp1');
  const o = qv(repo, 'gc');
  assert(o.includes('清理'), o);
  qvFail(repo, 'log', 'exp1');
});
t('switch 后 snap 延续', () => {
  qv(repo, 'branch', 'after-gc');
  W(repo, 'z.txt', 'z\n');
  qv(repo, 'snap', '-m', 'z');
  qv(repo, 'switch', 'main');
  assert(!fs.existsSync(path.join(repo, 'z.txt')), '');
  qv(repo, 'merge', 'after-gc');
  assert(R(repo, 'z.txt') === 'z\n', '');
});

// ---- 性能基准 ----
t('性能基准', () => {
  const bench = fs.mkdtempSync(path.join(os.tmpdir(), 'qv-bench-'));
  for (let i = 0; i < 2000; i++) W(bench, `p/d${Math.floor(i / 100)}/f${i}.txt`, 'x'.repeat(2000) + i);
  let t0 = Date.now(); qv(bench, 'init'); const tInit = Date.now() - t0;
  for (let i = 0; i < 10; i++) W(bench, `p/d0/f${i}.txt`, 'changed ' + Date.now());
  t0 = Date.now(); qv(bench, 'snap', '-m', 'bench2'); const tSnap = Date.now() - t0;
  t0 = Date.now(); qv(bench, 'verify', '--deep'); const tVerify = Date.now() - t0;
  const nBr = 30;
  for (let i = 0; i < nBr; i++) { qv(bench, 'branch', `b${i}`); W(bench, `b${i}.txt`, 'v' + i); qv(bench, 'snap', '-m', 'b' + i); qv(bench, 'switch', 'main'); }
  t0 = Date.now(); const o = qv(bench, 'batch-merge'); const tBatch = Date.now() - t0;
  assert(o.includes(`批量合并 ${nBr} 个分支`), o);
  console.log(`  基准: init(2000 文件)=${tInit}ms  增量snap(10改动)=${tSnap}ms  verify --deep=${tVerify}ms  batch-merge(${nBr}分支)=${tBatch}ms`);
  fs.rmSync(bench, { recursive: true, force: true });
});

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(repo, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
