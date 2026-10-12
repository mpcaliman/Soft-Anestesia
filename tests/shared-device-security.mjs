/** Regressão D2: logout compartilhado isola sem apagar trabalho offline. */
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

const between = (start, end) => {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  assert.notEqual(a, -1, `início não encontrado: ${start}`);
  assert.notEqual(b, -1, `fim não encontrado: ${end}`);
  return source.slice(a, b);
};

class MemoryStorage {
  constructor(initial = {}) { this.values = new Map(Object.entries(initial)); }
  get length() { return this.values.size; }
  key(index) { return Array.from(this.values.keys())[index] ?? null; }
  getItem(key) { return this.values.has(String(key)) ? this.values.get(String(key)) : null; }
  setItem(key, value) { this.values.set(String(key), String(value)); }
  removeItem(key) { this.values.delete(String(key)); }
  clear() { this.values.clear(); }
}

/* Metadados da equipe seguem a clínica; não ficam crus no navegador. */
const shared = new MemoryStorage({
  'medsys.v7.auth.users': '[{"usuario":"legado@outra.clinica"}]'
});
const contextSource = between('const contextoAba = (() => {', "const DEMO_FLAG = 'medsys.v7.demo';");
let nextId = 0;
const abrirAba = (uid, org) => {
  const sessionStorage = new MemoryStorage();
  const sandbox = {
    console, sessionStorage,
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}` },
    setInterval: () => 1, clearInterval: () => {},
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    BroadcastChannel: class BroadcastChannel { postMessage() {} close() {} },
    addEventListener() {}, dispatchEvent() {}
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  Object.defineProperty(sandbox, 'localStorage', { value: shared, configurable: true, writable: true });
  vm.createContext(sandbox);
  vm.runInContext(`${contextSource}\nglobalThis.__d2 = { contextoAba, cofre };`, sandbox);
  sessionStorage.setItem('medsys.v7.auth.session', JSON.stringify({ uid, organization_id: org }));
  sessionStorage.setItem('medsys.v7.cloud.session', JSON.stringify({ access_token: 't-' + uid, user: { id: uid } }));
  assert.equal(sandbox.__d2.contextoAba.vincular({ uid, organization_id: org, role: 'gestor' }, ''), true);
  return sandbox;
};

const abaA = abrirAba('user-a', 'aaaaaaaa-1111-4111-8111-111111111111');
const abaB = abrirAba('user-b', 'bbbbbbbb-2222-4222-8222-222222222222');
abaA.localStorage.setItem('medsys.v7.auth.users', '[{"usuario":"equipe-a@teste.local"}]');
assert.equal(JSON.parse(abaA.localStorage.getItem('medsys.v7.auth.users'))[0].usuario, 'equipe-a@teste.local');
assert.equal(abaB.localStorage.getItem('medsys.v7.auth.users'), null);
assert.equal(shared.getItem('medsys.v7.auth.users'), '[{"usuario":"legado@outra.clinica"}]',
  'metadado legado sem organização deve permanecer inacessível, não ser adotado');
assert.equal(shared.getItem('medsys.v7.auth.users@aaaaaaaa'), '[{"usuario":"equipe-a@teste.local"}]');

const cofre = between('const cofre = {', "const DEMO_FLAG = 'medsys.v7.demo';");
const deviceList = between('  DO_APARELHO: [', "  ],\n\n  _real: null");
assert.doesNotMatch(deviceList, /medsys\.v7\.auth\.users/,
  'nomes/e-mails/papéis da equipe não podem ser globais no computador');
assert.match(cofre, /cofre\.DO_APARELHO\.indexOf\(k\) < 0/,
  'toda chave não classificada precisa cair na gaveta isolada');

const ambiente = between('const ambiente = {', '\n};\n\nconst programador = {');
const sharedPolicy = between('  compartilhado() {', '\n  PERGUNTOU_KEY:');
assert.match(sharedPolicy, /return true/,
  'todo aparelho deve seguir a política multiusuário');
assert.doesNotMatch(sharedPolicy, /getItem\(ambiente\.COMPART_KEY\)/,
  'preferência antiga não pode desativar a proteção multiusuário');
const defineShared = between('  definirCompartilhado(lig, opts = {}) {', '\n\n  /* ---------- a limpeza');
assert.doesNotMatch(defineShared, /setItem\(ambiente\.COMPART_KEY/,
  'interface não pode persistir exceção de aparelho pessoal');
assert.match(defineShared, /removeItem\(cloud\.SESSION_KEY\)/,
  'compatibilidade deve purgar token persistente legado');
const inventario = between('  _pendenciasDuraveis(org) {', '  _ultimaLimpeza: null,');
for (const evidence of [
  'FILA_KEY', 'FILA_DEL_KEY', 'QUEUE_KEY', '_enviosAtivos', '_relUpdatedAt',
  '_adendos', '_draftVersion', '_draftSyncedLocalAt',
  'rascunhos_fechados', 'medsys.v7.edicao.', 'clinicaSync.CHAVES', 'recibo.hash',
  'CONFLITOS_KEY'
]) {
  assert.match(inventario, new RegExp(evidence), `inventário precisa cobrir ${evidence}`);
}
assert.match(ambiente, /doc\.dataurl && \(!doc\.storage_path \|\| !doc\.cloud_confirmed_at\)/,
  'anexo local só é dispensável depois do recibo do registro pai');
assert.match(ambiente, /edicaoViva\.guardar\(mod\)/,
  'o formulário aberto precisa ser materializado antes de trocar o contexto');

/* Rascunhos pertencem a organization_id + user_id no servidor. A mesma
   fronteira precisa existir no armazenamento transitório, pois duas pessoas
   da mesma clínica podem usar este navegador em sequência. */
const draftsSource = between('const rascunhos = {', '\n/* ============================================================================\n   LINKER — vínculos entre documentos');
assert.match(draftsSource, /\.u\.['"]?\s*\+\s*uid\.replace/,
  'chaves de rascunho precisam carregar o usuário, além da gaveta da clínica');
assert.doesNotMatch(draftsSource, /getItem\(rascunhos\.(?:KEY_LIST|KEY_ATIVO|LAPIDES_KEY)\s*\+\s*mod\)/,
  'rascunho não pode reler a chave antiga sem dono');
const draftStorage = new MemoryStorage();
let draftOwner = { generation: 1, userId: 'medico-a', organizationId: 'clinica-a',
  deviceId: 'computador-1', tabId: 'tab-a', verified: true };
const draftSnapshots = new Map();
const draftOwnerKey = dono => [dono.organizationId, dono.userId, dono.deviceId].join(':');
const draftVault = {
  salvarSnapshot(namespace, key, payload) {
    const ownerKey = draftOwnerKey(draftOwner);
    const value = structuredClone({ namespace, key, payload, updatedAt: new Date().toISOString() });
    return Promise.resolve().then(() => {
      draftSnapshots.set(ownerKey + ':' + namespace + ':' + key, value);
      return { ok: true, durable: true };
    });
  },
  async listarSnapshots(namespace) {
    const ownerKey = draftOwnerKey(draftOwner) + ':' + namespace + ':';
    return Array.from(draftSnapshots.entries()).filter(([key]) => key.startsWith(ownerKey)).map(([, value]) => structuredClone(value));
  },
  async removerSnapshot(namespace, key) {
    draftSnapshots.delete(draftOwnerKey(draftOwner) + ':' + namespace + ':' + key);
    return { ok: true, durable: true };
  }
};
const draftRuntime = {
  console, localStorage: draftStorage, structuredClone, filaCifrada: draftVault,
  contextoAba: {
    atual: () => draftOwner, capturar: () => structuredClone(draftOwner),
    corresponde: snap => !!snap && snap.generation === draftOwner.generation &&
      snap.userId === draftOwner.userId && snap.organizationId === draftOwner.organizationId,
    aoMudar() {}
  },
  store: { cloudOnlyAtivo: () => true },
  rascunhosSync: { _indisponivel: () => true },
  toast() {}
};
draftRuntime.window = draftRuntime;
draftRuntime.globalThis = draftRuntime;
vm.createContext(draftRuntime);
vm.runInContext(`${draftsSource}\nglobalThis.__draftsD2 = rascunhos;`, draftRuntime);
draftRuntime.__draftsD2.setList('pre', [{ id: 'draft-a', dados: { paciente_nome: 'Paciente do médico A' }, updatedAt: '2026-10-07T10:00:00.000Z' }]);
await draftRuntime.__draftsD2.aguardarPersistencia('pre');
assert.equal(draftStorage.getItem('medsys.v7.rascunhos.pre.u.medico-a'), null,
  'rascunho cloud-only não pode persistir prontuário em texto claro');
draftOwner = { generation: 2, userId: 'secretaria-b', organizationId: 'clinica-a',
  deviceId: 'computador-1', tabId: 'tab-b', verified: true };
assert.deepEqual(Array.from(draftRuntime.__draftsD2.list('pre')), [],
  'segunda pessoa da mesma clínica não pode herdar o rascunho local da primeira');
draftRuntime.__draftsD2.setList('pre', [{ id: 'draft-b', dados: { paciente_nome: 'Paciente da pessoa B' }, updatedAt: '2026-10-07T10:01:00.000Z' }]);
await draftRuntime.__draftsD2.aguardarPersistencia('pre');
draftOwner = { generation: 3, userId: 'medico-a', organizationId: 'clinica-a',
  deviceId: 'computador-1', tabId: 'tab-c', verified: true };
await draftRuntime.__draftsD2.restaurarCifrado();
assert.equal(draftRuntime.__draftsD2.list('pre')[0].id, 'draft-a',
  'ao retornar, o dono deve reencontrar somente o próprio rascunho');

const liveEditSource = between('const edicaoViva = {', '\n/* ============================================================================\n   POLÍTICA CLOUD-ONLY');
assert.match(liveEditSource, /_lerLegadoDoMesmoDono[\s\S]*legado\.uid[\s\S]*!==\s*uid/,
  'edição viva legada só pode ser adotada com UID exato no payload');
assert.match(liveEditSource,
  /filaCifrada\.salvarSnapshot\('live-edit', mod, rascunho\)/,
  'edição viva deve usar snapshot cifrado, inclusive quando estiver offline');
assert.match(liveEditSource, /confirmarSalvamento[\s\S]*edicaoViva\._mem\.get\(mod\) !== capturado/,
  'recibo tardio não pode apagar caracteres digitados depois do clique');

const liveStorage = new MemoryStorage();
let liveOwner = { generation: 1, userId: 'medico-a', organizationId: 'clinica-a',
  deviceId: 'computador-1', tabId: 'live-a', verified: true };
const liveSnapshots = new Map();
const liveOwnerKey = dono => [dono.organizationId, dono.userId, dono.deviceId].join(':');
const liveVault = {
  salvarSnapshot(namespace, key, payload) {
    const ownerKey = liveOwnerKey(liveOwner);
    const value = structuredClone({ namespace, key, payload, updatedAt: new Date().toISOString() });
    return Promise.resolve().then(() => {
      liveSnapshots.set(ownerKey + ':' + namespace + ':' + key, value);
      return { ok: true, durable: true };
    });
  },
  async listarSnapshots(namespace) {
    const prefix = liveOwnerKey(liveOwner) + ':' + namespace + ':';
    return Array.from(liveSnapshots.entries()).filter(([key]) => key.startsWith(prefix)).map(([, value]) => structuredClone(value));
  },
  async removerSnapshot(namespace, key) {
    liveSnapshots.delete(liveOwnerKey(liveOwner) + ':' + namespace + ':' + key);
    return { ok: true, durable: true };
  }
};
const liveListeners = [];
const liveField = { name: 'paciente_nome', type: 'text', value: '' };
const liveForm = {
  dataset: {}, firstChild: null,
  querySelectorAll: () => [liveField],
  querySelector: () => liveField,
  addEventListener() {}, insertBefore() {}
};
const liveRuntime = {
  console, structuredClone, localStorage: liveStorage, filaCifrada: liveVault,
  setTimeout: () => 1, clearTimeout() {},
  store: { cloudOnlyAtivo: () => true },
  state: { dirty: true },
  rascunhosSync: { _indisponivel: () => true, _lerAtual: async () => null, gravarUnico: async () => ({ ok: false, offline: true }) },
  auth: { usuarioAtual: () => ({ usuario: liveOwner.userId }) },
  contextoAba: {
    atual: () => liveOwner, capturar: () => structuredClone(liveOwner),
    corresponde: snap => !!snap && snap.generation === liveOwner.generation &&
      snap.userId === liveOwner.userId && snap.organizationId === liveOwner.organizationId,
    aoMudar: fn => liveListeners.push(fn)
  },
  document: { getElementById: id => id === 'form-termo' ? liveForm : null },
  utils: { escapeHTML: String, jsArg: JSON.stringify }
};
liveRuntime.window = liveRuntime;
liveRuntime.globalThis = liveRuntime;
vm.createContext(liveRuntime);
vm.runInContext(`${liveEditSource}\nglobalThis.__liveD4 = edicaoViva;`, liveRuntime);
const live = liveRuntime.__liveD4;
const trocarLive = async next => {
  const anterior = structuredClone(liveOwner);
  liveOwner = next;
  liveListeners.forEach(fn => fn(structuredClone(liveOwner), anterior));
  await live.restaurarCifrado();
};

liveField.value = 'Texto do médico A';
assert.equal(live.guardar('termo', { mudou: true }), true);
await live.aguardarPersistencia('termo');
assert.equal(liveStorage.getItem('medsys.v7.edicao.termo.u.medico-a'), null,
  'formulário cloud-only não pode usar localStorage nem quando ainda não foi salvo');
await trocarLive({ generation: 2, userId: 'secretaria-b', organizationId: 'clinica-a',
  deviceId: 'computador-1', tabId: 'live-b', verified: true });
assert.equal(live.ler('termo'), null, 'usuário seguinte não pode abrir a edição do anterior');
liveField.value = 'Texto da pessoa B';
live.guardar('termo', { mudou: true });
await live.aguardarPersistencia('termo');
await trocarLive({ generation: 3, userId: 'medico-a', organizationId: 'clinica-a',
  deviceId: 'computador-1', tabId: 'live-a-2', verified: true });
assert.equal(live.ler('termo').dados.paciente_nome, 'Texto do médico A');

liveField.value = 'Versão enviada';
live.guardar('termo', { mudou: true });
await live.aguardarPersistencia('termo');
let confirmarRecibo;
const reciboTardio = new Promise(resolve => { confirmarRecibo = resolve; });
const fechamentoTardio = live.confirmarSalvamento('termo', { _id: 'termo-1' }, reciboTardio);
await Promise.resolve();
liveField.value = 'Caracteres posteriores ao clique';
confirmarRecibo({ ok: true, remoteConfirmed: true, durable: true });
assert.equal(await fechamentoTardio, false,
  'confirmação da versão anterior não pode limpar a digitação posterior');
await live.aguardarPersistencia('termo');
assert.equal(live.ler('termo').dados.paciente_nome, 'Caracteres posteriores ao clique');

liveField.value = 'Versão finalmente protegida';
assert.equal(await live.confirmarSalvamento('termo', { _id: 'termo-2' },
  Promise.resolve({ ok: false, queued: true, durable: true })), true);
await live.aguardarPersistencia('termo');
assert.equal(live.ler('termo'), null, 'WAL durável deve ser seguido por lápide cifrada da edição já salva');
const limpar = between('  limparDadosLocais(org) {', '\n\n  /* ---------- troca de ambiente ----------');
assert.ok(limpar.indexOf('_pendenciasDuraveis(alvo)') < limpar.indexOf('cofre.esvaziar(alvo)'),
  'inventário deve bloquear a exclusão antes de tocar a gaveta');
assert.match(limpar, /if \(inventario\.preservar\)[\s\S]*return 0/,
  'qualquer pendência precisa conservar a gaveta inteira');
assert.doesNotMatch(limpar, /pdfFila\.removerAmbiente/,
  'logout compartilhado não pode apagar PDF que espera reconexão');
assert.match(limpar, /pdfsPreservados:\s*true/,
  'a decisão de preservar a fila binária deve ficar explícita');
assert.doesNotMatch(ambiente, /backupCompleto\.exportar\(\{ silent: true \}\)/,
  'logout não pode despejar prontuário automaticamente na pasta Downloads compartilhada');

/* Executa o inventário com uma gaveta física falsa: além de provar que os
   sinais existem no texto, garante que cada um realmente bloqueia a limpeza
   e que uma gaveta integralmente confirmada ainda pode ser removida. */
const orgD2 = 'aaaaaaaa-1111-4111-8111-111111111111';
const fisicoD2 = chave => `${chave}@${orgD2.slice(0, 8)}`;
const discoD2 = new MemoryStorage();
let esvaziamentos = 0;
const hashD2 = bruto => `h:${String(bruto)}`;
const runtimeD2 = {
  console,
  cofre: {
    DO_APARELHO: [], _real: discoD2,
    real: (chave, org) => `${chave}@${String(org || '').slice(0, 8)}`,
    esvaziar: () => { esvaziamentos++; return 7; }
  },
  disco: { CHAVES: [], _mem: {}, ehGrande: () => false, remove() {} },
  cloudRel: {
    FILA_KEY: 'medsys.v7.rel.fila', FILA_DEL_KEY: 'medsys.v7.rel.fila_del',
    CONFLITOS_KEY: 'medsys.v7.rel.conflitos', MODOS: { pre: {} },
    _enviosAtivos: {}, _reenvios: {}
  },
  cloud: { QUEUE_KEY: 'medsys.v7.cloud.queue' },
  STORAGE: {
    pacientes: 'medsys.v5.pacientes', agenda: 'medsys.v7.agenda', pre: 'medsys.v3.pre'
  },
  rascunhos: { MODS: ['pre'], ativo: () => false, salvarAtual() {} },
  edicaoViva: { MODS: ['termo'], guardar: () => false },
  clinicaSync: {
    META_KEY: 'medsys.v7.clinicasync.meta', CHAVES: { 'medsys.v7.logoCustom': 'logo' },
    _hash: hashD2
  },
  prontuario: { CAMPOS_ANEXO: ['_docs'] },
  contextoAba: { outroAtivoNaOrganizacao: () => false, organizationId: () => orgD2 },
  state: { currentModule: 'dashboard' }
};
vm.createContext(runtimeD2);
vm.runInContext(`${ambiente}\n};\nglobalThis.__ambienteD2 = ambiente;`, runtimeD2);
const inventariar = () => runtimeD2.__ambienteD2._pendenciasDuraveis(orgD2);
const gravarJson = (chave, valor) => discoD2.setItem(fisicoD2(chave), JSON.stringify(valor));

assert.equal(inventariar().preservar, false, 'gaveta vazia não deve ficar bloqueada para sempre');
gravarJson(runtimeD2.STORAGE.pre, [{
  _id: 'confirmado', _updatedAt: '2026-10-07T10:00:00.000Z', _relUpdatedAt: '2026-10-07T10:00:00.000Z'
}]);
assert.equal(inventariar().preservar, false, 'registro com recibo atual pode sair do cache');
gravarJson(runtimeD2.STORAGE.pre, [{ _id: 'somente-local', _updatedAt: '2026-10-07T10:01:00.000Z' }]);
assert.ok(inventariar().motivos.includes('registro_sem_recibo'));

discoD2.clear();
gravarJson('medsys.v7.edicao.termo', { dados: { nome: 'Paciente em digitação' } });
assert.ok(inventariar().motivos.includes('edicao_viva_pendente'));

discoD2.clear();
const cfgLocal = JSON.stringify({ nome: 'Clínica em edição' });
discoD2.setItem(fisicoD2('medsys.v7.logoCustom'), cfgLocal);
assert.ok(inventariar().motivos.includes('configuracao_clinica_sem_recibo'));
gravarJson(runtimeD2.clinicaSync.META_KEY, {
  'medsys.v7.logoCustom': { hash: hashD2(cfgLocal), at: '2026-10-07T10:02:00.000Z' }
});
assert.equal(inventariar().preservar, false, 'hash confirmado é recibo da configuração da clínica');

discoD2.clear();
gravarJson(runtimeD2.cloudRel.FILA_KEY, [{ id: 'pendente' }]);
assert.equal(runtimeD2.__ambienteD2.limparDadosLocais(orgD2), 0);
assert.equal(esvaziamentos, 0, 'fila offline deve bloquear cofre.esvaziar');
discoD2.clear();
assert.equal(runtimeD2.__ambienteD2.limparDadosLocais(orgD2), 7);
assert.equal(esvaziamentos, 1, 'sem pendência, o cache confirmado pode ser removido');

const remover = between('  async remover(mod, item, opts = {}) {', '\n\n  mirrorRegistro(');
assert.ok(remover.indexOf('_filaDelPor(tabela, legacy, filaInicial)') < remover.indexOf('await cloudRel.esperarEnvio'),
  'exclusão precisa entrar na fila durável antes do primeiro await');

const logout = between('  logout(opts) {', '\n\n  /* ---- Fila offline');
assert.match(logout, /saida && saida\.preservou[\s\S]*trabalho ainda não confirmado ficou protegido/,
  'a saída deve informar preservação, sem prometer limpeza que não ocorreu');

console.log('  ✓ D2: computador compartilhado isola metadados e preserva todo trabalho sem recibo');
