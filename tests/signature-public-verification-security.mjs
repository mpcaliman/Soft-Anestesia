import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCompiledActions, readRuntimeComposition } from './helpers/read-app-source.mjs';
import { createVerificationHandler } from '../supabase/functions/assinatura-validacao/handler.mjs';

const project = 'https://yqqrfgbvoexricjdxpis.supabase.co';
const code = 'ABCD-2345-EFGH';
const hash = 'a'.repeat(64);
const row = {
  codigo: code, hash_doc: hash, algoritmo: 'SHA-256', versao: 1,
  assinado_em: '2026-10-11T15:00:00+00:00',
  titulo: 'PRIVATE CLINICAL TITLE', paciente_ini: 'PRIVATE PATIENT',
  profissional: 'PRIVATE PROFESSIONAL', crm: 'PRIVATE CRM',
  organization_id: 'PRIVATE ORGANIZATION', doc_id: 'PRIVATE DOCUMENT',
  cert_titular: 'PRIVATE CERTIFICATE', cert_serial: 'PRIVATE SERIAL',
};
const envelope = {
  encontrado: true,
  registro: { codigo: code, hash_doc: hash, algoritmo: 'SHA-256', versao: 1, assinado_em: row.assinado_em },
  escopo: 'registro_e_hash', validacao_criptografica: 'nao_verificada_por_esta_consulta',
};
const modern = 'sb_secret_SYNTHETIC_TEST_ONLY';
const legacy = role => 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify({ role })).toString('base64url') + '.synthetic';
const request = (body, options = {}) => new Request(project + '/functions/v1/assinatura-validacao' + (options.search || ''), {
  method: options.method || 'POST',
  headers: options.headers || { 'content-type': 'application/json' },
  ...(options.method === 'GET' || options.method === 'OPTIONS' ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
});
const setup = (environment = {}, backend = () => Response.json([row])) => {
  const calls = [];
  const env = { SUPABASE_URL: project, SUPABASE_SECRET_KEYS: JSON.stringify({ default: modern }), ...environment };
  const handler = createVerificationHandler({ env: name => env[name], fetcher: async (url, options) => {
    calls.push({ url: new URL(url), options });
    return await backend(url, options);
  } });
  return { handler, calls };
};
let checks = 0;
async function check(name, callback) {
  await callback(); checks++;
  console.log('✓ ' + name);
}

await check('public proof lookup strips every private field even if the backend returns it', async () => {
  const { handler, calls } = setup();
  const response = await handler(request({ codigo: code.toLowerCase() }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), envelope);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(calls.length, 1);
  const { url, options } = calls[0];
  assert.equal(url.pathname, '/rest/v1/assinaturas_publicas');
  assert.deepEqual([...url.searchParams.keys()].sort(), ['codigo', 'limit', 'select']);
  assert.equal(url.searchParams.get('codigo'), 'eq.' + code);
  assert.equal(url.searchParams.get('select'), 'codigo,hash_doc,algoritmo,versao,assinado_em');
  assert.equal(options.method, 'GET');
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers.apikey, modern);
  assert.equal(options.headers.Authorization, undefined);
  assert(options.signal instanceof AbortSignal);
});

await check('hash proof never reveals a separate validation code and ambiguous digests fail closed', async () => {
  const one = setup();
  const response = await one.handler(request({ hash: hash.toUpperCase() }));
  const body = await response.json();
  assert.equal(body.registro.codigo, null);
  assert.equal(body.registro.hash_doc, hash);
  assert.equal(one.calls[0].url.searchParams.get('hash_doc'), 'eq.' + hash);
  const ambiguous = setup({}, () => Response.json([row, { ...row, codigo: 'JKLM-6789-NPQR' }]));
  const error = await ambiguous.handler(request({ hash }));
  assert.equal(error.status, 409);
  assert.equal((await error.text()).includes(code), false);
});

