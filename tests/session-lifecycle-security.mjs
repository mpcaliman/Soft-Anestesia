/** Regressão D4: sair/bloquear/fechar descarta acesso e preserva o WAL cifrado. */
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
const between = (start, end) => {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  assert.notEqual(a, -1, `início ausente: ${start}`);
  assert.notEqual(b, -1, `fim ausente: ${end}`);
  return source.slice(a, b);
};
const platformSource = between('const contextoAba = (() => {', '\n\n/* FIM DA PLATAFORMA DE CONTEXTO E FILA OFFLINE */');
const storeSource = await readFile(resolve(root, 'src/platform/clinical-store.js'), 'utf8');
const cloudSource = between('const cloud = {', '\n\n/* FIM DO ADAPTADOR SUPABASE */');
const authSource = await readFile(resolve(root, 'src/platform/auth.js'), 'utf8');

class MemoryStorage {
  values = new Map();
  get length() { return this.values.size; }
  key(i) { return Array.from(this.values.keys())[i] ?? null; }
  getItem(k) { return this.values.get(String(k)) ?? null; }
  setItem(k, v) { this.values.set(String(k), String(v)); }
  removeItem(k) { this.values.delete(String(k)); }
}
const classList = () => ({ remove() {}, add() {} });
const shared = new MemoryStorage();
const channels = [];
function runtime(restored = {}) {
  const events = new Map();
  const timers = new Map();
  const snapshots = restored.snapshots || new Map();
  const envelopes = restored.envelopes || new Map();
  const operations = restored.operations || new Map();
  const clone = x => x == null ? x : structuredClone(x);
  const field = { tagName: 'INPUT', type: 'text', value: '', defaultValue: '',
    dataset: { patientIdentityWatch: '1', patientKey: '' } };
  const readonly = { tagName: 'INPUT', type: 'text', readOnly: true, value: '', defaultValue: '', dataset: {} };
  const hidden = { tagName: 'INPUT', type: 'hidden', value: '', defaultValue: '', dataset: {} };
  const textarea = { tagName: 'TEXTAREA', value: '', defaultValue: '', dataset: {} };
  const checkbox = { tagName: 'INPUT', type: 'checkbox', value: 'sim', checked: false, defaultChecked: false, dataset: {} };
  const form = { dataset: { patientKey: '', edicaoViva: '1' } };
  const output = { textContent: '', classList: classList() };
  const canvas = { width: 100, height: 50, erased: false,
    getContext() { return { clearRect: () => { canvas.erased = true; } }; } };
  const app = { style: {} };
  const overlay = { style: {} };
  const document = {
    hidden: false, visibilityState: 'visible',
    addEventListener() {},
    getElementById(id) {
      if (id === 'auth-overlay') return overlay;
      if (['modal-body','ppp','meu-dia-lista','dirty-badge'].includes(id)) return output;
      return null;
    },
    querySelector: s => s === '.app' ? app : null,
    querySelectorAll(s) {
      if (s === '.module input, .module select, .module textarea') return [field, readonly, hidden, textarea, checkbox];
      if (s === '.module form') return [form];
      if (s.includes('canvas')) return [canvas];
      if (s.includes('tbody') || s.includes('signature-preview')) return [output];
      return [];
    }
  };
  const sandbox = {
    console, document, sessionStorage: restored.sessionStorage || new MemoryStorage(),
    crypto: webcrypto, TextEncoder, TextDecoder, atob, btoa, structuredClone,
    navigator: { onLine: true }, location: { hash: '#dashboard' },
    STORAGE: { pre: 'medsys.v7.pre', pacientes: 'medsys.v7.pacientes' }, HISTORY_MAX: 300,
    setTimeout(fn) { const id = timers.size + 1; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); }, setInterval() { return 100; }, clearInterval() {},
    addEventListener(type, fn) { if (!events.has(type)) events.set(type, []); events.get(type).push(fn); },
    dispatchEvent(event) { (events.get(event.type) || []).forEach(fn => fn(event)); },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    BroadcastChannel: class {
      constructor() { this.messages = []; channels.push(this); }
      postMessage(message) { this.messages.push(clone(message)); }
    },
    toast() {}, pendencias: { esquecerMostrada() {} },
    modal: { close() {} }, ui: { fecharDropdowns() {} },
    state: { dirty: false, importTarget: null, sigDrawing: false, currentModule: 'pre' },
    prontuario: { _docs: {} }, pre: { _linkPendente: null, meds: { _lista: [] } },
    linker: { _preBuscadaNaNuvem: {} },
    escritaContinua: { _timers: {} },
    pdfBackup: { TOKEN_KEY: 'medsys.v7.pdfbk.token', _accessToken: null, _tokenExpira: 0 },
    modoNuvem: { aoSair() {} }
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  Object.defineProperty(sandbox, 'localStorage', { value: shared, writable: true, configurable: true });
  vm.createContext(sandbox);
  vm.runInContext(`${platformSource}\n${storeSource}\n${cloudSource}\n${authSource}\nglobalThis.__lifecycle = { contextoAba, filaCifrada, store, cloud, auth };`, sandbox);
  const { contextoAba, filaCifrada: vault, store, cloud, auth } = sandbox.__lifecycle;
  const driver = {
    async getEnvelope(k) { return clone(envelopes.get(k)); },
    async addEnvelope(v) { if (envelopes.has(v.ownerKey)) return false; envelopes.set(v.ownerKey, clone(v)); return true; },
    async getOperation(k) { return clone(operations.get(k)); },
    async addOperation(v) { if (operations.has(v.operationId)) return false; operations.set(v.operationId, clone(v)); return true; },
    async listOperations(ownerKey) { return Array.from(operations.values()).filter(v => v.ownerKey === ownerKey).map(clone); },
    async deleteOperation(k) { operations.delete(k); },
    async putSnapshot(v) { snapshots.set(v.snapshotId, clone(v)); return true; },
    async listSnapshots(ownerKey) { return Array.from(snapshots.values()).filter(v => v.ownerKey === ownerKey).map(clone); }
  };
  vault._definirDriverParaTeste(driver);
  vault._buscarKekServidor = async dono => ({ material: Uint8Array.from({ length: 32 }, (_, i) => i + (dono.userId === 'user-a' ? 1 : 2)), keyVersion: 1 });
  cloud._atualizarUI = () => {};
  auth._render = () => {};
  auth.init();
  const pendingSnapshots = [];
  let captureOwner = null;
  sandbox.ambiente = {
    aoSair() {
      captureOwner = contextoAba.capturar();
      if (contextoAba.operational() && field.value) pendingSnapshots.push(vault.salvarSnapshot('live-edit', 'pre', { nome: field.value }));
      return { preservou: operations.size > 0 };
    }
  };
  const login = async (uid = 'user-a', org = 'aaaaaaaa-1111-4111-8111-111111111111') => {
    sandbox.sessionStorage.setItem(cloud.SESSION_KEY, JSON.stringify({ user: { id: uid }, access_token: 'token-' + uid, refresh_token: 'refresh-' + uid }));
    contextoAba.prepararUsuario(uid, { forcar: true });
    assert.equal(contextoAba.vincular({ uid, organization_id: org, role: 'gestor' }, 'Clínica'), true);
    auth._definirSessao({ id: uid, uid, usuario: uid, perfil: 'admin', modulos: ['pre'], organization_id: org });
    await vault.preparar();
    field.value = field.defaultValue = 'Paciente Sigiloso';
    readonly.value = readonly.defaultValue = '54 anos';
    hidden.value = hidden.defaultValue = 'registro-clinico';
    textarea.value = textarea.defaultValue = 'História clínica privada';
    checkbox.checked = checkbox.defaultChecked = true;
    field.dataset.patientKey = form.dataset.patientKey = 'identidade-clinica';
    output.textContent = 'Prontuário renderizado'; canvas.erased = false;
    store._lembrar('pre', [{ _id: 'registro-clinico', nome: field.value }]);
    sandbox.pre.meds._lista = [{ medicamento: 'Medicação da pessoa anterior' }];
    sandbox.prontuario._docs = { pre: [{ dataurl: 'data:imagem-sigilosa' }] };
    sandbox.linker._preBuscadaNaNuvem = { 'Paciente Sigiloso': true };
    sandbox.pdfBackup._accessToken = 'token-drive';
    sandbox.sessionStorage.setItem(sandbox.pdfBackup.TOKEN_KEY, 'token-drive');
    sandbox.state.dirty = true;
  };
  const assertClosed = () => {
    assert.equal(auth.estaLogado(), false);
    assert.equal(cloud.estaLogado(), false);
    assert.equal(contextoAba.operational(), false);
    assert.equal(sandbox.sessionStorage.getItem(contextoAba.CONTEXT_KEY), null);
    assert.equal(vault._chaves.size, 0);
    assert.equal(vault._aberturas.size, 0);
    assert.equal(store._memoria.size, 0);
    for (const el of [field, readonly, hidden, textarea]) { assert.equal(el.value, ''); assert.equal(el.defaultValue, ''); }
    assert.equal(checkbox.checked, false); assert.equal(checkbox.defaultChecked, false);
    assert.equal(checkbox.value, 'sim', 'valor estático da opção deve permanecer utilizável');
    assert.equal(field.dataset.patientKey, undefined); assert.equal(form.dataset.patientKey, undefined);
    assert.equal(field.dataset.patientIdentityWatch, '1', 'listener já ligado não deve duplicar no próximo login');
    assert.equal(form.dataset.edicaoViva, '1');
    assert.equal(output.textContent, ''); assert.equal(canvas.erased, true);
    assert.equal(sandbox.pre.meds._lista.length, 0); assert.equal(Object.keys(sandbox.prontuario._docs).length, 0);
    assert.equal(Object.keys(sandbox.linker._preBuscadaNaNuvem).length, 0);
    assert.equal(sandbox.pdfBackup._accessToken, null);
    assert.equal(sandbox.sessionStorage.getItem(sandbox.pdfBackup.TOKEN_KEY), null);
    assert.equal(sandbox.state.dirty, false);
    assert.equal(overlay.style.display, 'flex');
  };
  return { sandbox, auth, cloud, vault, store, contextoAba, login, assertClosed, pendingSnapshots,
    operations, snapshots, envelopes, overlay, field, get captureOwner() { return captureOwner; }, events, timers };
}

