import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, '..');
const distDir = resolve(rootDir, 'dist');
const expected = ['build-info.json', 'index.html', 'medicamentos-base.js', 'sw.js'];

async function filesUnder(dir, prefix = '') {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await filesUnder(resolve(dir, entry.name), relative));
    else files.push(relative);
  }
  return files.sort();
}

const actual = await filesUnder(distDir);
assert.deepEqual(actual, expected, 'dist/ deve conter somente o allowlist público');

const buildInfo = JSON.parse(await readFile(resolve(distDir, 'build-info.json'), 'utf8'));
for (const relativePath of expected.filter(file => file !== 'build-info.json')) {
  const bytes = await readFile(resolve(distDir, relativePath));
  const digest = createHash('sha256').update(bytes).digest('hex');
  assert.equal(buildInfo.assets[relativePath], digest, `hash inválido para ${relativePath}`);
}

const html = await readFile(resolve(distDir, 'index.html'), 'utf8');
assert.match(html, /src="medicamentos-base\.js"/, 'index.html deve carregar a base pública de medicamentos');
assert.match(html, /serviceWorker\.register\('sw\.js'\)/, 'index.html deve registrar o service worker público');

console.log('✓ dist/ contém somente os artefatos públicos esperados e íntegros');
