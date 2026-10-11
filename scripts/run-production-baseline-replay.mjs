import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compareCatalogs } from './compare-application-catalog.mjs';
import { prepareProductionApplicationBaseline } from './prepare-production-application-baseline.mjs';
import { assertCommandSuccess, assertLocalDatabaseUrl, assertSafeEnvironment, createPsqlExecutor,
  isolatedConfig, loadMigrationPlan, runConcurrentRetification } from './run-local-sql-integration.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = 'docs/engineering/PRODUCTION-APPLICATION-CATALOG-2026-10-11.json';
const restorePath = 'docs/engineering/PRODUCTION-APPLICATION-BASELINE-2026-10-11.sql';
const manifestPath = 'docs/engineering/PRODUCTION-APPLICATION-BASELINE-2026-10-11.manifest.json';
const stagePath = 'docs/engineering/STAGING-APPLICATION-CATALOG-2026-10-11.json';
const hash = value => createHash('sha256').update(value).digest('hex');

async function execute(command, args, { env, cwd, timeoutMs = 120000, input } = {}) {
  const child = spawn(command, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  let stdout = '', stderr = '', bytes = 0;
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  for (const [stream, name] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
    stream.setEncoding('utf8');
    stream.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 16 * 1024 * 1024) child.kill('SIGKILL');
      if (name === 'stdout') stdout += chunk; else stderr += chunk;
    });
  }
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  return new Promise(resolveDone => {
    let settled = false;
    const finish = code => { if (settled) return; settled = true; clearTimeout(timer); resolveDone({ code, stdout, stderr }); };
    child.on('error', () => finish(-1)); child.on('close', code => finish(code ?? -1));
  });
}

