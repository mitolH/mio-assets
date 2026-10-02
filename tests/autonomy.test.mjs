import { test, after } from 'node:test';
import { loadRepo, assertNoNewViolations, flushBaseline, isSpriteRef, buildCollisionGrid } from './lib/repo.mjs';

// 演员自主行动（ref.autonomy）的数据检查，语义与运行时 src/engine/npc-autonomy 一致：
// 一天 48 个时间槽（slot n = n/2 点），窗口两端包含，from > to 表示跨午夜；
// 会走动的演员（有 goto/wander/patrol 且没有 interaction）不留静态碰撞，按实时位置占格。

const repo = loadRepo();
after(flushBaseline);

const SLOTS_PER_DAY = 48;
const BEHAVIORS = new Set(['idle', 'wander', 'patrol', 'goto', 'face']);
const POSITIONAL = new Set(['wander', 'patrol', 'goto']);
const FACINGS = new Set(['up', 'down', 'left', 'right']);
const TRIGGERS = new Set(['playerNear', 'objectInteracted', 'storyVariable', 'npcBehavior']);
const OPS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte']);
const NPC_STATES = new Set([...BEHAVIORS, 'say', 'moving']);
const isSlot = (v) => Number.isInteger(v) && v >= 0 && v < SLOTS_PER_DAY;
const isTile = (t) => t && Number.isInteger(t.tileX) && Number.isInteger(t.tileY);

function mapContext(m) {
  const refs = m.layers.flatMap((l) => l.components);
  const refIds = new Set(refs.map((r) => r.refId).filter(Boolean));
  const actors = refs.filter((r) => r.refId && isSpriteRef(r) && r.autonomy
    && ((r.autonomy.schedule?.length ?? 0) > 0 || (r.autonomy.reactions?.length ?? 0) > 0));
  const moves = (b) => b && POSITIONAL.has(b.type);
  const mobile = new Set(actors.filter((a) => !a.interaction
    && ((a.autonomy.schedule ?? []).some((e) => moves(e.behavior)) || (a.autonomy.reactions ?? []).some((r) => moves(r.behavior))))
    .map((a) => a.refId));
  const blocked = buildCollisionGrid(repo, m, mobile);
  const locations = new Map(m.districts.flatMap((d) => (d.locations ?? []).map((l) => [l.id, { x: d.x + l.offsetX, y: d.y + l.offsetY }])));
  const protectedTiles = new Set([...locations.values()].map((p) => `${p.x},${p.y}`));
  for (const tp of m.teleports ?? []) protectedTiles.add(`${tp.sourceTileX},${tp.sourceTileY}`);
  const inb = (x, y) => x >= 0 && y >= 0 && x < m.widthInTiles && y < m.heightInTiles;
  return { refs, refIds, actors, mobile, blocked, locations, protectedTiles, inb };
}

/** 与运行时寻路一致：起点自身可以是阻挡格，之后只走可走格。 */
function reachableFrom(ctx, start) {
  const seen = new Set([`${start.tileX},${start.tileY}`]);
  const q = [[start.tileX, start.tileY]];
  while (q.length) {
    const [x, y] = q.shift();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, k = `${nx},${ny}`;
      if (ctx.inb(nx, ny) && !ctx.blocked[ny][nx] && !seen.has(k)) { seen.add(k); q.push([nx, ny]); }
    }
  }
  return seen;
}

