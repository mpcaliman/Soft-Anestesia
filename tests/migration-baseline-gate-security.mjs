import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertMigrationBaselineState, assertPublicationDispatch } from '../scripts/migration-baseline-gate.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const current = JSON.parse(await readFile(join(repository, 'database/migration-baseline.json'), 'utf8'));
assertMigrationBaselineState(current);
const blocked = { ...structuredClone(current), status: 'blocked_pending_staging_reconciliation', remoteApplyAllowed: false };
delete blocked.stagingEvidence;
const verified = { ...structuredClone(blocked), status: 'staging_verified', remoteApplyAllowed: true,
  stagingEvidence: { matrixPassed: true, authenticatedSessionsPassed: true,
    schemaHash: 'a'.repeat(64), workflowUrl: 'https://github.com/mpcaliman/Soft-Anestesia/actions/runs/123456' } };

for (const purpose of ['integrity', 'local-sql']) {
  assert.equal(assertMigrationBaselineState(blocked, { purpose }).stagingVerified, false);
  assert.equal(assertMigrationBaselineState(verified, { purpose }).stagingVerified, true);
}
assert.equal(assertMigrationBaselineState(verified, { purpose: 'publication' }).stagingVerified, true);
assert.throws(() => assertMigrationBaselineState(blocked, { purpose: 'publication' }));
assert.throws(() => assertMigrationBaselineState(verified, { purpose: 'remote-sql' }));
assert.ok(Object.isFrozen(assertMigrationBaselineState(verified)));

for (const mutate of [
  x => { x.schema = 2; }, x => { x.status = 'approved'; },
  x => { x.status = 'blocked_pending_staging_reconciliation'; },
  x => { x.remoteApplyAllowed = false; }, x => { x.remoteApplyAllowed = 'true'; },
  x => { delete x.stagingEvidence; }, x => { x.stagingEvidence = []; },
  x => { x.stagingEvidence.matrixPassed = false; }, x => { x.stagingEvidence.matrixPassed = 'true'; },
  x => { x.stagingEvidence.authenticatedSessionsPassed = false; },
  x => { x.stagingEvidence.authenticatedSessionsPassed = 'true'; },
  x => { x.stagingEvidence.schemaHash = 'present'; },
  x => { x.stagingEvidence.schemaHash = 'A'.repeat(64); },
  x => { x.stagingEvidence.workflowUrl = 'https://github.com/other/repo/actions/runs/123456'; },
  x => { x.stagingEvidence.workflowUrl += '?redirect=elsewhere'; },
  x => { x.stagingEvidence.workflowUrl = 'https://github.com/mpcaliman/Soft-Anestesia/actions/runs/0'; }
]) {
  const invalid = structuredClone(verified); mutate(invalid);
  for (const purpose of ['integrity', 'local-sql', 'publication']) {
    assert.throws(() => assertMigrationBaselineState(invalid, { purpose }));
  }
}
for (const value of [true, 'false', undefined, null]) {
  assert.throws(() => assertMigrationBaselineState({ ...blocked, remoteApplyAllowed: value }));
}

const dispatch = { eventName: 'workflow_dispatch', ref: 'refs/heads/main', actor: 'mpcaliman',
  triggeringActor: 'mpcaliman', runAttempt: '1', repository: 'mpcaliman/Soft-Anestesia' };
assert.doesNotThrow(() => assertPublicationDispatch(dispatch));
for (const [key, value] of [
  ['eventName', 'push'], ['eventName', 'pull_request_target'], ['ref', 'refs/heads/codex/audit-remediation-v2'],
  ['actor', 'github-actions[bot]'], ['triggeringActor', 'another-user'], ['runAttempt', '2'],
  ['runAttempt', 1], ['repository', 'other/repo']
]) assert.throws(() => assertPublicationDispatch({ ...dispatch, [key]: value }));
for (const key of Object.keys(dispatch)) {
  const missing = { ...dispatch }; delete missing[key];
  assert.throws(() => assertPublicationDispatch(missing));
}

