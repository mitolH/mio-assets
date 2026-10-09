// 素材库加载与规则引擎（零依赖）。默认检查本仓库；ASSET_REPO_DIR 可指向别处（如草稿目录）。
import { readFileSync, readdirSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TILE = 16;
export const ROOT = resolve(process.env.ASSET_REPO_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..'));

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const listJson = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : []);

export function loadRepo() {
  const components = new Map();
  const componentFiles = [];
  const compDir = join(ROOT, 'components');
  for (const cat of existsSync(compDir) ? readdirSync(compDir).filter((n) => statSync(join(compDir, n)).isDirectory()).sort() : []) {
    for (const f of listJson(join(compDir, cat))) {
      const rel = `components/${cat}/${f}`;
      const data = readJson(join(ROOT, rel));
      componentFiles.push({ rel, cat, file: f, data });
      components.set(data.id, data);
    }
  }
  const maps = listJson(join(ROOT, 'maps')).map((f) => ({ rel: `maps/${f}`, file: f, data: readJson(join(ROOT, 'maps', f)) }));
  const sprites = listJson(join(ROOT, 'sprites')).map((f) => ({ rel: `sprites/${f}`, file: f, data: readJson(join(ROOT, 'sprites', f)) }));
  const manifest = existsSync(join(ROOT, 'manifest.json')) ? readJson(join(ROOT, 'manifest.json')) : null;
  return { components, componentFiles, maps, sprites, manifest, spriteMap: new Map(sprites.map((s) => [s.data.id, s.data])) };
}

// ---- 基线：已知的历史遗留问题，按 "规则|对象" 记录；新增违规才会失败 ----
const BASELINE_PATH = join(ROOT, 'tests', 'baseline.json');
const baseline = existsSync(BASELINE_PATH) ? new Set(readJson(BASELINE_PATH)) : new Set();
const collected = new Set();

/** violations: string[]，每项形如 "rule|subject|detail"；前两段构成基线 key。 */
export function assertNoNewViolations(t, violations) {
  const fresh = [];
  for (const v of violations) {
    const key = v.split('|').slice(0, 2).join('|');
    collected.add(key);
    if (!baseline.has(key)) fresh.push(v.replace('|', ' | '));
  }
  if (fresh.length) {
    const byRule = {};
    for (const f of fresh) { const r = f.split(' | ')[0]; byRule[r] = (byRule[r] ?? 0) + 1; }
    const summary = Object.entries(byRule).map(([r, n]) => `${r}×${n}`).join('  ');
    // 每条规则最多展示 8 条示例，避免被单一规则刷屏
    const perRule = {}, shown = [];
    for (const f of fresh) { const r = f.split(' | ')[0]; perRule[r] = (perRule[r] ?? 0) + 1; if (perRule[r] <= 8) shown.push(f); }
    throw new Error(`${fresh.length} 个新违规 [${summary}]:\n  ${shown.join('\n  ')}`);
  }
}

export function flushBaseline() {
  if (process.env.UPDATE_BASELINE === '1') {
    const merged = new Set([...(existsSync(BASELINE_PATH) ? readJson(BASELINE_PATH) : []), ...collected]); // 各测试文件是独立进程，合并写入
    writeFileSync(BASELINE_PATH, JSON.stringify([...merged].sort(), null, 2) + '\n');
  }
}

// ---- 组件像素工具 ----
export function tilePixels(comp, tx, ty) {
  // 与运行时一致：超出像素范围的部分视为透明(0)
  const out = [];
  for (let y = 0; y < TILE; y++) {
    const row = comp.pixels[ty * TILE + y] ?? [];
    out.push(Array.from({ length: TILE }, (_, x) => row[tx * TILE + x] ?? 0));
  }
  return out;
}
export const isOpaqueTile = (comp, tx, ty) => tilePixels(comp, tx, ty).every((r) => r.every((v) => v !== 0));
export const hasOpaque = (comp, tx, ty) => tilePixels(comp, tx, ty).some((r) => r.some((v) => v !== 0));
export const isSpriteRef = (r) => r.assetType === 'sprite' || (!!r.spriteId && !r.componentId);
export { basename };

// ---- 碰撞：与运行时 src/engine/sprite-collision.ts + CollisionGrid + OccupancyRegistry 同一语义 ----
// 精灵 ref 的 (tileX,tileY) = 脚底格。精灵碰撞默认只占脚底一格（footprint 缺省 = 1×1、offset 0/0，相对脚底格）；
// footprint.origin === 'sprite-box' 的旧数据 offset 相对画布左上角格，按 anchor 换算回脚底坐标。
// ref.collision 覆盖：'none' = 不挡；{ tiles:[{dx,dy}] } = 精确格（精灵相对脚底格，组件相对左上角格）。
// 运行时精灵演员不进静态网格，而是作为占位者按实时位置占格（隐藏时让开）；校验里取最坏情况：所有演员都在摆放格挡路。
export const DEFAULT_FOOTPRINT = Object.freeze({ tileWidth: 1, tileHeight: 1, offsetTileX: 0, offsetTileY: 0 });
const num = (v) => typeof v === 'number' && Number.isFinite(v);

export function resolveFootprint(sp) {
  const fp = sp.footprint;
  if (!fp) return { ...DEFAULT_FOOTPRINT };
  const out = {
    tileWidth: num(fp.tileWidth) && fp.tileWidth > 0 ? Math.floor(fp.tileWidth) : 1,
    tileHeight: num(fp.tileHeight) && fp.tileHeight > 0 ? Math.floor(fp.tileHeight) : 1,
    offsetTileX: num(fp.offsetTileX) ? Math.round(fp.offsetTileX) : 0,
    offsetTileY: num(fp.offsetTileY) ? Math.round(fp.offsetTileY) : 0,
  };
  if (fp.origin === 'sprite-box') {
    out.offsetTileX -= Math.floor(sp.anchorX / TILE);
    out.offsetTileY -= Math.max(0, Math.ceil(sp.anchorY / TILE) - 1);
  }
  return out;
}

/** 精灵自身碰撞形状（相对脚底格）：collisionMask 优先，否则 footprint 矩形。 */
export function spriteOffsets(sp) {
  const fp = resolveFootprint(sp);
  const out = [];
  if (sp.collisionMask?.length) sp.collisionMask.forEach((row, r) => row.forEach((c, k) => c && out.push({ dx: fp.offsetTileX + k, dy: fp.offsetTileY + r })));
  else for (let r = 0; r < fp.tileHeight; r++) for (let k = 0; k < fp.tileWidth; k++) out.push({ dx: fp.offsetTileX + k, dy: fp.offsetTileY + r });
  return out;
}

/** ref.collision 覆盖；undefined = 无覆盖。 */
export function refOverride(ref) {
  const o = ref.collision;
  if (o === undefined || o === null) return undefined;
  if (o === 'none') return [];
  if (typeof o === 'object' && Array.isArray(o.tiles)) return o.tiles.filter((t) => t && num(t.dx) && num(t.dy)).map((t) => ({ dx: Math.round(t.dx), dy: Math.round(t.dy) }));
  return undefined;
}

/** ref 的碰撞形状（相对 ref.tileX/tileY）。 */
export function refOffsets(repo, ref) {
  const override = refOverride(ref);
  if (override) return override;
  if (isSpriteRef(ref)) { const sp = repo.spriteMap.get(ref.spriteId); return sp ? spriteOffsets(sp) : [{ dx: 0, dy: 0 }]; }
  const mask = repo.components.get(ref.componentId)?.collisionMask;
  const out = [];
  if (mask) mask.forEach((row, r) => row.forEach((c, k) => c && out.push({ dx: k, dy: r })));
  return out;
}

const objectRefs = (map) => map.layers.filter((l) => l.type === 'object' || l.type === 'collision').flatMap((l) => l.components);

/** 演员（object/collision 层上的精灵 ref）→ 占格列表 [{x,y}]。 */
export function actorTiles(repo, map) {
  const out = [];
  for (const ref of objectRefs(map)) {
    if (!isSpriteRef(ref) || !repo.spriteMap.has(ref.spriteId)) continue;
    out.push({ ref, refId: ref.refId, tiles: refOffsets(repo, ref).map((o) => ({ x: ref.tileX + o.dx, y: ref.tileY + o.dy })) });
  }
  return out;
}

/**
 * 返回 blocked[y][x]：静态碰撞 + （默认）所有演员的占格（最坏情况：都站在摆放格）。
 * skipRefIds 中的 ref 不挡（例如会走动的自主演员、或正在检查的演员自身）；opts.actors === false 只要静态网格。
 */
export function buildCollisionGrid(repo, map, skipRefIds = new Set(), opts = {}) {
  const W = map.widthInTiles, H = map.heightInTiles;
  const blocked = Array.from({ length: H }, () => new Array(W).fill(false));
  const set = (x, y) => { if (x >= 0 && y >= 0 && x < W && y < H) blocked[y][x] = true; };
  for (const ref of objectRefs(map)) {
    if (ref.refId && skipRefIds.has(ref.refId)) continue;
    if (isSpriteRef(ref)) {
      if (opts.actors === false || !repo.spriteMap.has(ref.spriteId)) continue;
    } else if (!repo.components.has(ref.componentId)) continue;
    for (const o of refOffsets(repo, ref)) set(ref.tileX + o.dx, ref.tileY + o.dy);
  }
  return blocked;
}
