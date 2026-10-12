import assert from 'node:assert/strict';
import { authorizationFor, verifyGitHubAuthorization, REPOSITORY, AUTHORIZATION_CONTEXT,
  AUTHORIZATION_WORKFLOW } from '../scripts/verify-owner-authorization.mjs';

const sha = 'a'.repeat(40);
const input = { sha, scope: 'merge', reference: 'G4-audit-v2' };
const comment = {
  user: { login: 'mpcaliman', type: 'User' },
  body: `SOFT-AUTORIZACAO G4-audit-v2 ${sha} merge`,
  created_at: '2026-10-09T10:00:00Z', html_url: 'https://github.com/mpcaliman/Soft-Anestesia/pull/225#issuecomment-test'
};
assert.throws(() => authorizationFor(input));
assert.throws(() => authorizationFor({ ...input, comments: [{ ...comment, user: { login: 'outro' } }] }));
assert.throws(() => authorizationFor({ ...input, sha: 'b'.repeat(40), comments: [comment] }));
assert.throws(() => authorizationFor({ ...input, comments: [{ ...comment, body: comment.body + ' extra' }] }));
assert.equal(authorizationFor({ ...input, comments: [comment] }).owner, 'mpcaliman');
assert.throws(() => authorizationFor({ ...input, comments: [comment, {
  ...comment, body: comment.body.replace('SOFT-AUTORIZACAO', 'SOFT-REVOGACAO'), updated_at: '2026-10-09T11:00:00Z'
}] }));
assert.throws(() => authorizationFor({ ...input, comments: [{ ...comment, body: 'Exemplo\n' + comment.body }] }));
assert.throws(() => authorizationFor({ ...input, reviews: [{ ...comment, state: 'APPROVED', commit_id: sha }] }));
assert.throws(() => authorizationFor({ ...input, scope: 'deploy', comments: [comment] }));
const tiedRevocation = { ...comment, body: comment.body.replace('SOFT-AUTORIZACAO', 'SOFT-REVOGACAO') };
for (const comments of [[comment, tiedRevocation], [tiedRevocation, comment]]) {
  assert.throws(() => authorizationFor({ ...input, comments }));
}
assert.equal(authorizationFor({ ...input, comments: [tiedRevocation, {
  ...comment, updated_at: '2026-10-09T10:00:01Z'
}] }).owner, 'mpcaliman');
for (const scope of ['__proto__', 'constructor', 'toString']) {
  assert.throws(() => authorizationFor({ ...input, scope, comments: [comment] }), /SHA\/escopo inválido/);
}
assert.throws(() => authorizationFor({ ...input, comments: [{ ...comment, updated_at: '2026-10-09T09:59:59Z' }] }), /Datas da decisão/);
console.log('  ✓ autorização do proprietário exige identidade, escopo e SHA exatos; revogação invalida');

// Model GitHub responses, rather than treating a status description or caller
// supplied dispatch object as an authorization. No real credentials/network.
const pr = '225';
const workflowSha = 'b'.repeat(40), newerMain = 'c'.repeat(40), blob = 'd'.repeat(40);
const reference = `G4-PR-${pr}`;
const runId = 81234;
const proof = `https://github.com/${REPOSITORY}/actions/runs/${runId}`;
const owner = { login: 'mpcaliman', type: 'User' };
const grantAt = '2026-10-09T10:00:00Z';
const apiInput = { repository: REPOSITORY, pr, sha, scope: 'merge', reference, token: 'mock-token' };
const pull = { state: 'open', draft: false, base: { ref: 'main', repo: { full_name: REPOSITORY } },
  head: { sha, repo: { full_name: REPOSITORY } } };
const run = { id: runId, event: 'workflow_dispatch', head_branch: 'main', head_sha: workflowSha,
  path: AUTHORIZATION_WORKFLOW, repository: { full_name: REPOSITORY }, head_repository: { full_name: REPOSITORY },
  actor: { ...owner }, triggering_actor: { ...owner }, run_attempt: 1, workflow_id: 999,
  display_title: `SOFT-AUTORIZACAO ${reference} ${sha} merge`, status: 'completed', conclusion: 'success',
  created_at: grantAt, updated_at: '2026-10-09T10:00:30Z' };
const status = { state: 'success', context: AUTHORIZATION_CONTEXT, sha,
  creator: { login: 'github-actions[bot]', type: 'Bot', id: 41898282 },
  url: `https://api.github.com/repos/${REPOSITORY}/statuses/${sha}`, target_url: proof,
  description: 'Informational text is not proof', created_at: '2026-10-09T10:00:20Z' };
