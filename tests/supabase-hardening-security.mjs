import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAppSource } from './helpers/read-app-source.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const appArg = process.argv.find(arg => arg.startsWith('--app-root='));
const appRoot = resolve(repo, appArg ? appArg.slice('--app-root='.length) : '.');

const [migration, indexes, signatureMigration, signatureEdge, accountsEdge, config, app, signatureUi, runbook] =
  await Promise.all([
    readFile(resolve(repo, 'database/migrations/0025_supabase_hardening.sql'), 'utf8'),
    readFile(resolve(repo, 'database/migrations/0026_e1_performance_indexes.sql'), 'utf8'),
    readFile(resolve(repo, 'supabase/migrations/0002_assinaturas_hardening.sql'), 'utf8'),
    readFile(resolve(repo, 'supabase/functions/assinatura/index.ts'), 'utf8'),
    readFile(resolve(repo, 'supabase/functions/contas/index.ts'), 'utf8'),
    readFile(resolve(repo, 'supabase/config.toml'), 'utf8'),
    readAppSource(appRoot),
    readFile(resolve(appRoot, 'src/integrations/signature-digital.js'), 'utf8'),
    readFile(resolve(repo, 'docs/engineering/E1-SUPABASE-HARDENING.md'), 'utf8'),
  ]);

// Histórico aditivo e sem descarte de índices/dados.
assert.doesNotMatch(migration, /^\s*(delete|truncate)\s+/im);
assert.doesNotMatch(indexes, /drop\s+index/i);
assert.match(indexes, /create\s+index\s+concurrently\s+if\s+not\s+exists/gi);
assert.match(indexes, /organization_users\(user_id, organization_id, role\)/i);
assert.doesNotMatch(indexes, /e1_(recovery|risk|consents|prescriptions|documents|consultations|quotes|appointments)_org_idx/i);

// Privilégios e search_path deixam de depender dos defaults do projeto.
assert.match(migration, /revoke create on schema public from public/i);
assert.match(migration, /revoke execute on all functions in schema public from public, anon, authenticated/i);
assert.match(migration, /revoke all on all tables in schema app from public, anon, authenticated/i);
assert.match(migration, /alter default privileges in schema public revoke execute on functions/i);
assert.match(migration, /alter function %I\.%I\(%s\) set search_path = pg_catalog, app, auth, extensions, storage, public/i);
assert.match(migration, /unnest\(coalesce\(p\.proconfig, array\[\]::text\[\]\)\) as config\(setting\)/i);
assert.match(migration, /grant execute on function %s to authenticated/i);

// RLS consolidada: policies antigas que somavam acesso são removidas.
assert.match(migration, /r\.table_name \|\| '_aux_sel'/i);
assert.match(migration, /r\.table_name \|\| '_share_sel'/i);
assert.match(migration, /drop policy if exists appointments_sel/i);
assert.match(migration, /drop policy if exists ou_all/i);
assert.match(migration, /create policy ou_upd[\s\S]*?using[\s\S]*?with check/i);
assert.match(migration, /create policy medregras_upd[\s\S]*?using[\s\S]*?with check/i);
assert.match(migration, /user_id = \(select auth\.uid\(\)\)/i);
assert.match(migration, /app\.pode_ler_registro_modulo/i);
assert.match(migration, /app\.modulos_editaveis_do_papel/i);

