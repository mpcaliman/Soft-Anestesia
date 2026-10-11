/** Real app + Chromium + hosted Auth/RLS/CAS/Realtime/WAL. No API mocks.
 * Usage: node scripts/staging-only/hosted-browser.mjs --credentials=/tmp/private.json
 *   --report=/workspace/hosted-browser-report.json --app-root=dist --natural-expiry
 * Credentials must be mode0600, outside Git. Recovery is independently invoked
 * by the root after this exits, with the SAME run UUID and a fresh recovery cap.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { observeRedacted, authStateRedacted } from './browser-diagnostics.mjs';

const TARGET = 'yqqrfgbvoexricjdxpis';
const args = process.argv.slice(2);
const arg = name => args.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const credentialsPath = arg('credentials'), reportPath = arg('report');
if (!credentialsPath || !reportPath) throw new Error('credentials_and_report_paths_required');
const root = resolve(arg('app-root') || 'dist');
assert.notEqual(resolve(credentialsPath).startsWith(resolve(process.cwd()) + sep), true, 'credentials_must_be_outside_repository');
assert.equal((await stat(credentialsPath)).mode & 0o077, 0, 'credentials_must_be_private');
const fixture = JSON.parse(await readFile(credentialsPath, 'utf8'));
assert.equal(fixture.target, TARGET, 'staging_target_mismatch');
assert.match(fixture.runId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i);
assert.equal(fixture.users.length, 4); assert.equal(fixture.organizations.length, 2); assert.equal(fixture.patients.length, 2);
assert.ok(fixture.publicKey.startsWith('sb_publishable_'), 'modern_public_key_required');
assert.equal(fixture.fixtureAccess, 'active-until-independent-recovery');
fixture.users.forEach((user, index) => {
  assert.equal(user.email, `audit-${fixture.runId}-${index}@example.invalid`);
  assert.equal(user.organizationIndex, index < 2 ? 0 : 1);
  assert.equal(Buffer.byteLength(user.password, 'utf8'), 68);
});
const checks = [];
const report = { target: TARGET, runId: fixture.runId, startedAt: new Date().toISOString(),
  actualBrowser: 'chromium', API: 'hosted_without_mocks', checks, jwt: [],
  productionAccessed: false, independentRecoveryRequired: true, recoveryVerified: false,
  executionFailed: false, naturalExpirationUsesTrustedMouseActivity: true,
  realtimePositiveDeliveryTables: ['patients'], realtimeOtherJoinedTablesDeliveryNotProven: true, authDiagnostics: [] };
const saveReport = () => writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
const check = async (name, work) => {
  process.stdout.write(JSON.stringify({ phase: name, status: 'running' }) + '\n');
  try { await work(); checks.push({ name, passed: true }); }
  catch { checks.push({ name, passed: false, diagnostic: 'assertion_or_browser_transport_failed' }); throw new Error(name); }
  finally { await saveReport(); }
};
const wait = async (work, milliseconds = 45000) => {
  const until = Date.now() + milliseconds;
  while (Date.now() < until) {
    if (await work()) return;
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error('bounded_wait_failed');
};
const profile = await mkdtemp(resolve(tmpdir(), 'soft-hosted-browser-'));
let restoreBarrier = null, releaseRestore = null;
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const file = resolve(root, '.' + (pathname === '/' ? '/index.html' : decodeURIComponent(pathname)));
    if (!file.startsWith(root + sep)) throw new Error('invalid_path');
    // Hold restored documents until request observation and stage config are
    // attached. This makes the zero-credential-requests counter meaningful.
    if (pathname === '/index.html' && restoreBarrier) await restoreBarrier;
    const content = await readFile(file);
    response.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
      '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' })[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      // Supplements the built application's strict CSP; this also blocks the
      // production default URL during restore before Playwright attaches.
      'Content-Security-Policy': `connect-src 'self' https://${TARGET}.supabase.co wss://${TARGET}.supabase.co` });
    response.end(content);
  } catch { response.writeHead(404); response.end(); }
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const appURL = `http://127.0.0.1:${server.address().port}/index.html`;
let child, browser, context;
const events = new Map();
let authenticatedRequests = 0;
const attach = async () => {
  let port;
  await wait(async () => {
    try { port = Number((await readFile(resolve(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); return port > 0; }
    catch { return false; }
  }, 20000);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  context = browser.contexts()[0];
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === `${TARGET}.supabase.co` || url.hostname === '127.0.0.1' || url.protocol === 'data:' || url.protocol === 'blob:') return route.continue();
    if (url.hostname === 'zbpbrnalamjrcfbscjkt.supabase.co') report.productionAccessAttemptBlocked = true;
    return route.abort();
  });
  context.on('request', request => {
    if (new URL(request.url()).hostname === `${TARGET}.supabase.co` && request.headers().authorization) authenticatedRequests++;
  });
  await context.addInitScript(({ url, publicKey }) => {
    globalThis.__hostedRawStorage = localStorage;
    localStorage.setItem('medsys.v7.cloud.cfg', JSON.stringify({ url, anonKey: publicKey }));
  }, { url: `https://${TARGET}.supabase.co`, publicKey: fixture.publicKey });
};
const launch = async () => {
  const executable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath();
  const launchArgs = ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--restore-last-session', 'about:blank'];
  if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) launchArgs.push(`--proxy-server=${process.env.HTTPS_PROXY || process.env.HTTP_PROXY}`);
  child = spawn(executable, launchArgs, { detached: true, stdio: ['ignore', 'ignore', 'ignore'] });
  // Never print browser stderr: a transport diagnostic may contain a URL/key.
  child.on('error', () => {});
  await attach();
  if (releaseRestore) { releaseRestore(); restoreBarrier = null; releaseRestore = null; }
};
const boot = async page => {
  page.on('dialog', dialog => dialog.accept());
  await page.goto(appURL, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof auth !== 'undefined' && typeof cloud !== 'undefined' && typeof persistenciaCloudFirst !== 'undefined');
};
const observe = page => {
  const own = []; events.set(page, own);
  page.on('websocket', socket => socket.on('framereceived', frame => {
    try {
      const message = JSON.parse(String(frame.payload));
      if (message.event === 'postgres_changes') {
        const data = message.payload?.data, row = data?.record || data?.old_record;
        if (row?.id) own.push({ table: data.table, id: row.id, organizationId: row.organization_id, version: row.version });
      }
    } catch { /* Non-JSON transport frames do not enter evidence. */ }
  }));
};
const login = async (page, index) => {
  const user = fixture.users[index];
  const diagnostic = { userIndex: index }; report.authDiagnostics.push(diagnostic); observeRedacted(page, TARGET, diagnostic);
  try {
    await page.locator('#auth-email').fill(user.email); await page.locator('#auth-pass').fill(user.password);
    await page.evaluate(() => auth.tentarLoginNuvem());
    await page.waitForFunction(({ uid, org }) => auth.estaLogado() && contextoAba.operational()
      && contextoAba.organizationId() === org && cloud.session()?.user?.id === uid,
    { uid: user.id, org: fixture.organizations[user.organizationIndex] }, { timeout: 45000 });
    await page.evaluate(() => filaCifrada.preparar());
  } finally {
    diagnostic.authState = await authStateRedacted(page, { target: TARGET, uid: user.id, org: fixture.organizations[user.organizationIndex] });
    await saveReport();
  }
};
const claims = page => page.evaluate(() => {
  const token = cloud.session()?.access_token;
  const value = JSON.parse(atob(token.split('.')[1].replaceAll('-', '+').replaceAll('_', '/')));
  return { iat: value.iat, exp: value.exp, userId: value.sub };
});
const ready = page => page.waitForFunction(() => realtime._canais.size === Object.keys(realtime.TABELAS).length
  && Array.from(realtime._canais.values()).every(channel => channel.confirmado), null, { timeout: 45000 });
