import test from 'node:test';
import assert from 'node:assert/strict';
import { depthAt } from '../scripts/exit-depth.mjs';

test('falls between two measured sizes', () => {
  const d = depthAt([{ usd: 1000, impact: 0.5 }, { usd: 10000, impact: 1.5 }], 1);
  assert.equal(d.usd, 3162);
});
test('says when the limit is past the ends of the ladder', () => {
  assert.deepEqual(depthAt([{ usd: 100, impact: 2 }], 1), { under: 100 });
  assert.deepEqual(depthAt([{ usd: 100, impact: 0.1 }, { usd: 1000, impact: 0.2 }], 1), { over: 1000 });
  assert.equal(depthAt([], 1), null);
});
