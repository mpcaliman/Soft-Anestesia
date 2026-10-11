import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const source = await readFile(new URL('../scripts/staging-integration-runner.ts', import.meta.url), 'utf8');
const capability = 'synthetic-operator-capability-for-boundary-test';
const capabilityHash = createHash('sha256').update(capability).digest('hex');
const runId = 'b4bf5c3d-74c2-41ae-b9cc-c8f44d341058';
const activeWindow = () => ({ issuedAt: new Date(Date.now() - 1000).toISOString(),
  expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() });

function runner(projectUrl, options = {}) {
  let handler;
  let networkCalls = 0;
  const calls = [];
  const claims = options.claims || new Map();
  const window = { ...activeWindow(), ...options.window };
  const environment = { SUPABASE_URL: projectUrl, SUPABASE_SERVICE_ROLE_KEY: 'synthetic-private-admin-token',
    SUPABASE_ANON_KEY: 'synthetic-public-key' };
  const context = vm.createContext({
    Deno: { env: { get: key => environment[key] }, serve: callback => { handler = callback; } },
    crypto: webcrypto, TextEncoder, Uint8Array, Request, Response, AbortSignal,
    setTimeout, clearTimeout, setInterval, clearInterval, WebSocket: class {},
    fetch: async (target, request) => {
      networkCalls++; calls.push(target);
      if (options.acceptClaims && target.endsWith('/rest/v1/staging_audit_run_claims')) {
        const row = JSON.parse(request.body);
        assert.equal(request.headers.Authorization, 'Bearer synthetic-private-admin-token');
        if (claims.has(row.capability_sha256) || [...claims.values()].some(item => item.run_id === row.run_id))
          return Response.json({ code: '23505' }, { status: 409 });
        const claim = { ...row, claimed_at: new Date().toISOString() };
        claims.set(row.capability_sha256, claim);
        if (options.loseClaimResponse) throw new Error('fetch_failed');
        return Response.json([claim], { status: 201 });
      }
      throw new Error('synthetic-private-admin-token');
    }
  });
  const deployed = source.replace('__RUN_CAPABILITY_SHA256__', capabilityHash)
    .replace('__RUN_UUID__', runId).replace('__RUN_ISSUED_AT__', window.issuedAt).replace('__RUN_EXPIRES_AT__', window.expiresAt);
  const code = stripTypeScriptTypes(deployed);
  new vm.Script(code, { filename: 'staging-integration-runner.ts' }).runInContext(context);
  const request = (token = capability, method = 'POST', boundId = runId) => new Request('https://operator.invalid/run',
    { method, headers: { 'x-audit-capability': token, 'Content-Type': 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify({ runId: boundId }) } : {}) });
  return { handle: (token, method, boundId) => handler(request(token, method, boundId)), calls: () => networkCalls, paths: () => calls };
}

const production = runner('https://zbpbrnalamjrcfbscjkt.supabase.co');
assert.equal((await production.handle()).status, 403);
assert.equal(production.calls(), 0, 'runner nunca acessa APIs quando o ambiente é produção');

const unknownProject = runner('https://unknown.supabase.co');
assert.equal((await unknownProject.handle()).status, 403);
assert.equal(unknownProject.calls(), 0);

const staging = runner('https://yqqrfgbvoexricjdxpis.supabase.co');
assert.equal((await staging.handle('wrong-capability')).status, 403);
assert.equal((await staging.handle(capability, 'GET')).status, 403);
assert.equal((await staging.handle(capability, 'POST', '49f818c2-d080-4e56-9c3a-a1dc57359068')).status, 400);
assert.equal(staging.calls(), 0, 'capacidade inválida não pode provisionar fixtures');

for (const window of [
  { issuedAt: new Date(Date.now() - 60000).toISOString(), expiresAt: new Date(Date.now() - 1).toISOString() },
  { issuedAt: new Date(Date.now() + 60000).toISOString(), expiresAt: new Date(Date.now() + 120000).toISOString() },
  { issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 16 * 60000).toISOString() },
  { issuedAt: 'invalid', expiresAt: new Date(Date.now() + 60000).toISOString() }
]) {
  const expired = runner('https://yqqrfgbvoexricjdxpis.supabase.co', { window });
  assert.equal((await expired.handle()).status, 403, 'prazo expirado, futuro, excessivo ou inválido não executa');
  assert.equal(expired.calls(), 0);
}

