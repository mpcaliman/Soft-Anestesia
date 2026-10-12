import assert from 'node:assert/strict';
import vm from 'node:vm';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAppSource } from './helpers/read-app-source.mjs';

const argument = process.argv.find(x => x.startsWith('--app-root='));
const root = argument ? resolve(argument.slice('--app-root='.length)) : resolve(fileURLToPath(new URL('..', import.meta.url)));
const source = await readAppSource(root);
const start = source.indexOf('  estadoNuvem(modKey, item) {');
const end = source.indexOf('  atualizarNuvemDoc(modKey, item) {', start);
assert.ok(start >= 0 && end > start);
let walPending = false, localPending = false;
const runtime = {
  demo: { ativo: () => false }, cloud: { estaConfigurado: () => true },
  cloudRel: { ehModuloRegistro: () => true, _filaLer: () => [] },
  persistenciaCloudFirst: { temPendente: () => walPending },
  store: { temPendenteLocal: () => localPending },
  utils: { formatarDataHora: value => value }
};
vm.createContext(runtime);
vm.runInContext('globalThis.ui = { NUVEM_ROTULOS: {},' + source.slice(start, end) + '};', runtime);
const document = { _id: 'same-record', _relUpdatedAt: '2026-10-08T12:00:00Z' };
assert.equal(runtime.ui.estadoNuvem('pre', document).cls, 'ok');
localPending = true;
assert.equal(runtime.ui.estadoNuvem('pre', document).cls, 'parado', 'a confirmação anterior não confirma uma edição ainda não estagiada');
localPending = false; walPending = true;
assert.equal(runtime.ui.estadoNuvem('pre', document).cls, 'parado', 'a edição no WAL cifrado ainda precisa de recibo próprio');
assert.match(runtime.ui.estadoNuvem('pre', document).tit, /fila/);
walPending = false;
assert.equal(runtime.ui.estadoNuvem('pre', document).cls, 'ok', 'o recibo da nova edição libera o selo confirmado');
console.log('  ✓ Selo da nuvem distingue recibo anterior de edição pendente no WAL');
