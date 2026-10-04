import { test, after } from 'node:test';
import { loadRepo, assertNoNewViolations, flushBaseline, isSpriteRef, TILE, buildCollisionGrid } from './lib/repo.mjs';

const repo = loadRepo();
after(flushBaseline);

/** 与运行时 bakeMapLayerCanvases 同一语义：按图层顺序逐像素叠加（后写入在上，透明不覆盖），
 *  ground 层与其余可见层（collision 层不渲染）分别烘焙。 */
function bake(map) {
  const PW = map.widthInTiles * TILE, PH = map.heightInTiles * TILE;
  const ground = new Uint8Array(PW * PH); // 1 = 该像素已被不透明像素覆盖
  const oob = new Set();
  for (const layer of map.layers) {
    if (layer.visible === false || layer.type === 'collision') continue;
    const isGround = layer.type === 'ground';
    for (const ref of layer.components) {
      if (isSpriteRef(ref) || !ref.componentId) continue;
      const comp = repo.components.get(ref.componentId);
      if (!comp) continue;
      const ox = ref.tileX * TILE, oy = ref.tileY * TILE;
      for (let y = 0; y < comp.pixels.length; y++) for (let x = 0; x < comp.pixels[y].length; x++) {
        if (comp.pixels[y][x] === 0) continue;
        const X = ox + x, Y = oy + y;
        if (X < 0 || Y < 0 || X >= PW || Y >= PH) { oob.add(comp.id); continue; }
        if (isGround) ground[Y * PW + X] = 1;
      }
    }
  }
  return { PW, PH, ground, oob };
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

test('ground 层：整张地图每个像素都被不透明地面覆盖（否则运行时露出黑底）', (t) => {
  const v = [];
  for (const { data: m } of repo.maps) {
    const { PW, PH, ground } = bake(m);
    const holeTiles = new Map();
    for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) {
      if (!ground[y * PW + x]) { const k = `(${Math.floor(x / TILE)},${Math.floor(y / TILE)})`; holeTiles.set(k, (holeTiles.get(k) ?? 0) + 1); }
    }
    if (holeTiles.size) v.push(`ground-hole|${m.id}|${holeTiles.size} 个 tile 含未覆盖像素: ${[...holeTiles.keys()].slice(0, 8).join(' ')}`);
  }
  assertNoNewViolations(t, v);
});

test('图层内容不得越出地图边界', (t) => {
  const v = [];
  for (const { data: m } of repo.maps) {
    const { oob } = bake(m);
    for (const id of oob) v.push(`out-of-bounds|${m.id}:${id}|有像素越出地图`);
  }
  assertNoNewViolations(t, v);
});

test('可玩性：起点/地点可走、且从起点可达', (t) => {
  const v = [];
  for (const { data: m } of repo.maps) {
    if (!m.level?.startLocationId) continue;
    const blocked = buildCollisionGrid(repo, m);
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

/** 与游戏运行时 src/engine/interaction-range.ts 同一规则：量到物件底座（collisionMask）或外框，并始终含左上角格；精灵取脚下格。 */
function interactionTiles(ref) {
  const tl = { x: ref.tileX, y: ref.tileY };
  if (isSpriteRef(ref)) return [tl];
  const comp = repo.components.get(ref.componentId);
  if (!comp) return [tl];
  const tiles = [tl];
  const mask = comp.collisionMask;
  if (mask && mask.some((row) => row.some(Boolean))) mask.forEach((row, r) => row.forEach((b, c) => b && tiles.push({ x: ref.tileX + c, y: ref.tileY + r })));
  else for (let r = 0; r < comp.tileHeight; r++) for (let c = 0; c < comp.tileWidth; c++) tiles.push({ x: ref.tileX + c, y: ref.tileY + r });
  return tiles;
}

test('交互物必须在某个地点的交互范围内（否则玩家永远看不到它的按钮，剧情会卡住）', (t) => {
  const v = [];
  for (const { data: m } of repo.maps) {
    const locs = m.districts.flatMap((d) => (d.locations ?? []).map((l) => ({ id: l.id, x: d.x + l.offsetX, y: d.y + l.offsetY })));
    if (!locs.length) continue;
    for (const layer of m.layers) for (const ref of layer.components) {
      const it = ref.interaction;
      if (!it?.interactions?.length) continue;
      // 生活模拟场景演员（persona）：场景模式下点人会自动走近，非场景模式运行时剥掉这份 interaction。
      if (ref.persona && m.runtime?.slice) continue;
      const range = it.interactionRange ?? 1;
      const tiles = interactionTiles(ref);
      let best = Infinity, bestLoc = null;
      for (const l of locs) for (const tt of tiles) { const d = Math.abs(tt.x - l.x) + Math.abs(tt.y - l.y); if (d < best) { best = d; bestLoc = l.id; } }
      if (best > range) v.push(`interaction-unreachable|${m.id}:${ref.refId}|最近地点 ${bestLoc} 距离 ${best} > 范围 ${range}`);
    }
  }
  assertNoNewViolations(t, v);
});
