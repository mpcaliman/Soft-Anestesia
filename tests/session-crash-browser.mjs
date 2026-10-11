/** D5: crash de renderer e SIGKILL do navegador não restauram autorização.
 * Usa Chromium real, sessionStorage/IndexedDB reais e uma API Auth de teste.
 * Não acessa Supabase nem dados reais. O perfil é removido ao terminar.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const rootArg = process.argv.find(arg => arg.startsWith('--app-root='));
const root = rootArg ? resolve(process.cwd(), rootArg.slice('--app-root='.length)) : resolve(here, '..');
const profile = await mkdtemp(resolve(tmpdir(), 'soft-session-crash-'));
const org = 'aaaaaaaa-1111-4111-8111-111111111111';
const users = {
  'owner@test.invalid': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'other@test.invalid': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
};
const tokens = new Map();
let loginRequests = 0;
let credentialRequests = 0;
const send = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
};
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/mock-supabase/')) {
      if (url.pathname === '/mock-supabase/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
        let body = '';
        for await (const part of req) body += part;
        const { email, password } = JSON.parse(body);
        const uid = users[email];
        if (!uid || password !== 'test-password') return send(res, 401, { error: 'invalid_credentials' });
        const token = 'fresh-token-' + ++loginRequests;
        tokens.set(token, { uid, email });
        return send(res, 200, { access_token: token, refresh_token: 'fresh-refresh-' + loginRequests,
          expires_in: 3600, user: { id: uid, email } });
      }
      const bearer = String(req.headers.authorization || '').replace(/^Bearer /, '');
      const user = tokens.get(bearer);
      if (bearer) credentialRequests++;
      if (!user) return send(res, 401, { error: 'unauthorized' });
      const path = url.pathname.slice('/mock-supabase'.length);
      if (path === '/rest/v1/profiles') return send(res, 200, [{ id: user.uid, email: user.email, nome: 'Usuário teste', ativo: true }]);
      if (path === '/rest/v1/organization_users') return send(res, 200, [{ user_id: user.uid, organization_id: org, role: 'gestor', ativo: true }]);
      if (path === '/rest/v1/organizations') return send(res, 200, [{ id: org, nome: 'Clínica teste', settings: {} }]);
      if (path === '/rest/v1/rpc/ensure_offline_keyring') return send(res, 200, [{
        wrap_key: Buffer.alloc(32, user.uid === users['owner@test.invalid'] ? 11 : 22).toString('base64'), key_version: 1
      }]);
      if (req.method === 'GET') return send(res, 200, []);
      if (path === '/auth/v1/logout') return send(res, 200, {});
      /* Uma operação offline deve continuar pendente durante toda a prova. */
      return send(res, 503, { error: 'offline_test' });
    }
    const path = resolve(root, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
    if (!path.startsWith(root + sep)) return send(res, 403, {});
    const data = await readFile(path);
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
      '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' }[extname(path)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
    res.end(data);
  } catch { send(res, 404, {}); }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const appUrl = 'http://127.0.0.1:' + server.address().port + '/index.html';
