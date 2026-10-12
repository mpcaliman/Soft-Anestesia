/** Regra 1: canais reais do cliente, rotação JWT, contexto e edição aberta. */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAppSource } from './helpers/read-app-source.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.find(x => x.startsWith('--app-root='));
const appRoot = arg ? resolve(process.cwd(), arg.slice(11)) : resolve(here, '..');
const source = await readAppSource(appRoot);
function between(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `fonte ausente: ${start}`);
  return source.slice(a, b);
}

class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.style = {}; this.attrs = {}; this.listeners = {}; this.value = ''; }
  get firstChild() { return this.children[0] || null; }
  appendChild(el) { el.parentNode = this; this.children.push(el); return el; }
  insertBefore(el, before) { el.parentNode = this; const i = this.children.indexOf(before); this.children.splice(i < 0 ? 0 : i, 0, el); }
  setAttribute(key, val) { this.attrs[key] = val; }
  addEventListener(key, fn) { this.listeners[key] = fn; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(x => x !== this); }
  querySelector(selector) { return this.fields?.[selector] || null; }
}
const elements = new Map();
const form = new Element('form');
form.fields = Object.fromEntries(['_id', '_caseId', '_caseKey'].map(k => [`[name="${k}"]`, new Element('input')]));
form.fields['[name="_id"]'].value = 'ficha-a';
form.fields['[name="_caseId"]'].value = 'encounter-a';
elements.set('form-anestesia', form);
elements.set('realtime-primary-status', new Element());
let generation = 1;
let organizationId = 'org-a';
let userId = 'user-a';
let token = 'JWT-1';
let refresh = async () => true;
const contexto = () => ({ generation, organizationId, userId, deviceId: 'device-a', tabId: 'tab-a', verified: true });
const lists = new Map();
const wsMessages = [], toasts = [], dispatched = [], network = [], snapshots = new Map();
const intervalo = new Map();
let nextId = 0, respostaStatus = 200;
let gate = null;
const copia = x => JSON.parse(JSON.stringify(x));
class Socket {
  constructor() { this.readyState = 0; }
  send(msg) { wsMessages.push(JSON.parse(msg)); }
  close() { this.readyState = 3; if (this.onclose) this.onclose(); }
  open() { this.readyState = 1; this.onopen(); }
}
const sandbox = {
  console, Map, Set, Date, JSON, Promise,
  navigator: { onLine: true }, WebSocket: Socket,
  state: { currentModule: 'anestesia' },
  STORAGE: { anestesia: 'medsys.anestesia', pre: 'medsys.pre' },
  contextoAba: {
    capturar: contexto, operational: () => true,
    corresponde: c => !!c && c.generation === generation && c.organizationId === organizationId && c.userId === userId,
    organizationId: () => organizationId,
    compativelComSessoes: () => true,
  },
  cloud: {
    config: () => ({ url: 'https://teste.supabase.co', anonKey: 'anon' }),
    session: () => ({ access_token: token, user: { id: userId } }),
    _garantirToken: () => refresh(), _headers: () => ({ Authorization: `Bearer ${token}` }),
    divergencia: () => false, estaConfigurado: () => true, estaLogado: () => true,
  },
  auth: { usuarioAtual: () => ({ uid: userId, role: 'gestor' }) },
  store: {
    list: mod => lists.get(mod) || [],
    setList: (mod, items) => { lists.set(mod, items); return true; },
    getById: (mod, id) => (lists.get(mod) || []).find(x => x._id === id),
  },
  disco: { get: () => null, set: () => { throw new Error('payload clínico não pode persistir em claro'); } },
  localStorage: { getItem: () => null, setItem: () => { throw new Error('persistência local online proibida'); } },
  utils: { uid: () => `client-${++nextId}` },
  rascunhos: { _coletar: () => ({ _id: 'ficha-a', procedimento: 'texto ainda digitado', eventos: [{ tipo: 'Em edição' }] }) },
  persistenciaCloudFirst: {
    temPendente: () => false,
    indisponivel: (r, e) => r ? [408, 425, 429].includes(r.status) || r.status >= 500 : /network|failed to fetch/i.test(e?.message || ''),
  },
  filaCifrada: {
    salvarSnapshot: async (namespace, key, payload) => {
      snapshots.set(`${namespace}:${key}`, { namespace, key, payload: copia(payload), owner: contexto() });
      return { durable: true };
    },
    removerSnapshot: async (namespace, key) => { snapshots.delete(`${namespace}:${key}`); return { durable: true }; },
    listarSnapshots: async namespace => Array.from(snapshots.values()).filter(x => x.namespace === namespace),
  },
  document: {
    getElementById: id => elements.get(id) || null,
    createElement: tag => new Element(tag),
  },
  toast: (...args) => toasts.push(args),
  syncStatus: { refresh() {} }, nuvemEstado: { renderMenu() {} },
  ui: { repintarNuvemAtual() {} },
  setInterval: fn => { const id = ++nextId; intervalo.set(id, fn); return id; },
  clearInterval: id => intervalo.delete(id), setTimeout: () => ++nextId, clearTimeout() {},
  CustomEvent: class { constructor(type, opts) { this.type = type; this.detail = opts.detail; } },
  dispatchEvent: event => dispatched.push(event),
  fetch: async (url, opts = {}) => {
    network.push({ url, opts });
    if (gate) await gate;
    return { ok: respostaStatus < 400, status: respostaStatus,
      json: async () => [{ id: 'conflict-server', status: opts.method === 'PATCH' ? 'resolved_remote' : 'pending' }],
      text: async () => 'rejeitado' };
  },
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(between('const cloudRel = {', '/* FIM DA PERSISTÊNCIA RELACIONAL */') +
  between('const realtime = {', 'const sincronia = {') + '\nglobalThis.api = { cloudRel, realtime };', sandbox);
const { cloudRel, realtime } = sandbox.api;

await realtime.conectar();
const primeiro = realtime._ws;
primeiro.open();
const joins = wsMessages.filter(x => x.event === 'phx_join');
assert.equal(joins.length, Object.keys(realtime.TABELAS).length);
for (const join of joins) {
  assert.equal(join.payload.access_token, 'JWT-1');
  assert.equal(join.payload.config.postgres_changes[0].filter, 'organization_id=eq.org-a');
  assert.equal(join.join_ref, join.ref);
  realtime._receber({ topic: join.topic, ref: join.ref, event: 'phx_reply', payload: { status: 'ok' } }, contexto());
}
assert.equal(elements.get('realtime-primary-status').textContent, 'ativo');
assert.ok(joins.some(x => x.topic.endsWith(':encounters')));
assert.ok(joins.some(x => x.topic.endsWith(':anesthesia_timeline_events')));

/* A passagem da expiração atualiza todos os canais e preserva join_ref. */
refresh = async () => { token = 'JWT-2'; return true; };
await realtime._renovarToken();
const rotations = wsMessages.filter(x => x.event === 'access_token');
assert.equal(rotations.length, joins.length);
for (const join of joins) {
  const rotated = rotations.find(x => x.topic === join.topic);
  assert.equal(rotated.payload.access_token, 'JWT-2');
  assert.equal(rotated.join_ref, join.ref);
}

const event = (table, record, type = 'UPDATE', ctx = contexto()) => realtime._receber({
  topic: `realtime:public:${table}`, event: 'postgres_changes',
  payload: { data: { schema: 'public', table, type, record } },
}, ctx);
const ficha = cloudRel._rowParaRegistro({ id: 'server-ficha-a', organization_id: organizationId,
  encounter_id: 'encounter-a', legacy_id: 'ficha-a', version: 1, updated_at: '2026-10-01',
  data: { _id: 'ficha-a', procedimento: 'versão aberta' } }, organizationId);
assert.equal(ficha._relId, 'server-ficha-a');
assert.equal(ficha._relEncounterId, 'encounter-a');
lists.set('anestesia', [ficha]);

/* Evento remoto preserva digitação ainda não salva e avisa imediatamente. */
let release;
gate = new Promise(resolveGate => { release = resolveGate; });
event('anesthesia_records', { id: 'server-ficha-a', organization_id: organizationId,
  encounter_id: 'encounter-a', legacy_id: 'ficha-a', version: 2, updated_at: '2026-10-02', updated_by: 'user-b',
  data: { _id: 'ficha-a', procedimento: 'versão do colega', eventos: [{ tipo: 'Remoto' }] } });
const conflito = cloudRel._conflitosLer()[0];
assert.equal(conflito.proposed.procedimento, 'texto ainda digitado');
assert.equal(conflito.canonical.procedimento, 'versão do colega');
assert.equal(conflito.metadata.proposedBy, 'user-a');
assert.equal(conflito.metadata.canonicalBy, 'user-b');
assert.ok(conflito.metadata.changedFields.includes('procedimento'));
assert.equal(lists.get('anestesia')[0].procedimento, 'versão aberta');
assert.equal(lists.get('anestesia')[0]._relVersion, 1);
assert.ok(form.children.some(x => x.attrs.role === 'status'));
assert.ok(form.children.some(x => x.children.some(c => c.textContent === 'Comparar versões')));
assert.equal(snapshots.size, 0, 'online, a evidência clínica pertence à memória ou servidor');
release(); gate = null;
await new Promise(resolveTick => setImmediate(resolveTick));
assert.equal(conflito.synced, true);
assert.equal(snapshots.size, 0);

/* Tabelas relacionadas não passam por mesclarLocal/STORAGE fictício. */
cloudRel._cacheEnc['org-a:caso-a'] = 'encounter-a';
event('encounters', { id: 'encounter-a', organization_id: organizationId, legacy_id: 'caso-a',
  version: 2, procedimento: 'Novo procedimento', updated_at: '2026-10-03' });
assert.equal(cloudRel._cacheEnc['org-a:caso-a'], undefined);
assert.equal(realtime.relacionados('encounters')[0].linha.procedimento, 'Novo procedimento');
event('anesthesia_timeline_events', { id: 'event-a', organization_id: organizationId,
  encounter_id: 'encounter-a', anesthesia_record_id: 'server-ficha-a',
  type: 'event', ts: '2026-10-03T12:00:00Z', updated_at: '2026-10-03T12:00:00Z', payload: { texto: "<img onerror='roubo()'>" } });
assert.equal(realtime.relacionados('anesthesia_timeline_events').length, 1);
assert.ok(form.children.some(x => x.children.some(c => c.tagName === 'pre' && c.textContent.includes('<img onerror='))));
assert.equal(lists.get('anestesia')[0].procedimento, 'versão aberta');
assert.equal(dispatched.filter(x => x.type === 'soft:clinical-related-change').length, 2);
const count = realtime._recebidos;
event('encounters', { id: 'outro', organization_id: 'org-b', legacy_id: 'caso-b', version: 8 });
assert.equal(realtime._recebidos, count);
assert.equal(realtime.relacionados('encounters').length, 1);

/* 403 não vira offline; 503 confirmado protege só a evidência não recebida. */
conflito.synced = false;
respostaStatus = 403;
assert.equal(await cloudRel._enviarConflito(conflito), false);
assert.equal(snapshots.size, 0);
respostaStatus = 503;
assert.equal(await cloudRel._enviarConflito(conflito), false);
assert.equal(snapshots.size, 1);
assert.equal(snapshots.values().next().value.owner.userId, 'user-a');
cloudRel._limparConflitosMemoria();
assert.equal(await cloudRel.restaurarConflitosOffline(), 1);
respostaStatus = 200;
assert.equal(await cloudRel._enviarConflito(cloudRel._conflitosLer()[0]), true);
assert.equal(snapshots.size, 0, 'recibo de sync_conflicts elimina a cópia clínica offline');

/* Uma decisão não desaparece do painel antes da confirmação do servidor. */
const decidir = cloudRel._conflitosLer()[0];
respostaStatus = 503;
assert.equal(cloudRel.resolverConflito(decidir.clientId, 'remote', { version: 2 }), true);
assert.equal(cloudRel.conflitosPendentes(), 1, 'a intenção não é uma resolução confirmada');
await new Promise(resolveTick => setImmediate(resolveTick));
assert.equal(snapshots.size, 1);
const intencao = snapshots.values().next().value.payload;
assert.equal(intencao.snapshotType, 'resolution');
assert.equal(intencao.resolutionRequested.status, 'resolved_remote');
assert.equal(intencao.proposed, undefined, 'a decisão offline não duplica as versões clínicas já confirmadas');
assert.equal(intencao.canonical, undefined);
cloudRel._limparConflitosMemoria();
assert.equal(await cloudRel.restaurarConflitosOffline(), 1);
respostaStatus = 200;
assert.equal(await cloudRel._resolverConflitoServidor(cloudRel._conflitosLer()[0]), true);
assert.equal(cloudRel.conflitosPendentes(), 0);
assert.equal(snapshots.size, 0);

/* Refresh iniciado na conta antiga nunca envia JWT ao socket da conta nova. */
let finishRefresh;
refresh = () => new Promise(resolveRefresh => { finishRefresh = resolveRefresh; });
const rotating = realtime._renovarToken();
const oldContext = contexto();
generation++; organizationId = 'org-b'; userId = 'user-b'; token = 'JWT-B';
const messagesBefore = wsMessages.length;
finishRefresh(true);
assert.equal(await rotating, false);
assert.equal(wsMessages.length, messagesBefore);
event('encounters', { id: 'stale', organization_id: 'org-a' }, 'UPDATE', oldContext);
assert.equal(realtime._recebidos, count);
realtime._encerrar(true);
assert.equal(form.children.length, 0, 'troca/saída remove painéis clínicos transitórios');
assert.equal(realtime.relacionados('encounters').length, 0);
assert.equal(cloudRel._conflitosLer().length, 0);

refresh = async () => true;
await realtime.conectar();
realtime._ws.open();
const novo = realtime._ws;
realtime._receber({ topic: 'realtime:public:encounters', event: 'phx_error', payload: {} }, contexto());
assert.equal(novo.readyState, 3, 'canal recusado reinicia a conexão, em vez de silêncio indefinido');
assert.equal(realtime._ws, null);

/* A mesma rota cobre drafts live:* sem convertê-los em rascunhos de outro módulo. */
sandbox.contextoAba.atual = contexto;
sandbox.store.cloudOnlyAtivo = () => true;
sandbox.localStorage.removeItem = () => {};
vm.runInContext(between('const rascunhosSync = {', 'const rascunhos = {') +
  between('const edicaoViva = {', 'try { contextoAba.aoMudar((atual, anterior) => edicaoViva.aoMudarContexto') +
  '\nglobalThis.liveApi = { edicaoViva, rascunhosSync };', sandbox);
const { edicaoViva: live, rascunhosSync: drafts } = sandbox.liveApi;
const consentForm = new Element('form');
const consentField = new Element('textarea'); consentField.name = 'consentimento'; consentField.type = 'textarea';
consentField.value = 'Minha edição';
consentForm.querySelectorAll = () => [consentField];
elements.set('form-termo', consentForm);
sandbox.state.currentModule = 'termo';
await realtime.conectar(); realtime._ws.open();
let draftRow = { id: 'server-live', organization_id: organizationId, user_id: userId, module: 'live:termo',
  doc_id: 'live_termo', version: 2, updated_at: '2026-10-05', updated_by: userId,
  data: { id: 'live_termo', dados: { consentimento: 'Edição da nuvem' }, updatedAt: '2026-10-05' } };
const draftRequests = [];
sandbox.fetch = async (url, opts = {}) => {
  if (!url.includes('/rest/v1/drafts')) {
    const body = opts.method === 'PATCH' ? JSON.parse(opts.body) : {};
    return { ok: true, status: 200, json: async () => [{ id: 'audit-live', status: body.status || 'pending' }] };
  }
  draftRequests.push({ url, opts });
  const params = new URL(url).searchParams;
  let rows = [];
  if (opts.method === 'PATCH') {
    assert.equal(params.get('organization_id'), 'eq.' + organizationId);
    assert.equal(params.get('user_id'), 'eq.' + userId);
    assert.equal(params.get('module'), 'eq.live:termo');
    if (params.get('version') === 'eq.' + draftRow.version) {
      draftRow = { ...draftRow, data: JSON.parse(opts.body).data, version: draftRow.version + 1 };
      rows = [copia(draftRow)];
    }
  } else if (!opts.method) rows = [copia(draftRow)];
  return { ok: true, status: 200, json: async () => rows };
};
live._garantirContexto();
const minha = { id: 'live_termo', mod: 'termo', uid: userId, dados: { consentimento: consentField.value },
  updatedAt: '2026-10-04', em: '2026-10-04', _draftVersion: 1, _draftOrg: organizationId, remoteConfirmed: false };
live._mem.set('termo', minha);
const foreignLive = { ...draftRow, user_id: 'outro-usuario' };
event('drafts', foreignLive);
assert.equal(cloudRel.conflitosPendentes(), 0);
event('drafts', draftRow);
const liveConflict = cloudRel._conflitosLer()[0];
assert.equal(liveConflict.baseVersion, 1);
assert.equal(liveConflict.serverVersion, 2);
assert.equal(liveConflict.metadata.draftModule, 'live:termo');
assert.equal(liveConflict.proposed.dados.consentimento, 'Minha edição');
assert.equal(consentField.value, 'Minha edição');
assert.ok(consentForm.children.some(x => x.attrs.role === 'status'));
await new Promise(resolveTick => setImmediate(resolveTick));
assert.equal(await cloudRel._resolverConflitoEdicaoViva(liveConflict.clientId, 'local', contexto()), true);
assert.equal(draftRow.version, 3, 'escolher local usa a revisão remota como base do CAS');
assert.equal(draftRow.data.dados.consentimento, 'Minha edição');
await new Promise(resolveTick => setImmediate(resolveTick));
assert.equal(cloudRel.conflitosPendentes(), 0);
const afterSaveRequests = draftRequests.length;
assert.equal(await live._enviar('termo'), true);
assert.equal(draftRequests.length, afterSaveRequests, 'recibo não alterado não produz gravações repetidas');

/* Um colega altera de novo; digitação posterior à notificação nunca é apagada. */
draftRow = { ...draftRow, version: 4, data: { ...draftRow.data, dados: { consentimento: 'Novo texto da nuvem' } } };
event('drafts', draftRow);
const secondConflict = cloudRel._conflitosLer()[0];
assert.equal(secondConflict.serverVersion, 4);
await new Promise(resolveTick => setImmediate(resolveTick));
consentField.value = 'Digitação posterior ao aviso';
assert.equal(await cloudRel._resolverConflitoEdicaoViva(secondConflict.clientId, 'remote', contexto()), true);
assert.equal(consentField.value, 'Digitação posterior ao aviso');

/* Recuperação preserva opções de radio e listas, sem interpretar nomes como seletor. */
const controls = [
  { name: 'opcao', type: 'radio', value: 'A', checked: false },
  { name: 'opcao', type: 'radio', value: 'B', checked: true },
  { name: 'riscos[]', type: 'checkbox', value: 'A', checked: true },
  { name: 'riscos[]', type: 'checkbox', value: 'B', checked: false },
  { name: 'procedimentos[]', type: 'text', value: 'Primeiro' },
  { name: 'procedimentos[]', type: 'text', value: 'Segundo' },
];
const multiForm = { querySelectorAll: () => controls };
const recovered = live._ler(multiForm);
for (const el of controls) { if (el.type === 'radio' || el.type === 'checkbox') el.checked = false; else el.value = ''; }
live._preencherForm(multiForm, recovered);
assert.equal(controls[0].checked, false); assert.equal(controls[1].checked, true);
assert.equal(controls[2].checked, true); assert.equal(controls[3].checked, false);
assert.equal(controls[4].value, 'Primeiro'); assert.equal(controls[5].value, 'Segundo');
const posterior = cloudRel._conflitosLer().find(x => x.metadata.motivo === 'digitacao_posterior_ao_conflito');
assert.equal(posterior.proposed.dados.consentimento, 'Digitação posterior ao aviso');
assert.equal(posterior.canonical.dados.consentimento, 'Novo texto da nuvem');
assert.equal(live._mem.get('termo').dados.consentimento, 'Digitação posterior ao aviso');
assert.equal(snapshots.size, 0, 'novas versões online continuam na memória e no servidor');
const blockedContext = contexto(); generation++;
assert.equal(live.adotarVersaoConflito('termo', drafts._daLinha(draftRow, organizationId), blockedContext).ok, false);
assert.equal(consentField.value, 'Digitação posterior ao aviso');

console.log('  ✓ Regra 1: JWT em todos os canais, encontros/linha do tempo e conflito visível sem perda de digitação');
