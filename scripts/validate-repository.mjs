import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, '..');
const read = path => readFile(resolve(rootDir, path), 'utf8');

const [pkgText, lockText, nvm, nodeVersion, ci, pages, gitignore] = await Promise.all([
  read('package.json'),
  read('package-lock.json'),
  read('.nvmrc'),
  read('.node-version'),
  read('.github/workflows/ci.yml'),
  read('.github/workflows/pages.yml'),
  read('.gitignore')
]);

const pkg = JSON.parse(pkgText);
const lock = JSON.parse(lockText);
const pinnedNode = nvm.trim();

assert.equal(nodeVersion.trim(), pinnedNode, '.nvmrc e .node-version devem coincidir');
assert.equal(pkg.engines.node, pinnedNode, 'package.json deve fixar a mesma versão do Node');
assert.equal(process.version, `v${pinnedNode}`, `execute com Node ${pinnedNode}`);
assert.equal(pkg.packageManager, `npm@${pkg.engines.npm}`, 'npm deve estar fixado em packageManager');
if (process.env.npm_config_user_agent) {
  assert.match(
    process.env.npm_config_user_agent,
    new RegExp(`^npm/${pkg.engines.npm.replaceAll('.', '\\.')}(?:\\s|$)`),
    `execute os scripts com npm ${pkg.engines.npm}`
  );
}
assert.equal(lock.lockfileVersion, 3, 'package-lock deve usar lockfileVersion 3');
assert.equal(lock.packages[''].devDependencies.playwright, pkg.devDependencies.playwright);
assert.equal(lock.packages[''].devDependencies.supabase, pkg.devDependencies.supabase);

for (const [name, version] of Object.entries(pkg.devDependencies)) {
  assert.match(version, /^\d+\.\d+\.\d+$/, `${name} deve usar versão exata`);
}

assert.match(ci, /\bnpm ci\b/, 'CI deve instalar pelo lockfile com npm ci');
assert.doesNotMatch(ci, /\bnpm install\b/, 'CI não pode usar npm install');
assert.match(ci, /npm run test:ci/, 'CI deve executar a cadeia completa de validação');
assert.match(pages, /path:\s*dist\b/, 'Pages deve publicar somente dist/');
assert.doesNotMatch(pages, /path:\s*['"]?\.['"]?\s*$/m, 'Pages nunca pode publicar a raiz');
assert.match(pages, /workflow_dispatch:/, 'deploy deve exigir acionamento manual autorizado');
assert.match(pages, /authorization:/, 'deploy deve registrar uma referência G5');
assert.match(pages, /actions\/workflows\/ci\.yml\/runs/, 'deploy deve confirmar a CI do mesmo commit');
assert.doesNotMatch(pages, /^\s{2}(?:push|workflow_run):/m, 'deploy não pode ser automático');
assert.doesNotMatch(gitignore, /^package-lock\.json$/m, 'package-lock.json precisa ser versionado');

const actionRefs = [...ci.matchAll(/uses:\s*[^@\s]+@([^\s#]+)/g), ...pages.matchAll(/uses:\s*[^@\s]+@([^\s#]+)/g)];
assert.ok(actionRefs.length >= 6, 'ações essenciais do GitHub não encontradas');
for (const [, ref] of actionRefs) {
  assert.match(ref, /^[a-f0-9]{40}$/, `GitHub Action deve usar SHA imutável, recebeu ${ref}`);
}

console.log('✓ versões, lockfile, CI e publicação reproduzível validados');
