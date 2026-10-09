import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const source = await readFile(new URL('../scripts/staging-integration-runner.ts', import.meta.url), 'utf8');
const capability = 'synthetic-operator-capability-for-boundary-test';
const capabilityHash = createHash('sha256').update(capability).digest('hex');

function runner(projectUrl) {
  let handler;
  let networkCalls = 0;
  const environment = { SUPABASE_URL: projectUrl, SUPABASE_SERVICE_ROLE_KEY: 'synthetic-private-admin-token',
    SUPABASE_ANON_KEY: 'synthetic-public-key' };
  const context = vm.createContext({
    Deno: { env: { get: key => environment[key] }, serve: callback => { handler = callback; } },
    crypto: webcrypto, TextEncoder, Uint8Array, Request, Response, AbortSignal,
    setTimeout, clearTimeout, setInterval, clearInterval, WebSocket: class {},
    fetch: async () => { networkCalls++; throw new Error('synthetic-private-admin-token'); }
  });
  const code = stripTypeScriptTypes(source.replace('__RUN_CAPABILITY_SHA256__', capabilityHash));
  new vm.Script(code, { filename: 'staging-integration-runner.ts' }).runInContext(context);
  const request = (token = capability, method = 'POST') => new Request('https://operator.invalid/run',
    { method, headers: { 'x-audit-capability': token } });
  return { handle: (token, method) => handler(request(token, method)), calls: () => networkCalls };
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
assert.equal(staging.calls(), 0, 'capacidade inválida não pode provisionar fixtures');

const result = await (await staging.handle()).json();
assert.equal(staging.calls(), 1);
assert.equal(result.failed, 1, 'falha de provisionamento continua sendo falha');
assert.equal(result.checks[0].name, 'required_retification_schema');
assert.equal(result.checks[0].diagnostic, 'unexpected_error');
assert.ok(!JSON.stringify(result).includes('synthetic-private-admin-token'), 'diagnóstico não revela segredo recebido em erro');
assert.equal((await staging.handle()).status, 403, 'mesma instância não aceita executar duas vezes');
assert.equal(staging.calls(), 1);

console.log('✓ runner de homologação bloqueia produção, alvo desconhecido e capacidade inválida sem chamadas administrativas; erro não expõe token');

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
