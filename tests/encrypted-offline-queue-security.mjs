/** Regressão D3a: fila offline transacional, cifrada e presa ao mesmo dono. */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAppSource } from './helpers/read-app-source.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const rootArg = process.argv.find(arg => arg.startsWith('--app-root='));
const root = rootArg ? resolve(process.cwd(), rootArg.slice('--app-root='.length)) : resolve(here, '..');
const source = await readAppSource(root);
const migration = await readFile(resolve(here, '../database/migrations/0022_encrypted_offline_keyrings.sql'), 'utf8');

const between = (start, end) => {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  assert.notEqual(a, -1, `início não encontrado: ${start}`);
  assert.notEqual(b, -1, `fim não encontrado: ${end}`);
  return source.slice(a, b);
};

const vaultSource = between('const filaCifrada = {', '\n\n/* FIM DA PLATAFORMA DE CONTEXTO E FILA OFFLINE */');
assert.match(vaultSource, /indexedDB\.open/);
assert.doesNotMatch(vaultSource, /localStorage\.(?:getItem|setItem)/,
  'a nova fila clínica não pode voltar a ser array em localStorage');
assert.match(vaultSource, /AES-GCM/);
assert.match(vaultSource, /AES-KW/);
assert.match(vaultSource, /transaction\.oncomplete|tx\.oncomplete/,
  'durabilidade só pode ser confirmada depois de concluir a transação');
