/** Regressão D3c: reconciliação offline, dependências, deletes e observabilidade. */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAppSource } from './helpers/read-app-source.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const rootArg = process.argv.find(arg => arg.startsWith('--app-root='));
const root = rootArg ? resolve(process.cwd(), rootArg.slice('--app-root='.length)) : resolve(here, '..');
const source = await readAppSource(root);

const between = (start, end) => {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  assert.notEqual(a, -1, `início não encontrado: ${start}`);
  assert.notEqual(b, -1, `fim não encontrado: ${end}`);
  return source.slice(a, b);
};

const vault = between('const filaCifrada = {', '\n\n/* FIM DA PLATAFORMA DE CONTEXTO E FILA OFFLINE */');
const storeSource = between('const store = {', '/* ============================================================================\n   CARIMBO DE HORA');
const deleteCloud = between('  async apagarNaClinica(', '\n  async drenarFilaDel()');
const engine = between('const persistenciaCloudFirst = {', '\n\n/* FIM DA PERSISTÊNCIA CLOUD-FIRST */');
const migration = between('  async migrarLegado() {', '\n  async drenar(opts = {}) {');

assert.match(vault, /DB_VERSION:\s*3/);
assert.match(vault, /STORE_META:\s*'metadata'/);
assert.match(vault, /STORE_SNAPSHOTS:\s*'snapshots'/);
assert.match(vault, /getMeta:[\s\S]*putMeta:/);
assert.match(vault, /putSnapshot:[\s\S]*listSnapshots:/,
  'rascunhos de recuperação precisam usar armazenamento cifrado próprio');
assert.match(source, /id="fila-cifrada-painel"/);
for (const metric of ['resumo.total', 'resumo.maisAntiga', 'resumo.tentativas',
  'resumo.comErro', 'resumo.ultimaConfirmacao', 'resumo.ultimoErro']) {
  assert.match(engine, new RegExp(metric.replace('.', '\\.')), `painel sem ${metric}`);
}

assert.match(storeSource, /persistenciaCloudFirst\.remover\(modKey, prev\)/,
  'delete novo precisa passar pelo WAL cifrado');
assert.match(storeSource, /res\.durable !== false[\s\S]*atuais\.unshift\(prev\)/,
  'delete sem durabilidade deve restaurar a cópia local');
assert.match(deleteCloud, /last_operation_id[\s\S]*last_operation_checksum/,
  'soft-delete precisa gravar o próprio recibo idempotente');
assert.match(engine, /semFilaLegada:\s*true/,
  'delete cifrado não pode duplicar a intenção na fila antiga');

assert.match(engine, /_uuidDeterministico[\s\S]*_importarUpsert[\s\S]*_importarDelete/);
assert.match(migration, /await persistenciaCloudFirst\._importarUpsert[\s\S]*cloudRel\._filaGravar/,
  'upsert legado só sai depois de entrar no cofre');
assert.match(migration, /await persistenciaCloudFirst\._importarDelete[\s\S]*cloudRel\._filaDelGravar/,
  'delete legado só sai depois de entrar no cofre');
assert.match(migration, /restantes:\s*cloudRel\._filaLer\(\)\.length/,
  'resultado deve reler a fila caso a remoção legada falhe');
assert.match(engine, /_prioridade[\s\S]*pacientes[\s\S]*agenda[\s\S]*financeiro/);
assert.match(engine, /versoesConfirmadas[\s\S]*baseVersionOverride/,
  'operações sucessivas do mesmo registro devem encadear a versão confirmada');
assert.match(engine, /_tokensProduzidos[\s\S]*dependenciasFalhas/,
  'falha de paciente\/atendimento deve bloquear dependentes na mesma drenagem');

const stable = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  return '{' + Object.keys(value).sort().filter(k => value[k] !== undefined)
    .map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
};
const sha = async value => createHash('sha256').update(String(value)).digest('hex');
const clone = value => value == null ? value : structuredClone(value);
const owner = {
  verified: true, generation: 1,
  organizationId: 'aaaaaaaa-1111-4111-8111-111111111111',
  userId: '11111111-1111-4111-8111-111111111111',
  deviceId: 'dev-11111111-1111-4111-8111-111111111111', tabId: 'tab-a'
};
const contextoAba = {
  capturar: () => Object.freeze({ ...owner }),
  corresponde: ctx => !!ctx && ctx.generation === owner.generation &&
    ctx.organizationId === owner.organizationId && ctx.userId === owner.userId,
  aoMudar: () => {}
};