await check('no-proof, malformed proof, enumeration, SQL/filter injection and oversized body never reach the database', async () => {
  const { handler, calls } = setup();
  const invalid = [
    {}, [], null, { codigo: code, hash }, { codigo: code, organization_id: 'other-clinic' },
    { codigo: 'ABCD-2345-EFGH,hash_doc.eq.' + hash }, { codigo: '*' },
    { hash: 'g'.repeat(64) }, { hash: hash + '.or=(true)' },
    { codigo: '<script>alert(1)</script>' }, { codigo: 123 }, { user_id: 'some-user' },
    '{"codigo":', ' '.repeat(513),
  ];
  for (const body of invalid) assert.equal((await handler(request(body))).status, 400);
  assert.equal((await handler(request({ codigo: code }, { search: '?codigo=' + code }))).status, 400);
  assert.equal((await handler(request({ codigo: code }, { headers: { 'content-type': 'text/plain' } }))).status, 415);
  assert.equal((await handler(request(null, { method: 'GET' }))).status, 405);
  assert.equal((await handler(request(null, { method: 'OPTIONS' }))).status, 204);
  assert.equal(calls.length, 0);
});

await check('legacy server JWT works while malformed keys, anon credentials and unsafe server destinations fail closed', async () => {
  const token = legacy('service_role');
  const compatible = setup({ SUPABASE_SECRET_KEYS: '', SUPABASE_SERVICE_ROLE_KEY: token });
  assert.equal((await compatible.handler(request({ codigo: code }))).status, 200);
  assert.equal(compatible.calls[0].options.headers.Authorization, 'Bearer ' + token);
  for (const environment of [
    { SUPABASE_SECRET_KEYS: '{broken', SUPABASE_SERVICE_ROLE_KEY: token },
    { SUPABASE_SECRET_KEYS: '{"default":"sb_publishable_SYNTHETIC"}', SUPABASE_SERVICE_ROLE_KEY: token },
    { SUPABASE_SECRET_KEYS: '', SUPABASE_SERVICE_ROLE_KEY: legacy('anon') },
    { SUPABASE_SECRET_KEYS: '', SUPABASE_SERVICE_ROLE_KEY: '' },
    { SUPABASE_URL: 'https://other.invalid' },
    { SUPABASE_URL: project + '/unsafe' },
    { SUPABASE_URL: project + '?redirect=elsewhere' },
    { SUPABASE_URL: 'http://yqqrfgbvoexricjdxpis.supabase.co' },
  ]) {
    const closed = setup(environment);
    assert.equal((await closed.handler(request({ codigo: code }))).status, 503);
    assert.equal(closed.calls.length, 0);
  }
});

await check('a real negative lookup differs from an outage or malformed/mismatched upstream row', async () => {
  const missing = setup({}, () => Response.json([]));
  assert.deepEqual(await (await missing.handler(request({ codigo: code }))).json(), { encontrado: false });
  const failures = [
    () => new Response('PRIVATE SERVER SECRET ' + modern, { status: 403 }),
    () => Response.json({ error: 'PRIVATE SERVER SECRET ' + modern }),
    () => Response.json([{ ...row, codigo: 'JKLM-6789-NPQR' }]),
    () => Response.json([{ ...row, hash_doc: 'bad' }]),
    () => Response.json([{ ...row, algoritmo: 'MD5' }]),
    () => Response.json([{ ...row, versao: 0 }]),
    () => Response.json([{ ...row, assinado_em: 'bad-date' }]),
    () => new Response('x'.repeat(16385)),
    () => { throw new Error('PRIVATE SERVER SECRET ' + modern); },
  ];
  for (const backend of failures) {
    const { handler } = setup({}, backend);
    const response = await handler(request({ codigo: code }));
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.equal(text.includes('PRIVATE'), false);
    assert.equal(text.includes(modern), false);
    assert.equal(text.includes(code), false);
    assert.equal(text.includes('encontrado'), false);
  }
});

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootArgument = process.argv.find(argument => argument.startsWith('--app-root='));
const appRoot = rootArgument ? resolve(process.cwd(), rootArgument.slice('--app-root='.length)) : repo;
const SoftActions = await readCompiledActions(appRoot);
const uiSource = await readFile(resolve(appRoot, 'src/integrations/signature-digital.js'), 'utf8');
function ui(fetcher, key = 'sb_publishable_SYNTHETIC_TEST_ONLY', savedConfig = true) {
  const input = { value: code }, result = { innerHTML: '' }, calls = [];
  const listeners = new Map(), intervals = [];
  const context = vm.createContext({
    SoftActions,
    window: {
      addEventListener(name, callback) {
        const callbacks = listeners.get(name) || []; callbacks.push(callback); listeners.set(name, callbacks);
      },
      dispatchEvent(event) { for (const callback of listeners.get(event.type) || []) callback(event); },
    },
    location: { origin: 'https://example.invalid', pathname: '/', hash: '' },
    document: { getElementById: id => id === 'ad-validar-inp' ? input : id === 'ad-validar-res' ? result : null },
    localStorage: { getItem: () => savedConfig ? JSON.stringify({ url: project, anonKey: key }) : null },
    cloud: { DEFAULT_URL: project, DEFAULT_KEY: key }, store: { list: () => [] },
    crypto: globalThis.crypto, TextEncoder, AbortSignal, Event, atob,
    setInterval(callback) { intervals.push(callback); },
    fetch: async (url, options) => { calls.push({ url, options }); return await fetcher(url, options); },
  });
  vm.runInContext(uiSource, context);
  return { context, input, result, calls, intervals, verify: () => context.window.assinaturaDigital._fazerValidacao() };
}

