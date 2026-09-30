import { test, after } from 'node:test';
import { loadRepo, assertNoNewViolations, flushBaseline, TILE } from './lib/repo.mjs';

const repo = loadRepo();
after(flushBaseline);

const HEX = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;

test('组件 schema：尺寸、tile 数、调色板、像素索引', (t) => {
  const v = [];
  const seen = new Map();
  for (const { rel, cat, file, data: d } of repo.componentFiles) {
    const id = d.id;
    if (seen.has(id)) v.push(`duplicate-id|${id}|同时出现在 ${seen.get(id)} 与 ${rel}`);
    seen.set(id, rel);
    if (`${id}.json` !== file) v.push(`filename|${id}|文件名 ${file} 与 id 不一致`);
    if (d.category !== cat) v.push(`category-dir|${id}|category=${d.category} 但位于 components/${cat}/`);
    if (!Number.isInteger(d.width) || !Number.isInteger(d.height)) { v.push(`size|${id}|宽高不是整数`); continue; }
    if (d.width % TILE || d.height % TILE) v.push(`size-multiple|${id}|${d.width}x${d.height} 不是 ${TILE} 的整数倍`);
    if (d.tileWidth !== Math.ceil(d.width / TILE) || d.tileHeight !== Math.ceil(d.height / TILE)) v.push(`tile-count|${id}|tileWidth/Height 与像素尺寸不符`);
    if (!Array.isArray(d.palette) || d.palette[0] !== 'transparent') v.push(`palette0|${id}|palette[0] 必须是 "transparent"`);
    else for (const [i, c] of d.palette.entries()) if (i > 0 && !HEX.test(c)) v.push(`palette-hex|${id}|palette[${i}]=${c} 非法`);
    if (!Array.isArray(d.pixels) || d.pixels.length !== d.height) { v.push(`pixel-rows|${id}|pixels 行数 ${d.pixels?.length} != height ${d.height}`); continue; }
    let badRow = -1, badIdx = null;
    for (let y = 0; y < d.pixels.length && badRow < 0; y++) {
      const row = d.pixels[y];
      if (row.length !== d.width) { badRow = y; break; }
      for (const p of row) if (!Number.isInteger(p) || p < 0 || p >= d.palette.length) { badIdx = p; badRow = y; break; }
    }
    if (badRow >= 0) v.push(`pixel-grid|${id}|第 ${badRow} 行长度或调色板索引非法(${badIdx ?? '长度'})`);
  }
  assertNoNewViolations(t, v);
});

test('manifest 与文件一一对应', (t) => {
  const v = [];
  if (!repo.manifest) return assertNoNewViolations(t, ['manifest|manifest.json|缺失']);
  const m = repo.manifest;
  const check = (kind, listed, files, pathOf) => {
    const listedIds = new Map(listed.map((e) => [e.id, e]));
    for (const f of files) if (!listedIds.has(f.id)) v.push(`manifest-missing|${f.id}|${kind} 存在文件但未登记在 manifest`);
    const fileIds = new Set(files.map((f) => f.id));
    for (const e of listed) {
      if (!fileIds.has(e.id)) v.push(`manifest-orphan|${e.id}|manifest 登记了 ${kind} 但文件不存在`);
      const f = files.find((x) => x.id === e.id);
      if (f && e.path !== pathOf(f)) v.push(`manifest-path|${e.id}|path=${e.path} 应为 ${pathOf(f)}`);
    }
  };
  check('component', m.components, repo.componentFiles.map((c) => ({ id: c.data.id, rel: c.rel })), (f) => f.rel);
  check('map', m.maps, repo.maps.map((x) => ({ id: x.data.id, rel: x.rel })), (f) => f.rel);
  check('sprite', m.sprites, repo.sprites.map((x) => ({ id: x.data.id, rel: x.rel })), (f) => f.rel);
  assertNoNewViolations(t, v);
});
