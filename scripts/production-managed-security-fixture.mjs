import assert from 'node:assert/strict';
import { compareCatalogs, validateCatalog } from './compare-application-catalog.mjs';

const storageOwner = 'supabase_storage_admin';
const privileges = ['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE'];
const knownRoles = ['anon', 'authenticated', 'service_role', 'postgres', storageOwner];
const permittedExtraTables = ['iceberg_namespaces', 'iceberg_tables'];
const identifier = value => '"' + String(value).replaceAll('"', '""') + '"';
const literal = value => "'" + String(value).replaceAll("'", "''") + "'";
const role = value => value === 'PUBLIC' ? 'PUBLIC' : identifier(value);

// Supabase CLI and hosted Storage can have different platform release dates.
// Only the captured dependency privileges are restored on a disposable local
// database; managed table definitions, owners and existing migrations stay intact.
export function prepareManagedSecurityFixture(source, current) {
  const expected = validateCatalog(source), actual = validateCatalog(current);
  assert.equal(source.projectRef, 'zbpbrnalamjrcfbscjkt');
  assert.equal(current.projectRef, 'local-disposable', 'Managed fixture requires the isolated local target');
  const names = expected.storage_relation_security.map(x => x.name).sort();
  assert.equal(names.length, 8, 'Review a changed production Storage dependency inventory');
  for (const table of expected.storage_relation_security) {
    assert.equal(table.rls, true, 'Captured Storage dependency must enforce RLS');
    assert.equal(typeof table.force_rls, 'boolean');
    assert.ok(actual.storage_relation_security.some(x => x.name === table.name), 'Missing managed Storage prerequisite');
  }
  const extras = actual.storage_relation_security.filter(x => !names.includes(x.name));
  for (const table of extras) {
    assert.ok(permittedExtraTables.includes(table.name), 'Unreviewed extra managed Storage table');
    assert.equal(table.rls, true, 'Extra managed Storage table must enforce RLS');
    assert.equal(table.force_rls, false);
    assert.ok(!actual.policies.some(x => x.schema === 'storage' && x.relation === table.name), 'Extra Storage table must have no policies');
    const grants = actual.effective_grants.filter(x => x.schema === 'storage' && x.name === table.name);
    assert.equal(grants.length, 18, 'Extra Storage grant inventory differs from the reviewed CLI fixture');
    for (const grant of grants) {
      assert.equal(grant.kind, 'relation');
      assert.equal(grant.grantor, storageOwner);
      assert.equal(grant.grantable, false);
      assert.ok(['anon', 'authenticated', 'service_role', storageOwner].includes(grant.grantee), 'Unreviewed extra Storage grantee');
      assert.ok(['anon', 'authenticated'].includes(grant.grantee) ? grant.privilege === 'SELECT' : privileges.includes(grant.privilege),
        'Extra Storage client privilege exceeds SELECT');
    }
  }
  const sql = ['begin;', `set local application_name='soft_as_production_baseline_replay';`, `do $managed_fixture_guard$ begin
 if current_database()<>'postgres' or current_user<>'supabase_admin'
  or current_setting('server_version_num')::integer/10000<>17
  or current_setting('application_name')<>'soft_as_production_baseline_replay' then
  raise exception 'Managed security fixture requires isolated PostgreSQL 17'; end if;
 if exists(select 1 from auth.users) or exists(select 1 from storage.objects) then
  raise exception 'Managed security fixture requires empty Auth and Storage objects'; end if;
 if (select count(*) from pg_roles where rolname in ('anon','authenticated','supabase_storage_admin'))<>3 then
  raise exception 'Reference Storage security roles are missing'; end if;
 if exists(select 1 from pg_roles where rolname in ('anon','authenticated') and (rolsuper or rolbypassrls)) then
  raise exception 'Reference client role bypasses row security'; end if;
 if pg_has_role('anon','supabase_storage_admin','MEMBER')
  or pg_has_role('authenticated','supabase_storage_admin','MEMBER') then
  raise exception 'Reference client role can inherit Storage ownership'; end if;
 end $managed_fixture_guard$;`];
  for (const table of expected.storage_relation_security) {
    const matching = row => row.schema === 'storage' && row.name === table.name;
    const grants = expected.effective_grants.filter(matching);
    const currentGrants = actual.effective_grants.filter(matching);
    for (const grant of [...grants, ...currentGrants]) {
      assert.equal(grant.kind, 'relation');
      assert.equal(grant.grantor, storageOwner, 'Managed fixture cannot reconstruct foreign grant chains');
      assert.ok(knownRoles.includes(grant.grantee), 'Unreviewed captured Storage grantee');
      assert.ok(privileges.includes(grant.privilege));
      assert.equal(typeof grant.grantable, 'boolean');
    }
    assert.ok(grants.length > 0, 'Missing captured effective Storage grants');
    const target = `storage.${identifier(table.name)}`;
    sql.push(`do $managed_owner_guard$ begin
 if not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='storage' and c.relname=${literal(table.name)} and c.relkind in ('r','p')
   and pg_get_userbyid(c.relowner)=${literal(storageOwner)}) then
  raise exception 'Managed Storage prerequisite owner differs'; end if; end $managed_owner_guard$;`);
    sql.push(`set local role ${identifier(storageOwner)};`);
    sql.push(`revoke all on table ${target} from ${['PUBLIC', ...new Set([...grants, ...currentGrants].map(x => x.grantee))].map(role).join(',')};`);
    for (const grant of grants) sql.push(`grant ${grant.privilege} on table ${target} to ${role(grant.grantee)}${grant.grantable ? ' with grant option' : ''};`);
    sql.push(`alter table ${target} enable row level security;`);
    sql.push(`alter table ${target} ${table.force_rls ? 'force' : 'no force'} row level security;`, 'reset role;');
  }
  for (const table of extras) {
    sql.push(`do $extra_storage_guard$ begin
 if not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='storage' and c.relname=${literal(table.name)} and c.relkind in ('r','p')
   and pg_get_userbyid(c.relowner)=${literal(storageOwner)}) then
  raise exception 'Extra managed Storage owner differs'; end if;
 if exists(select 1 from storage.${identifier(table.name)}) then
  raise exception 'Extra managed Storage table must remain empty'; end if;
 if exists(select 1 from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='storage' and c.relname=${literal(table.name)}) then
  raise exception 'Extra managed Storage table must have no policies'; end if;
 end $extra_storage_guard$;`);
    for (const client of ['anon', 'authenticated']) sql.push(`set local role ${identifier(client)};
do $extra_visibility_guard$ begin
 if exists(select 1 from storage.${identifier(table.name)}) then
  raise exception 'Extra Storage table is visible to a client role'; end if;
end $extra_visibility_guard$;
reset role;`);
  }
  sql.push('commit;');
  return { query: sql.join('\n')+'\n', capturedStorageTables: names,
    extraPlatformTables: extras.map(table => ({ name: table.name, rls: table.rls, force_rls: table.force_rls,
      policies: 0, clientPrivilege: 'SELECT', clientGrantOption: false, requiredEmpty: true })),
    managedTableStructuresChanged: false, managedOwnersChanged: false,
    managedSecurityAdjustedLocally: true, productionApplyAllowed: false };
}

export function compareManagedSecurityDependencies(source, current) {
  const names = validateCatalog(source).storage_relation_security.map(x => x.name);
  const scoped = document => {
    const copy = structuredClone(document);
    copy.catalog.schemas = copy.catalog.schemas.filter(x => ['auth', 'storage', 'extensions'].includes(x.schema));
    copy.catalog.effective_grants = copy.catalog.effective_grants.filter(x => ['auth', 'storage', 'extensions'].includes(x.schema)
      && (x.schema !== 'storage' || x.kind !== 'relation' || names.includes(x.name)));
    copy.catalog.storage_relation_security = copy.catalog.storage_relation_security.filter(x => names.includes(x.name)).map(x => {
      // ACL null/default and explicit ACL may encode the same privileges. The
      // independent effective_grants comparison retains grantor/grant options.
      const row = { ...x }; delete row.acl; return row;
    });
    return copy;
  };
  return compareCatalogs(scoped(source), scoped(current), { categories: ['schemas', 'effective_grants', 'storage_relation_security'] });
}
