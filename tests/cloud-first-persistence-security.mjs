/** Regressão D3b: nuvem primária, WAL cifrado e recibo idempotente. */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createHash, webcrypto } from 'node:crypto';
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
  'a indisponibilidade precisa poder proteger a intenção com cifragem');
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
let durableWrites = 0;
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
    durableWrites++;
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
    if (!persistence.temPendente(_mod, item._id)) {
      assert.equal(Array.from(queue.values()).some(x => x.entityId === item._id), false,
        'online, nenhuma cópia clínica local pode anteceder a tentativa remota');
    }
    const op = opts.operation;
    const existing = remote.get(item._id);
    if (existing && this._mesmoRecibo(existing, op)) {
      return { ok: true, replayed: true, row: structuredClone(existing) };
    }
    if (mode === 'outage') return { ok: false, motivo: 'rede' };
    if (mode === 'forbidden') return { ok: false, motivo: 'http 403' };
    if (mode === 'server-down') return { ok: false, status: 503, motivo: 'temporariamente indisponível' };
    if (mode === 'unexpected') throw new Error('erro interno de programação');
    if (mode === 'conflict') return { ok: false, conflict: true, motivo: 'versao_divergente',
      cloud: { _id: item._id, nome: 'Versão remota' }, cloudUpdatedAt: '2026-10-07T13:00:00Z' };
    const row = {
      organization_id: current.organizationId, legacy_id: item._id, version: 2,
      last_operation_id: op.id, last_operation_checksum: op.checksum
    };
    remote.set(item._id, structuredClone(row));
    if (mode === 'lost-response') return { ok: false, motivo: 'rede' };
    if (mode === 'bad-receipt') return { ok: true, row: { ...row, last_operation_checksum: 'outro' } };
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

/* Online: a operação é enviada e confirmada sem qualquer escrita clínica local. */
mode = 'success';
const online = await persistence.salvar('pre', {
  _id: 'pre-online', _relVersion: 1, nome: 'Paciente A', data: '2026-10-07'
});
assert.equal(online.ok, true);
assert.equal(online.remoteConfirmed, true);
assert.equal(queue.size, 0);
assert.equal(durableWrites, 0, 'sucesso online deve produzir zero escrita no WAL');
assert.equal(persistence.temPendente('pre', 'pre-online'), false);

/* Restaurar online depende do recibo remoto, sem criar uma cópia no aparelho. */
const restored = await persistence.restaurar('pre', {
  _id: 'pre-restored', _relVersion: 2, _relOrg: current.organizationId,
  nome: 'Paciente Restaurado', data: '2026-10-07'
});
assert.equal(restored.ok, true);
assert.equal(restored.remoteConfirmed, true);
assert.equal(restored.row.deleted_at, null);
assert.equal(queue.size, 0);
assert.equal(durableWrites, 0);

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

/* Falha de autorização não é indisponibilidade: intenção só em memória. */
mode = 'forbidden';
const forbidden = await persistence.salvar('pre', {
  _id: 'pre-forbidden', _relVersion: 1, nome: 'Paciente C', data: '2026-10-07'
});
assert.equal(forbidden.queued, false);
assert.equal(forbidden.blocked, true);
assert.equal(forbidden.durable, false);
assert.equal(queue.size, 0);
assert.ok(Array.from(persistence._intencoesMemoria.values()).some(x => x.entityId === 'pre-forbidden'),
  'erro de autorização preserva a intenção transitória sem alegar durabilidade');

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

/* Conflito preserva as duas versões em memória e não inventa persistência offline. */
mode = 'conflict';
const conflict = await persistence.salvar('pre', {
  _id: 'pre-conflict', _relVersion: 1, nome: 'Paciente E', data: '2026-10-07'
});
assert.equal(conflict.blocked, true);
assert.equal(conflict.queued, false);
assert.equal(conflitos.length > 0, true);
assert.equal(conflict.durable, false);
assert.equal(queue.size, 1);

/* Adendo online é append-only remoto. Offline confirmado usa o WAL cifrado. */
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

/* Autorizar uma cópia offline exige indisponibilidade comprovada, não uma
   rejeição de negócio, um recibo incorreto ou um erro de programação. */
assert.equal(persistence.indisponivel(), false);
for (const statusCode of [400, 401, 403, 404, 409, 422]) {
  navigator.onLine = false;
  assert.equal(persistence.indisponivel({ ok: false, status: statusCode }), false,
    `HTTP ${statusCode} explícito não pode autorizar persistência offline`);
}
assert.equal(persistence.indisponivel(), true);
assert.equal(persistence.indisponivel({ conflict: true, motivo: 'versao_divergente' }), false);
navigator.onLine = true;
for (const statusCode of [408, 425, 429, 500, 503, 504]) {
  assert.equal(persistence.indisponivel({ ok: false, status: statusCode }), true);
}
assert.equal(persistence.indisponivel(null, new TypeError('Failed to fetch')), true);
assert.equal(persistence.indisponivel(null, new Error('erro interno')), false);
assert.equal(persistence.indisponivel({ ok: false, motivo: 'token' }), false);