await check('public app lookup works before login/configuration without any Bearer or credential and does not assert ICP validity', async () => {
  const app = ui(() => Response.json(envelope), undefined, false);
  await app.verify();
  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0].url, project + '/functions/v1/assinatura-validacao');
  assert.equal(app.calls[0].options.method, 'POST');
  assert.equal(app.calls[0].options.headers.authorization, undefined);
  assert.equal(app.calls[0].options.headers.Authorization, undefined);
  assert.equal(app.calls[0].options.credentials, 'omit');
  assert.equal(app.calls[0].options.cache, 'no-store');
  assert.deepEqual(JSON.parse(app.calls[0].options.body), { codigo: code });
  assert.match(app.result.innerHTML, /encontrado na nuvem/);
  assert.doesNotMatch(app.result.innerHTML, /PRIVATE|Registro de assinatura íntegro/);
  assert.match(app.result.innerHTML, /validar\.iti\.gov\.br/);
});

await check('public app rejects server/user credentials and reports unavailable/mismatched responses truthfully', async () => {
  for (const key of ['sb_secret_SYNTHETIC_TEST_ONLY', legacy('service_role'), legacy('authenticated')]) {
    const app = ui(() => { throw new Error('must not call'); }, key);
    await app.verify();
    assert.equal(app.calls.length, 0);
    assert.match(app.result.innerHTML, /Consulta não concluída/);
  }
  const legacyApp = ui(() => Response.json(envelope), legacy('anon'));
  await legacyApp.verify();
  assert.equal(legacyApp.calls[0].options.headers.authorization, undefined);
  for (const reply of [
    () => Response.json({ erro: '<img src=x onerror=alert(1)>' }, { status: 503 }),
    () => Response.json({ ...envelope, registro: { ...envelope.registro, codigo: 'JKLM-6789-NPQR' } }),
    () => Response.json({ ...envelope, validacao_criptografica: 'verified' }),
    () => { throw new Error('network unavailable'); },
  ]) {
    const app = ui(reply); await app.verify();
    assert.match(app.result.innerHTML, /Consulta não concluída/);
    assert.doesNotMatch(app.result.innerHTML, /Não encontrado|encontrado na nuvem|<img/);
  }
  const absent = ui(() => Response.json({ encontrado: false })); await absent.verify();
  assert.match(absent.result.innerHTML, /Não encontrado/);
});

await check('a late lookup cannot replace the result for a newer entered proof', async () => {
  let releaseFirst;
  const firstResponse = new Promise(resolve => { releaseFirst = resolve; });
  let sequence = 0;
  const app = ui(() => ++sequence === 1 ? firstResponse : Response.json({ encontrado: false }));
  const first = app.verify();
  app.input.value = 'JKLM-6789-NPQR';
  await app.verify();
  assert.match(app.result.innerHTML, /Não encontrado/);
  releaseFirst(Response.json(envelope)); await first;
  assert.match(app.result.innerHTML, /Não encontrado/);
  assert.doesNotMatch(app.result.innerHTML, /encontrado na nuvem/);
});

