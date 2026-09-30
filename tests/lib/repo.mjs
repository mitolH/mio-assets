// 素材库加载与规则引擎（零依赖）。默认检查本仓库；ASSET_REPO_DIR 可指向别处（如草稿目录）。
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
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
  for (const cat of existsSync(compDir) ? readdirSync(compDir).sort() : []) {
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
    const shown = fresh.slice(0, 40).join('\n  ');
    throw new Error(`${fresh.length} 个新违规:\n  ${shown}${fresh.length > 40 ? `\n  ... 另有 ${fresh.length - 40} 个` : ''}`);
  }
}

export function flushBaseline() {
  if (process.env.UPDATE_BASELINE === '1') {
    writeFileSync(BASELINE_PATH, JSON.stringify([...collected].sort(), null, 2) + '\n');
  }
}

// ---- 组件像素工具 ----
export function tilePixels(comp, tx, ty) {
  const out = [];
  for (let y = 0; y < TILE; y++) out.push(comp.pixels[ty * TILE + y].slice(tx * TILE, tx * TILE + TILE));
  return out;
}
export const isOpaqueTile = (comp, tx, ty) => tilePixels(comp, tx, ty).every((r) => r.every((v) => v !== 0));
export const hasOpaque = (comp, tx, ty) => tilePixels(comp, tx, ty).some((r) => r.some((v) => v !== 0));
export const isSpriteRef = (r) => r.assetType === 'sprite' || (!!r.spriteId && !r.componentId);
export { basename };
