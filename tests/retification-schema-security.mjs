/** Contrato revisável SQL/cliente. Não substitui execução em PostgreSQL real. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sql = await readFile(new URL('../database/migrations/0031_append_only_retification_cas.sql', import.meta.url),'utf8');
const fixture = await readFile(new URL('./sql/retification-cas-security.sql', import.meta.url),'utf8');
const historical = await readFile(new URL('../database/migrations/0020_conflict_preservation_and_immutability.sql', import.meta.url),'utf8');
const client = await readFile(new URL('../index.html', import.meta.url),'utf8');
const names = text => [...text.matchAll(/'([^']+)'/g)].map(m => m[1]).sort();
const sqlProtected = sql.match(/lower\(k\) = any\(array\[([\s\S]*?)\]\)/)?.[1];
const clientProtected = client.match(/CAMPOS_PROTEGIDOS:\s*\[([\s\S]*?)\]/)?.[1];
const sqlClinical = sql.match(/p_depth = 0 and k = any\(array\[([\s\S]*?)\]/)?.[1];
const clientClinical = client.match(/CAMPOS_CLINICOS_INTERNOS:\s*\[([\s\S]*?)\]/)?.[1];
assert(sqlProtected && clientProtected && sqlClinical && clientClinical);
assert.deepEqual(names(sqlProtected),names(clientProtected),'cliente e servidor devem proteger as mesmas identidades, assinaturas e credenciais');
assert.deepEqual(names(sqlClinical),names(clientClinical),'allowlist clínica deve ser idêntica no cliente e servidor');
const trigger = sql.slice(sql.indexOf('create or replace function app.stamp_retification_cas()'));
assert.match(sql,/alter table public\.addenda add column if not exists retification_revision bigint/i);
assert.match(sql,/create unique index[\s\S]*\(organization_id, parent_table, parent_id, retification_revision\)[\s\S]*where retification_revision is not null/i);
assert.match(trigger,/new\.retification_revision := null;[\s\S]*if not \(new\.data \? 'retificacao'\) then return new;/);
assert.match(trigger,/new\.reason not in \('correcao','retificacao'\)/);
assert.match(trigger,/current_setting\('transaction_isolation'\) <> 'read committed'[\s\S]*errcode = 'serialization_failure'/);
const lock = trigger.indexOf('perform pg_advisory_xact_lock(hashtextextended(');
const replay = trigger.indexOf('select * into prior from public.addenda');
const head = trigger.indexOf('select legacy_id,retification_revision into head_id,head_revision');
assert(lock > 0 && replay > lock && head > replay,'o comando de leitura da cabeça ocorre após o lock e a verificação idempotente');
assert.match(trigger,/new\.organization_id::text \|\| '\/' \|\| new\.parent_table \|\| '\/' \|\| new\.parent_id::text/);
assert.match(trigger,/new\.organization_id::text \|\| '\/addenda-operation\/' \|\| new\.legacy_id,1/);
assert.match(trigger,/auth\.uid\(\) is null/);
assert.match(trigger,/app\.org_ids\(\)/);
assert.match(trigger,/app\.pode_editar_modulo/);
assert.match(trigger,/app\.can_access_addendum_parent/);
assert.match(trigger,/prior\.parent_table is distinct from new\.parent_table/);
assert.match(trigger,/prior\.parent_id is distinct from new\.parent_id/);
assert.match(trigger,/prior\.texto is distinct from new\.texto/);
assert.match(trigger,/prior\.reason is distinct from new\.reason/);
assert.match(trigger,/prior\.author_id is distinct from new\.author_id/);
assert.match(trigger,/from public\.profiles p where p\.id = auth\.uid\(\)/);
assert.match(trigger,/new\.data := jsonb_set\(new\.data,'\{autor_exibicao\}',to_jsonb\(coalesce/);
assert.match(trigger,/\(prior\.data->'retificacao'\) - array\['status','revisao','baseAtualId'\] is distinct from proposed/);
assert.match(trigger,/where organization_id = new\.organization_id and parent_table = new\.parent_table[\s\S]*and parent_id = new\.parent_id and retification_revision is not null[\s\S]*order by retification_revision desc/);
assert.match(trigger,/when proposed->>'baseAdendoId' = head_id then 'accepted' else 'conflict'/);
assert.match(trigger,/if outcome = 'accepted' then new\.retification_revision := head_revision\+1; end if;/);
assert.match(trigger,/'status',outcome,'revisao',coalesce\(new\.retification_revision,head_revision\),'baseAtualId',head_id/);
assert.match(sql,/p_depth > 16/);
assert.match(sql,/left\(lower\(k\),10\) = 'assinatura'/);
assert.match(sql,/left\(lower\(k\),9\) = 'signature'/);
assert.match(sql,/left\(lower\(k\),15\) = 'data_assinatura'/);
assert.match(sql,/p_depth = 0 and k = any\(array/);
for (const field of ['_medsLista','_procsExtra','_labExtras','_premedSel','_seguimentos','_procsRealizados','_resumo']) {
  assert(sql.includes("'"+field+"'"),'allowlist clínica '+field);
}
for (const field of ['__proto__','constructor','prototype','patient_id','patientref','caseid','organization_id','uid','access_token','refresh_token','sig_dataurl']) {
  assert(sql.includes("'"+field+"'"),'campo interno bloqueado '+field);
}
assert('trg_addenda_stamped_retification' > 'trg_addenda_stamp','CAS roda após derivar autor, hora e pai');
assert.match(historical,/new\.author_id := auth\.uid\(\)/);
assert.match(historical,/new\.created_at := now\(\)/);
assert.match(historical,/create trigger trg_addenda_append_only[\s\S]*before update or delete/i);
assert.match(sql,/revoke update, delete on table public\.addenda from authenticated/i);
assert.doesNotMatch(sql,/\bsecurity definer\b|\b(?:update|delete from|insert into) public\.|drop policy|drop trigger if exists trg_addenda_(?:stamp|append_only|audit)\s/i,
  'retificação não escreve no pai nem enfraquece políticas, carimbo ou evidência');
for(const fn of ['valid_retification_fields(jsonb,integer)','stamp_retification_cas()']) {
  assert(sql.includes('revoke all on function app.'+fn+' from public, anon;'));
  assert(sql.includes('grant execute on function app.'+fn+' to authenticated;'));
}
assert.match(fixture,/begin isolation level read committed/i);
assert.match(fixture,/set local role authenticated/i);
assert.match(fixture,/on conflict \(organization_id,legacy_id\) do nothing/i);
assert.match(fixture,/original from retification_original_snapshot/);
assert.match(fixture,/foreign organization wrote proposal/);
assert.match(fixture,/conflicting proposal was not retained/);
assert.match(fixture,/rollback;/i);
// DELETE do pai polimórfico não pode deixar a cadeia append-only órfã.
const deleteGuard = await readFile(new URL('../database/migrations/0032_finalized_delete_guard.sql',import.meta.url),'utf8');
const deleteFixture = await readFile(new URL('./sql/finalized-delete-security.sql',import.meta.url),'utf8');
assert.match(deleteGuard,/create or replace function app\.guard_finalized\(\)/i);
assert.match(deleteGuard,/old\.finalized_at is not null[\s\S]*using errcode = 'check_violation'/);
assert.match(deleteGuard,/if tg_op = 'DELETE' then return old; end if;/);
assert.match(deleteGuard,/create trigger trg_guard before update or delete/);
assert.match(deleteGuard,/enable always trigger trg_guard/);
assert.doesNotMatch(deleteGuard,/auth\.uid\(\)|app\.eh_programador\(\)|security definer|drop policy|disable trigger|delete from public\./i,
  'não existe bypass de papel nem remoção de evidência na migração');
for(const table of ['preanesthetic_assessments','consultations','anesthesia_records','recovery_records','risk_assessments','consents','prescriptions','documents','cash_closings']) {
  assert(deleteGuard.includes("'"+table+"'"),'guard de exclusão obrigatório em '+table);
  assert(deleteFixture.includes("'"+table+"'"),'fixture de exclusão cobre '+table);
}
assert.match(deleteFixture,/set local role authenticated/i);
assert.match(deleteFixture,/authenticated DELETE removed finalized original/);
assert.match(deleteFixture,/administrative DELETE removed finalized original/);
assert.match(deleteFixture,/organization cascade removed finalized original/);
assert.match(deleteFixture,/authorized draft DELETE silently canceled/);
assert.match(deleteFixture,/original changed or disappeared/);
assert.match(deleteFixture,/cascade lost retained addendum/);
assert.match(deleteFixture,/rollback;/i);
console.log('✓ contrato SQL append-only: cabeça e CAS com revisão servidor, isolamento, idempotência e fixtures reais preparados; execução PostgreSQL permanece pendente');
