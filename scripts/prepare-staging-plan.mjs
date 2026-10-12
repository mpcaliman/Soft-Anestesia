import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Produção não é um alvo deste programa. O plano não executa SQL nem contém chaves.
export const stagingProject = 'yqqrfgbvoexricjdxpis';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = text => createHash('sha256').update(text).digest('hex');
const manifest = JSON.parse(await readFile(resolve(root, 'database/migration-baseline.json'), 'utf8'));
const paths = (await readdir(resolve(root, 'database/migrations')))
  .filter(path => /^\d{4}_.+\.sql$/.test(path)).sort().map(path => `database/migrations/${path}`);
paths.push('supabase/migrations/0002_assinaturas_hardening.sql');

const migrations = [];
for (const [index, path] of paths.entries()) {
  const source = await readFile(resolve(root, path), 'utf8');
  assert.equal(digest(source), manifest.files[path], `SHA não revisado: ${path}`);
  // Uma base vazia não exige CONCURRENTLY. A derivação é identificada no plano,
  // sem editar o SQL histórico ou fingir que ela serve para aplicar em produção.
  const emptyStagingIndexBuild = path.includes('/0026_');
  const query = emptyStagingIndexBuild
    ? source.replaceAll('create index concurrently if not exists', 'create index if not exists')
    : source;
  migrations.push({
    ordinal: index + 1,
    source: path,
    migrationName: `staging_rebuild_${path.split('/').at(-1).replace('.sql', '')}`,
    sourceSha256: digest(source),
    appliedSha256: digest(query),
    transformation: emptyStagingIndexBuild ? 'nonconcurrent_indexes_on_verified_empty_staging_only' : null,
    query
  });
}

const plan = {
  format: 1,
  targetProject: stagingProject,
  parentProductionProject: 'zbpbrnalamjrcfbscjkt',
  productionApplyAllowed: false,
  clinicalDataDeletionAllowed: false,
  routinePolicyReplacementAllowed: true,
  preconditions: ['branch audit-remediation-v2, with_data=false', 'public.assinaturas empty',
    'app schema absent before first migration', 'auth.users empty before fixture provisioning'],
  preconditionEvidence: {
    branchIdentity: 'connector list_branches verified',
    productionDataCopied: false,
    signatureRows: 'connector list_tables verified zero',
    applicationSchema: 'root information_schema verified absent before attempted apply',
    authUsers: 'not independently verified; fixture provisioning blocked until verified'
  },
  preservedMigrationHistory: '0001_assinaturas',
  excluded: ['RODAR_AGORA_*', 'database/apply_all.sql', 'seeds', 'production records'],
  migrationCount: migrations.length,
  sourceSetSha256: digest(migrations.map(m => `${m.source}\t${m.sourceSha256}\n`).join('')),
  migrations
};
const output = process.argv[2];
assert.ok(output, 'Informe um arquivo de saída fora do pacote público; nenhum SQL é executado.');
await writeFile(resolve(output), JSON.stringify(plan, null, 2) + '\n');
console.log(JSON.stringify({ targetProject: stagingProject, migrationCount: migrations.length,
  sourceSetSha256: plan.sourceSetSha256, output: resolve(output), executed: false }));
