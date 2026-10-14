import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { catalogIdentity, compareCatalogs, stableJson } from './compare-application-catalog.mjs';
import { prepareProductionApplicationBaseline } from './prepare-production-application-baseline.mjs';
import { compareManagedSecurityDependencies, prepareManagedSecurityFixture } from './production-managed-security-fixture.mjs';
import { historicalFixtureEvidence, loadHistoricalUpgradeFixture } from './historical-upgrade-fixture.mjs';
import { captureSyntheticFixtureCounts, legacyFixtureEvidence, loadLegacyUpgradeFixture, runConcurrentLegacyProvenance } from './legacy-upgrade-fixture.mjs';
import { assertCommandSuccess, assertLocalDatabaseUrl, assertSafeEnvironment, createPsqlExecutor,
  isolatedConfig, loadMigrationPlan, reconciledPermissionFixtureEvidence, runConcurrentRetification,
  readPlatformMigrationCapabilityDiagnostics, safePlatformCapabilityDiagnostics, verifyPlatformMigrationCapabilities } from './run-local-sql-integration.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = 'docs/engineering/PRODUCTION-APPLICATION-CATALOG-2026-10-11.json';
const restorePath = 'docs/engineering/PRODUCTION-APPLICATION-BASELINE-2026-10-11.sql';
const manifestPath = 'docs/engineering/PRODUCTION-APPLICATION-BASELINE-2026-10-11.manifest.json';
const stagePath = 'docs/engineering/STAGING-APPLICATION-CATALOG-2026-10-11.json';
const hash = value => createHash('sha256').update(value).digest('hex');
const replayPhases = ['source-artifacts', 'empty-history', 'application-restore', 'managed-security-fixture',
  'supplementary-coverage', 'application-comparison', 'managed-security-comparison', 'record-free-baseline', 'managed-platform-migration-capabilities',
  'prerequisite-reconciliation', 'prerequisite-verification', 'application-upgrade', 'permission-reconciliation-verification',
  'historical-upgrade-seed','historical-upgrade-preservation','legacy-provenance-seed','legacy-provenance-preservation',
  'synthetic-fixture-counts','legacy-three-pair-observed-advisory-locks','upgrade-comparison', 'transaction-fixtures', 'concurrent-retification'];
const prerequisitePath = 'database/migrations/0013_cbhpm_2022.sql';

export function replayFailureDetails(error, fallbackOperation) {
  const operation = replayPhases.includes(error.replayPhase) ? error.replayPhase : fallbackOperation;
  const sqlState = /^[0-9A-Z]{5}$/.test(error.sqlState ?? '') ? error.sqlState : undefined;
  const migrationPath = error.migrationPath === prerequisitePath || /^database\/migrations\/00(?:1[89]|2\d|3[0-4])_[a-z0-9_]+\.sql$|^supabase\/migrations\/0002_assinaturas_hardening\.sql$/.test(error.migrationPath ?? '')
    ? error.migrationPath : undefined;
  const missingRelation = /^(?:public|app)\.[a-z_][a-z0-9_]{0,62}$/.test(error.missingRelation ?? '') ? error.missingRelation : undefined;
  const sourceLine = Number.isInteger(error.sourceLine) && error.sourceLine > 0 && error.sourceLine <= 1000000 ? error.sourceLine : undefined;
  const platformPrerequisite = ['postgres-role','supabase-admin-default-privileges','extension-schema-create',
    'required-extension-inventory','extension-owner','storage-policy-owner','realtime-publication-owner'].includes(error.platformPrerequisite)
    ? error.platformPrerequisite : undefined;
  const assertionCode = error.catalogDifference ? 'CATALOG_DIFFERENCE' : error.code === 'ERR_ASSERTION' ? 'NODE_ASSERTION' : error.assertion ? 'SQL_RAISE' : undefined;
  return { operation, ...(sqlState ? { sqlState } : {}), ...(migrationPath ? { migrationPath } : {}),
    ...(missingRelation ? { missingRelation } : {}), ...(sourceLine ? { sourceLine } : {}),
    ...(platformPrerequisite ? {platformPrerequisite} : {}),
    ...(assertionCode ? { assertionCode } : {}), ...(error.catalogDifference ? {
      changedObjects: error.catalogDifference.changes.length, comparisonCounts: error.catalogDifference.counts } : {}) };
}

