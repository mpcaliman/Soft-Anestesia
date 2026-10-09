import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const appArg = process.argv.find(x => x.startsWith('--app-root='));
const root = appArg ? resolve(appArg.slice('--app-root='.length)) : process.cwd();
const source = await readFile(resolve(root, 'src/platform/network-privacy.js'), 'utf8');
const calls = [];
const sandbox = vm.createContext({ URL, fetch: async (...args) => { calls.push(args); return { ok: true }; } });
vm.runInContext(source, sandbox);
for (const route of ['rest', 'auth', 'storage', 'functions']) {
  await sandbox.fetch(`https://staging.test/${route}/v1/resource`, { method: 'POST', cache: 'force-cache', body: 'sintético' });
  assert.equal(calls.at(-1)[1].cache, 'no-store');
  assert.equal(calls.at(-1)[1].body, 'sintético');
}
await sandbox.fetch({ url: 'https://staging.test/rest/v1/patients' });
assert.equal(calls.at(-1)[1].cache, 'no-store');
const publicOptions = { cache: 'force-cache' };
await sandbox.fetch('https://app.test/src/ui/modal.js', publicOptions);
assert.equal(calls.at(-1)[1], publicOptions);
console.log('  ✓ respostas clínicas/Auth/Storage não usam cache HTTP; assets públicos mantêm cache offline');
