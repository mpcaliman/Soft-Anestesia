import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Offline preparation only: no fetch, Git ref/index writes, credentials, commits,
// branch changes, GitHub mutations or production publication.
const repository = 'mpcaliman/Soft-Anestesia';
const baseSha = '634f9e2ccfe86ec0174b845526b0f9f70159db34';
const baseTree = '4f884ee5159b6829650d326bb8127fd8df85e944';
const sourceSha = 'ad6f4b37c0f239619515b677bd1bef21227c28fc';
// Pinned native GitHub GET evidence, queried 2026-10-10 00:35 UTC.
// Tree entries contain only names/modes/hashes; no clinical file was opened.
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
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argumentsByName = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (!['--output', '--base-pages-file', '--base-pages-blob'].includes(name) || !value || argumentsByName.has(name)) {
    throw new Error('Usage: node scripts/prepare-governance-bootstrap.mjs --output /tmp/new-directory [--base-pages-file /tmp/pages-at-base.yml --base-pages-blob FULL_GIT_BLOB_SHA]');
  }
  argumentsByName.set(name, value);
}
const output = argumentsByName.get('--output');
if (!output || !isAbsolute(output)) throw new Error('--output must be an absolute, new directory');
if (resolve(output) === repoRoot || resolve(output).startsWith(`${repoRoot}/`)) {
  throw new Error('Output must be outside the repository; this script never modifies the checked-out tree');
}
const externalPages = argumentsByName.get('--base-pages-file');
const externalBlob = argumentsByName.get('--base-pages-blob');
if (Boolean(externalPages) !== Boolean(externalBlob) || (externalBlob && !/^[0-9a-f]{40}$/.test(externalBlob))) {
  throw new Error('External base Pages bytes require their full Git blob SHA from a read-only query at the exact base SHA');
}

function gitRead(...args) {
  return execFileSync('git', ['--no-lazy-fetch', ...args], {
    cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  });
}
function blobSha(content) {
  const bytes = Buffer.from(content, 'utf8');
  return createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
}
function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}
function treeSha(entries) {
  const sorted = [...entries].sort((a, b) => Buffer.compare(
    Buffer.from(a.path + (a.type === 'tree' ? '/' : '')),
    Buffer.from(b.path + (b.type === 'tree' ? '/' : ''))));
  const bytes = Buffer.concat(sorted.map(entry => Buffer.concat([
    Buffer.from(`${entry.mode.replace(/^0+/, '')} ${entry.path}\0`), Buffer.from(entry.sha, 'hex')
  ])));
  return createHash('sha1').update(Buffer.from(`tree ${bytes.length}\0`)).update(bytes).digest('hex');
}
for (const evidence of Object.values(reviewedBaseMetadata)) {
  if (treeSha(evidence.tree) !== evidence.sha) throw new Error('Pinned base tree metadata does not reproduce its Git tree SHA');
}
if (blobSha(reviewedBasePages) !== 'c1feb9acf2bb6f9391cadc384d977a341c22bc4e') {
  throw new Error('Pinned base Pages bytes do not reproduce the reviewed Git blob');
}
function replaceOnce(content, oldText, newText) {
  if (content.split(oldText).length !== 2) throw new Error('Source differs from the reviewed bootstrap transform');
  return content.replace(oldText, newText);
}
function readSource(path, expectedBlob) {
  const content = gitRead('show', `${sourceSha}:${path}`);
  if (blobSha(content) !== expectedBlob) throw new Error(`Unreviewed source bytes: ${path}`);
  return content;
}

const ownerSource = readSource('.github/workflows/owner-approval.yml', '523cc3e6a58e980866ceb78561a8b2f9bdbf3ccc');
const verifierSource = readSource('scripts/verify-owner-authorization.mjs', 'ac7127c9631f5a19c07cec77efa4bd211e487ba0');
const fullRuleset = readSource('.github/rulesets/main.json', '26b6b2f2d1d5440bd3acd20883d56a4d8f04a187');
let owner = replaceOnce(ownerSource, '          node-version-file: .nvmrc', "          node-version: '24.19.0'");
owner = replaceOnce(owner, '\njobs:\n', '\nconcurrency:\n  group: owner-authorization-${{ github.event.pull_request.number || github.event.issue.number }}\n  cancel-in-progress: false\n\njobs:\n');
let verifier = replaceOnce(verifierSource, "!/^[0-9a-f]{40}$/.test(sha || '') || !GATES[scope]", "!/^[0-9a-f]{40}$/.test(sha || '') || !Object.hasOwn(GATES, scope)");
verifier = replaceOnce(verifier,
  '  decisions.sort((a, b) => String(a.date).localeCompare(String(b.date)));',
  '  // GitHub timestamps have second precision: a tied revocation wins.\n  decisions.sort((a, b) => String(a.date).localeCompare(String(b.date)) ||\n    Number(a.line === revoke) - Number(b.line === revoke));');
