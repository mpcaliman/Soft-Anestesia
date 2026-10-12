import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const catalogCategories = ['server', 'schemas', 'extensions', 'relations', 'columns', 'constraints',
  'indexes', 'sequences', 'types', 'functions', 'policies', 'triggers', 'rules', 'default_privileges',
  'publications', 'storage_relation_security', 'storage_buckets', 'migration_history', 'effective_grants',
  'table_inheritance', 'coverage'];
const sensitive = /eyJ[A-Za-z0-9_-]{20,}|sk_live_|sb_secret_|-----BEGIN[^-]*PRIVATE KEY|https?:\/\/[^/\s]*:[^/@\s]*@|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
export const stableJson = value => JSON.stringify(value, (_, v) => {
  if (v && typeof v === 'object' && !Array.isArray(v)) return Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]]));
  return v;
});
export const catalogHash = value => createHash('sha256').update(stableJson(value)).digest('hex');

export function validateCatalog(document) {
  assert.equal(document?.format, 1, 'Unknown catalog format');
  assert.equal(document.kind, 'supabase_application_catalog');
  assert.match(document.projectRef, /^[a-z0-9]{20}$|^local-disposable$/);
  assert.equal(document.dataIncluded, false, 'Data-bearing snapshots are refused');
  assert.equal(document.secretValuesIncluded, false, 'Secrets are refused');
  assert.ok(!sensitive.test(JSON.stringify(document)), 'Sensitive-looking value is refused before export');
  const catalog = document.catalog;
  assert.deepEqual(Object.keys(catalog).sort(), [...catalogCategories].sort(), 'Missing/unknown metadata category');
  for (const name of catalogCategories) {
    assert.ok(Array.isArray(catalog[name]), `Category must be an array: ${name}`);
    const keys = catalog[name].map(row => catalogIdentity(name, row));
    assert.equal(new Set(keys).size, keys.length, `Duplicate metadata identity: ${name}`);
  }
  for (const check of catalog.coverage) assert.equal(check.total, 0, `Unsupported application object: ${check.check}`);
  assert.equal(catalog.table_inheritance.length, 0, 'Partition/inheritance replay is not implemented');
  for (const seq of catalog.sequences) for (const key of ['start', 'increment', 'minimum', 'maximum', 'cache']) {
    assert.equal(typeof seq[key], 'string', 'Sequence bigint must be text; JSON numbers can silently round');
    assert.match(seq[key], /^-?\d+$/);
    assert.ok(BigInt(seq[key]) >= -(2n ** 63n) && BigInt(seq[key]) <= 2n ** 63n - 1n);
  }
  return catalog;
}

export function catalogIdentity(category, row) {
  const fields = {
    server: [], schemas: ['schema'], extensions: ['name'], relations: ['schema', 'name'],
    columns: ['schema', 'relation', 'name'], constraints: ['schema', 'relation', 'name'],
    indexes: ['schema', 'relation', 'name'], sequences: ['schema', 'name'], types: ['schema', 'name'],
    functions: ['schema', 'name', 'arguments'], policies: ['schema', 'relation', 'name'],
    triggers: ['schema', 'relation', 'name'], rules: ['schema', 'relation', 'name'],
    default_privileges: ['owner', 'schema', 'object_type'], publications: ['name'],
    storage_relation_security: ['name'], storage_buckets: ['id'], migration_history: ['version'],
    effective_grants: ['kind', 'schema', 'relation', 'name', 'arguments', 'grantee', 'grantor', 'privilege', 'grantable'],
    table_inheritance: ['schema', 'relation', 'ordinal'], coverage: ['check']
  }[category];
  assert.ok(fields, 'Unknown catalog category');
  return fields.map(key => String(row[key] ?? '')).join('|');
}

