import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicAssets } from './public-assets.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, '..');
const distDir = resolve(rootDir, 'dist');
const expected = ['build-info.json', ...publicAssets].sort();

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
assert.deepEqual(Object.keys(buildInfo.assets).sort(), [...publicAssets].sort(),
  'build-info deve registrar exatamente a allowlist pública');
for (const relativePath of publicAssets) {
  const bytes = await readFile(resolve(distDir, relativePath));
  const digest = createHash('sha256').update(bytes).digest('hex');
  assert.equal(buildInfo.assets[relativePath], digest, `hash inválido para ${relativePath}`);
}

const html = await readFile(resolve(distDir, 'index.html'), 'utf8');
assert.match(html, /src="medicamentos-base\.js"/, 'index.html deve carregar a base pública de medicamentos');
assert.match(html, /src="vendor\/jspdf\.umd\.min\.js"/, 'index.html deve carregar o jsPDF versionado');
assert.match(html, /src="src\/domain\/encounter-identity\.js"/, 'index.html deve carregar a identidade de atendimento');
assert.match(html, /src="src\/platform\/session-vault\.js"/, 'index.html deve carregar a plataforma de sessão e fila');
assert.match(html, /src="src\/platform\/clinical-store\.js"/, 'index.html deve carregar o armazenamento clínico');
assert.match(html, /src="src\/platform\/auth\.js"/, 'index.html deve carregar a plataforma de autenticação');
assert.match(html, /src="src\/platform\/cloud-client\.js"/, 'index.html deve carregar o adaptador Supabase');
assert.match(html, /src="src\/platform\/sync-runtime\.js"/, 'index.html deve carregar o runtime de sincronização');
assert.match(html, /src="src\/platform\/relational-persistence\.js"/, 'index.html deve carregar a persistência relacional');
assert.match(html, /src="src\/platform\/cloud-first\.js"/, 'index.html deve carregar a persistência Cloud First');
assert.match(html, /src="src\/platform\/realtime-compat\.js"/, 'index.html deve carregar o Realtime de compatibilidade');
assert.match(html, /src="src\/domain\/encounter-linker\.js"/, 'index.html deve carregar o linker de atendimentos');
assert.match(html, /src="src\/app\/bootstrap\.js"/, 'index.html deve carregar o bootstrap público');
assert.match(html, /src="src\/shared\/soft-qr\.js"/, 'index.html deve carregar o módulo de QR');
assert.match(html, /src="src\/integrations\/signature-digital\.js"/, 'index.html deve carregar o módulo de assinatura');
assert.doesNotMatch(html, /Version 2\.5\.1/, 'dist não deve conter o jsPDF vulnerável embutido');
const bootstrap = await readFile(resolve(distDir, 'src/app/bootstrap.js'), 'utf8');
assert.match(bootstrap, /serviceWorker\.register\('sw\.js'\)/,
  'bootstrap deve registrar o service worker público');

const policy = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/i)?.[1];
assert(policy, 'dist deve declarar CSP antes de carregar o app');
assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/, 'nenhuma diretiva CSP pode liberar código inline ou eval');
assert.match(policy, /object-src &#39;none&#39;/, 'CSP deve bloquear plugins');
assert.doesNotMatch(html, /\s(?:on[a-z]+|style)\s*=/i, 'HTML servido não pode incluir eventos ou estilos inline');
assert.doesNotMatch(html, /<style\b/i, 'folhas principais precisam ser arquivos externos');
for (const match of html.matchAll(/<script\b([^>]*)>/gi)) {
  assert.match(match[1], /\bsrc=/i, 'todo script servido precisa ter origem externa');
}
assert(buildInfo.csp?.actions > 1000, 'build precisa registrar a compilação de todas as ações legadas');
const actions = await readFile(resolve(distDir, 'src/ui/strict-actions.js'), 'utf8');
assert.doesNotMatch(actions, /\beval\s*\(|\b(?:new\s+)?Function\s*\(/,
  'dispatcher não pode compilar dados em JavaScript');

console.log('✓ dist/ contém somente os artefatos públicos esperados e íntegros');