assert.doesNotMatch(vaultSource, /MAX_FILA|slice\(\s*-\s*\d+/,
  'fila cifrada não pode descartar operação antiga por corte silencioso');
assert.match(vaultSource, /remoteConfirmed !== true/,
  'remoção local precisa exigir confirmação verificável do servidor');
assert.match(vaultSource, /STORE_META:\s*'metadata'/,
  'observabilidade deve ficar particionada no IndexedDB, não junto ao prontuário');
assert.match(vaultSource, /state === 'sending'[\s\S]*attempts[\s\S]*lastAttemptAt/,
  'tentativa deve ser contada quando o envio começa');

assert.match(migration, /create table if not exists app\.offline_keyrings/);
assert.match(migration, /primary key \(user_id, device_id\)/);
assert.match(migration, /v_uid uuid := auth\.uid\(\)/,
  'o dono da chave deve vir do JWT, nunca de parâmetro controlado pelo cliente');
assert.doesNotMatch(migration, /function public\.ensure_offline_keyring\([^)]*user/i);
assert.match(migration, /revoke all on table app\.offline_keyrings from authenticated/);
assert.match(migration, /grant execute on function public\.ensure_offline_keyring\(text\) to authenticated/);

const envelopes = new Map();
const operations = new Map();
const metadata = new Map();
const snapshots = new Map();
let quotaNaProxima = false;
const clone = value => value == null ? value : structuredClone(value);
const driver = {
  async getEnvelope(key) { return clone(envelopes.get(key) || null); },
  async addEnvelope(value) {
    if (envelopes.has(value.ownerKey)) return false;
    envelopes.set(value.ownerKey, clone(value)); return true;
  },
  async getOperation(id) { return clone(operations.get(id) || null); },
  async addOperation(value) {
    if (quotaNaProxima) {
      quotaNaProxima = false;
      const e = new Error('quota cheia'); e.name = 'QuotaExceededError'; throw e;
    }
    if (operations.has(value.operationId)) return false;
    operations.set(value.operationId, clone(value)); return true;
  },
  async listOperations(ownerKey) {
    return Array.from(operations.values()).filter(x => x.ownerKey === ownerKey).map(clone);
  },
  async deleteOperation(id) { operations.delete(id); },
  async updateOperation(id, patch) {
    const atual = operations.get(id); if (!atual) return null;
    const novo = Object.assign({}, atual, clone(patch)); operations.set(id, novo); return clone(novo);
  },
  async getMeta(ownerKey) { return clone(metadata.get(ownerKey) || null); },
  async putMeta(value) { metadata.set(value.ownerKey, clone(value)); },
  async putSnapshot(value) {
    const atual = snapshots.get(value.snapshotId);
    if (atual && String(atual.updatedAt || '') > String(value.updatedAt || '')) return false;
    snapshots.set(value.snapshotId, clone(value)); return true;
  },
  async listSnapshots(ownerKey) {
    return Array.from(snapshots.values()).filter(x => x.ownerKey === ownerKey).map(clone);
  }
};

const listeners = [];
let generation = 1;
let current = {
  organizationId: 'aaaaaaaa-1111-4111-8111-111111111111',
  userId: '11111111-1111-4111-8111-111111111111',
  deviceId: 'dev-11111111-1111-4111-8111-111111111111',
  tabId: 'tab-a'
};
const snapshot = () => Object.freeze(Object.assign({ verified: true, generation }, current));
const contextoAba = {
  donoFila: () => Object.assign({}, current),
  capturar: snapshot,
  corresponde: snap => !!snap && snap.verified && snap.generation === generation &&
    snap.organizationId === current.organizationId && snap.userId === current.userId,
  aoMudar: fn => listeners.push(fn)
};
const trocar = next => {
  const anterior = snapshot();
  current = Object.assign({}, next); generation++;
  listeners.forEach(fn => fn(snapshot(), anterior));
};

const sandbox = {
  console, crypto: webcrypto, TextEncoder, TextDecoder, structuredClone,
  atob, btoa, contextoAba, Map, Set, Date, JSON, Uint8Array, ArrayBuffer
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(`${vaultSource}\nglobalThis.__vault = filaCifrada;`, sandbox);
const vault = sandbox.__vault;
vault._definirDriverParaTeste(driver);

const keyA = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const keyB = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);
vault._buscarKekServidor = async dono => ({
  material: Uint8Array.from(dono.userId.startsWith('1111') ? keyA : keyB), keyVersion: 1
});

const createdAt = '2026-10-07T12:00:00.000Z';
await vault.preparar();
const snapSalvo = await vault.salvarSnapshot('live-edit', 'termo', {
  dados: { paciente_nome: 'Paciente do Snapshot', observacao: 'conteúdo clínico secreto' }
});
assert.equal(snapSalvo.durable, true);
const brutoSnapshotA = Array.from(snapshots.values())[0];
assert.ok(brutoSnapshotA && brutoSnapshotA.ciphertext);
assert.doesNotMatch(JSON.stringify(brutoSnapshotA), /Paciente do Snapshot|conteúdo clínico secreto/,
  'snapshot de recuperação também deve ficar cifrado no IndexedDB');
assert.equal(brutoSnapshotA.namespace, 'live-edit');
assert.equal(Object.prototype.hasOwnProperty.call(brutoSnapshotA, 'payload'), false,
  'metadados do snapshot não podem carregar prontuário em claro');
const salvo = await vault.enfileirar({
  operationId: 'op-d3a-1', module: 'anestesia', entityId: 'registro-1', action: 'upsert',
  baseVersion: 3, createdAt,
  payload: { paciente: { nome: 'Paciente Sigiloso', cpf: '123.456.789-00' }, procedimento: 'Teste' }
});
assert.equal(salvo.ok, true);
assert.equal(salvo.durable, true);
assert.equal(operations.size, 1);

const brutoA = operations.get('op-d3a-1');
const textoBruto = JSON.stringify(brutoA);
assert.doesNotMatch(textoBruto, /Paciente Sigiloso|123\.456\.789-00|procedimento":"Teste/,
  'IndexedDB não pode conter o payload clínico em texto legível');
const envelopeA = envelopes.get(brutoA.ownerKey);
assert.ok(envelopeA && envelopeA.wrappedKey);
assert.equal(Object.prototype.hasOwnProperty.call(envelopeA, 'wrapKey'), false,
  'KEK do servidor não pode ser persistida no envelope local');

const duplicado = await vault.enfileirar({
  operationId: 'op-d3a-1', module: 'anestesia', entityId: 'registro-1', action: 'upsert',
  baseVersion: 3, createdAt,
  payload: { paciente: { nome: 'Paciente Sigiloso', cpf: '123.456.789-00' }, procedimento: 'Teste' }
});
assert.equal(duplicado.duplicate, true);
assert.equal(operations.size, 1, 'retentativa idempotente não duplica a operação');

await vault.marcarEstado('op-d3a-1', 'sending');
await vault.registrarFalha('op-d3a-1', new Error('rede interrompida'));
const acompanhada = (await vault.listar())[0];
assert.equal(acompanhada.queue.state, 'sending');
assert.equal(acompanhada.queue.attempts, 1, 'início do envio conta uma tentativa exatamente uma vez');
assert.match(acompanhada.queue.lastError, /rede interrompida/);
const resumoPendente = await vault.resumo();
assert.equal(resumoPendente.total, 1);
assert.equal(resumoPendente.tentativas, 1);
assert.equal(resumoPendente.comErro, 1);

/* Outro usuário no mesmo computador recebe outra KEK e nem enumera a fila A. */
trocar({
  organizationId: 'bbbbbbbb-2222-4222-8222-222222222222',
  userId: '22222222-2222-4222-8222-222222222222',
  deviceId: current.deviceId, tabId: 'tab-b'
});
const abertaB = await vault.preparar();
assert.equal(JSON.stringify(await vault.listar()), '[]');
assert.equal(JSON.stringify(await vault.listarSnapshots('live-edit')), '[]',
  'segunda pessoa não pode enumerar snapshots do primeiro dono');
await assert.rejects(() => vault._decifrar(brutoA, abertaB.key), e => e && e.code === 'operacao_inacessivel');
await assert.rejects(() => vault._decifrarSnapshot(brutoSnapshotA, abertaB.key),
  e => e && e.code === 'snapshot_inacessivel');

/* Crash/reabertura: memória zerada, mesmo usuário autenticado recupera a KEK
   do servidor, desembrulha a DEK já existente e relê a operação intacta. */
trocar({
  organizationId: 'aaaaaaaa-1111-4111-8111-111111111111',
  userId: '11111111-1111-4111-8111-111111111111',
  deviceId: current.deviceId, tabId: 'tab-a-nova'
});
assert.equal(vault._chaves.size, 0, 'troca/logout deve apagar chaves abertas da memória');
const recuperadas = await vault.listar();
assert.equal(recuperadas.length, 1);
assert.equal(recuperadas[0].payload.paciente.nome, 'Paciente Sigiloso');
assert.equal(recuperadas[0].baseVersion, 3);
const snapshotsRecuperados = await vault.listarSnapshots('live-edit');
assert.equal(snapshotsRecuperados[0].payload.dados.paciente_nome, 'Paciente do Snapshot');

/* Uma escrita que já capturou a chave A pode concluir depois da troca para B,
   mas continua fisicamente presa ao ownerKey A e invisível para B. */
let liberarSnapshot;
const putSnapshotOriginal = driver.putSnapshot.bind(driver);
driver.putSnapshot = async value => {
  if (value.key === 'risco') await new Promise(resolve => { liberarSnapshot = resolve; });
  return putSnapshotOriginal(value);
};
const atrasada = vault.salvarSnapshot('live-edit', 'risco', {
  dados: { paciente_nome: 'Nunca para o próximo usuário' }
});
trocar({
  organizationId: 'bbbbbbbb-2222-4222-8222-222222222222',
  userId: '22222222-2222-4222-8222-222222222222',
  deviceId: current.deviceId, tabId: 'tab-b-2'
});
for (let i = 0; i < 20 && typeof liberarSnapshot !== 'function'; i++) {
  await new Promise(resolve => setTimeout(resolve, 0));
}
assert.equal(typeof liberarSnapshot, 'function');
liberarSnapshot();
assert.equal((await atrasada).durable, true);
assert.equal((await vault.listarSnapshots('live-edit')).length, 0,
  'conclusão tardia deve ficar invisível ao usuário que assumiu o aparelho');
driver.putSnapshot = putSnapshotOriginal;

trocar({
  organizationId: 'aaaaaaaa-1111-4111-8111-111111111111',
  userId: '11111111-1111-4111-8111-111111111111',
  deviceId: current.deviceId, tabId: 'tab-a-final'
});
assert.equal((await vault.listarSnapshots('live-edit')).find(x => x.key === 'risco')
  .payload.dados.paciente_nome, 'Nunca para o próximo usuário');

await assert.rejects(
  () => vault.confirmar('op-d3a-1', { remoteConfirmed: false, checksum: salvo.checksum }),
  e => e && e.code === 'recibo_invalido'
);
assert.equal(operations.size, 1, 'falha/recibo incompleto nunca apaga a única cópia');
await vault.confirmar('op-d3a-1', { remoteConfirmed: true, checksum: salvo.checksum });
assert.equal(operations.size, 0, 'confirmação verificável remove a cópia local');
const resumoConfirmado = await vault.resumo();
assert.ok(resumoConfirmado.ultimaConfirmacao,
  'última confirmação deve sobreviver fora da memória para o painel operacional');

/* Quota cheia rejeita a promessa: a UI não pode anunciar “salvo” quando a
   transação durável falhou. */
quotaNaProxima = true;
await assert.rejects(() => vault.enfileirar({
  operationId: 'op-sem-espaco', module: 'pre', entityId: 'pre-1', action: 'upsert',
  createdAt: '2026-10-07T12:01:00.000Z', payload: { nome: 'Não pode sumir' }
}), e => e && e.name === 'QuotaExceededError');
assert.equal(operations.size, 0);

console.log('  ✓ D3a: fila offline cifrada, transacional, idempotente e isolada por dono');
