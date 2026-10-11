/** Contrato SQL: conflitos de todos os rascunhos continuam autorizáveis e imutáveis. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const sql=await readFile(resolve(repo,'database/migrations/0029_cloud_live_draft_modules.sql'),'utf8');
const historical=await readFile(resolve(repo,'database/migrations/0020_conflict_preservation_and_immutability.sql'),'utf8');
const helper=sql.slice(sql.indexOf('create or replace function app.sync_conflict_permission_module'),sql.indexOf('revoke all on function app.sync_conflict_permission_module'));
assert.match(helper,/p_table = 'drafts' and p_module in/);
for(const mod of ['pre','consulta','anestesia','recuperacao','termo','prescricao','risco','documentos','orcamento','financeiro','agenda']) assert(helper.includes("'"+mod+"'"),mod+' plain é aceito nos conflitos de drafts');
assert.match(helper,/when p_table = 'drafts' then app\.draft_permission_module\(p_module\)/);
assert.match(helper,/when p_module = app\.module_for_table\(p_table\) then p_module/);
assert.match(helper,/else null/);
assert.doesNotMatch(helper,/\b(?:substring|replace|split_part)\s*\(|\blike\b/i,'mapeamento não aceita prefixos arbitrários');
assert.match(sql,/conkey @> array\[v_module,v_table\]::smallint\[\]/,'migração só substitui o CHECK composto de tabela e módulo');
assert.match(sql,/check \(app\.sync_conflict_permission_module\(table_name,module\) is not null\)/);
for(const policy of ['sync_conflicts_sel','sync_conflicts_ins','sync_conflicts_upd']) {
 const start=sql.indexOf('create policy '+policy);
 const end=sql.indexOf(';',start);
 const body=sql.slice(start,end);
 assert(start>=0);
 assert.match(body,/organization_id in \(select app\.org_ids\(\)\)/);
 assert.match(body,/created_by = \(select auth\.uid\(\)\)/);
 assert.match(body,/app\.sync_conflict_permission_module\(table_name,module\)/);
 if(policy!=='sync_conflicts_sel') assert.match(body,/app\.pode_editar_modulo/);
 if(policy==='sync_conflicts_upd') assert.match(body,/with check/);
}
assert.doesNotMatch(sql,/drop (?:table|trigger)|alter column.*(?:canonical_data|proposed_data)|delete from public\.sync_conflicts/i);
assert.match(historical,/new\.proposed_data is distinct from old\.proposed_data/);
assert.match(historical,/new\.canonical_data is distinct from old\.canonical_data/);
assert.match(historical,/new\.base_version is distinct from old\.base_version/);
assert.match(historical,/new\.server_version is distinct from old\.server_version/);
const fixture=await readFile(resolve(repo,'tests/sql/live-draft-conflict-security.sql'),'utf8');
assert.match(fixture,/rollback;/i);
assert.match(fixture,/set local role authenticated/i);
assert.match(fixture,/insufficient_privilege/);
assert.match(fixture,/check_violation/);
console.log('✓ CHECK e RLS dos conflitos aceitam drafts live, preservando organização, autor, permissão e ambas as versões');