const result = await (await staging.handle()).json();
assert.equal(staging.calls(), 1);
assert.equal(result.failed, 1, 'falha de provisionamento continua sendo falha');
assert.equal(result.runId, runId, 'identidade conhecida pelo operador aparece mesmo quando o claim falha');
assert.equal(result.checks[0].name, 'durable_invocation_claim');
assert.equal(result.checks[0].diagnostic, 'unexpected_error');
assert.ok(!JSON.stringify(result).includes('synthetic-private-admin-token'), 'diagnóstico não revela segredo recebido em erro');
assert.equal((await staging.handle()).status, 403, 'mesma instância não aceita executar duas vezes');
assert.equal(staging.calls(), 1);

const sharedClaims = new Map();
const firstIsolate = runner('https://yqqrfgbvoexricjdxpis.supabase.co', { acceptClaims: true, claims: sharedClaims });
const firstResult = await (await firstIsolate.handle()).json();
assert.equal(firstResult.checks[0].name, 'durable_invocation_claim');
assert.equal(firstResult.checks[0].passed, true);
assert.ok(firstResult.checks.some(check => check.name === 'required_retification_schema' && !check.passed));
assert.equal(firstIsolate.paths().filter(path => path.includes('/auth/')).length, 0);
const secondIsolate = runner('https://yqqrfgbvoexricjdxpis.supabase.co', { acceptClaims: true, claims: sharedClaims });
assert.equal((await secondIsolate.handle()).status, 409, 'segundo isolate não repete capacidade persistida');
assert.equal(secondIsolate.calls(), 1, 'duplicação termina no claim, antes de qualquer schema/Auth');

const racingClaims = new Map();
const racingIsolates = [0, 1].map(() => runner('https://yqqrfgbvoexricjdxpis.supabase.co',
  { acceptClaims: true, claims: racingClaims }));
const racingResponses = await Promise.all(racingIsolates.map(isolate => isolate.handle()));
assert.deepEqual(racingResponses.map(response => response.status).sort(), [200, 409],
  'duas invocações simultâneas têm exatamente um claim aceito');
assert.equal(racingClaims.size, 1);
assert.ok(racingIsolates.every(isolate => !isolate.paths().some(path => path.includes('/auth/'))));

const uncertainClaims = new Map();
const lostReply = runner('https://yqqrfgbvoexricjdxpis.supabase.co',
  { acceptClaims: true, loseClaimResponse: true, claims: uncertainClaims });
const lostReplyResult = await (await lostReply.handle()).json();
assert.equal(lostReplyResult.failed, 1);
assert.equal(lostReply.calls(), 1, 'claim sem resposta não pode criar contas');
const afterLostReply = runner('https://yqqrfgbvoexricjdxpis.supabase.co', { acceptClaims: true, claims: uncertainClaims });
assert.equal((await afterLostReply.handle()).status, 409, 'resposta perdida conserva bloqueio persistente entre isolates');

console.log('✓ runner bloqueia produção, prazo inválido, UUID incorreto e repetição entre isolates; claim perdido não cria Auth e erro não expõe token');

const { exerciseRunner } = await import('./helpers/staging-runner-fixture.mjs');
const passing = await exerciseRunner(source, capability, capabilityHash);
assert.equal(passing.result.failed, 0, JSON.stringify(passing.result.checks.filter(check => check.passed === false)));
assert.equal(passing.result.pending, 1, 'canal legado ausente continua pendente');
assert.equal(passing.result.retention.policy, 'retain-blocked-synthetic-evidence');
assert.equal(passing.result.retention.authUserIds.length, 4);
assert.equal(passing.result.retention.organizationIds.length, 2);
assert.equal(passing.result.retention.records.filter(row => row.table === 'addenda').length, 3);
assert.equal(passing.auditOrClinicalDeletionCommitted, false, 'teste e cleanup não podem apagar evidência');
assert.equal(passing.result.retention.clinicalRowsDeleted, false);
assert.equal(passing.result.retention.auditRowsDeleted, false);
assert.equal(passing.result.retention.authUsersDeleted, false);
assert.ok(passing.accounts.every(user => user.blocked && user.sessionsRevoked), 'contas retidas ficam bloqueadas');
assert.ok(passing.memberships.every(membership => !membership.ativo), 'JWT emitido não conserva vínculo ativo');
assert.ok(passing.result.checks.some(check => check.name === 'realtime_refresh_every_joined_topic' && check.passed));
assert.equal(passing.result.checks.filter(check => check.name === 'synthetic_auth_banned_password_rotated' && check.passed).length, 4,
  'as quatro rotações passam pela política Auth e bloqueiam as contas');

