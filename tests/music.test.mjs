// 音乐曲目（music/*.json：MIDI 的 base64 封装）：manifest.music 与文件一一对应，内容是合法的小型 SMF。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const entries = manifest.music ?? [];
const hasMusicDir = existsSync(join(ROOT, 'music'));

test('manifest.music 与 music/*.json 一一对应', { skip: !hasMusicDir && '无 music 目录' }, () => {
  const files = readdirSync(join(ROOT, 'music')).filter((f) => f.endsWith('.json')).sort();
  assert.deepEqual(entries.map((e) => e.path.replace(/^music\//, '')).sort(), files);
  const ids = entries.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'id 重复');
});

for (const e of entries) {
  test(`曲目 ${e.id} 是合法的小型 MIDI`, () => {
    const file = JSON.parse(readFileSync(join(ROOT, e.path), 'utf8'));
    assert.equal(file.id, e.id);
    assert.equal(file.format, 'midi-base64');
    const bytes = Buffer.from(file.data, 'base64');
    assert.equal(bytes.subarray(0, 4).toString('latin1'), 'MThd', 'SMF 文件头');
    assert.ok(bytes.length <= 30 * 1024, `${bytes.length} 字节超过 30KB`);
    assert.ok(file.durationSec >= 40 && file.durationSec <= 90, `时长 ${file.durationSec}s 不在 40–90s`);
    assert.ok(bytes.length > 200, '音符太少');
  });
}
