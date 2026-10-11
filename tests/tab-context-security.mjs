/** Regressão D1: cada aba mantém identidade e clínica imutáveis durante I/O. */
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

const shared = new MemoryStorage({
  'medsys.v5.pacientes': JSON.stringify([{ _id: 'legado', nome: 'Não pode aparecer' }]),
  'medsys.v7.cloud.org_id': 'ponteiro-legado-invalido',
  'medsys.v7.auth.session': JSON.stringify({ id: 'stale-user' }),
  'medsys.v7.auth.sessao_dia': JSON.stringify({ dia: '2026-10-07', sess: { id: 'stale-user' } }),
  'medsys.v7.cloud.session': JSON.stringify({ access_token: 'stale-token', user: { id: 'stale-user' } })
});
const contextSource = between('const contextoAba = (() => {', "const DEMO_FLAG = 'medsys.v7.demo';");
let nextId = 0;

const abrirAba = ({ uid, org } = {}) => {
  const session = new MemoryStorage();
  const events = new Map();
  const sandbox = {
    console,
    sessionStorage: session,
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}` },
    setInterval: () => 1,
    clearInterval: () => {},
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    BroadcastChannel: class BroadcastChannel {
      constructor(name) { this.name = name; this.onmessage = null; }
      postMessage() {}
      close() {}
    },
    addEventListener(type, fn) { events.set(type, fn); },
    dispatchEvent(ev) { const fn = events.get(ev.type); if (fn) fn(ev); }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  Object.defineProperty(sandbox, 'localStorage', { value: shared, configurable: true, writable: true });
  vm.createContext(sandbox);
  vm.runInContext(`${contextSource}\nglobalThis.__d1 = { contextoAba, cofre };`, sandbox);
  if (uid && org) {
    /* Um login novo acontece após o bootstrap, nunca por credenciais de uma
       aba que o navegador recuperou de um processo anterior. */
    session.setItem('medsys.v7.auth.session', JSON.stringify({ uid, organization_id: org }));
    session.setItem('medsys.v7.cloud.session', JSON.stringify({
      access_token: `token-${uid}`, user: { id: uid, email: `${uid}@teste.local` }
    }));
    assert.equal(sandbox.__d1.contextoAba.vincular({ uid, organization_id: org, role: 'gestor', orgs: 1 }, org), true);
  }
  return sandbox;
};

const orgA = 'aaaaaaaa-1111-4111-8111-111111111111';
const orgB = 'bbbbbbbb-2222-4222-8222-222222222222';
const abaA = abrirAba({ uid: 'user-a', org: orgA });
const abaB = abrirAba({ uid: 'user-b', org: orgB });

assert.equal(shared.getItem('medsys.v7.auth.session'), null,
  'sessão de app persistente legada deve ser expurgada antes de restaurar contexto');
assert.equal(shared.getItem('medsys.v7.auth.sessao_dia'), null,
  'marcador diário legado deve ser expurgado em computador multiusuário');
assert.equal(shared.getItem('medsys.v7.cloud.session'), null,
  'token Supabase persistente legado nunca pode autenticar outra aba');

abaA.localStorage.setItem('medsys.v5.pacientes', JSON.stringify([{ _id: 'a', nome: 'Paciente A' }]));
abaB.localStorage.setItem('medsys.v5.pacientes', JSON.stringify([{ _id: 'b', nome: 'Paciente B' }]));

assert.equal(abaA.__d1.contextoAba.organizationId(), orgA);
assert.equal(abaB.__d1.contextoAba.organizationId(), orgB);
assert.equal(JSON.parse(abaA.localStorage.getItem('medsys.v5.pacientes'))[0].nome, 'Paciente A');
assert.equal(JSON.parse(abaB.localStorage.getItem('medsys.v5.pacientes'))[0].nome, 'Paciente B');
assert.equal(JSON.parse(shared.getItem('medsys.v5.pacientes@aaaaaaaa'))[0].nome, 'Paciente A');
assert.equal(JSON.parse(shared.getItem('medsys.v5.pacientes@bbbbbbbb'))[0].nome, 'Paciente B');

/* Um ponteiro global sobrescrito por qualquer aba não muda a rota já vinculada. */
shared.setItem('medsys.v7.cloud.org_id', orgB);
assert.equal(abaA.__d1.contextoAba.organizationId(), orgA);
assert.equal(JSON.parse(abaA.localStorage.getItem('medsys.v5.pacientes'))[0].nome, 'Paciente A');

/* Login incompleto/falha de perfil fica em quarentena, sem ler o legado cru. */
const abaSemContexto = abrirAba();
assert.equal(abaSemContexto.localStorage.getItem('medsys.v5.pacientes'), null);
abaSemContexto.localStorage.setItem('medsys.v5.pacientes', '[{"_id":"quarentena"}]');
assert.equal(shared.getItem('medsys.v5.pacientes'), JSON.stringify([{ _id: 'legado', nome: 'Não pode aparecer' }]));
assert.match(Array.from(shared.values.keys()).find(k => k.startsWith('medsys.v5.pacientes@unbound-')) || '', /@unbound-/);

const contexto = between('const contextoAba = (() => {', 'const cofre = {');
assert.match(contexto, /sessionStorage\.setItem\(CONTEXT_KEY/,
  'contexto da clínica deve pertencer à aba');
assert.match(contexto, /\^\(lock\|logout\)\$/,
  'BroadcastChannel pode transportar somente bloqueio ou saída');
assert.doesNotMatch(contexto, /postMessage\([^)]*organizationId/,
  'BroadcastChannel não pode distribuir ponteiro de clínica');

const cofre = between('const cofre = {', "const DEMO_FLAG = 'medsys.v7.demo';");
assert.match(cofre, /contextoAba\.organizationId\(\)/,
  'gaveta local deve usar o contexto imutável da aba');
assert.doesNotMatch(cofre.slice(cofre.indexOf('  org()'), cofre.indexOf('  sufixo(')), /getItem\(cofre\.ORG_KEY|getItem\(ORG_KEY/,
  'ponteiro global legado não pode rotear dados');
assert.match(cofre, /@unbound-/,
  'aba sem organização confirmada precisa de quarentena própria');

const cloud = between('const cloud = {', '/* ============================================================================\n   CONFIGURAÇÕES NA NUVEM');
const sessionStore = between('  _lojaSessao() {', '  _gravarSessao(sess) {');
assert.match(sessionStore, /sessionStorage/);
assert.doesNotMatch(sessionStore, /return\s+localStorage/,
  'sessão em uso nunca pode ser compartilhada entre abas');
const login = between('  async login(email, senha, opts) {', '  async confirmarContexto() {');
assert.match(login, /contextoAba\.prepararUsuario/,
  'login deve invalidar o contexto anterior antes de gravar a nova sessão');
assert.doesNotMatch(login, /setTimeout\([^\n]*cloud\.sincronizar/,
  'login não pode sincronizar antes de confirmar o perfil e a clínica');
assert.match(cloud, /_mesmoDonoFila[\s\S]*organizationId[\s\S]*userId[\s\S]*deviceId/,
  'fila legada deve filtrar organização, usuário e aparelho');
const confirmar = between('  async confirmarContexto() {', '  _refreshPromise: null,');
assert.match(confirmar, /contextoFinal\.userId\s*!==\s*uidInicial[\s\S]*contextoFinal\.organizationId/,
  'confirmação da clínica deve rejeitar resposta que terminou em outra identidade');
const autoSync = between('  autoSyncAoEntrar() {', '  autoSyncAoVoltar(opts = {}) {');
assert.match(autoSync, /const contexto = cloudRel\._capturarContexto\(\)[\s\S]*const agendar =[\s\S]*if \(!contextoValido\(\)\) return/,
  'tarefas atrasadas do login devem pertencer à geração que as agendou');

const rel = between('const cloudRel = {', '/* FIM DA PERSISTÊNCIA RELACIONAL */');
assert.match(rel, /contextoAba\.compativelComSessoes\(cloud\.session\(\), auth\.usuarioAtual\(\)\)/,
  'I/O relacional deve exigir a mesma identidade nas duas sessões');
assert.match(rel, /organizationId:\s*dono\.organizationId[\s\S]*userId:\s*dono\.userId[\s\S]*deviceId:\s*dono\.deviceId[\s\S]*tabId:\s*dono\.tabId/,
  'operações offline precisam carregar o dono completo e a aba de origem');
assert.match(rel, /_contextoValido\(contexto, org\)/,
  'respostas assíncronas devem validar novamente o contexto capturado');

const realtime = between('const realtime = {', 'const sincronia = {');
assert.match(realtime, /filter:\s*'organization_id=eq\.'\s*\+\s*contexto\.organizationId/,
  'Realtime primário deve filtrar a organização no servidor');
assert.match(realtime, /linha\.organization_id[\s\S]*contexto\.organizationId/,
  'cada evento Realtime deve ser conferido no cliente');

const realtimeBeta = between('const cloudRealtime = {', '/* Uma troca controlada invalida sockets');
assert.match(realtimeBeta, /conectar\(\)\s*\{\s*return realtime\.conectar\(\)/,
  'compatibilidade Realtime deve delegar ao cliente obrigatório com filtro por organização');
assert.doesNotMatch(realtimeBeta, /new WebSocket|_ultimoEnvioTs/,
  'um segundo transporte não pode descartar eventos concorrentes durante a janela de eco');

const syncLoop = between('const sincronia = {', 'try { window.sincronia = sincronia;');
assert.match(syncLoop, /const contextoValido = \(\) => cloudRel\._contextoValido[\s\S]*await cloudRel\.drenarFila\(\);[\s\S]*if \(!contextoValido\(\)\) return/,
  'ciclo automático deve parar entre operações quando a aba troca de dono');

const pdfQueue = between('const pdfFila = {', 'try { window.pdfFila = pdfFila;');
assert.match(pdfQueue, /organizationId:\s*dono\.organizationId[\s\S]*cloudUserId:\s*dono\.cloudUserId[\s\S]*deviceId:\s*dono\.deviceId[\s\S]*tabId:\s*dono\.tabId/,
  'fila binária deve carregar clínica, usuário, aparelho e aba de origem');
const drive = between('const driveImport = {', '/* ============================================================================\n   FILA DE PDFs QUE NÃO SUBIRAM');
assert.match(drive, /_tokenLeitura\(contextoEsperado\)[\s\S]*_contextoValido\(contextoEsperado\)/,
  'token do Drive não pode sobreviver a uma troca de contexto');

console.log('  ✓ D1: contexto imutável por aba, filas com dono e Realtime isolado por clínica');
