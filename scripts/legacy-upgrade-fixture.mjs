import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const hash = value => createHash('sha256').update(value).digest('hex');
const fixturePath = 'tests/sql/legacy-provenance-security.sql';
const racePath = 'tests/sql/legacy-provenance-concurrency-security.sql';
const raceNames = ['LEGACY PROVENANCE RACE PREPARE', 'LEGACY PROVENANCE RACE SESSION A',
  'LEGACY PROVENANCE RACE SESSION B', 'NORMAL PATIENT RACE SESSION C', 'NORMAL PATIENT RACE SESSION D',
  'OWNER PROVENANCE RACE SESSION E', 'OWNER PROVENANCE RACE SESSION F',
  'LEGACY PROVENANCE REPEATABLE READ VERIFY', 'LEGACY PROVENANCE RACE VERIFY'];

function section(source, name) {
  const start = `-- BEGIN ${name}`, end = `-- END ${name}`;
  assert.equal(source.split(start).length, 2, 'Legacy fixture phase start must be unique');
  assert.equal(source.split(end).length, 2, 'Legacy fixture phase end must be unique');
  const from = source.indexOf(start) + start.length, to = source.indexOf(end);
  assert.ok(from < to, 'Legacy fixture phase boundaries are reversed');
  const sql = source.slice(from, to);
  assert.ok(sql.trim(), 'Legacy fixture phase must contain reviewed SQL');
  return { sql, sha256: hash(sql) };
}

export function legacyFixtureSections(source, raceSource) {
  const seed = section(source, 'LEGACY PROVENANCE SEED');
  const verify = section(source, 'LEGACY PROVENANCE VERIFY');
  assert.ok(source.indexOf('-- END LEGACY PROVENANCE SEED') < source.indexOf('-- BEGIN LEGACY PROVENANCE VERIFY'));
  assert.match(seed.sql, /^\s*begin;/i); assert.match(seed.sql, /commit;\s*$/i);
  assert.match(verify.sql, /^\s*begin;/i); assert.match(verify.sql, /rollback;\s*$/i);
  const race = Object.fromEntries(raceNames.map(name => [name, section(raceSource, name)]));
  for (const name of raceNames.filter(x => /SESSION/.test(x))) {
    assert.match(race[name].sql, /^\s*begin isolation level read committed;/i);
  }
  assert.match(race['LEGACY PROVENANCE RACE PREPARE'].sql, /commit;\s*$/i);
  assert.match(race['LEGACY PROVENANCE REPEATABLE READ VERIFY'].sql, /^\s*begin isolation level repeatable read;/i);
  assert.match(race['LEGACY PROVENANCE REPEATABLE READ VERIFY'].sql, /\brollback;/i);
  return { path: fixturePath, sha256: hash(source), seed, verify,
    race: { path: racePath, sha256: hash(raceSource), sections: race } };
}

export async function loadLegacyUpgradeFixture(repoDir) {
  const [source, raceSource] = await Promise.all([fixturePath, racePath].map(path => readFile(join(repoDir, path), 'utf8')));
  return legacyFixtureSections(source, raceSource);
}

function safeResult(stdout, key, expected) {
  let result;
  try { result = JSON.parse(stdout.trim()); } catch { throw new Error('Legacy fixture must return one safe JSON result'); }
  assert.ok(result && typeof result === 'object' && !Array.isArray(result), 'Legacy fixture response must be an object');
  const raw = result[key];
  assert.ok(raw && typeof raw === 'object' && !Array.isArray(raw), 'Legacy fixture criterion object is absent');
  for (const [name, value] of Object.entries(expected)) assert.ok(raw[name] === value, 'Legacy preservation/count criterion failed');
  return { ...expected };
}

export function legacyFixtureEvidence(stdout, fixture) {
  return { ...safeResult(stdout, 'legacyProvenanceFixture', { passed: true, syntheticSourceRows: 12,
    validatedSources: 6, divergentTargetPreserved: true, sourceFrozenAndPreserved: true,
    ownerAndStampIsolation: true, explicitPatientAndCaseMapping: true,
    historicalClaimsSeparatedFromImportAudit: true, repeatedCopyIdempotent: true, verificationRolledBack: true }),
  sourcePath: fixture.path, sourceSha256: fixture.sha256,
  extractedPhaseSha256: { seed: fixture.seed.sha256, verify: fixture.verify.sha256 },
  productionMutated: false, persistedRowsSynthetic: true };
}

export async function captureSyntheticFixtureCounts(db) {
  const tables = ['patients', 'encounters', 'preanesthetic_assessments', 'anesthesia_records',
    'recovery_records', 'consents', 'addenda', 'appointments'];
  const result = await db.run(`begin read only;
select jsonb_build_object('authRows',(select count(*) from auth.users),
 'legacySourceRows',(select count(*) from public.documentos),'signatureRows',(select count(*) from public.assinaturas),
 'tableRows',jsonb_build_object(${tables.map(name => `'${name}',(select count(*) from public.${name})`).join(',')}));
commit;`, 'aggregate synthetic fixture counts');
  let raw; try { raw = JSON.parse(result.stdout.trim()); } catch { throw new Error('Synthetic fixture counts must return one safe JSON result'); }
  assert.ok(raw && typeof raw === 'object' && !Array.isArray(raw));
  for (const [key, expected] of Object.entries({ authRows: 8, legacySourceRows: 12, signatureRows: 1 }))
    assert.equal(raw[key], expected, 'Synthetic fixture count differs');
  const expectedRows = { patients: 6, encounters: 3, preanesthetic_assessments: 93,
    anesthesia_records: 167, recovery_records: 143, consents: 53, addenda: 2, appointments: 0 };
  assert.ok(raw.tableRows && typeof raw.tableRows === 'object' && !Array.isArray(raw.tableRows));
  assert.deepEqual(Object.keys(raw.tableRows).sort(), tables.toSorted());
  for (const [name, expected] of Object.entries(expectedRows)) assert.equal(raw.tableRows[name], expected, 'Synthetic canonical fixture count differs');
  return { authRows: raw.authRows, legacySourceRows: raw.legacySourceRows, signatureRows: raw.signatureRows,
    canonicalClinicalRows: Object.values(expectedRows).reduce((sum, count) => sum + count, 0),
    tableRows: { ...expectedRows }, scope: 'declared-historical-and-legacy-synthetic-fixtures', productionMutated: false };
}

