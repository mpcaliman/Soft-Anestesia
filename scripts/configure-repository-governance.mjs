import { readFile } from 'node:fs/promises';

const repository = 'mpcaliman/Soft-Anestesia';
const desired = JSON.parse(await readFile(new URL('../.github/rulesets/main.json', import.meta.url), 'utf8'));
const apply = process.argv.includes('--apply');
if (!apply && !process.argv.includes('--inspect')) {
  console.log(JSON.stringify({ repository, applied: false, ruleset: desired }, null, 2));
} else if (!process.env.GH_TOKEN) {
  if (apply) throw new Error('GH_TOKEN com administração do repositório é necessário; nenhum ajuste foi aplicado');
  console.log(JSON.stringify({ repository, applied: false, ruleset: desired }, null, 2));
} else {
  async function api(path, method = 'GET', body) {
    const response = await fetch(`https://api.github.com/${path}`, {
      method, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${process.env.GH_TOKEN}`,
        'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    if (!response.ok) throw new Error(`GitHub recusou ${method} ${response.status}; proteção não confirmada`);
    return response.json();
  }
  const [repo, actor, rulesets] = await Promise.all([api(`repos/${repository}`), api('user'), api(`repos/${repository}/rulesets`)]);
  if (!repo.permissions?.admin || actor.login !== 'mpcaliman') throw new Error('A alteração exige a identidade administrativa do proprietário');
  const existing = rulesets.find(item => item.name === desired.name);
  if (!apply) console.log(JSON.stringify({ repository, applied: false, current: existing || null, ruleset: desired }, null, 2));
  else {
    await api(`repos/${repository}/rulesets${existing ? '/' + existing.id : ''}`, existing ? 'PUT' : 'POST', desired);
    const verified = await api(`repos/${repository}/rulesets?includes_parents=false`);
    const active = verified.find(item => item.name === desired.name && item.enforcement === 'active');
    if (!active) throw new Error('GitHub não confirmou o ruleset ativo');
    console.log(JSON.stringify({ repository, applied: true, id: active.id, url: active._links?.html?.href }));
  }
}