export async function replayProductionBaseline(db, repoDir = rootDir) {
  const source = JSON.parse(await readFile(join(repoDir, sourcePath), 'utf8'));
  const extraCoverage = JSON.parse(await readFile(join(repoDir, 'docs/engineering/PRODUCTION-APPLICATION-COVERAGE-2026-10-11.json'), 'utf8'));
  assert.equal(extraCoverage.sourceProject, source.projectRef);
  assert.equal(extraCoverage.metadataOnly, true);
  assert.equal(extraCoverage.productionMutated, false);
  assert.equal(extraCoverage.checks.length, 7);
  for (const check of extraCoverage.checks) assert.equal(check.total, 0, 'Unsupported source application object');
  const expectedStage = JSON.parse(await readFile(join(repoDir, stagePath), 'utf8'));
  const prepared = prepareProductionApplicationBaseline(source);
  const storedRestore = await readFile(join(repoDir, restorePath), 'utf8');
  const storedManifest = JSON.parse(await readFile(join(repoDir, manifestPath), 'utf8'));
  assert.equal(prepared.query, storedRestore, 'Restore artifact must reproduce deterministically from the captured catalog');
  assert.equal(hash(storedRestore), storedManifest.restoreSqlSha256);
  assert.equal(prepared.manifest.catalogSha256, storedManifest.catalogSha256);
  const captureSql = await readFile(join(repoDir, 'scripts/capture-application-catalog.sql'), 'utf8');
  const snapshot = async () => {
    const result = await db.run(`begin read only;\n${captureSql}\ncommit;`, 'application metadata snapshot');
    return { format: 1, kind: 'supabase_application_catalog', projectRef: 'local-disposable',
      capturedAt: new Date().toISOString(), dataIncluded: false, secretValuesIncluded: false,
      catalog: JSON.parse(result.stdout.trim()) };
  };
  // This empty platform fixture permits history metadata capture when the stock
  // local image does not create schema_migrations. No history rows are inserted.
  await db.run(`create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations(version text primary key,statements text[],name text);`, 'empty local migration metadata fixture');
  const originalHistory = (await snapshot()).catalog.migration_history;
  assert.deepEqual(originalHistory, [], 'Reference database must have no application migration history');
  await db.run(`set application_name='soft_as_production_baseline_replay';\n${storedRestore}`, 'captured production application restore');
  const restored = await snapshot();
  const coverageSql = await readFile(join(repoDir, 'scripts/check-application-catalog-coverage.sql'), 'utf8');
  const localCoverage = await db.run(`select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) from (${coverageSql.replace(/^--.*$/gm,'').trim().replace(/;$/,'')}) q;`, 'supplementary application coverage');
  const coverageOrder = (a,b) => a.check_name.localeCompare(b.check_name);
  assert.deepEqual(JSON.parse(localCoverage.stdout.trim()).sort(coverageOrder), [...extraCoverage.checks].sort(coverageOrder),
    'Supplementary application dependency coverage differs');
  const baselineComparison = compareCatalogs(source, restored, { applicationOnly: true });
  if (!baselineComparison.equal) {
    const error = new Error(`Restored application differs from captured production in ${baselineComparison.changes.length} objects`);
    error.catalogDifference = baselineComparison; throw error;
  }
  const managedSecurityDocument = document => {
    const copy = structuredClone(document);
    copy.catalog.schemas = copy.catalog.schemas.filter(x => ['auth', 'storage', 'extensions'].includes(x.schema));
    copy.catalog.effective_grants = copy.catalog.effective_grants.filter(x => ['auth', 'storage', 'extensions'].includes(x.schema));
    return copy;
  };
  const managedSecurityComparison = compareCatalogs(managedSecurityDocument(source), managedSecurityDocument(restored),
    { categories: ['schemas', 'effective_grants', 'storage_relation_security'] });
  if (!managedSecurityComparison.equal) {
    const error = new Error('Managed Auth/Storage/extension schema authorization differs from captured prerequisites');
    error.catalogDifference = managedSecurityComparison; throw error;
  }
  await db.run(`do $empty$ declare r record; n bigint; begin
 if exists(select 1 from auth.users) or exists(select 1 from storage.objects) then raise exception 'Reference platform must remain record-free'; end if;
 for r in select n.nspname,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','app') and c.relkind in ('r','p') loop
  execute format('select count(*) from %I.%I',r.nspname,r.relname) into n;
  if n<>0 then raise exception 'Reference application must remain record-free'; end if;
 end loop; end $empty$;`, 'record-free captured baseline');
  const plan = (await loadMigrationPlan(repoDir)).filter(x => x.path.startsWith('database/migrations/') && Number(x.path.split('/').at(-1).slice(0, 4)) >= 18
    || x.path === 'supabase/migrations/0002_assinaturas_hardening.sql');
  assert.equal(plan.length, 16, 'Exactly 0018–0032 and signature hardening must be rehearsed');
  // psql --file executes each top-level command in autocommit. The original
  // transaction-free 0026 therefore exercises CONCURRENTLY without rewriting it.
  for (const entry of plan) await db.run(entry.sql, entry.path);
  const upgraded = await snapshot();
  assert.deepEqual(upgraded.catalog.migration_history, originalHistory, 'Replay must not repair/rewrite formal migration history');
  const stagingComparison = compareCatalogs(expectedStage, upgraded, { applicationOnly: true });
  // Preserve all real-source differences for review; no wildcard whitelist or
  // asserted staging equivalence. This reference includes retained documentos-pdf.
  const fixtures = ['tests/sql/retification-cas-security.sql', 'tests/sql/finalized-delete-security.sql'];
  for (const path of fixtures) {
    const sql = await readFile(join(repoDir, path), 'utf8');
    assert.match(sql, /^begin\b/im); assert.match(sql, /rollback;\s*$/i);
    await db.run(sql, path);
  }
  const race = await runConcurrentRetification(db);
  return { format: 1, baselineReplayVerified: true, productionCatalogCapturedAt: source.capturedAt,
    baselineCatalogSha256: prepared.manifest.catalogSha256, baselineRestoreSqlSha256: hash(storedRestore),
    applicationDefinitionAndGrantsEquivalent: true, managedSecurityDependenciesEquivalent: true, applicationUpgradeVerified: true,
    migrationHashes: Object.fromEntries(plan.map(x => [x.path, x.sha256])), migrationsRehearsed: plan.length,
    performanceIndexesAppliedConcurrently: true, sourceMigrationsChanged: false,
    migrationHistoryRewritten: false, beforeFixturesClinicalRows: 0, beforeFixturesAuthRows: 0,
    retainedPrivateBuckets: source.catalog.storage_buckets.map(x => x.id), fixtures, race,
    baselineComparison, managedSecurityComparison, stagingComparison, stagingCatalogEqual: stagingComparison.equal,
    hostedIntegrationVerified: false, productionVerified: false, productionApplyAllowed: false };
}

