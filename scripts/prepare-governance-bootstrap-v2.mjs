import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Offline preparation only. No credentials, fetch, Git writes, commit, branch
// changes, remote mutation, SQL execution or publication. V1 stays frozen.
const repository = 'mpcaliman/Soft-Anestesia';
const baseSha = '634f9e2ccfe86ec0174b845526b0f9f70159db34';
const baseTree = '4f884ee5159b6829650d326bb8127fd8df85e944';
const expectedNewTree = 'c2e00f10187ff6682bb9ab576912f0f66d12af8a';
const reviewedCheckoutSha = 'fff59e2eb42f481f8a2f03803b94ed5bff49cfef';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reviewedSources = [
  { path: '.github/workflows/owner-approval.yml', blobSha: '3fd9b8e609fda81e7f85422641d8c2e92c02a38a',
    sha256: '565eebc36d6c93be6a763a745350b9e00426a621b70049e2f65ecf62eb9424fb' },
  { path: 'scripts/verify-owner-authorization.mjs', blobSha: 'cf112ff26af5f4e40b038c1eb2ee4d4f6bcdb085',
    sha256: 'bbaa92dc4fda0867678e097f5e9a8ed98b917e9d066a7c482e6bd2c33ae33a8a' },
  { path: '.github/rulesets/main.json', blobSha: 'a8ef2cbd3fb23443b5d8f2b4512d7e0185aa06aa',
    sha256: '8b51d736ea7a347ac6e2cd5a1f4b5aee5c6da7da99d901b802277a8f6d19a410' }
];
// Native read-only GitHub tree/Pages evidence pinned at the exact base,
// queried 2026-10-10 00:35 UTC. Only names/modes/hashes and Pages were read.
const reviewedBaseMetadata = {
  "base": {
    "sha": "4f884ee5159b6829650d326bb8127fd8df85e944",
    "tree": [
      {
        "path": ".github",
        "mode": "040000",
        "type": "tree",
        "sha": "ab9fa0180246d602b4593b9c1665049c3e579015"
      },
      {
        "path": ".gitignore",
        "mode": "100644",
        "type": "blob",
        "sha": "95a99259091cbc8a82187c4247f905500a17c558"
      },
      {
        "path": "database",
        "mode": "040000",
        "type": "tree",
        "sha": "207bc98127266d62ac106c2f7694d5a373b5897f"
      },
      {
        "path": "index.html",
        "mode": "100644",
        "type": "blob",
        "sha": "49d557eea3ea0affefcd3bd97202cd86514ff131"
      },
      {
        "path": "medicamentos-base.js",
        "mode": "100644",
        "type": "blob",
        "sha": "9fd97fc72ee37e47b76c8263c67cede8fca12571"
      },
      {
        "path": "package.json",
        "mode": "100644",
        "type": "blob",
        "sha": "4762b8b1b3cdcfc8fcc9760285033ec120dfa73f"
      },
      {
        "path": "scripts",
        "mode": "040000",
        "type": "tree",
        "sha": "29e5bc4631f389689f10022b7a61d41a73f5db5b"
      },
      {
        "path": "supabase",
        "mode": "040000",
        "type": "tree",
        "sha": "d445fb02611857cd8721f6746568d239f84d2edc"
      },
      {
        "path": "sw.js",
        "mode": "100644",
        "type": "blob",
        "sha": "1dbd289d61a710b24a7bf7b0f3cb8d1ec8a654f3"
      },
      {
        "path": "tests",
        "mode": "040000",
        "type": "tree",
        "sha": "cc2d395269831ac603c22ee02a615199978b72f9"
      }
    ],
    "url": "https://api.github.com/repos/mpcaliman/Soft-Anestesia/git/trees/4f884ee5159b6829650d326bb8127fd8df85e944"
  },
  "github": {
    "sha": "ab9fa0180246d602b4593b9c1665049c3e579015",
    "tree": [
      {
        "path": "workflows",
        "mode": "040000",
        "type": "tree",
        "sha": "837aa65e2e32e10340399f93ad11da9a94025ba5"
      }
    ],
    "url": "https://api.github.com/repos/mpcaliman/Soft-Anestesia/git/trees/ab9fa0180246d602b4593b9c1665049c3e579015"
  },
  "scripts": {
    "sha": "29e5bc4631f389689f10022b7a61d41a73f5db5b",
    "tree": [
      {
        "path": "anvisa",
        "mode": "040000",
        "type": "tree",
        "sha": "52a39c7417d53bf4f6ae0b867fd1e86e84e0c6a7"
      },
      {
        "path": "gerar-base-medicamentos.mjs",
        "mode": "100644",
        "type": "blob",
        "sha": "3a6e5307e21d997dd76d46692b78fc495dca5914"
      },
      {
        "path": "gerar-sql-partes.mjs",
        "mode": "100644",
        "type": "blob",
        "sha": "40289d37c359ca2714a2e1da07820e8aaca11818"
      },
      {
        "path": "gerar-sql-unico.mjs",
        "mode": "100644",
        "type": "blob",
        "sha": "3349c44c78c637007495e578025f9a45fbc61db9"
      },
      {
        "path": "import-anvisa-medications.mjs",
        "mode": "100644",
        "type": "blob",
        "sha": "7fdc02fca7d2c207965363e3745f052b850eec41"
      }
    ],
    "url": "https://api.github.com/repos/mpcaliman/Soft-Anestesia/git/trees/29e5bc4631f389689f10022b7a61d41a73f5db5b"
  },
  "workflows": {
    "sha": "837aa65e2e32e10340399f93ad11da9a94025ba5",
    "tree": [
      {
        "path": "ci.yml",
        "mode": "100644",
        "type": "blob",
        "sha": "6195e5f256e5203f2e97ad3760f3ac800d6f5156"
      },
      {
        "path": "pages.yml",
        "mode": "100644",
        "type": "blob",
        "sha": "c1feb9acf2bb6f9391cadc384d977a341c22bc4e"
      }
    ],
    "url": "https://api.github.com/repos/mpcaliman/Soft-Anestesia/git/trees/837aa65e2e32e10340399f93ad11da9a94025ba5"
  }
};
const reviewedBasePages = "name: Publicar no GitHub Pages\n\n# Publica o app de anestesia (raiz do repositório) no GitHub Pages.\n\non:\n  push:\n    branches: [ main ]\n  workflow_dispatch:\n\npermissions:\n  contents: read\n  pages: write\n  id-token: write\n\nconcurrency:\n  group: pages\n  cancel-in-progress: true\n\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/configure-pages@v5\n        with:\n          enablement: true\n      - uses: actions/upload-pages-artifact@v3\n        with:\n          path: '.'\n  deploy:\n    needs: build\n    runs-on: ubuntu-latest\n    environment:\n      name: github-pages\n      url: ${{ steps.deployment.outputs.page_url }}\n    steps:\n      - id: deployment\n        uses: actions/deploy-pages@v4\n";
const blockedPages = `name: GitHub Pages — bloqueado para bootstrap

# Não publica nem executa código do repositório. Substituir somente depois de
# integrar e validar o workflow completo, a CI e a homologação autenticada.
on:
  workflow_dispatch:

permissions: {}

jobs:
  publication-blocked:
    name: Publicação bloqueada durante bootstrap
    runs-on: ubuntu-latest
    steps:
      - name: Impedir publicação antes dos portões completos
        run: |
          echo "Publicação bloqueada: concluir governança, integração e homologação antes de substituir este stub."
          exit 1
`;

