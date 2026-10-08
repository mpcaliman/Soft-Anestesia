/** Regressão B2: legado sem organização fica em quarentena até decisão auditada. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAppSource } from './helpers/read-app-source.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const rootArg = process.argv.find(arg => arg.startsWith('--app-root='));
const appRoot = rootArg ? resolve(process.cwd(), rootArg.slice('--app-root='.length)) : repo;
const source = await readAppSource(appRoot);
const migration = await readFile(
  resolve(repo, 'database/migrations/0024_legacy_quarantine_migration.sql'),
  'utf8'
);

const between = (text, start, end) => {
  const a = text.indexOf(start);
  const b = text.indexOf(end, a + start.length);
  assert.notEqual(a, -1, `início não encontrado: ${start}`);
  assert.notEqual(b, -1, `fim não encontrado: ${end}`);
  return text.slice(a, b);
};

/* Nenhum usuário comum pode carimbar a clínica no acervo local órfão. */
const claim = between(source, '  reivindicar() {', '\n  dispensarLegado()');
assert.match(claim, /return 0;/, 'sentinela deve recusar adoção local');
assert.doesNotMatch(claim, /setItem|removeItem|cofre\._decidir/,
  'adoção local não pode mover, apagar ou marcar o acervo');
const decision = between(source, '  _decidirLegado() {', '\n  },\n\n  /* CONSERTO');
assert.doesNotMatch(decision, /cofre\.reivindicar|cofre\.dispensarLegado/,
  'modal comum não pode classificar nem dispensar a origem');
assert.match(source, /somente o programador pode associá-lo a uma clínica com auditoria/i);

