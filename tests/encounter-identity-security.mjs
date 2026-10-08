/** F1c: identidade forte não mistura homônimos e mantém compatibilidade legada. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { readAppSource } from './helpers/read-app-source.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const rootArg = process.argv.find(arg => arg.startsWith('--app-root='));
const appRoot = rootArg ? resolve(process.cwd(), rootArg.slice('--app-root='.length)) : repo;

const [identitySource, appSource, linkerSource, runbook] = await Promise.all([
  readFile(resolve(appRoot, 'src/domain/encounter-identity.js'), 'utf8'),
  readAppSource(appRoot),
  readFile(resolve(appRoot, 'src/domain/encounter-linker.js'), 'utf8'),
  readFile(resolve(repo, 'docs/engineering/F1-MODULARIZATION.md'), 'utf8'),
]);

const sandbox = { window: {} };
vm.runInNewContext(identitySource, sandbox, { filename: 'encounter-identity.js' });
const identity = sandbox.window.SoftEncounterIdentity;
assert(identity && Object.isFrozen(identity), 'contrato de identidade deve ser imutável');

assert.equal(identity.normalizeName('  José  da   Silva '), 'jose da silva');
assert.equal(identity.validCpf('529.982.247-25'), true);
assert.equal(identity.validCpf('111.111.111-11'), false);

const homonimoA = { nome: 'Maria de Souza', nasc: '1980-01-02', cpf: '' };
const homonimoB = { nome: 'Maria de Souza', nasc: '1992-03-04', cpf: '' };
assert.equal(identity.legacyPatientKey(homonimoA), identity.legacyPatientKey(homonimoB),
  'chave histórica deve permanecer compatível com o banco existente');
assert.notEqual(identity.strongPatientKey(homonimoA), identity.strongPatientKey(homonimoB),
  'homônimos com nascimentos diferentes não podem compartilhar identidade forte');
assert.equal(identity.strongPatientKey({ nome: 'Maria de Souza', nasc: '', cpf: '' }), null,
  'nome isolado não pode autorizar união automática');

const cpfA = identity.strongPatientKey({ nome: 'Paciente', nasc: '', cpf: '52998224725' });
const cpfB = identity.strongPatientKey({ nome: 'Paciente', nasc: '', cpf: '11144477735' });
assert.notEqual(cpfA, cpfB, 'CPFs válidos diferentes devem produzir pessoas diferentes');

const nested = identity.fromRecord({
  paciente: { nome: 'Ana Lima', nascimento: '1975-06-07', cpf: '529.982.247-25' },
  procedimento: { descricao: 'Colecistectomia' }, data_anestesia: '2026-10-07'
});
assert.equal(nested.nome, 'Ana Lima');
assert.equal(nested.nasc, '1975-06-07');
assert.equal(nested.cpf, '52998224725');
const caseKey = identity.strongEncounterKey(nested, {
  procedimento: { descricao: 'Colecistectomia' }, data_anestesia: '2026-10-07'
});
assert.match(caseKey, /^cpf:52998224725\|2026-10-07\|colecistectomia$/);
assert.notEqual(
  identity.scopedKey('aaaaaaaa-1111-4111-8111-111111111111', caseKey),
  identity.scopedKey('bbbbbbbb-2222-4222-8222-222222222222', caseKey),
  'o mesmo caso não pode compartilhar chave entre organizações'
);

const preIdentity = identity.fromRecord({ nome: 'Ana Lima', nasc: '1975-06-07' });
assert.equal(preIdentity.nasc, '1975-06-07',
  'o alias de nascimento usado pela pré-anestésica deve participar da identidade');

/* Executa o objeto real do linker com duas Marias distintas. Métodos que
   acessam DOM/transporte não são chamados; o teste cobre apenas a decisão de
   identidade que antecede qualquer autopreenchimento ou importação. */
