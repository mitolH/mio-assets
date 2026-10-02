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

// ---- 碰撞网格：与运行时 CollisionGrid.buildFromMap 同一语义 ----
/** 返回 blocked[y][x]；skipRefIds 中的 ref（如会走动的自主演员）不留静态碰撞。 */
export function buildCollisionGrid(repo, map, skipRefIds = new Set()) {
  const W = map.widthInTiles, H = map.heightInTiles;
  const blocked = Array.from({ length: H }, () => new Array(W).fill(false));
  const set = (x, y) => { if (x >= 0 && y >= 0 && x < W && y < H) blocked[y][x] = true; };
  for (const layer of map.layers) {
    if (layer.type !== 'object' && layer.type !== 'collision') continue;
    for (const ref of layer.components) {
      if (ref.refId && skipRefIds.has(ref.refId)) continue;
      if (isSpriteRef(ref)) {
        const sp = repo.spriteMap.get(ref.spriteId); if (!sp) continue;
        const fp = sp.footprint ?? { tileWidth: 1, tileHeight: 1, offsetTileX: 0, offsetTileY: 0 };
        const bx = ref.tileX + fp.offsetTileX, by = ref.tileY + fp.offsetTileY;
        if (sp.collisionMask) sp.collisionMask.forEach((row, r) => row.forEach((c, k) => c && set(bx + k, by + r)));
        else for (let r = 0; r < fp.tileHeight; r++) for (let k = 0; k < fp.tileWidth; k++) set(bx + k, by + r);
      } else {
        const comp = repo.components.get(ref.componentId); const mask = comp?.collisionMask; if (!mask) continue;
        mask.forEach((row, r) => row.forEach((c, k) => c && set(ref.tileX + k, ref.tileY + r)));
      }
    }
  }
  return blocked;
}
