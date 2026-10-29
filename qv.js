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
// 路径安全：manifest/bundle 是不可信输入，防路径穿越
function safePath(p) {
  if (!p || typeof p !== 'string' || p.includes('\0') || /^[a-zA-Z]:/.test(p) || p.startsWith('/') || p.startsWith('\\') || p.split('/').includes('..') || p.split('\\').includes('..')) return false;
  return true;
}

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

// ---------- 忽略规则（.qvignore，gitignore 风格子集；内置最低默认集） ----------
async function loadIgnores(root) {
  const pats = ['node_modules/', '__pycache__/'];
  try {
    const txt = await fsp.readFile(path.join(root, '.qvignore'), 'utf8');
    for (let ln of txt.split(/\r?\n/)) { ln = ln.trim(); if (ln && !ln.startsWith('#')) pats.push(ln); }
  } catch {}
  const rxs = pats.map(p => {
    const dir = p.endsWith('/');
    const body = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
    return dir ? new RegExp('^' + body) : new RegExp('(^|/)' + body + '$');
  });
  return (p) => rxs.some(rx => rx.test(p));
}

// ---------- 工作区扫描（增量：mtime+size 未变沿用缓存哈希） ----------
async function scanWorkdir(root, last) {
  const ignored = await loadIgnores(root);
  const all = await fsp.readdir(root, { recursive: true, withFileTypes: true });
  const files = all.filter(d => d.isFile()).map(d => path.relative(root, path.join(d.parentPath || d.path, d.name)).replace(/\\/g, '/'))
    .filter(p => p !== QV && !p.startsWith(QV + '/'))
    .filter(p => !ignored(p));
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
  const ignored = await loadIgnores(root);
  const paths = Object.keys(target);
  for (const p of paths) if (!safePath(p)) die(`非法路径（拒绝写入）: ${JSON.stringify(p)}`);
  const toDel = Object.keys(cur).filter(p => !(p in target)).filter(p => !ignored(p));
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
// LCS 匹配对（base 行号, side 行号）——chunk 式 diff 的基础
function matchPairs(x, y) {
  const n = x.length, m = y.length;
  if (n * m > 25e6) return null;
  const dp = new Int32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i * (m + 1) + j] = x[i] === y[j] ? dp[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
  const pairs = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { pairs.push([i, j]); i++; j++; }
    else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) i++; else j++;
  }
  return pairs;
}
// 匹配对之间的差异段（chunk）——天然覆盖插入/删除/修改三种形态
function chunksFromPairs(pairs, baseLen, S) {
  const chunks = []; let pb = -1, ps = -1;
  for (const [bi, si] of [...pairs, [baseLen, S.length]]) {
    if (bi > pb + 1 || si > ps + 1) chunks.push({ b0: pb + 1, b1: bi, s: S.slice(ps + 1, si) });
    pb = bi; ps = si;
  }
  return chunks;
}
// chunk 式三方合并：区间不重叠双侧各取，真重叠才冲突（删除不再错位成伪冲突）
function diff3(base, ours, theirs) {
  if (ours === theirs) return { text: ours, conflicts: 0 };
  if (base === ours) return { text: theirs, conflicts: 0 };
  if (base === theirs) return { text: ours, conflicts: 0 };
  const B = base.split('\n'), O = ours.split('\n'), T = theirs.split('\n');
  const pO = matchPairs(B, O), pT = matchPairs(B, T);
  if (!pO || !pT) // 超大文件退化：整文件冲突
    return { text: '<<<<<<< OURS\n' + ours + '\n=======\n' + theirs + '\n>>>>>>> THEIRS\n', conflicts: 1 };
  const cO = chunksFromPairs(pO, B.length, O), cT = chunksFromPairs(pT, B.length, T);
  const all = [
    ...cO.map(c => ({ ...c, side: 'o' })),
    ...cT.map(c => ({ ...c, side: 't' }))
  ].sort((a, b) => a.b0 - b.b0 || a.b1 - b.b1);
  const out = []; let conflicts = 0, bCur = 0, i = 0;
  while (i < all.length) {
    // 收集重叠组：base 区间 [b0,b1) 相交的 chunk 一起处理
    const group = [all[i]]; let end = all[i].b1; i++;
    // 区间相交，或同起点的双侧改动（含同点纯插入）→ 必须同组裁决
    while (i < all.length && (all[i].b0 < end || all[i].b0 === group[0].b0)) { group.push(all[i]); end = Math.max(end, all[i].b1); i++; }
    const start = group[0].b0;
    if (start > bCur) { for (let k = bCur; k < start; k++) out.push(B[k]); bCur = start; }
    const gO = group.filter(g => g.side === 'o'), gT = group.filter(g => g.side === 't');
    if (gO.length === 0) { out.push(...gT[0].s); }
    else if (gT.length === 0) { out.push(...gO[0].s); }
    else if (gO.length === 1 && gT.length === 1 && gO[0].s.join('\n') === gT[0].s.join('\n')) { out.push(...gO[0].s); }
    else {
      out.push('<<<<<<< OURS', ...gO.flatMap(g => g.s), '=======', ...gT.flatMap(g => g.s), '>>>>>>> THEIRS'); conflicts++;
    }
    bCur = end;
  }
  if (bCur < B.length) for (let k = bCur; k < B.length; k++) out.push(B[k]);
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
  let conflicts = 0; const report = []; const renames = [];
  const curWork = await loadCache(root);
  // rename 检测（v1.2）：一侧删除旧路径且新增同哈希内容 = 重命名；对侧对旧路径的修改迁移到新路径
  const handled = new Set();
  const oAddedByHash = {}; for (const p of Object.keys(sm2)) if (!bmM[p]) oAddedByHash[sm2[p].h] = p;
  const tAddedByHash = {}; for (const p of Object.keys(amM)) if (!bmM[p]) tAddedByHash[amM[p].h] = p;
  for (const p of Object.keys(bmM)) {
    const yO = (!sm2[p] && oAddedByHash[bmM[p].h]) || null;  // ours 把 p 重命名为 yO（内容未动）
    const yT = (!amM[p] && tAddedByHash[bmM[p].h]) || null;  // theirs 把 p 重命名为 yT
    if (yO && amM[p] && amM[p].h !== bmM[p].h && !amM[yO] && !handled.has(yO)) {
      result[yO] = amM[p]; handled.add(p); handled.add(yO); renames.push(`${p} -> ${yO}（采纳对侧修改）`);
    } else if (yT && sm2[p] && sm2[p].h !== bmM[p].h && !sm2[yT] && !handled.has(yT)) {
      result[yT] = sm2[p]; handled.add(p); handled.add(yT); renames.push(`${p} -> ${yT}（采纳本侧修改）`);
    }
  }
  for (const p of paths) {
    if (handled.has(p)) continue;
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
  if (renames.length && opts.reportRenames) renames.forEach(r => ok('RENAME ' + r));
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
// ---------- 局域网协作：bundle 导出/导入（不可信输入，全量重哈希校验） ----------
const BUNDLE_MAGIC = 'QVB1\n';
async function collectReachable(root) {
  const snaps = await loadSnaps(root);
  const hashes = new Set();
  for (const s of snaps.values()) {
    hashes.add(s.id); hashes.add(s.tree);
    const m = JSON.parse((await get(root, s.tree)).toString());
    for (const p of Object.keys(m)) hashes.add(m[p].h);
  }
  return { snaps, hashes };
}
async function cmdExport(root, file) {
  if (!file) die('用法: qv export <file.qvb>');
  const { snaps, hashes } = await collectReachable(root);
  const heads = {};
  for (const b of await fsp.readdir(headsDir(root))) heads[b] = await readHead(root, b);
  const snapLog = await fsp.readFile(path.join(root, QV, 'snapshots.jsonl'));
  const parts = [];
  for (const h of hashes) parts.push(await get(root, h));
  const header = Buffer.from(BUNDLE_MAGIC + hashes.size + '\n' + parts.map((b, i) => [...hashes][i] + ' ' + b.length).join('\n') + '\n', 'utf8');
  const sepSnaps = Buffer.from('\n===SNAPS===\n', 'utf8');
  const sepRefs = Buffer.from('\n===REFS===\n', 'utf8');
  await fsp.writeFile(file, Buffer.concat([header, ...parts, sepSnaps, snapLog, sepRefs, Buffer.from(JSON.stringify(heads))]));
  ok(`导出 ${hashes.size} 对象 / ${snaps.size} 快照 / ${Object.keys(heads).length} 分支 -> ${file}`);
}
async function cmdImport(root, file) {
  if (!file) die('用法: qv import <file.qvb>');
  // clone 语义：空目录导入即初始化（协作新成员起步方式）
  const isClone = !fs.existsSync(path.join(root, QV));
  if (isClone) {
    await fsp.mkdir(path.join(root, QV, 'refs', 'heads'), { recursive: true });
    await fsp.writeFile(path.join(root, QV, 'config.json'), JSON.stringify({ v: 1, algo: 'sha256', created: Date.now() }, null, 2));
    await fsp.writeFile(path.join(root, QV, 'HEAD'), 'main\n');
  }
  let buf;
  try { buf = await fsp.readFile(file); } catch { die(`无法读取: ${file}`); }
  if (!buf.subarray(0, 5).equals(Buffer.from(BUNDLE_MAGIC))) die('不是 qv bundle（魔数不符）');
  // 解析对象表
  const headEnd = buf.indexOf(10, 5); // 换行：对象个数行
  const nObj = parseInt(buf.subarray(5, headEnd).toString(), 10);
  let off = headEnd + 1;
  const table = [];
  for (let i = 0; i < nObj; i++) {
    const eol = buf.indexOf(10, off);
    const [h, sz] = buf.subarray(off, eol).toString().split(' ');
    if (!/^[0-9a-f]{64}$/.test(h)) die(`非法哈希: ${h}`);
    table.push({ h, sz: parseInt(sz, 10) });
    off = eol + 1;
  }
  // 读对象体并全量重哈希（防投毒：内容哈希必须等于声称键）
  let imported = 0, skipped = 0;
  for (const t of table) {
    const body = buf.subarray(off, off + t.sz); off += t.sz;
    const real = crypto.createHash('sha256').update(body).digest('hex');
    if (real !== t.h) die(`对象哈希不符（拒绝导入）: ${t.h.slice(0, 12)}`);
    if (await has(root, t.h)) skipped++; else { await fsp.mkdir(objDir(root, t.h), { recursive: true }); await fsp.writeFile(path.join(objDir(root, t.h), t.h.slice(2)), body); imported++; }
  }
  const sIdx = buf.indexOf('===SNAPS===', off);
  const rIdx = buf.indexOf('===REFS===', sIdx);
  if (sIdx < 0 || rIdx < 0 || rIdx < sIdx) die('bundle 结构损坏');
  const inSnaps = buf.subarray(sIdx + 12, rIdx).toString().trim();
  const have = await loadSnaps(root);
  let addSnaps = 0;
  for (const ln of inSnaps.split('\n')) {
    if (!ln.trim()) continue;
    const o = JSON.parse(ln);
    if (!have.has(o.id)) { await appendSnap(root, o); addSnaps++; }
  }
  const inHeads = JSON.parse(buf.subarray(rIdx + 11).toString());
  const newBranches = [];
  for (const b of Object.keys(inHeads)) {
    let name = b;
    if (await readHead(root, name)) { if (await readHead(root, name) === inHeads[b]) continue; name = b + '-peer'; }
    await writeHead(root, name, inHeads[b]);
    newBranches.push(name);
  }
  ok(`导入 ${imported} 对象（${skipped} 已有）/ ${addSnaps} 快照；分支: ${newBranches.join(', ') || '(无新增)'}`);
  if (newBranches.length) ok(`可合并: qv merge ${newBranches[0]}   或批量: qv batch-merge`);
  // clone 模式：落盘主分支工作区（否则新成员拿到的是空目录）
  if (isClone) {
    const snaps2 = await loadSnaps(root);
    const mainId = inHeads['main'] || Object.values(inHeads)[0];
    if (mainId && snaps2.has(mainId)) {
      await restore(root, JSON.parse((await get(root, snaps2.get(mainId).tree)).toString()));
      ok(`已检出 ${inHeads['main'] ? 'main' : Object.keys(inHeads)[0]} 分支工作区（${Object.keys(JSON.parse((await get(root, snaps2.get(mainId).tree)).toString())).length} 文件）`);
    }
  }
}

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
  const r = await doMerge(root, src, dst, { conflict: 'mark', msg, reportRenames: true });
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
    case 'export': return cmdExport(root, rest[0]);
    case 'import': return cmdImport(root, rest[0]);
    case 'gc': return cmdGc(root);
    case 'diff': return cmdDiff(root, rest[0]);
    case 'status': return cmdStatus(root);
    default:
      ok('qv — 快照模型 VCS（实验 O(1) / sha256 内容寻址 / 批量合并）\n用法: init | snap [-m msg] | branch [name] | switch <br|snap> | log | merge <src> [--into=dst] | batch-merge [pattern...] | verify [--deep] | export <file.qvb> | import <file.qvb> | gc | diff | status | drop <br>');
      if (cmd) die('未知命令: ' + cmd);
  }
}
if (require.main === module) main().catch(e => die(e.stack || e.message));
module.exports = { diff3, safePath, manifestBuf, manifestHash };
