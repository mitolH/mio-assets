import { test, after } from 'node:test';
import {
  loadRepo, assertNoNewViolations, flushBaseline, isSpriteRef, buildCollisionGrid, actorTiles, spriteOffsets, refOffsets,
} from './lib/repo.mjs';

// 角色碰撞与占格（语义与运行时 src/engine/sprite-collision.ts、CollisionGrid、OccupancyRegistry 一致）：
// - 精灵 ref 的 (tileX,tileY) = 脚底格；角色默认只挡脚底一格；大型精灵/人群可在精灵 footprint 或 ref.collision 里配置。
// - 运行时角色之间不能互相穿过，玩家只能站在演员旁边的空格交互（交互范围量到演员脚底格/碰撞格）。
// - 这里取最坏情况：所有演员都站在摆放格挡路。若因此堵死了地点、门、交互锚点或进图落点 → 报错（不能靠“穿人”过去）。

const repo = loadRepo();
after(flushBaseline);
const mapsById = new Map(repo.maps.map((m) => [m.data.id, m.data]));
const key = (x, y) => `${x},${y}`;

function locationsOf(m) {
  return m.districts.flatMap((d) => (d.locations ?? []).map((l) => ({ id: l.id, x: d.x + l.offsetX, y: d.y + l.offsetY })));
}

function startOf(m) {
  const locs = locationsOf(m);
  return locs.find((l) => l.id === m.level?.startLocationId) ?? locs[0] ?? null;
}

/** 其它地图传送进本图的落点（玩家进图后站的格）。 */
function landingsOf(m) {
  const out = [];
  for (const { data: other } of repo.maps) {
    for (const tp of other.teleports ?? []) if (tp.target?.mapId === m.id) out.push({ id: `${other.id}:${tp.id}`, x: tp.target.tileX, y: tp.target.tileY });
  }
  return out;
}

function reach(blocked, m, start) {
  const inb = (x, y) => x >= 0 && y >= 0 && x < m.widthInTiles && y < m.heightInTiles;
  const seen = new Set([key(start.x, start.y)]);
  const q = [[start.x, start.y]];
  for (let h = 0; h < q.length; h++) {
    const [x, y] = q[h];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, k = key(nx, ny);
      if (inb(nx, ny) && !blocked[ny][nx] && !seen.has(k)) { seen.add(k); q.push([nx, ny]); }
    }
  }
  return seen;
}

/** 与运行时 getInteractionTiles 一致：左上/脚底格 + 碰撞格（组件无碰撞时用外框）。 */
function interactionTiles(ref) {
  const out = [{ x: ref.tileX, y: ref.tileY }];
  if (isSpriteRef(ref)) {
    for (const o of refOffsets(repo, ref)) out.push({ x: ref.tileX + o.dx, y: ref.tileY + o.dy });
    return out;
  }
  const comp = repo.components.get(ref.componentId);
  if (!comp) return out;
  const offs = refOffsets(repo, ref);
  if (offs.length) for (const o of offs) out.push({ x: ref.tileX + o.dx, y: ref.tileY + o.dy });
  else for (let r = 0; r < comp.tileHeight; r++) for (let c = 0; c < comp.tileWidth; c++) out.push({ x: ref.tileX + c, y: ref.tileY + r });
  return out;
}

const interactable = (m, ref) => !!ref.refId && ((ref.interaction?.interactions?.length ?? 0) > 0
  || (m.runtime?.slice?.objectInteractions?.[ref.refId]?.length ?? 0) > 0);

function anchorReached(reachSet, ref) {
  const range = ref.interaction?.interactionRange ?? 1;
  const tiles = interactionTiles(ref);
  for (const k of reachSet) {
    const [x, y] = k.split(',').map(Number);
    if (tiles.some((t) => Math.abs(t.x - x) + Math.abs(t.y - y) <= range)) return true;
  }
  return false;
}

test('精灵碰撞：角色默认只挡脚底格（footprint 相对脚底格包含 0/0）', (t) => {
  const v = [];
  for (const { data: s } of repo.sprites) {
    const offs = spriteOffsets(s);
    if (s.category === 'character' && !offs.some((o) => o.dx === 0 && o.dy === 0)) {
      v.push(`sprite-footprint-not-feet|${s.id}|碰撞格 ${JSON.stringify(offs)} 不含脚底格；旧的画布左上角坐标请改成脚底坐标或标注 origin:'sprite-box'`);
    }
    const fp = s.footprint;
    if (fp && fp.origin !== undefined && fp.origin !== 'feet' && fp.origin !== 'sprite-box') v.push(`sprite-footprint-schema|${s.id}|origin 只能是 feet/sprite-box`);
  }
  assertNoNewViolations(t, v);
});

