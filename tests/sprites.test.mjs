import { test, after } from 'node:test';
import { loadRepo, assertNoNewViolations, flushBaseline, TILE } from './lib/repo.mjs';

const repo = loadRepo();
after(flushBaseline);

function bbox(comp) {
  let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1, n = 0;
  comp.pixels.forEach((row, y) => row.forEach((p, x) => { if (p !== 0) { n++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; } }));
  return { minX, maxX, minY, maxY, n };
}
const distinctColors = (comp) => new Set(comp.pixels.flat().filter((p) => p !== 0)).size;
const isGreenKey = (hex) => { const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16); return g > 200 && r < 80 && b < 80; };

test('精灵：动画帧引用存在、尺寸一致', (t) => {
  const v = [];
  for (const { data: s } of repo.sprites) {
    if (!s.animations?.length) v.push(`no-animation|${s.id}|无动画`);
    if (!s.animations?.some((a) => a.id === s.defaultAnimationId)) v.push(`default-animation|${s.id}|defaultAnimationId=${s.defaultAnimationId} 不存在`);
    for (const a of s.animations ?? []) {
      if (!a.frames?.length) v.push(`empty-animation|${s.id}:${a.id}|无帧`);
      for (const [i, f] of (a.frames ?? []).entries()) for (const ls of f.layerStates ?? []) {
        const c = repo.components.get(ls.componentId);
        if (!c) { v.push(`frame-missing|${s.id}:${a.id}#${i}|组件 ${ls.componentId} 不存在`); continue; }
        if (c.width !== s.width || c.height !== s.height) v.push(`frame-size|${s.id}:${a.id}#${i}|${c.width}x${c.height} != 精灵 ${s.width}x${s.height}`);
      }
    }
  }
  assertNoNewViolations(t, v);
});

test('角色帧：脚底基线/头顶/中线稳定，无绿幕色，像素密度达标', (t) => {
  const v = [];
  for (const { data: s } of repo.sprites) {
    if (s.category !== 'character') continue;
    for (const a of s.animations ?? []) {
      const boxes = [];
      for (const [i, f] of a.frames.entries()) for (const ls of f.layerStates ?? []) {
        const c = repo.components.get(ls.componentId); if (!c) continue;
        const b = bbox(c); b.id = c.id; b.i = i; b.colors = distinctColors(c); b.comp = c; boxes.push(b);
      }
      if (!boxes.length) continue;
      const base = boxes[0];
      for (const b of boxes) {
        if (b.n === 0) { v.push(`frame-empty|${b.id}|空帧`); continue; }
        if (Math.abs(b.maxY - base.maxY) > 1) v.push(`foot-drift|${s.id}:${a.id}#${b.i}|脚底 ${b.maxY} vs 首帧 ${base.maxY}`);
        if (b.maxY < s.height - 4) v.push(`foot-not-at-bottom|${s.id}:${a.id}#${b.i}|脚底 y=${b.maxY}，画布高 ${s.height}`);
        if (Math.abs(b.minY - base.minY) > 2) v.push(`head-drift|${s.id}:${a.id}#${b.i}|头顶 ${b.minY} vs 首帧 ${base.minY}`);
        if (b.minX < 1 || b.maxX > s.width - 2) v.push(`edge-touch|${s.id}:${a.id}#${b.i}|像素贴到画布边缘(${b.minX}..${b.maxX})`);
        if (b.comp.palette.some((c, idx) => idx > 0 && isGreenKey(c))) v.push(`green-key|${b.id}|调色板含绿幕色`);
        if (b.n < 900) v.push(`density-low|${b.id}|仅 ${b.n} 个像素(角色应 ≥900)`);
        if (b.colors < 12) v.push(`colors-low|${b.id}|仅 ${b.colors} 种颜色(角色应 ≥12)`);
      }
    }
  }
  assertNoNewViolations(t, v);
});

test('地面/地形 tile：颜色数与可平铺性', (t) => {
  const v = [];
  for (const { data: c } of repo.componentFiles) {
    if (c.category !== 'terrain' || c.tileWidth !== 1 || c.tileHeight !== 1) continue;
    if (c.pixels.some((r) => r.some((p) => p === 0))) continue; // 透明 tile 由地图规则处理
    if (distinctColors(c) < 3) v.push(`ground-colors|${c.id}|仅 ${distinctColors(c)} 色`);
  }
  assertNoNewViolations(t, v);
});

test('角色精灵：必须有 idle-up（引擎 idle-up→idle→idle-down 查找，缺失会转成正面）；f1=f4=walk-up f1，f2/f3 为呼吸帧', (t) => {
  const v = [];
  const sameRows = (a, b) => a.pixels.length === b.pixels.length && a.pixels.every((r, y) => r.every((p, x) => p === b.pixels[y][x]));
  for (const { data: s } of repo.sprites) {
    if (s.category !== 'character' || s.width !== 48) continue;
    const idle = s.animations?.find((a) => a.id === 'idle-up');
    const walk = s.animations?.find((a) => a.id === 'walk-up');
    if (!idle) { v.push(`idle-up-missing|${s.id}|缺少 idle-up 片段`); continue; }
    if (idle.frames.length !== 4 || !idle.loop || idle.frames.some((f) => f.duration !== 180)) v.push(`idle-up-shape|${s.id}|应为 4 帧、180ms、loop`);
    if (!walk) continue;
    const comp = (f) => repo.components.get(f?.layerStates?.[0]?.componentId);
    const w1 = comp(walk.frames[0]); const [i1, i2, i3, i4] = idle.frames.map(comp);
    if (!w1 || !i1 || !i2 || !i3 || !i4) continue;
    if (!sameRows(i1, w1) || !sameRows(i4, w1)) v.push(`idle-up-f1f4|${s.id}|f1/f4 应与 walk-up f1 像素相同`);
    if (sameRows(i2, w1) || !sameRows(i2, i3)) v.push(`idle-up-breath|${s.id}|f2=f3 且应不同于 f1（呼吸帧）`);
    if (!/_idle_up_f\d_/.test(i1.id)) v.push(`idle-up-id|${s.id}|组件 id 应含 _idle_up_f{n}_`);
    if (!repo.manifest?.components?.some((c) => c.id === i1.id)) v.push(`idle-up-manifest|${i1.id}|未登记到 manifest`);
  }
  assertNoNewViolations(t, v);
});
