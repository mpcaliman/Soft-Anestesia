import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicAssets } from './public-assets.mjs';

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

for (const relativePath of publicAssets) {
  if (!relativePath || relativePath.startsWith('/') || relativePath.split('/').includes('..')) {
    throw new Error(`Caminho público inválido: ${relativePath}`);
  }
  const source = resolve(rootDir, relativePath);
  const destination = resolve(distDir, relativePath);
  if (!source.startsWith(rootDir + sep) || !destination.startsWith(distDir + sep)) {
    throw new Error(`Caminho público fora do projeto: ${relativePath}`);
  }
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  const bytes = await readFile(source);
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