test('ref.collision 覆盖：结构合法', (t) => {
  const v = [];
  for (const { data: m } of repo.maps) {
    for (const layer of m.layers) for (const ref of layer.components) {
      const c = ref.collision;
      if (c === undefined) continue;
      const ok = c === 'none' || (typeof c === 'object' && c !== null && Array.isArray(c.tiles)
        && c.tiles.every((o) => o && Number.isInteger(o.dx) && Number.isInteger(o.dy)));
      if (!ok) v.push(`ref-collision-schema|${m.id}:${ref.refId ?? ref.componentId ?? ref.spriteId}|collision 只能是 'none' 或 { tiles: [{dx,dy}] }（整数）`);
    }
  }
  assertNoNewViolations(t, v);
});

test('演员占格：不站在地点格、传送源格或进图落点上', (t) => {
  const v = [];
  for (const { data: m } of repo.maps) {
    const locs = new Map(locationsOf(m).map((l) => [key(l.x, l.y), l.id]));
    const doors = new Map((m.teleports ?? []).map((tp) => [key(tp.sourceTileX, tp.sourceTileY), tp.id]));
    const lands = new Map(landingsOf(m).map((l) => [key(l.x, l.y), l.id]));
    for (const a of actorTiles(repo, m)) {
      const s = `${m.id}:${a.refId ?? a.ref.spriteId}`;
      for (const tt of a.tiles) {
        const k = key(tt.x, tt.y);
        if (locs.has(k)) v.push(`actor-on-location|${s}|占着地点 ${locs.get(k)} (${k})`);
        if (doors.has(k)) v.push(`actor-on-door|${s}|占着传送源格 ${doors.get(k)} (${k})`);
        if (lands.has(k)) v.push(`actor-on-landing|${s}|占着进图落点 ${lands.get(k)} (${k})`);
      }
    }
  }
  assertNoNewViolations(t, v);
});

test('所有演员都挡路时：地点、传送门、进图落点、交互锚点仍从起点可达（所有地图，含旧图）', (t) => {
  const v = [];
  for (const { data: m } of repo.maps) {
    const start = startOf(m);
    if (!start) continue;
    const withActors = buildCollisionGrid(repo, m);
    const without = buildCollisionGrid(repo, m, new Set(), { actors: false });
    const actors = actorTiles(repo, m);
    if (withActors[start.y]?.[start.x] && !without[start.y]?.[start.x]) {
      v.push(`actors-block-start|${m.id}|起点 (${start.x},${start.y}) 被演员占着`);
      continue;
    }
    const full = reach(withActors, m, start);
    const free = reach(without, m, start);
    // 谁堵的：逐个拿掉演员看能否恢复
    const blame = (ok) => actors.filter((a) => {
      if (!a.refId) return false;
      const g = buildCollisionGrid(repo, m, new Set([a.refId]));
      return ok(reach(g, m, start));
    }).map((a) => a.refId.replace(`${m.id}_`, '')).join(',') || '多个演员合围';

    for (const l of locationsOf(m)) {
      const k = key(l.x, l.y);
      if (free.has(k) && !full.has(k)) v.push(`actors-block-location|${m.id}:${l.id}|(${k}) 被演员堵住（${blame((r) => r.has(k))}）`);
    }
    for (const tp of m.teleports ?? []) {
      const k = key(tp.sourceTileX, tp.sourceTileY);
      if (free.has(k) && !full.has(k)) v.push(`actors-block-door|${m.id}:${tp.id}|(${k}) 被演员堵住（${blame((r) => r.has(k))}）`);
    }
    for (const l of landingsOf(m)) {
      const k = key(l.x, l.y);
      if (free.has(k) && !full.has(k) && !withActors[l.y]?.[l.x]) v.push(`actors-block-landing|${m.id}:${l.id}|进图落点 (${k}) 与起点之间被演员隔断（${blame((r) => r.has(k))}）`);
    }
    for (const layer of m.layers) for (const ref of layer.components) {
      if (!interactable(m, ref)) continue;
      // 演员自己的格子当然站不上去；只要求范围内有走得到的空格（通常是身边一格）
      const self = ref.refId;
      if (anchorReached(free, ref) && !anchorReached(full, ref)) {
        v.push(`actors-block-interaction|${m.id}:${self}|交互范围 ${ref.interaction?.interactionRange ?? 1} 内没有可达的空格（${blame((r) => anchorReached(r, ref))}）`);
      }
    }
  }
  assertNoNewViolations(t, v);
});