// Ambiente/autoria permanecem imutáveis e compartilhamento é uma exceção
// identificada, nunca uma troca silenciosa de organization_id.
assert.match(migration, /new\.organization_id is distinct from old\.organization_id/i);
assert.match(migration, /A autoria original de um registro não pode ser alterada/i);
assert.match(migration, /O usuário vinculado ao registro não pode ser alterado/i);
assert.match(migration, /O papel de um vínculo não pode ser alterado/i);
assert.match(migration, /new\.criado_por := auth\.uid\(\)/i);
assert.match(migration, /A autoria do compartilhamento é imutável/i);
assert.match(migration, /create trigger trg_org_scope before update/i);
assert.match(migration, /app\.compartilhada_para_mim\(organization_id/i);

// Extensões/matview saem do schema exposto, mantendo view security invoker.
assert.match(migration, /alter extension %I set schema extensions/i);
assert.match(migration, /alter materialized view public\.medicamentos_clinicos set schema app/i);
assert.match(migration, /create or replace view public\.medicamentos_clinicos[\s\S]*?with \(security_invoker = true\)/i);
assert.match(migration, /alter function public\.buscar_medicamentos\(text,text,integer,boolean\)[\s\S]*?extensions/i);

// Assinaturas: acesso direto fechado; apenas Edge/service_role, com escopo.
assert.match(signatureMigration, /add column if not exists organization_id uuid/i);
assert.match(signatureMigration, /check \(organization_id is not null\) not valid/i);
assert.match(signatureMigration, /check \(signed_by is not null\) not valid/i);
assert.match(signatureMigration, /assinaturas_org_chain_slot_uidx/i);
assert.match(signatureMigration, /coalesce\(prev_hash, '<root>'\)/i);
assert.match(signatureMigration, /alter view public\.assinaturas_publicas[\s\S]*security_invoker = true/i);
assert.match(signatureMigration, /revoke all on table public\.assinaturas from public, anon, authenticated/i);
assert.match(signatureMigration, /grant select, insert on table public\.assinaturas to service_role/i);

const publicValidationAt = signatureEdge.indexOf('if (op === "validar")');
const protectedGuardAt = signatureEdge.indexOf('const guarda = await exigirClinico');
assert(publicValidationAt >= 0 && protectedGuardAt > publicValidationAt,
  'validação pública deve ocorrer antes do guard das rotas protegidas');
assert.match(signatureEdge, /client\.auth\.getUser\(jwt\)/);
assert.match(signatureEdge, /\.from\("organization_users"\)[\s\S]*?\.eq\("ativo", true\)[\s\S]*?\.in\("role", \["gestor", "anestesiologista"\]\)/);
assert.match(signatureEdge, /organization_id: guarda\.organizationId/);
assert.match(signatureEdge, /signed_by: guarda\.user\.id/);
assert.match(signatureEdge, /\.eq\("organization_id", guarda\.organizationId\)/);
assert.match(signatureEdge, /if \(!isPdf\(pdf\)\)/);
assert.match(signatureEdge, /result\.error\.code !== "23505"/);
assert.match(signatureEdge, /cert_emissor: null/);
assert.doesNotMatch(signatureEdge, /cert_emissor:\s*meta\./);

// Configuração local e UX concordam com o contrato de senha; cadastro é fechado.
assert.match(config, /auto_expose_new_tables = false/);
assert.match(config, /\[auth\][\s\S]*?enable_signup = false/);
assert.match(config, /\[auth\.email\][\s\S]*?enable_signup = false/);
assert.match(config, /minimum_password_length = 12/);
assert.match(config, /password_requirements = "lower_upper_letters_digits_symbols"/);
assert.match(config, /secure_password_change = true/);
assert.match(accountsEdge, /senha\.length < 12/);
assert.match(accountsEdge, /\[\^A-Za-z0-9\]/);
assert.match(app, /validarSenha\(senha\)/);
assert.match(app, /A senha precisa de ao menos 12 caracteres/);

// O adaptador de assinatura usa a sessão da aba, nunca a anon key como bearer
// de uma operação protegida.
const providerStart = signatureUi.indexOf('safeid_cloud: {');
const providerEnd = signatureUi.indexOf('\n    }\n  };', providerStart);
const provider = signatureUi.slice(providerStart, providerEnd);
assert.match(provider, /authorization: 'Bearer ' \+ s\.access_token/);
assert.match(provider, /organization_id: this\._orgAtual\(\)/);
assert.match(signatureUi, /htmlSeguro \? v : AD\.esc\(v\)/);

// O que depende do Supabase hospedado continua explicitamente bloqueado.
assert.match(runbook, /aplicação remota bloqueada por G3/i);
assert.match(runbook, /proteção contra senhas vazadas/i);
assert.match(runbook, /matriz RLS/i);
assert.match(runbook, /Realtime, edição simultânea, fila offline e reconciliação/i);

console.log('✓ E1 Supabase: RLS, privilégios, assinatura, senha e homologação protegidos');