export async function runProductionBaselineReplay({ repoDir = rootDir, inheritedEnv = process.env, run = execute } = {}) {
  assertSafeEnvironment(inheritedEnv);
  const cli = join(repoDir, 'node_modules/.bin/supabase'); await access(cli);
  const workdir = await mkdtemp(join(tmpdir(), 'soft-production-reference-'));
  const projectId = `soft-as-sql-${randomBytes(12).toString('hex')}`;
  const env = { PATH: inheritedEnv.PATH, HOME: inheritedEnv.HOME, TMPDIR: workdir, LANG: 'C.UTF-8',
    DOCKER_HOST: 'unix:///var/run/docker.sock', DOCKER_CONFIG: join(workdir, 'docker-config'),
    SUPABASE_SKIP_UPDATE_CHECK: 'true', SUPABASE_TELEMETRY_DISABLED: 'true' };
  let startAttempted = false, evidence = { format: 1, baselineReplayVerified: false,
    hostedIntegrationVerified: false, productionVerified: false, productionApplyAllowed: false };
  let failure, operation = 'prepare';
  const checked = async (command, args, label, options = {}) => {
    operation = label; return assertCommandSuccess(await run(command, args, { env, cwd: workdir, ...options }), label);
  };
  try {
    await mkdir(join(workdir, 'supabase')); await mkdir(env.DOCKER_CONFIG);
    await writeFile(join(workdir, 'supabase/config.toml'), isolatedConfig(projectId), { mode: 0o600 });
    assert.equal((await checked(cli, ['--version'], 'CLI version')).stdout.trim(), '2.119.0');
    const help = (await checked(cli, ['--help'], 'CLI help')).stdout;
    assert.ok(help.includes('--workdir'));
    for (const name of ['start', 'status', 'stop']) await checked(cli, [name, '--help'], `CLI ${name} help`);
    await checked('docker', ['info', '--format', '{{.ServerVersion}}'], 'local Docker');
    startAttempted = true;
    await checked(cli, ['start', '--workdir', workdir], 'local platform startup', { timeoutMs: 12 * 60 * 1000 });
    const status = JSON.parse((await checked(cli, ['status', '--workdir', workdir, '--output', 'json'], 'local status')).stdout);
    assertLocalDatabaseUrl(status.DB_URL);
    const inspection = JSON.parse((await checked('docker', ['inspect', '--type', 'container', `supabase_db_${projectId}`], 'local container identity')).stdout);
    const db = createPsqlExecutor({ status, inspection, projectId, inheritedEnv, env, cwd: workdir, execute: run });
    operation = 'captured production baseline restore and upgrade';
    evidence = await replayProductionBaseline(db, repoDir);
  } catch (error) {
    evidence.baselineReplayVerified = false;
    if (error.catalogDifference) evidence.baselineComparison = error.catalogDifference;
    const sqlState = /^[0-9A-Z]{5}$/.test(error.sqlState ?? '') ? error.sqlState : undefined;
    evidence.failure = { operation, ...(sqlState ? { sqlState } : {}) };
    failure = new Error(`Production reference replay failed at ${operation}${sqlState ? ` (SQLSTATE ${sqlState})` : ''}; no remote verification claimed.`);
  } finally {
    if (startAttempted) {
      try {
        await checked(cli, ['stop', '--workdir', workdir, '--no-backup'], 'exclusive reference cleanup', { timeoutMs: 90000 });
        evidence.ephemeralCleanupVerified = true;
      } catch {
        evidence.baselineReplayVerified = false; evidence.ephemeralCleanupVerified = false;
        failure = new Error('Production reference ephemeral cleanup failed.');
      }
    }
    await rm(workdir, { recursive: true, force: true });
    await mkdir(join(repoDir, 'artifacts'), { recursive: true });
    await writeFile(join(repoDir, 'artifacts/production-baseline-replay-evidence.json'), JSON.stringify(evidence, null, 2)+'\n', { mode: 0o600 });
  }
  if (failure) throw failure;
  return evidence;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) throw new Error('Reference executor accepts no target arguments');
  runProductionBaselineReplay().then(evidence => console.log(`Production application baseline replay: ${evidence.migrationsRehearsed} upgrades; Auth/Storage platform dependencies; production untouched.`))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
