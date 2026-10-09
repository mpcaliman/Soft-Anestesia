import { readAppSource, readCompiledActions } from './helpers/read-app-source.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootArg = process.argv.find(arg => arg.startsWith('--app-root='));
const appRoot = rootArg ? resolve(process.cwd(), rootArg.slice('--app-root='.length)) : repo;
const indexPath = resolve(appRoot, 'index.html');
const html = await readAppSource(appRoot);
const SoftActions = await readCompiledActions(appRoot);
const storeSource = await readFile(resolve(appRoot, 'src/platform/clinical-store.js'), 'utf8');
function objectSource(name) {
  const start = html.indexOf('const ' + name + ' = {');
  const end = html.indexOf('\n};', start);
  assert(start >= 0 && end > start, name + ' deve existir');
  return html.slice(start, end + 3);
}
const values = new Map();
const localStorage = {
  getItem: key => values.get(context.organizationId + '|' + key) ?? null,
  setItem: (key, value) => values.set(context.organizationId + '|' + key, String(value)),
  removeItem: key => values.delete(context.organizationId + '|' + key)
};
let sequence = 0;
let context = { generation: 1, userId: 'doctor-1', organizationId: 'org-1', tabId: 'tab-1' };
const staged = [];
const sandbox = vm.createContext({ SoftActions,
  console, setTimeout, clearTimeout, localStorage,
  HISTORY_MAX: 100,
  STORAGE: {pre:'pre', consulta:'consulta', anestesia:'anestesia', financeiro:'financeiro'},
  CBHPM_VERSAO: '2022',
  state: { currentModule: 'pre' },
  window: {}, document: { getElementById: () => null },
  utils: { uid: () => 'id-' + (++sequence), escapeHTML: String },
  markClean() {}, toast() {}, setSavedStatus() {},
  modal: { close() {} },
  auth: { usuarioAtual: () => ({ id:'doctor-1', nome:'Dra. Teste' }) },
  contextoAba: { atual: () => context, operational: () => true, aoMudar() {} },
  cloudRel: { _org: () => context.organizationId },
  persistenciaCloudFirst: {
    salvarAdendo(mod, rec, ad, table) {
      staged.push({mod, id:rec._id, ad:JSON.parse(JSON.stringify(ad)), table});
      return Promise.resolve({durable:true, queued:true, motivo:'offline'});
    }
  },
  linker: {link() {}}, historico: {_fmtRS: String}
});
vm.runInContext(storeSource + '\n' + objectSource('adendos') + '\n' + objectSource('fin') +
  '\nglobalThis.api = {store, adendos, fin};', sandbox);
const {store, fin} = sandbox.api;
fin.isAutoEnabled = () => true;
fin._cabecalho = (mod, record) => ({paciente:record.nome, dataProc:'2026-09-01',
  procedimento:'Consulta', patientRef:record._patientRef, caseId:record._caseId});
fin.linhasDe = () => [{linhaId:'', valor_final:100, quantidade:1, fracao:100}];
fin._linhaComoCodigo = () => ({codigo:'10101012', valor_previsto:100});

const original = {_id:'signed-1', nome:'Maria Silva', cirurgia:'Colecistectomia',
  _patientRef:'patient-1', _caseId:'case-1', _relOrg:'org-1', _finalizado:true,
  _finalizadoEm:'2026-09-01T12:00:00.000Z'};
store.setList('pre',[original]);
store.setList('financeiro',[]);
const beforeCancellation = JSON.parse(JSON.stringify(store.getById('pre',original._id)));
fin.finalizacao._ctx = {mod:'pre', docId:original._id};
fin.finalizacao.cancelar();
const cancelled = store.getById('pre',original._id);
assert.equal(cancelled._semFinanceiro, undefined, 'cancelar não grava marcador no documento assinado');
assert.equal(cancelled._finalizadoEm,original._finalizadoEm);
const canonical = JSON.parse(JSON.stringify(cancelled));
delete canonical._adendos;
assert.deepEqual(canonical,original,'conteúdo canônico permanece idêntico');
assert.equal(cancelled._adendos.length,1);
assert.equal(cancelled._adendos[0].motivo,'decisao_financeira');
assert.equal(cancelled._adendos[0].texto,fin.finalizacao.DECISAO_NAO);
assert(cancelled._adendos[0].autor && cancelled._adendos[0].data);
assert.equal(staged.length,1,'decisão usa o transporte/WAL existente para adendos');
assert.equal(staged[0].table,'preanesthetic_assessments');
assert.equal(fin.fromDoc('pre',cancelled),null,'gravação posterior não ressuscita cobrança');
assert.equal(fin.fromDoc('pre',beforeCancellation),null,
  'clone obtido antes do NÃO consulta a decisão auditável do documento atual');
