/** Limites legados são barreiras explícitas; nunca descartam pendências. */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAppSource } from './helpers/read-app-source.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const rootArg = process.argv.find(arg => arg.startsWith('--app-root='));
const root = rootArg ? resolve(process.cwd(), rootArg.slice('--app-root='.length)) : resolve(here, '..');
const source = await readAppSource(root);
const between = (start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.notEqual(a, -1); assert.notEqual(b, -1); return source.slice(a, b);
};
const owner = { generation: 1, verified: true, organizationId: 'clinic-a', userId: 'user-a',
  deviceId: 'device-a', tabId: 'tab-a' };
const snapshot = () => Object.freeze({ ...owner });
const values = new Map(), notifications = [], statuses = [];
let quota = false, writes = 0;
const runtime = {
  console, Map, Set, Date, JSON, Promise,
  contextoAba: { capturar: snapshot, donoFila: snapshot,
    corresponde: ctx => ctx.generation === owner.generation && ctx.userId === owner.userId &&
      ctx.organizationId === owner.organizationId },
  localStorage: { getItem: key => values.get(key) ?? null,
    setItem(key, value) {
      writes++;
      if (quota) throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
      values.set(key, String(value));
    } },
  toast: message => notifications.push(message),
  syncStatus: { refresh() {}, cloudState: value => statuses.push(value) },
  ui: { repintarNuvemAtual() {} },
  store: { getById: (_mod, id) => ({ _id: id }) }
};
runtime.window = runtime; runtime.globalThis = runtime;
vm.createContext(runtime);
vm.runInContext(between('const cloud = {', '/* FIM DO ADAPTADOR SUPABASE */') + '\n' +
  between('const cloudRel = {', '/* FIM DA PERSISTÊNCIA RELACIONAL */') +
  '\nglobalThis.client = cloud; globalThis.rel = cloudRel;', runtime);
const { client, rel } = runtime;
const foreign = [
  { mod: 'pre', id: 'foreign-user', organizationId: owner.organizationId, userId: 'user-b', deviceId: owner.deviceId },
  { mod: 'pre', id: 'foreign-device', organizationId: owner.organizationId, userId: owner.userId, deviceId: 'device-b' },
  { mod: 'pre', id: 'foreign-clinic', organizationId: 'clinic-b', userId: owner.userId, deviceId: owner.deviceId }
];
const entries = (count, deleted = false) => Array.from({ length: count }, (_, i) => ({
  ...(deleted ? { tabela: 'preanesthetic_assessments' } : { mod: 'pre' }),
  id: 'record-' + i, ts: i, tentativas: 1, organizationId: owner.organizationId,
  userId: owner.userId, deviceId: owner.deviceId, tabId: owner.tabId
}));

for (const deleted of [false, true]) {
  const key = deleted ? rel.FILA_DEL_KEY : rel.FILA_KEY;
  const original = foreign.concat(entries(2000, deleted));
  values.set(key, JSON.stringify(original));
  const before = values.get(key), writesBefore = writes;
  const result = deleted ? rel._filaDelPor('preanesthetic_assessments', 'new-record') : rel._filaPor('pre', 'new-record', 'rede');
  assert.equal(result, false, 'nova identidade acima da capacidade deve ser recusada explicitamente');
  assert.equal(rel._ultimoMotivo, 'fila_legada_cheia');
  assert.equal(values.get(key), before, 'recusa preserva bytes e todas as pendências anteriores');
  assert.equal(writes, writesBefore, 'limite é verificado antes de tocar no armazenamento');
  const own = deleted ? rel._filaDelLer() : rel._filaLer();
  assert.equal(own.length, 2000);
  assert.equal(own[0].id, 'record-0');
  assert.equal(own.at(-1).id, 'record-1999');
  assert.equal(own.some(entry => entry.id === 'new-record'), false);
  assert.ok(notifications.at(-1).includes('não foi protegida'));
  assert.equal(statuses.at(-1), 'error');

  const update = deleted ? rel._filaDelPor('preanesthetic_assessments', 'record-0') : rel._filaPor('pre', 'record-0', 'retentativa');
  assert.equal(update, true, 'retentativa da mesma identidade deve atualizar no limite');
  const updated = deleted ? rel._filaDelLer() : rel._filaLer();
  assert.equal(updated.length, 2000);
  assert.equal(updated.find(entry => entry.id === 'record-0').tentativas, 2);
  assert.ok(updated.some(entry => entry.id === 'record-1999'));
  assert.deepEqual(JSON.parse(values.get(key)).filter(entry => !rel._mesmoDonoFila(entry, owner)), foreign,
    'escrita de um dono não pode tocar nas filas de outros usuários, dispositivos ou clínicas');

  quota = true;
  const quotaBefore = values.get(key);
  assert.equal(deleted ? rel._filaDelPor('preanesthetic_assessments', 'record-1') : rel._filaPor('pre', 'record-1', 'rede'), false);
  assert.equal(rel._ultimoMotivo, 'fila_legada_armazenamento');
  assert.equal(values.get(key), quotaBefore, 'quota não altera nem descarta a fila antiga');
  quota = false;
}