for (const failure of ['unexpected', 'bad-receipt']) {
  mode = failure;
  const writesBefore = durableWrites;
  const result = await persistence.salvar('pre', { _id: failure, _relVersion: 1, nome: 'Em memória' });
  assert.equal(result.ok, false);
  assert.equal(result.durable, false);
  assert.equal(durableWrites, writesBefore, `${failure} não pode criar WAL`);
}
mode = 'server-down';
const serverBefore = durableWrites;
const serverDown = await persistence.salvar('pre', { _id: 'server-down', _relVersion: 1, nome: 'Servidor indisponível' });
assert.equal(serverDown.queued, true);
assert.equal(serverDown.durable, true);
assert.equal(durableWrites, serverBefore + 1);

/* Quota offline preserva a intenção em memória e informa falha; nunca afirma
   proteção quando a transação cifrada não concluiu. */
const oldStage = filaCifrada.enfileirar;
filaCifrada.enfileirar = async () => { throw filaCifrada._erro('quota', 'sem espaço'); };
navigator.onLine = false;
const noSpace = await persistence.salvar('pre', { _id: 'sem-espaco', nome: 'Não confirmado' });
assert.equal(noSpace.durable, false);
assert.equal(noSpace.queued, false);
assert.ok(Array.from(persistence._intencoesMemoria.values()).some(x => x.entityId === 'sem-espaco'));
filaCifrada.enfileirar = oldStage;
navigator.onLine = true;

/* Exercise the real AES-GCM vault with a driver boundary, rather than
   accepting the fake queue's "encrypted" label as proof. Only ciphertext
   operation rows may cross the durable storage boundary after an outage. */
const vaultSource = between('const filaCifrada = {', '\n\n/* FIM DA PLATAFORMA DE CONTEXTO E FILA OFFLINE */');
const envelopesReal = new Map(), operationsReal = new Map(), metadataReal = new Map();
const storageEvents = [];
const copy = value => value == null ? value : structuredClone(value);
const driverReal = {
  getEnvelope: async key => copy(envelopesReal.get(key) || null),
  async addEnvelope(value) { envelopesReal.set(value.ownerKey, copy(value)); return true; },
  getOperation: async key => copy(operationsReal.get(key) || null),
  async addOperation(value) {
    storageEvents.push(['add', copy(value)]);
    assert.ok(value.ciphertext && value.iv, 'a transação offline recebe somente o envelope cifrado');
    assert.equal(Object.hasOwn(value, 'payload'), false);
    assert.doesNotMatch(JSON.stringify(value), /Segredo clínico|Nome confidencial/);
    operationsReal.set(value.operationId, copy(value)); return true;
  },
  listOperations: async ownerKey => Array.from(operationsReal.values()).filter(x => x.ownerKey === ownerKey).map(copy),
  async deleteOperation(key) { storageEvents.push(['delete', key]); operationsReal.delete(key); },
  async updateOperation(key, patch) {
    const value = operationsReal.get(key);
    if (!value) return null;
    storageEvents.push(['update', copy(patch)]);
    const updated = { ...value, ...copy(patch) }; operationsReal.set(key, updated); return copy(updated);
  },
  getMeta: async ownerKey => copy(metadataReal.get(ownerKey) || null),
  async putMeta(value) { metadataReal.set(value.ownerKey, copy(value)); }
};
let realMode = 'success', realSends = 0;
const transportReal = {
  ...cloudRel,
  async enviarRegistro(_mod, item, opts) {
    realSends++;
    if (realMode === 'outage') return { ok: false, motivo: 'rede' };
    if (realMode === 'auth') return { ok: false, status: 403, motivo: 'permissão negada' };
    return { ok: true, row: { organization_id: current.organizationId, legacy_id: item._id,
      version: Number(item._relVersion || 0) + 1,
      last_operation_id: opts.operation.id, last_operation_checksum: opts.operation.checksum } };
  }
};
const realRuntime = {
  console, crypto: webcrypto, TextEncoder, TextDecoder, atob, btoa, Uint8Array, ArrayBuffer,
  Set, Map, Date, JSON, Promise, structuredClone, navigator,
  contextoAba: { ...contextoAba, donoFila: () => snapshot() },
  cloudRel: transportReal, migracaoFase4, syncStatus, cloud, pacientes, agenda
};
realRuntime.window = realRuntime; realRuntime.globalThis = realRuntime;
vm.createContext(realRuntime);
vm.runInContext(`${vaultSource}\n${engine}\nglobalThis.__vault = filaCifrada; globalThis.__transport = persistenciaCloudFirst;`, realRuntime);
const realVault = realRuntime.__vault, realTransport = realRuntime.__transport;
realVault._definirDriverParaTeste(driverReal);
realVault._buscarKekServidor = async () => ({ material: Uint8Array.from({ length: 32 }, (_, i) => i + 1), keyVersion: 1 });
await realVault.preparar();
const realOnline = await realTransport.salvar('pre', { _id: 'real-online', nome: 'Nome confidencial', texto: 'Segredo clínico' });
assert.equal(realOnline.remoteConfirmed, true);
assert.equal(storageEvents.length, 0, 'online o driver não pode receber nem escrita nem remoção de prontuário');
realMode = 'auth';
const realAuth = await realTransport.salvar('pre', { _id: 'real-auth', nome: 'Nome confidencial' });
assert.equal(realAuth.durable, false);
assert.equal(storageEvents.length, 0, 'negação de acesso não autoriza o driver cifrado');
realMode = 'outage';
const realOutage = await realTransport.salvar('pre', { _id: 'real-offline', nome: 'Nome confidencial', texto: 'Segredo clínico' });
assert.equal(realOutage.durable, true);
assert.equal(operationsReal.size, 1);
assert.equal((await realVault.listar())[0].payload.item.texto, 'Segredo clínico');
realMode = 'success';
assert.equal((await realTransport.drenar()).enviados, 1);
assert.equal(operationsReal.size, 0, 'recibo comprovado deve remover a única cópia cifrada');
assert.equal(storageEvents.filter(([event]) => event === 'delete').length, 1);
assert.equal(realSends, 4);

