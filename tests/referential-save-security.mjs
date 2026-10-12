/** Regra 1/4: falha ao resolver paciente/caso não confirma ficha órfã. */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rootArg = process.argv.find(arg => arg.startsWith('--app-root='));
const root = rootArg ? resolve(process.cwd(), rootArg.slice('--app-root='.length)) : resolve(here, '..');
const [source, transport] = await Promise.all([
  readFile(resolve(root, 'src/platform/relational-persistence.js'), 'utf8'),
  readFile(resolve(root, 'src/platform/cloud-first.js'), 'utf8')
]);
const org = 'aaaaaaaa-1111-4111-8111-111111111111';
const context = { organizationId: org, userId: 'user-a', verified: true, generation: 1 };
const contextListeners = [];
let patientExisting = false, failureTable = 'patients', failureStatus = 503, uploadFailure = null;
let clinicalWrites = 0;
const json = value => new Response(JSON.stringify(value), { status: 200 });
const sandbox = {
  console, navigator: { onLine: true },
  contextoAba: { capturar: () => context, corresponde: c => c === context,
    aoMudar: listener => contextListeners.push(listener) },
  cloud: {
    config: () => ({ url: 'https://synthetic.invalid' }),
    _headers: () => ({}), _garantirToken: async () => true, servidorFora: () => false
  },
  migracaoFase4: {
    _ident: item => ({ nome: item.paciente_nome || '' }),
    _patKey: identity => identity.nome ? 'pat:' + identity.nome : null,
    _encKey: key => key ? 'case:' + key : null,
    _dataISO: value => value || null
  },
  prontuario: {
    async prepararParaNuvem(_mod, item) {
      if (uploadFailure) throw uploadFailure;
      return { dados: structuredClone(item), contexto: null };
    },
    confirmarNaNuvem() {}
  },
  store: { list: () => [], setList() {} },
  async fetch(url, opts = {}) {
    const table = new URL(url).pathname.split('/').at(-1);
    if (opts.method === 'POST' && table !== 'patients' && table !== 'encounters') {
      clinicalWrites++;
      return json([{ id: 'record-remote', ...JSON.parse(opts.body)[0], version: 1 }]);
    }
    if (table === failureTable && (opts.method === 'POST' || failureStatus === 401)) {
      if (failureStatus === 'network') throw new TypeError('Failed to fetch');
      return new Response('failure', { status: failureStatus });
    }
    if (table === 'patients' && patientExisting) return json([{ id: 'patient-remote', legacy_id: 'pat:Sintético' }]);
    return json([]);
  }
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(`${source}\n${transport}\nglobalThis.api = { cloudRel, persistenciaCloudFirst };`, sandbox);
const { cloudRel: rel, persistenciaCloudFirst: engine } = sandbox.api;
rel._capturarContexto = () => context;
rel._contextoValido = () => true;
rel._org = () => org;
rel.registrarAnexos = async () => true;
const reset = () => { clinicalWrites = 0; rel._cachePac = {}; rel._cacheEnc = {}; uploadFailure = null; };
const record = () => ({ _id: 'record-1', paciente_nome: 'Sintético' });

for (const table of ['patients', 'encounters']) {
  for (const status of [503, 403, 401, 'network']) {
    reset(); failureTable = table; failureStatus = status; patientExisting = table === 'encounters';
    const result = await rel.enviarRegistro('pre', record());
    assert.equal(result.ok, false, `${table} ${status} nunca confirma a ficha`);
    assert.equal(clinicalWrites, 0, 'falha de dependência impede INSERT/PATCH clínico com FK nula');
    assert.equal(engine._classeFalha(result), status === 403 || status === 401 ? 'auth' : 'outage',
      'rejeição de autorização fica em memória; indisponibilidade habilita WAL cifrado');
  }
}
for (const status of [503, 403, 'network']) {
  reset(); failureTable = 'patients'; failureStatus = status; patientExisting = false;
  const result = await rel.enviarAgenda(record());
  assert.equal(result.ok, false);
  assert.equal(clinicalWrites, 0, 'agenda não pode confirmar uma resolução de paciente que falhou');
  assert.equal(engine._classeFalha(result), status === 403 ? 'auth' : 'outage');
}
for (const failure of [Object.assign(new Error('HTTP 503'), { status: 503 }),
  Object.assign(new Error('HTTP 403'), { status: 403 }), new TypeError('Failed to fetch')]) {
  reset(); uploadFailure = failure;
  const result = await rel.enviarRegistro('pre', record());
  assert.equal(result.ok, false);
  assert.equal(clinicalWrites, 0);
  assert.equal(engine._classeFalha(result), failure.status === 403 ? 'auth' : 'outage',
    'falha de upload preserva sua causa, sem transformar 403 em falta de rede');
}

// Um módulo que legitimamente não possui identidade de paciente/caso continua
// funcionando: null significa ausência de identidade, nunca erro de rede.
reset(); failureTable = 'patients'; failureStatus = 503; patientExisting = false;
const independent = await rel.enviarRegistro('fin_fechamentos', { _id: 'closing-1' });
assert.equal(independent.ok, true);
assert.equal(clinicalWrites, 1);
assert.equal(independent.row.patient_id, null);
// Trocar de pessoa na mesma clínica também encerra os índices nominativos da
// sessão anterior; UUIDs não tornam inofensiva a chave que contém o nome.
rel._cachePac[org + ':pat:Sintético'] = 'patient-remote';
rel._cacheEnc[org + ':case:Sintético'] = 'case-remote';
for (const listener of contextListeners) listener({ ...context, userId: 'user-b', generation: 2 }, context);
assert.equal(Object.keys(rel._cachePac).length, 0);
assert.equal(Object.keys(rel._cacheEnc).length, 0);
console.log('  ✓ Paciente, caso e anexo com 503/rede bloqueiam fichas órfãs e habilitam WAL; 401/403 preservam rejeição de autorização');