const r = runtime();
await r.login();
await r.vault.enfileirar({ operationId: 'wal-pendente', module: 'pre', entityId: 'registro-clinico',
  payload: { nome: 'Paciente Sigiloso', dados: 'Operação offline ainda sem recibo' } });
const before = structuredClone(r.operations.get('wal-pendente'));
r.auth.logout();
r.assertClosed();
assert.equal(r.captureOwner.userId, 'user-a', 'trabalho aberto deve ser capturado antes de invalidar a identidade');
await Promise.all(r.pendingSnapshots);
assert.deepEqual(r.operations.get('wal-pendente'), before, 'logout jamais descarta nem altera a operação cifrada pendente');
assert.doesNotMatch(JSON.stringify(Array.from(r.snapshots.values())), /Paciente Sigiloso/);
assert.equal(channels[0].messages.length, 1, 'logout manual bloqueia as outras abas da mesma conta uma vez');
await assert.rejects(r.vault.listar(), e => e.code === 'contexto_nao_confirmado');
await r.login('user-b');
assert.equal((await r.vault.listar()).length, 0, 'outra pessoa da mesma clínica não consegue abrir o WAL anterior');
assert.equal((await r.vault.listarSnapshots('live-edit')).length, 0);
r.auth.logout({ broadcast: false });
await Promise.all(r.pendingSnapshots);
await r.login();
assert.equal((await r.vault.listar())[0].payload.nome, 'Paciente Sigiloso', 'o mesmo dono recupera a operação após autenticar novamente');
assert.equal((await r.vault.listarSnapshots('live-edit'))[0].payload.nome, 'Paciente Sigiloso');

