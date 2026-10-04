import { test, after } from 'node:test';
import { loadRepo, assertNoNewViolations, flushBaseline, isSpriteRef, buildCollisionGrid } from './lib/repo.mjs';

// 生活模拟场景的地图侧数据（runtime.slice、ref.persona、scenarioOnly 传送门），语义与运行时
// src/engine/life-sim/scenario-map.ts 一致。剧情/台词在游戏内容仓库，这里只查地图自身的结构与可走性。

const repo = loadRepo();
after(flushBaseline);
const mapsById = new Map(repo.maps.map((m) => [m.data.id, m.data]));

function isStartDialogueOnly(def) {
  return Array.isArray(def.effects) && def.effects.length > 0
    && def.effects.every((e) => e.type === 'start_dialogue' && typeof e.target === 'string' && e.target)
    && Array.isArray(def.conditions);
}

function reachable(blocked, w, h, start) {
  const seen = new Set([`${start.x},${start.y}`]);
  const q = [[start.x, start.y]];
  while (q.length) {
    const [x, y] = q.shift();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, k = `${nx},${ny}`;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h && !blocked[ny][nx] && !seen.has(k)) { seen.add(k); q.push([nx, ny]); }
    }
  }
  return seen;
}

function startTile(m) {
  for (const d of m.districts) for (const l of d.locations ?? []) if (l.id === m.level?.startLocationId) return { x: d.x + l.offsetX, y: d.y + l.offsetY };
  return null;
}

test('场景：runtime.slice 结构合法，persona/场景交互只引用对话 id', (t) => {
  const v = [];
  for (const { data: m } of repo.maps) {
    const slice = m.runtime?.slice;
    const refs = m.layers.flatMap((l) => l.components);
    const refIds = new Set(refs.map((r) => r.refId).filter(Boolean));
    for (const ref of refs) {
      if (!ref.persona) continue;
      const s = `${m.id}:${ref.refId}`;
      if (!slice) v.push(`scenario-persona-orphan|${s}|带 persona 但地图没有 runtime.slice`);
      if (!ref.refId || !isSpriteRef(ref)) v.push(`scenario-persona-schema|${s}|persona 只能放在带 refId 的精灵上`);
      if (typeof ref.persona.npcId !== 'string' || !ref.persona.npcId) v.push(`scenario-persona-schema|${s}|npcId 必须是非空字符串`);
      if (ref.persona.periods !== undefined && !(Array.isArray(ref.persona.periods) && ref.persona.periods.every((p) => typeof p === 'string'))) {
        v.push(`scenario-persona-schema|${s}|periods 必须是字符串数组`);
      }
      for (const def of ref.interaction?.interactions ?? []) if (!isStartDialogueOnly(def)) v.push(`scenario-interaction-schema|${s}#${def.id}|persona 交互只能用 start_dialogue 效果`);
    }
    if (!slice) continue;
    if (typeof slice.sliceId !== 'string' || !slice.sliceId) v.push(`scenario-schema|${m.id}|sliceId 缺失`);
    if (!Array.isArray(slice.roles) || slice.roles.length === 0) v.push(`scenario-schema|${m.id}|roles 不能为空`);
    if (m.runtime.schemaVersion !== 1) v.push(`scenario-schema|${m.id}|runtime.schemaVersion 必须为 1`);
    for (const [refId, defs] of Object.entries(slice.objectInteractions ?? {})) {
      if (!refIds.has(refId)) v.push(`scenario-ref-missing|${m.id}:${refId}|objectInteractions 引用的物件不存在`);
      for (const def of defs) if (!isStartDialogueOnly(def)) v.push(`scenario-interaction-schema|${m.id}:${refId}#${def.id}|只能用 start_dialogue 效果`);
    }
  }
  assertNoNewViolations(t, v);
});

test('场景：传送门源格可走且从起点可达，目标地图存在且落点可走', (t) => {
  const v = [];
  for (const { data: m } of repo.maps) {
    for (const tp of m.teleports ?? []) {
      if (!tp.scenarioOnly) continue;
      const s = `${m.id}:${tp.id}`;
      const blocked = buildCollisionGrid(repo, m);
      const start = startTile(m);
      if (blocked[tp.sourceTileY]?.[tp.sourceTileX] !== false) v.push(`scenario-door-blocked|${s}|源格 (${tp.sourceTileX},${tp.sourceTileY}) 越界或被阻挡`);
      else if (start && !reachable(blocked, m.widthInTiles, m.heightInTiles, start).has(`${tp.sourceTileX},${tp.sourceTileY}`)) {
        v.push(`scenario-door-unreachable|${s}|源格从起点不可达`);
      }
      const target = mapsById.get(tp.target?.mapId);
      if (!target) { v.push(`scenario-door-target-missing|${s}|目标地图 ${tp.target?.mapId} 不存在`); continue; }
      const tb = buildCollisionGrid(repo, target);
      if (tb[tp.target.tileY]?.[tp.target.tileX] !== false) v.push(`scenario-door-landing-blocked|${s}|落点 (${tp.target.tileX},${tp.target.tileY}) 越界或被阻挡`);
      const back = (target.teleports ?? []).some((o) => o.sourceTileX === tp.target.tileX && o.sourceTileY === tp.target.tileY);
      if (back) v.push(`scenario-door-bounce|${s}|落点正好是目标图的传送源格，会来回弹`);
    }
  }
  assertNoNewViolations(t, v);
});
