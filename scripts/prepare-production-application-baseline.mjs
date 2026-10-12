import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { catalogHash, validateCatalog } from './compare-application-catalog.mjs';

export const productionProject = 'zbpbrnalamjrcfbscjkt';
const ident = value => '"' + String(value).replaceAll('"', '""') + '"';
const qualified = (schema, name) => `${ident(schema)}.${ident(name)}`;
const literal = value => "'" + String(value).replaceAll("'", "''") + "'";
const role = value => value.toUpperCase() === 'PUBLIC' ? 'public' : ident(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const fragment = value => {
  assert.equal(typeof value, 'string');
  assert.ok(value.length && !/[;\u0000]/.test(value), 'Unexpected multi-statement metadata fragment');
  return value;
};
const bigint = value => { assert.equal(typeof value, 'string'); assert.match(value, /^-?\d+$/); return value; };
const terminate = value => fragment(value.replace(/;\s*$/, '')) + ';';
const ownerKinds = { r: 'table', p: 'table', m: 'materialized view', v: 'view', S: 'sequence' };
const aclPrivileges = { r: 'SELECT', w: 'UPDATE', a: 'INSERT', d: 'DELETE', D: 'TRUNCATE', x: 'REFERENCES',
  t: 'TRIGGER', m: 'MAINTAIN', X: 'EXECUTE', U: 'USAGE', C: 'CREATE', c: 'CONNECT', T: 'TEMPORARY' };

function defaultAclEntries(acl) {
  assert.match(acl, /^\{[^{}]*\}$/);
  return acl.slice(1, -1).split(',').flatMap(item => {
    const match = item.match(/^([a-z_0-9]*)=([A-Za-z*]*)\/([a-z_0-9]+)$/);
    assert.ok(match, 'Quoted/unknown default ACL requires explicit review');
    const result = [];
    for (let i = 0; i < match[2].length; i++) {
      const privilege = aclPrivileges[match[2][i]];
      assert.ok(privilege, 'Unknown ACL privilege code');
      const grantable = match[2][i + 1] === '*';
      if (grantable) i++;
      result.push({ grantee: match[1] || 'PUBLIC', privilege, grantable });
    }
    return result;
  });
}

export function prepareProductionApplicationBaseline(document) {
  assert.equal(document.projectRef, productionProject, 'Only the fixed production catalog is a source');
  const c = validateCatalog(document);
  assert.ok(!c.default_privileges.some(x => x.schema === null), 'Global default privileges require explicit replay support');
  assert.equal(c.types.length, 0, 'Custom type replay requires explicit support');
  assert.equal(c.rules.length, 0, 'Custom rewrite rules require explicit support');
  assert.ok(c.relations.every(r => !r.is_partition && ['r', 'v', 'm', 'S'].includes(r.kind)));
  assert.ok(c.columns.every(x => !x.options?.length && !x.compression), 'Column options/compression require explicit support');
  assert.ok(c.relations.every(x => !x.options?.length || x.kind === 'v'), 'Table/matview options require explicit support');
  const sql = [
    '-- Application-only production DDL captured without any records or secrets.',
    '-- REFERENCE REPLAY ONLY: disposable Docker-local Supabase/PostgreSQL 17.',
    '-- Never apply this restore artifact to production or an existing remote staging database.',
    '-- Auth/Storage managed tables/functions are prerequisites, not copied DDL.',
    '-- No migration-history rows are inserted, repaired or rewritten.',
    'begin;', 'set local search_path=pg_catalog;', 'set local check_function_bodies=off;',
    "set local lock_timeout='5s';", "set local statement_timeout='120s';",
    'do $reference_guard$ begin',
    " if current_database()<>'postgres' or current_user<>'supabase_admin' or current_setting('server_version_num')::integer/10000<>17",
    "    or current_setting('application_name')<>'soft_as_production_baseline_replay' then",
    "   raise exception 'Production baseline replay requires the isolated local reference executor'; end if;",
    " if exists(select 1 from auth.users) or exists(select 1 from storage.objects) or exists(",
    "   select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace",
    "   where n.nspname in ('public','app') and c.relkind in ('r','p','v','m','f','S')",
    "   and not exists(select 1 from pg_depend d where d.classid='pg_class'::regclass and d.objid=c.oid and d.deptype='e')) then",
    "   raise exception 'Reference replay requires an empty application and zero Auth/Storage objects'; end if;",
    " if to_regprocedure('auth.uid()') is null or to_regclass('auth.users') is null",
    "    or to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null then",
    "   raise exception 'Managed Supabase Auth/Storage dependencies missing'; end if;",
    'end $reference_guard$;',
    'create schema if not exists extensions;', 'create schema app authorization postgres;'
  ];
  for (const schema of c.schemas.filter(x => ['public', 'app', 'extensions'].includes(x.schema))) {
    sql.push(`alter schema ${ident(schema.schema)} owner to ${ident(schema.owner)};`);
    assert.ok(c.effective_grants.some(g => g.kind === 'schema' && g.schema === schema.schema), 'Empty schema ACL requires explicit replay support');
  }
  for (const relation of c.relations) assert.ok(c.effective_grants.some(g => g.kind === (relation.kind === 'S' ? 'sequence' : 'relation') && g.schema === relation.schema && g.name === relation.name),
    'Empty relation/sequence ACL requires explicit replay support');
  for (const e of c.extensions.filter(x => ['pgcrypto', 'unaccent', 'pg_trgm', 'uuid-ossp'].includes(x.name))) {
    sql.push(`create extension if not exists ${ident(e.name)} with schema ${ident(e.schema)} version ${literal(e.version)};`);
    assert.equal(e.relocatable, true);
    sql.push(`alter extension ${ident(e.name)} set schema ${ident(e.schema)};`);
    sql.push(`do $extension_guard$ begin if not exists(select 1 from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname=${literal(e.name)} and e.extversion=${literal(e.version)} and n.nspname=${literal(e.schema)}) then raise exception 'Application extension version/schema mismatch'; end if; end $extension_guard$;`);
  }
  sql.push('set local role postgres;');
  for (const f of c.functions) {
    assert.equal(f.owner, 'postgres', 'Privileged/custom role ownership requires review');
    assert.ok(c.effective_grants.some(g => g.kind === 'function' && g.schema === f.schema && g.name === f.name && g.arguments === f.arguments),
      'Empty function ACL requires explicit replay support');
    assert.ok(!/\b(?:pg_read_file|pg_ls_dir|lo_import)\s*\(|\bcopy\b[\s\S]*\b(?:program|from\s+['"])/i.test(f.definition));
    // Full pg_get_functiondef is reviewed metadata, not an interpolated SQL fragment.
    sql.push(f.definition.trim().replace(/;?$/, ';'));
  }
  const independentSequences = c.sequences.filter(x => !x.ownership?.some(o => o.dependency_type === 'i'));
  const seqOptions = seq => `as ${fragment(seq.type)} start with ${bigint(seq.start)} increment by ${bigint(seq.increment)} minvalue ${bigint(seq.minimum)} maxvalue ${bigint(seq.maximum)} cache ${bigint(seq.cache)} ${seq.cycle ? 'cycle' : 'no cycle'}`;
  for (const seq of independentSequences) sql.push(`create sequence ${qualified(seq.schema, seq.name)} ${seqOptions(seq)};`);
  for (const r of c.relations.filter(x => x.kind === 'r')) {
    assert.equal(r.owner, 'postgres');
    assert.equal(r.persistence, 'p', 'Unlogged/temp table replay requires explicit support');
    const columns = c.columns.filter(x => x.schema === r.schema && x.relation === r.name).sort((a, b) => a.ordinal - b.ordinal);
    const parts = columns.map(column => {
      let part = `${ident(column.name)} ${fragment(column.type)}`;
      if (column.collation) part += ` collate ${fragment(column.collation)}`;
      if (column.identity) {
        const seq = c.sequences.find(x => x.ownership?.some(o => o.schema === r.schema && o.relation === r.name && o.column === column.name && o.dependency_type === 'i'));
        assert.ok(seq, 'Identity sequence metadata is required');
        part += ` generated ${column.identity === 'a' ? 'always' : 'by default'} as identity (sequence name ${qualified(seq.schema, seq.name)} ${seqOptions(seq).replace(/^as [^ ]+ /, '')})`;
      } else if (column.generated) {
        assert.equal(column.generated, 's');
        part += ` generated always as (${fragment(column.default_expression)}) stored`;
      } else if (column.default_expression !== null) part += ` default ${fragment(column.default_expression)}`;
      if (column.not_null) part += ' not null';
      return ' '+part;
    });
    sql.push(`create table ${qualified(r.schema, r.name)} (\n${parts.join(',\n')}\n);`);
  }
  for (const k of c.constraints.filter(x => x.type !== 'f')) {
    assert.ok(['p', 'u', 'c', 'x'].includes(k.type));
    sql.push(`alter table ${qualified(k.schema, k.relation)} add constraint ${ident(k.name)} ${fragment(k.definition)};`);
  }
  for (const k of c.constraints.filter(x => x.type === 'f')) sql.push(`alter table ${qualified(k.schema, k.relation)} add constraint ${ident(k.name)} ${fragment(k.definition)};`);
  for (const r of c.relations.filter(x => ['m', 'v'].includes(x.kind))) {
    const options = r.options?.length ? ` with (${r.options.map(fragment).join(',')})` : '';
    sql.push(`create ${r.kind === 'm' ? 'materialized view' : 'view'} ${qualified(r.schema, r.name)}${options} as ${fragment(r.view_definition.trim().replace(/;$/, ''))}${r.kind === 'm' ? ' with no data' : ''};`);
  }
  for (const i of c.indexes.filter(x => !x.constraint_owned)) {
    assert.ok(i.valid && i.ready, 'Invalid/incomplete indexes cannot establish a baseline');
    assert.equal(i.clustered, false, 'Clustered index replay requires explicit support');
    assert.ok(!i.tablespace, 'Custom tablespaces require explicit support');
    sql.push(terminate(i.definition));
  }
  for (const column of c.columns.filter(x => c.relations.some(r => r.schema === x.schema && r.name === x.relation && r.kind === 'r'))) {
    const storage = { p: 'plain', e: 'external', m: 'main', x: 'extended' }[column.storage];
    assert.ok(storage);
    sql.push(`alter table ${qualified(column.schema, column.relation)} alter column ${ident(column.name)} set storage ${storage};`);
    if (column.statistics_target !== null) {
      assert.ok(Number.isInteger(column.statistics_target));
      sql.push(`alter table ${qualified(column.schema, column.relation)} alter column ${ident(column.name)} set statistics ${column.statistics_target};`);
    }
  }
  for (const seq of independentSequences) for (const o of seq.ownership ?? []) sql.push(`alter sequence ${qualified(seq.schema, seq.name)} owned by ${qualified(o.schema, o.relation)}.${ident(o.column)};`);
  for (const r of c.relations) {
    assert.equal(r.owner, 'postgres');
    if (r.kind !== 'S') sql.push(`alter ${ownerKinds[r.kind]} ${qualified(r.schema, r.name)} owner to postgres;`);
    if (r.kind === 'r') {
      sql.push(`alter table ${qualified(r.schema, r.name)} ${r.rls ? 'enable' : 'disable'} row level security;`);
      sql.push(`alter table ${qualified(r.schema, r.name)} ${r.force_rls ? 'force' : 'no force'} row level security;`);
      const identity = { d: 'default', f: 'full', n: 'nothing' }[r.replica_identity];
      if (identity) sql.push(`alter table ${qualified(r.schema, r.name)} replica identity ${identity};`);
      else {
        const index = c.indexes.find(x => x.schema === r.schema && x.relation === r.name && x.replica_identity);
        assert.ok(index); sql.push(`alter table ${qualified(r.schema, r.name)} replica identity using index ${ident(index.name)};`);
      }
    }
  }
  sql.push('reset role;');
  for (const p of c.policies) {
    assert.ok(['ALL', 'SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(p.command));
    assert.ok(['PERMISSIVE', 'RESTRICTIVE'].includes(p.permissive));
    const roles = p.roles.map(role).join(',');
    sql.push(`drop policy if exists ${ident(p.name)} on ${qualified(p.schema, p.relation)};`);
    sql.push(`create policy ${ident(p.name)} on ${qualified(p.schema, p.relation)} as ${p.permissive.toLowerCase()} for ${p.command.toLowerCase()} to ${roles}${p.using_expression ? ' using ('+fragment(p.using_expression)+')' : ''}${p.check_expression ? ' with check ('+fragment(p.check_expression)+')' : ''};`);
  }
  for (const t of c.triggers) {
    sql.push(terminate(t.definition));
    const state = { O: 'enable', A: 'enable always', R: 'enable replica', D: 'disable' }[t.enabled];
    assert.ok(state); sql.push(`alter table ${qualified(t.schema, t.relation)} ${state} trigger ${ident(t.name)};`);
  }
  const grants = c.effective_grants.filter(x => ['public', 'app', 'extensions'].includes(x.schema));
  const grantGroups = new Map();
  for (const g of grants) {
    const key = JSON.stringify([g.kind, g.schema, g.relation, g.name, g.arguments]);
    if (!grantGroups.has(key)) grantGroups.set(key, []);
    grantGroups.get(key).push(g);
  }
  for (const rows of grantGroups.values()) {
    const g = rows[0];
    let object;
    if (g.kind === 'column') object = `table ${qualified(g.schema, g.relation)}`;
    else if (g.kind === 'schema') object = `schema ${ident(g.schema)}`;
    else object = `${g.kind === 'relation' ? 'table' : g.kind} ${qualified(g.schema, g.name)}${g.kind === 'function' ? '('+g.arguments+')' : ''}`;
    const roles = [...new Set(['PUBLIC', ...rows.map(x => x.grantee), 'anon', 'authenticated', 'service_role', 'supabase_admin', 'postgres'])];
    if (g.kind !== 'column') sql.push(`revoke all on ${object} from ${roles.map(role).join(',')};`);
    for (const entry of rows) {
      const privilege = fragment(entry.privilege)+(g.kind === 'column' ? ` (${ident(g.name)})` : '');
      sql.push(`grant ${privilege} on ${object} to ${role(entry.grantee)}${entry.grantable ? ' with grant option' : ''};`);
    }
  }
  for (const d of c.default_privileges.filter(x => ['public', 'app'].includes(x.schema))) {
    const object = { r: 'tables', S: 'sequences', f: 'functions', T: 'types' }[d.object_type];
    assert.ok(object);
    const entries = defaultAclEntries(d.acl), prefix = `alter default privileges for role ${ident(d.owner)} in schema ${ident(d.schema)}`;
    sql.push(`${prefix} revoke all on ${object} from ${[...new Set(['PUBLIC', ...entries.map(x => x.grantee)])].map(role).join(',')};`);
    for (const entry of entries) sql.push(`${prefix} grant ${entry.privilege} on ${object} to ${role(entry.grantee)}${entry.grantable ? ' with grant option' : ''};`);
  }
  for (const publication of c.publications) {
    assert.equal(publication.name, 'supabase_realtime'); assert.equal(publication.all_tables, false);
    sql.push('do $publication_guard$ begin if not exists(select 1 from pg_publication where pubname=\'supabase_realtime\') then create publication supabase_realtime; end if; end $publication_guard$;');
    const actions = ['inserts', 'updates', 'deletes', 'truncates'].filter(k => publication[k]).map(x => ({ inserts: 'insert', updates: 'update', deletes: 'delete', truncates: 'truncate' })[x]);
    sql.push(`alter publication supabase_realtime set (publish=${literal(actions.join(', '))}, publish_via_partition_root=${publication.via_partition_root ? 'true' : 'false'});`);
    for (const t of publication.tables) {
      assert.ok(!t.row_filter); assert.equal(t.columns.length, c.columns.filter(x => x.schema === t.schema && x.relation === t.relation).length);
      sql.push(`alter publication supabase_realtime add table ${qualified(t.schema, t.relation)};`);
    }
    sql.push(`alter publication supabase_realtime owner to ${ident(publication.owner)};`);
  }
  for (const bucket of c.storage_buckets) {
    assert.ok(!bucket.public, 'Public Storage buckets require explicit review');
    const mimeTypes = bucket.allowed_mime_types ? `array[${bucket.allowed_mime_types.map(literal).join(',')}]::text[]` : 'null';
    sql.push(`insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values(${literal(bucket.id)},${literal(bucket.id)},false,${bucket.file_size_limit === null ? 'null' : bigint(bucket.file_size_limit)},${mimeTypes}) on conflict(id) do update set public=excluded.public,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;`);
  }
  sql.push('commit;');
  const query = sql.join('\n')+'\n';
  return { query, manifest: { format: 1, sourceProject: productionProject, sourceCapturedAt: document.capturedAt,
    catalogSha256: catalogHash(c), restoreSqlSha256: digest(query), applicationRelations: c.relations.length,
    tables: c.relations.filter(x => x.kind === 'r').length, functions: c.functions.length, policies: c.policies.length,
    triggers: c.triggers.length, clinicalRowsCopied: false, authRowsCopied: false, storageObjectsCopied: false,
    authStorageManagedDDLIncluded: false, migrationHistoryRewritten: false, restoreVerified: false,
    productionApplyAllowed: false, target: 'disposable Docker-local Supabase PostgreSQL 17 only',
    platformDependencies: ['Supabase managed roles', 'auth.users + auth.uid()', 'managed storage.buckets/objects',
      'server/extension versions and managed grants from captured catalog; verify separately'],
    excluded: document.excluded, sourceHistory: c.migration_history } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [input, output, manifestPath] = process.argv.slice(2);
  if (!input || !output || !manifestPath || process.argv.length !== 5) throw new Error('Usage: node scripts/prepare-production-application-baseline.mjs catalog.json output.sql manifest.json');
  const result = prepareProductionApplicationBaseline(JSON.parse(await readFile(input, 'utf8')));
  await writeFile(output, result.query); await writeFile(manifestPath, JSON.stringify(result.manifest, null, 2)+'\n');
  console.log(`Application restore artifact: ${result.manifest.tables} tables; no data, remote execution, or migration-history rewrite.`);
}