const weakCreation = await exerciseRunner(source.replace("const password = 'Aa1!' + ", 'const password = '), capability, capabilityHash);
assert.equal(weakCreation.accounts.length, 0, 'Auth rejeita criação sem maiúscula antes de persistir uma conta');
assert.ok(weakCreation.result.checks.some(check => check.name === 'fixture_auth_create' && !check.passed && check.diagnostic === 'http_422'));
const weakRotation = await exerciseRunner(source.replace("{ password: 'Aa1!' + ", '{ password: '), capability, capabilityHash);
assert.equal(weakRotation.accounts.length, 4, 'regressão somente na rotação ainda cria as quatro contas');
assert.equal(weakRotation.result.checks.filter(check => check.name === 'synthetic_auth_banned_password_rotated' && !check.passed
  && check.diagnostic === 'http_422').length, 4, 'a API rejeita todas as rotações sem maiúscula');
assert.ok(weakRotation.accounts.every(user => !user.blocked), 'rotação recusada não produz falso bloqueio Auth');

const lostUpdate = await exerciseRunner(source, capability, capabilityHash, { bothAccepted: true });
assert.ok(lostUpdate.result.checks.some(check => check.name === 'retification_atomic_race_two_real_sessions_preserves_both_proposals' && !check.passed),
  'duas propostas aceitas contra a mesma base devem reprovar a homologação');
assert.ok(lostUpdate.accounts.every(user => user.blocked && user.sessionsRevoked), 'falha CAS também bloqueia as contas criadas');

const changedOriginal = await exerciseRunner(source, capability, capabilityHash, { mutateOriginal: true });
assert.ok(changedOriginal.result.checks.some(check => check.name === 'retification_atomic_race_two_real_sessions_preserves_both_proposals' && !check.passed),
  'recibo accepted não pode esconder alteração do prontuário original');
assert.equal(changedOriginal.auditOrClinicalDeletionCommitted, false);

const failedLogin = await exerciseRunner(source, capability, capabilityHash, { failFirstLogin: true });
assert.equal(failedLogin.accounts.length, 1);
assert.ok(failedLogin.accounts[0].blocked, 'Auth criado antes de falhar login permanece rastreado e bloqueado');
assert.equal(failedLogin.result.retention.authUserIds.length, 1);
assert.equal(failedLogin.auditOrClinicalDeletionCommitted, false);

const lostMembershipReply = await exerciseRunner(source, capability, capabilityHash, { loseMembershipResponse: true });
assert.ok(lostMembershipReply.result.failed > 0);
assert.ok(lostMembershipReply.memberships.every(membership => !membership.ativo), 'confirmação seguida de resposta perdida também desativa vínculo');
const lostProgrammerReply = await exerciseRunner(source, capability, capabilityHash, { loseProgrammerResponse: true });
assert.ok(lostProgrammerReply.result.failed > 0);
assert.equal(lostProgrammerReply.programmerPrivileges.length, 0, 'resposta perdida não deixa privilégio de programador ativo');

const unavailable = await exerciseRunner(source, capability, capabilityHash, { permissionInfrastructureError: true });
assert.ok(unavailable.result.checks.some(check => check.name === 'ordinary_user_cannot_authorize_share' && !check.passed),
  '503 não comprova que a autorização bloqueou uma operação');
const erasedOriginal = await exerciseRunner(source, capability, capabilityHash, { allowParentDelete: true });
assert.ok(erasedOriginal.result.checks.some(check => check.name === 'retification_parent_update_delete_and_org_cascade_denied' && !check.passed));
assert.equal(erasedOriginal.result.retention.clinicalRowsDeleted, true, 'relatório deve admitir perda detectada, sem flags falsas constantes');
console.log('✓ runner exige CAS com um vencedor e conflito preservado, pai imutável, eventos em todos os tópicos e retém evidência com contas bloqueadas mesmo após falha');
