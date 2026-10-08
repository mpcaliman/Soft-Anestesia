/** Regressão C2: conflitos, rascunhos e finalizados nunca usam last-write-wins. */
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
  resolve(repo, 'database/migrations/0020_conflict_preservation_and_immutability.sql'),
  'utf8'
);

const between = (text, start, end) => {
  const a = text.indexOf(start);
  const b = text.indexOf(end, a + start.length);
  assert.notEqual(a, -1, `início não encontrado: ${start}`);
  assert.notEqual(b, -1, `fim não encontrado: ${end}`);
  return text.slice(a, b);
};

assert.match(migration, /create table if not exists public\.sync_conflicts/i);
assert.match(migration, /unique\s*\(organization_id,\s*client_conflict_id\)/i,
  'a retentativa de um conflito precisa ser idempotente por ambiente');
assert.match(migration, /alter table public\.sync_conflicts force row level security/i);
for (const policy of ['sync_conflicts_sel', 'sync_conflicts_ins', 'sync_conflicts_upd']) {
  assert.match(migration, new RegExp(`create policy ${policy}[\\s\\S]*?to authenticated`, 'i'),
    `${policy} precisa declarar o papel autenticado`);
}
assert.match(migration, /created_by\s*=\s*\(select auth\.uid\(\)\)/i,
  'conflitos não podem ser vistos ou resolvidos como outro usuário');
assert.match(migration, /new\.proposed_data is distinct from old\.proposed_data/i);
assert.match(migration, /new\.canonical_data is distinct from old\.canonical_data/i,
  'as duas evidências do conflito devem permanecer imutáveis');
assert.match(migration, /revoke delete on table public\.sync_conflicts from authenticated/i);

const finalized = between(migration,
  'create or replace function app.guard_finalized()',
  '-- 5) Rascunhos também participam');
assert.match(finalized, /if old\.finalized_at is not null then[\s\S]*raise exception/i,
  'qualquer atualização posterior à finalização deve ser recusada');
assert.match(finalized, /create or replace function app\.stamp_finalization\(\)/i);
assert.match(finalized, /new\.finalized_at\s*:=\s*now\(\)/i);
assert.match(finalized, /new\.finalized_by\s*:=\s*auth\.uid\(\)/i,
  'horário e autor da finalização devem vir do servidor');
assert.match(finalized, /trg_finalization_stamp before insert or update/i);
assert.match(finalized, /trg_guard before update[\s\S]*app\.guard_finalized\(\)/i,
  'a migração deve reinstalar a proteção mesmo se o ambiente remoto estiver incompleto');

assert.match(migration, /create trigger trg_addenda_append_only[\s\S]*before update or delete/i);
assert.match(migration, /new\.author_id\s*:=\s*auth\.uid\(\)/i);
assert.match(migration, /new\.created_at\s*:=\s*now\(\)/i);
assert.match(migration, /grant select, insert on table public\.addenda to authenticated/i);
assert.match(migration, /revoke update, delete on table public\.addenda from authenticated/i,
  'adendos precisam ser append-only também nos privilégios');

assert.match(migration, /alter table public\.drafts add column if not exists version integer not null default 1/i);
assert.match(migration, /new\.organization_id is distinct from old\.organization_id[\s\S]*new\.user_id is distinct from old\.user_id/i,
  'a identidade e o ambiente do rascunho devem ser imutáveis');
for (const policy of ['drafts_sel', 'drafts_ins', 'drafts_upd', 'drafts_del']) {
  assert.match(migration, new RegExp(`create policy ${policy}[\\s\\S]*?to authenticated`, 'i'),
    `${policy} precisa declarar o papel autenticado`);
}
assert.match(migration, /user_id\s*=\s*\(select auth\.uid\(\)\)/i,
  'cada pessoa só pode acessar os próprios rascunhos');
assert.match(migration, /array\['sync_conflicts','addenda','drafts'\]/i);
assert.match(migration, /alter publication supabase_realtime add table public\.%I/i);
assert.match(migration, /alter table public\.%I replica identity full/i,
  'conflitos, adendos e rascunhos precisam convergir pelo Realtime');

const rel = between(source, 'const cloudRel = {', '/* FIM DA PERSISTÊNCIA RELACIONAL */');
assert.match(source, /CHAVES:\s*\[[\s\S]*'medsys\.v7\.rel\.conflitos'/,
  'conflitos offline precisam usar o armazenamento durável e isolado');
const disco = between(source, 'const disco = {', 'try { window.disco = disco; }');
assert.match(disco, /const chaveDisco = disco\._k\(k, org\)/);
assert.match(disco, /disco\._mem\[chaveDisco\]\s*=\s*v/,
  'o reload precisa hidratar a mesma chave de ambiente usada na gravação');
assert.doesNotMatch(disco, /await disco\._ler\(k\)/,
  'o IndexedDB não pode reler a chave global sem organização');
assert.match(disco, /remove\(chave, org\)[\s\S]*const chaveDisco = disco\._k\(chave, org\)/,
  'a limpeza compartilhada precisa poder apagar a gaveta anterior pelo id');
assert.match(source, /disco\.remove\(k, alvo\)/,
  'trocar de usuário deve remover também o IndexedDB da organização anterior');
const registrar = between(rel, '  registrarConflito(', '  async _enviarConflito(');
assert.ok(registrar.indexOf('cloudRel._conflitoSalvar(entry)') < registrar.indexOf('cloudRel._enviarConflito(entry)'),
  'a evidência local deve ser persistida antes da tentativa de rede');
assert.match(rel, /x\.ownerId === dono \|\| \(gestor && x\.serverVisible\)/,
  'um computador compartilhado não pode exibir conflito local de outro usuário');

const enviarConflito = between(rel, '  async _enviarConflito(', '  async _resolverConflitoServidor(');
assert.match(enviarConflito, /resolution=ignore-duplicates/);
assert.match(enviarConflito, /client_conflict_id=eq\.[\s\S]*select=id,status/,
  'retentativa com resposta perdida precisa confirmar o recibo no servidor');
const resolverConflito = between(rel, '  async _resolverConflitoServidor(', '  resolverConflito(');
assert.ok(resolverConflito.indexOf('if (!confirmado) return false') < resolverConflito.indexOf('_conflitoRemover'),
  'a cópia offline só pode sair depois do recibo de resolução');

const drafts = between(source, 'const rascunhosSync = {', 'const rascunhos = {');
assert.match(drafts, /organization_id=eq\.[\s\S]*user_id=eq\.[\s\S]*module=eq\.[\s\S]*doc_id=eq\.[\s\S]*version=eq\./,
  'PATCH de rascunho precisa comparar toda a identidade e a versão');
assert.match(drafts, /resolution=ignore-duplicates,return=representation/,
  'o primeiro envio do rascunho não pode sobrescrever outro aparelho');
assert.match(drafts, /_preservarConflito\(/,
  'edições simultâneas do rascunho precisam virar duas cópias preservadas');

const storeSave = between(source, '  save(modKey, item)', '  delete(modKey, id)');
assert.match(storeSave, /prevExistente && prevExistente\._finalizado/);
assert.match(storeSave, /adendos\.salvarComoCorrecao/,
  'a defesa central deve converter edição de finalizado em adendo');

console.log('  ✓ C2: conflitos, rascunhos e finalizados ficam preservados por ambiente');
