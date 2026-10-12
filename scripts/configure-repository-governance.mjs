import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const repository = 'mpcaliman/Soft-Anestesia';
const fullRuleset = JSON.parse(await readFile(new URL('../.github/rulesets/main.json', import.meta.url), 'utf8'));
const actionsIntegration = 15368;

export function desiredGovernance(mode = 'full') {
  if (!['bootstrap', 'full'].includes(mode)) throw new Error('Modo deve ser bootstrap ou full');
  const desired = structuredClone(fullRuleset);
  if (mode === 'bootstrap') desired.rules.find(rule => rule.type === 'required_status_checks')
    .parameters.required_status_checks = [{ context: 'smoke', integration_id: actionsIntegration }];
  return desired;
}

function containsDesired(actual, desired) {
  if (Array.isArray(desired)) return Array.isArray(actual) && actual.length === desired.length &&
    desired.every((item, index) => containsDesired(actual[index], item));
  if (desired && typeof desired === 'object') return actual && typeof actual === 'object' &&
    Object.entries(desired).every(([key, value]) => containsDesired(actual[key], value));
  return actual === desired;
}

export function verifyGovernance(actual, desired) {
  const normalize = ruleset => ({ ...ruleset, rules: (ruleset.rules || []).map(rule => ({ ...rule,
    ...(rule.type === 'required_status_checks' ? { parameters: { ...rule.parameters,
      required_status_checks: [...(rule.parameters?.required_status_checks || [])].sort((a, b) => a.context.localeCompare(b.context)) } } : {})
  })).sort((a, b) => a.type.localeCompare(b.type)) });
  if (!containsDesired(normalize(actual), normalize(desired))) throw new Error('GitHub não confirmou todas as regras, condições e ausência de bypass');
}

export async function configureGovernance({ mode = 'full', apply = false, inspect = false, token, pr, expectedMain, fetchImpl = fetch } = {}) {
  const desired = desiredGovernance(mode);
  if (!apply && !inspect) return { repository, mode, applied: false, ruleset: desired };
  if (!token) throw new Error('GH_TOKEN com acesso ao repositório é necessário; nenhum ajuste foi aplicado');
  if (apply && !/^[1-9]\d*$/.test(String(pr || ''))) throw new Error('--apply exige --pr para comprovar os checks do HEAD real');
  if (expectedMain && !/^[0-9a-f]{40}$/.test(expectedMain)) throw new Error('--expected-main exige SHA completo');
  async function api(path, method = 'GET', body) {
    let response;
    try {
      response = await fetchImpl(`https://api.github.com/repos/${repository}${path ? '/' + path : ''}`, {
        method, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
        signal: AbortSignal.timeout(15000),
        ...(body ? { body: JSON.stringify(body) } : {})
      });
    } catch { throw new Error('GitHub indisponível; proteção não confirmada'); }
    if (!response.ok) throw new Error(`GitHub recusou ${method} ${response.status}; proteção não confirmada`);
    if (response.status === 204) return null;
    try { return await response.json(); } catch { throw new Error('GitHub retornou JSON inválido; proteção não confirmada'); }
  }
  // Repository-scoped capability check; no profile endpoint and no claim that
  // an administrative credential belongs to the owner. Actions checks actor.
  const repo = await api('');
  if (repo.full_name !== repository || repo.owner?.login !== 'mpcaliman' || repo.default_branch !== 'main' || repo.permissions?.admin !== true) {
    throw new Error('A configuração exige administração confirmada no repositório alvo');
  }
  const main = await api('branches/main');
  if (!/^[0-9a-f]{40}$/.test(main.commit?.sha || '') || (expectedMain && main.commit.sha !== expectedMain)) {
    throw new Error('main mudou ou não pôde ser confirmada; nenhum ajuste foi aplicado');
  }
  const rulesets = [];
  for (let page = 1; ; page++) {
    const batch = await api(`rulesets?includes_parents=false&per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error('Lista de rulesets inválida');
    rulesets.push(...batch);
    if (batch.length < 100) break;
  }
  const matches = rulesets.filter(item => item.name === desired.name);
  if (matches.length > 1) throw new Error('Rulesets homônimos tornam a atualização ambígua');
  const existing = matches[0] ? await api(`rulesets/${matches[0].id}`) : null;
  if (!apply) return { repository, mode, applied: false, main: main.commit.sha, current: existing, ruleset: desired };
  const pull = await api(`pulls/${pr}`);
  if (pull.state !== 'open' || pull.base?.ref !== 'main' || pull.base?.repo?.full_name !== repository ||
      pull.head?.repo?.full_name !== repository || !/^[0-9a-f]{40}$/.test(pull.head?.sha || '')) {
    throw new Error('PR de verificação não corresponde ao repositório e main');
  }
  const sha = pull.head.sha;
  const checks = [];
  for (let page = 1; ; page++) {
    const result = await api(`commits/${sha}/check-runs?per_page=100&page=${page}`);
    if (!Array.isArray(result.check_runs)) throw new Error('Resposta de checks inválida');
    checks.push(...result.check_runs);
    if (result.check_runs.length < 100) break;
  }
  const statuses = [];
  for (let page = 1; ; page++) {
    const result = await api(`commits/${sha}/statuses?per_page=100&page=${page}`);
    if (!Array.isArray(result)) throw new Error('Resposta de status inválida');
    statuses.push(...result);
    if (result.length < 100) break;
  }
  for (const check of desired.rules.find(rule => rule.type === 'required_status_checks').parameters.required_status_checks) {
    const observed = checks.some(item => item.name === check.context && item.app?.id === actionsIntegration && item.head_sha === sha) ||
      statuses.some(item => item.context === check.context && item.creator?.id === 41898282 &&
        item.creator?.login === 'github-actions[bot]' && item.creator?.type === 'Bot' &&
        item.url === `https://api.github.com/repos/${repository}/statuses/${sha}`);
    if (!observed) throw new Error(`Check ${check.context} ainda não foi observado no HEAD; ruleset não aplicado`);
  }
  // Revalidate targets immediately before the only write.
  const freshMain = await api('branches/main');
  const freshPull = await api(`pulls/${pr}`);
  if (freshMain.commit?.sha !== main.commit.sha || freshPull.head?.sha !== sha || freshPull.state !== 'open') {
    throw new Error('Alvo mudou durante a inspeção; ruleset não aplicado');
  }
  const result = await api(`rulesets${existing ? '/' + existing.id : ''}`, existing ? 'PUT' : 'POST', desired);
  const id = existing?.id || result?.id;
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('GitHub não confirmou o ID do ruleset');
  const verified = await api(`rulesets/${id}`);
  verifyGovernance(verified, desired);
  return { repository, mode, applied: true, id, verifiedHead: sha, url: verified._links?.html?.href };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const options = { mode: 'full', token: process.env.GH_TOKEN };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (seen.has(argument)) throw new Error('Argumento repetido');
    seen.add(argument);
    if (argument === '--apply' || argument === '--inspect') options[argument.slice(2)] = true;
    else if (['--mode', '--pr', '--expected-main'].includes(argument) && args[index + 1] && !args[index + 1].startsWith('--')) {
      options[{ '--mode': 'mode', '--pr': 'pr', '--expected-main': 'expectedMain' }[argument]] = args[++index];
    } else throw new Error('Uso: node scripts/configure-repository-governance.mjs [--inspect|--apply] [--mode bootstrap|full] [--pr NUMERO] [--expected-main SHA]');
  }
  if (options.apply && options.inspect) throw new Error('Escolha --inspect ou --apply');
  console.log(JSON.stringify(await configureGovernance(options), null, 2));
}
