#!/usr/bin/env node
// qv — quick-experiment version control. 快照模型 VCS：实验 O(1)、SHA-256 内容寻址、
// 增量快照、文件级三方合并、批量级联合并、全库 Merkle 校验。单文件零依赖（Node >= 20）。
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const QV = '.qv';
const CONC = 32;

const die = (m) => { console.error('qv: ' + m); process.exit(1); };
const ok = (m) => { console.log(m); };

// ---------- 对象库（内容寻址存储：sha256 键，明文存储——任何字节篡改可被 verify 直接检出） ----------
function objDir(root, h) { return path.join(root, QV, 'objects', h.slice(0, 2)); }
async function put(root, buf) {
  const h = crypto.createHash('sha256').update(buf).digest('hex');
  const f = path.join(objDir(root, h), h.slice(2));
  try { await fsp.access(f); } catch { await fsp.mkdir(objDir(root, h), { recursive: true }); await fsp.writeFile(f, buf); }
  return h;
}
async function get(root, h) { return fsp.readFile(path.join(objDir(root, h), h.slice(2))); }
async function has(root, h) { try { await fsp.access(path.join(objDir(root, h), h.slice(2))); return true; } catch { return false; } }

// ---------- manifest：路径 → {h,size,mtime}，稳定序列化保证内容寻址 ----------
function manifestBuf(m) {
  const o = {}; for (const p of Object.keys(m).sort()) o[p] = { h: m[p].h, s: m[p].s };
  return Buffer.from(JSON.stringify(o));
}
function manifestHash(m) { return crypto.createHash('sha256').update(manifestBuf(m)).digest('hex'); }

// ---------- 工作区扫描（增量：mtime+size 未变沿用缓存哈希） ----------
async function scanWorkdir(root, last) {
  const all = await fsp.readdir(root, { recursive: true, withFileTypes: true });
  const files = all.filter(d => d.isFile()).map(d => path.relative(root, path.join(d.parentPath || d.path, d.name)).replace(/\\/g, '/'))
    .filter(p => p !== QV && !p.startsWith(QV + '/'));
  const m = {};
  const queue = [...files];
  while (queue.length) {
    const batch = queue.splice(0, CONC);
    await Promise.all(batch.map(async p => {
      const st = await fsp.stat(path.join(root, p));
      const c = last && last[p];
      if (c && c.s === st.size && c.m === Math.floor(st.mtimeMs) && await has(root, c.h)) { m[p] = c; return; }
      const buf = await fsp.readFile(path.join(root, p));
      m[p] = { h: await put(root, buf), s: st.size, m: Math.floor(st.mtimeMs) };
    }));
  }
  return m;
}

// ---------- 引用与快照日志（追加式，含 reflog 可恢复） ----------
const headsDir = r => path.join(r, QV, 'refs', 'heads');
async function readHead(root, br) {
  const f = path.join(headsDir(root), br);
  try { return (await fsp.readFile(f, 'utf8')).trim(); } catch { return null; }
}
async function writeHead(root, br, snapId) {
  await fsp.mkdir(headsDir(root), { recursive: true });
  await fsp.writeFile(path.join(headsDir(root), br), snapId + '\n');
  await fsp.appendFile(path.join(root, QV, 'reflog.jsonl'), JSON.stringify({ ts: Date.now(), branch: br, to: snapId }) + '\n');
}
async function appendSnap(root, snap) {
  await fsp.appendFile(path.join(root, QV, 'snapshots.jsonl'), JSON.stringify(snap) + '\n');
}
async function loadSnaps(root) {
  const out = new Map();
  try {
    const txt = await fsp.readFile(path.join(root, QV, 'snapshots.jsonl'), 'utf8');
    for (const ln of txt.split('\n')) { if (!ln.trim()) continue; const o = JSON.parse(ln); out.set(o.id, o); }
  } catch {}
  return out;
}
async function saveCache(root, m) { await fsp.writeFile(path.join(root, QV, 'last-manifest.json'), JSON.stringify({ m })); }
async function loadCache(root) { try { return (JSON.parse(await fsp.readFile(path.join(root, QV, 'last-manifest.json'), 'utf8'))).m; } catch { return null; } }

