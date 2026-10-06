import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, '..');
const manifestPath = resolve(rootDir, 'database/migration-baseline.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const supabaseConfig = await readFile(resolve(rootDir, 'supabase/config.toml'), 'utf8');

async function sqlFilesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sqlFilesUnder(absolute));
    else if (entry.name.endsWith('.sql')) files.push(relative(rootDir, absolute).replaceAll('\\', '/'));
  }
  return files;
}

assert.equal(manifest.status, 'blocked_pending_staging_reconciliation');
assert.equal(manifest.remoteApplyAllowed, false, 'aplicação remota deve permanecer bloqueada na E0');
assert.match(
  supabaseConfig,
  /\[db\.migrations\][\s\S]*?\nenabled = false(?:\n|$)/,
  'migrações da CLI devem permanecer desativadas até autorização G3'
);
assert.match(
  supabaseConfig,
  /\[db\.seed\][\s\S]*?\nenabled = false(?:\n|$)/,
  'seeds da CLI devem permanecer desativados até autorização G3'
);

const actualFiles = [
  ...await sqlFilesUnder(resolve(rootDir, 'database')),
  ...await sqlFilesUnder(resolve(rootDir, 'supabase/migrations'))
].sort();
const recordedFiles = Object.keys(manifest.files).sort();
assert.deepEqual(actualFiles, recordedFiles, 'inventário SQL mudou; revise e autorize a nova baseline');

for (const [path, expectedHash] of Object.entries(manifest.files)) {
  const bytes = await readFile(resolve(rootDir, path));
  const actualHash = createHash('sha256').update(bytes).digest('hex');
  assert.equal(actualHash, expectedHash, `${path} mudou sem atualização autorizada da baseline`);
}

const numberedDatabaseMigrations = recordedFiles
  .filter(path => /^database\/migrations\/\d{4}_.+\.sql$/.test(path))
  .map(path => Number(path.match(/\/(\d{4})_/)[1]));
assert.deepEqual(
  numberedDatabaseMigrations,
  Array.from({ length: 17 }, (_, index) => index + 1),
  'database/migrations deve preservar a sequência histórica 0001–0017'
);

assert.ok(
  recordedFiles.some(path => path.startsWith('supabase/migrations/')),
  'histórico paralelo de supabase/migrations deve permanecer explícito até a reconciliação'
);

console.log('✓ baseline SQL íntegra; aplicação remota continua bloqueada até homologação autorizada');
