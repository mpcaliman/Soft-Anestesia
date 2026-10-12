import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { prepareLegacyEmptyStagingBaseline, productionProject, stagingProject } from '../scripts/prepare-legacy-empty-staging-baseline.mjs';

const categories = ['01_relation', '02_columns', '03_constraints_and_fk_dependencies', '04_indexes',
  '05_owned_sequences', '06_triggers', '07_policies', '08_table_grants', '09_column_grants'];
const column = (name, ordinal, type = 'uuid', extra = {}) => ({ ordinal_position: ordinal,
  column_name: name, data_type: type, not_null: true, default_or_generated_expression: null,
  identity_code: '', generated_code: '', collation_schema: null, collation_name: null,
  storage_code: 'p', statistics_target: null, attoptions: null, attislocal: true, attinhcount: 0, ...extra });
function fixture() {
  const catalog = {};
  const put = (table, category, rows) => { catalog[`production.public.${table}.${category}`] = rows.map(row => ({ ...row, total_metadata_rows: rows.length })); };
  for (const table of ['documentos', 'pacientes']) {
    for (const category of categories) put(table, category, []);
    put(table, '01_relation', [{ schema_name: 'public', table_name: table, owner_role: 'postgres',
      relkind: 'r', relpersistence: 'p', relispartition: false, relreplident: 'd', reloptions: null }]);
    put(table, '02_columns', [column('id', 1), column('user_id', 2), column('updated_at', 3, 'timestamp with time zone',
      { default_or_generated_expression: 'now()' })]);
    put(table, '03_constraints_and_fk_dependencies', [{ constraint_name: table + '_pkey',
      constraint_type: 'p', belongs_to_target: true, constraint_table_schema: 'public',
      constraint_table_name: table, constraint_definition: 'PRIMARY KEY (id)',
      convalidated: true, conislocal: true, coninhcount: 0, conparentid: '0' }]);
    put(table, '04_indexes', [{ index_name: table + '_pkey', indisvalid: true, indisready: true,
      indislive: true, indisclustered: false, indisreplident: false, indisexclusion: false,
      reloptions: null, tablespace_name: null, index_definition: `CREATE UNIQUE INDEX ${table}_pkey ON public.${table} USING btree (id)` }]);
    put(table, '07_policies', [{ policy_name: 'source owner policy', permissive: true, command: 'ALL',
      roles: ['authenticated'], using_expression: '(auth.uid() = user_id)', with_check_expression: '(auth.uid() = user_id)' }]);
    put(table, '08_table_grants', [{ grantee_role: 'service_role', privilege_type: 'SELECT', is_grantable: false }]);
  }
  catalog['production.public.documentos.02_columns'][0].identity_code = 'd';
  catalog['production.public.documentos.02_columns'][0].data_type = 'bigint';
  put('documentos', '05_owned_sequences', [{ column_name: 'id', identity_code: 'd',
    dependency_type: 'i', sequence_schema: 'public', sequence_name: 'documentos_id_seq',
    sequence_data_type: 'bigint', sequence_owner_role: 'postgres', seqcycle: false,
    sequence_acl: ['postgres=rwU/postgres', 'service_role=rwU/postgres'] }]);
  put('pacientes', '06_triggers', [{ is_internal: false, function_schema: 'public',
    function_name: 'set_updated_at', function_identity_arguments: '', enabled_code: 'O',
    trigger_definition: 'CREATE TRIGGER set_pacientes_updated_at BEFORE UPDATE ON public.pacientes FOR EACH ROW EXECUTE FUNCTION set_updated_at()' }]);
  catalog['production.public.10_schema_grants'] = [{ total_metadata_rows: 1 }];
  return { capture: { sourceProject: productionProject, catalog }, supplement: {
    sequences: [{ sequence_schema: 'public', sequence_name: 'documentos_id_seq', seqstart: '1',
      seqincrement: '1', seqmin: '1', seqmax: '9223372036854775807', seqcache: '1', seqcycle: false,
      owner_role: 'postgres', sequence_type: 'bigint', total_metadata_rows: 1 }],
    functions: [{ schema_name: 'public', function_name: 'set_updated_at', identity_arguments: '',
      owner_role: 'postgres', security_definer: false, configuration: null, total_metadata_rows: 1,
      acl: '{postgres=X/postgres,service_role=X/postgres}',
      definition: 'CREATE OR REPLACE FUNCTION public.set_updated_at()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$\nbegin new.updated_at = now(); return new; end;\n$function$\n' }]
  } };
}

