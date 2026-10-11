import assert from 'node:assert/strict';
import { configureGovernance, desiredGovernance, verifyGovernance } from '../scripts/configure-repository-governance.mjs';

const repository = 'mpcaliman/Soft-Anestesia';
const mainSha = 'b'.repeat(40), headSha = 'a'.repeat(40);
const full = desiredGovernance('full'), bootstrap = desiredGovernance('bootstrap');
assert.deepEqual(full.rules.find(rule => rule.type === 'required_status_checks').parameters.required_status_checks.map(check => check.context),
  ['validate', 'sql-local', 'Autorização G4 do proprietário']);
assert.deepEqual(bootstrap.rules.find(rule => rule.type === 'required_status_checks').parameters.required_status_checks.map(check => check.context), ['smoke']);
for (const ruleset of [full, bootstrap]) {
  const policy = ruleset.rules.find(rule => rule.type === 'pull_request').parameters;
  assert.equal(policy.required_approving_review_count, 0);
  assert.equal(policy.require_last_push_approval, false);
  assert.equal(policy.required_review_thread_resolution, true);
  assert.deepEqual(ruleset.bypass_actors, []);
}
assert.throws(() => desiredGovernance('unknown'));
verifyGovernance({ ...full, rules: [...full.rules].reverse(), id: 17 }, full);
for (const alter of [
  rule => { rule.enforcement = 'disabled'; },
  rule => { rule.bypass_actors = [{ actor_id: 1, actor_type: 'RepositoryRole', bypass_mode: 'always' }]; },
  rule => { rule.conditions.ref_name.include = ['refs/heads/*']; },
  rule => { rule.rules.find(item => item.type === 'required_status_checks').parameters.required_status_checks.pop(); }
]) {
  const actual = structuredClone(full); alter(actual);
  assert.throws(() => verifyGovernance(actual, full));
}

function mock(options = {}) {
  const requests = [], counts = new Map();
  let stored;
  const fetchImpl = async (url, init = {}) => {
    const prefix = `https://api.github.com/repos/${repository}`;
    assert.ok(url === prefix || url.startsWith(prefix + '/'), 'Only repository endpoints may be called');
    assert.ok(!url.endsWith('/user'));
    const path = url.slice(prefix.length).replace(/^\//, '');
    const method = init.method || 'GET';
    requests.push({ path, method });
    counts.set(path, (counts.get(path) || 0) + 1);
    let body;
    if (path === '') body = { full_name: repository, owner: { login: 'mpcaliman' }, default_branch: 'main', permissions: { admin: options.admin !== false } };
    else if (path === 'branches/main') body = { commit: { sha: options.mainDrift && counts.get(path) > 1 ? 'c'.repeat(40) : mainSha } };
    else if (path.startsWith('rulesets?includes_parents=false&per_page=100&page=')) {
      const page = Number(new URL(url).searchParams.get('page'));
      body = options.pagedRulesets ? (page === 1 ? Array.from({ length: 100 }, (_, index) => ({ name: `Other ${index}`, id: index + 100 })) : [{ name: full.name, id: 17 }]) :
        options.duplicates ? [{ name: full.name, id: 1 }, { name: full.name, id: 2 }] : [];
    }
    else if (path === 'pulls/225') body = { state: 'open', draft: true, base: { ref: 'main', repo: { full_name: repository } },
      head: { sha: options.headDrift && counts.get(path) > 1 ? 'c'.repeat(40) : headSha, repo: { full_name: repository } } };
    else if (path === `commits/${headSha}/check-runs?per_page=100&page=1`) body = { check_runs:
      (options.missingCheck ? ['validate'] : ['validate', 'sql-local', 'smoke']).map(name => ({ name, head_sha: headSha, app: { id: options.wrongIssuer ? 42 : 15368 } })) };
    else if (path === `commits/${headSha}/statuses?per_page=100&page=1`) body = [{ context: 'Autorização G4 do proprietário', state: 'pending',
      creator: { id: 41898282, login: 'github-actions[bot]', type: 'Bot' }, url: `https://api.github.com/repos/${repository}/statuses/${headSha}` }];
    else if (path === 'rulesets' && method === 'POST') { stored = JSON.parse(init.body); body = { ...stored, id: 17 }; }
    else if (path === 'rulesets/17') {
      if (method === 'PUT') stored = JSON.parse(init.body);
      body = { ...(stored || full), id: 17 };
      if (options.badReadback) body.bypass_actors = [{ actor_id: 1 }];
    }
    else throw new Error(`Unexpected mocked request: ${method} ${path}`);
    return { ok: true, status: 200, json: async () => structuredClone(body) };
  };
  return { fetchImpl, requests };
}

const preview = await configureGovernance({ fetchImpl: () => { throw new Error('Preview must stay offline'); } });
assert.equal(preview.applied, false);
assert.deepEqual(preview.ruleset, full);
await assert.rejects(() => configureGovernance({ apply: true, pr: 225 }), /GH_TOKEN/);
await assert.rejects(() => configureGovernance({ apply: true, token: 'mock-token' }), /--pr/);
for (const mode of ['bootstrap', 'full']) {
  const api = mock();
  const result = await configureGovernance({ mode, apply: true, pr: 225, token: 'mock-token', expectedMain: mainSha, fetchImpl: api.fetchImpl });
  assert.equal(result.applied, true);
  assert.equal(result.verifiedHead, headSha);
  assert.deepEqual(api.requests.filter(request => request.method !== 'GET').map(request => request.method), ['POST']);
}
const pagination = mock({ pagedRulesets: true });
assert.equal((await configureGovernance({ apply: true, pr: 225, token: 'mock-token', fetchImpl: pagination.fetchImpl })).applied, true);
assert.ok(pagination.requests.some(request => request.path === 'rulesets?includes_parents=false&per_page=100&page=2'));
assert.deepEqual(pagination.requests.filter(request => request.method !== 'GET').map(request => request.method), ['PUT']);
for (const options of [{ admin: false }, { duplicates: true }, { mainDrift: true }, { headDrift: true }, { missingCheck: true }, { wrongIssuer: true }]) {
  const api = mock(options);
  await assert.rejects(() => configureGovernance({ apply: true, pr: 225, token: 'mock-token', expectedMain: mainSha, fetchImpl: api.fetchImpl }));
  assert.equal(api.requests.filter(request => request.method !== 'GET').length, 0, 'Preflight failure must not mutate GitHub');
}
const readback = mock({ badReadback: true });
await assert.rejects(() => configureGovernance({ apply: true, pr: 225, token: 'mock-token', fetchImpl: readback.fetchImpl }), /não confirmou todas/);
const wrongBase = mock();
await assert.rejects(() => configureGovernance({ apply: true, pr: 225, token: 'mock-token', expectedMain: 'f'.repeat(40), fetchImpl: wrongBase.fetchImpl }), /main mudou/);
assert.equal(wrongBase.requests.filter(request => request.method !== 'GET').length, 0);
console.log('  ✓ governança só escreve após validar alvo, administração, SHA e checks; confirma regras completas sem perfil pessoal');
