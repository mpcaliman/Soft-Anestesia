/** Regressão C1: nenhuma escrita clínica pode usar "last write wins". */
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
const migration = await readFile(resolve(repo, 'database/migrations/0019_optimistic_concurrency.sql'), 'utf8');

const between = (start, end) => {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  assert.notEqual(a, -1, `início não encontrado: ${start}`);
  assert.notEqual(b, -1, `fim não encontrado: ${end}`);
  return source.slice(a, b);
};

for (const table of ['patients', 'encounters', 'appointments']) {
  assert.match(migration, new RegExp(`alter table public\\.${table} add column if not exists version`, 'i'),
    `${table} precisa de versão explícita`);
}
assert.match(migration, /new\.version\s*:=\s*coalesce\(old\.version,\s*1\)\s*\+\s*1/i,
  'somente o banco deve incrementar a versão');
assert.match(migration, /new\.organization_id is distinct from old\.organization_id/i,
  'o banco deve impedir troca de ambiente');
assert.match(migration, /force row level security/i,
  'as tabelas multi-tenant devem forçar RLS');

const rel = between('const cloudRel = {', '/* FIM DA PERSISTÊNCIA RELACIONAL */');
const atomic = between('  async _gravarAtomico(', '  _aplicarMetaLocal(');
assert.match(atomic, /method:\s*'PATCH'/);
assert.match(atomic, /organization_id=eq\.[\s\S]*legacy_id=eq\.[\s\S]*version=eq\./,
  'UPDATE precisa comparar organização, identidade e versão na mesma requisição');
assert.match(atomic, /return=representation/,
  'o cliente precisa receber a nova versão confirmada pelo banco');
assert.match(atomic, /_inserirSemSobrescrever/,
  'primeira gravação deve usar insert-if-absent');

const insertOnly = between('  async _inserirSemSobrescrever(', '  /* UPDATE condicional');
assert.match(insertOnly, /resolution=ignore-duplicates/,
  'INSERT não pode atualizar silenciosamente uma linha concorrente');

for (const fn of ['enviarPaciente', 'enviarAgenda', 'enviarRegistro']) {
  const start = `  async ${fn}(`;
  const a = rel.indexOf(start);
  assert.notEqual(a, -1, `${fn} não encontrado`);
  const body = rel.slice(a, rel.indexOf('\n  },', a) + 5);
  assert.match(body, /_gravarAtomico\(/, `${fn} deve usar compare-and-swap`);
  assert.doesNotMatch(body, /opts\.force|merge-duplicates|migracaoFase4\._upsert/,
    `${fn} não pode contornar a versão`);
}

assert.match(rel, /_SELECT:\s*'[^']*version[^']*updated_by/,
  'pacientes devem baixar versão e autor');
assert.match(rel, /_AG_SELECT:\s*'[^']*version[^']*updated_by/,
  'agenda deve baixar versão e autor');
assert.match(rel, /_REG_SELECT:\s*'[^']*version[^']*updated_by/,
  'módulos clínicos devem baixar versão e autor');
assert.match(rel, /_relVersion/, 'a versão confirmada precisa acompanhar o cache offline');
assert.doesNotMatch(source, /cloudRel\.enviar(?:Paciente|Agenda|Registro)\([^\n]*force\s*:\s*true/,
  'nenhum chamador pode forçar sobrescrita concorrente');

const deletion = between('  async apagarNaClinica(', '  async drenarFilaDel(');
assert.match(deletion, /version=eq\./,
  'soft-delete também precisa comparar a versão-base');
assert.match(deletion, /return=representation/,
  'soft-delete deve confirmar qual versão foi apagada');
assert.match(deletion, /async restaurarNaClinica\(/,
  'restaurar da lixeira precisa desfazer o soft-delete no banco');
assert.match(deletion, /deleted_at=not\.is\.null[\s\S]*version=eq\.|version=eq\.[\s\S]*deleted_at=not\.is\.null/,
  'restore deve comparar versão e exigir que a linha ainda esteja apagada');
assert.match(deletion, /last_operation_id[\s\S]*last_operation_checksum/,
  'delete e restore precisam de recibo idempotente verificável');
for (const select of ['_SELECT', '_AG_SELECT', '_REG_SELECT']) {
  assert.match(rel, new RegExp(`${select}:\\s*'[^']*deleted_at[^']*last_operation_id`),
    `${select} precisa devolver o estado do soft-delete para validar o recibo`);
}

assert.match(rel, /delete dados\[k\]/,
  'metadados locais de concorrência não devem entrar no JSON clínico');

console.log('  ✓ C1: gravações e exclusões usam versão atômica por organização');