const encrypted = new Map();
const failStage = new Set();
const filaCifrada = {
  _id: () => '00000000-0000-4000-8000-000000000001',
  _erro(code, message) { const e = new Error(message || code); e.code = code; return e; },
  _estavel: stable,
  _sha256: sha,
  _donoKey: d => JSON.stringify([d.organizationId, d.userId, d.deviceId]),
  async preparar() { return { ownerKey: this._donoKey(owner) }; },
  async enfileirar(op) {
    if (failStage.has(op.entityId)) throw this._erro('quota', 'sem espaço');
    const checksum = await sha(stable(op));
    const existing = encrypted.get(op.operationId);
    if (existing) {
      if (existing.checksum !== checksum) throw this._erro('colisao_operacao', 'conteúdo diferente');
      return { ok: true, durable: true, duplicate: true, checksum };
    }
    encrypted.set(op.operationId, clone({ ...op, checksum,
      queue: { state: 'staged', attempts: 0, lastError: null, lastAttemptAt: null } }));
    return { ok: true, durable: true, duplicate: false, checksum };
  },
  async listar() { return Array.from(encrypted.values()).map(clone); },
  async marcarEstado(id, state, detail) {
    const op = encrypted.get(id); if (!op) return false;
    op.queue.state = state;
    if (state === 'sending') { op.queue.attempts++; op.queue.lastAttemptAt = new Date().toISOString(); }
    if (detail) op.queue.lastError = String(detail);
    return true;
  },
  async registrarFalha(id, error) {
    const op = encrypted.get(id); if (!op) return false;
    op.queue.lastError = String(error && (error.code || error.message) || error);
    return true;
  },
  async confirmar(id, receipt) {
    const op = encrypted.get(id); if (!op) return false;
    assert.equal(receipt.remoteConfirmed, true);
    assert.equal(receipt.checksum, op.checksum);
    encrypted.delete(id); return true;
  },
  async resumo() { return { total: encrypted.size }; }
};

