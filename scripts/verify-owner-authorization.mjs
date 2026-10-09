import { pathToFileURL } from 'node:url';

export const OWNER = 'mpcaliman';
const GATES = { merge: 'G4', deploy: 'G5', migration: 'G3' };

// A referência em um arquivo/PR não é autorização. A evidência deve vir da
// identidade autenticada do proprietário no GitHub e nomear o SHA completo.
export function authorizationFor({ sha, scope, reference, comments = [], reviews = [] }) {
  if (!/^[0-9a-f]{40}$/.test(sha || '') || !GATES[scope]) throw new Error('SHA/escopo inválido');
  const gate = GATES[scope];
  if (!new RegExp(`^${gate}-[A-Za-z0-9._/-]+$`).test(reference || '')) throw new Error('Referência inválida');
  const token = `SOFT-AUTORIZACAO ${reference} ${sha} ${scope}`;
  const revoke = `SOFT-REVOGACAO ${reference} ${sha} ${scope}`;
  const decisions = comments.filter(c => c.user?.login === OWNER && !c.user?.type?.includes('Bot'))
    .map(c => ({ line: String(c.body || '').trim(), date: c.updated_at || c.created_at, url: c.html_url }))
    .filter(c => c.line === token || c.line === revoke);
  decisions.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const last = decisions.at(-1);
  if (!last || last.line !== token) throw new Error(`Falta autorização ${reference} de ${OWNER} para ${scope} no SHA ${sha}`);
  return { owner: OWNER, sha, scope, reference, evidence: last.url, authorizedAt: last.date };
}

export async function verifyGitHubAuthorization({ repository, pr, sha, scope, reference, token }) {
  if (repository !== 'mpcaliman/Soft-Anestesia' || !/^\d+$/.test(String(pr))) throw new Error('Repositório/PR inválido');
  if (!token) throw new Error('Token GitHub ausente');
  async function get(path) {
    const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' }
    });
    if (!response.ok) throw new Error(`GitHub recusou leitura ${response.status}`);
    return response.json();
  }
  async function pages(path) {
    const rows = [];
    for (let page = 1; ; page++) {
      const batch = await get(`${path}?per_page=100&page=${page}`);
      if (!Array.isArray(batch)) throw new Error('Resposta GitHub inválida');
      rows.push(...batch);
      if (batch.length < 100) return rows;
    }
  }
  const pull = await get(`pulls/${pr}`);
  if (pull.base?.ref !== 'main' || pull.head?.sha !== sha || pull.head?.repo?.full_name !== repository)
    throw new Error('A autorização deve corresponder ao HEAD atual do PR para main');
  const comments = await pages(`issues/${pr}/comments`);
  return authorizationFor({ sha, scope, reference, comments });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [pr, sha, scope, reference] = process.argv.slice(2);
  const result = await verifyGitHubAuthorization({
    repository: process.env.GITHUB_REPOSITORY, pr, sha, scope, reference, token: process.env.GH_TOKEN
  });
  console.log(JSON.stringify(result));
}
