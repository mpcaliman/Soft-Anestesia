/** Hosted browser fixture guardrails. No network or production credentials. */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

const original = await readFile(new URL('../scripts/staging-only/browser-bootstrap.ts', import.meta.url), 'utf8');
const runId = '11111111-1111-4111-8111-111111111111';
const capability = 'unit-test-only-browser-capability';
const hash = Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(capability))).toString('hex');
const issued = new Date(Date.now() - 1000).toISOString(), expires = new Date(Date.now() + 300000).toISOString();
const configured = original.replace('__BROWSER_CAPABILITY_SHA256__', hash).replace('__BROWSER_RUN_UUID__', runId)
  .replace('__BROWSER_ISSUED_AT__', issued).replace('__BROWSER_EXPIRES_AT__', expires);
const create = ({ target = 'yqqrfgbvoexricjdxpis', claims = new Set(), failAt, loseAuthReply = false,
  publicKey = 'sb_publishable_synthetic_public', inventoryOverride, source = configured } = {}) => {
  let handler; const accounts = [], organizations = [], patients = [], calls = [];
  const env = { SUPABASE_URL: `https://${target}.supabase.co`, SUPABASE_SECRET_KEYS: JSON.stringify({ default: 'sb_secret_synthetic_server' }),
    SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: publicKey }) };
  const json = (value, status = 200) => Response.json(value, { status });
  const sandbox = { Response, TextEncoder, crypto: webcrypto, AbortSignal, URL, console, atob,
    Deno: { env: { get: key => env[key] }, serve: fn => { handler = fn; } },
    fetch: async (address, options) => {
      const url = new URL(address), body = options.body ? JSON.parse(options.body) : null;
      calls.push({ path: url.pathname, method: options.method, body });
      const auth = options.headers.Authorization;
      assert.ok(!auth?.includes('sb_secret_') && !auth?.includes('sb_publishable_'), 'modern_keys_never_bearer');
      if (url.pathname === '/auth/v1/admin/users' || url.pathname.startsWith('/rest/v1/organizations')
          || url.pathname.startsWith('/rest/v1/profiles') || url.pathname === '/rest/v1/organization_users'
          || url.pathname.includes('staging_audit_')) {
        assert.equal(options.headers.apikey, 'sb_secret_synthetic_server', 'server_requests_use_server_apikey');
        assert.equal(auth, undefined);
      } else assert.equal(options.headers.apikey, 'sb_publishable_synthetic_public');
      if (failAt === url.pathname) return json({ sensitive: 'do-not-return-upstream-body' }, 503);
      if (url.pathname === '/rest/v1/staging_audit_run_claims') {
        if (claims.has(body.run_id)) return json({ code: '23505' }, 409);
        claims.add(body.run_id); return json([body], 201);
      }
      if (url.pathname === '/rest/v1/rpc/staging_audit_recovery_inventory') return json(inventoryOverride === undefined
        ? { runId, claimedAt: new Date().toISOString(), authUserIds: [], organizationIds: [], activeMemberships: 0,
          activeProfiles: 0, activeOrganizations: 0, programmerPrivileges: 0, bannedAuthUsers: 0, activeSharesPendingClosure: 0 }
        : inventoryOverride);
      if (url.pathname === '/auth/v1/admin/users') {
        assert.equal(Buffer.byteLength(body.password), 68); assert.match(body.password, /[A-Z]/); assert.match(body.password, /[a-z]/);
        assert.match(body.password, /[0-9]/); assert.match(body.password, /[!]/); assert.equal(body.app_metadata.synthetic_audit, runId);
        const user = { id: webcrypto.randomUUID(), ...body }; accounts.push(user);
        if (loseAuthReply) throw new Error('transport_secret_must_not_escape');
        return json(user, 201);
      }
      if (url.pathname === '/rest/v1/organizations') { assert.match(body.nome, new RegExp(`^synthetic-${runId}-[01]$`)); organizations.push(body); return json([body], 201); }
      if (url.pathname === '/rest/v1/profiles' || url.pathname === '/rest/v1/organization_users') return json([body], 201);
      if (url.pathname === '/auth/v1/token') {
        assert.equal(auth, undefined); const user = accounts.find(account => account.email === body.email && account.password === body.password);
        assert.ok(user); return json({ user: { id: user.id }, access_token: `user-jwt-${user.id}`, refresh_token: 'test-refresh-not-exported' });
      }
      if (url.pathname === '/rest/v1/patients') { assert.match(auth, /^Bearer user-jwt-/); const row = { id: webcrypto.randomUUID(), version: 1, ...body }; patients.push(row); return json([row], 201); }
      if (url.pathname === '/auth/v1/logout') return new Response(null, { status: 204 });
      throw new Error('unexpected_route');
    } };
  vm.createContext(sandbox); vm.runInContext(source, sandbox);
  const invoke = (cap = capability, id = runId) => handler(new Request(`https://${target}.supabase.co/functions/v1/synthetic-bootstrap`,
    { method: 'POST', headers: { 'x-audit-capability': cap, 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: id }) }));
  return { invoke, accounts, organizations, patients, calls };
};
const production = create({ target: 'zbpbrnalamjrcfbscjkt' }); assert.equal((await production.invoke()).status, 403); assert.equal(production.calls.length, 0);
const secretPublic = create({ publicKey: 'sb_secret_synthetic_server' });
assert.equal((await secretPublic.invoke()).status, 403); assert.equal(secretPublic.calls.length, 0, 'misconfigured_public_key_cannot_escape');
const denied = create(); assert.equal((await denied.invoke('wrong')).status, 403); assert.equal(denied.calls.length, 0);
assert.equal((await denied.invoke(capability, webcrypto.randomUUID())).status, 400); assert.equal(denied.calls.length, 0);
const expired = create({ source: configured.replace(expires, new Date(Date.now() - 500).toISOString()) });
assert.equal((await expired.invoke()).status, 403); assert.equal(expired.calls.length, 0);
for (const invalid of [null, { runId: webcrypto.randomUUID() }, { runId, authUserIds: ['unexpected-existing-identity'], organizationIds: [] }]) {
  const malformedInventory = create({ inventoryOverride: invalid }); const deniedResponse = await malformedInventory.invoke();
  assert.equal(deniedResponse.status, 500); assert.equal(malformedInventory.accounts.length, 0);
  assert.equal((await deniedResponse.json()).diagnostic, 'fixture_recovery_preflight_mismatch');
}
const passing = create(); const response = await passing.invoke(); assert.equal(response.status, 200);
assert.equal(response.headers.get('cache-control'), 'no-store');
const payload = await response.json(); assert.equal(payload.users.length, 4); assert.equal(payload.organizations.length, 2); assert.equal(payload.patients.length, 2);
assert.equal(payload.fixtureAccess, 'active-until-independent-recovery');
assert.equal(payload.independentRecoveryRequired, true); assert.equal(passing.calls[0].path, '/rest/v1/staging_audit_run_claims');
assert.equal(passing.accounts.length, 4); assert.equal(passing.patients.length, 2);
assert.ok(!JSON.stringify(payload).includes('sb_secret_')); assert.ok(!JSON.stringify(payload).includes('user-jwt-'));
assert.ok(!JSON.stringify(payload).includes('test-refresh-not-exported')); assert.equal((await passing.invoke()).status, 403);
const unique = new Set(); const first = create({ claims: unique }); assert.equal((await first.invoke()).status, 200);
const nextIsolate = create({ claims: unique }); assert.equal((await nextIsolate.invoke()).status, 500); assert.equal(nextIsolate.accounts.length, 0);
const interrupted = create({ failAt: '/rest/v1/organizations' }); const failure = await interrupted.invoke(); assert.equal(failure.status, 500);
const result = await failure.json(); assert.equal(result.independentRecoveryRequired, true); assert.equal(result.diagnostic, 'http_503');
assert.equal(result.users, undefined); assert.ok(!JSON.stringify(result).includes('do-not-return-upstream-body'));
assert.equal(interrupted.calls.filter(call => call.method === 'DELETE').length, 0, 'partial_failure_must_retain_evidence_for_recovery');
const lostClaims = new Set(), lost = create({ claims: lostClaims, loseAuthReply: true });
const lostResponse = await lost.invoke(); assert.equal(lostResponse.status, 500); assert.equal(lost.accounts.length, 1);
assert.equal(lost.accounts[0].app_metadata.synthetic_audit, runId, 'independent_SQL_recovery_can_identify_committed_Auth_without_a_client_ID');
assert.equal((await lostResponse.json()).diagnostic, 'unexpected_error');
const afterLost = create({ claims: lostClaims }); assert.equal((await afterLost.invoke()).status, 500); assert.equal(afterLost.accounts.length, 0);
console.log('✓ bootstrap browser fecha produção/capacidade/prazo/UUID/repetição; modern keys corretas, patient JWT real, credenciais sintéticas só resposta protegida e recovery independente');