assert.equal(store.list('financeiro').length,0,
  'clone anterior à decisão não cria cobrança');

/* Clones e dados restaurados em ordem diferente consultam o evento mais
   recente pelo horário canônico do servidor. */
const restored = {...original,_adendos:[
  {motivo:'decisao_financeira',texto:fin.finalizacao.DECISAO_SIM,
   data:'2026-01-01T00:00:00Z',_serverCreatedAt:'2026-09-02T12:00:00Z'},
  {motivo:'decisao_financeira',texto:fin.finalizacao.DECISAO_NAO,
   data:'2026-09-03T12:00:00Z',_serverCreatedAt:'2026-09-01T12:00:00Z'}
]};
assert.equal(fin.finalizacao.decisaoDe(restored),true,'horário do servidor vence o do aparelho');
assert.equal(fin.finalizacao.decisaoDe({...original,_adendos:[
  {motivo:'correcao',texto:fin.finalizacao.DECISAO_NAO,data:'2099-01-01'}
]}),null,'texto clínico parecido não vira comando financeiro');

/* O SIM explícito revoga o NÃO sem apagar o histórico; a linha financeira
   gerada fica vinculada ao documento/caso e não duplica na segunda chamada. */
const allowed = fin.finalizacao.registrarDecisao('pre',original._id,true);
assert.equal(fin.finalizacao.decisaoDe(allowed),true);
assert.equal(allowed._adendos.length,2);
const created = fin.fromDoc('pre',allowed);
assert(created && created.item && created.isNew);
assert.equal(created.item._origemId,original._id);
assert.equal(created.item._patientRef,original._patientRef);
assert.equal(created.item._caseId,original._caseId);
fin.fromDoc('pre',allowed);
assert.equal(store.list('financeiro').length,1);
assert.equal(fin.finalizacao.registrarDecisao('pre',original._id,true)._adendos.length,2,
  'a mesma decisão não cria eventos repetidos');

/* Nenhuma decisão é herdada por homônimo, outro módulo/caso ou organização. */
store.setList('pre',[allowed,{...original,_id:'signed-2',_caseId:'case-2'}]);
assert.equal(fin.finalizacao.decisaoDe(store.getById('pre','signed-2')),null);
store.setList('consulta',[{...original,_id:'signed-1',_caseId:'case-3'}]);
assert.equal(fin.finalizacao.decisaoDe(store.getById('consulta','signed-1')),null);
store.setList('anestesia',[{...original,_id:'draft-1',_finalizado:false}]);
assert.equal(fin.finalizacao.registrarDecisao('anestesia','draft-1',false),null,
  'rascunho não recebe decisão de finalização');
const stagesBefore = staged.length;
const financialBefore = JSON.parse(JSON.stringify(store.list('financeiro')));
const foreignDocument = {...original,_id:'foreign-signed-1',_relOrg:'org-2'};
assert.equal(fin.fromDoc('pre',foreignDocument),null,
  'documento de outra clínica não cria cobrança na organização atual');
assert.deepEqual(JSON.parse(JSON.stringify(store.list('financeiro'))),financialBefore,
  'rejeitar documento de outra clínica preserva os lançamentos locais');
store.setList('pre',[{...original,_relOrg:'org-2'}]);
assert.equal(fin.finalizacao.registrarDecisao('pre',original._id,false),null,
  'registro de outra clínica não recebe decisão');
assert.equal(staged.length,stagesBefore);
context = {...context,organizationId:'org-2',generation:2};
assert.equal(store.getById('pre',original._id),undefined,
  'trocar de organização limpa o cache de decisões junto do documento');
await new Promise(resolve => setTimeout(resolve,0));
console.log('Financial decisions VM: immutable original, audit/WAL, cancel/allow, dedupe, identity and org isolation passed');