function digest(kind, content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  return createHash('sha1').update(Buffer.from(`${kind} ${bytes.length}\0`)).update(bytes).digest('hex');
}
function blobSha(content) { return digest('blob', content); }
function sha256(content) { return createHash('sha256').update(content).digest('hex'); }
function treeSha(entries) {
  if (!Array.isArray(entries) || new Set(entries.map(entry => entry.path)).size !== entries.length) throw new Error('Duplicate or invalid tree entries');
  for (const entry of entries) {
    if (!entry.path || /[\/\0]/.test(entry.path) || !/^[0-9a-f]{40}$/.test(entry.sha) ||
        !['tree', 'blob'].includes(entry.type) ||
        (entry.type === 'tree' ? entry.mode !== '040000' : !['100644', '100755', '120000'].includes(entry.mode))) {
      throw new Error('Invalid pinned tree entry');
    }
  }
  const sorted = [...entries].sort((a, b) => Buffer.compare(
    Buffer.from(a.path + (a.type === 'tree' ? '/' : '')),
    Buffer.from(b.path + (b.type === 'tree' ? '/' : ''))));
  return digest('tree', Buffer.concat(sorted.map(entry => Buffer.concat([
    Buffer.from(`${entry.mode.replace(/^0+/, '')} ${entry.path}\0`), Buffer.from(entry.sha, 'hex')
  ]))));
}
function requireEntry(entries, path, sha) {
  if (entries.find(entry => entry.path === path)?.sha !== sha) throw new Error('Pinned parent/child tree link differs');
}
function verifyBase() {
  for (const evidence of Object.values(reviewedBaseMetadata)) {
    if (treeSha(evidence.tree) !== evidence.sha) throw new Error('Pinned base metadata does not reproduce its Git tree');
  }
  if (reviewedBaseMetadata.base.sha !== baseTree) throw new Error('Pinned root differs from expected base tree');
  requireEntry(reviewedBaseMetadata.base.tree, '.github', reviewedBaseMetadata.github.sha);
  requireEntry(reviewedBaseMetadata.base.tree, 'scripts', reviewedBaseMetadata.scripts.sha);
  requireEntry(reviewedBaseMetadata.github.tree, 'workflows', reviewedBaseMetadata.workflows.sha);
  requireEntry(reviewedBaseMetadata.workflows.tree, 'pages.yml', blobSha(reviewedBasePages));
  if (blobSha(reviewedBasePages) !== 'c1feb9acf2bb6f9391cadc384d977a341c22bc4e' ||
      blobSha(blockedPages) !== '5069f170b5afca5a2f7ce741d07af284af3be010') throw new Error('Pages bytes differ from reviewed blobs');
  if (reviewedBaseMetadata.workflows.tree.some(entry => entry.path === 'owner-approval.yml') ||
      reviewedBaseMetadata.scripts.tree.some(entry => entry.path === 'verify-owner-authorization.mjs')) {
    throw new Error('Bootstrap additions already exist in pinned base');
  }
}
function wholeFilePatch(file) {
  const oldLines = file.old ? file.old.slice(0, -1).split('\n') : [];
  const newLines = file.next.slice(0, -1).split('\n');
  const metadata = file.operation === 'add'
    ? `new file mode 100644\nindex ${'0'.repeat(40)}..${blobSha(file.next)}\n--- /dev/null\n`
    : `index ${blobSha(file.old)}..${blobSha(file.next)} 100644\n--- a/${file.path}\n`;
  return `diff --git a/${file.path} b/${file.path}\n${metadata}+++ b/${file.path}\n@@ -${oldLines.length ? '1,' + oldLines.length : '0,0'} +1,${newLines.length} @@\n` +
    oldLines.map(line => `-${line}\n`).join('') + newLines.map(line => `+${line}\n`).join('');
}

