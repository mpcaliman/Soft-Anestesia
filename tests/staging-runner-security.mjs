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
    SUPABASE_ANON_KEY: 'synthetic-public-key', SUPABASE_SECRET_KEYS: JSON.stringify({ default: 'sb_secret_synthetic_admin' }),
    SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: 'sb_publishable_synthetic_anon' }) };
  const context = vm.createContext({
    Deno: { env: { get: key => environment[key] }, serve: callback => { handler = callback; } },
    crypto: webcrypto, TextEncoder, Uint8Array, Request, Response, AbortSignal,
    setTimeout, clearTimeout, setInterval, clearInterval, WebSocket: class {},
    fetch: async (target, request) => {
      networkCalls++; calls.push(target);
      if (options.acceptClaims && target.endsWith('/rest/v1/staging_audit_run_claims')) {
        const row = JSON.parse(request.body);
        assert.equal(request.headers.apikey, 'sb_secret_synthetic_admin');
        assert.equal(request.headers.Authorization, undefined, 'secret moderno não é JWT Bearer');
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
assert.ok(firstResult.checks.some(check => check.name === 'required_independent_recovery' && !check.passed));
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
assert.equal(passing.result.realtime.initial_subscription.joinedTopics, 4);
assert.equal(passing.result.realtime.initial_subscription.subscribedTopics, 4);
assert.equal(passing.result.realtime.first_updates.ownPatientSeen, true);
assert.equal(passing.result.realtime.first_updates.ownEncounterSeen, true);
assert.equal(passing.result.realtime.first_updates.foreignOrganizationSeen, false);
for (const snapshot of Object.values(passing.result.realtime))
  assert.ok(Object.values(snapshot).every(value => ['boolean', 'number'].includes(typeof value)), 'diagnóstico Realtime só contém contadores/booleans, nunca payload/JWT/nome');
const lateReadiness = await exerciseRunner(source, capability, capabilityHash, { delayedRealtimeReadiness: true });
assert.equal(lateReadiness.result.failed, 0, 'ack Phoenix antecipado aguarda confirmação CDC antes das primeiras gravações');
const ackOnlyRunner = source.replaceAll(' && subscribed.size === topics.length', '');
const prematureUpdates = await exerciseRunner(ackOnlyRunner, capability, capabilityHash, { delayedRealtimeReadiness: true, fastRealtimeWaits: true });
assert.ok(prematureUpdates.result.checks.some(check => check.name === 'realtime_own_update_and_cross_org_filter' && !check.passed),
  'a versão que confunde ack com CDC perde os primeiros eventos e reprova sob o mesmo servidor');
const noReadiness = await exerciseRunner(source, capability, capabilityHash, { missingRealtimeReadiness: true, fastRealtimeWaits: true });
assert.ok(noReadiness.result.checks.some(check => check.name === 'realtime_authenticated_operational_and_addenda_topics' && !check.passed));
assert.equal(noReadiness.result.realtime.initial_subscription.joinedTopics, 4);
assert.equal(noReadiness.result.realtime.initial_subscription.subscribedTopics, 0, 'canal sem CDC vivo jamais é aceito');
const missingEncounterEvents = await exerciseRunner(source, capability, capabilityHash, { dropEncounterRealtime: true, fastRealtimeWaits: true });
assert.ok(missingEncounterEvents.result.checks.some(check => check.name === 'realtime_own_update_and_cross_org_filter' && !check.passed));
assert.equal(missingEncounterEvents.result.realtime.first_updates.ownPatientSeen, true);
assert.equal(missingEncounterEvents.result.realtime.first_updates.ownEncounterSeen, false, 'diagnóstico distingue tabela sem entrega');
const foreignRealtime = await exerciseRunner(source, capability, capabilityHash, { leakForeignRealtime: true });
assert.ok(foreignRealtime.result.checks.some(check => check.name === 'realtime_own_update_and_cross_org_filter' && !check.passed));
assert.equal(foreignRealtime.result.realtime.first_updates.foreignOrganizationSeen, true, 'vazamento entre organizações reprova, sem revelar o payload');
const fixtureRightsSql = await readFile(new URL('../scripts/staging-only/fixture-server-rights.sql', import.meta.url), 'utf8');
function grantedServerPrivileges(sql) {
  const privilegesByTable = {};
  for (const match of sql.replace(/^--.*$/gm, '').matchAll(/\bgrant\s+([a-z,\s]+?)\s+on\s+table\s+([a-z0-9_.,\s]+?)\s+to\s+service_role\s*;/gi)) {
    const privileges = match[1].split(',').map(value => value.trim().toUpperCase());
    for (const table of match[2].split(',').map(value => value.trim())) privilegesByTable[table] = privileges;
  }
  return privilegesByTable;
}
const serverPrivileges = grantedServerPrivileges(fixtureRightsSql);
const explicitRights = await exerciseRunner(source, capability, capabilityHash, { serverPrivileges });
assert.equal(explicitRights.result.failed, 0, 'a matriz SQL mínima permite o runner completo sem privilégios clínicos de escrita do servidor');
for (const table of ['public.patients', 'public.encounters', 'public.preanesthetic_assessments', 'public.addenda', 'public.audit_logs'])
  assert.deepEqual(serverPrivileges[table], ['SELECT'], 'o backend de fixtures só lê evidência clínica; criação usa JWT real');
assert.equal(serverPrivileges['public.staging_audit_recoveries'], undefined, 'nenhum CRUD direto de recovery é concedido');
assert.equal(serverPrivileges['public.staging_audit_run_claims'], undefined, 'claims mantém contrato separado SELECT/INSERT');
const hardeningSql = await readFile(new URL('../scripts/staging-only/fixture-server-rights-hardening.sql', import.meta.url), 'utf8');
const normalizedPrivileges = grantedServerPrivileges(hardeningSql);
const expectedBackendMatrix = {
  'public.patients': ['SELECT'], 'public.encounters': ['SELECT'],
  'public.preanesthetic_assessments': ['SELECT'], 'public.addenda': ['SELECT'],
  'public.audit_logs': ['SELECT'], 'public.documentos': ['SELECT'], 'public.org_shares': ['SELECT'],
  'public.organizations': ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  'public.profiles': ['SELECT', 'INSERT', 'UPDATE'],
  'public.organization_users': ['SELECT', 'INSERT', 'UPDATE'],
  'public.app_programmers': ['SELECT', 'INSERT', 'DELETE'],
  'public.staging_audit_run_claims': ['SELECT', 'INSERT']
};
assert.deepEqual(normalizedPrivileges, expectedBackendMatrix, 'DDL normaliza exatamente os privilégios necessários, sem escrita clínica ou de legado');
const revokedAllTargets = [...hardeningSql.replace(/^--.*$/gm, '').matchAll(/\brevoke\s+all\s+on\s+table\s+([a-z0-9_.,\s]+?)\s+from\s+service_role\s*;/gi)]
  .flatMap(match => match[1].split(',').map(value => value.trim())).sort();
assert.deepEqual(revokedAllTargets, [...Object.keys(expectedBackendMatrix), 'public.staging_audit_recoveries'].sort(),
  'antes do grant mínimo, todos os direitos prévios dos treze alvos são retirados');
assert.match(hardeningSql, /execute format\('revoke truncate on table public\.%I from service_role', r\.relname\)/);
assert.match(hardeningSql, /c\.relkind in \('r','p'\)[\s\S]*has_table_privilege\('service_role',c\.oid,'TRUNCATE'\)/,
  'pós-condição verifica TRUNCATE efetivo no catálogo público inteiro, incluindo herança');
const hardenedRunner = await exerciseRunner(source, capability, capabilityHash, { serverPrivileges: normalizedPrivileges });
assert.equal(hardenedRunner.result.failed, 0, 'runner completo funciona com a matriz normalizada extraída do DDL aplicado');
assert.equal(hardenedRunner.auditOrClinicalDeletionCommitted, false);
const missingServerSelect = structuredClone(normalizedPrivileges);
missingServerSelect['public.addenda'] = [];
const unavailableServer = await exerciseRunner(source, capability, capabilityHash, { serverPrivileges: missingServerSelect });
assert.equal(unavailableServer.accounts.length, 0, 'ausência de SELECT servidor interrompe antes de criar qualquer Auth');
assert.ok(unavailableServer.result.checks.some(check => check.name === 'required_retification_schema' && !check.passed && check.diagnostic === 'http_403'));
assert.ok(unavailableServer.result.checks.some(check => check.name === 'synthetic_independent_database_containment' && check.passed),
  'RPC independente SECURITY DEFINER contém acesso sem grant de tabela ao servidor');
const legacyKeys = await exerciseRunner(source, capability, capabilityHash, { legacyApiKeys: true });
assert.equal(legacyKeys.result.failed, 0, 'fallback legacy preserva apikey/admin Bearer e sessões dos usuários');
const badAdminBearer = await exerciseRunner(source.replace("token.startsWith('sb_secret_')", 'false'), capability, capabilityHash);
assert.equal(badAdminBearer.accounts.length, 0);
assert.ok(badAdminBearer.result.checks.some(check => check.name === 'durable_invocation_claim' && !check.passed && check.diagnostic === 'http_401'),
  'chave sb_secret em Bearer é recusada antes de claim/fixtures');
const wrongAdminApiKey = await exerciseRunner(source.replace('const apiKey = token === adminKey ? adminKey : anonKey;', 'const apiKey = anonKey;'), capability, capabilityHash);
assert.equal(wrongAdminApiKey.accounts.length, 0);
assert.ok(wrongAdminApiKey.result.checks.some(check => check.name === 'durable_invocation_claim' && !check.passed
  && ['http_401', 'http_403'].includes(check.diagnostic)),
  'apikey anon não autentica chamada administrativa moderna');
const badPublishableBearer = await exerciseRunner(source.replace("token.startsWith('sb_publishable_')", 'false'), capability, capabilityHash);
assert.equal(badPublishableBearer.accounts.length, 1);
assert.ok(badPublishableBearer.accounts[0].blocked, 'falha de login público conserva limpeza administrativa');
assert.ok(badPublishableBearer.result.checks.some(check => check.name === 'fixture_auth_password_login' && !check.passed && check.diagnostic === 'http_401'),
  'chave sb_publishable em Bearer é recusada pelo Auth');
assert.equal(passing.result.checks.filter(check => check.name === 'synthetic_auth_banned_password_rotated' && check.passed).length, 4,
  'as quatro rotações passam pela política Auth e bloqueiam as contas');

const weakCreation = await exerciseRunner(source.replace("const password = 'Aa1!' + ", 'const password = '), capability, capabilityHash);
assert.equal(weakCreation.accounts.length, 0, 'Auth rejeita criação sem maiúscula antes de persistir uma conta');
assert.ok(weakCreation.result.checks.some(check => check.name === 'fixture_auth_create' && !check.passed && check.diagnostic === 'http_422'));
const weakRotation = await exerciseRunner(source.replaceAll("{ password: 'Aa1!' + ", '{ password: '), capability, capabilityHash);
assert.equal(weakRotation.accounts.length, 4, 'regressão somente na rotação ainda cria as quatro contas');
assert.equal(weakRotation.result.checks.filter(check => check.name === 'synthetic_auth_banned_password_rotated' && !check.passed
  && check.diagnostic === 'http_422').length, 4, 'a API rejeita todas as rotações sem maiúscula');
assert.ok(weakRotation.accounts.every(user => !user.blocked), 'rotação recusada não produz falso bloqueio Auth');

// Exercise an oversized request at Auth, rather than just checking the source
// expression: prefixed UUIDs with their separators require 76 UTF-8 bytes.
const compactPassword = "'Aa1!' + crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '')";
const oversizedPassword = "'Aa1!' + crypto.randomUUID() + crypto.randomUUID()";
const longCreation = await exerciseRunner(source.replace(`const password = ${compactPassword}`, `const password = ${oversizedPassword}`), capability, capabilityHash);
assert.equal(longCreation.accounts.length, 0, 'Auth rejeita senha de 76 bytes antes de criar a conta');
assert.ok(longCreation.result.checks.some(check => check.name === 'fixture_auth_create' && !check.passed && check.diagnostic === 'http_422'));
const longRotation = await exerciseRunner(source.replaceAll(`{ password: ${compactPassword}`, `{ password: ${oversizedPassword}`), capability, capabilityHash);
assert.equal(longRotation.accounts.length, 4, 'regressão de comprimento somente na rotação conserva quatro contas');
assert.equal(longRotation.result.checks.filter(check => check.name === 'synthetic_auth_banned_password_rotated' && !check.passed
  && check.diagnostic === 'http_422').length, 4, 'Auth rejeita todas as rotações de 76 bytes');
assert.ok(longRotation.accounts.every(user => !user.blocked), 'rotação longa rejeitada não marca falso bloqueio Auth');

const budgetExceeded = await exerciseRunner(source, capability, capabilityHash, { exhaustRuntimeBudgetAtAuthCreate: true });
assert.equal(budgetExceeded.accounts.length, 1, 'fim do orçamento interrompe novas contas e testes');
assert.ok(budgetExceeded.accounts[0].blocked, 'reserva de encerramento ainda bloqueia a primeira identidade');
assert.ok(budgetExceeded.result.checks.some(check => !check.passed && check.diagnostic === 'audit_runtime_budget'));
assert.ok(budgetExceeded.result.checks.some(check => check.name === 'synthetic_independent_database_containment' && check.passed));
const lostAuthCreation = await exerciseRunner(source, capability, capabilityHash, { loseAuthCreationResponse: true });
assert.equal(lostAuthCreation.accounts.length, 1);
assert.ok(lostAuthCreation.accounts[0].blocked, 'inventário recupera e bloqueia Auth confirmado sem resposta antes do users.push');
assert.ok(lostAuthCreation.result.checks.some(check => check.name === 'synthetic_independent_database_containment' && check.passed));
const storageUnavailable = await exerciseRunner(source, capability, capabilityHash, { storageDeleteUnavailable: true });
assert.ok(storageUnavailable.result.checks.some(check => check.name === 'storage_cross_org_delete_denied' && !check.passed),
  '503 no DELETE Storage não prova isolamento, mesmo quando o objeto original permanece intacto');

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
await import('./staging-fixture-recovery-security.mjs');
