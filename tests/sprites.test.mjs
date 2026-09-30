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
