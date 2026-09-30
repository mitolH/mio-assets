import { test, after } from 'node:test';
import { loadRepo, assertNoNewViolations, flushBaseline, isOpaqueTile, hasOpaque, isSpriteRef, TILE } from './lib/repo.mjs';

const repo = loadRepo();
after(flushBaseline);

/** 与运行时 AssetTilesetFactory.buildFromEditorMap 同一语义：
 *  ground 层每格只保留最后写入的一个 tile；其余可见层（collision 层除外）共用一个 overlay，同样每格仅一个 tile。 */
function simulate(map) {
  const W = map.widthInTiles, H = map.heightInTiles;
  const ground = new Array(W * H).fill(null);
  const overlay = new Array(W * H).fill(null);
  const clobbers = new Map(); // "earlier -> later" => 被覆盖的有像素 tile 数
  const oob = [];
  for (const layer of map.layers) {
    if (layer.visible === false || layer.type === 'collision') continue;
    const target = layer.type === 'ground' ? ground : overlay;
    for (const ref of layer.components) {
      if (isSpriteRef(ref) || !ref.componentId) continue;
      const comp = repo.components.get(ref.componentId);
      if (!comp) continue;
      for (let ty = 0; ty < comp.tileHeight; ty++) for (let tx = 0; tx < comp.tileWidth; tx++) {
        const x = ref.tileX + tx, y = ref.tileY + ty;
        if (x < 0 || y < 0 || x >= W || y >= H) { if (hasOpaque(comp, tx, ty)) oob.push(`${comp.id}@(${x},${y})`); continue; }
        const prev = target[y * W + x];
        if (target === overlay && prev && hasOpaque(prev.comp, prev.tx, prev.ty)) {
          const k = `${prev.comp.id} -> ${comp.id}`;
          clobbers.set(k, (clobbers.get(k) ?? 0) + 1);
        }
        target[y * W + x] = { comp, tx, ty };
      }
    }
  }
  return { W, H, ground, overlay, clobbers, oob };
}

function collisionGrid(map) {
  const W = map.widthInTiles, H = map.heightInTiles;
  const blocked = Array.from({ length: H }, () => new Array(W).fill(false));
  const set = (x, y) => { if (x >= 0 && y >= 0 && x < W && y < H) blocked[y][x] = true; };
  for (const layer of map.layers) {
    if (layer.type !== 'object' && layer.type !== 'collision') continue;
    for (const ref of layer.components) {
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

test('地图引用：组件/精灵存在且已登记在 level.assets', (t) => {
  const v = [];
  for (const { data: m } of repo.maps) {
    const listedC = new Set(m.level?.assets?.componentIds ?? []);
    const listedS = new Set(m.level?.assets?.spriteIds ?? []);
    const usedC = new Set(), usedS = new Set();
    for (const layer of m.layers) for (const ref of layer.components) {
      if (isSpriteRef(ref)) { usedS.add(ref.spriteId); if (!repo.spriteMap.has(ref.spriteId)) v.push(`ref-missing-sprite|${m.id}:${ref.spriteId}|图层 ${layer.name}`); }
      else { usedC.add(ref.componentId); if (!repo.components.has(ref.componentId)) v.push(`ref-missing-component|${m.id}:${ref.componentId}|图层 ${layer.name}`); }
    }
    for (const id of usedC) if (!listedC.has(id)) v.push(`assets-unlisted-component|${m.id}:${id}|使用了但未列入 level.assets.componentIds`);
    for (const id of usedS) if (!listedS.has(id)) v.push(`assets-unlisted-sprite|${m.id}:${id}|使用了但未列入 level.assets.spriteIds`);
    for (const id of listedC) if (!repo.components.has(id)) v.push(`assets-missing-component|${m.id}:${id}|level.assets 列出但不存在`);
  }
  assertNoNewViolations(t, v);
});

test('ground 层：每格都有 tile 且完全不透明（否则运行时露出黑底）', (t) => {
  const v = [];
  for (const { data: m } of repo.maps) {
    const { W, H, ground } = simulate(m);
    const holes = [], transparent = new Map();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const c = ground[y * W + x];
      if (!c) { holes.push(`(${x},${y})`); continue; }
      if (!isOpaqueTile(c.comp, c.tx, c.ty)) transparent.set(c.comp.id, [...(transparent.get(c.comp.id) ?? []), `(${x},${y})`]);
    }
    if (holes.length) v.push(`ground-hole|${m.id}|${holes.length} 格无地面: ${holes.slice(0, 6).join(' ')}`);
    for (const [id, cells] of transparent) v.push(`ground-transparent|${m.id}:${id}|${cells.length} 格含透明像素(会显示黑底): ${cells.slice(0, 4).join(' ')}`);
  }
  assertNoNewViolations(t, v);
});

test('overlay 层：同一格后写入的 tile 不得吞掉先前有像素的 tile', (t) => {
  const v = [];
  for (const { data: m } of repo.maps) {
    const { clobbers, oob } = simulate(m);
    for (const [k, n] of clobbers) v.push(`overlay-clobber|${m.id}:${k}|${n} 格被覆盖，先前素材出现缺口`);
    if (oob.length) v.push(`out-of-bounds|${m.id}|${oob.length} 个有像素的 tile 越出地图: ${oob.slice(0, 4).join(' ')}`);
  }
  assertNoNewViolations(t, v);
});

test('可玩性：起点/地点可走、且从起点可达', (t) => {
  const v = [];
  for (const { data: m } of repo.maps) {
    if (!m.level?.startLocationId) continue;
    const blocked = collisionGrid(m);
    const locs = m.districts.flatMap((d) => (d.locations ?? []).map((l) => ({ ...l, x: d.x + l.offsetX, y: d.y + l.offsetY })));
    const start = locs.find((l) => l.id === m.level.startLocationId);
    if (!start) { v.push(`start-missing|${m.id}|startLocationId 找不到`); continue; }
    const inb = (x, y) => x >= 0 && y >= 0 && x < m.widthInTiles && y < m.heightInTiles;
    for (const l of locs) if (!inb(l.x, l.y) || blocked[l.y][l.x]) v.push(`location-blocked|${m.id}:${l.id}|(${l.x},${l.y}) 越界或被阻挡`);
    if (blocked[start.y]?.[start.x]) continue;
    const seen = new Set([`${start.x},${start.y}`]); const q = [[start.x, start.y]];
    while (q.length) { const [x, y] = q.shift(); for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) { const nx = x + dx, ny = y + dy; if (inb(nx, ny) && !blocked[ny][nx] && !seen.has(`${nx},${ny}`)) { seen.add(`${nx},${ny}`); q.push([nx, ny]); } } }
    for (const l of locs) if (l !== start && !blocked[l.y]?.[l.x] && !seen.has(`${l.x},${l.y}`)) v.push(`location-unreachable|${m.id}:${l.id}|(${l.x},${l.y}) 从起点不可达`);
  }
  assertNoNewViolations(t, v);
});