const readOwn = (page, index) => page.evaluate(async patient => {
  const row = await cloudRel._lerAtualTab('patients', contextoAba.organizationId(), patient.legacy_id, cloudRel._SELECT);
  if (!row || row.id !== patient.id) throw new Error('own_row_missing');
  return { id: row.id, version: row.version, organizationId: row.organization_id };
}, fixture.patients[index]);
const update = (page, index, version, marker) => page.evaluate(async ({ patient, version, marker }) => {
  const result = await cloudRel._gravarAtomico('patients', contextoAba.organizationId(), patient.legacy_id,
    { telefone: marker }, version, cloudRel._SELECT, row => cloudRel._rowParaItem(row, row.organization_id),
    { id: crypto.randomUUID(), checksum: await filaCifrada._sha256(marker) });
  return { ok: !!result.ok, conflict: !!result.conflict, version: result.row?.version, cloudVersion: result.cloudVersion };
}, { patient: fixture.patients[index], version, marker });
const locked = page => page.evaluate(() => {
  const reusable = /^(medsys\.v7\.auth\.(session|sessao_dia)|medsys\.v7\.cloud\.session|medsys\.v7\.pdfbk\.token)(@|$)/;
  for (const storage of [sessionStorage, cofre._real]) {
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (reusable.test(key) && storage.getItem(key)) return false;
    }
  }
  return !auth.usuarioAtual() && !cloud.session() && !contextoAba.operational() && filaCifrada._chaves.size === 0;
});
const ciphertexts = page => page.evaluate(async () => {
  const db = await new Promise((ok, fail) => {
    const request = indexedDB.open(filaCifrada.DB, filaCifrada.DB_VERSION);
    request.onsuccess = () => ok(request.result); request.onerror = () => fail(request.error);
  });
  try { return await new Promise((ok, fail) => {
    const tx = db.transaction(filaCifrada.STORE_OPERACOES, 'readonly');
    const request = tx.objectStore(filaCifrada.STORE_OPERACOES).getAll(); let rows;
    request.onsuccess = () => { rows = request.result; };
    tx.oncomplete = () => ok(rows); tx.onerror = () => fail(tx.error);
  }); } finally { db.close(); }
});
const kill = async () => {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit'); process.kill(-child.pid, 'SIGKILL'); await exited; child = null;
  await rm(resolve(profile, 'DevToolsActivePort'), { force: true });
};
let failure = false;
try {
  await launch();
  const a = await context.newPage(), b = await context.newPage(), peer = await context.newPage();
  [a, b, peer].forEach(observe); await Promise.all([a, b, peer].map(boot));
  await check('real_auth_two_clinics_same_browser_three_tabs', async () => {
    const results = await Promise.allSettled([login(a, 0), login(b, 2), login(peer, 1)]);
    assert.ok(results.every(result => result.status === 'fulfilled'), 'all_three_real_auth_logins_required');
    const rows = await Promise.all([readOwn(a, 0), readOwn(b, 1), readOwn(peer, 0)]);
    assert.equal(rows[0].organizationId, fixture.organizations[0]); assert.equal(rows[1].organizationId, fixture.organizations[1]);
    await b.evaluate(otherOrg => localStorage.setItem('medsys.v7.cloud.org_id', otherOrg), fixture.organizations[1]);
    assert.equal(await a.evaluate(() => contextoAba.organizationId()), fixture.organizations[0]);
    const invisible = await b.evaluate(async patient => {
      const r = await fetch(cloud.config().url + `/rest/v1/patients?id=eq.${patient.id}&select=id`, { headers: cloud._headers(true) });
      return r.ok && (await r.json()).length === 0;
    }, fixture.patients[0]); assert.equal(invisible, true);
  });
  await check('real_realtime_own_delivery_and_cross_clinic_absence', async () => {
    await Promise.all([ready(a), ready(b), ready(peer)]);
    // Phoenix join replies are followed by a real positive barrier event;
    // waiting for its receipt establishes usable CDC before assertions.
    const before = await readOwn(peer, 0);
    // CDC establishment can lag a Phoenix join reply. Repeat bounded REAL
    // writes only until one positive record event arrives; no mock readiness.
    let delivered = false;
    for (let attempt = 0; attempt < 8 && !delivered; attempt++) {
      const current = await readOwn(peer, 0);
      const result = await update(peer, 0, current.version, `synthetic-browser-cdc-barrier-${attempt}`); assert.equal(result.ok, true);
      try { await wait(() => events.get(a).some(event => event.id === before.id && event.version === result.version), 5000); delivered = true; }
      catch { if (attempt === 7) throw new Error('cdc_positive_barrier_failed'); }
    }
    assert.equal(delivered, true);
    assert.ok(events.get(a).every(event => event.organizationId === fixture.organizations[0]));
    assert.equal(events.get(b).some(event => event.id === before.id), false);
    const beta = await readOwn(b, 1); const changed = await update(b, 1, beta.version, 'synthetic-browser-beta'); assert.equal(changed.ok, true);
    await wait(() => events.get(b).some(event => event.id === beta.id && event.version === changed.version));
    assert.equal(events.get(a).some(event => event.id === beta.id), false);
  });
  await check('real_concurrent_same_revision_exactly_one_winner', async () => {
    const base = await readOwn(a, 0);
    const results = await Promise.all([update(a, 0, base.version, 'synthetic-browser-proposal-a'),
      update(peer, 0, base.version, 'synthetic-browser-proposal-peer')]);
    assert.equal(results.filter(result => result.ok).length, 1); assert.equal(results.filter(result => result.conflict).length, 1);
    assert.equal((await readOwn(a, 0)).version, base.version + 1);
    report.concurrentResults = results;
  });
  if (args.includes('--natural-expiry')) await check('real_session_crosses_original_jwt_expiration_automatic_refresh_and_realtime', async () => {
    const initial = await Promise.all([claims(a), claims(b), claims(peer)]); report.jwt = initial;
    const expiry = Math.max(...initial.map(jwt => jwt.exp)) * 1000;
    assert.ok(initial.every(jwt => jwt.exp > jwt.iat && jwt.exp - jwt.iat <= 7200));
    const until = expiry + 1500;
    while (Date.now() < until) {
      // Real trusted input keeps the five-minute shared-device inactivity
      // policy satisfied; neither session timers nor JWT clocks are changed.
      for (const page of [a, b, peer]) await page.mouse.move(20 + Date.now() % 5, 25);
      process.stdout.write(JSON.stringify({ phase: 'natural_jwt_expiration', secondsRemaining: Math.ceil((until - Date.now()) / 1000) }) + '\n');
      await saveReport(); await new Promise(done => setTimeout(done, Math.min(30000, until - Date.now())));
    }
    const renewed = await Promise.all([claims(a), claims(b), claims(peer)]);
    assert.ok(renewed.every((jwt, index) => jwt.exp > initial[index].exp && jwt.iat > initial[index].iat));
    report.renewedJWT = renewed; await Promise.all([ready(a), ready(b), ready(peer)]);
    const own = await readOwn(peer, 0); const result = await update(peer, 0, own.version, 'synthetic-browser-after-natural-expiry');
    assert.equal(result.ok, true); await wait(() => events.get(a).some(event => event.id === own.id && event.version === result.version));
    assert.equal(events.get(b).some(event => event.id === own.id), false);
  });
  else checks.push({ name: 'real_session_crosses_original_jwt_expiration_automatic_refresh_and_realtime', passed: null, diagnostic: 'natural_expiry_not_requested' });
  const offlineName = `Synthetic Offline ${fixture.runId}`, offlineId = `offline-${fixture.runId}`;
  let encrypted;
  await check('real_offline_wal_ciphertext_and_zero_plaintext_local_storage', async () => {
    await context.setOffline(true);
    const result = await a.evaluate(async ({ id, name }) => {
      const r = await persistenciaCloudFirst.salvar('pacientes', { _id: id, nome: name });
      return { queued: !!r.queued, durable: !!r.durable };
    }, { id: offlineId, name: offlineName }); assert.deepEqual(result, { queued: true, durable: true });
    encrypted = await ciphertexts(a); assert.ok(encrypted.length >= 1); assert.doesNotMatch(JSON.stringify(encrypted), new RegExp(offlineName));
    assert.equal(await a.evaluate(name => {
      const native = cofre._real;
      for (let index = 0; index < native.length; index++) if ((native.getItem(native.key(index)) || '').includes(name)) return false;
      return true;
    }, offlineName), true);
    await a.evaluate(() => sessionStorage.setItem('__hosted_crash_marker', 'original-document'));
  });
  await check('real_sigkill_restore_locks_hosted_session_retains_encrypted_wal', async () => {
    const requestsBeforeRestore = authenticatedRequests;
    restoreBarrier = new Promise(done => { releaseRestore = done; });
    await kill(); await launch();
    await wait(() => context.pages().filter(page => page.url().startsWith(appURL)).length === 3, 20000);
    const restoredPages = context.pages().filter(page => page.url().startsWith(appURL));
    assert.equal(restoredPages.length, 3, 'all_three_tabs_must_actually_restore');
    let restored;
    for (const page of restoredPages) {
      await page.waitForLoadState('load');
      await page.waitForFunction(() => typeof auth !== 'undefined' && typeof cloud !== 'undefined'
        && typeof filaCifrada !== 'undefined' && typeof persistenciaCloudFirst !== 'undefined');
      assert.equal(await locked(page), true);
      const marker = await page.evaluate(() => sessionStorage.getItem('__hosted_crash_marker'));
      if (marker === 'original-document') { assert.equal(restored, undefined); restored = page; }
    }
    assert.ok(restored, 'original_owner_tab_marker_must_restore');
    assert.deepEqual(await ciphertexts(restored), encrypted);
    report.restoredAuthenticatedRequests = authenticatedRequests - requestsBeforeRestore;
    assert.equal(report.restoredAuthenticatedRequests, 0, 'restored_tabs_must_not_reuse_hosted_credentials');
    await login(restored, 2); assert.equal(await restored.evaluate(async () => (await filaCifrada.listar()).length), 0);
    await restored.evaluate(() => auth.logout({ broadcast: false })); await login(restored, 0);
    // Re-login is a real Auth request. The original user's successful online
    // key unwrap automatically unlocks and drains the encrypted offline WAL.
    await wait(async () => await restored.evaluate(async () => (await filaCifrada.listar()).length === 0), 60000);
    const uploaded = await restored.evaluate(async name => {
      const url = cloud.config().url + '/rest/v1/patients?organization_id=eq.' + contextoAba.organizationId()
        + '&nome=eq.' + encodeURIComponent(name) + '&select=id';
      const r = await fetch(url, { headers: cloud._headers(true) }); return r.ok && (await r.json()).length === 1;
    }, offlineName); assert.equal(uploaded, true);
  });
} catch (error) {
  failure = true; report.executionFailed = true;
  report.failure = /^[a-z0-9_]+$/.test(error.message) ? error.message : 'browser_setup_or_check_failed';
  if (!checks.some(check => check.passed === false)) checks.push({ name: 'browser_setup', passed: false, diagnostic: 'browser_setup_failed' });
} finally {
  try { await kill(); } catch { failure = true; report.executionFailed = true;
    checks.push({ name: 'browser_process_shutdown', passed: false, diagnostic: 'browser_process_shutdown_failed' }); }
  server.close(); await rm(profile, { recursive: true, force: true });
  report.completedAt = new Date().toISOString(); report.passed = checks.filter(check => check.passed === true).length;
  report.failed = checks.filter(check => check.passed === false).length; report.pending = checks.filter(check => check.passed === null).length;
  await saveReport(); process.stdout.write(JSON.stringify({ target: TARGET, runId: fixture.runId, passed: report.passed,
    failed: report.failed, pending: report.pending, executionFailed: failure, independentRecoveryRequired: true }) + '\n');
}
if (failure || report.failed || report.pending) process.exitCode = 1;
