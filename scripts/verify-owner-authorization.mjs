import { pathToFileURL } from 'node:url';

export const OWNER = 'mpcaliman';
export const REPOSITORY = 'mpcaliman/Soft-Anestesia';
export const AUTHORIZATION_CONTEXT = 'Autorização G4 do proprietário';
export const AUTHORIZATION_WORKFLOW = '.github/workflows/owner-approval.yml';
const VERIFIER_PATH = 'scripts/verify-owner-authorization.mjs';
const JOB_NAME = 'Verificar autorização registrada';
const GATES = { merge: 'G4', deploy: 'G5', migration: 'G3' };
const ACTIONS_BOT_ID = 41898282;
const TRUSTED_RUN_PATHS = new Set([AUTHORIZATION_WORKFLOW, `${AUTHORIZATION_WORKFLOW}@main`, `${AUTHORIZATION_WORKFLOW}@refs/heads/main`]);

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)) {
    throw new Error('Data da decisão ausente ou ambígua');
  }
  return Date.parse(value);
}

function validateInput({ sha, scope, reference }) {
  if (!/^[0-9a-f]{40}$/.test(sha || '') || !Object.hasOwn(GATES, scope)) throw new Error('SHA/escopo inválido');
  if (!new RegExp(`^${GATES[scope]}-[A-Za-z0-9._/-]+$`).test(reference || '')) throw new Error('Referência inválida');
}

function commentDecisions({ sha, scope, reference, comments }) {
  const allow = `SOFT-AUTORIZACAO ${reference} ${sha} ${scope}`;
  const revoke = `SOFT-REVOGACAO ${reference} ${sha} ${scope}`;
  return comments.filter(c => c.user?.login === OWNER && c.user?.type === 'User')
    .filter(c => [allow, revoke].includes(String(c.body || '').trim()))
    .map(c => {
      const time = timestamp(c.updated_at || c.created_at);
      if (c.updated_at && time < timestamp(c.created_at)) throw new Error('Datas da decisão inconsistentes');
      return { revoked: String(c.body).trim() === revoke, date: c.updated_at || c.created_at,
        time, evidence: c.html_url, method: 'comment' };
    });
}

function resolveAuthorization(input, dispatchDecisions = []) {
  validateInput(input);
  const decisions = [...commentDecisions(input), ...dispatchDecisions];
  // GitHub timestamps have second precision: a tied revocation always wins.
  decisions.sort((a, b) => a.time - b.time || Number(a.revoked) - Number(b.revoked));
  const last = decisions.at(-1);
  if (!last || last.revoked) throw new Error(`Falta autorização ${input.reference} de ${OWNER} para ${input.scope} no SHA ${input.sha}`);
  if (!last.evidence) throw new Error('Decisão sem evidência verificável');
  return { owner: OWNER, sha: input.sha, scope: input.scope, reference: input.reference,
    evidence: last.evidence, authorizedAt: last.date, method: last.method };
}

// Plain callers can supply owner comments, never unverified dispatch evidence.
export function authorizationFor({ sha, scope, reference, comments = [] }) {
  return resolveAuthorization({ sha, scope, reference, comments });
}

function githubClient(token, fetchImpl) {
  if (!token) throw new Error('Token GitHub ausente');
  async function get(path) {
    let response;
    try {
      response = await fetchImpl(`https://api.github.com/repos/${REPOSITORY}/${path}`, {
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' }
      });
    } catch { throw new Error('GitHub indisponível; autorização não confirmada'); }
    if (!response.ok) throw new Error(`GitHub recusou leitura ${response.status}`);
    try { return await response.json(); }
    catch { throw new Error('GitHub retornou JSON inválido'); }
  }
  async function pages(path, field) {
    const rows = [];
    for (let page = 1; ; page++) {
      const response = await get(`${path}?per_page=100&page=${page}`);
      const batch = field ? response[field] : response;
      if (!Array.isArray(batch)) throw new Error('Resposta GitHub inválida');
      rows.push(...batch);
      if (batch.length < 100) return rows;
    }
  }
  return { get, pages };
}

function validatePull(pull, sha) {
  if (pull.state !== 'open' || pull.draft !== false || pull.base?.ref !== 'main' ||
      pull.base?.repo?.full_name !== REPOSITORY || pull.head?.sha !== sha || pull.head?.repo?.full_name !== REPOSITORY) {
    throw new Error('A autorização deve corresponder ao HEAD atual de um PR pronto e aberto para main');
  }
}

function runIdFromStatus(status, sha) {
  if (status.state !== 'success' || status.context !== AUTHORIZATION_CONTEXT ||
      status.creator?.login !== 'github-actions[bot]' || status.creator?.type !== 'Bot' || status.creator?.id !== ACTIONS_BOT_ID ||
      status.url !== `https://api.github.com/repos/${REPOSITORY}/statuses/${sha}` || (status.sha && status.sha !== sha)) return null;
  const prefix = `https://github.com/${REPOSITORY}/actions/runs/`;
  if (typeof status.target_url !== 'string' || !status.target_url.startsWith(prefix)) return null;
  const id = status.target_url.slice(prefix.length);
  return /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id)) ? id : null;
}