let relQueue = [];
let delQueue = [];
let personalQueue = [];
let failRelWrite = false;
const records = new Map();
const sent = [];
const failedModules = new Set();
let deleteContext = null;
const cloudRel = {
  MODOS: {
    pre: { tabela: 'preanesthetic_assessments', enc: true },
    anestesia: { tabela: 'anesthesia_records', enc: true },
    financeiro: { tabela: 'finance_entries', enc: true },
    orcamento: { tabela: 'quotes', enc: false }
  },
  suportaModulo(mod) { return ['pacientes','agenda'].includes(mod) || !!this.MODOS[mod]; },
  tabelaDoModulo(mod) {
    if (mod === 'pacientes') return 'patients';
    if (mod === 'agenda') return 'appointments';
    return this.MODOS[mod] && this.MODOS[mod].tabela;
  },
  chaveLegada(mod, item) {
    if (mod === 'pacientes') return migracaoFase4._patKey(migracaoFase4._ident(item));
    return item && item._id || '';
  },
  _versao: item => Number.isInteger(Number(item && item._relVersion)) && Number(item._relVersion) > 0
    ? Number(item._relVersion) : null,
  _mesmoRecibo: (row, op) => !!row && row.last_operation_id === op.id && row.last_operation_checksum === op.checksum,
  _filaLer: () => clone(relQueue),
  _filaGravar(q) { if (failRelWrite) return false; relQueue = clone(q); return true; },
  _filaDelLer: () => clone(delQueue),
  _filaDelGravar(q) { delQueue = clone(q); return true; },
  disponivel: () => true,
  _envioAtivo: () => null,
  esperarEnvio: async () => null,
  registrarConflito: () => {},
  _resolverConflitoRegistro: () => {},
  async enviarPaciente(item, opts) { return this.enviarRegistro('pacientes', item, opts); },
  async enviarAgenda(item, opts) { return this.enviarRegistro('agenda', item, opts); },
  async enviarRegistro(mod, item, opts) {
    sent.push({ mod, version: Number(item && item._relVersion) || null });
    if (failedModules.has(mod)) return { ok: false, motivo: 'http 422' };
    const version = (Number(item && item._relVersion) || 0) + 1;
    return { ok: true, row: {
      organization_id: owner.organizationId, legacy_id: this.chaveLegada(mod, item), version,
      last_operation_id: opts.operation.id, last_operation_checksum: opts.operation.checksum
    } };
  },
  async apagarNaClinica(_table, legacyId, ctx) {
    deleteContext = clone(ctx);
    return { ok: true, row: {
      organization_id: owner.organizationId, legacy_id: legacyId, version: 2,
      last_operation_id: ctx.operation.id, last_operation_checksum: ctx.operation.checksum,
      deleted_at: '2026-10-07T14:00:00.000Z'
    } };
  }
};
const migracaoFase4 = {
  _ident: item => ({ nome: item.nome || item.paciente_nome || '' }),
  _patKey: id => id && id.nome ? 'nome:' + id.nome.toLowerCase() : '',
  _encKey: (pat, item) => pat && item.procedimento
    ? pat + '|' + String(item.data || '') + '|' + String(item.procedimento).toLowerCase() : ''
};
const store = { getById: (mod, id) => clone(records.get(mod + ':' + id) || null) };
const cloud = {
  QUEUE_KEY: 'legacy-personal',
  servidorFora: () => false,
  _fila: () => clone(personalQueue),
  _donoFila: () => clone(owner),
  _filaTodas: () => clone(personalQueue),
  _mesmoDonoFila: () => true
};
const localStorage = {
  setItem(key, value) {
    assert.equal(key, cloud.QUEUE_KEY);
    personalQueue = JSON.parse(value);
  }
};
const syncStatus = { refresh: () => {}, cloudSyncing: () => {}, cloudDone: () => {}, cloudState: () => {} };
const pacientes = { _resolverConflito: () => {} };
const agenda = { _resolverConflito: () => {} };
const navigator = { onLine: true };

