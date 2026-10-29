#!/usr/bin/env node
// qv — quick-experiment version control. 快照模型 VCS：实验 O(1)、SHA-256 内容寻址、
// 增量快照、文件级三方合并、批量级联合并、全库 Merkle 校验。单文件零依赖（Node >= 20）。
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const QV = '.qv';
const CONC = 32;
const VERSION = '1.4.1';
const BIG_FILE = 64 * 1024 * 1024;   // 超过此尺寸走分块存储（AI checkpoint/模型权重场景）
const CHUNK = 8 * 1024 * 1024;       // 分块大小

const die = (m) => { console.error('qv: ' + m); process.exit(1); };
const ok = (m) => { console.log(m); };
const BRANCH_OK = /^[A-Za-z0-9_.-]{1,64}$/; // 分支名白名单：bundle/import 不可信输入的路径穿越防线
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
// 大文件分块存储：块本身是小 blob（内容寻址自动去重），块哈希列表内联进 manifest entry
async function hashBigFile(root, absPath, size) {
  const fh = await fsp.open(absPath, 'r');
  try {
    const buf = Buffer.alloc(CHUNK); const chunks = []; const hashs = [];
    for (let off = 0; off < size; off += CHUNK) {
      const { bytesRead } = await fh.read(buf, 0, CHUNK, off);
      const h = await put(root, buf.subarray(0, bytesRead));
      chunks.push(h); hashs.push(h);
    }
    const top = crypto.createHash('sha256').update(hashs.join('\n')).digest('hex');
    return { h: top, s: size, chunks };
  } finally { await fh.close(); }
}
// 把对象（普通或分块）流式写到目标路径（大文件不进内存）
async function materialize(root, entry, dest) {
  if (!entry.chunks) { await fsp.writeFile(dest, await get(root, entry.h)); return; }
  const fh = await fsp.open(dest, 'w');
  try { for (const c of entry.chunks) { await fh.writeFile(await get(root, c)); } } finally { await fh.close(); }
}
async function has(root, h) { try { await fsp.access(path.join(objDir(root, h), h.slice(2))); return true; } catch { return false; } }

// ---------- manifest：路径 → {h,size,mtime}，稳定序列化保证内容寻址 ----------
function manifestBuf(m) {
  const o = {};
  for (const p of Object.keys(m).sort()) o[p] = m[p].chunks ? { h: m[p].h, s: m[p].s, chunks: m[p].chunks } : { h: m[p].h, s: m[p].s };
  return Buffer.from(JSON.stringify(o));
}
function manifestHash(m) { return crypto.createHash('sha256').update(manifestBuf(m)).digest('hex'); }

// ---------- 忽略规则（.qvignore，gitignore 风格子集；内置最低默认集） ----------
async function loadIgnores(root) {
  const pats = ['node_modules/', '__pycache__/'];
  try {
    const txt = (await fsp.readFile(path.join(root, '.qvignore'), 'utf8')).replace(/^\ufeff/, ''); // 剥 BOM：PowerShell 5.1/Notepad 写 UTF-8 带 BOM 会粘死第一条规则
    for (let ln of txt.split(/\r?\n/)) { ln = ln.trim(); if (ln && !ln.startsWith('#')) pats.push(ln); }
  } catch {}
  const rxs = pats.map(p => {
    const dir = p.endsWith('/');
    const body = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
    return dir ? new RegExp('(^|/)' + body) : new RegExp('(^|/)' + body + '$');
  });
  return (p) => rxs.some(rx => rx.test(p));
}