const pages = await readFile(join(repository, '.github/workflows/pages.yml'), 'utf8');
const publicationGuard = "    if: github.event_name == 'workflow_dispatch' && github.actor == 'mpcaliman' && github.triggering_actor == 'mpcaliman' && github.ref == 'refs/heads/main' && github.run_attempt == 1";
for (const job of ['build', 'deploy']) assert.ok(pages.includes(`  ${job}:\n${publicationGuard}\n`), `${job} deve recusar reexecução mesmo ao reaproveitar outro job`);
assert.match(pages, /assertPublicationDispatch\(\{ eventName: process\.env\.GITHUB_EVENT_NAME/);
assert.match(pages, /assertMigrationBaselineState\(baseline, \{ purpose: 'publication' \}\)/);
assert.doesNotMatch(pages, /baseline\.status !== 'staging_verified'/);

const shadow = await mkdtemp(join(tmpdir(), 'soft-baseline-state-'));
try {
  await Promise.all([
    cp(join(repository, 'database'), join(shadow, 'database'), { recursive: true }),
    cp(join(repository, 'supabase'), join(shadow, 'supabase'), { recursive: true }),
    cp(join(repository, 'tests/sql'), join(shadow, 'tests/sql'), { recursive: true }),
    cp(join(repository, '.github/workflows'), join(shadow, '.github/workflows'), { recursive: true })
  ]);
  await mkdir(join(shadow, 'scripts'));
  for (const name of ['migration-baseline-gate.mjs', 'historical-upgrade-fixture.mjs', 'legacy-upgrade-fixture.mjs',
    'run-local-sql-integration.mjs', 'validate-migrations.mjs','compare-application-catalog.mjs','capture-application-catalog.sql']) {
    await cp(join(repository, 'scripts', name), join(shadow, 'scripts', name));
  }
  await mkdir(join(shadow,'docs/engineering'),{recursive:true});
  await cp(join(repository,'docs/engineering/PRODUCTION-APPLICATION-CATALOG-2026-10-11.json'),
    join(shadow,'docs/engineering/PRODUCTION-APPLICATION-CATALOG-2026-10-11.json'));
  const runnerSource = await readFile(join(shadow, 'scripts/run-local-sql-integration.mjs'), 'utf8');
  assert.match(runnerSource, /assertMigrationBaselineState\(manifest, \{ purpose: 'local-sql' \}\)/);
  const validatorSource = await readFile(join(shadow, 'scripts/validate-migrations.mjs'), 'utf8');
  assert.match(validatorSource, /assertMigrationBaselineState\(manifest\)/);
  await cp(join(repository, 'tests/local-sql-integration-security.mjs'), join(shadow, 'tests/local-sql-integration-security.mjs'));
  const { loadMigrationPlan, runLocalSqlIntegration } = await import(pathToFileURL(join(shadow, 'scripts/run-local-sql-integration.mjs')));

  for (const [label, manifest] of [['blocked', blocked], ['verified', verified]]) {
    await writeFile(join(shadow, 'database/migration-baseline.json'), JSON.stringify(manifest));
    const plan = await loadMigrationPlan(shadow);
    const expectedCount = Object.keys(manifest.files).filter(path => /^database\/migrations\/\d{4}_.+\.sql$/.test(path)).length + 2;
    assert.equal(plan.length, expectedCount);
    await import(`${pathToFileURL(join(shadow, 'scripts/validate-migrations.mjs'))}?case=${label}`);
    await import(`${pathToFileURL(join(shadow, 'tests/local-sql-integration-security.mjs'))}?case=${label}`);
    console.log(`✓ ${label}: inventário completo/${expectedCount} migrações e suíte existente de isolamento passam`);
  }
  for (const manifest of [{ ...verified, remoteApplyAllowed: false }, { ...verified, stagingEvidence: {} }]) {
    await writeFile(join(shadow, 'database/migration-baseline.json'), JSON.stringify(manifest));
    let calls = 0;
    await assert.rejects(runLocalSqlIntegration({ repoDir: shadow, inheritedEnv: {}, execute: async () => { calls++; } }));
    assert.equal(calls, 0, 'Manifesto inválido não pode iniciar CLI/Docker');
  }
} finally { await rm(shadow, { recursive: true, force: true }); }
console.log('✓ baseline aprovada permanece testável localmente; publicação exige homologação e despacho novo real do proprietário');
