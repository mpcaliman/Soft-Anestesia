/** Regressão B1: nenhum dado novo pode usar o canal pessoal sem organização. */
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
const migration = await readFile(resolve(repo, 'database/migrations/0018_stop_legacy_writes.sql'), 'utf8');

const between = (start, end) => {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  assert.notEqual(a, -1, `início não encontrado: ${start}`);
  assert.notEqual(b, -1, `fim não encontrado: ${end}`);
  return source.slice(a, b);
};

assert.doesNotMatch(source, /\/rest\/v1\/documentos(?:\?|['"])/,
  'o app não pode acessar diretamente a tabela pessoal legada');
assert.doesNotMatch(source, /onclick="ambiente\.trazerBackupPessoal\(\)"/,
  'usuário comum não pode forçar importação do legado');

const store = between('const store = {', '/* ============================================================================\n   CARIMBO DE HORA');
assert.doesNotMatch(store, /cloud\.pushDoc\(/,
  'store não pode duplicar novas gravações no canal pessoal');
assert.match(store, /cloudRel\.mirror\(modKey, item\)/,
  'store deve encaminhar gravações ao canal organizacional');
assert.match(store, /cloudRel\.remover\(modKey, prev\)/,
  'remoções também devem usar o canal organizacional');

const legacySentinel = between('  async pushDoc(modulo, item, operacao) {', '  /* ---- Sincronização completa');
assert.match(legacySentinel, /canal_pessoal_encerrado/,
  'API antiga deve recusar explicitamente novas gravações');
assert.doesNotMatch(legacySentinel, /fetch\s*\(/,
  'sentinela do canal antigo não pode fazer I/O');

const drafts = between('const rascunhosSync = {', 'const rascunhos = {');
assert.match(drafts, /['"]\?on_conflict=organization_id,user_id,module,doc_id['"]/,
  'inserção de rascunho deve preservar exatamente a chave organizacional completa');
assert.match(drafts, /fetch\(c\.url \+ '\/rest\/v1\/drafts' \+ filtro \+ select/,
  'filtro composto deve ser aplicado à tabela drafts na requisição real');
assert.match(drafts, /user_id:\s*contexto\.userId[\s\S]*module:\s*mod[\s\S]*doc_id:\s*r\.id/,
  'payload deve usar usuário capturado, módulo e identidade do rascunho');
assert.match(drafts, /linha\.organization_id === org[\s\S]*linha\.user_id === contexto\.userId[\s\S]*linha\.doc_id === r\.id && linha\.module === mod/,
  'recibo deve repetir toda a identidade esperada antes de confirmar sucesso');
assert.match(drafts, /organization_id:\s*org/,
  'payload de rascunho deve carregar a organização autenticada');
assert.doesNotMatch(drafts, /\/rest\/v1\/documentos/,
  'rascunhos não podem retornar ao legado');

const preferences = between('const configSync = {', '/* ============================================================================\n   👨‍💻 PROGRAMADOR');
assert.match(preferences, /\/rest\/v1\/user_preferences\?on_conflict=organization_id,user_id/,
  'preferências devem ser isoladas por organização e usuário');
assert.doesNotMatch(preferences, /cloud\._enviarOp|\/rest\/v1\/documentos/,
  'preferências não podem usar a fila pessoal');

assert.match(migration, /create table if not exists public\.drafts/i);
assert.match(migration, /create table if not exists public\.user_preferences/i);
assert.match(migration, /alter table public\.drafts force row level security/i);
assert.match(migration, /revoke all on table public\.documentos from public, anon, authenticated/i,
  'o banco deve congelar acesso direto ao legado');
assert.match(migration, /if not app\.eh_programador\(\)/i,
  'recuperação excepcional deve validar o programador no servidor');
assert.match(migration, /insert into public\.legacy_access_logs/i,
  'cada leitura excepcional deve gerar auditoria sem conteúdo clínico');

console.log('  ✓ B1: canal pessoal congelado; rascunhos e preferências estão na organização');