/* A newly online edit must not leap ahead of its older offline intent. The
   old version is confirmed first; the new one uses that causal receipt and
   must not create an additional WAL while the server is available. */
navigator.onLine = false;
await realTransport.salvar('pre', { _id: 'causal-online', _relVersion: 1, nome: 'Primeira edição' });
const writesBeforeCausal = storageEvents.filter(([event]) => event === 'add').length;
navigator.onLine = true;
const causalOnline = await realTransport.salvar('pre', { _id: 'causal-online', _relVersion: 1, nome: 'Segunda edição' });
assert.equal(causalOnline.remoteConfirmed, true);
assert.equal(causalOnline.row.version, 3, 'nova intenção usa o recibo da anterior, sem sobrepor a história');
assert.equal(storageEvents.filter(([event]) => event === 'add').length, writesBeforeCausal);
assert.equal(operationsReal.size, 0);

/* Token-renewal failures must carry the same strict availability semantics.
   In particular, an empty 403 body or an unconfirmed email is not an outage. */
const clientSource = await readFile(resolve(root, 'src/platform/cloud-client.js'), 'utf8');
const authStart = clientSource.indexOf('  _classificarFalhaAuth(r, data) {');
const authEnd = clientSource.indexOf('  /* A última falha', authStart);
const classifyAuth = vm.runInNewContext('({' + clientSource.slice(authStart, authEnd) + '})')._classificarFalhaAuth;
assert.equal(classifyAuth({ status: 403 }, null).tipo, 'credencial');
assert.equal(classifyAuth({ status: 401 }, null).tipo, 'credencial');
assert.equal(classifyAuth({ status: 422 }, null).tipo, 'credencial');
assert.equal(classifyAuth({ status: 200 }, null).tipo, 'protocolo');
assert.equal(classifyAuth({ status: 503 }, null).tipo, 'fora');
const renewStart = clientSource.indexOf('  async _renovarToken() {');
const renewEnd = clientSource.indexOf('  /* Quando a renovação do token falha', renewStart);
let renewalCase = { status: 403, data: null };
const renewalCloud = {
  _refreshPromise: null, _servidorFora: false,
  config: () => ({ url: 'https://nuvem.test' }),
  session: () => ({ refresh_token: 'r', user: { id: current.userId } }),
  _headers: () => ({}), _classificarFalhaAuth: classifyAuth
};
const renewalRuntime = {
  cloud: renewalCloud, contextoAba, persistenciaCloudFirst: persistence,
  async fetch() {
    if (renewalCase.error) throw renewalCase.error;
    return { status: renewalCase.status, ok: renewalCase.status < 400, json: async () => renewalCase.data };
  }
};
const renewToken = vm.runInNewContext('({' + clientSource.slice(renewStart, renewEnd) + '})', renewalRuntime)._renovarToken;
for (const candidate of [
  { status: 403, data: null, outage: false },
  { status: 401, data: null, outage: false },
  { status: 400, data: { message: 'Email not confirmed' }, outage: false },
  { status: 200, data: null, outage: false },
  { status: 503, data: null, outage: true },
  { status: 429, data: null, outage: true },
  { error: new TypeError('Failed to fetch'), outage: true },
  { error: new Error('erro interno'), outage: false }
]) {
  renewalCase = candidate;
  assert.equal(await renewToken(), false);
  assert.equal(renewalCloud._servidorFora, candidate.outage,
    'a renovação só pode permitir WAL clínico quando a indisponibilidade foi comprovada');
}

console.log('  ✓ D3b: online sem escrita durável, outage AES-GCM, recibo idempotente e rejeições só em memória');