const apiUrl = 'http://127.0.0.1:' + server.address().port + '/mock-supabase';
let child;
let browser;
let cdpEndpoint;
const poll = async (fn, timeout = 20000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await fn();
    if (value) return value;
    await new Promise(done => setTimeout(done, 50));
  }
  throw new Error('Tempo esgotado ao iniciar Chromium');
};
const attach = async () => {
  browser = await chromium.connectOverCDP(cdpEndpoint);
  const context = browser.contexts()[0];
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1' || url.protocol === 'data:') return route.continue();
    return route.abort();
  });
  const page = context.pages().find(p => p.url().startsWith(appUrl)) || await context.newPage();
  page.on('dialog', dialog => dialog.accept());
  if (!page.url().startsWith(appUrl)) await page.goto(appUrl);
  /* CDP pode se conectar enquanto o Chromium ainda analisa os scripts. Auth
     e cofre aparecem antes do adaptador cloud; esperar só os dois permite
     que a primeira inspeção leia uma variável ainda não declarada. */
  await page.waitForLoadState('load');
  await page.waitForFunction(() => typeof auth !== 'undefined' && typeof cloud !== 'undefined' &&
    typeof filaCifrada !== 'undefined' && typeof persistenciaCloudFirst !== 'undefined');
  return { page, context };
};
const launch = async () => {
  let stderr = '';
  child = spawn(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath(), [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, '--restore-last-session', appUrl
  ], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', data => { stderr = (stderr + String(data)).slice(-3000); });
  const port = await poll(async () => {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Chromium encerrou antes do teste: ' + stderr);
    try { return Number((await readFile(resolve(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); }
    catch { return null; }
  });
  cdpEndpoint = 'http://127.0.0.1:' + port;
  return attach();
};
const stopAbruptly = async () => {
  const exited = once(child, 'exit');
  process.kill(-child.pid, 'SIGKILL');
  await exited;
  child = null;
  /* Chrome writes a port file at each launch; an old one must not be reused. */
  await rm(resolve(profile, 'DevToolsActivePort'), { force: true });
};
const login = async (page, email = 'owner@test.invalid') => {
  await page.evaluate(api => { localStorage.setItem(cloud.CFG_KEY, JSON.stringify({ url: api, anonKey: 'test-publishable-key' })); }, apiUrl);
  await page.locator('#auth-email').fill(email);
  await page.locator('#auth-pass').fill('test-password');
  await page.evaluate(() => auth.tentarLoginNuvem());
  await page.waitForFunction(() => auth.estaLogado() && contextoAba.operational() && document.getElementById('auth-overlay').style.display === 'none');
  await page.evaluate(() => filaCifrada.preparar());
};
const locked = async page => {
  const state = await page.evaluate(() => ({
    auth: auth.usuarioAtual(), cloud: cloud.session(), context: contextoAba.operational(),
    verified: contextoAba.atual().verified, keys: filaCifrada._chaves.size,
    overlay: document.getElementById('auth-overlay').style.display,
    patient: document.querySelector('#form-pre [name="paciente_nome"]')?.value || '',
    drive: sessionStorage.getItem('medsys.v7.pdfbk.token')
  }));
  assert.deepEqual(state, { auth: null, cloud: null, context: false, verified: false,
    keys: 0, overlay: 'flex', patient: '', drive: null });
};
const ciphertexts = async page => page.evaluate(async () => {
  const db = await new Promise((ok, fail) => {
    const r = indexedDB.open(filaCifrada.DB, filaCifrada.DB_VERSION);
    r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error);
  });
  try {
    return await new Promise((ok, fail) => {
      const tx = db.transaction(filaCifrada.STORE_OPERACOES, 'readonly');
      const r = tx.objectStore(filaCifrada.STORE_OPERACOES).getAll();
      let result;
      r.onsuccess = () => { result = r.result; };
      tx.oncomplete = () => ok(result.map(({ state, attempts, lastError, lastAttemptAt, ...immutable }) => immutable));
      tx.onerror = () => fail(tx.error);
    });
  } finally { db.close(); }
});

try {
  let { page, context } = await launch();
  await locked(page);
  await login(page);
  /* A API confirma indisponibilidade com 503. Isso cria WAL real sem deixar
     uma emulação de rede vinculada ao renderer que será derrubado. */
  await page.evaluate(async () => {
    const pending = await persistenciaCloudFirst.salvar('pre', {
      _id: 'registro-pendente', paciente_nome: 'Caso sintético secreto'
    });
    if (!pending.queued || !pending.durable) throw new Error('Gravação clínica offline não recebeu proteção durável');
    const el = document.querySelector('#form-pre [name="paciente_nome"]');
    if (el) el.value = 'Caso sintético secreto';
    sessionStorage.setItem('__crash_marker', 'documento-anterior');
    sessionStorage.setItem('medsys.v7.pdfbk.token', 'token-drive-sintetico');
  });
  const encrypted = await ciphertexts(page);
  assert.equal(encrypted.length, 1);
  assert.doesNotMatch(JSON.stringify(encrypted), /Caso sintético secreto/);
  /* Nenhum interceptor do cliente antigo pode bloquear o reload posterior ao
     crash. O processo mantém a barreira DNS para destinos externos. */
  await context.unroute('**/*');
  const cdp = await context.newCDPSession(page);
  const crashed = once(page, 'crash');
  cdp.send('Page.crash').catch(() => {});
  let crashTimeout;
  try {
    await Promise.race([crashed, new Promise((_, reject) => { crashTimeout = setTimeout(() => reject(new Error('Renderer não caiu')), 10000); })]);
  } finally { clearTimeout(crashTimeout); }
  const requestsBeforeReload = credentialRequests;
  /* O objeto Page do Playwright fica permanentemente marcado como crashed.
     O CDPSession separado ainda fala com o browser e recarrega o MESMO target,
     conservando sua sessionStorage. Fechar a conexão CDP só desconecta o
     cliente: o Chromium lançado por spawn permanece vivo. */
  await cdp.send('Page.reload', { ignoreCache: true });
  await browser.close();
  assert.equal(child.exitCode, null, 'reconectar CDP não pode encerrar o navegador');
  assert.equal(child.signalCode, null);
  ({ page, context } = await attach());
  await page.waitForFunction(() => typeof auth !== 'undefined' && document.getElementById('auth-overlay').style.display === 'flex');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('__crash_marker')), 'documento-anterior',
    'o renderer deve realmente ter recebido a sessionStorage do documento que caiu');
  await locked(page);
  assert.equal(credentialRequests, requestsBeforeReload, 'boot não pode reutilizar o JWT recuperado pelo navegador');
  assert.deepEqual(await ciphertexts(page), encrypted, 'crash do renderer não pode apagar o WAL cifrado');
  await login(page, 'other@test.invalid');
  assert.equal(await page.evaluate(async () => (await filaCifrada.listar()).length), 0);
  await page.evaluate(() => auth.logout({ broadcast: false }));
  await login(page);
  assert.equal(await page.evaluate(async () => (await filaCifrada.listar())[0].payload.item.paciente_nome), 'Caso sintético secreto');
  assert.equal(loginRequests, 3, 'recuperação só ocorre após autenticações novas no servidor de teste');
  await stopAbruptly();
  ({ page, context } = await launch());
  await locked(page);
  assert.deepEqual(await ciphertexts(page), encrypted, 'SIGKILL e reabertura preservam a pendência cifrada');
  await login(page);
  assert.equal(await page.evaluate(async () => (await filaCifrada.listar())[0].payload.item.paciente_nome), 'Caso sintético secreto');
  console.log('  ✓ D5: Chromium crash/restore e SIGKILL não reutilizam credenciais; WAL cifrado só volta ao dono após login novo');
} finally {
  if (child) {
    try { await stopAbruptly(); } catch {}
  }
  server.closeAllConnections();
  await new Promise(done => server.close(done));
  await rm(profile, { recursive: true, force: true });
}
