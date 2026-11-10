import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ImmuneStore } from '../dsh-immune-system/dist/core/store/index.js';
import { BUILTIN_PACKS } from '../dsh-immune-system/dist/core/packs.js';

function store() {
  return new ImmuneStore({ dbPath: ':memory:' });
}

function packOf(id) {
  const pack = BUILTIN_PACKS.find((candidate) => candidate.id === id);
  assert.ok(pack, `pack ${id} must exist`);
  return pack;
}

test('every builtin pack is well-formed and non-duplicated across packs', () => {
  const packIds = new Set();
  const prescriptions = new Set();
  for (const pack of BUILTIN_PACKS) {
    assert.ok(pack.id.length > 0 && pack.label.length > 0 && pack.description.length > 0);
    assert.ok(pack.rules.length >= 5, `${pack.id}: enough rules to matter`);
    for (const rule of pack.rules) {
      assert.ok(rule.trigger_pattern.length >= 8, `${pack.id}: trigger is keyword-rich`);
      assert.ok(rule.symptom.length >= 8 && rule.prescription.length >= 10, `${pack.id}: rule is substantive`);
      prescriptions.add(rule.prescription);
    }
    assert.ok(!packIds.has(pack.id), 'pack ids are unique');
    packIds.add(pack.id);
  }
  const total = BUILTIN_PACKS.reduce((sum, pack) => sum + pack.rules.length, 0);
  assert.equal(prescriptions.size, total, 'no prescription repeats across packs');
});

test('seed installs through the insert path, is idempotent, and removes cleanly', () => {
  const s = store();
  const first = s.seedPack('git-safety', packOf('git-safety').rules);
  assert.equal(first.inserted, 6);
  assert.equal(first.alreadySeeded, 0);
  assert.equal(s.listAll().length, 6);

  const second = s.seedPack('git-safety', packOf('git-safety').rules);
  assert.deepEqual([second.inserted, second.alreadySeeded], [0, 6], 'a repeat seed is a no-op');
  assert.equal(s.listAll().length, 6);

  const removed = s.removeSeedPack('git-safety');
  assert.deepEqual([removed.removed, removed.keptChanged, removed.keptProven], [6, 0, 0]);
  assert.equal(s.listAll(true).length, 0, 'nothing lingers');
  s.close();
});

test('a seeded rule that has been delivered is kept on removal', () => {
  const s = store();
  s.seedPack('node-ts', packOf('node-ts').rules);
  const delivered = s.listAll()[0].id;
  s['db'].prepare('UPDATE antibodies SET hit_count = 3 WHERE id = ?').run(delivered);

  const removed = s.removeSeedPack('node-ts');
  assert.equal(removed.removed, 5);
  assert.equal(removed.keptProven, 1, 'the delivered rule is evidence now');
  assert.ok(s.listAll(true).some((row) => row.id === delivered), 'it survives removal');
  s.close();
});

test('a seeded rule whose wording changed is kept on removal', () => {
  const s = store();
  s.seedPack('docker', packOf('docker').rules);
  const edited = s.listAll()[0].id;
  s.setPrescription(edited, '人工改写过的建议文本', 'human');

  const removed = s.removeSeedPack('docker');
  assert.equal(removed.removed, 5);
  assert.equal(removed.keptChanged, 1, 'the rewritten rule belongs to the user now');
  assert.equal(s.listAll(true).find((row) => row.id === edited).prescription, '人工改写过的建议文本');
  s.close();
});

test('seeding over an identical user rule protects that rule from removal', () => {
  const s = store();
  // The user already learned this lesson live; seeding merges into their row.
  s.insert(packOf('python-uv').rules[0]);
  const theirs = s.listAll()[0].id;
  const report = s.seedPack('python-uv', packOf('python-uv').rules);
  assert.equal(report.inserted, 6, 'the merge still records all six rows');

  const removed = s.removeSeedPack('python-uv');
  assert.equal(removed.keptProven, 1, 'the user rule was hit-counted by the merge');
  assert.ok(s.listAll(true).some((row) => row.id === theirs), 'the user rule survives');
  s.close();
});