export async function prepareGovernanceBootstrapV2({ output, sourceRoot = repoRoot } = {}) {
  verifyBase();
  if (!output || !isAbsolute(output)) throw new Error('--output must be an absolute new directory');
  const realRepo = await realpath(repoRoot);
  const realParent = await realpath(dirname(resolve(output)));
  const target = join(realParent, resolve(output).split('/').at(-1));
  if (target === realRepo || target.startsWith(`${realRepo}/`)) throw new Error('Output must be outside the repository');
  const sourceContents = new Map();
  for (const source of reviewedSources) {
    // Each source is read once, as bytes; output uses that verified snapshot.
    const bytes = await readFile(join(sourceRoot, source.path));
    if (blobSha(bytes) !== source.blobSha || sha256(bytes) !== source.sha256) throw new Error(`Unreviewed source bytes: ${source.path}`);
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!content.endsWith('\n') || content.includes('\r')) throw new Error('Reviewed source must be newline-terminated UTF-8');
    sourceContents.set(source.path, content);
  }
  const owner = sourceContents.get('.github/workflows/owner-approval.yml');
  const verifier = sourceContents.get('scripts/verify-owner-authorization.mjs');
  if (!owner.includes("node-version: '24.19.0'") || owner.includes('node-version-file:') || !owner.includes('workflow_dispatch:')) {
    throw new Error('Bootstrap requires standalone pinned Node and real owner dispatch');
  }
  const fullRuleset = JSON.parse(sourceContents.get('.github/rulesets/main.json'));
  const pullRule = fullRuleset.rules.find(rule => rule.type === 'pull_request').parameters;
  if (pullRule.required_approving_review_count !== 0 || pullRule.require_last_push_approval !== false || fullRuleset.bypass_actors.length !== 0) {
    throw new Error('Ruleset differs from reviewed owner-authorization policy');
  }
  const bootstrapRuleset = structuredClone(fullRuleset);
  bootstrapRuleset.rules.find(rule => rule.type === 'required_status_checks').parameters.required_status_checks = [{ context: 'smoke', integration_id: 15368 }];
  const files = [
    { path: '.github/workflows/owner-approval.yml', old: '', next: owner, operation: 'add' },
    { path: '.github/workflows/pages.yml', old: reviewedBasePages, next: blockedPages, operation: 'replace' },
    { path: 'scripts/verify-owner-authorization.mjs', old: '', next: verifier, operation: 'add' }
  ];
  const patch = files.map(wholeFilePatch).join('');
  const workflowEntries = reviewedBaseMetadata.workflows.tree.map(entry => entry.path === 'pages.yml' ? { ...entry, sha: blobSha(blockedPages) } : { ...entry });
  workflowEntries.push({ path: 'owner-approval.yml', mode: '100644', type: 'blob', sha: blobSha(owner) });
  const scriptEntries = reviewedBaseMetadata.scripts.tree.map(entry => ({ ...entry }));
  scriptEntries.push({ path: 'verify-owner-authorization.mjs', mode: '100644', type: 'blob', sha: blobSha(verifier) });
  const githubEntries = reviewedBaseMetadata.github.tree.map(entry => ({ ...entry, sha: treeSha(workflowEntries) }));
  const rootEntries = reviewedBaseMetadata.base.tree.map(entry => ({ ...entry,
    sha: entry.path === '.github' ? treeSha(githubEntries) : entry.path === 'scripts' ? treeSha(scriptEntries) : entry.sha }));
  const closedTrees = {
    '.github/workflows': { sha: treeSha(workflowEntries), entries: workflowEntries },
    '.github': { sha: treeSha(githubEntries), entries: githubEntries },
    scripts: { sha: treeSha(scriptEntries), entries: scriptEntries },
    '/': { sha: treeSha(rootEntries), entries: rootEntries }
  };
  if (closedTrees['/'].sha !== expectedNewTree) throw new Error('Prepared tree differs from independently reviewed v2 tree');
  const observedCheckoutSha = resolve(sourceRoot) === repoRoot ? execFileSync('git', ['--no-lazy-fetch', 'rev-parse', 'HEAD'],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() : null;
  const observedCheckoutBlobs = observedCheckoutSha ? reviewedSources.map(source => {
    try {
      const blobSha = execFileSync('git', ['--no-lazy-fetch', 'rev-parse', `${observedCheckoutSha}:${source.path}`],
        { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      return { path: source.path, blobSha: /^[0-9a-f]{40}$/.test(blobSha) ? blobSha : null };
    } catch { return { path: source.path, blobSha: null }; }
  }) : [];
  const sidecars = [
    { path: 'temporary-main-ruleset.json', content: `${JSON.stringify(bootstrapRuleset, null, 2)}\n` },
    { path: 'main-ruleset-after-bootstrap.json', content: sourceContents.get('.github/rulesets/main.json') }
  ];
  const manifest = {
    formatVersion: 2, repository, baseSha, baseTree, applied: false, externalMutations: false, publicationEnabled: false,
    newCommitSha: null, newTreeSha: closedTrees['/'].sha, expectedNewTreeSha: expectedNewTree,
    sourceWorkingTree: { kind: 'reviewed working-tree byte snapshot', uncommittedWhenReviewed: true,
      reviewedCheckoutSha, observedCheckoutSha, observedCheckoutBlobs,
      checkoutCommitContainsAllReviewedBytes: observedCheckoutSha && observedCheckoutBlobs.every(source => source.blobSha) ?
        observedCheckoutBlobs.every((source, index) => source.blobSha === reviewedSources[index].blobSha) : null,
      sources: reviewedSources },
    basePagesEvidence: { source: 'pinned native GitHub GET at exact base SHA', blob: blobSha(reviewedBasePages) },
    baseMetadataEvidence: reviewedBaseMetadata,
    baseAdditionsConfirmedAbsentAtPinnedBase: ['.github/workflows/owner-approval.yml', 'scripts/verify-owner-authorization.mjs'],
    closedTrees, scope: files.map(file => file.path), patchSha256: sha256(patch),
    files: files.map(file => ({ path: file.path, mode: '100644', operation: file.operation,
      oldBlobSha: file.old ? blobSha(file.old) : null, newBlobSha: blobSha(file.next), sha256: sha256(file.next) })),
    adminFilesExcludedFromBootstrapCommit: sidecars.map(file => file.path),
    adminFiles: sidecars.map(file => ({ path: file.path, sha256: sha256(file.content) })),
    bootstrapRequiredStatusChecks: bootstrapRuleset.rules.find(rule => rule.type === 'required_status_checks').parameters.required_status_checks,
    fullRulesetRequiredStatusChecks: fullRuleset.rules.find(rule => rule.type === 'required_status_checks').parameters.required_status_checks,
    prerequisites: ['Revalidate exact remote main base SHA and final bootstrap diff/CI',
      'Contain legacy Pages branch publication before any main merge (PUT Pages was refused with HTTP 403)',
      'Apply and verify real bootstrap ruleset (POST rulesets was refused with HTTP 403)',
      'Record existing session authorization honestly; no fabricated comment/review or missing G4 status'],
    remoteBlockers: { pagesWorkflow: { id: 310367403, disabledConfirmed: true },
      pagesSource: { buildType: 'legacy', branch: 'main', path: '/', updateHttpStatus: 403 },
      bootstrapRuleset: { applied: false, createHttpStatus: 403 }, mainMergeAllowed: false }
  };
  // All input and tree validation precedes the first write. mkdir is exclusive.
  await mkdir(target);
  for (const file of files) {
    const path = join(target, 'files', file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.next, { flag: 'wx', mode: 0o644 });
  }
  await writeFile(join(target, 'bootstrap.patch'), patch, { flag: 'wx', mode: 0o644 });
  for (const file of sidecars) await writeFile(join(target, file.path), file.content, { flag: 'wx', mode: 0o644 });
  await writeFile(join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
  return { prepared: true, applied: false, output: target, baseSha, newTreeSha: manifest.newTreeSha,
    paths: manifest.scope, patchSha256: manifest.patchSha256 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 4 || process.argv[2] !== '--output') throw new Error('Usage: node scripts/prepare-governance-bootstrap-v2.mjs --output /tmp/new-directory');
  console.log(JSON.stringify(await prepareGovernanceBootstrapV2({ output: process.argv[3] }), null, 2));
}