export function verifyCbhpmPrerequisite(before, after, reference) {
  assert.ok(!before.catalog.relations.some(x => x.schema === 'public' && x.name === 'cbhpm_codigos'),
    'The prerequisite must be identified as absent before reconciliation');
  const relation = after.catalog.relations.find(x => x.schema === 'public' && x.name === 'cbhpm_codigos');
  assert.ok(relation); assert.equal(relation.kind, 'r'); assert.equal(relation.rls, true); assert.equal(relation.force_rls, false);
  assert.equal(relation.owner, 'postgres', 'Verified production migration role must own the table created by the original SQL');
  assert.equal(after.catalog.columns.filter(x => x.schema === 'public' && x.relation === 'cbhpm_codigos').length, 23);
  const policy = after.catalog.policies.find(x => x.schema === 'public' && x.relation === 'cbhpm_codigos');
  assert.ok(policy); assert.equal(policy.name, 'cbhpm_sel'); assert.equal(policy.command, 'SELECT');
  assert.deepEqual(policy.roles, ['authenticated']); assert.equal(policy.using_expression, 'true');
  const delta = compareCatalogs(before, after, { applicationOnly: true });
  const permittedCategory = ['relations', 'columns', 'constraints', 'indexes', 'policies', 'effective_grants'];
  for (const change of delta.changes) {
    assert.equal(change.status, 'added', 'Prerequisite may not change/remove an existing captured object');
    const row = after.catalog[change.category]?.find(x => change.identity === catalogIdentity(change.category, x));
    assert.ok(row && permittedCategory.includes(change.category), 'Unexpected prerequisite metadata category');
    assert.equal(row.schema, 'public');
    if (change.category === 'indexes' && row.relation === 'finance_entries') {
      assert.ok(['idx_fin_origem', 'idx_fin_cbhpm'].includes(row.name), 'Unreviewed financial index');
    } else assert.equal(['relations','effective_grants'].includes(change.category) ? row.name : row.relation, 'cbhpm_codigos',
      'Prerequisite must not add unrelated application objects');
  }
  for (const [category, count] of Object.entries({ relations: 1, columns: 23, constraints: 2, indexes: 7, policies: 1 }))
    assert.equal(delta.counts[category].added, count, 'Original CBHPM prerequisite object inventory differs');
  assert.deepEqual(after.catalog.indexes.filter(x => x.schema === 'public' && x.relation === 'cbhpm_codigos').map(x => x.name).sort(),
    ['cbhpm_codigos_codigo_numerico_key','cbhpm_codigos_pkey','idx_cbhpm_codigo_numerico','idx_cbhpm_descricao_lower','idx_cbhpm_selecionavel']);
  const scopedRows = (document, category) => document.catalog[category].filter(x => x.schema === 'public' &&
    (x.relation === 'cbhpm_codigos' || category === 'indexes' && x.relation === 'finance_entries' && ['idx_fin_origem','idx_fin_cbhpm'].includes(x.name)))
    .map(x => { const row = {...x}; if (category === 'columns') delete row.acl; return row; })
    .sort((a,b)=>catalogIdentity(category,a).localeCompare(catalogIdentity(category,b)));
  for (const category of ['columns','constraints','indexes','policies'])
    assert.equal(stableJson(scopedRows(after,category)),stableJson(scopedRows(reference,category)), 'Original CBHPM prerequisite structure differs from its verified reference');
  // The captured defaults contain broad permissions. Reconstruct that exact
  // intermediate contract instead of mistaking a SELECT policy for an ACL.
  const defaults = before.catalog.default_privileges.find(x=>x.owner==='postgres'&&x.schema==='public'&&x.object_type==='r');
  assert.ok(defaults && typeof defaults.acl==='string');
  const codePrivileges = {a:'INSERT',r:'SELECT',w:'UPDATE',d:'DELETE',D:'TRUNCATE',x:'REFERENCES',t:'TRIGGER',m:'MAINTAIN'};
  const inherited = new Map(Object.values(codePrivileges).map(privilege=>['postgres|'+privilege,{grantee:'postgres',privilege,grantable:false}]));
  for (const entry of defaults.acl.slice(1,-1).split(',')) {
    const parts=entry.match(/^([a-z_][a-z0-9_]*)=([arwdDxtm*]+)\/postgres$/);
    assert.ok(parts,'Unreviewed CBHPM default privilege syntax');
    for (let i=0;i<parts[2].length;i++) {
      const privilege=codePrivileges[parts[2][i]]; assert.ok(privilege);
      const grantable=parts[2][i+1]==='*'; if(grantable)i++;
      inherited.set(parts[1]+'|'+privilege,{grantee:parts[1],privilege,grantable});
    }
  }
  if(!inherited.has('authenticated|SELECT'))inherited.set('authenticated|SELECT',{grantee:'authenticated',privilege:'SELECT',grantable:false});
  const expectedGrants=[...inherited.values()].map(x=>({kind:'relation',schema:'public',relation:null,name:'cbhpm_codigos',arguments:null,grantor:'postgres',...x}));
  const sortedGrants=rows=>rows.sort((a,b)=>catalogIdentity('effective_grants',a).localeCompare(catalogIdentity('effective_grants',b)));
  assert.equal(stableJson(sortedGrants(after.catalog.effective_grants.filter(x=>x.schema==='public'&&x.name==='cbhpm_codigos'))),
    stableJson(sortedGrants(expectedGrants)), 'CBHPM grants must exactly inherit the captured defaults and original SELECT grant');
  return delta;
}

