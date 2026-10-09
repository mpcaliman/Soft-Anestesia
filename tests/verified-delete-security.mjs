/** Regressão: ausência confirmada nunca significa HTTP/rede/JSON inválido. */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAppSource } from './helpers/read-app-source.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const rootArg = process.argv.find(arg => arg.startsWith('--app-root='));
const root = rootArg ? resolve(process.cwd(), rootArg.slice('--app-root='.length)) : resolve(here, '..');
const source = await readAppSource(root);
const between = (start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.notEqual(a, -1); assert.notEqual(b, -1);
  return source.slice(a, b);
};
const owner = { verified: true, generation: 1, organizationId: 'clinic-a', userId: 'user-a',
  deviceId: 'device-a', tabId: 'tab-a' };
const snapshot = () => Object.freeze({ ...owner });
const contextoAba = {
  capturar: snapshot, donoFila: snapshot, operational: () => true,
  organizationId: () => owner.organizationId,
  corresponde: ctx => !!ctx && ctx.generation === owner.generation &&
    ctx.organizationId === owner.organizationId && ctx.userId === owner.userId,
  compativelComSessoes: () => true, aoMudar() {}
};
const clone = value => value == null ? value : structuredClone(value);
const envelopes = new Map(), operations = new Map(), metadata = new Map();
let operationWrites = 0, removals = 0, legacyRemovals = 0;
const driver = {
  getEnvelope: async key => clone(envelopes.get(key) || null),
  async addEnvelope(value) { envelopes.set(value.ownerKey, clone(value)); return true; },
  getOperation: async key => clone(operations.get(key) || null),
  async addOperation(value) {
    operationWrites++;
    assert.ok(value.ciphertext && value.iv);
    assert.equal(Object.hasOwn(value, 'payload'), false);
    operations.set(value.operationId, clone(value)); return true;
  },
  listOperations: async ownerKey => Array.from(operations.values()).filter(value => value.ownerKey === ownerKey).map(clone),
  async updateOperation(key, patch) {
    const previous = operations.get(key); if (!previous) return null;
    const next = { ...previous, ...clone(patch) }; operations.set(key, next); return clone(next);
  },
  async deleteOperation(key) { removals++; operations.delete(key); },
  getMeta: async key => clone(metadata.get(key) || null),
  async putMeta(value) { metadata.set(value.ownerKey, clone(value)); }
};
let responses = [], requests = [];
const runtime = {
  console, Map, Set, Date, JSON, Promise, structuredClone, crypto: webcrypto,
  TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, atob, btoa,
  navigator: { onLine: true }, contextoAba,
  cloud: { config: () => ({ url: 'https://cloud.test' }), _headers: () => ({}),
    _garantirToken: async () => true, session: () => ({ user: { id: owner.userId } }),
    estaConfigurado: () => true, estaLogado: () => true, divergencia: () => false,
    servidorFora: () => false },
  auth: { usuarioAtual: () => ({ id: owner.userId }) },
  syncStatus: { cloudSyncing() {}, cloudDone() {}, cloudState() {}, refresh() {} },
  async fetch(url, options = {}) {
    requests.push({ url: String(url), method: options.method || 'GET' });
    const response = responses.shift(); assert.ok(response, 'requisição extra inesperada');
    if (response.error) throw response.error;
    return { status: response.status, ok: response.status >= 200 && response.status < 300,
      async json() { if (response.invalidJson) throw new SyntaxError('bad JSON'); return clone(response.body); },
      async text() { return ''; } };
  }
};
runtime.window = runtime; runtime.globalThis = runtime;
vm.createContext(runtime);
vm.runInContext(between('const filaCifrada = {', '\n\n/* FIM DA PLATAFORMA DE CONTEXTO E FILA OFFLINE */') + '\n' +
  between('const cloudRel = {', '/* FIM DA PERSISTÊNCIA RELACIONAL */') + '\n' +
  between('const persistenciaCloudFirst = {', '\n\n/* FIM DA PERSISTÊNCIA CLOUD-FIRST */') +
  '\nglobalThis.vault = filaCifrada; globalThis.rel = cloudRel; globalThis.transport = persistenciaCloudFirst;', runtime);
const { vault, rel, transport } = runtime;
vault._definirDriverParaTeste(driver);
vault._buscarKekServidor = async () => ({ material: Uint8Array.from({ length: 32 }, (_, i) => i + 1), keyVersion: 1 });
rel._filaDelTirar = () => { legacyRemovals++; };
rel._filaDelPor = () => { throw new Error('nova fila legada proibida'); };
await vault.preparar();