const linkerStart = linkerSource.indexOf('const linker = {');
const linkerEnd = linkerSource.indexOf('\n\n/* FIM DO LINKER DE ATENDIMENTOS */', linkerStart);
assert(linkerStart >= 0 && linkerEnd > linkerStart, 'bloco do linker deve ser localizável');

const keyA = identity.strongPatientKey(homonimoA);
const keyB = identity.strongPatientKey(homonimoB);
const caseFromSelectedPatient = identity.strongEncounterKey({ patientKey: keyA }, {
  paciente: homonimoA.nome, data: '2026-10-07', procedimento: 'Colecistectomia'
});
assert.equal(caseFromSelectedPatient, keyA + '|2026-10-07|colecistectomia',
  'a identidade já selecionada deve formar a chave do caso sem depender de recapturar CPF/nascimento');
const fixtures = {
  pacientes: [
    { _id: 'pac-a', nome: homonimoA.nome, nascimento: homonimoA.nasc,
      telefone: '1111-1111', convenio: 'Plano A', _updatedAt: '2026-10-01T10:00:00Z' },
    { _id: 'pac-b', nome: homonimoB.nome, nascimento: homonimoB.nasc,
      telefone: '2222-2222', convenio: 'Plano B', _updatedAt: '2026-10-02T10:00:00Z' },
  ],
  pre: [
    { _id: 'pre-a', nome: homonimoA.nome, nasc: homonimoA.nasc,
      _patientKey: keyA, _updatedAt: '2026-10-03T10:00:00Z' },
    { _id: 'pre-b', nome: homonimoB.nome, nasc: homonimoB.nasc,
      _patientKey: keyB, _updatedAt: '2026-10-04T10:00:00Z' },
  ],
  consulta: [
    { _id: 'con-a', nome: homonimoA.nome, nascimento: homonimoA.nasc,
      telefone: '1111-9999', _patientKey: keyA, _updatedAt: '2026-10-05T10:00:00Z' },
    { _id: 'con-b', nome: homonimoB.nome, nascimento: homonimoB.nasc,
      telefone: '2222-9999', _patientKey: keyB, _updatedAt: '2026-10-06T10:00:00Z' },
  ],
};
sandbox.store = { list: mod => fixtures[mod] || [] };
sandbox.STORAGE = {};
vm.runInNewContext(
  linkerSource.slice(linkerStart, linkerEnd) + '\nglobalThis.__testedLinker = linker;',
  sandbox,
  { filename: 'encounter-linker.js' }
);
const testedLinker = sandbox.__testedLinker;
const ambiguous = testedLinker._dadosMaisRecentes(homonimoA.nome, 'pre');
assert.equal(ambiguous.ambiguous, true,
  'dois homônimos fortes devem bloquear o preenchimento sem uma seleção');
assert.equal(Object.keys(ambiguous.dados).length, 0,
  'nenhum dado pode vazar antes de escolher qual homônimo é o paciente');

const selectedA = testedLinker._dadosMaisRecentes(homonimoA.nome, 'pre', { identityKey: keyA });
assert.equal(selectedA.ambiguous, false);
assert.equal(selectedA.dados.telefone, '1111-9999');
assert.equal(selectedA.dados.convenio, 'Plano A');
assert.notEqual(selectedA.dados.telefone, '2222-9999',
  'campos recentes do segundo homônimo não podem contaminar o primeiro');
assert.equal(testedLinker.ultimoPorNome('pre', homonimoA.nome), null,
  'importação pelo nome deve parar quando houver homônimos');
assert.equal(testedLinker.ultimoPorNome('pre', homonimoA.nome, { identityKey: keyA })._id, 'pre-a');