// This checks the declared 0033 delta rather than hiding historical staging
// differences. SQL probes separately verify inherited/effective permissions.
export function verifyReconciledPermissions(before, after) {
  const application = x => ['public','app'].includes(x.schema);
  const tables = new Map(after.catalog.relations.filter(x=>application(x)&&['r','p'].includes(x.kind))
    .map(x=>[x.schema+'.'+x.name,x]));
  for (const row of [...after.catalog.relations,...after.catalog.functions].filter(application))
    assert.equal(row.owner,'postgres','Canonical postgres migration ownership differs');
  const grants = after.catalog.effective_grants.filter(application);
  const supplierDefaults = document => document.catalog.default_privileges.filter(x=>x.owner==='supabase_admin')
    .sort((a,b)=>catalogIdentity('default_privileges',a).localeCompare(catalogIdentity('default_privileges',b)));
  assert.equal(stableJson(supplierDefaults(before)),stableJson(supplierDefaults(after)),
    'Supplier default privileges must remain exactly unchanged');
  assert.ok(!grants.some(x=>x.grantable&&['PUBLIC','anon','authenticated','service_role'].includes(x.grantee)),
    'Application client/service grant option remains');
  assert.ok(!grants.some(x=>x.kind==='relation'&&tables.has(x.schema+'.'+x.name)&&x.privilege==='TRUNCATE'
    &&['PUBLIC','anon','authenticated','service_role'].includes(x.grantee)), 'Application TRUNCATE grant remains');
  assert.ok(!grants.some(x=>x.kind==='sequence'&&x.schema==='public'&&x.name==='documentos_id_seq'
    &&['PUBLIC','anon','authenticated'].includes(x.grantee)), 'Legacy sequence client grant remains');
  assert.ok(!grants.some(x=>x.kind==='relation'&&x.schema==='public'&&['documentos','pacientes'].includes(x.name)
    &&['PUBLIC','anon','authenticated'].includes(x.grantee)), 'Legacy clinical table client grant remains');
  assert.ok(!grants.some(x=>x.kind==='function'&&x.schema==='public'&&x.name==='prog_read_legacy_documents'
    &&x.privilege==='EXECUTE'&&['PUBLIC','anon','authenticated'].includes(x.grantee)), 'Legacy raw RPC client grant remains');
  assert.ok(!grants.some(x=>x.kind==='function'&&x.schema==='public'&&x.name==='criar_minha_organizacao'
    &&x.privilege==='EXECUTE'&&['PUBLIC','anon','authenticated','service_role'].includes(x.grantee)),
    'Self-provisioning RPC remains exposed');
  const capabilities = document => new Set(document.catalog.effective_grants.filter(x=>application(x)
    &&x.kind==='relation'&&x.grantee==='service_role'&&['SELECT','INSERT','UPDATE','DELETE'].includes(x.privilege))
    .map(x=>stableJson({schema:x.schema,name:x.name,privilege:x.privilege})));
  const prior = capabilities(before), current = capabilities(after);
  for (const capability of prior) assert.ok(current.has(capability),'Existing service CRUD capability was removed');
  for (const capability of current) if(JSON.parse(capability).privilege==='DELETE')
    assert.ok(prior.has(capability),'Reconciliation must not add service DELETE');
  return { verified:true, canonicalMigrationOwner:'postgres', applicationTables:tables.size,
    applicationTruncateGrants:0, legacySequenceClientGrants:0, legacyTableClientGrants:0, legacyRawRpcClientGrants:0,
    selfProvisioningRpcClientOrServiceGrants:0,
    existingServiceCrudPreserved:true, serviceCrudBefore:prior.size, serviceCrudAfter:current.size,
    applicationExecutorDefaultsClosureRequiresSQLProbes:true,supplierDefaultPrivilegesClosed:false,
    supplierDefaultsPreserved:true,supplierDefaultPrivilegesPending:true,
    additionalServiceDeleteGrants:0, inheritedAndFuturePermissionsVerifiedBy:'tests/sql/reconciled-permissions-security.sql' };
}

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
  let phase = 'source-artifacts', migrationPath, initialPlatformMigrationCapabilityDiagnostics;
  try {
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
  phase = 'empty-history';
  await db.run(`create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations(version text primary key,statements text[],name text);`, 'empty local migration metadata fixture');
  const originalHistory = (await snapshot()).catalog.migration_history;
  assert.deepEqual(originalHistory, [], 'Reference database must have no application migration history');
  initialPlatformMigrationCapabilityDiagnostics=await readPlatformMigrationCapabilityDiagnostics(db);
  phase = 'application-restore';
  await db.run(`set application_name='soft_as_production_baseline_replay';\n${storedRestore}`, 'captured production application restore');
  phase = 'managed-security-fixture';
  const preFixture = await snapshot();
  const managedFixture = prepareManagedSecurityFixture(source, preFixture);
  await db.run(managedFixture.query, 'isolated managed Storage security fixture');
  const restored = await snapshot();
  // Revalidate the platform-only extras after mutation, rather than hiding
  // unknown/new tables or authorization drift behind a comparison filter.
  prepareManagedSecurityFixture(source, restored);
  phase = 'supplementary-coverage';
  const coverageSql = await readFile(join(repoDir, 'scripts/check-application-catalog-coverage.sql'), 'utf8');
  const localCoverage = await db.run(`select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) from (${coverageSql.replace(/^--.*$/gm,'').trim().replace(/;$/,'')}) q;`, 'supplementary application coverage');
  const coverageOrder = (a,b) => a.check_name.localeCompare(b.check_name);
  assert.deepEqual(JSON.parse(localCoverage.stdout.trim()).sort(coverageOrder), [...extraCoverage.checks].sort(coverageOrder),
    'Supplementary application dependency coverage differs');
  phase = 'application-comparison';
  const baselineComparison = compareCatalogs(source, restored, { applicationOnly: true });
  if (!baselineComparison.equal) {
    const error = new Error(`Restored application differs from captured production in ${baselineComparison.changes.length} objects`);
    error.catalogDifference = baselineComparison; error.comparisonKind = 'baselineComparison'; throw error;
  }
  phase = 'managed-security-comparison';
  const managedSecurityComparison = compareManagedSecurityDependencies(source, restored);
  if (!managedSecurityComparison.equal) {
    const error = new Error('Managed Auth/Storage/extension schema authorization differs from captured prerequisites');
    error.catalogDifference = managedSecurityComparison; error.comparisonKind = 'managedSecurityComparison'; throw error;
  }
  phase = 'record-free-baseline';
  await db.run(`do $empty$ declare r record; n bigint; begin
 if exists(select 1 from auth.users) or exists(select 1 from storage.objects) then raise exception 'Reference platform must remain record-free'; end if;
 for r in select n.nspname,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','app') and c.relkind in ('r','p') loop
  execute format('select count(*) from %I.%I',r.nspname,r.relname) into n;
  if n<>0 then raise exception 'Reference application must remain record-free'; end if;
 end loop; end $empty$;`, 'record-free captured baseline');
  const allMigrations = await loadMigrationPlan(repoDir);
  const historicalFixture=await loadHistoricalUpgradeFixture(repoDir);
  const legacyFixture=await loadLegacyUpgradeFixture(repoDir);
  assert.equal(typeof db.runMigrationAsPostgres, 'function', 'A verified postgres-role migration executor is required');
  phase = 'managed-platform-migration-capabilities';
  const platformMigrationCapabilities=await verifyPlatformMigrationCapabilities(db);
  const prerequisite = allMigrations.find(x => x.path === prerequisitePath);
  assert.ok(prerequisite, 'The original verified CBHPM migration is required');
  // The exact captured baseline comparison precedes this declared additive
  // prerequisite. It is not presented as part of the original production schema.
  phase = 'prerequisite-reconciliation'; migrationPath = prerequisite.path;
  await db.runMigrationAsPostgres(prerequisite.sql, prerequisite.path);
  phase = 'prerequisite-verification'; migrationPath = undefined;
  const reconciled = await snapshot();
  const prerequisiteComparison = verifyCbhpmPrerequisite(restored, reconciled, expectedStage);
  await db.run(`do $reference_guard$ begin
 if exists(select 1 from public.cbhpm_codigos) then raise exception 'CBHPM prerequisite must remain unseeded'; end if;
 end $reference_guard$;`, 'unseeded CBHPM prerequisite');
  assert.deepEqual(reconciled.catalog.migration_history, originalHistory, 'Prerequisite must not rewrite formal history');
  phase='historical-upgrade-seed';
  await db.run(historicalFixture.seed.sql,'synthetic historical pre0018 seed');
  const plan = allMigrations.filter(x => x.path.startsWith('database/migrations/') && Number(x.path.split('/').at(-1).slice(0, 4)) >= 18
    || x.path === 'supabase/migrations/0002_assinaturas_hardening.sql');
  // 0035 entrou depois da 0034: ela acrescenta os exames em série à allowlist
  // clínica da retificação. O ensaio cobre de 0018 em diante, então cresce com ela.
  assert.equal(plan.length, 20, 'Exactly 0018–0036 and signature hardening must be rehearsed');
  // psql --file executes each top-level command in autocommit. The original
  // transaction-free 0026 therefore exercises CONCURRENTLY without rewriting it.
  phase = 'application-upgrade';
  let permissionReconciliation, historicalUpgrade;
  for (const entry of plan) {
    if(entry.path.startsWith('database/migrations/0034_')) {
      phase='historical-upgrade-preservation';migrationPath=undefined;
      const historicalResult=await db.run(historicalFixture.verify.sql,'synthetic historical upgrade verification');
      historicalUpgrade=historicalFixtureEvidence(historicalResult.stdout,historicalFixture);
      phase='legacy-provenance-seed';
      await db.run(legacyFixture.seed.sql,'synthetic legacy pre0034 seed');
      phase='application-upgrade';
    }
    const isReconciliation = /^database\/migrations\/0033_[a-z0-9_]+\.sql$/.test(entry.path);
    const beforePermissions = isReconciliation ? await snapshot() : undefined;
    migrationPath = entry.path;
    await db.runMigrationAsPostgres(entry.sql, entry.path);
    if(isReconciliation) {
      phase = 'permission-reconciliation-verification';
      permissionReconciliation = verifyReconciledPermissions(beforePermissions,await snapshot());
      phase = 'application-upgrade';
    }
  }
  assert.ok(permissionReconciliation?.verified,'The append-only permission reconciliation must be verified');
  assert.equal(historicalUpgrade?.verified,true,'Historical upgrade must be verified before the additive legacy seed');
  phase='legacy-provenance-preservation';migrationPath=undefined;
  const legacyResult=await db.run(legacyFixture.verify.sql,'synthetic legacy upgrade verification');
  const legacyProvenance=legacyFixtureEvidence(legacyResult.stdout,legacyFixture);
  phase='synthetic-fixture-counts';
  const beforeTransactionFixtureCounts=await captureSyntheticFixtureCounts(db);
  migrationPath = undefined; phase = 'upgrade-comparison';
  const upgraded = await snapshot();
  const cbhpmFinalGrants = upgraded.catalog.effective_grants.filter(x => x.schema === 'public' && x.name === 'cbhpm_codigos');
  assert.ok(!cbhpmFinalGrants.some(x => ['PUBLIC','anon'].includes(x.grantee)), 'CBHPM must deny anonymous/public client privileges after hardening');
  const authenticatedCbhpm = cbhpmFinalGrants.filter(x => x.grantee === 'authenticated');
  assert.equal(authenticatedCbhpm.length, 1); assert.equal(authenticatedCbhpm[0].privilege, 'SELECT');
  assert.equal(authenticatedCbhpm[0].grantable, false);
  assert.deepEqual(upgraded.catalog.migration_history, originalHistory, 'Replay must not repair/rewrite formal migration history');
  const stagingComparison = compareCatalogs(expectedStage, upgraded, { applicationOnly: true });
  // Preserve all real-source differences for review; no wildcard whitelist or
  // asserted staging equivalence. This reference includes retained documentos-pdf.
  const fixtures = ['tests/sql/retification-cas-security.sql', 'tests/sql/finalized-delete-security.sql',
    'tests/sql/reconciled-permissions-security.sql'];
  let reconciledPermissionProbes;
  phase = 'transaction-fixtures';
  for (const path of fixtures) {
    const sql = await readFile(join(repoDir, path), 'utf8');
    assert.match(sql, /^begin\b/im); assert.match(sql, /rollback;\s*$/i);
    const result=await db.run(sql, path);
    if(path==='tests/sql/reconciled-permissions-security.sql')
      reconciledPermissionProbes=reconciledPermissionFixtureEvidence(result.stdout,platformMigrationCapabilities);
  }
  assert.equal(reconciledPermissionProbes?.applicationExecutorDefaultPrivilegesClosed,true);
  permissionReconciliation.applicationExecutorDefaultPrivilegesClosed=true;
  permissionReconciliation.applicationExecutorDefaultsClosureRequiresSQLProbes=false;
  phase = 'concurrent-retification';
  const race = await runConcurrentRetification(db);
  phase='legacy-three-pair-observed-advisory-locks';
  const legacyConcurrency=await runConcurrentLegacyProvenance(db,legacyFixture,assertCommandSuccess);
  return { format: 1, baselineReplayVerified: true, productionCatalogCapturedAt: source.capturedAt,
    baselineCatalogSha256: prepared.manifest.catalogSha256, baselineRestoreSqlSha256: hash(storedRestore),
    applicationDefinitionAndGrantsEquivalent: true, capturedManagedSecurityDependenciesEquivalent: true, applicationUpgradeVerified: true,
    managedSecurityFixture: { capturedStorageTables: managedFixture.capturedStorageTables,
      extraPlatformTables: managedFixture.extraPlatformTables, extraPlatformIsolationVerified: true,
      managedTableStructuresChanged: false, managedOwnersChanged: false,
      managedSecurityAdjustedLocally: true, productionApplied: false },
    prerequisiteReconciliation: { path: prerequisite.path, sha256: prerequisite.sha256,
      absentFromCapturedProduction: ['public.cbhpm_codigos'], requiredBy: 'database/migrations/0025_supabase_hardening.sql',
      originalSqlExecuted: true, seededRows: 0, verified: true, comparison: prerequisiteComparison,
      intermediateEffectiveGrants: reconciled.catalog.effective_grants.filter(x => x.schema === 'public' && x.name === 'cbhpm_codigos'),
      finalEffectiveGrants: cbhpmFinalGrants,
      productionApplied: false, migrationHistoryRewritten: false },
    migrationHashes: Object.fromEntries(plan.map(x => [x.path, x.sha256])), migrationsRehearsed: plan.length,
    migrationExecutionRole: 'postgres', migrationRoleGuardVerified: true, migrationSqlInputUnchanged: true,
    platformMigrationCapabilities,
    initialPlatformMigrationCapabilityDiagnostics,
    historicalUpgrade,
    legacyProvenance,legacyConcurrency,beforeTransactionFixtureCounts,
    permissionReconciliation,
    reconciledPermissionProbes,
    stagingReferenceCapturedAt: expectedStage.capturedAt, stagingReferenceIsHistorical: true,
    performanceIndexesAppliedConcurrently: true, sourceMigrationsChanged: false,
    migrationHistoryRewritten: false, beforeFixturesClinicalRows: beforeTransactionFixtureCounts.canonicalClinicalRows,
    beforeFixturesAuthRows: beforeTransactionFixtureCounts.authRows, baselineClinicalRows:0,baselineAuthRows:0,
    retainedPrivateBuckets: source.catalog.storage_buckets.map(x => x.id), fixtures, race,
    baselineComparison, managedSecurityComparison, stagingComparison, stagingCatalogEqual: stagingComparison.equal,
    hostedIntegrationVerified: false, productionVerified: false, productionApplyAllowed: false };
  } catch (error) {
    error.replayPhase = phase;
    if(initialPlatformMigrationCapabilityDiagnostics&&!error.platformCapabilityDiagnostics)
      error.platformCapabilityDiagnostics=initialPlatformMigrationCapabilityDiagnostics;
    if (migrationPath) error.migrationPath = migrationPath;
    throw error;
  }
}