for (const type of ['lock', 'logout']) {
  await r.login();
  const broadcasts = channels[0].messages.length;
  r.sandbox.dispatchEvent({ type: 'medsys:auth-event', detail: { type, userId: 'user-a' } });
  r.assertClosed();
  await Promise.all(r.pendingSnapshots);
  assert.equal(channels[0].messages.length, broadcasts, 'evento recebido não pode criar ciclo de broadcasts');
}
await r.login();
r.auth.bloquearAgora();
r.assertClosed();
await Promise.all(r.pendingSnapshots);
await r.login();
r.auth._resetTimer();
r.timers.get(r.auth._timer)();
r.assertClosed();
await Promise.all(r.pendingSnapshots);

/* Uma página mantida no BFCache também precisa voltar bloqueada. */
await r.login();
const broadcasts = channels[0].messages.length;
r.sandbox.dispatchEvent({ type: 'pagehide', persisted: true });
r.assertClosed();
await Promise.all(r.pendingSnapshots);
assert.equal(channels[0].messages.length, broadcasts, 'fechar uma aba preserva o acesso das demais abas da conta');
assert.deepEqual(r.operations.get('wal-pendente'), before);

/* Resposta tardia de permissões não pode reabrir a conta após sair. */
await r.login();
r.cloud.estaConfigurado = () => true;
let resolveProfile;
r.cloud.buscarPerfil = () => new Promise(resolve => { resolveProfile = resolve; });
const revalidation = r.auth.revalidarAcesso();
r.auth.logout({ broadcast: false });
resolveProfile({ uid: 'user-a', role: 'auxiliar' });
assert.equal(await revalidation, false);
r.assertClosed();
await Promise.all(r.pendingSnapshots);

