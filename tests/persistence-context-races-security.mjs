import { readAppSource, readCompiledActions } from './helpers/read-app-source.mjs';
/** Regressão: conclusão de WAL/exclusão não pode alterar a clínica seguinte. */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rootArgument = process.argv.find(argument => argument.startsWith('--app-root='));
const root = rootArgument
  ? resolve(process.cwd(), rootArgument.slice('--app-root='.length))
  : resolve(here, '..');
const [engineSource, storeSource, htmlSource] = await Promise.all([
  readFile(resolve(root, 'src/platform/cloud-first.js'), 'utf8'),
  readFile(resolve(root, 'src/platform/clinical-store.js'), 'utf8'),
  readAppSource(root)
]);
const SoftActions = await readCompiledActions(root);
const deferred = () => {
  let resolvePromise, rejectPromise;
  const promise = new Promise((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
};
let generation = 1, organizationId = 'clinic-a';
const snapshot = () => ({ generation, organizationId, userId: 'user-a', tabId: 'tab-a', verified: true });
const contextoAba = {
  atual: snapshot, capturar: snapshot, operational: () => true,
  corresponde: context => !!context && context.generation === generation &&
    context.organizationId === organizationId && context.userId === 'user-a',
  aoMudar() {}
};
let gate = deferred(), protections = 0, sends = 0;
const engineRuntime = {
  console, Set, Map, Date, JSON, Promise, contextoAba,
  filaCifrada: {
    _erro(code, message) { return Object.assign(new Error(message), { code }); },
    enfileirar: () => gate.promise, marcarEstado: async () => true
  },
  store: { protegidoNoCofre: () => { protections++; } },
  cloudRel: { enviarRegistro: async () => { sends++; } }
};
engineRuntime.window = engineRuntime;
engineRuntime.globalThis = engineRuntime;
vm.createContext(engineRuntime);
vm.runInContext(`${engineSource}\nglobalThis.__engine = persistenciaCloudFirst;`, engineRuntime);
const engine = engineRuntime.__engine;
const operation = {
  operationId: 'op-a', module: 'pre', entityId: 'same-id', action: 'upsert',
  contexto: snapshot(), payload: { transport: 'cloud-rel-v1', action: 'upsert', item: { _id: 'same-id' } }
};
const staging = engine._estagiar(operation);
generation++;
organizationId = 'clinic-b';
gate.resolve({ ok: true, durable: true, checksum: 'encrypted-commit' });
await assert.rejects(staging, error => error.code === 'contexto_trocado');
assert.equal(protections, 0, 'commit da clínica A não pode liberar texto da clínica B de mesmo ID');
assert.equal(engine.pendentesConhecidos(), 0, 'WAL do dono anterior não entra na contagem da nova clínica');
assert.equal((await engine._enviar(operation, null)).motivo, 'contexto_trocado');
assert.equal(sends, 0, 'intenção capturada na clínica anterior não pode buscar o destino da atual');

const values = new Map();
const localStorage = {
  getItem: key => values.get(organizationId + ':' + key) ?? null,
  setItem: (key, value) => values.set(organizationId + ':' + key, String(value)),
  removeItem: key => values.delete(organizationId + ':' + key)
};
let deletion = deferred();
const warnings = [];
const storeRuntime = {
  console, Set, Map, WeakMap, Date, JSON, Promise, contextoAba, localStorage,
  STORAGE: { pre: 'records.pre' }, HISTORY_MAX: 300,
  persistenciaCloudFirst: { remover: () => deletion.promise },
  toast: message => warnings.push(message)
};
storeRuntime.window = storeRuntime;
storeRuntime.globalThis = storeRuntime;
storeRuntime.SoftActions = SoftActions;
vm.createContext(storeRuntime);
vm.runInContext(`${storeSource}\nglobalThis.__store = store;`, storeRuntime);
const store = storeRuntime.__store;
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

/* A exclusão sem commit é desfeita quando a pessoa segue na mesma clínica. */
store.setList('pre', [{ _id: 'same-context', nome: 'Preservado' }]);
store.delete('pre', 'same-context');
deletion.resolve({ ok: false, durable: false });
await flush();
assert.equal(store.getById('pre', 'same-context').nome, 'Preservado');
assert.equal(warnings.length, 1);

/* Resolução negativa e rejeição chegam depois da troca de dono. Nenhuma
   delas pode devolver o paciente antigo à lista de outra clínica. */
for (const rejects of [false, true]) {
  generation++;
  organizationId = 'clinic-a-' + rejects;
  deletion = deferred();
  store.setList('pre', [{ _id: 'same-id', nome: 'Paciente clínica A' }]);
  store.delete('pre', 'same-id');
  generation++;
  organizationId = 'clinic-b-' + rejects;
  store.setList('pre', [{ _id: 'same-id', nome: 'Paciente clínica B' }]);
  if (rejects) deletion.reject(new Error('IndexedDB indisponível'));
  else deletion.resolve({ ok: false, durable: false });
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(store.list('pre'))),
    [{ _id: 'same-id', nome: 'Paciente clínica B' }]);
  assert.equal(warnings.length, 1, 'resultado antigo não deve renderizar aviso na sessão seguinte');
}