const pages = `name: GitHub Pages — bloqueado para bootstrap

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

let oldPages;
let basePagesEvidence;
if (externalPages) {
  oldPages = await readFile(externalPages, 'utf8');
  if (blobSha(oldPages) !== externalBlob || externalBlob !== blobSha(reviewedBasePages)) {
    throw new Error('Base Pages file does not match its pinned read-only Git blob evidence');
  }
  basePagesEvidence = { source: 'external read-only contents response matches pinned base evidence', blob: externalBlob };
} else {
  oldPages = reviewedBasePages;
  basePagesEvidence = { source: 'pinned native GitHub read-only contents response at exact base SHA', blob: blobSha(oldPages) };
}
const files = [
  { path: '.github/workflows/owner-approval.yml', old: '', next: owner, mode: 'add' },
  { path: '.github/workflows/pages.yml', old: oldPages, next: pages, mode: 'replace' },
  { path: 'scripts/verify-owner-authorization.mjs', old: '', next: verifier, mode: 'add' }
];
for (const file of files) {
  if (!file.next.endsWith('\n') || (file.old && !file.old.endsWith('\n'))) {
    throw new Error('Reviewed bundle requires newline-terminated UTF-8 files');
  }
}
function wholeFilePatch(file) {
  const oldLines = file.old ? file.old.slice(0, -1).split('\n') : [];
  const newLines = file.next.slice(0, -1).split('\n');
  const metadata = file.mode === 'add'
    ? `new file mode 100644\nindex ${'0'.repeat(40)}..${blobSha(file.next)}\n--- /dev/null\n`
    : `index ${blobSha(file.old)}..${blobSha(file.next)} 100644\n--- a/${file.path}\n`;
  const oldRange = oldLines.length ? `1,${oldLines.length}` : '0,0';
  return `diff --git a/${file.path} b/${file.path}\n${metadata}+++ b/${file.path}\n@@ -${oldRange} +1,${newLines.length} @@\n` +
    oldLines.map(line => `-${line}\n`).join('') + newLines.map(line => `+${line}\n`).join('');
}
const patch = files.map(wholeFilePatch).join('');
const temporaryRuleset = JSON.parse(fullRuleset);
temporaryRuleset.rules = temporaryRuleset.rules.filter(rule => rule.type !== 'required_status_checks');
const workflowEntries = reviewedBaseMetadata.workflows.tree.map(entry => entry.path === 'pages.yml'
  ? { ...entry, sha: blobSha(pages) } : { ...entry });
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
const manifest = {
  formatVersion: 1, repository, baseSha, baseTree, sourceSha,
  applied: false, externalMutations: false, publicationEnabled: false,
  newCommitSha: null, newTreeSha: closedTrees['/'].sha,
  basePagesEvidence,
  baseMetadataEvidence: reviewedBaseMetadata,
  baseAdditionsConfirmedAbsentAtPinnedBase: ['.github/workflows/owner-approval.yml', 'scripts/verify-owner-authorization.mjs'],
  closedTrees,
  scope: files.map(file => file.path),
  transforms: ['Explicit Node 24.19.0 pin replaces .nvmrc dependency', 'Serialize owner-status runs per PR',
    'Equal-timestamp revocation wins', 'Only own properties of the gate map are valid scopes',
    'Replace automatic Pages publication with manual, always-failing stub'],
  patchSha256: sha256(patch),
  files: files.map(file => ({ path: file.path, mode: '100644', operation: file.mode,
    oldBlobSha: file.mode === 'add' ? null : blobSha(file.old), newBlobSha: blobSha(file.next), sha256: sha256(file.next) })),
  fullRulesetRequiredStatusChecks: JSON.parse(fullRuleset).rules.find(rule => rule.type === 'required_status_checks').parameters.required_status_checks,
  adminFilesExcludedFromBootstrapCommit: ['temporary-main-ruleset.json', 'main-ruleset-after-bootstrap.json'],
  prerequisite: 'Revalidate exact remote base SHA; independent human review; real owner SHA-specific authorization'
};

// mkdir is deliberately exclusive: reruns never overwrite a previous bundle.
await mkdir(output);
for (const file of files) {
  const path = join(output, 'files', file.path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, file.next, { flag: 'wx', mode: 0o644 });
}
await writeFile(join(output, 'bootstrap.patch'), patch, { flag: 'wx', mode: 0o644 });
await writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
await writeFile(join(output, 'temporary-main-ruleset.json'), `${JSON.stringify(temporaryRuleset, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
await writeFile(join(output, 'main-ruleset-after-bootstrap.json'), fullRuleset, { flag: 'wx', mode: 0o644 });
console.log(JSON.stringify({ prepared: true, applied: false, output, baseSha, sourceSha,
  paths: manifest.scope, patchSha256: manifest.patchSha256 }, null, 2));