const cases = [
  { id: 'server-unavailable', replies: [{ status: 503, body: null }], outage: true, status: 503 },
  { id: 'forbidden', replies: [{ status: 403, body: null }], outage: false, status: 403 },
  { id: 'timeout', replies: [{ error: new Error('timeout') }], outage: true },
  { id: 'network', replies: [{ error: new TypeError('Failed to fetch') }], outage: true },
  { id: 'malformed-json', replies: [{ status: 200, invalidJson: true }], outage: false, status: 200 },
  { id: 'malformed-shape', replies: [{ status: 200, body: {} }], outage: false, status: 200 },
  { id: 'wrong-scope', replies: [{ status: 200, body: [{ organization_id: 'clinic-b', legacy_id: 'wrong-scope' }] }], outage: false },
  { id: 'patch-empty-reread-unavailable', version: 1,
    replies: [{ status: 200, body: [] }, { status: 503, body: null }], outage: true, status: 503 },
  { id: 'patch-empty-reread-forbidden', version: 1,
    replies: [{ status: 200, body: [] }, { status: 403, body: null }], outage: false, status: 403 },
  { id: 'patch-invalid-json', version: 1, replies: [{ status: 200, invalidJson: true }], outage: false }
];
for (const scenario of cases) {
  responses = [...scenario.replies]; requests = [];
  const writesBefore = operationWrites, deletesBefore = removals, legacyBefore = legacyRemovals;
  const result = await transport.remover('pre', { _id: scenario.id, _relOrg: owner.organizationId,
    ...(scenario.version ? { _relVersion: scenario.version } : {}) });
  assert.equal(result.ok, false, `${scenario.id}: leitura falha nunca é ausência confirmada`);
  assert.equal(result.ausente, undefined);
  assert.equal(result.durable, scenario.outage, `${scenario.id}: somente indisponibilidade pode cifrar offline`);
  assert.equal(result.queued, scenario.outage);
  if (scenario.status && !scenario.outage) assert.equal(result.status, scenario.status);
  assert.equal(operationWrites - writesBefore, scenario.outage ? 1 : 0);
  assert.equal(removals, deletesBefore, `${scenario.id}: sem recibo não pode apagar o WAL`);
  assert.equal(legacyRemovals, legacyBefore, `${scenario.id}: nenhuma fila pode perder a intenção`);
  assert.equal(responses.length, 0);
  assert.ok(requests.every(request => request.url.includes('organization_id=eq.clinic-a') &&
    request.url.includes('legacy_id=eq.' + scenario.id)), 'todas as leituras/exclusões conservam clínica e identidade');
}

for (const version of [null, 1]) {
  responses = version ? [{ status: 200, body: [] }, { status: 200, body: [] }] : [{ status: 200, body: [] }];
  requests = [];
  const writesBefore = operationWrites;
  const converged = await transport.remover('pre', { _id: 'verified-absent-' + version,
    _relOrg: owner.organizationId, ...(version ? { _relVersion: version } : {}) });
  assert.equal(converged.ok, true);
  assert.equal(converged.ausente, true, '200[] válido e escopado confirma convergência da exclusão');
  assert.equal(converged.remoteConfirmed, true);
  assert.equal(operationWrites, writesBefore, 'convergência online não cria WAL');
}

/* A previously durable delete remains encrypted while re-read is unavailable,
   then leaves the device only after a valid scoped absence check on reconnect. */
responses = [{ status: 200, body: [] }, { status: 503, body: null }];
const durable = await transport.remover('pre', { _id: 'retry-delete', _relOrg: owner.organizationId, _relVersion: 1 });
assert.equal(durable.durable, true);
const pending = (await vault.listar()).find(op => op.entityId === 'retry-delete');
assert.ok(pending);
responses = [{ status: 200, body: [] }, { status: 503, body: null }];
const unsuccessful = await rel.apagarNaClinica('preanesthetic_assessments', 'retry-delete', {
  organizationId: owner.organizationId, baseVersion: 1, mod: 'pre', semFilaLegada: true,
  operation: { id: pending.operationId, checksum: pending.payload.requestChecksum }
});
assert.equal(unsuccessful.ok, false);
assert.equal(unsuccessful.status, 503);
assert.ok(operations.has(pending.operationId), '503 após PATCH vazio não remove a intenção cifrada');
responses = [{ status: 200, body: [] }, { status: 200, body: [] }];
const absenceReceipt = await rel.apagarNaClinica('preanesthetic_assessments', 'retry-delete', {
  organizationId: owner.organizationId, baseVersion: 1, mod: 'pre', semFilaLegada: true,
  operation: { id: pending.operationId, checksum: pending.payload.requestChecksum }
});
assert.equal(transport._reciboValido({ ...pending, contexto: snapshot() }, absenceReceipt), true);
await vault.confirmar(pending.operationId, { remoteConfirmed: true, checksum: pending.checksum });
assert.equal(operations.has(pending.operationId), false);
assert.equal(removals, 1);

runtime.navigator.onLine = false;
assert.equal(transport.indisponivel({ ok: false, motivo: 'offline' }), true);
assert.equal(transport.indisponivel({ ok: false, motivo: 'http 403' }), false);
assert.equal(transport.indisponivel({ ok: false, motivo: 'contexto_trocado' }), false);
console.log('  ✓ Exclusão exige ausência 200[] válida: 503/rede preservam WAL, autorização/JSON falham sem cópia local');