console.log('  ✓ WAL e rollback de exclusão respeitam o contexto capturado após await');

/* Cadastros chegam por org_configs direto ao armazenamento. O cache de
   prontuários em memória não pode esconder essa atualização de configuração. */
storeRuntime.STORAGE.cad_cirurgioes = 'medsys.v5.cad.cirurgioes';
storeRuntime.cloud = {
  _garantirToken: async () => true,
  config: () => ({ url: 'https://nuvem.test' }),
  _headers: () => ({}), session: () => ({ user: { id: 'user-a' } })
};
storeRuntime.cloudRel = {
  disponivel: () => true, _capturarContexto: snapshot,
  _contextoValido: context => contextoAba.corresponde(context),
  _orgAsync: async () => organizationId
};
let configReads = 0;
const remoteSurgeons = [{ _id: 'cirurgiao-nuvem', nome: 'Dra. Helena' }];
storeRuntime.fetch = async url => {
  configReads++;
  const content = String(url).includes('select=chave,dados,updated_at');
  return { ok: true, json: async () => [{ chave: 'cad_cirurgioes',
    updated_at: '2026-10-09T12:00:00.000Z',
    ...(content ? { dados: { valor: remoteSurgeons } } : {}) }] };
};
const clinicSyncStart = htmlSource.indexOf('const clinicaSync = {');
assert.notEqual(clinicSyncStart, -1);
const clinicSyncEnd = htmlSource.indexOf('\n};', clinicSyncStart) + 4;
vm.runInContext(htmlSource.slice(clinicSyncStart, clinicSyncEnd) +
  '\nglobalThis.__clinicSync = clinicaSync;', storeRuntime);
store.setList('cad_cirurgioes', []);
assert.deepEqual(JSON.parse(JSON.stringify(store.list('cad_cirurgioes'))), []);
assert.equal(await storeRuntime.__clinicSync.puxarAplicar({ silent: true }), 1);
assert.equal(configReads, 2, 'cadastro novo deve ler índice e conteúdo');
assert.deepEqual(JSON.parse(JSON.stringify(store.list('cad_cirurgioes'))), remoteSurgeons,
  'a lista vazia lida antes do pull não pode esconder o cadastro da clínica');
assert.equal(await storeRuntime.__clinicSync.puxarAplicar({ silent: true }), 0);
assert.equal(configReads, 3, 'cadastro atualizado deve consultar somente o índice');

store.setList('pre', [{ _id: 'confirmado', nome: 'Paciente na memória',
  _relUpdatedAt: '2026-10-09T12:00:00.000Z' }]);
assert.equal(localStorage.getItem('records.pre'), null);
assert.equal(store.getById('pre', 'confirmado').nome, 'Paciente na memória',
  'a atualização dos cadastros mantém os prontuários confirmados em memória');
console.log('  ✓ cadastros refletem org_configs; prontuários confirmados continuam só em memória');

/* Even the success toast from an earlier account is isolated. A delayed
   receipt cannot announce a clinical save inside the next user's session. */
const savedStatuses = [];
storeRuntime.setSavedStatus = status => savedStatuses.push(status);
const notification = deferred();
const notificationItem = { _id: 'late-notification' };
store._registrarConfirmacao(notificationItem, notification.promise);
store.notificarNuvem(notificationItem, 'Ficha');
const beforeStatuses = savedStatuses.length, beforeWarnings = warnings.length;
generation++; organizationId = 'next-user-clinic';
notification.resolve({ ok: true, remoteConfirmed: true });
await flush();
assert.equal(savedStatuses.length, beforeStatuses);
assert.equal(warnings.length, beforeWarnings, 'recibo anterior não pode renderizar toast para o usuário atual');

/* A drain may finish encryption removal and then await a fresh queue read.
   If the context changes in that window, its old confirmed ID must not clear
   the next clinic's pending marker for an identical record ID. */
let drainGate = deferred(), listReads = 0, remoteClears = 0;
engineRuntime.navigator = { onLine: true };
engineRuntime.cloudRel.disponivel = () => true;
engineRuntime.filaCifrada._donoKey = context => context.organizationId + ':' + context.userId;
engineRuntime.filaCifrada.listar = async () => {
  listReads++;
  if (listReads === 1) return [{ ...operation, contexto: snapshot(), checksum: 'vault-checksum' }];
  return drainGate.promise;
};
engineRuntime.filaCifrada.confirmar = async () => true;
engineRuntime.store.confirmarRemoto = () => { remoteClears++; };
engine._enviar = async () => ({ ok: true, row: { version: 2 } });
engine._reciboValido = () => true;
const draining = engine.drenar();
for (let attempt = 0; attempt < 30 && listReads < 2; attempt++) await Promise.resolve();
assert.equal(listReads, 2);
generation++; organizationId = 'other-clinic-after-drain';
drainGate.resolve([]);
assert.equal((await draining).motivo, 'contexto_trocado');
assert.equal(remoteClears, 0, 'conclusão da fila anterior não pode limpar pendência do novo dono');
console.log('  ✓ notificações e confirmação tardia da drenagem não atravessam usuários/clínicas');
