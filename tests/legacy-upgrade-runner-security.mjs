import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertCommandSuccess } from '../scripts/run-local-sql-integration.mjs';
import { captureSyntheticFixtureCounts, legacyFixtureEvidence, legacyFixtureSections,
  loadLegacyUpgradeFixture, runConcurrentLegacyProvenance } from '../scripts/legacy-upgrade-fixture.mjs';

const repository = new URL('../', import.meta.url).pathname;
const fixture = await loadLegacyUpgradeFixture(repository);
const source = await readFile(new URL('../tests/sql/legacy-provenance-security.sql', import.meta.url), 'utf8');
const raceSource = await readFile(new URL('../tests/sql/legacy-provenance-concurrency-security.sql', import.meta.url), 'utf8');
assert.equal(legacyFixtureSections(source, raceSource).sha256, fixture.sha256);
assert.equal(Object.keys(fixture.race.sections).length, 9);
for (const [mutated, race] of [
  [source + '\n-- BEGIN LEGACY PROVENANCE SEED', raceSource],
  [source.replace('-- END LEGACY PROVENANCE VERIFY', '-- incomplete'), raceSource],
  [source.replace('commit;\n-- END LEGACY PROVENANCE SEED', 'rollback;\n-- END LEGACY PROVENANCE SEED'), raceSource],
  [source, raceSource.replace('-- END OWNER PROVENANCE RACE SESSION F', '-- incomplete')],
  [source, raceSource.replace('begin isolation level read committed;', 'begin isolation level repeatable read;')]
]) assert.throws(() => legacyFixtureSections(mutated, race));

const facts = { passed: true, syntheticSourceRows: 12, validatedSources: 6, divergentTargetPreserved: true,
  sourceFrozenAndPreserved: true, ownerAndStampIsolation: true, explicitPatientAndCaseMapping: true,
  historicalClaimsSeparatedFromImportAudit: true, repeatedCopyIdempotent: true, verificationRolledBack: true };
const safe = legacyFixtureEvidence(JSON.stringify({ legacyProvenanceFixture: { ...facts,
  privateRuntimeContent: 'do-not-export' }, privateRuntimeContent: 'do-not-export' }), fixture);
assert.ok(!JSON.stringify(safe).includes('do-not-export'));
for (const mutate of [x => { x.syntheticSourceRows = 11; }, x => { x.validatedSources = 7; },
  x => { x.sourceFrozenAndPreserved = false; }, x => { x.historicalClaimsSeparatedFromImportAudit = 'do-not-export'; }]) {
  const wrong = structuredClone(facts); mutate(wrong);
  assert.throws(() => legacyFixtureEvidence(JSON.stringify({ legacyProvenanceFixture: wrong }), fixture),
    error => !error.message.includes('do-not-export'));
}
for (const raw of ['null', '[]', '42', 'private runtime content'])
  assert.throws(() => legacyFixtureEvidence(raw, fixture), error => !error.message.includes('private runtime content'));

const counts = { authRows: 8, legacySourceRows: 12, signatureRows: 1,
  tableRows: { patients: 6, encounters: 3, preanesthetic_assessments: 93, anesthesia_records: 167,
    recovery_records: 143, consents: 53, addenda: 2, appointments: 0 } };
assert.equal((await captureSyntheticFixtureCounts({ run: async sql => {
  assert.match(sql, /^begin read only;/); assert.match(sql, /count\(\*\)/); assert.match(sql, /commit;$/);
  return { stdout: JSON.stringify({ ...counts, privateRuntimeContent: 'do-not-export' }) };
} })).canonicalClinicalRows, 467);
for (const mutate of [x => { x.authRows = 3; }, x => { x.tableRows.patients = 7; },
  x => { x.tableRows.private_table = 1; }]) {
  const wrong = structuredClone(counts); mutate(wrong);
  await assert.rejects(captureSyntheticFixtureCounts({ run: async () => ({ stdout: JSON.stringify(wrong) }) }));
}