/* Versões antigas podem já ter uma fila acima do teto. Atualização e remoção
   continuam autorizadas sem fatiá-la automaticamente para 2.000 itens. */
values.set(rel.FILA_KEY, JSON.stringify(foreign.concat(entries(2010))));
assert.equal(rel._filaPor('pre', 'record-0', 'retentativa'), true);
assert.equal(rel._filaLer().length, 2010);
assert.ok(rel._filaLer().some(entry => entry.id === 'record-2009'));
assert.equal(rel._filaPor('pre', 'new-overflow', 'rede'), false);
assert.equal(rel._filaLer().length, 2010);
assert.equal(rel._filaTirar('pre', 'record-0'), true);
assert.equal(rel._filaLer().length, 2009);
assert.ok(rel._filaLer().some(entry => entry.id === 'record-2009'));
rel._capturarContexto = snapshot;
rel._contextoValido = ctx => runtime.contextoAba.corresponde(ctx);
rel._envioAtivo = () => false;
rel.enviarRegistro = async () => ({ ok: true });
client._garantirToken = async () => true;
const drained = await rel.drenarFila({ limite: 3 });
assert.equal(drained.enviados, 3);
assert.equal(drained.restantes, 2006, 'drenagem de legado acima do teto remove somente os três confirmados');
assert.ok(rel._filaLer().some(entry => entry.id === 'record-2009'));
assert.deepEqual(JSON.parse(values.get(rel.FILA_KEY)).filter(entry => !rel._mesmoDonoFila(entry, owner)), foreign);

values.set(rel.FILA_DEL_KEY, JSON.stringify(foreign.concat(entries(2010, true))));
assert.equal(rel._filaDelPor('preanesthetic_assessments', 'record-0'), true);
assert.equal(rel._filaDelLer().length, 2010);
assert.equal(rel._filaDelTirar('preanesthetic_assessments', 'record-0'), true);
assert.equal(rel._filaDelLer().length, 2009);
assert.ok(rel._filaDelLer().some(entry => entry.id === 'record-2009'));

/* Conteúdo ilegível também não autoriza sobrescrever a única evidência. */
values.set(rel.FILA_KEY, '{fila incompleta');
assert.equal(rel._filaPor('pre', 'attempt-after-corruption', 'rede'), false);
assert.equal(values.get(rel.FILA_KEY), '{fila incompleta');
assert.equal(rel._ultimoMotivo, 'fila_legada_invalida');

/* O canal pessoal fechado nunca amplia, deduplica ou corta o acervo antigo. */
const personal = Array.from({ length: 501 }, (_, i) => ({ modulo: 'pre', doc_id: 'legacy-' + i,
  organizationId: owner.organizationId, userId: owner.userId, deviceId: owner.deviceId }));
values.set(client.QUEUE_KEY, JSON.stringify(personal));
const personalBefore = values.get(client.QUEUE_KEY), writesBefore = writes;
assert.equal(client._enfileirar({ modulo: 'pre', doc_id: 'new' }), false);
assert.equal(client._enfileirar({ modulo: 'pre', doc_id: 'legacy-0' }), false);
assert.equal(client._ultimaFalhaFila, 'canal_pessoal_encerrado');
assert.equal(values.get(client.QUEUE_KEY), personalBefore);
assert.equal(writes, writesBefore);
console.log('  ✓ Limites legados recusam novas identidades sem cortar pendências; quota/corrupção explícitas e canal pessoal encerrado');
