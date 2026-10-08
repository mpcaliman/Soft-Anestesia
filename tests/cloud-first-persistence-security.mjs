/** Regressão D3b: nuvem primária, WAL cifrado e recibo idempotente. */
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
const migration = await readFile(resolve(here, '../database/migrations/0023_idempotent_cloud_receipts.sql'), 'utf8');
const actionFeedback = await readFile(resolve(root, 'src/ui/action-feedback.js'), 'utf8');

const between = (start, end) => {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  assert.notEqual(a, -1, `início não encontrado: ${start}`);
  assert.notEqual(b, -1, `fim não encontrado: ${end}`);
  return source.slice(a, b);
};

const engine = between('const persistenciaCloudFirst = {', '\n\n/* FIM DA PERSISTÊNCIA CLOUD-FIRST */');
const newWritePath = between('  async _estagiar(op) {', '\n  _prioridade(op) {');
const legacyMigration = between('  async migrarLegado() {', '\n  async drenar(opts = {}) {');
const mirror = between('  mirror(mod, item) {', '\n\n  async remover(mod, item');
const atomic = between('  async _gravarAtomico(', '\n\n  _aplicarMetaLocal(');
const cloudSync = between('  async sincronizar(opts = {}) {', '\n  /* Remove apenas os cursores');
const contextConfirm = between('  async confirmarContexto() {', '\n\n  _refreshPromise:');

assert.doesNotMatch(newWritePath, /localStorage\.(?:getItem|setItem)/,
  'novas gravações e exclusões não podem usar fila clínica em localStorage');