const semDocumentoA = { _id: 'pac-ref-a', nome: 'João Pereira', telefone: '3333-1111' };
const semDocumentoB = { _id: 'pac-ref-b', nome: 'João Pereira', telefone: '3333-2222' };
const refFixtures = {
  pacientes: [semDocumentoA, semDocumentoB],
  pre: [
    { _id: 'pre-ref-a', nome: 'João Pereira', telefone: '3333-9991', _patientRef: 'pac-ref-a',
      _updatedAt: '2026-10-05T10:00:00Z' },
    { _id: 'pre-ref-b', nome: 'João Pereira', telefone: '3333-9992', _patientRef: 'pac-ref-b',
      _updatedAt: '2026-10-05T10:00:00Z' },
  ],
};
sandbox.store.list = mod => refFixtures[mod] || [];
assert.equal(testedLinker._dadosMaisRecentes('João Pereira', 'pre').ambiguous, true,
  'dois cadastros sem CPF/nascimento ainda devem permanecer separados pelo ID escolhido');
const selectedRef = testedLinker._dadosMaisRecentes('João Pereira', 'pre', { patientRef: 'pac-ref-a' });
assert.equal(selectedRef.dados.telefone, '3333-9991');
assert.equal(testedLinker.ultimoPorNome('pre', 'João Pereira'), null);
assert.equal(testedLinker.ultimoPorNome('pre', 'João Pereira', { patientRef: 'pac-ref-b' })._id, 'pre-ref-b');

sandbox.store.list = mod => mod === 'pre' ? [
  { _id: 'weak-a', nome: 'Carlos Lima' }, { _id: 'weak-b', nome: 'Carlos Lima' }
] : [];
assert.equal(testedLinker._dadosMaisRecentes('Carlos Lima', 'pre').ambiguous, true,
  'vários documentos conhecidos somente pelo nome não podem ser unidos');
assert.equal(testedLinker.ultimoPorNome('pre', 'Carlos Lima'), null);

sandbox.store.list = mod => mod === 'pre' ? [
  { _id: 'case-new', nome: homonimoA.nome, _patientKey: keyA, _caseId: 'caso-2',
    _updatedAt: '2026-10-07T12:00:00Z' },
  { _id: 'case-old', nome: homonimoA.nome, _patientKey: keyA, _caseId: 'caso-1',
    _updatedAt: '2026-10-06T12:00:00Z' }
] : [];
assert.equal(testedLinker.ultimoPorNome('pre', homonimoA.nome, {
  identityKey: keyA, caseId: 'caso-1'
})._id, 'case-old', 'caseId deve prevalecer sobre a simples recência do mesmo paciente');
assert.equal(testedLinker.ultimoPorNome('pre', homonimoA.nome, {
  identityKey: keyA, caseId: 'caso-inexistente'
}), null, 'um caso inexistente não pode cair silenciosamente no atendimento mais recente');

const hiddenContext = {
  '[name="_patientKey"]': { value: keyA },
  '[name="_patientRef"]': { value: 'pac-a' },
  '[name="_caseId"]': { value: 'caso-antigo' },
  '[name="_caseKey"]': { value: 'chave-antiga' },
  '[name="paciente_nome"], [name="nome"], [name="paciente"]': {
    dataset: { patientSelectedName: homonimoA.nome, patientKey: keyA }
  }
};
sandbox.document = {
  getElementById: id => id === 'form-pre'
    ? { querySelector: selector => hiddenContext[selector] || null }
    : null
};
testedLinker.limparContextoPaciente('pre');
assert.equal(hiddenContext['[name="_patientKey"]'].value, '');
assert.equal(hiddenContext['[name="_patientRef"]'].value, '');
assert.equal(hiddenContext['[name="_caseId"]'].value, '',
  'trocar de pessoa deve remover o identificador opaco do caso anterior');
assert.equal(hiddenContext['[name="_caseKey"]'].value, '');
assert.equal(hiddenContext['[name="paciente_nome"], [name="nome"], [name="paciente"]']
  .dataset.patientSelectedName, undefined);