const job = { name: 'Verificar autorização registrada', run_id: runId, status: 'completed', conclusion: 'success' };
const dispatch = { event: 'workflow_dispatch', ref: 'refs/heads/main', actor: 'mpcaliman',
  triggeringActor: 'mpcaliman', runId: String(runId), runAttempt: '1', workflowSha };
const ownerComment = (date, revoked = false) => ({ user: owner,
  body: `SOFT-${revoked ? 'REVOGACAO' : 'AUTORIZACAO'} ${reference} ${sha} merge`,
  created_at: date, html_url: `https://github.com/${REPOSITORY}/pull/${pr}#issuecomment-proof` });

function fixture(options = {}) {
  const live = options.live === true;
  const data = structuredClone({ pull, run, status, job });
  if (live) {
    data.run.status = data.job.status = 'in_progress';
    data.run.conclusion = data.job.conclusion = null;
  }
  options.mutate?.(data);
  const requests = [];
  let pullReads = 0;
  const replies = new Map();
  const fetchImpl = async (url, init) => {
    assert.equal(init.headers.Authorization, 'Bearer mock-token');
    assert.equal(init.headers['X-GitHub-Api-Version'], '2022-11-28');
    const prefix = `https://api.github.com/repos/${REPOSITORY}/`;
    assert.ok(url.startsWith(prefix), 'API requests must stay in the target repository');
    const path = url.slice(prefix.length);
    requests.push(path);
    if (replies.has(path)) {
      const reply = replies.get(path);
      if (reply instanceof Error) throw reply;
      if ('ok' in reply) return reply;
      return { ok: true, status: 200, json: async () => structuredClone(reply) };
    }
    let body;
    if (path === `pulls/${pr}`) body = ++pullReads === 1 ? data.pull : (options.secondPull || data.pull);
    else if (path.startsWith(`commits/${sha}/statuses?`)) {
      const page = Number(new URL(url).searchParams.get('page'));
      body = options.statusPages?.[page - 1] || (page === 1 ? (options.statuses || [data.status]) : []);
    } else if (path.startsWith(`issues/${pr}/comments?`)) {
      const page = Number(new URL(url).searchParams.get('page'));
      body = options.commentPages?.[page - 1] || (page === 1 ? (options.comments || []) : []);
    } else if (path === `actions/runs/${runId}`) body = data.run;
    else if (path === 'actions/workflows/owner-approval.yml') body = { id: 999, path: AUTHORIZATION_WORKFLOW };
    else if (path.startsWith(`actions/runs/${runId}/jobs?`)) {
      const page = Number(new URL(url).searchParams.get('page'));
      body = { jobs: options.jobPages?.[page - 1] || (page === 1 ? (options.jobs || [data.job]) : []) };
    } else if (path === 'branches/main') body = { commit: { sha: options.mainSha || workflowSha } };
    else if (path === `compare/${workflowSha}...${newerMain}`)
      body = { status: 'ahead', merge_base_commit: { sha: workflowSha } };
    else if (path.startsWith('contents/')) {
      const parsed = new URL(url);
      body = { type: 'file', path: parsed.pathname.slice(`/repos/${REPOSITORY}/contents/`.length), sha: blob };
    } else throw new Error(`Unexpected mock API request: ${path}`);
    return { ok: true, status: 200, json: async () => structuredClone(body) };
  };
  return { data, requests, replies, verify: (extra = {}) => verifyGitHubAuthorization({ ...apiInput, fetchImpl,
    ...(live ? { dispatch } : {}), ...extra }) };
}

let asyncCases = 0;
async function denied(options, extra, pattern = /Falta autorização|Execução não comprova|Despacho exige|Job de autorização|HEAD atual|GitHub |Data da decisão|Datas da execução|Resposta GitHub inválida/) {
  asyncCases++;
  await assert.rejects(fixture(options).verify(extra), pattern);
}

assert.throws(() => authorizationFor({ ...input, dispatchDecisions: [{ revoked: false,
  date: grantAt, time: Date.parse(grantAt), evidence: proof }] }), /Falta autorização/);
for (const extra of [
  { repository: 'attacker/Soft-Anestesia' }, { pr: '0' }, { pr: '0225' },
  { reference: 'G4-PR-226' }, { sha: sha.slice(1) }, { token: '' }
]) {
  const model = fixture();
  await assert.rejects(model.verify(extra), /Repositório\/PR inválido|Referência deve identificar|SHA\/escopo inválido|Token GitHub ausente/);
  assert.equal(model.requests.length, 0);
  asyncCases++;
}

