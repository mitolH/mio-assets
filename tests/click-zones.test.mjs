import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRepo, isSpriteRef, buildCollisionGrid, refOffsets } from './lib/repo.mjs';

// 演员点击区（场景模式「点人即开口」）：
// - 运行时只给带 `interaction` 的 ref 建点击区（WorldScene.createObjectZones）；没有 interaction 的演员点了没反应，
//   只能走近触发。`interactions: []` 也算点击区：点人时由内容（接触闸门 / fallbackLines 寒暄）决定说什么。
// - 点人后玩家先走到交互范围内的空格再触发（approachObject），所以范围内必须有从起点走得到的空格——
//   取最坏情况：所有演员都站在摆放格挡路（与 collision.test.mjs 同口径，但也覆盖 interactions 为空的点击区）。
// - 回归清单：内容里「接触型」对话（encounter trigger: contact）的对话方必须能点（2026-10-26 自动对话审计遗留的 5 位），
//   以及第五章补摆位的演员（梁母、差役、楼台上的祝父、坟前的马府管家、终景的县吏）。

const repo = loadRepo();
const mapsById = new Map(repo.maps.map((m) => [m.data.id, m.data]));
const key = (x, y) => `${x},${y}`;

/** 内容仓库接触闸门的对话方 + 第五章补摆位：mapId → refId 后缀。 */
const MUST_BE_TAPPABLE = {
  map_lz_ch01_river_ferry_v1: ['actor_villager_3'], // 船夫（祝/梁 渡口：书箱滑下石阶）
  map_lz_ch01_mountain_pavilion_v1: ['actor_student_5', 'actor_villager_3'], // 茶摊书生（驿亭讥笑）、卖茶人（梁 晨起问她去向）
  map_lz_ch04_ma_courtyard_v1: ['actor_ma_taishou_9', 'actor_county_clerk_10'], // 马太守（父命 / 门楼夜问）、县吏登门
  map_lz_ch05_tower_v1: ['actor_zhufu_father_8'], // 祝父上楼（祝 D2 三件事）
  map_lz_ch05_sickroom_v1: ['actor_liang_mother_8', 'actor_yamen_runner_9'], // 梁母、差役（官文）
  map_lz_ch05_grave_v1: ['actor_ma_steward_8'], // 坟前撑伞的管家（马）
  map_lz_ch05_butterfly_end_v1: ['actor_county_clerk_4'], // 县吏问如何报官（马 终景）
};

function locationsOf(m) {
  return m.districts.flatMap((d) => (d.locations ?? []).map((l) => ({ id: l.id, x: d.x + l.offsetX, y: d.y + l.offsetY })));
}

function reach(grid, m, start) {
  const seen = new Set([key(start.x, start.y)]);
  const q = [[start.x, start.y]];
  while (q.length) {
    const [x, y] = q.shift();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= m.widthInTiles || ny >= m.heightInTiles || grid[ny][nx] || seen.has(key(nx, ny))) continue;
      seen.add(key(nx, ny));
      q.push([nx, ny]);
    }
  }
  return seen;
}

function anchorTiles(ref) {
  return [{ x: ref.tileX, y: ref.tileY }, ...refOffsets(repo, ref).map((o) => ({ x: ref.tileX + o.dx, y: ref.tileY + o.dy }))];
}

const spriteRefs = (m) => m.layers.flatMap((l) => l.components).filter((r) => r.refId && isSpriteRef(r));

test('点击区回归清单：接触型对话方与第五章补摆位的演员都有点击区', () => {
  const errors = [];
  for (const [mapId, suffixes] of Object.entries(MUST_BE_TAPPABLE)) {
    const m = mapsById.get(mapId);
    if (!m) { errors.push(`${mapId}: 地图不存在`); continue; }
    for (const s of suffixes) {
      const ref = spriteRefs(m).find((r) => r.refId === `${mapId}_${s}`);
      if (!ref) { errors.push(`${mapId}_${s}: 演员不存在`); continue; }
      if (!ref.interaction) errors.push(`${ref.refId}: 缺少 interaction（不会生成点击区，点了没反应）`);
      else if (!Array.isArray(ref.interaction.interactions)) errors.push(`${ref.refId}: interaction.interactions 必须是数组（可为空）`);
      if (!ref.persona?.npcId) errors.push(`${ref.refId}: 缺少 persona.npcId（内容的接触闸门 with / 在场规则按它找人）`);
    }
  }
  assert.deepEqual(errors, []);
});

test('点击区：范围 1–4，范围内有从起点走得到的空格（所有演员都挡路时，含 interactions 为空的点击区）', () => {
  const errors = [];
  for (const { data: m } of repo.maps) {
    const start = locationsOf(m).find((l) => l.id === m.level?.startLocationId) ?? locationsOf(m)[0];
    if (!start) continue;
    const grid = buildCollisionGrid(repo, m);
    const reached = reach(grid, m, start);
    for (const ref of spriteRefs(m)) {
      if (!ref.interaction || !ref.persona) continue;
      const tracked = Object.entries(MUST_BE_TAPPABLE).some(([id, sfx]) => id === m.id && sfx.some((s) => ref.refId === `${id}_${s}`));
      // 旧演员沿用 collision.test.mjs 的基线；这里只严格检查回归清单里的演员
      if (!tracked) continue;
      const range = ref.interaction.interactionRange ?? 1;
      if (!(range >= 1 && range <= 4)) errors.push(`${ref.refId}: interactionRange ${range} 应在 1–4`);
      const ok = [...reached].some((k) => {
        const [x, y] = k.split(',').map(Number);
        return anchorTiles(ref).some((t) => Math.abs(t.x - x) + Math.abs(t.y - y) <= range);
      });
      if (!ok) errors.push(`${ref.refId}: 交互范围 ${range} 内没有从起点走得到的空格`);
      // 新摆位的演员脚下不压静态碰撞（压在墙/家具里会看起来"嵌进去"）；旧演员里有站在摊后/柜后的设计（如驿亭卖茶人），不查
      if (m.id.includes('_ch05_')) {
        const base = buildCollisionGrid(repo, m, new Set(), { actors: false });
        if (base[ref.tileY]?.[ref.tileX]) errors.push(`${ref.refId}: 摆放格 (${ref.tileX},${ref.tileY}) 是碰撞格`);
      }
    }
  }
  assert.deepEqual(errors, []);
});

test('第五章补摆位的演员缺省不在场（persona.periods 为空，由各视角内容的在场规则打开）', () => {
  const errors = [];
  for (const [mapId, suffixes] of Object.entries(MUST_BE_TAPPABLE)) {
    if (!mapId.includes('_ch05_')) continue;
    for (const s of suffixes) {
      const ref = spriteRefs(mapsById.get(mapId) ?? { layers: [] }).find((r) => r.refId === `${mapId}_${s}`);
      if (ref && !(Array.isArray(ref.persona?.periods) && ref.persona.periods.length === 0)) errors.push(`${ref.refId}: persona.periods 应为 []`);
    }
  }
  assert.deepEqual(errors, []);
});
