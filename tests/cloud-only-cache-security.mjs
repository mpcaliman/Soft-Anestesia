/** Regressão D4: prontuário confirmado fica na nuvem, não no aparelho. */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAppSource } from './helpers/read-app-source.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const rootArg = process.argv.find(arg => arg.startsWith('--app-root='));
const root = rootArg ? resolve(process.cwd(), rootArg.slice('--app-root='.length)) : resolve(here, '..');
const source = await readAppSource(root);
const storeSource = await readFile(resolve(root, 'src/platform/clinical-store.js'), 'utf8');
const cashMigration = await readFile(resolve(here, '../database/migrations/0027_cloud_only_cash_closings.sql'), 'utf8');

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(String(key)) ? this.values.get(String(key)) : null; }
  setItem(key, value) { this.values.set(String(key), String(value)); }
  removeItem(key) { this.values.delete(String(key)); }
}

let generation = 1;
let organizationId = 'aaaaaaaa-1111-4111-8111-111111111111';
const listeners = [];
const snapshot = () => ({ generation, organizationId, userId: 'user-a', tabId: 'tab-a', verified: true });
const localStorage = new MemoryStorage();
const diskValues = new Map();
const sandbox = {
  console, Map, Set, WeakMap, Promise, JSON, Date,
  localStorage,
  STORAGE: { pre: 'records.pre', agenda: 'records.agenda', pacientes: 'records.pacientes' },
  HISTORY_MAX: 300,
  contextoAba: {
    atual: snapshot,
    operational: () => true,
    aoMudar: fn => listeners.push(fn)
  },
  disco: {
    get: key => diskValues.has(key) ? diskValues.get(key) : null,
    set: (key, value) => { diskValues.set(key, String(value)); return true; },
    remove: key => diskValues.delete(key),
    suportado: () => false, _pronto: false
  },
  toast: () => {},
  window: null
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

localStorage.setItem('records.pre', JSON.stringify([{
  _id: 'confirmado', nome: 'Paciente Nuvem', _relUpdatedAt: '2026-10-07T10:00:00.000Z'
}]));
vm.runInContext(`${storeSource}\nglobalThis.__storeD4 = store;`, sandbox);
const store = sandbox.__storeD4;

assert.equal(store.list('pre').length, 1, 'cache legado confirmado deve entrar somente na memória da aba');
assert.equal(store.purgarConfirmadosDuraveis(), 1);
assert.equal(localStorage.getItem('records.pre'), null, 'confirmado não pode continuar no armazenamento local');
assert.equal(store.list('pre')[0].nome, 'Paciente Nuvem', 'a tela aberta continua funcional pela memória');

const pendente = { _id: 'pendente', nome: 'Paciente Offline' };
store._marcarPendente('pre', pendente._id);
store.setList('pre', [store.list('pre')[0], pendente]);
assert.deepEqual(JSON.parse(localStorage.getItem('records.pre')).map(x => x._id), ['pendente'],
  'antes da cifragem, somente a alteração ainda não protegida pode sobreviver a uma queda');
store.protegidoNoCofre('pre', pendente._id);
assert.equal(localStorage.getItem('records.pre'), null,
  'depois que o WAL cifra a operação, a cópia clínica em claro deve desaparecer');
assert.equal(store.list('pre').length, 2, 'a remoção durável não pode apagar a memória da aba');

generation++;
organizationId = 'bbbbbbbb-2222-4222-8222-222222222222';
listeners.forEach(fn => fn(snapshot()));
assert.deepEqual(store.list('pre'), [], 'troca de usuário/clínica deve zerar toda memória clínica da aba');

localStorage.setItem('records.pre', JSON.stringify([{ _id: 'fila-1', nome: 'Texto transitório' }]));
assert.equal(store.restaurarDoCofre([{
  operationId: 'op-1', module: 'pre', entityId: 'fila-1', createdAt: '2026-10-07T11:00:00.000Z',
  payload: { transport: 'cloud-rel-v1', action: 'upsert', item: { _id: 'fila-1', nome: 'Recuperado cifrado' } }
}]), 1);
assert.equal(store.getById('pre', 'fila-1').nome, 'Recuperado cifrado');
assert.equal(localStorage.getItem('records.pre'), null,
  'reabertura deve reconstruir da fila cifrada sem conservar o payload em claro');

/* A lixeira cloud-only também não é um segundo prontuário local. O snapshot
   necessário para desfazer a exclusão vive dentro do WAL cifrado `delete`; a
   ação `restore` precisa ficar durável antes de recolocar o item na tela. */
const trashStart = source.indexOf('const lixeira = {');
const trashEnd = source.indexOf('\ntry { contextoAba.aoMudar(() => lixeira._garantirContexto());', trashStart);
assert.notEqual(trashStart, -1);
assert.notEqual(trashEnd, -1);
const trashSource = source.slice(trashStart, trashEnd);
const trashDisk = new Map();
const trashLists = new Map([['pre', []]]);
let restoreCalls = 0;
const trashContext = { generation: 1, organizationId: 'clinica-a', userId: 'medico-a', tabId: 'tab-a' };
const trashRuntime = {
  console, JSON, Date,
  store: {
    cloudOnlyAtivo: () => true,
    _clone: value => structuredClone(value), _desidratar: value => structuredClone(value),
    _blobs: () => ({}), _hidratar() {},
    list: mod => structuredClone(trashLists.get(mod) || []),
    setList: (mod, list) => trashLists.set(mod, structuredClone(list))
  },
  disco: {
    get: key => trashDisk.get(key) || null,
    set: (key, value) => { trashDisk.set(key, value); return true; },
    remove: key => trashDisk.delete(key)
  },
  contextoAba: {
    atual: () => trashContext, capturar: () => structuredClone(trashContext),
    corresponde: snap => !!snap && snap.generation === trashContext.generation
  },
  persistenciaCloudFirst: {
    async restaurar(mod, item) {
      restoreCalls++; return { ok: false, queued: true, durable: true, row: null, mod, item };
    }
  },
  cloudRel: { _itemDaLinha: () => null },
  toast() {}, modal: { open() {}, close() {} }, document: { getElementById: () => null }
};
trashRuntime.window = trashRuntime;
trashRuntime.globalThis = trashRuntime;
vm.createContext(trashRuntime);
vm.runInContext(`${trashSource}\nglobalThis.__trashD4 = lixeira;`, trashRuntime);
const trash = trashRuntime.__trashD4;
trash.abrir = () => {};
trash.guardar('pre', { _id: 'apagado-1', nome: 'Paciente apenas no WAL' });
assert.equal(trashDisk.size, 0, 'lixeira cloud-only não pode gravar snapshot clínico em claro');
assert.equal(await trash.restaurar(0), true);
assert.equal(restoreCalls, 1);
assert.equal(trashLists.get('pre')[0].nome, 'Paciente apenas no WAL');
trash.restaurarDoCofre([{
  operationId: 'del-2', module: 'pre', entityId: 'apagado-2', createdAt: '2026-10-07T12:00:00Z',
  payload: { transport: 'cloud-rel-v1', action: 'delete', item: { _id: 'apagado-2', nome: 'Cifrado' } }
}]);
assert.equal(trash._ler()[0].item._id, 'apagado-2',
  'reabertura deve reconstruir a lixeira somente a partir do WAL decifrado');

/* A confirmação acompanha a identidade do registro, não apenas a referência
   do objeto. Exclusões e releituras devolvem clones diferentes. */
const confirmacao = Promise.resolve({ ok: true, remoteConfirmed: true });
store._registrarConfirmacao({ _id: 'clone-confirmacao' }, confirmacao);
assert.equal(await store.aguardarNuvem({ _id: 'clone-confirmacao' }), await confirmacao,
  'clone do mesmo registro deve encontrar a confirmação remota em andamento');

/* Resíduos do modelo anterior também precisam sair. Blob ainda referenciado
   por legado sem recibo é a única exceção até sua migração para o WAL. */
localStorage.setItem('medsys.v7.audit', '[{"nome":"Paciente"}]');
localStorage.setItem('medsys.v7.arquivo.indice', '{"pre":[{"nome":"Paciente"}]}');
localStorage.setItem('medsys.v7.arquivo.auto', '1');
localStorage.setItem('records.pre', JSON.stringify([{ _id: 'legado-pendente', foto: 'blob:manter' }]));
diskValues.set('medsys.v7.versions', '{"pre:x":[{"snapshot":{"nome":"Paciente"}}]}');
diskValues.set('medsys.v7.blobs', JSON.stringify({
  'blob:manter': 'data:image/png;base64,pendente',
  'blob:remover': 'data:image/png;base64,confirmado'
}));
store.purgarArtefatosConfirmadosDuraveis();
assert.equal(localStorage.getItem('medsys.v7.audit'), null);
assert.equal(localStorage.getItem('medsys.v7.arquivo.indice'), null);
assert.equal(localStorage.getItem('medsys.v7.arquivo.auto'), null);
assert.equal(diskValues.has('medsys.v7.versions'), false);
assert.deepEqual(Object.keys(JSON.parse(diskValues.get('medsys.v7.blobs'))), ['blob:manter']);

const start = source.indexOf('const modoNuvem = {');
const end = source.indexOf('\n};\n\n/* ============================================================================\n   PRÉ-LANÇAMENTO', start);
assert.notEqual(start, -1);
assert.notEqual(end, -1);
const modeSource = source.slice(start, end + 3);
assert.doesNotMatch(modeSource, /DIAS_PADRAO|arquivo\.restaurarTodos|localStorage\.setItem/,
  'política obrigatória não pode reabrir janela local nem oferecer restauração permanente');
assert.doesNotMatch(source, /id="modo-nuvem-(?:chk|dias)"/,
  'a interface não pode permitir desligar a nuvem nem escolher retenção clínica');
assert.doesNotMatch(source, /id="arq-auto-chk"|onclick="arquivo\.(?:arquivarAgora|restaurarTodos)\(/,
  'controles legados não podem oferecer retenção permanente no aparelho');
assert.match(source, /backupCompleto\._bloquearClinicaAtiva\(\)/,
  'backup local não pode fingir ser completo nem restaurar sobre clínica cloud-only');
assert.match(source, /demo\.ativo\(\)[\s\S]*programador\.souProgramador\(\)/,
  'exportação legada deve ficar restrita a demonstração/programador fora da clínica');
assert.match(source, /store\.purgarArtefatosConfirmadosDuraveis\(\)/,
  'manutenção deve remover índice, auditoria, versões e blobs confirmados legados');
assert.doesNotMatch(source, /id="realtime-chk"/,
  'tempo real obrigatório não pode ser apresentado como checkbox desligável');
assert.match(source, /Tempo real obrigatório[\s\S]*realtime-primary-status/,
  'Diagnóstico deve mostrar o estado do canal Realtime primário');
assert.match(source, /encerrarAcesso\(\)[\s\S]*cloud\.logout\(\{ silent: true \}\)[\s\S]*auth\.logout\(\)/,
  'desconectar da nuvem pela interface também deve bloquear a sessão local');
assert.match(source, /encerrarAcesso\(\)[\s\S]*contextoAba\.bloquearOutrasAbas\(\)[\s\S]*cloud\.logout/,
  'saída completa deve avisar as outras abas antes de apagar a identidade atual');
assert.doesNotMatch(source, /de volta no aparelho/,
  'interface cloud-only não pode alegar retenção permanente ao carregar registros');

let purges = 0;
const modeStorage = new MemoryStorage();
const modeSandbox = {
  localStorage: modeStorage,
  contextoAba: { operational: () => true },
  cloud: { estaConfigurado: () => true, estaLogado: () => true, sessaoExpirada: () => false },
  store: { purgarConfirmadosDuraveis: () => { purges++; return 3; } },
  navigator: { onLine: true },
  armazenamento: { render() {} },
  toast() {},
  globalThis: null
};
modeSandbox.globalThis = modeSandbox;
vm.createContext(modeSandbox);
vm.runInContext(`${modeSource}\nglobalThis.__modoD4 = modoNuvem;`, modeSandbox);
const modo = modeSandbox.__modoD4;
assert.equal(modo.ligado(), true);
assert.equal(modo.dias(), 0);
assert.equal(await modo.alternar(false), false, 'usuário não pode desligar a política cloud-only');
assert.equal(purges, 0, 'recusa de desligamento não deve mudar dados');
assert.equal(await modo.alternar(true), true);
assert.equal(purges, 1);

assert.match(storeSource, /'financeiro','fin_fechamentos',\s*'orcamento'/,
  'fechamento de caixa também deve sair do armazenamento durável depois do recibo');
assert.match(source, /fin_fechamentos:\s*\{\s*tabela:\s*'cash_closings'/,
  'fechamento de caixa precisa usar o motor relacional versionado');
assert.match(source, /cash_closings:\s*'fin_fechamentos'/,
  'mudança de caixa deve chegar por Realtime aos demais usuários');
assert.match(source, /TRANSPORTE_ADENDO:\s*'cloud-addendum-v1'/);
assert.match(source, /persistenciaCloudFirst\.salvarAdendo/,
  'adendo offline deve entrar no WAL cifrado antes do envio');
assert.match(cashMigration, /create table if not exists public\.cash_closings/);
assert.match(cashMigration, /when 'cash_closings'\s+then 'financeiro'/,
  'catálogo de conflitos deve reconhecer o fechamento pelo módulo financeiro');
assert.match(cashMigration, /force row level security/);
assert.match(cashMigration, /app\.pode_ler_registro_modulo\(/);
assert.match(cashMigration, /app\.pode_editar_registro_modulo\(/);
assert.match(cashMigration, /created_by = \(select auth\.uid\(\)\)/);
assert.match(cashMigration, /last_operation_id/);
assert.match(cashMigration, /supabase_realtime add table/);
assert.match(source, /entry\.tabela === 'cash_closings' \? 'financeiro' : entry\.mod/,
  'conflito de caixa deve usar a permissão financeiro ao chegar ao servidor');
assert.match(source, /metadata\.clientModule === 'fin_fechamentos'[\s\S]*\? 'fin_fechamentos'/,
  'ao voltar do servidor, conflito de caixa deve recuperar a coleção técnica local');

console.log('  ✓ D4: cache clínico cloud-only, recuperação cifrada e contexto isolado');