assert.match(legacyMigration,
  /await persistenciaCloudFirst\._importar(?:Upsert|Delete)[\s\S]*localStorage\.setItem\(cloud\.QUEUE_KEY/,
  'a chave legada só pode ser regravada depois da cópia para o cofre cifrado');
assert.match(engine, /await filaCifrada\.enfileirar/,
  'a mutação precisa ficar durável antes do envio');
assert.match(engine, /_reciboValido[\s\S]*last_operation|_mesmoRecibo/,
  'a remoção local depende do recibo idempotente da própria linha');
assert.match(engine, /_montarRestore[\s\S]*action:\s*'restore'/,
  'restaurar da lixeira precisa ser uma operação cifrada própria');
assert.match(engine, /_ordenar[\s\S]*grupos[\s\S]*lista\[0\]/,
  'prioridade global não pode inverter delete/restore da mesma entidade');
assert.match(mirror, /persistenciaCloudFirst\.salvar\(mod, item\)/);
assert.doesNotMatch(mirror, /_filaPor\(/,
  'gravações novas não podem voltar à fila legada limitada');
assert.match(cloudSync, /persistenciaCloudFirst\.drenar\(\)[\s\S]*cloudRel\.drenarFila\(\)/,
  'reconnect deve drenar o diário cifrado antes do legado');
assert.match(contextConfirm, /await persistenciaCloudFirst\.aquecer\(\)/,
  'a chave offline precisa ser aberta enquanto a sessão ainda está online');
assert.match(actionFeedback, /btn-acao-processando/,
  'clique pode sinalizar processamento sem fingir confirmação da nuvem');
assert.doesNotMatch(actionFeedback,
  /btn-acao-ok|['"](?:Salvo|Atualizado|Feito)['"]|['"]✓ /,
  'sucesso visual não pode nascer do clique; depende do estado real e do recibo');

for (const table of ['patients', 'appointments', 'preanesthetic_assessments',
  'consultations', 'anesthesia_records', 'recovery_records', 'risk_assessments',
  'consents', 'prescriptions', 'documents', 'finance_entries', 'quotes']) {
  assert.match(migration, new RegExp(`['"]${table}['"]`), `${table} sem recibo idempotente`);
}
assert.match(migration, /last_operation_id uuid/);
assert.match(migration, /last_operation_checksum text/);
assert.match(migration, /create unique index if not exists/);
assert.match(migration, /\^\[0-9a-f\]\{64\}\$/);
assert.match(atomic, /_mesmoRecibo\(ins\.row, recibo\)/,
  'retry de INSERT deve reconhecer o recibo já confirmado');
assert.match(atomic, /_mesmoRecibo\(atual, recibo\)/,
  'retry de PATCH deve reconhecer resposta perdida sem criar conflito falso');

let generation = 1;
const current = {
  verified: true,
  organizationId: 'aaaaaaaa-1111-4111-8111-111111111111',
  userId: '11111111-1111-4111-8111-111111111111',
  deviceId: 'dev-11111111-1111-4111-8111-111111111111',
  tabId: 'tab-a'
};
const snapshot = () => Object.freeze({ ...current, generation });
const listeners = [];
const contextoAba = {
  capturar: snapshot,
  corresponde: ctx => !!ctx && ctx.generation === generation &&
    ctx.organizationId === current.organizationId && ctx.userId === current.userId,
  aoMudar: fn => listeners.push(fn)
};

const queue = new Map();
let uuidN = 1;
const stable = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  return '{' + Object.keys(value).sort().filter(k => value[k] !== undefined)
    .map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
};
const filaCifrada = {
  _id() { return `00000000-0000-4000-8000-${String(uuidN++).padStart(12, '0')}`; },
  _erro(code, message, cause) { const e = new Error(message || code); e.code = code; e.cause = cause; return e; },
  _estavel: stable,
  _sha256: async value => createHash('sha256').update(String(value)).digest('hex'),
  _donoKey: dono => JSON.stringify([dono.organizationId, dono.userId, dono.deviceId]),
  async preparar() { return { ownerKey: this._donoKey(current) }; },
  async enfileirar(op) {
    assert.equal(queue.has(op.operationId), false, 'operação de teste não deve colidir');
    const checksum = 'vault-' + op.operationId;
    queue.set(op.operationId, structuredClone({ ...op, checksum }));
    return { ok: true, durable: true, checksum };
  },
  async listar() { return Array.from(queue.values()).map(value => structuredClone(value)); },
  async confirmar(id, receipt) {
    const op = queue.get(id);
    assert.ok(op, 'confirmação aponta para operação existente');
    assert.equal(receipt.remoteConfirmed, true);
    assert.equal(receipt.checksum, op.checksum);
    queue.delete(id);
    return true;
  },
  async registrarFalha(id, error) {
    const op = queue.get(id);
    if (op) op.lastError = String(error && (error.code || error.message) || error);
    return !!op;
  }
};

const navigator = { onLine: true };
const status = [];
const syncStatus = {
  cloudSyncing: () => status.push('syncing'),
  cloudDone: ok => status.push(ok ? 'synced' : 'pending'),
  cloudState: state => status.push(state),
  refresh: () => {}
};
const cloud = { servidorFora: () => false };
const conflitos = [];
const pacientes = { _resolverConflito: (...x) => conflitos.push(x) };
const agenda = { _resolverConflito: (...x) => conflitos.push(x) };
const addendaConfirmed = [];
const adendos = {
  async enviarOperacao(op) {
    const ad = op.payload.adendo;
    return { ok: true, row: {
      organization_id: current.organizationId, legacy_id: ad.id,
      parent_legacy_id: op.payload.parentLegacyId,
      texto: ad.texto, reason: ad.motivo || 'correcao',
      author_id: current.userId, created_at: '2026-10-07T14:00:00Z'
    } };
  },
  confirmarOperacao(op, row) { addendaConfirmed.push([op.entityId, row.legacy_id]); }
};
const migracaoFase4 = {
  _ident: item => ({ nome: item.nome || (item.paciente && item.paciente.nome) || '' }),
  _patKey: id => id && id.nome ? 'pat:' + id.nome.toLowerCase() : '',
  _encKey: (pat, item) => pat ? pat + ':' + String(item.data || '') : ''
};

let mode = 'success';
let sends = 0;
const remote = new Map();
const cloudRel = {
  MODOS: { pre: { enc: true } },
  suportaModulo: mod => ['pre', 'pacientes', 'agenda'].includes(mod),
  tabelaDoModulo: mod => mod === 'pacientes' ? 'patients' : mod === 'agenda' ? 'appointments' :
    mod === 'pre' ? 'preanesthetic_assessments' : null,
  _versao: item => Number.isInteger(Number(item && item._relVersion)) ? Number(item._relVersion) : null,
  chaveLegada: (_mod, item) => item && item._id || '',
  _normalizarOperacao: op => op && op.id && op.checksum ? op : null,
  _mesmoRecibo(row, op) {
    return !!row && !!op && row.last_operation_id === op.id && row.last_operation_checksum === op.checksum;
  },
  disponivel: () => navigator.onLine,
  registrarConflito: (...x) => conflitos.push(x),
  _resolverConflitoRegistro: (...x) => conflitos.push(x),
  async enviarPaciente(item, opts) { return this.enviarRegistro('pacientes', item, opts); },
  async enviarAgenda(item, opts) { return this.enviarRegistro('agenda', item, opts); },
  async enviarRegistro(_mod, item, opts) {
    sends++;
    assert.equal(queue.size > 0, true, 'WAL cifrado deve existir antes do fetch');
    const op = opts.operation;
    const existing = remote.get(item._id);
    if (existing && this._mesmoRecibo(existing, op)) {
      return { ok: true, replayed: true, row: structuredClone(existing) };
    }
    if (mode === 'outage') return { ok: false, motivo: 'rede' };
    if (mode === 'forbidden') return { ok: false, motivo: 'http 403' };
    if (mode === 'conflict') return { ok: false, conflict: true, motivo: 'versao_divergente',
      cloud: { _id: item._id, nome: 'Versão remota' }, cloudUpdatedAt: '2026-10-07T13:00:00Z' };
    const row = {
      organization_id: current.organizationId, legacy_id: item._id, version: 2,
      last_operation_id: op.id, last_operation_checksum: op.checksum
    };
    remote.set(item._id, structuredClone(row));
    if (mode === 'lost-response') return { ok: false, motivo: 'rede' };
    return { ok: true, row };
  },
  async apagarNaClinica(_table, legacyId, ctx) {
    return { ok: true, row: {
      organization_id: current.organizationId, legacy_id: legacyId, version: 2,
      deleted_at: '2026-10-07T13:30:00Z',
      last_operation_id: ctx.operation.id, last_operation_checksum: ctx.operation.checksum
    } };
  },
  async restaurarNaClinica(_table, legacyId, _item, ctx) {
    return { ok: true, row: {
      organization_id: current.organizationId, legacy_id: legacyId, version: 3,
      deleted_at: null,
      last_operation_id: ctx.operation.id, last_operation_checksum: ctx.operation.checksum
    } };
  }
};

const sandbox = {
  console, Set, Map, Date, JSON, Promise, structuredClone,
  navigator, contextoAba, filaCifrada, cloudRel, migracaoFase4,
  syncStatus, cloud, pacientes, agenda, adendos
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(`${engine}\nglobalThis.__engine = persistenciaCloudFirst;`, sandbox);
const persistence = sandbox.__engine;

assert.equal(persistence._reciboValido({
  contexto: snapshot(),
  payload: { transport: 'cloud-rel-v1', action: 'delete', legacyId: 'nunca-subiu' }
}, { ok: true, ausente: true }), true,
'delete de linha remotamente ausente deve encerrar o WAL em vez de ficar bloqueado para sempre');

const ordemCausal = persistence._ordenar([
  { module: 'pre', entityId: 'mesmo', action: 'restore', createdAt: '2026-10-07T10:00:02Z', operationId: '3' },
  { module: 'pacientes', entityId: 'outro', action: 'upsert', createdAt: '2026-10-07T10:00:03Z', operationId: '4' },
  { module: 'pre', entityId: 'mesmo', action: 'upsert', createdAt: '2026-10-07T10:00:00Z', operationId: '1' },
  { module: 'pre', entityId: 'mesmo', action: 'delete', createdAt: '2026-10-07T10:00:01Z', operationId: '2' }
]).filter(op => op.entityId === 'mesmo').map(op => op.action);
assert.deepEqual(Array.from(ordemCausal), ['upsert', 'delete', 'restore']);

/* Online: primeiro WAL, depois nuvem, depois recibo remove a cópia local. */
mode = 'success';
const online = await persistence.salvar('pre', {
  _id: 'pre-online', _relVersion: 1, nome: 'Paciente A', data: '2026-10-07'
});
assert.equal(online.ok, true);
assert.equal(online.remoteConfirmed, true);
assert.equal(queue.size, 0);
assert.equal(persistence.temPendente('pre', 'pre-online'), false);

/* Restaurar não pode ser apenas reintroduzir o objeto na memória: primeiro
   nasce um WAL `restore`, depois o soft-delete remoto volta a NULL e o recibo
   exato remove a intenção cifrada. */
const restored = await persistence.restaurar('pre', {
  _id: 'pre-restored', _relVersion: 2, _relOrg: current.organizationId,
  nome: 'Paciente Restaurado', data: '2026-10-07'
});
assert.equal(restored.ok, true);
assert.equal(restored.remoteConfirmed, true);
assert.equal(restored.row.deleted_at, null);
assert.equal(queue.size, 0);

/* Resposta perdida: a operação permanece; reconnect usa o MESMO UUID/checksum
   e reconhece a linha que o servidor já havia confirmado. */
mode = 'lost-response';
const lost = await persistence.salvar('pre', {
  _id: 'pre-lost', _relVersion: 1, nome: 'Paciente B', data: '2026-10-07'
});
assert.equal(lost.ok, false);
assert.equal(lost.queued, true);
assert.equal(queue.size, 1);
const sentBeforeDrain = sends;
mode = 'success';
const drained = await persistence.drenar();
assert.equal(drained.enviados, 1);
assert.equal(sends, sentBeforeDrain + 1);
assert.equal(queue.size, 0, 'recibo repetido deve retirar a WAL sem duplicar');

/* Falha de autorização não pode ser rotulada como falta de internet. A única
   cópia continua cifrada e bloqueada para correção/reautenticação. */
mode = 'forbidden';
const forbidden = await persistence.salvar('pre', {
  _id: 'pre-forbidden', _relVersion: 1, nome: 'Paciente C', data: '2026-10-07'
});
assert.equal(forbidden.queued, false);
assert.equal(forbidden.blocked, true);
assert.equal(forbidden.durable, true);
assert.equal(queue.size, 1);

/* Offline confirmado não tenta fetch e deixa a operação no cofre. */
navigator.onLine = false;
const beforeOffline = sends;
const offline = await persistence.salvar('pre', {
  _id: 'pre-offline', _relVersion: 1, nome: 'Paciente D', data: '2026-10-07'
});
assert.equal(offline.queued, true);
assert.equal(offline.durable, true);
assert.equal(sends, beforeOffline);
navigator.onLine = true;

/* Conflito mantém os dois lados e não apaga a operação sem recibo. */
mode = 'conflict';
const conflict = await persistence.salvar('pre', {
  _id: 'pre-conflict', _relVersion: 1, nome: 'Paciente E', data: '2026-10-07'
});
assert.equal(conflict.blocked, true);
assert.equal(conflict.queued, false);
assert.equal(conflitos.length > 0, true);
assert.equal(queue.size, 3);

/* Adendo de prontuário finalizado usa o MESMO WAL cifrado antes do INSERT
   append-only; não pode ficar apenas na memória quando a rede cai. */
mode = 'success';
const addendum = await persistence.salvarAdendo('pre', {
  _id: 'pre-finalizado', _relOrg: current.organizationId, _finalizado: true
}, {
  id: 'ad-1', texto: 'Correção auditável', motivo: 'correcao',
  data: '2026-10-07T14:00:00Z', autor: 'Dra. Teste'
}, 'preanesthetic_assessments');
assert.equal(addendum.ok, true);
assert.equal(addendum.remoteConfirmed, true);
assert.deepEqual(addendaConfirmed.at(-1), ['ad-1', 'ad-1']);

navigator.onLine = false;
const addendumOffline = await persistence.salvarAdendo('pre', {
  _id: 'pre-finalizado', _relOrg: current.organizationId, _finalizado: true
}, {
  id: 'ad-2', texto: 'Complemento offline', motivo: 'complementacao',
  data: '2026-10-07T14:10:00Z', autor: 'Dra. Teste'
}, 'preanesthetic_assessments');
assert.equal(addendumOffline.queued, true);
assert.equal(addendumOffline.durable, true);
const queuedAddendum = Array.from(queue.values()).find(op => op.payload.transport === 'cloud-addendum-v1');
assert.ok(queuedAddendum);
assert.equal(persistence._reciboValido({ ...queuedAddendum, contexto: snapshot() }, {
  ok: true,
  row: {
    organization_id: current.organizationId,
    legacy_id: 'ad-2',
    parent_legacy_id: 'pre-finalizado',
    texto: 'Outro texto',
    reason: 'complementacao'
  }
}), false, 'colisão de ID com conteúdo diferente nunca pode confirmar o WAL');
navigator.onLine = true;

console.log('  ✓ D3b: nuvem primária, WAL cifrado, recibo idempotente e falhas honestas');