assert.match(appSource, /SoftEncounterIdentity\.fromRecord\(it\)/);
assert.match(appSource, /SoftEncounterIdentity\.legacyPatientKey\(id\)/);
assert.match(appSource, /SoftEncounterIdentity\.legacyEncounterKey\(patKey, it\)/);
assert.match(linkerSource, /SoftEncounterIdentity\.normalizeName\(s\)/);
assert.match(linkerSource, /Há pacientes homônimos/);
assert.match(appSource, /patientSelectedName/);
assert.match(appSource, /linker\.aplicarContextoPaciente\('anestesia', ag, contextoPaciente\)/);
assert.match(appSource, /input\.dataset\.pacAuto \|\| input\.dataset\.acAttached/,
  'o fallback não pode abrir uma segunda lista sobre o autocomplete canônico');
assert.match(linkerSource, /limparContextoCaso\(mod\)/,
  'trocar de paciente deve limpar também o atendimento invisível anterior');
assert.match(linkerSource, /linker\.limparContextoCaso\(mod\)/);
assert.match(appSource, /: patientRef \? 'ref:' \+ patientRef : 'fraca:' \+ nomeNormal/,
  'o autocomplete fallback deve manter homônimos de referências distintas separados');
assert.match(appSource, /const chavesAmbiguas = new Set\(\)/,
  'pull da nuvem não pode escolher arbitrariamente entre pacientes locais ambíguos');
assert.match(appSource, /if \(!loc && !chavesAmbiguas\.has\(syncKey\)\)/);
assert.match(appSource, /if \(!mesmaIdentidade && !mesmaReferencia\) linker\.limparContextoPaciente\(MOD\)/,
  'selecionar outro paciente deve descartar o contexto do caso anterior');
assert.match(appSource, /Este marcador só observa edição; nunca é usado para unir prontuários/,
  'fichas legadas fracas também devem detectar a troca manual de nome');
assert.match(appSource, /\['_patientKey','_patientRef','_caseId','_caseKey'\]/,
  'save só deve herdar contexto ausente; vazio explícito representa uma troca');
assert.match(appSource, /_pacienteToken\(it\)/);
assert.match(appSource, /nome isolado não prova duplicidade/);
assert.match(appSource, /_prontEscolhas\(opcoes\)/);
assert.match(appSource, /_patientKey: cab\.patientKey \|\| item\._patientKey/,
  'lançamento financeiro automático deve herdar a identidade do documento clínico');
assert.match(appSource, /if \(!item\._caseId\) item\._caseId = 'caso_' \+ utils\.uid\(\)/,
  'todo registro clínico novo deve receber um identificador opaco de caso');
assert.match(appSource, /if \(modKey === 'financeiro' && item\._origemId\)/,
  'financeiro legado com origem explícita deve herdar o caso do documento');
assert.match(appSource, /_caseToken\(mod, item\)/);
assert.match(appSource, /Registro legado sem vínculo fica isolado/,
  'Meu Dia não pode unir registros legados só porque o nome coincide');
assert.match(appSource, /drive_file_id: a\.id/);
assert.match(appSource, /Cada arquivo vira um registro separado/,
  'importação do Drive não pode anexar automaticamente por nome + data');
assert.doesNotMatch(appSource, /\(p\[campoNome\] \|\| ''\)\.toLowerCase\(\) === \(a\.nome \|\| ''\)\.toLowerCase\(\)/,
  'idempotência do Drive não pode voltar a usar nome do paciente');
assert.match(appSource, /Não é seguro juntar ficha e SRPA sem o mesmo atendimento vinculado/);
assert.match(appSource, /Nome isolado nunca injeta o risco de um homônimo/);
assert.match(appSource, /dashboard\._tokenPaciente\(it\)/,
  'detalhe de pacientes únicos deve usar o mesmo contrato forte do totalizador');
assert.match(runbook, /nome isolado nunca\s+autoriza unir prontuários/i);
assert.match(runbook, /caminho remoto continua usando a chave legada/i);

console.log('  ✓ F1c: identidade forte separa homônimos sem romper legacy_id existente');
