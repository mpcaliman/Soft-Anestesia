import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, '..');
const distDir = resolve(rootDir, 'dist');
const publicFiles = ['index.html', 'medicamentos-base.js', 'sw.js'];

if (distDir !== resolve(rootDir, 'dist')) {
  throw new Error('Diretório de build inesperado; operação interrompida.');
}

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

const assets = {};
for (const relativePath of publicFiles) {
  const source = resolve(rootDir, relativePath);
  const destination = resolve(distDir, relativePath);
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
  dependencies: packageJson.devDependencies,
  assets
};

await writeFile(
  resolve(distDir, 'build-info.json'),
  JSON.stringify(buildInfo, null, 2) + '\n',
  'utf8'
);

console.log(`Build público criado em dist/ com ${publicFiles.length} arquivos do app.`);