const outcome = { passed: true, twoAuthenticatedProgrammers: true, legacyIdentityCommitted: 1,
  legacySourceBlocked: 1, twoAuthenticatedNormalWriters: true, normalIdentityCommitted: 1, normalWriterRejected: 1,
  twoConcurrentOwnerStatements: true, ownerCohortsAccepted: 1, contradictoryOwnerCohortsRejected: 1,
  originalSourcesPreserved: true };
const held = ['LEGACY_IDENTITY_A_UNCOMMITTED', 'NORMAL_IDENTITY_C_UNCOMMITTED', 'OWNER_PROVENANCE_E_UNCOMMITTED'];
const completed = ['LEGACY_IDENTITY_B_BLOCKED', 'NORMAL_IDENTITY_D_BLOCKED', 'OWNER_PROVENANCE_F_BLOCKED'];
const waiters = ['soft-as-legacy-identity-b', 'soft-as-normal-identity-d', 'soft-as-owner-provenance-f'];

async function protocol(mode = 'success') {
  const events = [], barriers = [], killed = []; let opens = 0;
  const db = {
    run: async (sql, label) => {
      events.push(label);
      if (label === 'legacy repeatable read denial') return { stdout: JSON.stringify({ legacyIdentityIsolation:
        { repeatableReadRejected: true, unchangedHistoricalIdentityPreserved: true } }) };
      if (label === 'legacy concurrent identity and owner invariants') return { stdout: JSON.stringify({ legacyIdentityRace:
        { ...outcome, ...(mode === 'invalid-final' ? { ownerCohortsAccepted: 2 } : {}), privateRuntimeContent: 'do-not-export' } }) };
      assert.match(sql, /commit;/); return {};
    },
    open: async sql => {
      const index = opens++, pair = Math.floor(index / 2), first = index % 2 === 0;
      events.push(`open-${index}`);
      assert.match(sql, /begin isolation level read committed;/);
      if (!first) assert.ok(events.includes(`held-${pair}`));
      return {
        waitFor: async marker => { assert.equal(marker, held[pair]); events.push(`held-${pair}`); },
        end: value => {
          events.push(`end-${index}`);
          if (first) {
            assert.ok(events.includes(`open-${index + 1}`) && events.includes(`end-${index + 1}`));
            barriers.push(value);
          }
        },
        kill: () => killed.push(index),
        done: Promise.resolve(first ? { code: 0, stdout: mode === 'missing-barrier' ? '' : 'LEGACY_PROVENANCE_OBSERVED_WAIT', stderr: '' } :
          { code: mode === 'second-error' ? 3 : 0, stdout: completed[pair], stderr: mode === 'second-error' ?
            'ERROR:  42501: private runtime content' : '' })
      };
    }
  };
  const run = runConcurrentLegacyProvenance(db, fixture, assertCommandSuccess);
  if (mode === 'success') {
    const report = await run;
    assert.equal(report.observedAdvisoryWaits, 3); assert.equal(opens, 6);
    assert.equal(report.broaderDeadlockFreedomVerified, false);
    assert.ok(!JSON.stringify(report).includes('do-not-export'));
    assert.ok(events.indexOf('legacy repeatable read denial') < events.indexOf('open-0'));
    for (let index = 0; index < barriers.length; index++) {
      const sql = barriers[index];
      assert.match(sql, /pg_locks waiting/); assert.match(sql, /not waiting\.granted/);
      assert.match(sql, /held\.pid=pg_backend_pid\(\)/);
      assert.ok(sql.includes(`activity.application_name='${waiters[index]}'`));
      assert.ok(sql.indexOf('pg_stat_clear_snapshot') < sql.indexOf('pg_locks waiting'));
      assert.ok(sql.indexOf('if observed is distinct from true') < sql.indexOf('commit;'));
    }
  } else {
    await assert.rejects(run, error => !error.message.includes('private runtime content'));
  }
  assert.equal(killed.length, opens, 'Both processes must be closed even on a failed assertion');
}
for (const mode of ['success', 'missing-barrier', 'second-error', 'invalid-final']) await protocol(mode);
console.log('✓ legacy runner: exact phase extraction, private-free evidence, three observed-lock protocols and isolation rejection; real PostgreSQL execution remains a CI requirement');
