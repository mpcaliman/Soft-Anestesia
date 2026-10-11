import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compareCatalogs, validateCatalog } from '../scripts/compare-application-catalog.mjs';
import { prepareProductionApplicationBaseline } from '../scripts/prepare-production-application-baseline.mjs';
import { runProductionBaselineReplay } from '../scripts/run-production-baseline-replay.mjs';

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
const candidates = JSON.parse(await read('docs/engineering/LEGACY-METADATA-CANDIDATES-2026-10-11.json'));
assert.equal(candidates.automaticAssignmentAllowed, false);
assert.equal(candidates.clinicalPayloadRead, false);
assert.equal(candidates.totals.source_rows, 1156);
assert.equal(candidates.totals.one_candidate_organization, 864);
assert.equal(candidates.totals.no_relational_match, 292);
assert.equal(candidates.totals.multiple_candidate_organizations, 0);
assert.ok(candidates.modules.every(x => !x.module.includes('@')), 'User-scoped module suffixes must not be published');
console.log('✓ production DDL baseline deterministic; grants/RLS/guards drift detected; no records, unsafe target, or automatic legacy classification');