// ---------- 工作区恢复（只写差异：目标 vs 缓存盘面） ----------
async function restore(root, target) {
  const cur = (await loadCache(root)) || {};
  const toDel = Object.keys(cur).filter(p => !(p in target));
  await Promise.all(toDel.map(p => fsp.rm(path.join(root, p), { force: true })));
  const toWrite = Object.keys(target).filter(p => !(p in cur) || cur[p].h !== target[p].h);
  const q = [...toWrite];
  while (q.length) {
    const batch = q.splice(0, CONC);
    await Promise.all(batch.map(async p => {
      const f = path.join(root, p);
      await fsp.mkdir(path.dirname(f), { recursive: true });
      await fsp.writeFile(f, await get(root, target[p].h));
    }));
  }
  const now = {};
  for (const p of Object.keys(target)) { const st = await fsp.stat(path.join(root, p)); now[p] = { h: target[p].h, s: st.size, m: Math.floor(st.mtimeMs) }; }
  await saveCache(root, now);
}

// ---------- 三方合并（LCA → 文件级 → 行级） ----------
function ancestors(snaps, id) {
  const seen = new Set(); const q = [id];
  while (q.length) { const s = q.shift(); if (!s || seen.has(s)) continue; seen.add(s); const o = snaps.get(s); if (o) q.push(...o.parents); }
  return seen;
}
function lca(snaps, a, b) {
  const sa = ancestors(snaps, a);
  const q = [b]; const seen = new Set();
  while (q.length) {
    const id = q.shift();
    if (sa.has(id)) return id;
    if (seen.has(id)) continue; seen.add(id);
    const o = snaps.get(id); if (o) q.push(...o.parents);
  }
  return null;
}
function diff3(base, ours, theirs) { // 行级三方，返回合并文本与冲突数
  if (ours === theirs) return { text: ours, conflicts: 0 };
  if (base === ours) return { text: theirs, conflicts: 0 };
  if (base === theirs) return { text: ours, conflicts: 0 };
  const B = base.split('\n'), O = ours.split('\n'), T = theirs.split('\n');
  if (B.length * O.length > 25e6 || B.length * T.length > 25e6) // 超大文件退化：整文件冲突
    return { text: '<<<<<<< OURS\n' + ours + '\n=======\n' + theirs + '\n>>>>>>> THEIRS\n', conflicts: 1 };
  const lcs = (x, y) => { // 返回 x 的稳定行集（简化：以出现计数对齐）
    const n = x.length, m = y.length; const dp = new Int32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      dp[i * (m + 1) + j] = x[i] === y[j] ? dp[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
    return dp;
  };
  const keepO = new Set(); { const dp = lcs(B, O); let i = 0, j = 0;
    while (i < B.length && j < O.length) { if (B[i] === O[j]) { keepO.add(i); i++; j++; } else if (dp[(i + 1) * (O.length + 1) + j] >= dp[i * (O.length + 1) + j + 1]) i++; else j++; } }
  const keepT = new Set(); { const dp = lcs(B, T); let i = 0, j = 0;
    while (i < B.length && j < T.length) { if (B[i] === T[j]) { keepT.add(i); i++; j++; } else if (dp[(i + 1) * (T.length + 1) + j] >= dp[i * (T.length + 1) + j + 1]) i++; else j++; } }
  // 生成合并：同区间单侧改→取侧；双侧改→冲突块
  const out = []; let conflicts = 0;
  const oIns = {}, tIns = {}; // baseIdx -> [lines]
  { let bi = 0; for (let k = 0; k < O.length; k++) { if (bi < B.length && O[k] === B[bi] && keepO.has(bi)) { bi++; } else { (oIns[bi] = oIns[bi] || []).push(O[k]); } } }
  { let bi = 0; for (let k = 0; k < T.length; k++) { if (bi < B.length && T[k] === B[bi] && keepT.has(bi)) { bi++; } else { (tIns[bi] = tIns[bi] || []).push(T[k]); } } }
  let i = 0;
  for (; i <= B.length; i++) {
    const oi = oIns[i] || [], ti = tIns[i] || [];
    if (oi.length && ti.length && oi.join('\n') !== ti.join('\n')) {
      out.push('<<<<<<< OURS', ...oi, '=======', ...ti, '>>>>>>> THEIRS'); conflicts++;
    } else if (oi.length) out.push(...oi);
    else if (ti.length) out.push(...ti);
    if (i < B.length) out.push(B[i]);
  }
  return { text: out.join('\n'), conflicts };
}

async function doMerge(root, srcBr, dstBr, opts) {
  const snaps = await loadSnaps(root);
  const a = await readHead(root, dstBr), b = await readHead(root, srcBr);
  if (!b) throw new Error(`分支不存在: ${srcBr}`);
  if (!a) throw new Error(`目标分支不存在: ${dstBr}`);
  const sa = snaps.get(a), sb = snaps.get(b);
  const baseId = lca(snaps, a, b);
  const sm = await get(root, sa.tree); const tm = JSON.parse(sm.toString());
  const bmM = baseId ? JSON.parse((await get(root, snaps.get(baseId).tree)).toString()) : {};
  const bm = bmM;
  const amM = JSON.parse((await get(root, sb.tree)).toString());
  const sm2 = tm; // dst 侧
  const result = {};
  const paths = new Set([...Object.keys(sm2), ...Object.keys(amM), ...Object.keys(bm)]);
  let conflicts = 0; const report = [];
  const curWork = await loadCache(root);
  for (const p of paths) {
    const inB = bm[p], inO = sm2[p], inT = amM[p];
    const hO = inO ? inO.h : null, hT = inT ? inT.h : null, hB = inB ? inB.h : null;
    if (hO === hT) { if (hO) result[p] = inO; continue; }
    if (hB === hO) { if (hT) result[p] = inT; continue; } // 只 theirs 改 → 取 theirs
    if (hB === hT) { if (hO) result[p] = inO; continue; } // 只 ours 改 → 取 ours
    // 双侧同文件不同改动 → 行级三方
    const txtB = hB ? (await get(root, hB)).toString() : '';
    const txtO = hO ? (await get(root, hO)).toString() : '';
    const txtT = hT ? (await get(root, hT)).toString() : '';
    const m3 = diff3(txtB, txtO, txtT);
    if (m3.conflicts === 0) { result[p] = { h: await put(root, Buffer.from(m3.text, 'utf8')), s: Buffer.byteLength(m3.text), m: 0 }; }
    else {
      conflicts++;
      report.push(p);
      if (opts.conflict !== 'skip') result[p] = { h: await put(root, Buffer.from(m3.text, 'utf8')), s: Buffer.byteLength(m3.text), m: 0 };
    }
  }
  if (conflicts && opts.conflict === 'abort') { report.forEach(p => console.error('CONFLICT ' + p)); throw new Error(`合并中止：${conflicts} 个冲突`); }
  const treeH = await put(root, manifestBuf(result));
  // 快照对象本身参与内容寻址：id = 对象哈希（存的是完整记录）
  const snap = { tree: treeH, parents: [a, b], msg: opts.msg || `merge ${srcBr}->${dstBr}`, ts: Date.now(), branch: dstBr };
  snap.id = await put(root, Buffer.from(JSON.stringify(snap)));
  await appendSnap(root, snap);
  await writeHead(root, dstBr, snap.id);
  // 若当前工作区在该分支，落盘合并结果
  if (opts.apply !== false) { await restore(root, result); }
  return { id: snap.id, conflicts, report, tree: result };
}

// ---------- 命令实现 ----------
async function cmdInit(root) {
  const d = path.join(root, QV);
  try { await fsp.access(d); die('已初始化（.qv 存在）'); } catch {}
  await fsp.mkdir(path.join(d, 'refs', 'heads'), { recursive: true });
  await fsp.writeFile(path.join(d, 'config.json'), JSON.stringify({ v: 1, algo: 'sha256', created: Date.now() }, null, 2));
  const m = await scanWorkdir(root, null);
  const treeH = await put(root, manifestBuf(m));
  const snap = { tree: treeH, parents: [], msg: 'qv init', ts: Date.now(), branch: 'main' };
  snap.id = await put(root, Buffer.from(JSON.stringify(snap)));
  await appendSnap(root, snap);
  await writeHead(root, 'main', snap.id);
  await saveCache(root, m);
  ok(`已初始化。main -> ${snap.id.slice(0, 12)}（${Object.keys(m).length} 个文件入册）`);
}

async function cmdSnap(root, args) {
  let br = await currentBranch(root), msg = 'wip';
  const i = args.indexOf('-m');
  if (i >= 0 && args[i + 1]) msg = args[i + 1];
  const j = args.findIndex(a => a.startsWith('--branch='));
  if (j >= 0) br = args[j].slice(9);
  const last = await loadCache(root);
  const m = await scanWorkdir(root, last);
  const parent = await readHead(root, br); if (!parent) die(`分支不存在: ${br}（先 qv branch ${br}）`);
  const treeH = await put(root, manifestBuf(m));
  const snap = { tree: treeH, parents: [parent], msg: msg || 'wip', ts: Date.now(), branch: br };
  snap.id = await put(root, Buffer.from(JSON.stringify(snap)));
  await appendSnap(root, snap);
  await writeHead(root, br, snap.id);
  await saveCache(root, m);
  ok(`${snap.id.slice(0, 12)} ${br}: ${Object.keys(m).length} 文件（增量快照）`);
}
async function currentBranch(root) {
  try { return (await fsp.readFile(path.join(root, QV, 'HEAD'), 'utf8')).trim(); } catch { return 'main'; }
}
async function setCurrentBranch(root, br) { await fsp.writeFile(path.join(root, QV, 'HEAD'), br + '\n'); }

async function cmdBranch(root, name) {
  if (!name) { const list = await fsp.readdir(headsDir(root)); ok(list.join('\n')); return; }
  const cur = await readHead(root, await currentBranch(root));
  if (!cur) die('当前分支无快照');
  await writeHead(root, name, cur);
  await setCurrentBranch(root, name);
  ok(`分支 ${name} -> ${cur.slice(0, 12)}（零拷贝）`);
}

async function cmdSwitch(root, target) {
  const snaps = await loadSnaps(root);
  let id = null, br = null;
  const h = await readHead(root, target);
  if (h) { id = h; br = target; }
  else if (snaps.has(target)) { id = target; br = snaps.get(target).branch; }
  else { const k = Array.from(snaps.keys()).find(k => k.startsWith(target)); if (k) { id = k; br = snaps.get(k).branch; } }
  if (!id) die(`未找到分支或快照: ${target}`);
  const s = snaps.get(id); if (!s) die(`快照对象缺失: ${id}`);
  await restore(root, JSON.parse((await get(root, s.tree)).toString()));
  if (br) await setCurrentBranch(root, br);
  ok(`已切换到 ${target}（${id.slice(0, 12)}，只写差异）`);
}

async function cmdLog(root, br) {
  const snaps = await loadSnaps(root);
  const target = br || (await currentBranch(root));
  let id = await readHead(root, target);
  if (!id) die(`分支不存在: ${target}`);
  const out = [];
  while (id) { const s = snaps.get(id); if (!s) break; out.push(`${s.id.slice(0, 12)} ${new Date(s.ts).toISOString().slice(0, 19)} ${s.msg}`); id = s.parents[0]; }
  ok(out.join('\n') || '(空)');
}

async function cmdDrop(root, target) {
  const f = path.join(headsDir(root), target);
  try { await fsp.access(f); } catch { die(`分支不存在: ${target}`); }
  await fsp.rm(f);
  await fsp.appendFile(path.join(root, QV, 'reflog.jsonl'), JSON.stringify({ ts: Date.now(), drop: target }) + '\n');
  ok(`已丢弃 ${target}（reflog 可追溯，对象留待 qv gc）`);
}

async function cmdMerge(root, src, arg2) {
  let dst = 'main', msg;
  if (arg2 && arg2.startsWith('--into=')) dst = arg2.slice(7);
  else if (arg2) msg = arg2;
  const r = await doMerge(root, src, dst, { conflict: 'mark', msg });
  ok(`${r.id.slice(0, 12)} 合并 ${src} -> ${dst}${r.conflicts ? `（${r.conflicts} 冲突已标记）` : '（干净）'}`);
  if (r.report.length) r.report.forEach(p => console.error('  CONFLICT: ' + p));
}

async function cmdBatchMerge(root, patterns) {
  const t0 = Date.now();
  const branches = (await fsp.readdir(headsDir(root))).filter(b => b !== 'main' && !b.startsWith('.'));
  const rx = patterns.map(p => new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'));
  const targets = branches.filter(b => patterns.length === 0 || rx.some(r => r.test(b)));
  const done = [], skipped = [];
  for (const b of targets) {
    try { const r = await doMerge(root, b, 'main', { conflict: 'abort', apply: false, msg: `batch-merge ${b}` }); done.push(`${b}(${r.conflicts}c)`); }
    catch (e) { skipped.push(b); }
  }
  const finalHead = await readHead(root, 'main');
  const snaps = await loadSnaps(root);
  await restore(root, JSON.parse((await get(root, snaps.get(finalHead).tree)).toString()));
  await setCurrentBranch(root, 'main');
  ok(`批量合并 ${done.length} 个分支: ${done.join(', ') || '(无)'}${skipped.length ? '\n  跳过(冲突): ' + skipped.join(', ') : ''}\n耗时 ${Date.now() - t0}ms，main -> ${finalHead.slice(0, 12)}`);
}

async function cmdVerify(root, deep) {
  const t0 = Date.now();
  const snaps = await loadSnaps(root);
  let bad = 0, checked = 0;
  for (const s of snaps.values()) {
    const buf = await get(root, s.id);
    if (crypto.createHash('sha256').update(buf).digest('hex') !== s.id) { bad++; console.error(`快照哈希不符: ${s.id.slice(0, 12)}`); continue; }
    checked++;
    const treeBuf = await get(root, s.tree);
    if (crypto.createHash('sha256').update(treeBuf).digest('hex') !== s.tree) { bad++; console.error(`树对象哈希不符: ${s.tree.slice(0, 12)}`); continue; }
    checked++;
    if (deep) {
      const m = JSON.parse(treeBuf.toString());
      for (const p of Object.keys(m)) {
        try { const buf2 = await get(root, m[p].h); if (crypto.createHash('sha256').update(buf2).digest('hex') !== m[p].h) { bad++; console.error(`blob 损坏: ${p}`); } checked++; }
        catch { bad++; console.error(`blob 缺失: ${p}`); }
      }
    }
  }
  ok(`校验 ${checked} 个对象，损坏 ${bad} 个，${bad === 0 ? 'OK' : 'FAIL'}（${Date.now() - t0}ms${deep ? '，深度' : ''}）`);
  if (bad) process.exit(1);
}

async function cmdGc(root) {
  const snaps = await loadSnaps(root);
  const live = new Set();
  for (const s of snaps.values()) {
    live.add(s.id); live.add(s.tree);
    const m = JSON.parse((await get(root, s.tree)).toString());
    for (const p of Object.keys(m)) live.add(m[p].h);
  }
  const base = path.join(root, QV, 'objects');
  let removed = 0;
  for (const d of await fsp.readdir(base)) {
    for (const f of await fsp.readdir(path.join(base, d))) {
      const h = d + f;
      if (!live.has(h)) { await fsp.rm(path.join(base, d, f)); removed++; }
    }
  }
  ok(`gc：保留 ${live.size} 个可达对象，清理 ${removed} 个孤儿`);
}

async function cmdDiff(root, arg) {
  const snaps = await loadSnaps(root);
  const cur = await scanWorkdir(root, await loadCache(root));
  const headId = await readHead(root, arg || (await currentBranch(root)));
  const head = JSON.parse((await get(root, snaps.get(headId).tree)).toString());
  let n = 0;
  for (const p of new Set([...Object.keys(cur), ...Object.keys(head)])) {
    const a = head[p] && head[p].h, b = cur[p] && cur[p].h;
    if (a !== b) { const tag = !a ? '新增' : !b ? '删除' : '修改'; ok(`${tag} ${p}`); n++; }
  }
  if (!n) ok('工作区与 HEAD 一致');
}

async function cmdStatus(root) {
  const br = await currentBranch(root);
  ok(`分支: ${br}`);
  await cmdDiff(root, br);
}

// ---------- CLI ----------
async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const root = process.cwd();
  switch (cmd) {
    case 'init': return cmdInit(root);
    case 'snap': return cmdSnap(root, rest);
    case 'branch': return cmdBranch(root, rest[0]);
    case 'switch': return cmdSwitch(root, rest[0]);
    case 'log': return cmdLog(root, rest[0]);
    case 'drop': return cmdDrop(root, rest[0]);
    case 'merge': return cmdMerge(root, rest[0], rest[1]);
    case 'batch-merge': return cmdBatchMerge(root, rest);
    case 'verify': return cmdVerify(root, rest.includes('--deep'));
    case 'gc': return cmdGc(root);
    case 'diff': return cmdDiff(root, rest[0]);
    case 'status': return cmdStatus(root);
    default:
      ok('qv — 快照模型 VCS（实验 O(1) / sha256 内容寻址 / 批量合并）\n用法: init | snap [-m msg] | branch [name] | switch <br|snap> | log | merge <src> [--into=dst] | batch-merge [pattern...] | verify [--deep] | gc | diff | status | drop <br>');
      if (cmd) die('未知命令: ' + cmd);
  }
}
main().catch(e => die(e.stack || e.message));