for (const live of [false, true]) {
  const model = fixture({ live });
  const result = await model.verify();
  assert.equal(result.evidence, proof);
  assert.equal(result.method, 'workflow_dispatch');
  assert.equal(result.authorizedAt, grantAt);
  assert.equal(model.requests.filter(path => path === `pulls/${pr}`).length, 2);
  asyncCases++;
}
for (const path of [`${AUTHORIZATION_WORKFLOW}@main`, `${AUTHORIZATION_WORKFLOW}@refs/heads/main`]) {
  assert.equal((await fixture({ mutate: d => { d.run.path = path; } }).verify()).method, 'workflow_dispatch');
  asyncCases++;
}
assert.equal((await fixture({ statuses: [], comments: [ownerComment(grantAt)] }).verify()).method, 'comment');
asyncCases++;

for (const mutate of [
  d => { d.status.state = 'pending'; },
  d => { d.status.context += ' forged'; },
  d => { d.status.creator.login = 'mpcaliman'; },
  d => { d.status.creator.type = 'User'; },
  d => { d.status.creator.id++; },
  d => { d.status.sha = 'e'.repeat(40); },
  d => { d.status.url = d.status.url.replace(sha, 'e'.repeat(40)); },
  d => { d.status.target_url += '?redirect=evil'; },
  d => { d.status.target_url += '#fragment'; },
  d => { d.status.target_url = d.status.target_url.replace(REPOSITORY, 'attacker/Soft-Anestesia'); },
  d => { d.status.target_url = d.status.target_url.replace(String(runId), '081234'); },
  d => { d.status.target_url = d.status.target_url.replace(String(runId), '9007199254740992'); }
]) await denied({ mutate });

for (const mutate of [
  d => { d.run.id++; },
  d => { d.run.event = 'pull_request_target'; },
  d => { d.run.head_branch = 'codex/forged'; },
  d => { d.run.path = '.github/workflows/other.yml'; },
  d => { d.run.path = `${AUTHORIZATION_WORKFLOW}@codex/forged`; },
  d => { d.run.path = `${AUTHORIZATION_WORKFLOW}@refs/heads/codex/forged`; },
  d => { d.run.repository.full_name = 'attacker/Soft-Anestesia'; },
  d => { d.run.head_repository.full_name = 'attacker/Soft-Anestesia'; },
  d => { d.run.actor.login = 'other'; },
  d => { d.run.actor.type = 'Bot'; },
  d => { d.run.triggering_actor.login = 'other'; },
  d => { d.run.triggering_actor.type = 'Bot'; },
  d => { d.run.run_attempt = 2; },
  d => { d.run.display_title = d.run.display_title.replace(reference, 'G4-PR-226'); },
  d => { d.run.display_title = d.run.display_title.replace(sha, 'e'.repeat(40)); },
  d => { d.run.head_sha = 'e'.repeat(39); },
  d => { d.run.workflow_id++; },
  d => { d.run.status = 'in_progress'; },
  d => { d.run.conclusion = 'failure'; },
  d => { d.job.conclusion = 'skipped'; },
  d => { d.job.status = 'queued'; },
  d => { d.job.run_id++; }
]) await denied({ mutate });
await denied({ jobs: [] });
await denied({ jobs: [job, job] });

for (const field of ['event', 'ref', 'actor', 'triggeringActor', 'runAttempt', 'runId', 'workflowSha']) {
  await denied({ live: true }, { dispatch: { ...dispatch, [field]: 'forged' } });
}
await denied({ live: true, mutate: d => { d.run.head_sha = newerMain; } });
await denied({ live: true, mutate: d => { d.run.status = 'completed'; d.run.conclusion = 'success'; } });
await denied({ live: true, mutate: d => { d.job.status = 'completed'; d.job.conclusion = 'success'; } });

for (const mutate of [
  p => { p.state = 'closed'; }, p => { p.draft = true; }, p => { p.base.ref = 'staging'; },
  p => { p.base.repo.full_name = 'attacker/Soft-Anestesia'; },
  p => { p.head.sha = newerMain; }, p => { p.head.repo.full_name = 'attacker/Soft-Anestesia'; }
]) {
  const changed = structuredClone(pull);
  mutate(changed);
  await denied({ secondPull: changed });
}