const [oldEdge, config] = await Promise.all([
  readFile(new URL('../supabase/functions/assinatura/index.ts', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/config.toml', import.meta.url), 'utf8'),
]);
const sourceHtml = await readRuntimeComposition(appRoot);
const printSource = await readFile(resolve(appRoot, 'src/print/print-preview.js'), 'utf8');
function objectSource(source, name) {
  const start = source.indexOf('const ' + name + ' = {');
  const end = source.indexOf('\n};', start);
  assert(start >= 0 && end > start);
  return source.slice(start, end + 3);
}
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
function attachmentUi() {
  const app = ui(() => { throw new Error('attachment cannot call a public backend'); });
  const fields = new Map(['nome', 'profissional', 'crm', '_id', 'assinatura_tipo', 'assinatura_meta']
    .map(name => [name, { value: name === 'nome' ? 'Synthetic patient' : name === '_id' ? 'SYNTHETIC-DOCUMENT-A' : '' }]));
  const form = { querySelector: selector => fields.get(selector.match(/name="([^"]+)"/)?.[1]) || null,
    appendChild() { throw new Error('unverified attachment must not add a signed/finalized lock'); } };
  const notices = [], dialogs = [], saved = [];
  let generation = 1, currentForm = form, memory = [], currentInput = null;
  Object.assign(app.context, {
    state: { currentModule: 'pre' },
    contextoAba: { capturar: () => ({ generation }), corresponde: owner => owner.generation === generation },
    store: {
      list: () => structuredClone(memory),
      setList: (module, rows) => { memory = structuredClone(rows); saved.push({ module, rows: structuredClone(rows) }); return true; },
    },
    modal: {
      close() { app.context.window.dispatchEvent(new Event('soft:modal-close')); },
      open(title, body) { app.context.window.dispatchEvent(new Event('soft:modal-open')); dialogs.push({ title, body }); },
    },
    toast: message => notices.push(message), markDirty() {},
    assinatura: { carimbarDataHora() { throw new Error('unverified PDF must not create a signature timestamp'); } },
  });
  app.context.document.getElementById = id => id === 'form-pre' ? currentForm : id === 'ad-pdf-input' ? currentInput : null;
  return { ...app, fields, notices, dialogs, saved, changeOwner: () => generation++,
    get records() { return structuredClone(memory); },
    replaceForm(docId) {
      const replacement = new Map([...fields].map(([name, field]) => [name, { value: name === '_id' ? docId : field.value }]));
      currentForm = { querySelector: selector => replacement.get(selector.match(/name="([^"]+)"/)?.[1]) || null };
      return replacement;
    },
    startModal() {
      currentInput = { files: [], value: '', isConnected: true };
      app.context.window.assinaturaDigital.iniciar();
      dialogs.length = 0;
    },
    selectFile(file) {
      currentInput.files = [file]; currentInput.value = 'file';
      return app.context.window.assinaturaDigital.registrar(currentInput);
    },
    attach(file) { this.startModal(); return this.selectFile(file); },
  };
}

await check('an unsigned externally attached PDF stays explicitly unverified without a central receipt or signature lock', async () => {
  const app = attachmentUi();
  await app.attach(new File(['%PDF-1.7\nsynthetic unsigned PDF'], 'synthetic.pdf', { type: 'application/pdf' }));
  assert.equal(app.saved.length, 1);
  const record = app.saved[0].rows[0];
  assert.equal(record.status, 'pdf_anexado_nao_verificado');
  assert.equal(record.centralReceiptConfirmed, false);
  assert.equal(record.signatureVerified, false);
  assert.equal(record.registroEscopo, 'memoria_da_sessao');
  const meta = JSON.parse(app.fields.get('assinatura_meta').value);
  assert.equal(meta.tipo, 'pdf_anexado');
  assert.equal(meta.centralReceiptConfirmed, false);
  assert.equal(meta.signatureVerified, false);
  assert.equal(app.fields.get('assinatura_tipo').value, 'pdf_anexado');
  assert.match(app.dialogs[0].body, /assinatura não verificada/);
  assert.match(app.dialogs[0].body, /nuvem ainda não confirmou/);
  assert.doesNotMatch(app.dialogs[0].body, /Documento assinado e registrado|Qualquer pessoa pode conferir a autenticidade/);
  assert.equal(app.calls.length, 0);
  const closed = attachmentUi();
  closed.context.store.setList = () => false;
  await closed.attach(new File(['%PDF-synthetic'], 'synthetic.pdf', { type: 'application/pdf' }));
  assert.equal(closed.dialogs.length, 0);
  assert.match(closed.notices[0], /Não foi possível registrar/);
});

await check('an owner/clinic switch during PDF reading cannot write old metadata into the new session', async () => {
  const app = attachmentUi();
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const attachment = app.attach({ type: 'application/pdf', name: 'synthetic.pdf', arrayBuffer: () => pending });
  app.changeOwner(); release(new TextEncoder().encode('%PDF-synthetic').buffer);
  await attachment;
  assert.equal(app.saved.length, 0);
  assert.equal(app.dialogs.length, 0);
  assert.equal(app.fields.get('assinatura_meta').value, '');
  assert.match(app.notices[0], /usuário ou a clínica mudou/);
});

await check('same-owner DOM replacement, reused document ID, case and patient changes reject attachment A without touching document B', async () => {
  for (const change of ['replace-node', 'reuse-node', 'change-module', 'change-case', 'change-patient']) {
    const app = attachmentUi();
    if (change === 'change-case') app.fields.set('_caseId', { value: 'SYNTHETIC-CASE-A' });
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const operation = app.attach({ type: 'application/pdf', name: 'synthetic-A.pdf', arrayBuffer: () => pending });
    const destination = change === 'replace-node' ? app.replaceForm('SYNTHETIC-DOCUMENT-B') : app.fields;
    if (change === 'reuse-node') app.fields.get('_id').value = 'SYNTHETIC-DOCUMENT-B';
    if (change === 'change-module') app.context.state.currentModule = 'consulta';
    if (change === 'change-case') app.fields.get('_caseId').value = 'SYNTHETIC-CASE-B';
    if (change === 'change-patient') app.fields.get('nome').value = 'Another synthetic patient';
    release(new TextEncoder().encode('%PDF-synthetic-A').buffer); await operation;
    assert.equal(app.saved.length, 0, change);
    assert.equal(app.dialogs.length, 0, change);
    assert.equal(destination.get('assinatura_meta').value, '', change);
    assert.match(app.notices[0], /documento mudou/, change);
  }
});

await check('two simultaneous attachments retain both cloned-list entries with a valid sequential hash chain', async () => {
  const app = attachmentUi();
  app.startModal();
  await Promise.all([
    app.selectFile(new File(['%PDF-synthetic-A'], 'synthetic-A.pdf', { type: 'application/pdf' })),
    app.selectFile(new File(['%PDF-synthetic-B'], 'synthetic-B.pdf', { type: 'application/pdf' })),
  ]);
  assert.equal(app.saved.length, 2);
  const records = app.records;
  assert.equal(records.length, 2);
  assert.deepEqual(records.map(record => record.versao), [1, 2]);
  assert.equal(records[0].prevHash, null);
  assert.equal(records[1].prevHash, records[0].selfHash);
  for (const record of records) {
    const canonical = { ...record, selfHash: undefined };
    const digest = await crypto.subtle.digest('SHA-256',
      new TextEncoder().encode(JSON.stringify(canonical, Object.keys(canonical).sort())));
    assert.equal(Buffer.from(digest).toString('hex'), record.selfHash);
    assert.equal(record.centralReceiptConfirmed, false);
  }
  assert.equal(app.dialogs.length, 1, 'one receipt opens only after both selections finish');
  assert.equal(app.notices.length, 0);
});

await check('modal cancellation invalidates an in-flight attachment after file reading and both hashing awaits', async () => {
  for (const event of ['soft:modal-close', 'soft:modal-open']) {
    for (const stage of ['file-read', 'file-hash', 'metadata-hash']) {
      const app = attachmentUi();
      let release, reached;
      const pause = new Promise(resolve => { release = resolve; });
      const barrier = new Promise(resolve => { reached = resolve; });
      let hashes = 0;
      app.context.crypto = {
        randomUUID: () => crypto.randomUUID(), getRandomValues: values => crypto.getRandomValues(values),
        subtle: { async digest(algorithm, bytes) {
          hashes++;
          if ((stage === 'file-hash' && hashes === 1) || (stage === 'metadata-hash' && hashes === 2)) {
            reached(); await pause;
          }
          return crypto.subtle.digest(algorithm, bytes);
        } },
      };
      const operation = app.attach({ type: 'application/pdf', name: 'synthetic-cancelled.pdf', async arrayBuffer() {
        if (stage === 'file-read') { reached(); await pause; }
        return new TextEncoder().encode('%PDF-synthetic-cancelled').buffer;
      } });
      await barrier;
      app.context.window.dispatchEvent(new Event(event));
      release(); await operation;
      assert.equal(app.saved.length, 0, event + ': ' + stage);
      assert.equal(app.dialogs.length, 0, event + ': ' + stage);
      assert.equal(app.fields.get('assinatura_meta').value, '', event + ': ' + stage);
      assert.equal(app.fields.get('assinatura_tipo').value, '', event + ': ' + stage);
      assert.match(app.notices[0], /anexação foi cancelada/, event + ': ' + stage);
    }
  }
});

await check('reopening a modal for the same unchanged document cancels its old read without cancelling the new selection', async () => {
  const app = attachmentUi();
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const oldOperation = app.attach({ type: 'application/pdf', name: 'synthetic-old.pdf', arrayBuffer: () => pending });
  const currentOperation = app.attach(new File(['%PDF-synthetic-new'], 'synthetic-new.pdf', { type: 'application/pdf' }));
  release(new TextEncoder().encode('%PDF-synthetic-old').buffer);
  await Promise.all([oldOperation, currentOperation]);
  assert.equal(app.records.length, 1);
  assert.equal(app.records[0].arquivo, 'synthetic-new.pdf');
  assert.equal(app.saved.length, 1);
  assert.equal(app.dialogs.length, 1);
  assert.equal(JSON.parse(app.fields.get('assinatura_meta').value).arquivo, 'synthetic-new.pdf');
  assert.match(app.notices[0], /anexação foi cancelada/);
});

await check('a completed selection keeps the modal active until its second legitimate selection finishes', async () => {
  const app = attachmentUi();
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  app.startModal();
  const first = app.selectFile(new File(['%PDF-synthetic-fast'], 'synthetic-fast.pdf', { type: 'application/pdf' }));
  const second = app.selectFile({ type: 'application/pdf', name: 'synthetic-slow.pdf', arrayBuffer: () => pending });
  await first;
  assert.equal(app.saved.length, 1);
  assert.equal(app.dialogs.length, 0, 'receipt cannot replace the modal of an in-flight selection');
  release(new TextEncoder().encode('%PDF-synthetic-slow').buffer); await second;
  assert.equal(app.records.length, 2);
  assert.equal(app.records[1].prevHash, app.records[0].selfHash);
  assert.deepEqual(app.records.map(record => record.versao), [1, 2]);
  assert.equal(app.dialogs.length, 1);
  assert.equal(app.notices.length, 0);
});

await check('cancellation also blocks a second attachment queued behind the first metadata hash', async () => {
  const app = attachmentUi();
  let release, reached;
  const pause = new Promise(resolve => { release = resolve; });
  const barrier = new Promise(resolve => { reached = resolve; });
  app.context.crypto = {
    randomUUID: () => crypto.randomUUID(), getRandomValues: values => crypto.getRandomValues(values),
    subtle: { async digest(algorithm, bytes) {
      const text = new TextDecoder().decode(bytes);
      if (text.startsWith('{')) { reached(); await pause; }
      return crypto.subtle.digest(algorithm, bytes);
    } },
  };
  app.startModal();
  const operations = [
    app.selectFile(new File(['%PDF-synthetic-first'], 'synthetic-first.pdf', { type: 'application/pdf' })),
    app.selectFile(new File(['%PDF-synthetic-second'], 'synthetic-second.pdf', { type: 'application/pdf' })),
  ];
  await barrier;
  app.context.window.dispatchEvent(new Event('soft:modal-close'));
  release(); await Promise.all(operations);
  assert.equal(app.saved.length, 0);
  assert.equal(app.records.length, 0);
  assert.equal(app.fields.get('assinatura_meta').value, '');
  assert.equal(app.dialogs.length, 0);
  assert.equal(app.notices.length, 2);
  assert(app.notices.every(notice => /anexação foi cancelada/.test(notice)));
});

await check('closing/replacing a modal and switching modules clear stale pending attachment context', async () => {
  for (const cause of ['soft:modal-close', 'soft:modal-open', 'module-switch']) {
    const app = attachmentUi(); app.context.window.assinaturaDigital.iniciar();
    app.dialogs.length = 0;
    if (cause === 'module-switch') {
      app.context.state.currentModule = 'consulta'; for (const tick of app.intervals) tick();
    } else app.context.window.dispatchEvent(new Event(cause));
    let reads = 0;
    await app.context.window.assinaturaDigital.registrar({
      files: [{ type: 'application/pdf', name: 'stale.pdf', arrayBuffer: async () => { reads++; return new ArrayBuffer(0); } }],
      value: 'file',
    });
    assert.equal(reads, 0, cause); assert.equal(app.saved.length, 0, cause);
    assert.equal(app.dialogs.length, 0, cause);
    assert.match(app.notices[0], /Contexto do documento perdido/, cause);
  }
});

await check('UI restoration and PDF printing never upgrade old or forged client metadata into ICP certification', async () => {
  const boxes = new Map();
  const context = vm.createContext({ SoftActions, window: {}, document: { getElementById: id => boxes.get(id) },
    utils: { escapeHTML: escape, escapeAttr: escape, jsArg: JSON.stringify }, crypto: globalThis.crypto });
  vm.runInContext(objectSource(sourceHtml, 'assinatura') + '\nglobalThis.component=assinatura;', context);
  vm.runInContext(objectSource(printSource, 'printPreview') + '\nglobalThis.printer=printPreview;', context);
  const pane = context.component.blocoHTML('sig-pre');
  assert.match(pane, /anexação sem verificação criptográfica ou confirmação da nuvem/);
  assert.match(pane, /não verifica a assinatura nem confirma o envio/);
  assert.doesNotMatch(pane, /marca o documento como assinado|padrão aceito pelo CFM/);
  for (const tipo of ['icp', 'pdf_anexado']) {
    const metadata = Object.freeze({ tipo, signatureVerified: true, cadeia_icp: true,
      arquivo: 'Synthetic </div><img src=x onerror=evil()>.pdf', assinante: 'Synthetic <script>evil()</script>',
      hash, codigo: code, ts: row.assinado_em });
    const original = JSON.stringify(metadata);
    const box = { innerHTML: '' }; boxes.set('sig-pre-icp-status', box);
    context.component._icpRenderStatus('sig-pre', metadata);
    const printed = context.printer._icpSelo(metadata);
    for (const output of [box.innerHTML, printed]) {
      assert.match(output, /PDF anexado — assinatura não verificada/);
      assert.doesNotMatch(output, /Assinado digitalmente|<img|<script/);
      assert.match(output, /&lt;/);
    }
    assert.equal(JSON.stringify(metadata), original, 'rendering does not change historical metadata');
  }
});

await check('legacy attachment captures exact parent form/document before reading and before the file chooser opens', async () => {
  for (const change of ['none', 'replace-node', 'reuse-node', 'change-module', 'change-case', 'chooser-reuse-node']) {
    const fields = new Map(['_id', 'nome', 'assinatura_tipo', 'assinatura_meta', '_caseId']
      .map(name => [name, { value: name === '_id' ? 'SYNTHETIC-DOCUMENT-A' : name === '_caseId' ? 'SYNTHETIC-CASE-A' : '' }]));
    const form = { querySelector: selector => fields.get(selector.match(/name="([^"]+)"/)?.[1]) || null };
    let currentForm = form, release, reads = 0;
    const pending = new Promise(resolve => { release = resolve; });
    const notices = [], box = { innerHTML: '' };
    const context = vm.createContext({
      SoftActions, window: {}, state: { currentModule: 'pre' },
      document: { getElementById: id => id === 'form-pre' ? currentForm : id === 'sig-pre-icp-status' ? box : null },
      contextoAba: { capturar: () => ({ owner: 'same-user-same-clinic' }), corresponde: () => true },
      crypto: globalThis.crypto, TextEncoder, utils: { escapeHTML: escape },
      toast: message => notices.push(message), markDirty() {},
    });
    vm.runInContext(objectSource(sourceHtml, 'assinatura') + '\nglobalThis.component=assinatura;', context);
    context.component.carimbarDataHora = () => { throw new Error('an unverified file must not create a signature timestamp'); };
    const input = { value: 'file', files: [{ type: 'application/pdf', name: 'synthetic-A.pdf',
      arrayBuffer: () => { reads++; return pending; } }] };
    context.component._icpPreparar('sig-pre', input);
    if (change === 'chooser-reuse-node') fields.get('_id').value = 'SYNTHETIC-DOCUMENT-B';
    const operation = context.component._icpRegistrar('sig-pre', input);
    if (change === 'replace-node') currentForm = { querySelector: form.querySelector };
    if (change === 'reuse-node') fields.get('_id').value = 'SYNTHETIC-DOCUMENT-B';
    if (change === 'change-module') context.state.currentModule = 'consulta';
    if (change === 'change-case') fields.get('_caseId').value = 'SYNTHETIC-CASE-B';
    release(new TextEncoder().encode('%PDF-synthetic-A').buffer); await operation;
    if (change === 'none') {
      assert.equal(JSON.parse(fields.get('assinatura_meta').value).signatureVerified, false);
      assert.match(box.innerHTML, /assinatura não verificada/);
    } else {
      assert.equal(fields.get('assinatura_meta').value, '', change);
      assert.equal(box.innerHTML, '', change);
      assert.match(notices[0], /documento mudou/, change);
    }
    if (change === 'chooser-reuse-node') assert.equal(reads, 0);
  }
});

await check('configured CSC secrets cannot enable the unhomologated driver, and clinical JWT guards still run', async () => {
  let handler, providerCalls = 0, authenticated = false, activeMember = true;
  const environment = { CSC_BASE_URL: 'https://provider.example.invalid', CSC_CLIENT_ID: 'synthetic',
    CSC_CLIENT_SECRET: 'synthetic', SUPABASE_URL: project, SUPABASE_SERVICE_ROLE_KEY: legacy('service_role') };
  const chain = { select() { return this; }, eq() { return this; }, in() { return this; },
    limit: async () => ({ data: activeMember ? [{ organization_id: '11111111-1111-4111-8111-111111111111' }] : [] }) };
  const context = vm.createContext({
    Deno: { env: { get: name => environment[name] }, serve: callback => { handler = callback; } },
    createClient: () => ({ auth: { getUser: async () => ({ data: { user: authenticated ? { id: 'synthetic-user' } : null } }) },
      from: () => chain }),
    fetch: () => { providerCalls++; throw new Error('unhomologated driver must never contact a provider'); },
    URL, Request, Response, crypto: globalThis.crypto, TextEncoder, TextDecoder, Uint8Array, atob,
  });
  const executable = stripTypeScriptTypes(oldEdge.replace(/^import .*;\s*$/m, ''), { mode: 'strip' });
  vm.runInContext(executable, context);
  const health = await handler(new Request(project + '/functions/v1/assinatura?op=health'));
  assert.equal((await health.json()).configurado, false);
  const sign = () => handler(new Request(project + '/functions/v1/assinatura?op=sign', {
    method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer synthetic-user-token' },
    body: JSON.stringify({ organization_id: '11111111-1111-4111-8111-111111111111' }),
  }));
  assert.equal((await sign()).status, 401);
  authenticated = true; activeMember = false;
  assert.equal((await sign()).status, 403);
  activeMember = true;
  assert.equal((await sign()).status, 501);
  assert.equal(providerCalls, 0);
});

assert.match(config, /\[functions\.assinatura-validacao\]\s+verify_jwt = false/);
assert.doesNotMatch(oldEdge, /from\("assinaturas_publicas"\)/);
assert.match(oldEdge, /if \(op === "validar"\)[\s\S]*?410/);
assert.match(oldEdge, /client\.auth\.getUser\(jwt\)/);
assert.match(oldEdge, /\.eq\("ativo", true\)[\s\S]*?\.in\("role", \["gestor", "anestesiologista"\]\)/);
console.log('Public signature verification: ' + checks + ' behavioral security groups passed; protected signing guards retained.');
