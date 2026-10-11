import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareGovernanceBootstrapV2 } from '../scripts/prepare-governance-bootstrap-v2.mjs';

const root = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(join(tmpdir(), 'soft-bootstrap-v2-security-'));
const sourceRoot = join(temporary, 'sources');
const sourcePaths = ['.github/workflows/owner-approval.yml', 'scripts/verify-owner-authorization.mjs', '.github/rulesets/main.json'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const blob = bytes => createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
try {
  for (const path of sourcePaths) {
    await mkdir(dirname(join(sourceRoot, path)), { recursive: true });
    await writeFile(join(sourceRoot, path), await readFile(join(root, path)));
  }
  const frozen = await readFile(join(root, 'scripts/prepare-governance-bootstrap.mjs'));
  assert.equal(sha256(frozen), 'f41ef92a19ef248b761f2451d471ce68c6e97ca6c35deafa9efddaca97703908');
  const output = join(temporary, 'bundle');
  const prepared = await prepareGovernanceBootstrapV2({ output, sourceRoot });
  assert.equal(prepared.applied, false);
  assert.equal(prepared.newTreeSha, 'c2e00f10187ff6682bb9ab576912f0f66d12af8a');
  const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
  const patch = await readFile(join(output, 'bootstrap.patch'));
  assert.equal(sha256(patch), manifest.patchSha256);
  assert.equal(manifest.newCommitSha, null);
  assert.equal(manifest.externalMutations, false);
  assert.equal(manifest.sourceWorkingTree.observedCheckoutSha, null);
  assert.equal(manifest.sourceWorkingTree.checkoutCommitContainsAllReviewedBytes, null);
  assert.deepEqual(manifest.scope, ['.github/workflows/owner-approval.yml', '.github/workflows/pages.yml', 'scripts/verify-owner-authorization.mjs']);
  assert.equal((patch.toString().match(/^diff --git /gm) || []).length, 3);
  assert.equal(manifest.remoteBlockers.mainMergeAllowed, false);
  assert.equal(manifest.remoteBlockers.pagesSource.buildType, 'legacy');
  for (const file of manifest.files) {
    const bytes = await readFile(join(output, 'files', file.path));
    assert.equal(blob(bytes), file.newBlobSha);
    assert.equal(sha256(bytes), file.sha256);
  }
  for (const file of manifest.adminFiles) assert.equal(sha256(await readFile(join(output, file.path))), file.sha256);
  for (const path of sourcePaths.slice(0, 2)) assert.deepEqual(await readFile(join(output, 'files', path)), await readFile(join(sourceRoot, path)));
  const stub = await readFile(join(output, 'files/.github/workflows/pages.yml'), 'utf8');
  assert.match(stub, /permissions: \{\}/);
  assert.match(stub, /exit 1/);
  assert.doesNotMatch(stub, /\b(?:push|checkout|deploy-pages|upload-pages-artifact|configure-pages):?\b/);
  const workflow = await readFile(join(output, 'files/.github/workflows/owner-approval.yml'), 'utf8');
  assert.match(workflow, /node-version: '24\.19\.0'/);
  assert.doesNotMatch(workflow, /node-version-file:/);
  assert.match(workflow, /workflow_dispatch:/);
  const bootstrap = JSON.parse(await readFile(join(output, 'temporary-main-ruleset.json'), 'utf8'));
  assert.equal(bootstrap.rules.find(rule => rule.type === 'pull_request').parameters.required_approving_review_count, 0);
  assert.equal(bootstrap.rules.find(rule => rule.type === 'pull_request').parameters.require_last_push_approval, false);
  assert.deepEqual(bootstrap.rules.find(rule => rule.type === 'required_status_checks').parameters.required_status_checks, [{ context: 'smoke', integration_id: 15368 }]);

  // Reconstruct the full-file unified patch in a disposable directory. The
  // standard git apply check is performed separately, since this executor can
  // refuse spawning Git apply from Node even for a non-repository /tmp folder.
  const discard = join(temporary, 'apply');
  await mkdir(join(discard, '.github/workflows'), { recursive: true });
  await mkdir(join(discard, 'scripts'), { recursive: true });
  const oldPagesLiteral = frozen.toString().split('const reviewedBasePages = ', 2)[1].split(';\nconst repoRoot', 1)[0];
  await writeFile(join(discard, '.github/workflows/pages.yml'), JSON.parse(oldPagesLiteral));
  for (const section of patch.toString().split('diff --git ').slice(1)) {
    const path = section.split('\n', 1)[0].split(' b/')[1];
    assert.ok(manifest.scope.includes(path));
    const lines = section.split(/@@ -[^\n]+ @@\n/, 2)[1].split('\n');
    assert.equal(lines.pop(), '');
    assert.ok(lines.every(line => line.startsWith('-') || line.startsWith('+')));
    const before = lines.filter(line => line.startsWith('-')).map(line => line.slice(1)).join('\n');
    const after = lines.filter(line => line.startsWith('+')).map(line => line.slice(1)).join('\n');
    if (before) assert.equal(await readFile(join(discard, path), 'utf8'), before + '\n');
    else await assert.rejects(access(join(discard, path)), /ENOENT/);
    await writeFile(join(discard, path), after + '\n');
  }
  for (const path of manifest.scope) assert.deepEqual(await readFile(join(discard, path)), await readFile(join(output, 'files', path)));

  await assert.rejects(prepareGovernanceBootstrapV2({ output, sourceRoot }), /EEXIST/);
  assert.equal(sha256(await readFile(join(output, 'bootstrap.patch'))), manifest.patchSha256);
  await assert.rejects(prepareGovernanceBootstrapV2({ output: 'relative', sourceRoot }), /absolute/);
  await assert.rejects(prepareGovernanceBootstrapV2({ output: join(root, 'forbidden-v2-output'), sourceRoot }), /outside/);
  const link = join(temporary, 'repo-link');
  await symlink(root, link);
  await assert.rejects(prepareGovernanceBootstrapV2({ output: join(link, 'forbidden-v2-output'), sourceRoot }), /outside/);
  for (const path of sourcePaths) {
    const original = await readFile(join(sourceRoot, path));
    await writeFile(join(sourceRoot, path), Buffer.concat([original, Buffer.from('\n// unreviewed\n')]));
    const rejectedOutput = join(temporary, 'rejected-' + sourcePaths.indexOf(path));
    await assert.rejects(prepareGovernanceBootstrapV2({ output: rejectedOutput, sourceRoot }), /Unreviewed source/);
    await assert.rejects(access(rejectedOutput), /ENOENT/);
    await writeFile(join(sourceRoot, path), original);
  }
  assert.equal(sha256(await readFile(join(root, 'scripts/prepare-governance-bootstrap.mjs'))), sha256(frozen));
  console.log('  ✓ bootstrap v2 pins reviewed bytes, exact three-file patch/tree, standalone dispatch and pending containment; no overwrite or repository writes');
} finally { await rm(temporary, { recursive: true, force: true }); }