function checkBehavior(v, subject, b, ctx, opts) {
  if (!b || !BEHAVIORS.has(b.type)) { v.push(`autonomy-schema|${subject}|未知行为 ${b?.type}`); return []; }
  if (b.emote !== undefined && typeof b.emote !== 'string') v.push(`autonomy-schema|${subject}|emote 必须是字符串`);
  const stops = [];
  switch (b.type) {
    case 'idle':
      if (b.facing !== undefined && !FACINGS.has(b.facing)) v.push(`autonomy-schema|${subject}|facing 非法 ${b.facing}`);
      break;
    case 'wander':
      if (!isTile(b.center) || !Number.isInteger(b.radius) || b.radius < 0) v.push(`autonomy-schema|${subject}|wander 需要 center 与非负整数 radius`);
      else stops.push(['wander.center', b.center]);
      break;
    case 'patrol':
      if (!Array.isArray(b.points) || b.points.length === 0 || !b.points.every(isTile)) v.push(`autonomy-schema|${subject}|patrol 需要非空 points`);
      else b.points.forEach((p, i) => stops.push([`patrol.points[${i}]`, p]));
      break;
    case 'goto':
      if (b.facing !== undefined && !FACINGS.has(b.facing)) v.push(`autonomy-schema|${subject}|facing 非法 ${b.facing}`);
      if (b.then !== undefined && b.then !== 'idle' && b.then !== 'face') v.push(`autonomy-schema|${subject}|then 只能是 idle/face`);
      if (isTile(b.tile)) stops.push(['goto.tile', b.tile]);
      else if (typeof b.locationId === 'string') {
        if (!ctx.locations.has(b.locationId)) v.push(`autonomy-ref-missing|${subject}|地点 ${b.locationId} 不存在`);
      } else v.push(`autonomy-schema|${subject}|goto 需要 tile 或 locationId`);
      break;
    case 'face':
      if (b.dir !== undefined && !FACINGS.has(b.dir)) v.push(`autonomy-schema|${subject}|dir 非法 ${b.dir}`);
      if (b.target !== undefined && b.target !== 'player' && !ctx.refIds.has(b.target)) v.push(`autonomy-ref-missing|${subject}|face 目标 ${b.target} 不存在`);
      if (b.dir === undefined && b.target === undefined) v.push(`autonomy-schema|${subject}|face 需要 dir 或 target`);
      break;
  }
  if (opts.pinned && stops.length > 0) {
    v.push(`autonomy-pinned-moves|${subject}|带 interaction 的演员运行时不会走动，${b.type} 的位置不会生效`);
  }
  return stops;
}

test('自主行动：时间槽、行为与触发器结构合法，引用存在', (t) => {
  const v = [];
  for (const { data: m } of repo.maps) {
    const ctx = mapContext(m);
    for (const ref of ctx.refs) {
      if (!ref.autonomy) continue;
      const subject = `${m.id}:${ref.refId ?? '(no refId)'}`;
      if (!ref.refId || !isSpriteRef(ref)) { v.push(`autonomy-schema|${subject}|autonomy 只能放在带 refId 的精灵 ref 上`); continue; }
      const a = ref.autonomy;
      if (a.speed !== undefined && !(typeof a.speed === 'number' && a.speed > 0 && a.speed <= 10)) v.push(`autonomy-schema|${subject}|speed 必须在 (0,10]`);
      (a.schedule ?? []).forEach((e, i) => {
        if (!isSlot(e.fromSlot) || !isSlot(e.toSlot)) v.push(`autonomy-slot|${subject}#${i}|时间槽必须是 0~${SLOTS_PER_DAY - 1} 的整数: ${e.fromSlot}→${e.toSlot}`);
        checkBehavior(v, `${subject}#${i}`, e.behavior, ctx, { pinned: !!ref.interaction });
      });
      (a.reactions ?? []).forEach((r, i) => {
        const s = `${subject}@${i}`;
        const tr = r.trigger;
        if (!tr || !TRIGGERS.has(tr.type)) { v.push(`autonomy-schema|${s}|未知触发器 ${tr?.type}`); return; }
        if (tr.type === 'playerNear') {
          if (!Number.isInteger(tr.radius) || tr.radius < 0) v.push(`autonomy-schema|${s}|playerNear 需要非负整数 radius`);
          if (tr.locationId !== undefined && !ctx.locations.has(tr.locationId)) v.push(`autonomy-ref-missing|${s}|地点 ${tr.locationId} 不存在`);
        }
        if (tr.type === 'objectInteracted' && !ctx.refIds.has(tr.refId)) v.push(`autonomy-ref-missing|${s}|物件 ${tr.refId} 不存在`);
        if (tr.type === 'npcBehavior') {
          if (!ctx.refIds.has(tr.refId)) v.push(`autonomy-ref-missing|${s}|演员 ${tr.refId} 不存在`);
          if (!NPC_STATES.has(tr.behavior)) v.push(`autonomy-schema|${s}|npcBehavior.behavior 非法 ${tr.behavior}`);
        }
        if (tr.type === 'storyVariable' && (typeof tr.key !== 'string' || !OPS.has(tr.op) || typeof tr.value !== 'number')) {
          v.push(`autonomy-schema|${s}|storyVariable 需要 key/op/value`);
        }
        if (!r.behavior && r.face === undefined && r.say === undefined) v.push(`autonomy-schema|${s}|反应需要 behavior/face/say 之一`);
        if (r.face !== undefined && !FACINGS.has(r.face) && r.face !== 'player' && !ctx.refIds.has(r.face)) v.push(`autonomy-ref-missing|${s}|face 目标 ${r.face} 不存在`);
        if (r.durationSlots !== undefined && !(Number.isInteger(r.durationSlots) && r.durationSlots >= 1)) v.push(`autonomy-schema|${s}|durationSlots 必须是正整数`);
        if (r.behavior) checkBehavior(v, s, r.behavior, ctx, { pinned: !!ref.interaction });
      });
    }
  }
  assertNoNewViolations(t, v);
});