/* Inventário persiste somente metadados e mantém o payload dentro do banco. */
assert.match(migration, /create table if not exists public\.legacy_document_registry/i);
assert.match(migration, /source_hash\s+text not null/i);
assert.match(migration, /source_bytes\s+bigint not null/i);
assert.doesNotMatch(
  between(migration,
    'create table if not exists public.legacy_document_registry',
    'create index if not exists legacy_registry_status_idx'),
  /\bdados\b\s+jsonb/i,
  'registro operacional não deve duplicar conteúdo clínico'
);
assert.match(migration, /app\.legacy_json_hash\(coalesce\(d\.dados::jsonb/i,
  'inventário deve calcular SHA-256 no servidor');
assert.match(migration, /octet_length\(coalesce\(d\.dados::jsonb/i,
  'inventário deve registrar tamanho sem retornar o payload');
const listSignature = between(
  migration,
  'create or replace function public.prog_list_legacy_documents',
  '\nlanguage plpgsql'
);
assert.match(listSignature, /source_ref text/i);
assert.doesNotMatch(listSignature, /source_doc_id text/i,
  'listagem da tela deve trocar o identificador original por referência opaca');

/* Todas as tabelas operacionais são programador-only, inclusive com FORCE RLS. */
assert.match(migration, /alter table public\.%I force row level security/i);
assert.match(migration, /using \(app\.eh_programador\(\)\)/i);
assert.match(migration, /revoke all on table public\.%I from public, anon, authenticated/i);
for (const rpc of [
  'prog_inventory_legacy_documents',
  'prog_legacy_migration_summary',
  'prog_list_legacy_documents',
  'prog_classify_legacy_documents',
  'prog_copy_legacy_documents',
  'prog_validate_legacy_documents',
  'prog_rollback_legacy_documents',
  'prog_ack_legacy_source_change'
]) {
  const bodyStart = `create or replace function public.${rpc}`;
  const body = between(migration, bodyStart, '\n$fn$;');
  assert.match(body, /if not app\.eh_programador\(\)/i,
    `${rpc} deve revalidar o programador no servidor`);
}

/* Associação é manual, sem inferência por vínculo atual ou primeira clínica. */
const classify = between(
  migration,
  'create or replace function public.prog_classify_legacy_documents',
  '\n$fn$;'
);
assert.match(classify, /p_registry_ids uuid\[\]/i);
assert.match(classify, /p_org uuid/i);
assert.match(classify, /char_length\(btrim\(coalesce\(p_reason/i);
assert.doesNotMatch(classify, /organization_users|app\.org_ids|limit 1/i,
  'classificação não pode deduzir clínica pelos vínculos atuais');
assert.match(classify, /action, previous_status[\s\S]*'classify'/i,
  'cada classificação deve gerar evento auditável');

/* Cópia é aditiva/idempotente, confere a fonte e bloqueia colisão divergente. */
const copy = between(
  migration,
  'create or replace function public.prog_copy_legacy_documents',
  '\n$fn$;'
);
assert.match(copy, /v_source_hash <> v_row\.source_hash/i);
assert.match(copy, /on conflict \(organization_id, legacy_id\) do nothing/i);
assert.match(copy, /target_hash_conflict/i);
assert.match(copy, /v_lookup_legacy := case when v_row\.target_table = 'patients'[\s\S]*legacy_patient_key/i,
  'paciente existente também deve passar pelo pré-check de identidade e hash');
assert.match(copy, /v_patient\.out_hash <> v_source_hash[\s\S]*legacy_patient_changed_during_copy/i,
  'colisão concorrente de paciente não pode ser adotada silenciosamente');
assert.match(copy, /source_module <> 'agenda'[\s\S]*legacy_patient_key\(v_source\) is null[\s\S]*legacy_patient_identity_missing/i,
  'módulo dependente não deve criar linha sem identidade mínima do paciente');
assert.match(copy, /app\.legacy_is_finalized\(v_source\)[\s\S]*finalized_at/i,
  'registro finalizado no legado deve permanecer finalizado/imutável no relacional');
assert.match(copy, /target_finalization_mismatch/i,
  'destino editável não pode ser aceito para uma origem já finalizada');
assert.doesNotMatch(copy, /do update\s+set\s+data/i,
  'cópia não pode sobrescrever payload de destino');
assert.match(copy, /rollback_deadline = clock_timestamp\(\) \+ make_interval/i);

const validate = between(
  migration,
  'create or replace function public.prog_validate_legacy_documents',
  '\n$fn$;'
);
assert.match(validate, /v_target_version is distinct from v_row\.target_version[\s\S]*target_version_changed/i,
  'validação deve rejeitar qualquer edição ocorrida depois da cópia');
assert.match(validate, /else\s+v_target_hash := app\.legacy_json_hash\(v_target_data\)/i,
  'hash do paciente também deve ser validado, não apenas módulos dependentes');
assert.match(validate, /deleted_at is null for share/i,
  'validação deve manter leitura consistente contra edição simultânea');

/* Origem nunca é alterada e a reversão é recuperável/condicionada. */
assert.doesNotMatch(migration, /delete\s+from\s+public\.documentos\b/i);
assert.doesNotMatch(migration, /update\s+public\.documentos\b/i);
assert.doesNotMatch(migration, /insert\s+into\s+public\.documentos\b/i);
assert.match(migration, /revoke all on table public\.documentos from public, anon, authenticated/i);
assert.match(migration, /revoke all on function public\.prog_read_legacy_documents\(uuid, integer, integer\)[\s\S]*from public, anon, authenticated/i,
  'RPC transitório que retornava JSON clínico deve deixar de ser executável pelo app');
const rollback = between(
  migration,
  'create or replace function public.prog_rollback_legacy_documents',
  '\n$fn$;'
);
assert.match(rollback, /v_hash <> v_map\.copied_hash or v_version <> v_map\.copied_version/i,
  'reversão deve parar se alguém editou depois da cópia');
assert.match(rollback, /set deleted_at = clock_timestamp\(\)/i,
  'reversão deve usar soft-delete recuperável');
assert.match(rollback, /v_finalized_at is not null[\s\S]*target_finalized_immutable/i,
  'reversão não pode alterar prontuário finalizado');
assert.match(rollback, /v_map\.table_name in \('patients','encounters'\)[\s\S]*legacy_dependency_count/i,
  'paciente/atendimento com dependentes não pode ser ocultado');
assert.doesNotMatch(rollback, /delete\s+from/i, 'reversão automática não pode apagar fisicamente');

/* A tela expõe o fluxo completo sem abrir o JSON clínico. */
assert.match(source, /Migração segura do legado/);
assert.match(source, /id="prog-legado-org">\$\{opcoesOrgEscolha\}/,
  'seletor de organização deve começar sem clínica padrão');
for (const rpc of [
  'prog_inventory_legacy_documents', 'prog_classify_legacy_documents',
  'prog_copy_legacy_documents', 'prog_validate_legacy_documents',
  'prog_rollback_legacy_documents'
]) {
  assert.match(source, new RegExp(`_rpc\\('${rpc}'`));
}
assert.doesNotMatch(source, /_rpc\('prog_read_legacy_documents'/,
  'UI operacional não deve baixar conteúdo clínico legado');
assert.doesNotMatch(source, /r\.source_doc_id/,
  'UI não deve renderizar nem o identificador original da linha');

/* Computador compartilhado: resposta antiga não atravessa a troca de conta. */
const programmerRequest = between(
  source,
  '  async _req(path, opts = {}) {',
  '\n  _rpc(nome, body) {'
);
assert.match(programmerRequest, /const contextoInicial = contextoAba\.capturar\(\)/);
assert.match(programmerRequest, /contextoAba\.mesmaGeracao\(contextoInicial\)/);
assert.match(programmerRequest, /sessaoAtual[\s\S]*user\.id[\s\S]*=== uidInicial/,
  'a mesma geração não basta: a sessão Supabase também deve manter a identidade');
assert.match(programmerRequest, /const r = await fetch[\s\S]*if \(!mesmoContexto\(\)\) throw erroContexto\(\);[\s\S]*const texto = await r\.text\(\);[\s\S]*if \(!mesmoContexto\(\)\) throw erroContexto\(\);/,
  'requisição deve bloquear a resposta antes e depois de ler o corpo');
assert.match(programmerRequest, /erro\.code = 'contexto_trocado'/);

console.log('  ✓ B2: legado em quarentena, classificação manual, cópia validada e reversível');