/* Queda sem pagehide: o navegador devolve toda a sessionStorage do processo
   anterior. Nenhum evento de logout foi disparado e o JWT continua válido. */
await r.login();
const crashSession = new MemoryStorage();
r.sandbox.sessionStorage.values.forEach((v, k) => crashSession.setItem(k, v));
crashSession.setItem('medsys.v7.pdfbk.token@aaaaaaaa', 'drive-restaurado');
const ciphertext = structuredClone(r.operations.get('wal-pendente'));
const restored = runtime({ sessionStorage: crashSession, envelopes: r.envelopes,
  operations: r.operations, snapshots: r.snapshots });
assert.equal(restored.auth.usuarioAtual(), null, 'espelho recuperado após crash nunca autentica novo documento');
assert.equal(restored.cloud.session(), null, 'access/refresh token recuperados não podem voltar a ser usados');
assert.equal(restored.contextoAba.operational(), false);
assert.equal(restored.contextoAba.atual().verified, false);
assert.equal(restored.overlay.style.display, 'flex', 'documento restaurado permanece na tela de autenticação');
assert.equal(restored.vault._chaves.size, 0, 'nenhuma chave clínica passa de um documento para outro');
assert.equal(restored.sandbox.sessionStorage.getItem('medsys.v7.pdfbk.token'), null);
assert.equal(restored.sandbox.sessionStorage.getItem('medsys.v7.pdfbk.token@aaaaaaaa'), null);
assert.deepEqual(restored.operations.get('wal-pendente'), ciphertext, 'boot não apaga pendências offline cifradas');
await assert.rejects(restored.vault.listar(), e => e.code === 'contexto_nao_confirmado');
await restored.login('user-b');
assert.equal((await restored.vault.listar()).length, 0, 'outro usuário não recupera a pendência após crash');
await restored.login();
assert.equal((await restored.vault.listar())[0].payload.nome, 'Paciente Sigiloso', 'o proprietário recupera seu WAL após autenticação nova');
restored.sandbox.navigator.onLine = false;
assert.equal((await restored.vault.listar())[0].payload.nome, 'Paciente Sigiloso', 'a sessão deste documento continua funcionando ao perder conexão');
console.log('  ✓ D4: logout, bloqueio, BFCache e restauração após crash fecham acesso/DOM sem perder WAL cifrado');