// ---------- 工作区扫描（增量：mtime+size 未变沿用缓存哈希；无权限目录容错跳过） ----------
async function walkDir(root, dir, ignored, out) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
  catch { return; } // EPERM / EBUSY / EBADF（System Volume Information 等）→ 跳过不崩
  for (const e of entries) {
    const p = path.relative(root, path.join(dir, e.name)).replace(/\\/g, '/');
    if (e.isDirectory()) {
      if (p === QV || ignored(p + '/')) continue;
      await walkDir(root, path.join(dir, e.name), ignored, out);
    } else if (e.isFile() && p !== QV && !ignored(p)) out.push(p);
  }
}
async function scanWorkdir(root, last) {
  const ignored = await loadIgnores(root);
  const files = [];
  await walkDir(root, root, ignored, files);
  const m = {};
  const queue = [...files];
  while (queue.length) {
    const batch = queue.splice(0, CONC);
    await Promise.all(batch.map(async p => {
      const st = await fsp.stat(path.join(root, p));
      const c = last && last[p];
      if (c && c.s === st.size && c.m === Math.floor(st.mtimeMs) && await has(root, c.h)) { m[p] = c; return; }
      if (st.size > BIG_FILE) { const e = await hashBigFile(root, path.join(root, p), st.size); e.m = Math.floor(st.mtimeMs); m[p] = e; return; }
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
  // 写入判断不信缓存：stat 事实核对（外部改动 size 不符必须重写，缓存会被外部编辑骗）
  const toWrite = [];
  for (const p of Object.keys(target)) {
    let need = !cur[p] || cur[p].h !== target[p].h;
    if (!need) {
      try { const st = await fsp.stat(path.join(root, p)); if (st.size !== target[p].s) need = true; }
      catch { need = true; }
    }
    if (need) toWrite.push(p);
  }
  const q = [...toWrite];
  while (q.length) {
    const batch = q.splice(0, CONC);
    await Promise.all(batch.map(async p => {
      const f = path.join(root, p);
      await fsp.mkdir(path.dirname(f), { recursive: true });
      await materialize(root, target[p], f);
    }));
  }
  const now = {};
  for (const p of Object.keys(target)) { const st = await fsp.stat(path.join(root, p)); now[p] = { ...target[p], s: st.size, m: Math.floor(st.mtimeMs) }; }
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
    // 双侧同文件不同改动 → 大文件（分块）不做行级合并：标记冲突保留 ours；普通文件走行级三方
    const big = (inB && inB.chunks) || (inO && inO.chunks) || (inT && inT.chunks);
    if (big) {
      conflicts++;
      report.push(p);
      console.error(`  CONFLICT(大文件): ${p}（分块对象不做行级合并，保留 ${hO ? 'ours' : 'theirs'} 侧）`);
      if (opts.conflict !== 'skip') result[p] = hO ? inO : inT;
      continue;
    }
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
    for (const p of Object.keys(m)) {
      hashes.add(m[p].h);
      if (m[p].chunks) for (const c of m[p].chunks) hashes.add(c);
    }
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
  const postSnaps = await loadSnaps(root); // 校验分支指向的快照真实存在（防悬空引用）
  for (const b of Object.keys(inHeads)) {
    if (!BRANCH_OK.test(b)) die(`非法分支名（拒绝导入）: ${JSON.stringify(b)}`);
    if (!/^[0-9a-f]{64}$/.test(inHeads[b] || '') || !postSnaps.has(inHeads[b])) die(`非法/悬空快照哈希（拒绝导入）: ${b}`);
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

// ---------- 跨机同步：push / pull（SSH 主通道 + 本地路径模式，bundle 协议复用） ----------
function run(argv, opts) { return execFileSync(argv[0], argv.slice(1), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts }); }
function isRemote(target) { return /^[A-Za-z0-9_.-]+@/.test(target) || /:/.test(target) && !/^[A-Za-z]:[\\/]/.test(target); }
function parseRemote(target) {
  // user@host[:dir] 或 user@host:dir
  const at = target.indexOf('@');
  const hostAndDir = at >= 0 ? target.slice(at + 1) : target;
  const ci = hostAndDir.indexOf(':');
  const host = ci >= 0 ? hostAndDir.slice(0, ci) : hostAndDir;
  const dir = ci >= 0 ? hostAndDir.slice(ci + 1) : 'qv-repo';
  const user = at >= 0 ? target.slice(0, at) : null;
  return { sshTarget: user ? `${user}@${host}` : host, dir: dir.replace(/\\/g, '/') };
}
async function ensureRemoteTool(rt, localTool) {
  // 远程没有 qv.js 则自引导传一份（单文件自足性）
  try { run(['ssh', rt.sshTarget, `test -f ${rt.dir}/qv.js`]); return `${rt.dir}/qv.js`; }
  catch {
    run(['ssh', rt.sshTarget, `mkdir -p ${rt.dir}`]);
    run(['scp', localTool, `${rt.sshTarget}:${rt.dir}/qv.js`]);
    return `${rt.dir}/qv.js`;
  }
}
async function cmdPush(root, target, toolPath) {
  const tmpBundle = path.join(process.env.TEMP || '/tmp', `qv-push-${Date.now()}.qvb`);
  await cmdExport(root, tmpBundle);
  if (isRemote(target)) {
    const rt = parseRemote(target);
    const remoteTool = await ensureRemoteTool(rt, toolPath || __filename);
    run(['scp', tmpBundle, `${rt.sshTarget}:${rt.dir}/.qv-incoming.qvb`]);
    const out = run(['ssh', rt.sshTarget, `node ${remoteTool} import ${rt.dir}/.qv-incoming.qvb && rm -f ${rt.dir}/.qv-incoming.qvb`]);
    process.stdout.write(out);
  } else {
    // 本地路径模式（同机仓库目录直推，也用于 CI/回环测试）
    const destRoot = path.resolve(target);
    if (!fs.existsSync(path.join(destRoot, QV))) die(`目标不是 qv 仓库: ${destRoot}（先在其 init 或 import clone）`);
    await cmdImport(destRoot, tmpBundle);
  }
  fs.unlinkSync(tmpBundle);
  ok(`push -> ${target} 完成`);
}
async function cmdPull(root, target, toolPath) {
  const tmpBundle = path.join(process.env.TEMP || '/tmp', `qv-pull-${Date.now()}.qvb`);
  if (isRemote(target)) {
    const rt = parseRemote(target);
    const remoteTool = await ensureRemoteTool(rt, toolPath || __filename);
    run(['ssh', rt.sshTarget, `node ${remoteTool} export ${rt.dir}/.qv-outgoing.qvb`]);
    run(['scp', `${rt.sshTarget}:${rt.dir}/.qv-outgoing.qvb`, tmpBundle]);
    run(['ssh', rt.sshTarget, `rm -f ${rt.dir}/.qv-outgoing.qvb`]);
  } else {
    const srcRoot = path.resolve(target);
    await cmdExport(srcRoot, tmpBundle);
  }
  await cmdImport(root, tmpBundle);
  fs.unlinkSync(tmpBundle);
  ok(`pull <- ${target} 完成；可 merge 同步过来的分支`);
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
  if (!BRANCH_OK.test(target || '')) die(`非法分支名: ${JSON.stringify(target)}`);
  if ((await currentBranch(root)) === target) die(`不能 drop 当前分支（先 qv switch 其他分支）`);
  const f = path.join(headsDir(root), target);
  try { await fsp.access(f); } catch { die(`分支不存在: ${target}`); }
  const droppedTo = (await fsp.readFile(f, 'utf8')).trim();
  await fsp.rm(f);
  await fsp.appendFile(path.join(root, QV, 'reflog.jsonl'), JSON.stringify({ ts: Date.now(), drop: target, to: droppedTo }) + '\n');
  ok(`已丢弃 ${target}（qv undrop 可撤销，对象留待 qv gc）`);
}

async function cmdUndrop(root) {
  const txt = await fsp.readFile(path.join(root, QV, 'reflog.jsonl'), 'utf8');
  const lines = txt.trim().split('\n').map(l => JSON.parse(l));
  for (let i = lines.length - 1; i >= 0; i--) {
    const e = lines[i];
    if (e.drop && e.to && !(await readHead(root, e.drop))) {
      if (await readHead(root, e.drop + '-peer')) { die(`名字被占用: ${e.drop}-peer`); }
      await writeHead(root, e.drop, e.to);
      return ok(`已撤销删除: ${e.drop} -> ${e.to.slice(0, 12)}`);
    }
  }
  die('reflog 中没有可撤销的 drop');
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
        const e = m[p];
        if (e.chunks) {
          for (const c of e.chunks) {
            try { const b = await get(root, c); if (crypto.createHash('sha256').update(b).digest('hex') !== c) { bad++; console.error(`块损坏: ${p}[${c.slice(0, 8)}]`); } checked++; }
            catch { bad++; console.error(`块缺失: ${p}[${c.slice(0, 8)}]`); }
          }
          continue;
        }
        try { const buf2 = await get(root, e.h); if (crypto.createHash('sha256').update(buf2).digest('hex') !== e.h) { bad++; console.error(`blob 损坏: ${p}`); } checked++; }
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
    for (const p of Object.keys(m)) {
      live.add(m[p].h);
      if (m[p].chunks) for (const c of m[p].chunks) live.add(c);
    }
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

async function resolveTarget(root, snaps, target) {
  if (!target) return null;
  const h = await readHead(root, target);
  if (h) return { id: h, br: target };
  if (snaps.has(target)) return { id: target, br: snaps.get(target).branch };
  const k = Array.from(snaps.keys()).find(k => k.startsWith(target));
  if (k) return { id: k, br: snaps.get(k).branch };
  return null;
}
async function cmdDiff(root, arg1, arg2) {
  const snaps = await loadSnaps(root);
  // 两参数：任意两快照/分支对比（Scion "queries as API" 启发）
  if (arg1 && arg2) {
    const A = await resolveTarget(root, snaps, arg1), B = await resolveTarget(root, snaps, arg2);
    if (!A) die(`未找到: ${arg1}`); if (!B) die(`未找到: ${arg2}`);
    const mA = JSON.parse((await get(root, snaps.get(A.id).tree)).toString());
    const mB = JSON.parse((await get(root, snaps.get(B.id).tree)).toString());
    let n = 0;
    for (const p of new Set([...Object.keys(mA), ...Object.keys(mB)])) {
      const ha = mA[p] && mA[p].h, hb = mB[p] && mB[p].h;
      if (ha !== hb) { ok(`${!ha ? '+' : !hb ? '-' : '~'} ${p}`); n++; }
    }
    if (!n) ok(`${arg1} 与 ${arg2} 内容一致`);
    return;
  }
  const cur = await scanWorkdir(root, await loadCache(root));
  const headId = await readHead(root, arg1 || (await currentBranch(root)));
  if (!headId) die(`分支不存在: ${arg1 || await currentBranch(root)}`);
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
    case '--version': case '-v': case 'version': return ok('qv ' + VERSION);
    case 'init': return cmdInit(root);
    case 'snap': return cmdSnap(root, rest);
    case 'branch': return cmdBranch(root, rest[0]);
    case 'switch': return cmdSwitch(root, rest[0]);
    case 'log': return cmdLog(root, rest[0]);
    case 'drop': return cmdDrop(root, rest[0]);
    case 'undrop': return cmdUndrop(root);
    case 'merge': return cmdMerge(root, rest[0], rest[1]);
    case 'batch-merge': return cmdBatchMerge(root, rest);
    case 'verify': return cmdVerify(root, rest.includes('--deep'));
    case 'export': return cmdExport(root, rest[0]);
    case 'import': return cmdImport(root, rest[0]);
    case 'push': return cmdPush(root, rest[0], rest[1] && rest[1].startsWith('--tool=') ? rest[1].slice(7) : undefined);
    case 'pull': return cmdPull(root, rest[0], rest[1] && rest[1].startsWith('--tool=') ? rest[1].slice(7) : undefined);
    case 'gc': return cmdGc(root);
    case 'diff': return cmdDiff(root, rest[0], rest[1]);
    case 'status': return cmdStatus(root);
    default:
      ok('qv — 快照模型 VCS（实验 O(1) / sha256 内容寻址 / 批量合并）\n用法: init | snap [-m msg] | branch [name] | switch <br|snap> | log | merge <src> [--into=dst] | batch-merge [pattern...] | verify [--deep] | export <file.qvb> | import <file.qvb> | push <user@host:dir|本地路径> | pull <...> | diff [<a> <b>] | status | drop <br> | --version\n大文件(>64MB)自动分块存储；push/pull 走系统 ssh/scp（零依赖），远程无 qv 会自动传一份过去');
      if (cmd) die('未知命令: ' + cmd);
  }
}
if (require.main === module) main().catch(e => die(e.stack || e.message));
module.exports = { diff3, safePath, manifestBuf, manifestHash };
