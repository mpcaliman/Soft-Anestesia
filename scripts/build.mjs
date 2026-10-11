import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicAssets } from './public-assets.mjs';
import { compileStrictAssets, compiledAssetPaths } from './strict-csp.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, '..');
const distDir = resolve(rootDir, 'dist');

if (distDir !== resolve(rootDir, 'dist')) {
  throw new Error('Diretório de build inesperado; operação interrompida.');
}

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

const assets = {};
const uniqueAssets = new Set(publicAssets);
if (uniqueAssets.size !== publicAssets.length) {
  throw new Error('A allowlist pública contém caminhos duplicados.');
}

const generatedPaths = new Set(compiledAssetPaths.filter(path => path !== 'src/ui/strict-actions.js'));
const sourceBytes = new Map();
for (const relativePath of publicAssets) {
  if (generatedPaths.has(relativePath)) continue;
  sourceBytes.set(relativePath, await readFile(resolve(rootDir, relativePath)));
}
const javascriptSources = new Map([...sourceBytes].filter(([path]) => path.endsWith('.js')).map(([path,bytes]) => [path,bytes.toString('utf8')]));
const compiled = compileStrictAssets(sourceBytes.get('index.html').toString('utf8'), javascriptSources);
for (const relativePath of publicAssets) {
  if (!relativePath || relativePath.startsWith('/') || relativePath.split('/').includes('..')) {
    throw new Error(`Caminho público inválido: ${relativePath}`);
  }
  const destination = resolve(distDir, relativePath);
  if (!destination.startsWith(distDir + sep)) throw new Error(`Caminho público fora do projeto: ${relativePath}`);
  const bytes = compiled.sources.has(relativePath) ? Buffer.from(compiled.sources.get(relativePath),'utf8') : sourceBytes.get(relativePath);
  if (!bytes) throw new Error(`Artefato público sem fonte: ${relativePath}`);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
  assets[relativePath] = createHash('sha256').update(bytes).digest('hex');
}

const packageJson = JSON.parse(await readFile(resolve(rootDir, 'package.json'), 'utf8'));
let sourceCommit = 'unknown';
try {
  sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim();
} catch {}

const buildInfo = {
  schema: 1,
  csp: { policy: compiled.policy, ...compiled.statistics },
  sourceCommit,
  runtime: {
    node: packageJson.engines.node,
    packageManager: packageJson.packageManager
  },
  dependencies: Object.assign({}, packageJson.dependencies || {}, packageJson.devDependencies || {}),
  assets
};

await writeFile(
  resolve(distDir, 'build-info.json'),
  JSON.stringify(buildInfo, null, 2) + '\n',
  'utf8'
);

console.log(`Build público criado em dist/ com ${publicAssets.length} arquivos do app.`);
