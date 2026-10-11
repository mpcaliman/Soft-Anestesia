import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compareCatalogs, validateCatalog } from '../scripts/compare-application-catalog.mjs';
import { prepareProductionApplicationBaseline } from '../scripts/prepare-production-application-baseline.mjs';
import { replayFailureDetails, replayProductionBaseline, runProductionBaselineReplay } from '../scripts/run-production-baseline-replay.mjs';
import { compareManagedSecurityDependencies, prepareManagedSecurityFixture } from '../scripts/production-managed-security-fixture.mjs';

const read = path => readFile(new URL('../'+path, import.meta.url), 'utf8');
const source = JSON.parse(await read('docs/engineering/PRODUCTION-APPLICATION-CATALOG-2026-10-11.json'));
const extraCoverage = JSON.parse(await read('docs/engineering/PRODUCTION-APPLICATION-COVERAGE-2026-10-11.json'));
assert.equal(extraCoverage.metadataOnly,true);
assert.equal(extraCoverage.checks.length,7);
assert.ok(extraCoverage.checks.every(x=>x.total===0));
const stage = JSON.parse(await read('docs/engineering/STAGING-APPLICATION-CATALOG-2026-10-11.json'));
const generated = prepareProductionApplicationBaseline(source);
assert.equal(generated.query, await read('docs/engineering/PRODUCTION-APPLICATION-BASELINE-2026-10-11.sql'));
const manifest = JSON.parse(await read('docs/engineering/PRODUCTION-APPLICATION-BASELINE-2026-10-11.manifest.json'));
assert.equal(generated.manifest.restoreSqlSha256, manifest.restoreSqlSha256);
assert.equal(generated.manifest.catalogSha256, manifest.catalogSha256);
assert.equal(manifest.restoreVerified, false, 'A generated artifact must not claim an unexecuted PostgreSQL replay');
assert.equal(manifest.productionApplyAllowed, false);
assert.equal(manifest.authStorageManagedDDLIncluded, false);
assert.equal(manifest.migrationHistoryRewritten, false);
let topLevelSql = generated.query;
// Stored administrative functions contain their historical Auth operations;
// restoring their definition does not invoke them. Check executable top level.
for (const routine of source.catalog.functions) topLevelSql = topLevelSql.replace(routine.definition.trim().replace(/;?$/, ';'), '');
assert.ok(!/(?:create|alter|drop)\s+table\s+(?:"?auth"?\.|"?storage"?\.)/i.test(topLevelSql));
assert.ok(!/(?:insert\s+into|update|delete\s+from)\s+(?:"?auth"?\.|"?supabase_migrations"?\.)/i.test(topLevelSql));
assert.match(generated.query, /9223372036854775807/);
assert.match(generated.query, /application_name'\)<>'soft_as_production_baseline_replay'/);
assert.match(generated.query, /server_version_num'\)::integer\/10000<>17/);
assert.match(generated.query, /'documentos-pdf','documentos-pdf',false/);

assert.equal(compareCatalogs(source, structuredClone(source)).equal, true);
const missingGrant = structuredClone(source);
const removed = missingGrant.catalog.effective_grants.findIndex(x => x.schema === 'public' && x.name === 'patients' && x.grantee === 'authenticated' && x.privilege === 'SELECT');
assert.ok(removed >= 0); missingGrant.catalog.effective_grants.splice(removed, 1);
const grantDiff = compareCatalogs(source, missingGrant, { applicationOnly: true });
assert.equal(grantDiff.equal, false);
assert.equal(grantDiff.changes.length, 1);
assert.equal(grantDiff.changes[0].category, 'effective_grants');
assert.equal(grantDiff.changes[0].status, 'removed');

const removedPolicy = structuredClone(source);
removedPolicy.catalog.policies[0].check_expression = 'false';
const policyDiff = compareCatalogs(source, removedPolicy, { applicationOnly: true });
assert.equal(policyDiff.equal, false);
assert.ok(policyDiff.changes.some(x => x.category === 'policies' && x.changedFields.includes('check_expression')));
const organizationOptional = structuredClone(source);
const orgColumn = organizationOptional.catalog.columns.find(x => x.relation === 'patients' && x.name === 'organization_id');
assert.equal(orgColumn.not_null, true); orgColumn.not_null = false;
assert.ok(compareCatalogs(source, organizationOptional, { applicationOnly: true }).changes.some(x => x.category === 'columns' && x.changedFields.includes('not_null')));
const disabledGuard = structuredClone(source);
disabledGuard.catalog.triggers[0].enabled = 'D';
assert.ok(compareCatalogs(source, disabledGuard).changes.some(x => x.category === 'triggers' && x.changedFields.includes('enabled')));
assert.equal(compareCatalogs(source, stage).equal, false, 'Stage upgrades cannot be mistaken for an unchanged production baseline');
const changedFutureGrant = structuredClone(source);
changedFutureGrant.catalog.default_privileges.find(x => x.schema === 'public' && x.object_type === 'f').acl = '{postgres=X/postgres}';
assert.ok(compareCatalogs(source, changedFutureGrant, { applicationOnly: true }).changes.some(x => x.category === 'default_privileges' && x.changedFields.includes('acl')),
  'Future grants must remain part of the comparison even when object ACL representation is normalized');
const newGlobalDefault = structuredClone(source);
newGlobalDefault.catalog.default_privileges.push({owner:'postgres',schema:null,object_type:'r',acl:'{anon=r/postgres}'});
assert.equal(compareCatalogs(source,newGlobalDefault,{applicationOnly:true}).equal,false, 'Global default privileges must affect the application comparison');
assert.throws(()=>prepareProductionApplicationBaseline(newGlobalDefault),/Global default privileges/);
const emptyFunctionAcl = structuredClone(source), denied = emptyFunctionAcl.catalog.functions[0];
denied.acl='{}';
emptyFunctionAcl.catalog.effective_grants=emptyFunctionAcl.catalog.effective_grants.filter(x=>!(x.kind==='function'&&x.schema===denied.schema&&x.name===denied.name&&x.arguments===denied.arguments));
assert.throws(()=>prepareProductionApplicationBaseline(emptyFunctionAcl),/Empty function ACL/,
  'An empty ACL must not restore the default PUBLIC EXECUTE privilege');
assert.ok(generated.query.includes('alter schema "public" owner to "pg_database_owner";'));
assert.ok(generated.query.includes('alter schema "extensions" owner to "postgres";'));

for (const mutate of [
  x => { x.dataIncluded = true; },
  x => { delete x.catalog.policies; },
  x => { x.catalog.functions.push(structuredClone(x.catalog.functions[0])); },
  x => { x.catalog.sequences[0].maximum = Number('9223372036854775807'); },
  x => { x.catalog.functions[0].definition += '\n-- sk_live_synthetic_disallowed'; },
  x => { x.catalog.coverage[0].total = 1; }
]) {
  const bad = structuredClone(source); mutate(bad);
  assert.throws(() => validateCatalog(bad));
}
const wrongSource = structuredClone(source); wrongSource.projectRef = 'yqqrfgbvoexricjdxpis';
assert.throws(() => prepareProductionApplicationBaseline(wrongSource));
let calls = 0;
for (const key of ['PGHOST', 'DATABASE_URL', 'SUPABASE_URL', 'DOCKER_CONTEXT']) {
  await assert.rejects(runProductionBaselineReplay({ inheritedEnv: { [key]: 'forbidden' }, run: async () => { calls++; } }));
}
assert.equal(calls, 0, 'No local or remote command may run with a target override');

const localPlatform = structuredClone(source); localPlatform.projectRef = 'local-disposable';
const tablePrivileges = ['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE'];
for (const name of ['iceberg_namespaces', 'iceberg_tables']) {
  localPlatform.catalog.storage_relation_security.push({ name, rls: true, force_rls: false, acl: null });
  for (const grantee of ['anon', 'authenticated', 'service_role', 'supabase_storage_admin']) {
    for (const privilege of ['anon', 'authenticated'].includes(grantee) ? ['SELECT'] : tablePrivileges) {
      localPlatform.catalog.effective_grants.push({ kind: 'relation', schema: 'storage', relation: null, name,
        arguments: null, grantor: 'supabase_storage_admin', grantee, privilege, grantable: false });
    }
  }
}
const managedFixture = prepareManagedSecurityFixture(source, localPlatform);
assert.equal(managedFixture.capturedStorageTables.length, 8);
assert.equal(managedFixture.extraPlatformTables.length, 2);
assert.equal(managedFixture.managedTableStructuresChanged, false);
assert.equal(managedFixture.managedOwnersChanged, false);
assert.equal(managedFixture.managedSecurityAdjustedLocally, true);
assert.match(managedFixture.query, /set local role "supabase_storage_admin"/);
assert.match(managedFixture.query, /grant MAINTAIN on table storage\."objects" to "anon";/);
assert.match(managedFixture.query, /grant SELECT on table storage\."objects" to "postgres" with grant option;/);
assert.match(managedFixture.query, /rolsuper or rolbypassrls/);
assert.match(managedFixture.query, /pg_has_role\('anon','supabase_storage_admin','MEMBER'\)/);
assert.match(managedFixture.query, /pg_has_role\('authenticated','supabase_storage_admin','MEMBER'\)/);
assert.match(managedFixture.query, /Extra managed Storage owner differs/);
assert.match(managedFixture.query, /Extra managed Storage table must have no policies/);
assert.match(managedFixture.query, /set local role "authenticated"/);
assert.ok(!/(?:create|drop)\s+table|owner\s+to|(?:^|\n)\s*(?:insert\s+into|update\s+|delete\s+from)/i.test(managedFixture.query),
  'Managed fixture only reconciles permissions and RLS; it must not copy DDL, owners or data');
assert.equal(compareManagedSecurityDependencies(source, localPlatform).equal, true);
for (const mutate of [
  x => { x.catalog.storage_relation_security = x.catalog.storage_relation_security.filter(t => t.name !== 'objects'); },
  x => { x.catalog.storage_relation_security.find(t => t.name === 'iceberg_tables').rls = false; },
  x => { x.catalog.storage_relation_security.push({ name: 'unreviewed_table', rls: true, force_rls: false, acl: null }); },
  x => { x.catalog.policies.push({ schema: 'storage', relation: 'iceberg_tables', name: 'unsafe_policy', roles: ['anon'], command: 'SELECT', permissive: 'PERMISSIVE', using_expression: 'true', check_expression: null }); },
  x => { x.catalog.effective_grants.find(g => g.name === 'iceberg_tables' && g.grantee === 'anon').privilege = 'INSERT'; },
  x => { x.catalog.effective_grants.find(g => g.name === 'iceberg_tables' && g.grantee === 'authenticated').grantable = true; },
  x => { x.catalog.effective_grants.find(g => g.schema === 'storage' && g.name === 'objects').grantor = 'unreviewed_grantor'; }
]) {
  const unsafe = structuredClone(localPlatform); mutate(unsafe);
  assert.throws(() => prepareManagedSecurityFixture(source, unsafe), 'A managed platform difference must be reviewed before it can be scoped out');
}
const changedRequiredPrivilege = structuredClone(localPlatform);
changedRequiredPrivilege.catalog.effective_grants = changedRequiredPrivilege.catalog.effective_grants.filter(g => !(g.schema === 'storage' && g.name === 'objects' && g.grantee === 'authenticated' && g.privilege === 'SELECT'));
assert.equal(compareManagedSecurityDependencies(source, changedRequiredPrivilege).equal, false, 'Captured Storage permissions remain an exact comparison');
const explicitDefaultAcl = structuredClone(localPlatform);
explicitDefaultAcl.catalog.storage_relation_security.find(t => t.name === 'migrations').acl = '{supabase_storage_admin=arwdDxtm/supabase_storage_admin}';
assert.equal(compareManagedSecurityDependencies(source, explicitDefaultAcl).equal, true, 'ACL spelling may differ only while all effective privileges match');
const changedStorageRls = structuredClone(localPlatform);
changedStorageRls.catalog.storage_relation_security.find(t => t.name === 'objects').rls = false;
assert.equal(compareManagedSecurityDependencies(source, changedStorageRls).equal, false);

const privateFailure = Object.assign(new Error('private token and arbitrary error content must never be exported'), {
  sqlState: '42501', assertion: 'private substituted runtime content' });
await assert.rejects(replayProductionBaseline({ run: async () => { throw privateFailure; } }), error => error === privateFailure);
const diagnostic = replayFailureDetails(privateFailure, 'prepare');
assert.deepEqual(diagnostic, { operation: 'empty-history', sqlState: '42501', assertionCode: 'SQL_RAISE' });
assert.ok(!JSON.stringify(diagnostic).includes('private'));
assert.equal(replayFailureDetails({ replayPhase: 'arbitrary private content', migrationPath: 'https://private.invalid', sqlState: 'invalid' }, 'prepare').operation, 'prepare');
const candidates = JSON.parse(await read('docs/engineering/LEGACY-METADATA-CANDIDATES-2026-10-11.json'));
assert.equal(candidates.automaticAssignmentAllowed, false);
assert.equal(candidates.clinicalPayloadRead, false);
assert.equal(candidates.totals.source_rows, 1156);
assert.equal(candidates.totals.one_candidate_organization, 864);
assert.equal(candidates.totals.no_relational_match, 292);
assert.equal(candidates.totals.multiple_candidate_organizations, 0);
assert.ok(candidates.modules.every(x => !x.module.includes('@')), 'User-scoped module suffixes must not be published');
console.log('✓ production DDL baseline deterministic; managed Storage grants/RLS and platform extras fail closed; phase diagnostics contain no runtime content; no automatic legacy classification');
