import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const stagingProject = 'yqqrfgbvoexricjdxpis';
export const productionProject = 'zbpbrnalamjrcfbscjkt';
const tables = ['documentos', 'pacientes'];
const categories = ['01_relation', '02_columns', '03_constraints_and_fk_dependencies', '04_indexes',
  '05_owned_sequences', '06_triggers', '07_policies', '08_table_grants', '09_column_grants'];
const digest = value => createHash('sha256').update(value).digest('hex');
const ident = value => '"' + String(value).replaceAll('"', '""') + '"';
const qualified = (schema, name) => `${ident(schema)}.${ident(name)}`;
const statementFragment = value => {
  assert.equal(typeof value, 'string', 'Catálogo SQL deve ser texto');
  assert.ok(value.length && !/[;\u0000]/.test(value), 'Fragmento de catálogo não pode conter outra instrução');
  return value;
};
const integer = value => {
  assert.equal(typeof value, 'string', 'Configuração de bigint deve ser capturada como texto, sem arredondamento JSON');
  assert.match(value, /^-?\d+$/);
  assert.ok(BigInt(value) >= -(2n ** 63n) && BigInt(value) <= 2n ** 63n - 1n, 'Configuração fora de bigint');
  return value;
};

export function prepareLegacyEmptyStagingBaseline(capture, supplement, targetProject = stagingProject) {
  assert.equal(targetProject, stagingProject, 'DDL derivado só pode ter a homologação fixa como alvo');
  assert.equal(capture.sourceProject, productionProject, 'Fonte de catálogo inesperada');
  assert.ok(capture.catalog && typeof capture.catalog === 'object');
  const functions = supplement.functions ?? [];
  const sequences = supplement.sequences ?? [];
  assert.equal(functions.length, 1, 'Complemento deve conter somente o helper de timestamp');
  assert.equal(sequences.length, 1, 'Complemento deve conter somente a sequência identity');
  for (const item of [...functions, ...sequences]) assert.equal(Number(item.total_metadata_rows), 1, 'Complemento truncado');
  const category = (table, name) => {
    const key = `production.public.${table}.${name}`;
    assert.ok(Object.hasOwn(capture.catalog, key), `Categoria de catálogo ausente: ${key}`);
    const rows = capture.catalog[key];
    assert.ok(Array.isArray(rows));
    for (const row of rows) assert.equal(Number(row.total_metadata_rows), rows.length, `Categoria truncada: ${key}`);
    return rows;
  };
  assert.ok(Object.hasOwn(capture.catalog, 'production.public.10_schema_grants'), 'ACL de schema ausente');
  const schemaGrants = capture.catalog['production.public.10_schema_grants'];
  for (const row of schemaGrants) assert.equal(Number(row.total_metadata_rows), schemaGrants.length, 'ACL de schema truncada');
  const sql = [
    '-- Somente homologação vazia yqqrfgbvoexricjdxpis. Nunca aplicar em produção.',
    '-- Estrutura capturada: duas tabelas legadas; zero linhas copiadas ou clínicas atribuídas.',
    '-- Transformação explícita: privilégios de clientes removidos, FORCE RLS e veto restritivo.',
    '-- Isto não estabelece um baseline completo de produção.',
    'begin;', "set local lock_timeout = '5s';", "set local statement_timeout = '60s';",
    'set local search_path = pg_catalog, public, auth;',
    'lock table auth.users, public.organizations in share mode;',
    'do $empty_staging_guard$ begin',
    "  if to_regclass('public.documentos') is not null or to_regclass('public.pacientes') is not null then",
    "    raise exception 'Reconstrução exige as duas tabelas legadas ausentes';", '  end if;',
    "  if to_regprocedure('public.set_updated_at()') is not null then",
    "    raise exception 'Reconstrução não substitui função pública preexistente';", '  end if;',
    '  if exists (select 1 from auth.users) or exists (select 1 from public.organizations)',
    '     or exists (select 1 from public.patients) or exists (select 1 from public.encounters) then',
    "    raise exception 'Reconstrução exige homologação vazia antes das fixtures';", '  end if;',
    'end $empty_staging_guard$;'
  ];
  const recreatedFunctions = new Set();
  const summary = [];
  for (const table of tables) {
    for (const name of categories) category(table, name);
    assert.equal(category(table, '09_column_grants').length, 0, 'ACL de coluna exige derivação adicional');
    const [relation] = category(table, '01_relation');
    assert.equal(category(table, '01_relation').length, 1, 'Relação deve existir exatamente uma vez');
    assert.equal(relation.schema_name, 'public');
    assert.equal(relation.table_name, table);
    assert.equal(relation.relkind, 'r', 'Partições exigem baseline adicional');
    assert.equal(relation.relpersistence, 'p');
    assert.equal(relation.relispartition, false);
    assert.equal(relation.relreplident, 'd', 'Replica identity não padrão exige baseline adicional');
    assert.ok(!relation.reloptions?.length, 'Reloptions exigem revisão adicional');
    assert.equal(relation.owner_role, 'postgres');
    const columns = category(table, '02_columns');
    assert.ok(columns.length > 0);
    const tableSequences = category(table, '05_owned_sequences');
    const columnSql = columns.map((column, index) => {
      assert.equal(column.ordinal_position, index + 1, 'Ordinal de coluna precisa ser contínuo');
      assert.equal(column.attislocal, true);
      assert.equal(column.attinhcount, 0);
      assert.ok(!column.attoptions?.length);
      assert.ok(['bigint', 'uuid', 'text', 'date', 'jsonb', 'timestamp with time zone'].includes(column.data_type),
        `Tipo não revisado: ${column.data_type}`);
      assert.equal(column.generated_code, '', 'Generated column exige baseline adicional');
      const parts = [ident(column.column_name), column.data_type];
      if (column.collation_name) {
        assert.equal(column.collation_schema, 'pg_catalog');
        assert.equal(column.collation_name, 'default');
        parts.push('collate "pg_catalog"."default"');
      }
      if (column.identity_code) {
        assert.ok(['a', 'd'].includes(column.identity_code));
        const source = tableSequences.find(sequence => sequence.column_name === column.column_name);
        assert.ok(source, 'Identity exige configuração da sequência');
        const sequence = sequences.find(item => item.sequence_schema === source.sequence_schema && item.sequence_name === source.sequence_name);
        assert.ok(sequence, 'Identity exige complemento bigint capturado como texto');
        assert.equal(source.dependency_type, 'i');
        assert.equal(source.sequence_schema, 'public');
        assert.equal(source.sequence_data_type, 'bigint');
        assert.equal(source.sequence_owner_role, 'postgres');
        assert.equal(sequence.owner_role, source.sequence_owner_role);
        assert.equal(sequence.sequence_type, source.sequence_data_type);
        assert.equal(sequence.seqcycle, source.seqcycle);
        for (const field of ['seqstart', 'seqincrement', 'seqmin', 'seqcache']) {
          if (Number.isSafeInteger(source[field])) assert.equal(String(source[field]), sequence[field], 'Complemento de sequência diverge do catálogo');
        }
        parts.push(`generated ${column.identity_code === 'a' ? 'always' : 'by default'} as identity (` +
          `sequence name ${qualified(source.sequence_schema, source.sequence_name)} ` +
          `start with ${integer(sequence.seqstart)} increment by ${integer(sequence.seqincrement)} ` +
          `minvalue ${integer(sequence.seqmin)} maxvalue ${integer(sequence.seqmax)} ` +
          `cache ${integer(sequence.seqcache)} ${sequence.seqcycle ? 'cycle' : 'no cycle'})`);
        assert.equal(column.default_or_generated_expression, null);
      } else if (column.default_or_generated_expression !== null) {
        assert.ok(['gen_random_uuid()', 'auth.uid()', 'now()', "'{}'::jsonb"].includes(column.default_or_generated_expression),
          'Default exige função adicional ou expressão ainda não revisada');
        parts.push('default ' + statementFragment(column.default_or_generated_expression));
      }
      if (column.not_null) parts.push('not null');
      return '  ' + parts.join(' ');
    });
    sql.push(`create table ${qualified('public', table)} (\n${columnSql.join(',\n')}\n);`);
    sql.push(`alter table ${qualified('public', table)} owner to "postgres";`);
    for (const column of columns) {
      const storage = { p: 'plain', e: 'external', m: 'main', x: 'extended' }[column.storage_code];
      assert.ok(storage, 'Storage code desconhecido');
      sql.push(`alter table ${qualified('public', table)} alter column ${ident(column.column_name)} set storage ${storage};`);
      if (column.statistics_target !== null && column.statistics_target !== undefined) {
        assert.ok(Number.isInteger(column.statistics_target) && column.statistics_target >= -1 && column.statistics_target <= 10000);
        sql.push(`alter table ${qualified('public', table)} alter column ${ident(column.column_name)} set statistics ${column.statistics_target};`);
      }
    }
    const constraints = category(table, '03_constraints_and_fk_dependencies');
    const indexConstraints = new Set();
    for (const constraint of constraints) {
      assert.equal(constraint.belongs_to_target, true, 'FK de entrada exige reconstrução adicional fora deste escopo');
      assert.equal(constraint.constraint_table_schema, 'public');
      assert.equal(constraint.constraint_table_name, table);
      assert.equal(constraint.convalidated, true);
      assert.equal(constraint.conislocal, true);
      assert.equal(constraint.coninhcount, 0);
      assert.equal(String(constraint.conparentid), '0');
      assert.ok(['p', 'u', 'f', 'c'].includes(constraint.constraint_type));
      if (constraint.constraint_type === 'f') {
        assert.equal(constraint.referenced_table_schema, 'auth');
        assert.equal(constraint.referenced_table_name, 'users');
      }
      sql.push(`alter table ${qualified('public', table)} add constraint ${ident(constraint.constraint_name)} ${statementFragment(constraint.constraint_definition)};`);
      if (['p', 'u'].includes(constraint.constraint_type)) indexConstraints.add(constraint.constraint_name);
    }
    const indexes = category(table, '04_indexes');
    for (const index of indexes) {
      assert.ok(index.indisvalid && index.indisready && index.indislive);
      assert.ok(!index.indisclustered && !index.indisreplident && !index.indisexclusion);
      assert.ok(!index.reloptions?.length && index.tablespace_name === null);
      if (!indexConstraints.has(index.index_name)) sql.push(statementFragment(index.index_definition) + ';');
    }
    for (const name of indexConstraints) assert.ok(indexes.some(index => index.index_name === name), 'Índice de constraint não capturado');
    const triggers = category(table, '06_triggers');
    for (const trigger of triggers.filter(item => !item.is_internal)) {
      assert.equal(trigger.function_schema, 'public');
      assert.equal(trigger.function_name, 'set_updated_at');
      assert.equal(trigger.function_identity_arguments, '');
      const signature = 'public.set_updated_at()';
      if (!recreatedFunctions.has(signature)) {
        const fn = functions.find(item => item.schema_name === 'public' && item.function_name === 'set_updated_at' && item.identity_arguments === '');
        assert.ok(fn, 'Função do trigger exige DDL de catálogo adicional');
        assert.equal(fn.owner_role, 'postgres');
        assert.equal(fn.security_definer, false, 'Trigger privilegiado exige revisão adicional');
        assert.match(fn.definition, /^CREATE OR REPLACE FUNCTION public\.set_updated_at\(\)\s+RETURNS trigger\b/i);
        const functionParts = fn.definition.match(/^CREATE OR REPLACE FUNCTION public\.set_updated_at\(\)\s+RETURNS trigger\s+LANGUAGE plpgsql\s+AS \$function\$([\s\S]*)\$function\$\s*;?\s*$/i);
        assert.ok(functionParts, 'DDL de helper exige revisão adicional');
        assert.ok(fn.configuration === null || Array.isArray(fn.configuration), 'Configuração de função não capturada');
        assert.equal(fn.configuration, null, 'Configuração de função exige revisão adicional');
        // Este helper legado só pode carimbar a linha atual. Qualquer outro
        // comportamento exige revisão explícita, sem substituir por um stub.
        assert.match(functionParts[1], /^\s*begin\s+new\.updated_at\s*:?=\s*now\(\)\s*;\s*return\s+new\s*;\s*end\s*;?\s*$/i);
        sql.push(fn.definition.trim().replace(/;?$/, ';'));
        sql.push('alter function "public"."set_updated_at"() owner to "postgres";');
        sql.push('revoke all on function "public"."set_updated_at"() from public, anon, authenticated;');
        assert.equal(typeof fn.acl, 'string', 'ACL da função não capturada');
        assert.match(fn.acl, /(?:\{|,)service_role=X\/postgres(?:,|\})/);
        sql.push('grant execute on function "public"."set_updated_at"() to "service_role";');
        recreatedFunctions.add(signature);
      }
      assert.equal(trigger.enabled_code, 'O', 'Estado de trigger exige revisão adicional');
      sql.push(statementFragment(trigger.trigger_definition) + ';');
    }
    const policies = category(table, '07_policies');
    for (const policy of policies) {
      assert.ok(['ALL', 'SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(policy.command));
      assert.ok(policy.roles.length > 0 && policy.roles.every(role => ['PUBLIC', 'anon', 'authenticated'].includes(role)));
      for (const expression of [policy.using_expression, policy.with_check_expression]) {
        if (expression !== null) {
          statementFragment(expression);
          assert.equal(expression, '(auth.uid() = user_id)', 'Policy usa dependência ainda não revisada');
        }
      }
      let statement = `create policy ${ident(policy.policy_name)} on ${qualified('public', table)} ` +
        `as ${policy.permissive ? 'permissive' : 'restrictive'} for ${policy.command.toLowerCase()} ` +
        `to ${policy.roles.map(role => role === 'PUBLIC' ? 'public' : ident(role)).join(', ')}`;
      if (policy.using_expression !== null) statement += ` using (${statementFragment(policy.using_expression)})`;
      if (policy.with_check_expression !== null) statement += ` with check (${statementFragment(policy.with_check_expression)})`;
      sql.push(statement + ';');
    }
    // Captured policies are retained as structural evidence, but can never
    // reopen the personal channel, even if someone later grants table access.
    sql.push(`alter table ${qualified('public', table)} enable row level security;`);
    sql.push(`alter table ${qualified('public', table)} force row level security;`);
    sql.push(`create policy "staging_legacy_channel_frozen" on ${qualified('public', table)} as restrictive for all to "anon", "authenticated" using (false) with check (false);`);
    sql.push(`revoke all on table ${qualified('public', table)} from public, anon, authenticated;`);
    sql.push(`revoke all (${columns.map(column => ident(column.column_name)).join(', ')}) on table ${qualified('public', table)} from public, anon, authenticated;`);
    const grants = category(table, '08_table_grants');
    const serviceGrants = grants.filter(grant => grant.grantee_role === 'service_role');
    assert.ok(serviceGrants.length > 0, 'Privilégios administrativos não capturados');
    for (const grant of serviceGrants) {
      assert.ok(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'].includes(grant.privilege_type));
      sql.push(`grant ${grant.privilege_type.toLowerCase()} on table ${qualified('public', table)} to "service_role"${grant.is_grantable ? ' with grant option' : ''};`);
    }
    for (const sequence of tableSequences) {
      sql.push(`revoke all on sequence ${qualified(sequence.sequence_schema, sequence.sequence_name)} from public, anon, authenticated;`);
      assert.ok(sequence.sequence_acl?.some(acl => acl.startsWith('service_role=')), 'ACL administrativa da sequência ausente');
      sql.push(`grant all on sequence ${qualified(sequence.sequence_schema, sequence.sequence_name)} to "service_role";`);
    }
    summary.push({ table: 'public.' + table, columns: columns.length, constraints: constraints.length,
      indexes: indexes.length, userTriggers: triggers.filter(item => !item.is_internal).length,
      sourcePolicies: policies.length, localRowsCopied: 0, organizationInferred: false });
  }
  sql.push("notify pgrst, 'reload schema';", 'commit;', '');
  return { query: sql.join('\n'), manifest: { format: 1, targetProject, sourceProject: productionProject,
    productionApplyAllowed: false, completeProductionBaseline: false, clinicalRowsCopied: false,
    transformations: ['force_rls_on_both_legacy_tables', 'deny_legacy_client_access_in_same_transaction',
      'retain_captured_policies_with_restrictive_client_veto', 'never_restore_client_table_column_or_sequence_grants'],
    tables: summary } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [capturePath, supplementPath, outputPath, targetProject = stagingProject] = process.argv.slice(2);
  assert.ok(capturePath && supplementPath && outputPath, 'Informe catálogo, complemento e saída SQL; nenhum SQL será executado.');
  const [captureText, supplementText] = await Promise.all([readFile(capturePath, 'utf8'), readFile(supplementPath, 'utf8')]);
  const result = prepareLegacyEmptyStagingBaseline(JSON.parse(captureText), JSON.parse(supplementText), targetProject);
  result.manifest.captureSha256 = digest(captureText);
  result.manifest.supplementSha256 = digest(supplementText);
  result.manifest.appliedSha256 = digest(result.query);
  await writeFile(outputPath, result.query);
  await writeFile(outputPath + '.json', JSON.stringify(result.manifest, null, 2) + '\n');
  console.log(JSON.stringify({ output: resolve(outputPath), ...result.manifest }));
}