const sandbox = {
  console, Set, Map, Date, JSON, Promise, structuredClone,
  contextoAba, filaCifrada, cloudRel, migracaoFase4, store, cloud,
  localStorage, syncStatus, pacientes, agenda, navigator
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(`${engine}\nglobalThis.__engine = persistenciaCloudFirst;`, sandbox);
const persistence = sandbox.__engine;

/* Ordem determinística: identidade, agenda, registro clínico, financeiro e delete. */
const ordered = persistence._ordenar([
  { operationId: '5', module: 'pre', action: 'delete', createdAt: '2026-10-07T10:00:00Z' },
  { operationId: '4', module: 'financeiro', action: 'upsert', createdAt: '2026-10-07T10:00:00Z' },
  { operationId: '3', module: 'anestesia', action: 'upsert', createdAt: '2026-10-07T10:00:00Z' },
  { operationId: '2', module: 'agenda', action: 'upsert', createdAt: '2026-10-07T10:00:00Z' },
  { operationId: '1', module: 'pacientes', action: 'upsert', createdAt: '2026-10-07T10:00:00Z' }
]);
assert.deepEqual(Array.from(ordered, x => x.operationId), ['1','2','3','4','5']);
assert.deepEqual(Array.from(persistence._tokensProduzidos({
  module: 'pre', action: 'upsert', dependsOn: ['patient:nome:ana', 'encounter:caso-1'], payload: { item: {} }
})), ['encounter:caso-1']);

/* Uma falha ao cifrar mantém a entrada antiga; a que coube sai somente depois. */
records.set('pre:ok', { _id: 'ok', nome: 'Ana', procedimento: 'A', data: '2026-10-07', _updatedAt: 'u1' });
records.set('pre:fail', { _id: 'fail', nome: 'Bia', procedimento: 'B', data: '2026-10-07', _updatedAt: 'u1' });
relQueue = [
  { mod: 'pre', id: 'ok', ts: Date.parse('2026-10-07T10:00:00Z') },
  { mod: 'pre', id: 'fail', ts: Date.parse('2026-10-07T10:01:00Z') }
];
failStage.add('fail');
let migrated = await persistence.migrarLegado();
assert.equal(migrated.migradas, 1);
assert.equal(migrated.restantes, 1);
assert.deepEqual(relQueue.map(x => x.id), ['fail']);
assert.equal(encrypted.size, 1);
failStage.clear();
migrated = await persistence.migrarLegado();
assert.equal(migrated.restantes, 0);
assert.equal(relQueue.length, 0);
assert.equal(encrypted.size, 2);

/* Se apagar a fila antiga falhar, a repetição usa o mesmo UUID e não duplica. */
encrypted.clear(); persistence._pendentes.clear();
records.set('pre:retry', { _id: 'retry', nome: 'Caio', procedimento: 'C', data: '2026-10-07', _updatedAt: 'u1' });
relQueue = [{ mod: 'pre', id: 'retry', ts: Date.parse('2026-10-07T11:00:00Z') }];
failRelWrite = true;
migrated = await persistence.migrarLegado();
assert.equal(migrated.restantes, 1);
assert.equal(encrypted.size, 1);
const deterministicId = Array.from(encrypted.keys())[0];
failRelWrite = false;
migrated = await persistence.migrarLegado();
assert.equal(migrated.restantes, 0);
assert.equal(encrypted.size, 1, 'retry da migração não pode duplicar a operação já cifrada');
assert.equal(Array.from(encrypted.keys())[0], deterministicId);

/* Duas edições offline do mesmo registro usam a versão devolvida pela anterior. */
encrypted.clear(); persistence._pendentes.clear(); sent.length = 0;
const first = await persistence._montar('pre', {
  _id: 'same', _relVersion: 1, nome: 'Dora', procedimento: 'D', data: '2026-10-07'
}, { operationId: '10000000-0000-4000-8000-000000000001', createdAt: '2026-10-07T12:00:00Z' });
const second = await persistence._montar('pre', {
  _id: 'same', _relVersion: 1, nome: 'Dora 2', procedimento: 'D', data: '2026-10-07'
}, { operationId: '10000000-0000-4000-8000-000000000002', createdAt: '2026-10-07T12:01:00Z' });
await persistence._estagiar(first);
await persistence._estagiar(second);
const drained = await persistence.drenar();
assert.equal(drained.enviados, 2);
assert.deepEqual(sent.map(x => x.version), [1, 2]);
assert.equal(encrypted.size, 0);

/* Falha do registro que forma o atendimento bloqueia o financeiro dependente. */
sent.length = 0;
const clinical = await persistence._montar('pre', {
  _id: 'clinical', _relVersion: 1, nome: 'Eva', procedimento: 'E', data: '2026-10-07'
}, { operationId: '20000000-0000-4000-8000-000000000001', createdAt: '2026-10-07T13:00:00Z' });
const finance = await persistence._montar('financeiro', {
  _id: 'finance', _relVersion: 1, nome: 'Eva', procedimento: 'E', data: '2026-10-07'
}, { operationId: '20000000-0000-4000-8000-000000000002', createdAt: '2026-10-07T13:01:00Z' });
await persistence._estagiar(clinical);
await persistence._estagiar(finance);
failedModules.add('pre');
const blocked = await persistence.drenar();
failedModules.clear();
assert.equal(blocked.bloqueados, 2);
assert.deepEqual(sent.map(x => x.mod), ['pre'], 'financeiro não deve atravessar dependência clínica bloqueada');
assert.equal(Array.from(encrypted.values()).find(x => x.entityId === 'finance').queue.state, 'blocked');

/* Delete também nasce no WAL e só sai com recibo da própria linha. */
encrypted.clear(); persistence._pendentes.clear(); deleteContext = null;
const deleted = await persistence.remover('agenda', { _id: 'agenda-1', _relVersion: 1, _relOrg: owner.organizationId });
assert.equal(deleted.ok, true);
assert.equal(deleted.remoteConfirmed, true);
assert.equal(deleteContext.semFilaLegada, true);
assert.equal(encrypted.size, 0);

console.log('  ✓ D3c: migração sem perda, ordem causal, deletes cifrados e painel operacional');