function normalizeRow(category, row, applicationOnly = false) {
  const copy = structuredClone(row);
  // Effective grants are compared independently. An explicit owner/PUBLIC ACL
  // equivalent to a NULL default ACL is not a different authorization policy.
  if (applicationOnly && ['schemas', 'relations', 'columns', 'functions', 'types', 'storage_relation_security'].includes(category)) delete copy.acl;
  // aclitem order has no meaning. Keep grantor/grant options and NULL vs explicit ACL.
  if (typeof copy.acl === 'string') copy.acl = '{' + copy.acl.slice(1, -1).split(',').sort().join(',') + '}';
  if (category === 'policies') copy.roles = [...copy.roles].sort();
  if (Array.isArray(copy.options)) copy.options.sort();
  return copy;
}

export function compareCatalogs(expectedDocument, actualDocument, { categories = catalogCategories, applicationOnly = false } = {}) {
  const expected = validateCatalog(expectedDocument), actual = validateCatalog(actualDocument);
  const changes = [], counts = {};
  const include = (category, row) => {
    if (!applicationOnly) return true;
    // This named staging-only capability ledger is not a production application
    // table. No wildcard filters hide future clinical/schema differences.
    if (row.schema === 'public' && (row.relation === 'staging_audit_run_claims' || row.name === 'staging_audit_run_claims')) return false;
    if (['server', 'migration_history', 'coverage', 'storage_relation_security'].includes(category)) return false;
    if (category === 'schemas') return ['public', 'app'].includes(row.schema);
    if (category === 'default_privileges') return row.schema === null || ['public', 'app'].includes(row.schema);
    if (category === 'effective_grants') return ['public', 'app'].includes(row.schema);
    // Platform versions and unrelated pg_net are separately reported prerequisites.
    if (category === 'extensions') return ['pgcrypto', 'unaccent', 'pg_trgm', 'uuid-ossp'].includes(row.name);
    return true;
  };
  for (const category of categories) {
    assert.ok(catalogCategories.includes(category));
    const left = new Map(expected[category].filter(x => include(category, x)).map(x => [catalogIdentity(category, x), normalizeRow(category, x, applicationOnly)]));
    const right = new Map(actual[category].filter(x => include(category, x)).map(x => [catalogIdentity(category, x), normalizeRow(category, x, applicationOnly)]));
    counts[category] = { expected: left.size, actual: right.size, added: 0, removed: 0, changed: 0 };
    for (const key of [...new Set([...left.keys(), ...right.keys()])].sort()) {
      const before = left.get(key), after = right.get(key);
      let status;
      if (!before) status = 'added'; else if (!after) status = 'removed';
      else if (stableJson(before) !== stableJson(after)) status = 'changed'; else continue;
      counts[category][status]++;
      const changedFields = before && after ? [...new Set([...Object.keys(before), ...Object.keys(after)])]
        .filter(field => stableJson(before[field]) !== stableJson(after[field])).sort() : [];
      changes.push({ category, identity: key, status, changedFields,
        ...(before ? { expectedSha256: catalogHash(before) } : {}), ...(after ? { actualSha256: catalogHash(after) } : {}) });
    }
  }
  return { format: 1, expectedProject: expectedDocument.projectRef, actualProject: actualDocument.projectRef,
    expectedCapturedAt: expectedDocument.capturedAt, actualCapturedAt: actualDocument.capturedAt,
    expectedCatalogSha256: catalogHash(expected), actualCatalogSha256: catalogHash(actual),
    comparison: applicationOnly ? 'application_objects_and_storage_policies_only' : 'all_captured_metadata',
    excludedTemporaryObjects: applicationOnly ? ['public.staging_audit_run_claims'] : [],
    equal: changes.length === 0, counts, changes, dataIncluded: false,
    productionApplyAllowed: false, hostedIntegrationVerified: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [expected, actual, output] = process.argv.slice(2);
  if (!expected || !actual || !output || process.argv.length !== 5) throw new Error('Usage: node scripts/compare-application-catalog.mjs expected.json actual.json output.json');
  const report = compareCatalogs(JSON.parse(await readFile(expected, 'utf8')), JSON.parse(await readFile(actual, 'utf8')));
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(`Catalog comparison: ${report.changes.length} differences; no remote changes.`);
}
