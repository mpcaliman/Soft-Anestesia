import assert from 'node:assert/strict';
import { networkErrorEnum, routeEnum, scriptErrorEnum, observeRedacted, authStateRedacted } from '../scripts/staging-only/browser-diagnostics.mjs';
const target = 'yqqrfgbvoexricjdxpis', sensitive = 'private-password-token-do-not-record';
assert.equal(networkErrorEnum(`failure https://${sensitive}`), 'other_transport_error');
assert.equal(networkErrorEnum('net::ERR_CERT_AUTHORITY_INVALID'), 'net::ERR_CERT_AUTHORITY_INVALID');
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
console.log('✓ diagnóstico browser mantém apenas enumerações/status/booleans; URL, query, mensagens e credenciais hostis não entram no relatório');