export async function runProductionBaselineReplay({ repoDir = rootDir, inheritedEnv = process.env, run = execute } = {}) {
  assertSafeEnvironment(inheritedEnv);
  const cli = join(repoDir, 'node_modules/.bin/supabase'); await access(cli);
  const workdir = await mkdtemp(join(tmpdir(), 'soft-production-reference-'));
  const projectId = `soft-as-sql-${randomBytes(12).toString('hex')}`;
  const env = { PATH: inheritedEnv.PATH, HOME: inheritedEnv.HOME, TMPDIR: workdir, LANG: 'C.UTF-8',
    DOCKER_HOST: 'unix:///var/run/docker.sock', DOCKER_CONFIG: join(workdir, 'docker-config'),
    SUPABASE_HOME: join(workdir, 'supabase-home'),
    SUPABASE_SKIP_UPDATE_CHECK: 'true', SUPABASE_TELEMETRY_DISABLED: 'true' };
  let startAttempted = false, evidence = { format: 1, baselineReplayVerified: false,
    hostedIntegrationVerified: false, productionVerified: false, productionApplyAllowed: false };
  let failure, operation = 'prepare';
  const checked = async (command, args, label, options = {}) => {
    operation = label; return assertCommandSuccess(await run(command, args, { env, cwd: workdir, ...options }), label);
  };
  try {
    await mkdir(join(workdir, 'supabase')); await mkdir(env.DOCKER_CONFIG);
    await mkdir(env.SUPABASE_HOME, { mode: 0o700 });
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
    if(error.platformCapabilityDiagnostics)
      evidence.platformMigrationCapabilityDiagnostics=safePlatformCapabilityDiagnostics(error.platformCapabilityDiagnostics);
    if (error.catalogDifference && ['baselineComparison', 'managedSecurityComparison'].includes(error.comparisonKind)) evidence[error.comparisonKind] = error.catalogDifference;
    evidence.failure = replayFailureDetails(error, operation);
    failure = new Error(`Production reference replay failed at ${evidence.failure.operation}${evidence.failure.migrationPath ? ' ['+evidence.failure.migrationPath+']' : ''}${evidence.failure.sqlState ? ` (SQLSTATE ${evidence.failure.sqlState})` : ''}${evidence.failure.missingRelation ? ' [relation '+evidence.failure.missingRelation+']' : ''}${evidence.failure.sourceLine ? ' [source line '+evidence.failure.sourceLine+']' : ''}${evidence.failure.assertionCode ? ' ['+evidence.failure.assertionCode+']' : ''}; no remote verification claimed.`);
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
