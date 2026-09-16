import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sha256, hashConvention, zeroHash, citedLine } from '../tools/corpus/check-manifest.mjs';

// Without this check, the P0 gate could accept a malformed or misbound P1 contract.
const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root));
const object = (value, label) => {
  assert.ok(value != null && typeof value === 'object' && !Array.isArray(value), label);
  return value;
};
const exactKeys = (value, keys, label) => assert.deepEqual(Object.keys(object(value, label)).sort(), [...keys].sort(), `${label} fields`);
const strings = (value, label, nonempty = false) => {
  assert.ok(Array.isArray(value) && (!nonempty || value.length > 0), label);
  assert.ok(value.every((item) => typeof item === 'string' && item.trim()), `${label} strings`);
  assert.equal(new Set(value).size, value.length, `${label} unique`);
};
const records = (value, label) => {
  assert.ok(Array.isArray(value), label);
  value.forEach((item, index) => object(item, `${label}[${index}]`));
};

try {
  assert.notEqual(process.exitCode, 1, 'manifest must pass first');
  const bytes = read('reconstruction/contracts/p1-parser-boundary.json');
  const raw = bytes.toString('utf8');
  assert.ok(Buffer.from(raw).equals(bytes), 'contract must be valid UTF-8');
  const { meta, contract } = JSON.parse(raw);
  exactKeys(meta, [
    'draftedFromOid', 'sha256', 'hashConvention', 'manifestSha256', 'sequencesSha256',
    'contractTypeRef', 'decisionBranches', 'questionResolutions', 'operationContract',
  ], 'meta');
  assert.match(meta.draftedFromOid, /^[a-f0-9]{40}$/, 'draftedFromOid');
  assert.equal(meta.hashConvention, hashConvention, 'hash convention');
  const prefix = /^(\{\s*"meta"\s*:\s*\{\s*"draftedFromOid"\s*:\s*"[^"]+"\s*,\s*"sha256"\s*:\s*")([a-f0-9]{64})(")/;
  assert.ok(prefix.test(raw), 'meta must lead with draftedFromOid and sha256');
  assert.equal(sha256(raw.replace(prefix, (_, before, hash, after) => before + zeroHash + after)), meta.sha256, 'contract self digest');

  const manifest = JSON.parse(read('reconstruction/tools/corpus/manifest.json'));
  const sequences = JSON.parse(read('reconstruction/tools/corpus/sequences.json'));
  assert.equal(meta.manifestSha256, manifest.meta.sha256, 'referenced manifest digest');
  assert.equal(meta.sequencesSha256, sequences.meta.sha256, 'referenced sequences digest');

  // References must resolve to substantive evidence, not a blank line or a made-up ID.
  const evidence = (ref) => {
    const match = ref.match(/^([^:#]+)(?::(\d+) «([^»]+)»|#(.+))?$/);
    assert.ok(match != null && !match[1].startsWith('/') && !match[1].split('/').includes('..'), `${ref}: checkout reference (line refs need «anchor»)`);
    if (match[2] != null) {
      const line = citedLine(fileURLToPath(new URL(match[1], root)), Number(match[2]), match[3], ref);
      assert.ok(line && !/^[|:\s-]+$/.test(line) && !/^```/.test(line), `${ref}: substantive line`);
    }
    if (match[4] != null) {
      assert.ok(JSON.parse(read(match[1]).toString('utf8')).expectations?.some((item) => item.expectedId === match[4]), `${ref}: expectedRef`);
    }
    if (match[2] == null && match[4] == null) read(match[1]);
  };
  evidence(meta.contractTypeRef);

  const fields = [
    'contractId', 'mode', 'objective',
    'baseOid', 'cleanTreeRequired', 'readPaths', 'allowedPaths', 'allowedGitCommands',
    'moduleIds', 'integrationContractIds', 'dependsOnContractIds', 'publicTypes', 'publicFunctions', 'allowedDependencies',
    'fixtureIds', 'sequenceIds', 'expectedDecisions', 'expectationEvidence',
    'semanticDeadlines', 'deliveryDeadlines', 'retentionLimits', 'resourceLimits', 'workDeadline',
    'persistenceUnits', 'persistedFields', 'nonPersistedFields',
    'outOfScope', 'acceptanceChecks', 'testMapping', 'requiredCommands', 'artifactRequirements',
    'unresolvedQuestions',
  ];
  exactKeys(contract, fields, 'contract');
  assert.ok(typeof contract.contractId === 'string' && contract.contractId.trim(), 'contractId');
  assert.ok(['read-only', 'implementation'].includes(contract.mode), 'mode');
  assert.ok(typeof contract.objective === 'string' && contract.objective.trim(), 'objective');
  // The integrator assigns the implementation base at order time via P1_BASE_OID=<oid> (no separate contract
  // artifact; check-manifest.mjs owns argv). Without this input the checker could only ever see the draft's 'unassigned'.
  const baseOid = process.env.P1_BASE_OID || contract.baseOid;
  if (baseOid === 'unassigned') {
    console.warn('WARN: contract.baseOid=unassigned; draft only, implementation must wait for integrator assignment (P1_BASE_OID=<oid>)');
  } else {
    assert.match(baseOid ?? '', /^[a-f0-9]{7,40}$/, 'base OID must be an OID or unassigned');
    // Without existence validation, an implementation could start before its contract was landed.
    execFileSync('git', ['cat-file', '-e', `${baseOid}:reconstruction/contracts/p1-parser-boundary.json`], { cwd: fileURLToPath(root), stdio: 'pipe' });
  }
  assert.equal(typeof contract.cleanTreeRequired, 'boolean', 'cleanTreeRequired');
  for (const field of [
    'readPaths', 'allowedPaths', 'allowedGitCommands', 'moduleIds', 'integrationContractIds',
    'dependsOnContractIds', 'publicTypes', 'publicFunctions', 'allowedDependencies',
    'fixtureIds', 'sequenceIds', 'persistenceUnits', 'persistedFields', 'nonPersistedFields',
    'outOfScope', 'artifactRequirements',
  ]) strings(contract[field], field, ['readPaths', 'allowedPaths', 'moduleIds', 'publicTypes', 'fixtureIds', 'sequenceIds', 'outOfScope', 'artifactRequirements'].includes(field));
  assert.ok(contract.workDeadline === null || (typeof contract.workDeadline === 'string' && contract.workDeadline.trim()), 'workDeadline');
  for (const field of [
    'expectedDecisions', 'expectationEvidence', 'semanticDeadlines', 'deliveryDeadlines',
    'retentionLimits', 'resourceLimits', 'acceptanceChecks', 'testMapping', 'requiredCommands',
    'unresolvedQuestions',
  ]) records(contract[field], field);

  const fixtureIds = manifest.fixtures.map((fixture) => fixture.fixtureId).sort();
  assert.deepEqual([...contract.fixtureIds].sort(), fixtureIds, 'fixtureIds must reference all 257 manifest rows');
  const sequenceIds = new Set(sequences.sequences.map((sequence) => sequence.sequenceId));
  assert.ok(contract.sequenceIds.every((id) => sequenceIds.has(id)), 'sequenceId must exist');
  const steps = new Map(sequences.sequences.flatMap((sequence) => sequence.steps.map((step) => [step.expectedRef, step])));
  const expectations = new Map(sequences.expectations.map((expectation) => [expectation.expectedId, expectation]));
  for (const item of contract.expectedDecisions) {
    exactKeys(item, ['expectedRef'], 'expectedDecision');
    const step = steps.get(item.expectedRef);
    const expectation = expectations.get(item.expectedRef);
    assert.ok(step != null && expectation != null, `${item.expectedRef}: expectedRef must exist`);
    assert.ok(contract.sequenceIds.includes(step.sequenceId), `${item.expectedRef}: sequence must be in sequenceIds`);
    assert.notEqual(expectation.decision, null, `${item.expectedRef}: null is unresolved, not an expected decision`);
  }
  for (const item of contract.expectationEvidence) {
    exactKeys(item, ['expectedRef'], 'expectationEvidence');
    const expectation = expectations.get(item.expectedRef);
    assert.ok(expectation != null, `${item.expectedRef}: evidence expectedRef must exist`);
    assert.ok(Array.isArray(expectation.basisRefs) && expectation.basisRefs.length > 0, `${item.expectedRef}: evidence must be nonempty`);
  }
  assert.deepEqual(
    contract.expectationEvidence.map((item) => item.expectedRef).sort(),
    contract.expectedDecisions.map((item) => item.expectedRef).sort(),
    'every expected decision needs evidence',
  );

  for (const ref of contract.publicTypes) {
    const match = ref.match(/^([^#]+)#([A-Za-z_$][\w$]*)$/);
    assert.ok(match != null, `${ref}: public type reference`);
    const source = read(match[1]).toString('utf8');
    assert.match(source, new RegExp(`export\\s+(?:type|interface)\\s+${match[2]}\\b`), `${ref}: exported type must exist`);
  }
  for (const check of contract.acceptanceChecks) {
    exactKeys(check, ['id', 'requirement', 'evidenceRefs'], 'acceptanceCheck');
    assert.ok(typeof check.id === 'string' && check.id.trim(), 'acceptanceCheck id');
    assert.ok(typeof check.requirement === 'string' && check.requirement.trim(), `${check.id}: requirement`);
    strings(check.evidenceRefs, `${check.id}: evidenceRefs`, true);
    check.evidenceRefs.forEach(evidence);
  }
  for (const mapping of contract.testMapping) {
    exactKeys(mapping, ['testId', 'purpose', 'referenceIds', 'behavior'], 'testMapping');
    assert.ok(typeof mapping.testId === 'string' && mapping.testId.trim(), 'testId');
    assert.ok(['acceptance', 'contractBoundary', 'regression', 'corpusHistory'].includes(mapping.purpose), `${mapping.testId}: purpose`);
    strings(mapping.referenceIds, `${mapping.testId}: referenceIds`, true);
    for (const ref of mapping.referenceIds) {
      if (!contract.acceptanceChecks.some((check) => check.id === ref)) evidence(ref);
    }
    assert.ok(typeof mapping.behavior === 'string' && mapping.behavior.trim(), `${mapping.testId}: behavior`);
  }
  for (const command of contract.requiredCommands) {
    exactKeys(command, ['command', 'cwd', 'target', 'stage', 'purpose'], 'requiredCommand');
    assert.ok(typeof command.cwd === 'string' && command.cwd.trim(), 'command cwd');
    assert.ok(typeof command.target === 'string' && command.target.trim(), 'command target');
    assert.ok(typeof command.command === 'string' && command.command.trim(), 'required command');
    assert.ok(['preparation', 'contract', 'implementation'].includes(command.stage), `${command.command}: stage`);
    assert.ok(typeof command.purpose === 'string' && command.purpose.trim(), `${command.command}: purpose`);
  }
  const owners = ['user', 'implementer', 'integrator', 'personal'];
  for (const question of contract.unresolvedQuestions) {
    exactKeys(question, ['id', 'owner', 'blocks', 'resolveBy', 'requiredEvidence'], 'unresolvedQuestion');
    assert.ok(typeof question.id === 'string' && question.id.trim(), 'question id');
    assert.ok(owners.includes(question.owner), `${question.id}: owner`);
    strings(question.blocks, `${question.id}: blocks`, true);
    assert.ok(typeof question.resolveBy === 'string' && question.resolveBy.trim(), `${question.id}: resolveBy`);
    strings(question.requiredEvidence, `${question.id}: requiredEvidence`, true);
  }
  assert.equal(new Set(contract.unresolvedQuestions.map((question) => question.id)).size, contract.unresolvedQuestions.length, 'unique unresolved IDs');
  console.log(`PASS: contract=${contract.contractId}; fixtures=${contract.fixtureIds.length}; sequences=${contract.sequenceIds.length}; expected=${contract.expectedDecisions.length}; unresolved=${contract.unresolvedQuestions.length}; sha256=${meta.sha256}`);
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
}