async function dispatchDecision({ client, pr, sha, reference, runId, completed, expectedWorkflowSha }) {
  const run = await client.get(`actions/runs/${runId}`);
  if (String(run.id) !== String(runId) || run.event !== 'workflow_dispatch' || run.head_branch !== 'main' ||
      !TRUSTED_RUN_PATHS.has(run.path) || run.repository?.full_name !== REPOSITORY ||
      run.head_repository?.full_name !== REPOSITORY || run.actor?.login !== OWNER || run.actor?.type !== 'User' ||
      run.triggering_actor?.login !== OWNER || run.triggering_actor?.type !== 'User' || run.run_attempt !== 1 ||
      run.display_title !== `SOFT-AUTORIZACAO ${reference} ${sha} merge` || !/^[0-9a-f]{40}$/.test(run.head_sha || '') ||
      (expectedWorkflowSha && run.head_sha !== expectedWorkflowSha) ||
      (completed ? run.status !== 'completed' || run.conclusion !== 'success' : run.status !== 'in_progress' || run.conclusion !== null)) {
    throw new Error('Execução não comprova despacho do proprietário na base confiável');
  }
  const workflow = await client.get('actions/workflows/owner-approval.yml');
  if (workflow.id !== run.workflow_id || workflow.path !== AUTHORIZATION_WORKFLOW) throw new Error('Workflow de autorização incorreto');
  const jobs = await client.pages(`actions/runs/${runId}/jobs`, 'jobs');
  const authorizationJobs = jobs.filter(job => job.name === JOB_NAME);
  if (authorizationJobs.length !== 1 || String(authorizationJobs[0].run_id) !== String(runId) ||
      (completed ? authorizationJobs[0].status !== 'completed' || authorizationJobs[0].conclusion !== 'success' :
        authorizationJobs[0].status !== 'in_progress' || authorizationJobs[0].conclusion !== null)) {
    throw new Error('Job de autorização não confirmou a decisão');
  }
  const main = await client.get('branches/main');
  const mainSha = main.commit?.sha;
  if (!/^[0-9a-f]{40}$/.test(mainSha || '')) throw new Error('Base confiável indisponível');
  if (run.head_sha !== mainSha) {
    const comparison = await client.get(`compare/${run.head_sha}...${mainSha}`);
    if (!['ahead', 'identical'].includes(comparison.status) || comparison.merge_base_commit?.sha !== run.head_sha) {
      throw new Error('O commit do despacho não pertence ao histórico de main');
    }
  }
  for (const path of [AUTHORIZATION_WORKFLOW, VERIFIER_PATH]) {
    const atRun = await client.get(`contents/${path}?ref=${run.head_sha}`);
    const atMain = await client.get(`contents/${path}?ref=${mainSha}`);
    if (atRun.type !== 'file' || atMain.type !== 'file' || atRun.path !== path || atMain.path !== path ||
        !/^[0-9a-f]{40}$/.test(atMain.sha || '') || atRun.sha !== atMain.sha) {
      throw new Error('O despacho não usou a implementação atualmente confiável de main');
    }
  }
  const time = timestamp(run.created_at);
  if (timestamp(run.updated_at) < time) throw new Error('Datas da execução inconsistentes');
  return { revoked: false, date: run.created_at, time, method: 'workflow_dispatch',
    evidence: `https://github.com/${REPOSITORY}/actions/runs/${runId}` };
}

export async function verifyGitHubAuthorization({ repository, pr, sha, scope, reference, token, fetchImpl = fetch, dispatch }) {
  if (repository !== REPOSITORY || !/^[1-9]\d*$/.test(String(pr))) throw new Error('Repositório/PR inválido');
  validateInput({ sha, scope, reference });
  if (scope === 'merge' && reference !== `G4-PR-${pr}`) throw new Error('Referência deve identificar o PR exato');
  const client = githubClient(token, fetchImpl);
  validatePull(await client.get(`pulls/${pr}`), sha);
  const decisions = [];
  if (dispatch) {
    if (scope !== 'merge' || dispatch.event !== 'workflow_dispatch' || dispatch.ref !== 'refs/heads/main' ||
        dispatch.actor !== OWNER || dispatch.triggeringActor !== OWNER || dispatch.runAttempt !== '1' ||
        !/^[1-9]\d*$/.test(String(dispatch.runId)) || !/^[0-9a-f]{40}$/.test(dispatch.workflowSha || '')) {
      throw new Error('Despacho exige evento real do proprietário em main');
    }
    decisions.push(await dispatchDecision({ client, pr, sha, reference, runId: dispatch.runId, completed: false,
      expectedWorkflowSha: dispatch.workflowSha }));
  } else if (scope === 'merge') {
    const statuses = await client.pages(`commits/${sha}/statuses`);
    const checkedRuns = new Set();
    for (const status of statuses) {
      const runId = runIdFromStatus(status, sha);
      if (!runId || checkedRuns.has(runId)) continue;
      const statusTime = timestamp(status.created_at);
      try {
        const decision = await dispatchDecision({ client, pr, sha, reference, runId, completed: true });
        if (statusTime < decision.time) throw new Error('Status anterior ao despacho');
        decisions.push(decision);
      } catch (error) {
        // A non-dispatch status is never authorization; transport or malformed
        // date failures still fail closed rather than silently using stale data.
        if (/^GitHub |Resposta GitHub inválida|Data da decisão|Datas da execução/.test(error.message)) throw error;
      }
      checkedRuns.add(runId);
    }
  }
  // Re-read after inspecting runs so a concurrent revocation or changed HEAD is
  // observed before publishing a status. Concurrency serializes this PR's jobs.
  const comments = await client.pages(`issues/${pr}/comments`);
  validatePull(await client.get(`pulls/${pr}`), sha);
  return resolveAuthorization({ sha, scope, reference, comments }, decisions);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [pr, sha, scope, reference] = process.argv.slice(2);
  console.log(JSON.stringify(await verifyGitHubAuthorization({
    repository: process.env.GITHUB_REPOSITORY, pr, sha, scope, reference, token: process.env.GH_TOKEN
  })));
}