const pairs = [
  { first: 'LEGACY PROVENANCE RACE SESSION A', second: 'LEGACY PROVENANCE RACE SESSION B',
    held: 'LEGACY_IDENTITY_A_UNCOMMITTED', completed: 'LEGACY_IDENTITY_B_BLOCKED', waiter: 'soft-as-legacy-identity-b' },
  { first: 'NORMAL PATIENT RACE SESSION C', second: 'NORMAL PATIENT RACE SESSION D',
    held: 'NORMAL_IDENTITY_C_UNCOMMITTED', completed: 'NORMAL_IDENTITY_D_BLOCKED', waiter: 'soft-as-normal-identity-d' },
  { first: 'OWNER PROVENANCE RACE SESSION E', second: 'OWNER PROVENANCE RACE SESSION F',
    held: 'OWNER_PROVENANCE_E_UNCOMMITTED', completed: 'OWNER_PROVENANCE_F_BLOCKED', waiter: 'soft-as-owner-provenance-f' }
];

function barrierSql(waiter) {
  assert.ok(pairs.some(pair => pair.waiter === waiter), 'Unreviewed legacy race waiter');
  return `reset role;
do $legacy_barrier$
declare observed boolean:=false;
begin
 for attempt in 1..200 loop
  perform pg_stat_clear_snapshot();
  select exists(
   select 1 from pg_locks waiting
   join pg_locks held on held.locktype=waiting.locktype
    and held.database is not distinct from waiting.database
    and held.classid=waiting.classid and held.objid=waiting.objid and held.objsubid=waiting.objsubid
   join pg_stat_activity activity on activity.pid=waiting.pid
   where waiting.locktype='advisory' and not waiting.granted and held.granted
    and held.pid=pg_backend_pid() and activity.application_name='${waiter}'
  ) into observed;
  exit when observed;
  perform pg_sleep(0.05);
 end loop;
 if observed is distinct from true then raise exception 'Legacy concurrent writer never waited on the held advisory lock'; end if;
end $legacy_barrier$;
\\echo LEGACY_PROVENANCE_OBSERVED_WAIT
commit;
\\q
`;
}

export async function runConcurrentLegacyProvenance(db, fixture, assertCommandSuccess) {
  assert.equal(typeof assertCommandSuccess, 'function', 'A safe SQL result validator is required');
  const sections = fixture.race.sections;
  await db.run(sections['LEGACY PROVENANCE RACE PREPARE'].sql, 'synthetic legacy race preparation');
  const isolationResult = await db.run(sections['LEGACY PROVENANCE REPEATABLE READ VERIFY'].sql, 'legacy repeatable read denial');
  const isolation = safeResult(isolationResult.stdout, 'legacyIdentityIsolation', {
    repeatableReadRejected: true, unchangedHistoricalIdentityPreserved: true });
  let observedLocks = 0;
  for (const pair of pairs) {
    const firstSql = sections[pair.first].sql, secondSql = sections[pair.second].sql;
    let first, second;
    try {
      first = await db.open(firstSql);
      await first.waitFor(pair.held);
      second = await db.open(secondSql);
      second.end();
      const barrier = barrierSql(pair.waiter);
      first.end(barrier);
      const [firstResult, secondResult] = await Promise.all([first.done, second.done]);
      assertCommandSuccess(secondResult, 'legacy concurrent second session', secondSql);
      assertCommandSuccess(firstResult, 'legacy concurrent first session', firstSql + barrier);
      assert.ok(firstResult.stdout.includes('LEGACY_PROVENANCE_OBSERVED_WAIT'), 'Legacy concurrency barrier was not observed');
      assert.ok(secondResult.stdout.includes(pair.completed), 'Legacy concurrent second session did not finish its reviewed assertion');
      observedLocks++;
    } finally {
      first?.kill(); second?.kill();
      await Promise.allSettled([first?.done, second?.done].filter(Boolean));
    }
  }
  const verified = await db.run(sections['LEGACY PROVENANCE RACE VERIFY'].sql, 'legacy concurrent identity and owner invariants');
  const outcome = safeResult(verified.stdout, 'legacyIdentityRace', { passed: true, twoAuthenticatedProgrammers: true,
    legacyIdentityCommitted: 1, legacySourceBlocked: 1, twoAuthenticatedNormalWriters: true,
    normalIdentityCommitted: 1, normalWriterRejected: 1, twoConcurrentOwnerStatements: true,
    ownerCohortsAccepted: 1, contradictoryOwnerCohortsRejected: 1, originalSourcesPreserved: true });
  assert.equal(observedLocks, 3, 'All three legacy concurrency barriers must be observed');
  return { ...outcome, ...isolation, observedAdvisoryWaits: observedLocks,
    sourcePath: fixture.race.path, sourceSha256: fixture.race.sha256,
    extractedPhaseSha256: Object.fromEntries(Object.entries(sections).map(([name, value]) => [name, value.sha256])),
    productionMutated: false, broaderDeadlockFreedomVerified: false };
}
