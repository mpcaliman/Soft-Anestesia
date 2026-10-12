import assert from 'node:assert/strict';
import vm from 'node:vm';
import { networkErrorEnum, routeEnum, scriptErrorEnum, observeRedacted, authStateRedacted, crashPageStateRedacted, browserDocumentKind } from '../scripts/staging-only/browser-diagnostics.mjs';
const target = 'yqqrfgbvoexricjdxpis', sensitive = 'private-password-token-do-not-record';
assert.equal(networkErrorEnum(`failure https://${sensitive}`), 'other_transport_error');
assert.equal(networkErrorEnum('net::ERR_CERT_AUTHORITY_INVALID'), 'net::ERR_CERT_AUTHORITY_INVALID');
const appURL = 'http://127.0.0.1:12345/index.html';
assert.equal(browserDocumentKind(appURL, appURL), 'application');
assert.equal(browserDocumentKind('about:blank', appURL), 'blank');
assert.equal(browserDocumentKind('chrome://newtab/', appURL), 'browser_new_tab');
assert.equal(browserDocumentKind('chrome://new-tab-page/', appURL), 'browser_new_tab');
assert.equal(browserDocumentKind('chrome://profile-picker/', appURL), 'browser_profile_picker');
assert.equal(browserDocumentKind('chrome-error://chromewebdata/', appURL), 'browser_error');
assert.equal(browserDocumentKind('https://private.invalid/?token=' + sensitive, appURL), 'external_other');
assert.equal(browserDocumentKind(sensitive, appURL), 'unknown_document');
assert.equal(routeEnum(`https://${target}.supabase.co/auth/v1/token?password=${sensitive}`, target), 'auth_token');
assert.equal(routeEnum(`https://zbpbrnalamjrcfbscjkt.supabase.co/${sensitive}`, target), 'non_stage_route');
assert.deepEqual(scriptErrorEnum({ name: 'ReferenceError', message: `ambiente is not defined ${sensitive}` }),
  { kind: 'ReferenceError', symbol: 'ambiente' });
const callbacks = new Map(), state = {};
observeRedacted({ on: (name, cb) => callbacks.set(name, cb) }, target, state);
callbacks.get('response')({ url: () => `https://${target}.supabase.co/rest/v1/profiles?id=eq.${sensitive}`, status: () => 403 });
callbacks.get('requestfailed')({ url: () => `https://${target}.supabase.co/auth/v1/token?token=${sensitive}`,
  failure: () => ({ errorText: `net::ERR_FAILED ${sensitive}` }) });
callbacks.get('pageerror')({ name: 'TypeError', message: `auth threw ${sensitive}` });
assert.equal(state.network[0].route, 'profiles'); assert.equal(state.network[0].status, 403);
assert.equal(state.network[1].error, 'other_transport_error');
assert.ok(!JSON.stringify(state).includes(sensitive));
assert.deepEqual(await authStateRedacted({ evaluate: async () => { throw new Error(sensitive); } }, {}), { diagnosticUnavailable: true });
assert.deepEqual(await crashPageStateRedacted({ evaluate: async () => { throw new Error(sensitive); } }), { crashDiagnosticUnavailable: true });
const storage = {
  length: 2, key: index => index === 0 ? 'medsys.v7.cloud.session' : '__hosted_crash_marker',
  getItem: key => key === '__hosted_crash_marker' ? 'original-document' : sensitive
};
const crashState = await crashPageStateRedacted({ evaluate: async fn => vm.runInNewContext(`(${fn.toString()})()`, {
  auth: { estaLogado: () => false }, cloud: { session: () => null },
  contextoAba: { operational: () => false, atual: () => ({ verified: false, userId: sensitive, organizationId: sensitive }) },
  filaCifrada: { DB: 'synthetic-offline-db', _chaves: new Map([[sensitive, sensitive]]) },
  store: { list: () => [{ nome: sensitive }] }, cofre: { _real: storage }, sessionStorage: storage,
  indexedDB: { databases: async () => [{ name: sensitive }] }
}) });
assert.equal(crashState.ownerMarkerPresent, true); assert.equal(crashState.nativeCredentialsPresent, true);
assert.equal(crashState.sessionCredentialsPresent, true); assert.equal(crashState.confirmedPatientsVisible, true);
assert.equal(crashState.inMemoryVaultKeyCount, 1); assert.equal(crashState.offlineDatabasePresent, false);
assert.ok(!JSON.stringify(crashState).includes(sensitive));
for (let index = 0; index < 1000; index++) callbacks.get('pageerror')({ name: 'TypeError', message: sensitive });
assert.equal(state.scriptErrors.length, 256, 'event_storm_diagnostic_memory_is_bounded');
console.log('✓ diagnóstico browser mantém apenas enumerações/status/booleans; URL, query, mensagens e credenciais hostis não entram no relatório');
