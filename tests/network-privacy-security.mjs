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

// A primeira impressão offline precisa funcionar mesmo sem uma visita prévia ao shell.
const swSource = await readFile(resolve(root, 'sw.js'), 'utf8');
const listeners = new Map(), publicCache = new Map();
const urlFor = value => new URL(typeof value === 'string' ? value : value.url, 'https://app.test/').href;
let activated = false, response;
vm.runInContext(swSource, vm.createContext({ URL,
  self: { location: { origin: 'https://app.test' },
    addEventListener: (name, fn) => listeners.set(name, fn),
    skipWaiting: () => { activated = true; } },
  caches: {
    open: async () => ({ addAll: async paths => {
      for (const path of paths) publicCache.set(urlFor(path), 'public:' + path);
    } }),
    match: async request => publicCache.get(urlFor(request))
  },
  fetch: async () => { throw new TypeError('rede indisponível'); }
}));
let installed;
listeners.get('install')({ waitUntil: promise => { installed = promise; } });
await installed;
assert(activated);
for (const path of ['print-shell.html', 'src/print/print-shell.js',
  'src/ui/strict-actions.js', 'src/ui/strict-actions.generated.js']) {
  response = undefined;
  listeners.get('fetch')({ request: { method: 'GET', url: urlFor(path),
    mode: path.endsWith('.html') ? 'navigate' : 'cors' },
    respondWith: promise => { response = promise; } });
  assert.equal(await response, 'public:' + path, 'shell e scripts funcionam na primeira impressão sem rede');
}
assert.equal(publicCache.size, 4, 'pré-cache contém somente assets de impressão públicos');
for (const route of ['rest', 'auth', 'storage', 'functions']) {
  response = undefined;
  listeners.get('fetch')({ request: { method: 'GET', url: urlFor(route + '/v1/clinical.json'), mode: 'cors' },
    respondWith: promise => { response = promise; } });
  assert.equal(response, undefined, 'endpoints clínicos nunca entram no cache do service worker');
}
console.log('  ✓ primeira impressão offline tem shell público pré-carregado; endpoints clínicos permanecem fora do SW');