for (const live of [false, true]) {
  for (const date of [grantAt, '2026-10-09T10:00:01Z']) {
    await denied({ live, comments: [ownerComment(date, true)] });
  }
  assert.equal((await fixture({ live, comments: [ownerComment('2026-10-09T09:59:59Z', true)] }).verify()).method,
    'workflow_dispatch');
  asyncCases++;
}
await denied({ comments: [ownerComment('2026-10-09T10:00:01Z', true)], mutate: d => {
  d.status.created_at = '2026-10-09T12:00:00Z';
  d.run.updated_at = '2026-10-09T12:00:00Z';
} });
assert.equal((await fixture({ comments: [ownerComment('2026-10-09T10:00:01Z')] }).verify()).method, 'comment');
asyncCases++;
await denied({ mutate: d => { d.status.created_at = '2026-10-09T09:59:59Z'; } });
await denied({ mutate: d => { d.status.created_at = 'yesterday'; } });
await denied({ mutate: d => { d.run.created_at = '2026-02-30T10:00:00Z'; } });
await denied({ mutate: d => { d.run.updated_at = '2026-10-09T09:59:59Z'; } });
await denied({ comments: [ownerComment('invalid', true)] });
await assert.rejects(fixture({ comments: [{ ...ownerComment(grantAt, true), updated_at: '2026-10-09T09:59:59Z' }] }).verify(), /Datas da decisão/);
asyncCases++;

// A dispatch from an ancestor remains valid only when both trusted files have
// identical contents. A branch commit or changed helper/workflow is rejected.
assert.equal((await fixture({ mainSha: newerMain }).verify()).method, 'workflow_dispatch');
asyncCases++;
for (const path of [AUTHORIZATION_WORKFLOW, 'scripts/verify-owner-authorization.mjs']) {
  const model = fixture({ mainSha: newerMain });
  model.replies.set(`contents/${path}?ref=${newerMain}`, { type: 'file', path, sha: 'e'.repeat(40) });
  await assert.rejects(model.verify(), /Falta autorização/);
  asyncCases++;
}
for (const comparison of [
  { status: 'diverged', merge_base_commit: { sha: workflowSha } },
  { status: 'behind', merge_base_commit: { sha: workflowSha } },
  { status: 'ahead', merge_base_commit: { sha: newerMain } }
]) {
  const model = fixture({ mainSha: newerMain });
  model.replies.set(`compare/${workflowSha}...${newerMain}`, comparison);
  await assert.rejects(model.verify(), /Falta autorização/);
  asyncCases++;
}
const wrongWorkflow = fixture();
wrongWorkflow.replies.set('actions/workflows/owner-approval.yml', { id: 999, path: '.github/workflows/other.yml' });
await assert.rejects(wrongWorkflow.verify(), /Falta autorização/);
asyncCases++;

for (const reply of [
  new Error('offline'), { ok: false, status: 403 },
  { ok: true, status: 200, json: async () => { throw new SyntaxError('bad JSON'); } }
]) {
  const model = fixture({ comments: [ownerComment(grantAt)] });
  model.replies.set(`actions/runs/${runId}`, reply);
  await assert.rejects(model.verify(), /GitHub /);
  asyncCases++;
}
for (const path of [`commits/${sha}/statuses?per_page=100&page=1`,
  `issues/${pr}/comments?per_page=100&page=1`, `actions/runs/${runId}/jobs?per_page=100&page=1`]) {
  const model = fixture();
  model.replies.set(path, {});
  await assert.rejects(model.verify(), /Resposta GitHub inválida/);
  asyncCases++;
}
const irrelevantStatus = { ...status, context: 'unrelated' };
const paged = fixture({ statusPages: [Array.from({ length: 100 }, () => irrelevantStatus), [status]],
  commentPages: [Array.from({ length: 100 }, () => ({ user: { login: 'other' }, body: 'noise' })),
    [ownerComment('2026-10-09T09:59:59Z', true)]],
  jobPages: [Array.from({ length: 100 }, () => ({ name: 'Other job' })), [job]] });
assert.equal((await paged.verify()).method, 'workflow_dispatch');
for (const path of [`commits/${sha}/statuses`, `issues/${pr}/comments`, `actions/runs/${runId}/jobs`])
  assert.ok(paged.requests.includes(`${path}?per_page=100&page=2`));
asyncCases++;
const duplicate = fixture({ statuses: [status, { ...status, description: 'forged later description' }] });
assert.equal((await duplicate.verify()).authorizedAt, grantAt);
assert.equal(duplicate.requests.filter(path => path === `actions/runs/${runId}`).length, 1);
asyncCases++;
console.log(`  ✓ ${asyncCases} casos API: despacho real vincula PR/SHA/main; status forjado, replay e revogação falham fechados`);
