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
    setTimeout, clearTimeout, WebSocket: class {},
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
assert.equal(result.checks[0].name, 'fixture_auth_create');
assert.equal(result.checks[0].diagnostic, 'unexpected_error');
assert.ok(!JSON.stringify(result).includes('synthetic-private-admin-token'), 'diagnóstico não revela segredo recebido em erro');
assert.equal((await staging.handle()).status, 403, 'mesma instância não aceita executar duas vezes');
assert.equal(staging.calls(), 1);

console.log('✓ runner de homologação bloqueia produção, alvo desconhecido e capacidade inválida sem chamadas administrativas; erro não expõe token');
