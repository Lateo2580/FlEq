import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sha256, hashConvention, zeroHash, citedLine } from '../tools/corpus/check-manifest.mjs';

// Without this check, the P0/P2 gate could accept a malformed or misbound work contract.
const root = new URL('../../', import.meta.url);
const contractsDirectory = new URL('reconstruction/contracts/', root);
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
  const manifest = JSON.parse(read('reconstruction/tools/corpus/manifest.json'));
  const sequences = JSON.parse(read('reconstruction/tools/corpus/sequences.json'));
  const fixtureIds = new Set(manifest.fixtures.map((fixture) => fixture.fixtureId));
  const sequenceIds = new Set(sequences.sequences.map((sequence) => sequence.sequenceId));
  const steps = new Map(sequences.sequences.flatMap((sequence) => sequence.steps.map((step) => [step.expectedRef, step])));
  const expectations = new Map(sequences.expectations.map((expectation) => [expectation.expectedId, expectation]));
  const names = readdirSync(contractsDirectory).filter((name) => name.endsWith('.json')).sort();
  const documents = names.map((name) => {
    const path = `reconstruction/contracts/${name}`;
    const bytes = read(path);
    const raw = bytes.toString('utf8');
    assert.ok(Buffer.from(raw).equals(bytes), `${name}: contract must be valid UTF-8`);
    return { name, path, raw, document: JSON.parse(raw) };
  });
  const contractsById = new Map(documents.map(({ document, path }) => [document.contract?.contractId, path]));
  assert.equal(contractsById.size, documents.length, 'contractId must be unique');

  for (const { name, path, raw, document } of documents) {
    try {
      const { meta, contract } = document;
      exactKeys(meta, [
        'draftedFromOid', 'sha256', 'hashConvention', 'manifestSha256', 'sequencesSha256',
        'contractTypeRef', 'decisionBranches', 'questionResolutions', 'operationContract',
      ], `${name}: meta`);
      assert.match(meta.draftedFromOid, /^[a-f0-9]{40}$/, `${name}: draftedFromOid`);
      assert.equal(meta.hashConvention, hashConvention, `${name}: hash convention`);
      records(meta.decisionBranches, `${name}: decisionBranches`);
      records(meta.questionResolutions, `${name}: questionResolutions`);
      object(meta.operationContract, `${name}: operationContract`);
      const prefix = /^(\{\s*"meta"\s*:\s*\{\s*"draftedFromOid"\s*:\s*"[^"]+"\s*,\s*"sha256"\s*:\s*")([a-f0-9]{64})(")/;
      assert.ok(prefix.test(raw), `${name}: meta must lead with draftedFromOid and sha256`);
      assert.equal(sha256(raw.replace(prefix, (_, before, hash, after) => before + zeroHash + after)), meta.sha256, `${name}: contract self digest`);
      assert.equal(meta.manifestSha256, manifest.meta.sha256, `${name}: referenced manifest digest`);
      assert.equal(meta.sequencesSha256, sequences.meta.sha256, `${name}: referenced sequences digest`);

      const evidence = (ref) => {
        const match = ref.match(/^([^:#]+)(?::(\d+) «([^»]+)»|#(.+))?$/);
        assert.ok(match != null && !match[1].startsWith('/') && !match[1].split('/').includes('..'), `${name}: ${ref}: checkout reference (line refs need «anchor»)`);
        if (match[2] != null) {
          const line = citedLine(fileURLToPath(new URL(match[1], root)), Number(match[2]), match[3], ref);
          assert.ok(line && !/^[|:\s-]+$/.test(line) && !/^```/.test(line), `${name}: ${ref}: substantive line`);
        }
        if (match[4] != null) {
          const target = JSON.parse(read(match[1]).toString('utf8'));
          assert.ok(target.expectations?.some((item) => item.expectedId === match[4]), `${name}: ${ref}: expectedRef in referenced file`);
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
      exactKeys(contract, fields, `${name}: contract`);
      assert.ok(typeof contract.contractId === 'string' && contract.contractId.trim(), `${name}: contractId`);
      assert.ok(['read-only', 'implementation'].includes(contract.mode), `${name}: mode`);
      assert.ok(typeof contract.objective === 'string' && contract.objective.trim(), `${name}: objective`);
      const baseOid = contract.contractId === 'P1-PARSER-BOUNDARY-001' ? process.env.P1_BASE_OID || contract.baseOid : contract.baseOid;
      if (baseOid === 'unassigned') {
        console.warn(`WARN: contract=${contract.contractId}; baseOid=unassigned; draft only, implementation must wait for integrator assignment`);
      } else {
        assert.match(baseOid ?? '', /^[a-f0-9]{7,40}$/, `${name}: base OID must be an OID or unassigned`);
        execFileSync('git', ['cat-file', '-e', `${baseOid}:${path}`], { cwd: fileURLToPath(root), stdio: 'pipe' });
      }
      assert.equal(typeof contract.cleanTreeRequired, 'boolean', `${name}: cleanTreeRequired`);
      for (const field of [
        'readPaths', 'allowedPaths', 'allowedGitCommands', 'moduleIds', 'integrationContractIds',
        'dependsOnContractIds', 'publicTypes', 'publicFunctions', 'allowedDependencies',
        'fixtureIds', 'sequenceIds', 'persistenceUnits', 'persistedFields', 'nonPersistedFields',
        'outOfScope', 'artifactRequirements',
      ]) strings(contract[field], `${name}: ${field}`, ['readPaths', 'allowedPaths', 'moduleIds', 'publicTypes', 'fixtureIds', 'sequenceIds', 'outOfScope', 'artifactRequirements'].includes(field));
      assert.ok(contract.workDeadline === null || (typeof contract.workDeadline === 'string' && contract.workDeadline.trim()), `${name}: workDeadline`);
      for (const field of [
        'expectedDecisions', 'expectationEvidence', 'semanticDeadlines', 'deliveryDeadlines',
        'retentionLimits', 'resourceLimits', 'acceptanceChecks', 'testMapping', 'requiredCommands',
        'unresolvedQuestions',
      ]) records(contract[field], `${name}: ${field}`);

      assert.ok(contract.fixtureIds.every((id) => fixtureIds.has(id)), `${name}: fixtureId must exist in manifest`);
      assert.ok(contract.sequenceIds.every((id) => sequenceIds.has(id)), `${name}: sequenceId must exist`);
      for (const dependency of contract.dependsOnContractIds) assert.ok(contractsById.has(dependency), `${name}: ${dependency}: dependsOnContractId must exist`);
      for (const item of contract.expectedDecisions) {
        exactKeys(item, ['expectedRef'], `${name}: expectedDecision`);
        const step = steps.get(item.expectedRef);
        const expectation = expectations.get(item.expectedRef);
        assert.ok(step != null && expectation != null, `${name}: ${item.expectedRef}: expectedRef must exist`);
        assert.ok(contract.sequenceIds.includes(step.sequenceId), `${name}: ${item.expectedRef}: sequence must be in sequenceIds`);
        assert.notEqual(expectation.decision, null, `${name}: ${item.expectedRef}: null is unresolved, not an expected decision`);
      }
      for (const item of contract.expectationEvidence) {
        exactKeys(item, ['expectedRef'], `${name}: expectationEvidence`);
        const expectation = expectations.get(item.expectedRef);
        assert.ok(expectation != null, `${name}: ${item.expectedRef}: evidence expectedRef must exist`);
        assert.ok(Array.isArray(expectation.basisRefs) && expectation.basisRefs.length > 0, `${name}: ${item.expectedRef}: evidence must be nonempty`);
      }
      assert.deepEqual(
        contract.expectationEvidence.map((item) => item.expectedRef).sort(),
        contract.expectedDecisions.map((item) => item.expectedRef).sort(),
        `${name}: every expected decision needs evidence`,
      );

      for (const ref of contract.publicTypes) {
        const match = ref.match(/^([^#]+)#([A-Za-z_$][\w$]*)$/);
        assert.ok(match != null, `${name}: ${ref}: public type reference`);
        const source = read(match[1]).toString('utf8');
        assert.match(source, new RegExp(`export\\s+(?:type|interface)\\s+${match[2]}\\b`), `${name}: ${ref}: exported type must exist`);
      }
      for (const check of contract.acceptanceChecks) {
        exactKeys(check, ['id', 'requirement', 'evidenceRefs'], `${name}: acceptanceCheck`);
        assert.ok(typeof check.id === 'string' && check.id.trim(), `${name}: acceptanceCheck id`);
        assert.ok(typeof check.requirement === 'string' && check.requirement.trim(), `${name}: ${check.id}: requirement`);
        strings(check.evidenceRefs, `${name}: ${check.id}: evidenceRefs`, true);
        check.evidenceRefs.forEach(evidence);
      }
      for (const mapping of contract.testMapping) {
        exactKeys(mapping, ['testId', 'purpose', 'referenceIds', 'behavior'], `${name}: testMapping`);
        assert.ok(typeof mapping.testId === 'string' && mapping.testId.trim(), `${name}: testId`);
        assert.ok(['acceptance', 'contractBoundary', 'regression', 'corpusHistory'].includes(mapping.purpose), `${name}: ${mapping.testId}: purpose`);
        strings(mapping.referenceIds, `${name}: ${mapping.testId}: referenceIds`, true);
        for (const ref of mapping.referenceIds) if (!contract.acceptanceChecks.some((check) => check.id === ref)) evidence(ref);
        assert.ok(typeof mapping.behavior === 'string' && mapping.behavior.trim(), `${name}: ${mapping.testId}: behavior`);
      }
      for (const command of contract.requiredCommands) {
        exactKeys(command, ['command', 'cwd', 'target', 'stage', 'purpose'], `${name}: requiredCommand`);
        assert.ok(typeof command.cwd === 'string' && command.cwd.trim(), `${name}: command cwd`);
        assert.ok(typeof command.target === 'string' && command.target.trim(), `${name}: command target`);
        assert.ok(typeof command.command === 'string' && command.command.trim(), `${name}: required command`);
        assert.ok(['preparation', 'contract', 'implementation'].includes(command.stage), `${name}: ${command.command}: stage`);
        assert.ok(typeof command.purpose === 'string' && command.purpose.trim(), `${name}: ${command.command}: purpose`);
      }
      const owners = ['user', 'implementer', 'integrator', 'personal'];
      for (const question of contract.unresolvedQuestions) {
        exactKeys(question, ['id', 'owner', 'blocks', 'resolveBy', 'requiredEvidence'], `${name}: unresolvedQuestion`);
        assert.ok(typeof question.id === 'string' && question.id.trim(), `${name}: question id`);
        assert.ok(owners.includes(question.owner), `${name}: ${question.id}: owner`);
        strings(question.blocks, `${name}: ${question.id}: blocks`, true);
        assert.ok(typeof question.resolveBy === 'string' && question.resolveBy.trim(), `${name}: ${question.id}: resolveBy`);
        strings(question.requiredEvidence, `${name}: ${question.id}: requiredEvidence`, true);
      }
      assert.equal(new Set(contract.unresolvedQuestions.map((question) => question.id)).size, contract.unresolvedQuestions.length, `${name}: unique unresolved IDs`);
      console.log(`PASS: contract=${contract.contractId}; fixtures=${contract.fixtureIds.length}; sequences=${contract.sequenceIds.length}; expected=${contract.expectedDecisions.length}; unresolved=${contract.unresolvedQuestions.length}; sha256=${meta.sha256}`);
    } catch (error) {
      console.error(`FAIL: contract=${document.contract?.contractId ?? name}; ${error.message}`);
      process.exitCode = 1;
    }
  }
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
}