test('自主行动：落脚格在图内、可走、不占剧情格，且从演员摆放格可达', (t) => {
  const v = [];
  for (const { data: m } of repo.maps) {
    const ctx = mapContext(m);
    for (const ref of ctx.actors) {
      if (!ctx.mobile.has(ref.refId)) continue;
      const subject = `${m.id}:${ref.refId}`;
      const home = { tileX: ref.tileX, tileY: ref.tileY };
      if (!ctx.inb(home.tileX, home.tileY) || ctx.blocked[home.tileY][home.tileX]) {
        v.push(`autonomy-home-blocked|${subject}|会走动的演员摆放格 (${home.tileX},${home.tileY}) 被阻挡，回家时无路可走`);
      }
      const reach = reachableFrom(ctx, home);
      const behaviors = [
        ...(ref.autonomy.schedule ?? []).map((e, i) => [`#${i}`, e.behavior]),
        ...(ref.autonomy.reactions ?? []).filter((r) => r.behavior).map((r, i) => [`@${i}`, r.behavior]),
      ];
      for (const [tag, b] of behaviors) {
        const stops = checkBehavior([], subject, b, ctx, { pinned: false });
        if (b?.type === 'goto' && !b.tile && ctx.locations.has(b.locationId)) {
          const p = ctx.locations.get(b.locationId);
          stops.push(['goto.locationId', { tileX: p.x, tileY: p.y }]);
        }
        for (const [what, p] of stops) {
          const s = `${subject}${tag}`;
          const where = `${what} (${p.tileX},${p.tileY})`;
          if (!ctx.inb(p.tileX, p.tileY)) { v.push(`autonomy-tile-oob|${s}|${where} 越界`); continue; }
          if (what === 'goto.locationId') {
            // 运行时会在地点旁就近找空地；这里只要求地点可达
            if (!reach.has(`${p.tileX},${p.tileY}`)) v.push(`autonomy-unreachable|${s}|${where} 从摆放格不可达`);
            continue;
          }
          if (ctx.blocked[p.tileY][p.tileX]) { v.push(`autonomy-tile-blocked|${s}|${where} 是碰撞格`); continue; }
          if (ctx.protectedTiles.has(`${p.tileX},${p.tileY}`)) v.push(`autonomy-tile-protected|${s}|${where} 占用了剧情地点/传送格`);
          if (!reach.has(`${p.tileX},${p.tileY}`)) v.push(`autonomy-unreachable|${s}|${where} 从摆放格 (${home.tileX},${home.tileY}) 不可达`);
        }
      }
    }
  }
  assertNoNewViolations(t, v);
});
