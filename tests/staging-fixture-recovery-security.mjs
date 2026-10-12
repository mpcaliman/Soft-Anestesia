import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const source = await readFile(new URL('../scripts/staging-only/fixture-recovery.ts', import.meta.url), 'utf8');
const capability = 'synthetic-recovery-capability';
const hash = createHash('sha256').update(capability).digest('hex');
const runId = 'b4bf5c3d-74c2-41ae-b9cc-c8f44d341058';
const otherRunId = '49f818c2-d080-4e56-9c3a-a1dc57359068';

function fixture(options = {}) {
  let handler, failedBan = false, lostBanReply = false;
  const calls = [];
  const adminKey = options.legacyApiKeys ? 'synthetic-admin-key' : 'sb_secret_synthetic_admin';
  const environment = { SUPABASE_URL: options.production ? 'https://zbpbrnalamjrcfbscjkt.supabase.co' : 'https://yqqrfgbvoexricjdxpis.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'synthetic-admin-key', SUPABASE_ANON_KEY: 'synthetic-anon-key',
    ...(options.legacyApiKeys ? {} : { SUPABASE_SECRET_KEYS: JSON.stringify({ default: adminKey }),
      SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: 'sb_publishable_synthetic_anon' }) }) };
  const ids = { own: '7cef9f04-122c-41ab-a23a-f38b2179e124',
    unacknowledged: '2dbdf9f7-fced-4dd3-83e0-6f0903fa86da', other: '4bc8122b-41b6-4f56-9f35-0e55fc494309',
    org: '119e683b-4200-463b-b103-2dbf01b3fcda', otherOrg: '73b9483e-c099-4bbd-bfa1-8f2dd3157dab' };
  const users = [ids.own, ids.unacknowledged, ids.other].map((id, index) => ({ id,
    app_metadata: { synthetic_audit: index < 2 ? runId : otherRunId }, banned: false, passwordChanged: false, programmer: true, profileActive: true }));
  const orgs = [{ id: ids.org, nome: `synthetic-${runId}-0`, active: true },
    { id: ids.otherOrg, nome: `synthetic-${otherRunId}-0`, active: true }];
  const memberships = [{ user: ids.own, org: ids.org, active: true },
    { user: ids.unacknowledged, org: ids.org, active: true }, { user: ids.other, org: ids.otherOrg, active: true }];
  const shares = [{ active: !!options.activeShare, expiry: Date.now() + (options.shareExpired ? -1000 : 60000) }];
  const claimedAt = new Date(Date.now() - (options.runnerStillActive ? 60000 : 240000)).toISOString();
  const inventory = () => {
    const ownUsers = users.filter(user => user.app_metadata.synthetic_audit === runId);
    const ownOrgs = orgs.filter(org => org.nome === `synthetic-${runId}-0` || org.nome === `synthetic-${runId}-1`);
    const userIds = ownUsers.map(user => user.id), orgIds = ownOrgs.map(org => org.id);
    return { runId, claimedAt, authUserIds: userIds, organizationIds: orgIds,
      activeMemberships: memberships.filter(item => item.active && (userIds.includes(item.user) || orgIds.includes(item.org))).length,
      activeProfiles: ownUsers.filter(user => user.profileActive).length, activeOrganizations: ownOrgs.filter(org => org.active).length,
      programmerPrivileges: ownUsers.filter(user => user.programmer).length, bannedAuthUsers: ownUsers.filter(user => user.banned).length,
      activeSharesPendingClosure: shares.filter(share => share.active).length,
      latestActiveShareExpiry: shares.some(share => share.active) ? new Date(shares[0].expiry).toISOString() : null };
  };
  const response = (body, status = 200) => Response.json(body, { status });
  const fetch = async (target, request) => {
    const path = new URL(target).pathname;
    calls.push({ path, method: request.method });
    if (request.headers.apikey !== adminKey || request.headers.Authorization !== (options.legacyApiKeys ? 'Bearer synthetic-admin-key' : undefined))
      return response({ code: 'PGRST301' }, 401);
    const body = request.body ? JSON.parse(request.body) : undefined;
    if (path.startsWith('/rest/v1/rpc/')) {
      assert.equal(body.p_run_id, runId, 'RPC fica vinculada ao UUID escolhido, sem inventário global');
      if (options.missingClaim) return response({ code: '22023' }, 400);
      if (path.endsWith('staging_audit_block_fixture')) {
        const scope = inventory();
        for (const member of memberships) if (scope.authUserIds.includes(member.user) || scope.organizationIds.includes(member.org)) member.active = false;
        for (const user of users) if (scope.authUserIds.includes(user.id)) { user.programmer = false; user.profileActive = false; }
        for (const org of orgs) if (scope.organizationIds.includes(org.id)) org.active = false;
        for (const share of shares) if (share.active && share.expiry <= Date.now()) share.active = false;
        const result = inventory();
        if (options.forgedScope) result.authUserIds.push(ids.other);
        return response(result);
      }
      if (path.endsWith('staging_audit_verify_recovery')) {
        const result = inventory();
        if (result.bannedAuthUsers !== result.authUserIds.length || result.activeMemberships) return response({ code: '23514' }, 400);
      }
      return response(inventory());
    }
    assert.ok(path.startsWith('/auth/v1/admin/users/'), 'recuperação não cria Auth, fixtures ou operações clínicas');
    const user = users.find(user => user.id === path.split('/').at(-1));
    assert.equal(user.app_metadata.synthetic_audit, runId, 'nenhum usuário de outra execução é bloqueado');
    assert.equal(inventory().activeMemberships, 0, 'acesso fecha antes de qualquer chamada Auth');
    if (request.method === 'PUT') {
      if (options.failBanOnce && !failedBan) { failedBan = true; return response({ code: 'unavailable' }, 503); }
      assert.equal(new TextEncoder().encode(body.password).length, 68);
      assert.match(body.password, /[A-Z]/); assert.match(body.password, /[a-z]/); assert.match(body.password, /[0-9]/); assert.match(body.password, /[^a-zA-Z0-9]/);
      assert.equal(body.ban_duration, '876000h');
      user.banned = true; user.passwordChanged = true;
      if (options.loseBanReply && !lostBanReply) { lostBanReply = true; throw new Error('synthetic-admin-key'); }
    } else assert.equal(request.method, 'GET', 'nenhuma identidade é apagada');
    return response({ id: user.id, banned_until: user.banned ? '2126-01-01T00:00:00Z' : null });
  };
  const issued = options.expired ? Date.now() - 300000 : Date.now() - 1000;
  const expires = options.expired ? Date.now() - 1000 : Date.now() + 600000;
  const context = vm.createContext({ Deno: { env: { get: key => environment[key] },
    serve: callback => { handler = callback; } }, crypto: webcrypto, TextEncoder, Uint8Array, Request, Response, AbortSignal, fetch });
  const actualSource = options.badModernBearer ? source.replace("adminKey.startsWith('sb_secret_')", 'false')
    : options.wrongAnonApiKey ? source.replace('apikey: adminKey,', 'apikey: anonKey,') : source;
  const deployed = actualSource.replace('__RECOVERY_RUN_UUID__', runId).replace('__RECOVERY_CAPABILITY_SHA256__', hash)
    .replace('__RECOVERY_ISSUED_AT__', new Date(issued).toISOString()).replace('__RECOVERY_EXPIRES_AT__', new Date(expires).toISOString());
  new vm.Script(stripTypeScriptTypes(deployed)).runInContext(context);
  const run = (boundId = runId, token = capability) => handler(new Request('https://operator.invalid/recovery', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-audit-capability': token }, body: JSON.stringify({ runId: boundId }) }));
  return { run, calls, users, memberships, orgs, ids };
}

for (const options of [{ production: true }, { expired: true }]) {
  const f = fixture(options); assert.equal((await f.run()).status, 403); assert.equal(f.calls.length, 0);
}
const wrong = fixture();
assert.equal((await wrong.run(otherRunId)).status, 400); assert.equal((await wrong.run(runId, 'wrong')).status, 403); assert.equal(wrong.calls.length, 0);
const active = fixture({ runnerStillActive: true });
assert.equal((await (await active.run()).json()).failed, 1);
assert.equal(active.calls.length, 1); assert.ok(active.memberships.every(member => member.active));
const missing = fixture({ missingClaim: true });
assert.equal((await (await missing.run()).json()).failed, 1); assert.equal(missing.calls.length, 1);

const success = fixture();
const result = await (await success.run()).json();
assert.equal(result.failed, 0); assert.equal(result.pending, 0);
assert.ok(success.users.filter(user => user.app_metadata.synthetic_audit === runId).every(user => user.banned && user.passwordChanged));
assert.ok(!success.memberships[0].active && !success.memberships[1].active);
assert.ok(success.users[2].programmer && !success.users[2].banned && success.orgs[1].active && success.memberships[2].active,
  'fixtures de outra execução permanecem intactas');
assert.equal((await (await success.run()).json()).failed, 0, 'recuperação é idempotente e repetível');
assert.ok(!JSON.stringify(result).includes('synthetic-admin-key'));
assert.equal((await (await fixture({ legacyApiKeys: true }).run()).json()).failed, 0, 'recuperação suporta fallback legacy');
for (const options of [{ badModernBearer: true }, { wrongAnonApiKey: true }]) {
  const f = fixture(options); const denied = await (await f.run()).json();
  assert.equal(denied.failed, 1);
  assert.ok(denied.checks.some(check => check.diagnostic === 'http_401'));
  assert.equal(f.calls.length, 1, 'headers modernos inválidos param antes de conter ou banir identidades');
}

for (const options of [{ failBanOnce: true }, { loseBanReply: true }]) {
  const f = fixture(options); const first = await (await f.run()).json();
  assert.equal(first.failed, 1); assert.equal(f.memberships[0].active, false, 'erro/queda Auth conserva bloqueio de acesso');
  assert.ok(!JSON.stringify(first).includes('synthetic-admin-key'));
  assert.equal((await (await f.run()).json()).failed, 0, 'repetir recuperação resolve confirmação perdida sem novas identidades');
}
const malicious = fixture({ forgedScope: true });
assert.equal((await (await malicious.run()).json()).failed, 1);
assert.equal(malicious.calls.filter(call => call.path.startsWith('/auth/')).length, 0, 'escopo alterado após bloqueio não autoriza ban de terceiro');
const pending = fixture({ activeShare: true });
assert.equal((await (await pending.run()).json()).pending, 1, 'share não expirada continua pendente, embora acesso esteja contido');
const expiredShare = fixture({ activeShare: true, shareExpired: true });
assert.equal((await (await expiredShare.run()).json()).pending, 0, 'expiração legítima permite fechar share sem mudar guard');
console.log('✓ recovery independente: alvo/UUID/prazo, Auth sem resposta, isolamento, ban/rotação, repetição após falha e shares pendentes explícitos');
