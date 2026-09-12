import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../../../', import.meta.url);
const baseOid = '46ea274fc216475f003647cc3d6626d2f52ef9d3';
const hashConvention = 'sha256 of UTF-8 file bytes with meta.sha256 replaced by 64 ASCII zeroes';
const zeroHash = '0'.repeat(64);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const read = (path) => readFileSync(fileURLToPath(new URL(path, root)));
const fixtureId = (path) => path.replace(/\//g, '__').replace(/\.(xml|json)$/, '');
const files = readdirSync(new URL('test/fixtures/', root), { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.(xml|json)$/.test(entry.name))
  .map((entry) => join(entry.parentPath ?? entry.path, entry.name).slice(fileURLToPath(root).length))
  .sort();

try {
  assert.equal(files.length, 257, 'fixture count');
  assert.equal(files.filter((path) => path.endsWith('.xml')).length, 236, 'XML count');
  assert.equal(files.filter((path) => path.endsWith('.json')).length, 21, 'JSON count');
  assert.ok(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === '--emit-skeleton'), 'usage: node check-manifest.mjs [--emit-skeleton]');
  if (process.argv[2] === '--emit-skeleton') {
    // No provenance inference: review every skeleton row before fixing the digest.
    const fixtures = files.map((path) => {
      const bytes = read(path);
      return {
        fixtureId: fixtureId(path), path, sha256: sha256(bytes), byteLength: bytes.length,
        role: path.endsWith('.xml') ? 'telegramXml' : null,
        acquisition: { kind: 'unknown', locator: null, acquiredAt: null, evidenceRefs: [] },
        modification: { kind: 'unknown', parentFixtureId: null, parentSha256: null, changes: [] },
        transport: { classification: null, headType: null, evidence: '' },
        documentTimes: { reportDateTimeRaw: null, targetDateTimeRaw: null },
        sourceStrength: 'unconfirmed', distribution: 'unconfirmed',
      };
    });
    process.stdout.write(`${JSON.stringify({ meta: { baseOid, sha256: zeroHash, hashConvention }, fixtures }, null, 2)}\n`);
  } else {
    const bytes = read('reconstruction/tools/corpus/manifest.json');
    const raw = bytes.toString('utf8');
    assert.ok(Buffer.from(raw).equals(bytes), 'manifest must be valid UTF-8');
    const { meta, fixtures } = JSON.parse(raw);
    assert.equal(meta.baseOid, baseOid, 'baseOid');
    assert.equal(meta.hashConvention, hashConvention, 'hash convention');
    const prefix = /^(\{\s*"meta"\s*:\s*\{\s*"baseOid"\s*:\s*"[^"]+"\s*,\s*"sha256"\s*:\s*")([a-f0-9]{64})(")/;
    assert.ok(prefix.test(raw), 'meta must lead with baseOid and sha256');
    assert.equal(sha256(raw.replace(prefix, (_, before, hash, after) => before + zeroHash + after)), meta.sha256, 'manifest self digest');
    assert.equal(fixtures.length, 257, 'manifest count');
    assert.deepEqual(fixtures.map((row) => row.path).sort(), files, 'fixture path set (including duplicates)');
    const counts = {};
    for (const row of fixtures) {
      assert.deepEqual(Object.keys(row).sort(), ['fixtureId', 'path', 'sha256', 'byteLength', 'role', 'acquisition', 'modification', 'transport', 'documentTimes', 'sourceStrength', 'distribution'].sort(), `${row.path}: CorpusFixture fields`);
      assert.deepEqual(Object.keys(row.acquisition).sort(), ['kind', 'locator', 'acquiredAt', 'evidenceRefs'].sort(), `${row.path}: acquisition fields`);
      assert.deepEqual(Object.keys(row.modification).sort(), ['kind', 'parentFixtureId', 'parentSha256', 'changes'].sort(), `${row.path}: modification fields`);
      assert.deepEqual(Object.keys(row.transport).sort(), ['classification', 'headType', 'evidence'].sort(), `${row.path}: transport fields`);
      assert.deepEqual(Object.keys(row.documentTimes).sort(), ['reportDateTimeRaw', 'targetDateTimeRaw'].sort(), `${row.path}: documentTimes fields`);
      assert.ok([
        row.acquisition.locator, row.acquisition.acquiredAt,
        row.modification.parentFixtureId, row.modification.parentSha256,
        row.transport.classification, row.transport.headType,
        row.documentTimes.reportDateTimeRaw, row.documentTimes.targetDateTimeRaw,
      ].every((value) => value === null || typeof value === 'string'), `${row.path}: nullable fields must be null or string`);
      assert.ok(Array.isArray(row.modification.changes), `${row.path}: changes must be an array`);
      assert.equal(row.fixtureId, fixtureId(row.path), `${row.path}: fixtureId`);
      const data = read(row.path);
      assert.equal(row.byteLength, data.length, `${row.path}: byteLength`);
      assert.equal(row.sha256, sha256(data), `${row.path}: sha256`);
      assert.ok(['telegramXml', 'checkpoint', 'restResponse', 'expectedValues', 'provenance'].includes(row.role), `${row.path}: role`);
      assert.ok(['confirmedOriginal', 'confirmedDerived', 'synthetic', 'unconfirmed'].includes(row.sourceStrength), `${row.path}: sourceStrength`);
      assert.ok(['publicApproved', 'privateOnly', 'unconfirmed'].includes(row.distribution), `${row.path}: distribution`);
      assert.ok(['jmaPublished', 'dmdataCaptured', 'externalCorpus', 'generated', 'unknown'].includes(row.acquisition.kind), `${row.path}: acquisition`);
      assert.ok(['byteIdentical', 'edited', 'synthetic', 'unknown'].includes(row.modification.kind), `${row.path}: modification`);
      assert.ok(Array.isArray(row.acquisition.evidenceRefs) && row.acquisition.evidenceRefs.every((ref) => typeof ref === 'string'), `${row.path}: evidenceRefs`);
      assert.ok(typeof row.transport.evidence === 'string' && row.transport.evidence.trim(), `${row.path}: transport evidence`);
      if (row.sourceStrength === 'unconfirmed') {
        assert.ok([...row.acquisition.evidenceRefs, row.transport.evidence].some((ref) => /^未確認理由: .+\S/u.test(ref)), `${row.path}: unconfirmed reason sentence`);
      }
      counts[row.sourceStrength] = (counts[row.sourceStrength] ?? 0) + 1;
    }

    // Modification invariants: validate all rows before resolving their parent chains.
    const byId = new Map(fixtures.map((row) => [row.fixtureId, row]));
    assert.equal(byId.size, 257, 'unique fixtureId');
    for (const row of fixtures) {
      if (['confirmedOriginal', 'confirmedDerived'].includes(row.sourceStrength)) {
        assert.ok(row.acquisition.evidenceRefs.some((ref) => ref.trim()), `${row.path}: confirmed source evidence required`);
      }
      if (row.modification.kind === 'edited') assert.ok(row.modification.changes.length > 0, `${row.path}: edited changes required`);
      for (const change of row.modification.changes) {
        assert.ok(change != null && typeof change === 'object' && !Array.isArray(change), `${row.path}: change must be an object`);
        assert.deepEqual(Object.keys(change).sort(), ['field', 'from', 'to'], `${row.path}: change fields`);
        assert.ok(typeof change.field === 'string' && change.field.trim(), `${row.path}: change field must be nonempty`);
        assert.ok([change.from, change.to].every((value) => value === null || typeof value === 'string'), `${row.path}: change from/to must be null or string`);
      }
      const parent = byId.get(row.modification.parentFixtureId);
      if (row.modification.parentFixtureId != null) {
        assert.ok(parent != null, `${row.path}: parentFixtureId must exist in manifest`);
        assert.equal(row.modification.parentSha256, parent.sha256, `${row.path}: parentSha256 must match parent row`);
      }
      const ancestors = new Set([row.fixtureId]);
      for (let ancestor = parent; ancestor != null; ancestor = byId.get(ancestor.modification.parentFixtureId)) {
        assert.ok(!ancestors.has(ancestor.fixtureId), `${row.path}: self-reference or parent cycle`);
        ancestors.add(ancestor.fixtureId);
      }
      if (row.modification.parentSha256 != null) {
        assert.match(row.modification.parentSha256, /^[a-f0-9]{64}$/, `${row.path}: parentSha256 format`);
        assert.notEqual(row.modification.parentSha256, zeroHash, `${row.path}: parentSha256 must not be all zeroes`);
        if (row.modification.parentFixtureId == null) {
          assert.ok(row.acquisition.evidenceRefs.some((ref) => ref.includes(row.modification.parentSha256)), `${row.path}: external parent hash must appear in evidenceRefs`);
        }
        if (row.modification.kind === 'byteIdentical') assert.equal(row.sha256, row.modification.parentSha256, `${row.path}: byteIdentical child and parent hashes must match`);
        if (row.modification.kind === 'edited') assert.notEqual(row.sha256, row.modification.parentSha256, `${row.path}: edited child and parent hashes must differ`);
      }
      if (row.modification.kind === 'byteIdentical') {
        assert.ok(
          row.sourceStrength === 'confirmedOriginal'
          || (row.sourceStrength === 'confirmedDerived' && ['confirmedOriginal', 'confirmedDerived'].includes(parent?.sourceStrength)),
          `${row.path}: byteIdentical requires confirmedOriginal or confirmedDerived with a confirmed parent`,
        );
      }
      if (row.sourceStrength === 'confirmedOriginal') {
        assert.equal(row.modification.kind, 'byteIdentical', `${row.path}: original modification`);
        assert.notEqual(row.acquisition.kind, 'unknown', `${row.path}: original acquisition must be known`);
      }
      if (row.sourceStrength === 'confirmedDerived') {
        assert.ok(['edited', 'byteIdentical'].includes(row.modification.kind), `${row.path}: derived modification`);
        assert.ok(
          (/^[a-f0-9]{64}$/.test(row.modification.parentSha256 ?? '') && row.modification.changes.length > 0)
          || parent != null,
          `${row.path}: derived parent hash and changes, or parentFixtureId required`,
        );
      }
      if (row.sourceStrength === 'synthetic') assert.equal(row.modification.kind, 'synthetic', `${row.path}: synthetic modification`);
    }
    console.log(`PASS: ${fixtures.length} fixtures (236 XML + 21 JSON); ${JSON.stringify(counts)}; manifest=${meta.sha256}; file=${sha256(bytes)}; base=${meta.baseOid}`);
  }
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
}
