import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, hashConvention, zeroHash, citedLine } from './check-manifest.mjs';

// Acceptance/contract boundary: without this check, P0 could ship missing or misbound evidence.
// Import also verifies the unchanged 257-row manifest; reuse its digest implementation.
try {
  assert.notEqual(process.exitCode, 1, 'manifest must pass first');
  const bytes = readFileSync(new URL('./sequences.json', import.meta.url));
  const raw = bytes.toString('utf8');
  assert.ok(Buffer.from(raw).equals(bytes), 'sequences must be valid UTF-8');
  const { meta, sequences, expectations, unresolvedQuestions } = JSON.parse(raw);
  const manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
  assert.equal(meta.baseOid, '3669dfd6a98e6c116c86f7db1cd27aa63002a90d', 'contract baseOid');
  assert.equal(meta.manifestSha256, manifest.meta.sha256, 'referenced manifest digest');
  assert.equal(meta.hashConvention, hashConvention, 'hash convention');
  const prefix = /^(\{\s*"meta"\s*:\s*\{\s*"baseOid"\s*:\s*"[^"]+"\s*,\s*"sha256"\s*:\s*")([a-f0-9]{64})(")/;
  assert.ok(prefix.test(raw), 'meta must lead with baseOid and sha256');
  assert.equal(sha256(raw.replace(prefix, (_, before, hash, after) => before + zeroHash + after)), meta.sha256, 'sequences self digest');
  assert.ok(meta.clock.includes('synthetic epoch milliseconds'), 'synthetic clock convention');
  assert.ok(Array.isArray(sequences) && Array.isArray(expectations), 'sequence/expectation arrays');
  assert.deepEqual(sequences.map((s) => s.sequenceId).sort(), Array.from({ length: 11 }, (_, i) => `O${String(i + 1).padStart(2, '0')}`), 'O01..O11 exactly once');
  const fixtures = new Map(manifest.fixtures.map((f) => [f.fixtureId, f]));
  const records = new Map(expectations.map((e) => [e.expectedId, e]));
  assert.equal(records.size, expectations.length, 'unique expectedId');
  assert.ok(Array.isArray(meta.p2Subsets) && meta.p2Subsets.length > 0, 'P2 subsets required');
  assert.equal(new Set(meta.p2Subsets.map((subset) => subset.subsetId)).size, meta.p2Subsets.length, 'unique P2 subsetId');
  for (const subset of meta.p2Subsets) {
    assert.deepEqual(Object.keys(subset), ['subsetId', 'stepRefs', 'replaces', 'deferred'], `${subset.subsetId}: P2 subset fields`);
    assert.match(subset.subsetId, /^P2-O\d{2}-[A-Z-]+-v\d+$/, `${subset.subsetId}: versioned P2 subsetId`);
    assert.ok(Array.isArray(subset.stepRefs) && subset.stepRefs.length > 0 && subset.stepRefs.every((ref) => records.has(ref)), `${subset.subsetId}: known stepRefs`);
    assert.equal(new Set(subset.stepRefs).size, subset.stepRefs.length, `${subset.subsetId}: unique stepRefs`);
    assert.ok(Array.isArray(subset.replaces) && subset.replaces.every((item) => typeof item === 'string' && item.trim()), `${subset.subsetId}: replaces`);
    for (const replacement of subset.replaces) {
      const match = replacement.match(/^((?:expected|unmet):O\d{2}:\d+(?: \+ (?:expected|unmet):O\d{2}:\d+)*) -> ((?:expected|unmet):O\d{2}:\d+)$/);
      assert.ok(match != null, `${subset.subsetId}: replacement syntax`);
      for (const ref of [...match[1].split(' + '), match[2]]) assert.ok(records.has(ref), `${subset.subsetId}: replacement reference ${ref}`);
      assert.ok(subset.stepRefs.includes(match[2]), `${subset.subsetId}: replacement target belongs to subset`);
    }
    assert.ok(typeof subset.deferred === 'string' && subset.deferred.trim(), `${subset.subsetId}: deferred scope`);
  }
  const used = new Set();
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const report = [];
  for (const sequence of sequences) {
    assert.ok(Array.isArray(sequence.steps) && sequence.steps.length > 0, `${sequence.sequenceId}: steps required`);
    let unmet = 0;
    let previousTime = null;
    for (const [index, step] of sequence.steps.entries()) {
      const label = `${sequence.sequenceId}:${index + 1}`;
      assert.deepEqual(Object.keys(step), ['sequenceId', 'position', 'action', 'fixtureId', 'receivedAt', 'evaluatedAt', 'inputSource', 'operationExpected', 'expectedRef', 'expectationBasis'], `${label}: CorpusSequenceStep fields/order`);
      assert.equal(step.sequenceId, sequence.sequenceId, `${label}: sequenceId`);
      assert.equal(step.position, index + 1, `${label}: position`);
      assert.ok(['receive', 'advanceClock', 'save', 'restart', 'injectFailure', 'recover'].includes(step.action), `${label}: action`);
      assert.ok(['ws', 'rest', 'replay', 'test'].includes(step.inputSource), `${label}: inputSource`);
      assert.ok(step.fixtureId === null || (typeof step.fixtureId === 'string' && fixtures.has(step.fixtureId)), `${label}: fixtureId`);
      assert.ok(Number.isSafeInteger(step.evaluatedAt), `${label}: evaluatedAt epoch ms`);
      if (previousTime !== null && !['restart', 'advanceClock'].includes(step.action)) {
        assert.ok(step.evaluatedAt >= previousTime, `${label}: clock reversal requires an explicit control`);
      }
      previousTime = step.evaluatedAt;
      assert.ok(step.receivedAt === null || Number.isSafeInteger(step.receivedAt), `${label}: receivedAt`);
      assert.ok([null, 'normal', 'training', 'test', 'rejected'].includes(step.operationExpected), `${label}: operationExpected`);
      if (step.action === 'receive') {
        assert.notEqual(step.operationExpected, null, `${label}: receive operation required`);
        assert.notEqual(step.receivedAt, null, `${label}: receive time required`);
        assert.equal(step.evaluatedAt, step.receivedAt, `${label}: fixed draft scheduler`);
        const fixture = fixtures.get(step.fixtureId);
        if (fixture != null) {
          assert.equal(fixture.role, 'telegramXml', `${label}: receive needs a telegram body`);
          // Without this fixture-body check, replay origin could silently replace the telegram's operation.
          const xml = readFileSync(new URL(fixture.path, new URL('../../../', import.meta.url)), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
          const control = xml.match(/<Control(?:\s[^>]*)?>([\s\S]*?)<\/Control>/)?.[1];
          const status = control?.match(/<Status(?:\s[^>]*)?>([^<]*)<\/Status>/)?.[1].trim();
          const operation = new Map([['通常', 'normal'], ['訓練', 'training'], ['試験', 'test']]).get(status) ?? 'rejected';
          assert.equal(step.operationExpected, operation, `${label}: Control.Status operation mismatch`);
          const reportTime = Date.parse(fixture.documentTimes.reportDateTimeRaw);
          if (Number.isFinite(reportTime)) assert.ok(step.receivedAt >= reportTime, `${label}: reception cannot predate the report`);
        }
      } else {
        assert.equal(step.receivedAt, null, `${label}: control has no reception time`);
        assert.equal(step.operationExpected, null, `${label}: control has no operation`);
      }
      const e = records.get(step.expectedRef);
      assert.ok(e != null, `${label}: expectedRef must resolve`);
      assert.ok(!used.has(step.expectedRef), `${label}: expectation cannot bind two steps`);
      used.add(step.expectedRef);
      assert.equal(e.sequenceId, step.sequenceId, `${label}: expected sequenceId`);
      assert.equal(e.position, step.position, `${label}: expected position`);
      assert.ok(Array.isArray(step.expectationBasis) && step.expectationBasis.length > 0, `${label}: evidence required`);
      assert.ok(step.expectationBasis.every((ref) => typeof ref === 'string' && /^L[1-4]: \S.*\S$/.test(ref)), `${label}: L1..L4 evidence syntax`);
      // Without file existence checks, invented evidence paths would satisfy the P0 acceptance gate.
      for (const ref of step.expectationBasis) {
        const location = ref.match(/^L[1-4]: ([^:\s]+):(\d+) «([^»]+)»(?:\s|$)/);
        assert.ok(location != null, `${label}: draft evidence needs file:line «anchor»`);
        const path = resolve(root, location[1]);
        assert.ok(path.startsWith(root.endsWith(sep) ? root : root + sep), `${label}: evidence outside checkout`);
        // Without line/content checks, out-of-range, blank, separator or drifted citations masquerade as evidence.
        const text = citedLine(path, Number(location[2]), location[3], label);
        assert.ok(text && !/^[|:\s-]+$/.test(text) && !/^#{1,6}\s|^```/.test(text), `${label}: evidence must cite substantive text`);
      }
      assert.deepEqual(e.basisRefs, step.expectationBasis, `${label}: evidence references`);
      assert.equal(e.basisLevel, Math.min(...step.expectationBasis.map((ref) => Number(ref[1]))), `${label}: strongest evidence level`);
      assert.deepEqual(Object.keys(e), ['expectedId', 'sequenceId', 'position', 'decision', 'effective', 'subjects', 'notices', 'intents', 'basisLevel', 'basisRefs', 'input', 'checks'], `${label}: expected record fields`);
      assert.ok([true, false, null].includes(e.notices) && [true, false, null].includes(e.intents), `${label}: side effect expectations`);
      assert.ok(Array.isArray(e.checks) && e.checks.length > 0 && e.checks.every((c) => typeof c === 'string' && c.trim()), `${label}: explicit acceptance checks`);
      // Without an unresolved-question link, a null receive decision could hide an unowned oracle gap.
      if (step.action === 'receive' && e.decision === null) {
        const ids = [...e.checks, ...e.basisRefs].join(' ').match(/\bQ-[A-Z][A-Z0-9-]*/g) ?? [];
        assert.ok(ids.some((id) => unresolvedQuestions.some((q) => q.id === id)), `${label}: null receive decision needs a declared Q-*`);
      }
      assert.ok(Array.isArray(e.subjects), `${label}: subjects`);
      for (const subject of e.subjects) {
        assert.deepEqual(Object.keys(subject), ['subject', 'revision'], `${label}: subject fields`);
        assert.ok(typeof subject.subject === 'string' && subject.subject.trim(), `${label}: subject identity`);
        assert.deepEqual(Object.keys(subject.revision), ['reportDateTimeRaw', 'serialRaw', 'infoTypeRaw'], `${label}: revision tuple`);
        assert.ok(Object.values(subject.revision).every((v) => v === null || typeof v === 'string'), `${label}: raw revision types`);
      }
      if (e.decision !== null) {
        assert.ok(['changed', 'unchanged', 'rejected'].includes(e.decision.kind), `${label}: Step kind`);
        const changed = e.decision.kind === 'changed';
        assert.deepEqual(Object.keys(e.decision), ['kind', changed ? 'change' : 'reason'], `${label}: Step projection fields`);
        if (changed) assert.ok([null, 'semantic', 'revisionOnly', 'deliveryOnly'].includes(e.decision.change), `${label}: change`);
        else if (e.decision.kind === 'unchanged') assert.ok(['duplicate', 'stale', 'noChange'].includes(e.decision.reason), `${label}: unchanged reason`);
        else assert.ok(e.decision.reason === null || (typeof e.decision.reason === 'string' && e.decision.reason.trim()), `${label}: rejection reason`);
      }
      if (e.effective !== null) {
        assert.ok(['active', 'inactive', 'unavailable'].includes(e.effective.kind), `${label}: Effective kind`);
        if (e.effective.kind === 'active') assert.deepEqual(Object.keys(e.effective), ['kind'], `${label}: active projection`);
        if (e.effective.kind === 'inactive') {
          assert.deepEqual(Object.keys(e.effective), ['kind', 'cause'], `${label}: inactive projection`);
          assert.deepEqual(Object.keys(e.effective.cause), ['kind'], `${label}: cause projection`);
          assert.ok(['released', 'cancelled', 'noActiveItems', 'expired'].includes(e.effective.cause.kind), `${label}: inactive cause`);
        }
        if (e.effective.kind === 'unavailable') {
          assert.deepEqual(Object.keys(e.effective), ['kind', 'reason'], `${label}: unavailable projection`);
          assert.ok(e.effective.reason === null || (typeof e.effective.reason === 'string' && e.effective.reason.trim()), `${label}: unavailable reason`);
        }
      }
      assert.ok(e.input === null || (typeof e.input.required === 'string' && e.input.required.trim() && typeof e.input.acquisition === 'string' && e.input.acquisition.trim()), `${label}: input contract`);
      if (step.expectedRef.startsWith('unmet:')) {
        unmet++;
        assert.equal(step.expectedRef, `unmet:${label}`, `${label}: unmet ID`);
        assert.equal(step.fixtureId, null, `${label}: unmet must not invent fixture`);
        assert.notEqual(e.input, null, `${label}: unmet input shape and acquisition plan`);
        assert.match(e.input.acquisition, /synthetic|REST/, `${label}: unmet acquisition plan`);
      } else {
        assert.equal(step.expectedRef, `expected:${label}`, `${label}: expected ID`);
        if (step.action === 'receive') assert.notEqual(step.fixtureId, null, `${label}: missing reception must be unmet`);
      }
    }
    report.push({ sequenceId: sequence.sequenceId, steps: sequence.steps.length, unmet });
  }
  assert.equal(used.size, records.size, 'no orphan expectations');
  assert.ok(Array.isArray(unresolvedQuestions), 'unresolvedQuestions');
  assert.equal(new Set(unresolvedQuestions.map((q) => q.id)).size, unresolvedQuestions.length, 'unique unresolved IDs');
  for (const q of unresolvedQuestions) {
    assert.deepEqual(Object.keys(q), ['id', 'owner', 'blocks', 'resolveBy'], 'unresolved fields');
    assert.ok(typeof q.id === 'string' && q.id.trim() && ['user', 'implementer', 'integrator'].includes(q.owner), 'unresolved id/owner');
    assert.ok(Array.isArray(q.blocks) && q.blocks.length > 0 && q.blocks.every((b) => typeof b === 'string' && b.trim()), `${q.id}: blocks`);
    assert.ok(typeof q.resolveBy === 'string' && q.resolveBy.trim(), `${q.id}: deadline`);
  }
  console.log(`PASS: ${expectations.length} steps; ${JSON.stringify(report)}; unmet=${report.reduce((n, r) => n + r.unmet, 0)} (reported, not waived); unresolved=${unresolvedQuestions.length}; sequences=${meta.sha256}; file=${sha256(bytes)}`);
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
}