const { capture, supplement } = fixture();
const prepared = prepareLegacyEmptyStagingBaseline(capture, supplement);
assert.equal(prepared.manifest.targetProject, stagingProject);
assert.equal(prepared.manifest.productionApplyAllowed, false);
assert.equal(prepared.manifest.completeProductionBaseline, false);
assert.equal(prepared.manifest.clinicalRowsCopied, false);
assert.match(prepared.query, /maxvalue 9223372036854775807/);
assert.doesNotMatch(prepared.query, /grant\s+[\s\S]*?\sto\s+"?(?:anon|authenticated)"?\s*;/i);
assert.doesNotMatch(prepared.query, /CREATE UNIQUE INDEX (?:documentos|pacientes)_pkey/);
for (const table of ['documentos', 'pacientes']) {
  assert.ok(prepared.query.includes(`alter table "public"."${table}" force row level security;`));
  assert.ok(prepared.query.includes(`create policy "staging_legacy_channel_frozen" on "public"."${table}" as restrictive for all to "anon", "authenticated" using (false) with check (false);`));
  assert.ok(prepared.query.includes(`revoke all on table "public"."${table}" from public, anon, authenticated;`));
}
assert.ok(prepared.query.indexOf('force row level security;') < prepared.query.lastIndexOf('commit;'));
assert.equal((prepared.query.match(/^commit;/gm) ?? []).length, 1);
assert.match(prepared.query, /lock table auth.users, public.organizations in share mode/);
assert.match(prepared.query, /to_regprocedure\('public\.set_updated_at\(\)'\) is not null/);

function rejected(mutate, pattern) {
  const input = fixture();
  mutate(input);
  assert.throws(() => prepareLegacyEmptyStagingBaseline(input.capture, input.supplement), pattern);
}
assert.throws(() => prepareLegacyEmptyStagingBaseline(capture, supplement, productionProject), /homologação fixa/);
rejected(input => { input.capture.sourceProject = 'unknown'; }, /Fonte/);
rejected(input => { delete input.capture.catalog['production.public.documentos.09_column_grants']; }, /Categoria.*ausente/);
rejected(input => { input.capture.catalog['production.public.documentos.02_columns'][0].total_metadata_rows = 99; }, /truncada/);
rejected(input => { input.capture.catalog['production.public.documentos.01_relation'] = []; }, /exatamente uma vez/);
rejected(input => { input.supplement.sequences[0].seqmax = Number('9223372036854775807'); }, /texto/);
rejected(input => { input.supplement.sequences[0].seqmax = '9223372036854776000'; }, /fora de bigint/);
rejected(input => { input.supplement.sequences = []; }, /somente a sequência/);
rejected(input => { input.supplement.functions = []; }, /somente o helper/);
rejected(input => { input.supplement.functions[0].security_definer = true; }, /privilegiado/);
rejected(input => { input.supplement.functions[0].definition = input.supplement.functions[0].definition.replace('new.updated_at = now();', "perform pg_read_file('secret');"); }, /input did not match|match the regular expression/i);
rejected(input => { input.capture.catalog['production.public.pacientes.02_columns'][0].default_or_generated_expression = 'arbitrary_helper()'; }, /Default/);
rejected(input => { input.capture.catalog['production.public.documentos.03_constraints_and_fk_dependencies'][0].belongs_to_target = false; }, /FK de entrada/);
rejected(input => { input.capture.catalog['production.public.documentos.03_constraints_and_fk_dependencies'][0].constraint_definition += '; drop table public.patients'; }, /outra instrução/);
rejected(input => { input.capture.catalog['production.public.pacientes.07_policies'][0].using_expression += '; select arbitrary()'; }, /outra instrução/);
rejected(input => { input.capture.catalog['production.public.pacientes.09_column_grants'] = [{ total_metadata_rows: 1 }]; }, /ACL de coluna/);
// Durable metadata artifacts must reproduce the transaction that was actually
// applied to staging, so a future generator change cannot silently alter it.
const base = new URL('../docs/engineering/', import.meta.url);
const [captureText, supplementText, appliedSql, manifestText] = await Promise.all([
  readFile(new URL('LEGACY-TABLE-CATALOG-2026-10-10.json', base), 'utf8'),
  readFile(new URL('LEGACY-TABLE-CATALOG-SUPPLEMENT-2026-10-10.json', base), 'utf8'),
  readFile(new URL('LEGACY-EMPTY-STAGING-BASELINE-2026-10-10.sql', base), 'utf8'),
  readFile(new URL('LEGACY-EMPTY-STAGING-BASELINE-2026-10-10.manifest.json', base), 'utf8')
]);
const actualManifest = JSON.parse(manifestText);
const hash = value => createHash('sha256').update(value).digest('hex');
assert.equal(hash(captureText), actualManifest.captureSha256);
assert.equal(hash(supplementText), actualManifest.supplementSha256);
assert.equal(hash(appliedSql), actualManifest.appliedSha256);
assert.equal(actualManifest.productionApplyAllowed, false);
assert.equal(actualManifest.completeProductionBaseline, false);
const replay = prepareLegacyEmptyStagingBaseline(JSON.parse(captureText), JSON.parse(supplementText));
assert.equal(replay.query, appliedSql, 'Catálogo versionado deve reproduzir byte a byte a transação de staging');
assert.deepEqual(replay.manifest.tables, actualManifest.tables);
console.log('✓ baseline legado exige catálogo completo, bigint sem perda e helper puro; cria somente staging vazio com RLS e veto a clientes na mesma transação');
