/** PR226: clinical corrections remain visible and safe under strict CSP. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compileStrictAssets} from '../scripts/strict-csp.mjs';
import {readAppSource} from './helpers/read-app-source.mjs';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const rootArg=process.argv.find(arg=>arg.startsWith('--app-root='));
const appRoot=rootArg?resolve(process.cwd(),rootArg.slice('--app-root='.length)):repo;
const source=await readAppSource(appRoot);
const runtime=await readFile(resolve(appRoot,'src/ui/strict-actions.js'),'utf8');
function object(name){const wrapper=name==='adendos';const start=source.indexOf('const '+name+' = '+(wrapper?'(() => {':'{'));const end=source.indexOf(wrapper?'\n})();':'\n};',start);assert(start>=0&&end>start,name);return source.slice(start,end+(wrapper?6:3));}
const payload=`Synthetic correction\nO'Connor & "Team" </div><img src=x onerror="globalThis.__adendaXss=1"><script>globalThis.__adendaXss=2</script>\u2028');evil();//`;
const record=Object.freeze({_id:'synthetic-signed',_finalizado:true,nome:'Synthetic patient',
  _adendos:Object.freeze([Object.freeze({id:'a1',data:'2026-10-09T12:00:00Z',autor:'Synthetic author & <script>',texto:payload}),
    Object.freeze({id:'a2',data:'2026-10-09T13:00:00Z',autor:'Synthetic author',texto:'Second correction: synthetic laboratory result.'})])});
const fixture=object('utils')+'\n'+object('adendos')+'\nglobalThis.renderAdenda=record=>adendos.htmlParaImpressao(record);globalThis.testAdendos=adendos;';
const html='<html><head><style>body{color:black}</style><style>.print-adendos{break-inside:avoid}</style></head><body>'
  +Array.from({length:16},(_,i)=>`<script>${i===0?fixture:''}</script>`).join('')+'</body></html>';
const compiled=compileStrictAssets(html,new Map([['src/ui/strict-actions.js',runtime]]));
assert(!compiled.policy.includes('unsafe-inline')&&!compiled.policy.includes('unsafe-eval'));
class Element{}class ShadowRoot{}class MutationObserver{observe(){}}
const document={nodeType:9,addEventListener(){}};
const sandbox=vm.createContext({window:{},document,Element,ShadowRoot,MutationObserver,console});
vm.runInContext(runtime,sandbox);sandbox.SoftActions=sandbox.window.SoftActions;
const activeRegistry=appRoot===repo?compiled.sources.get('src/ui/strict-actions.generated.js')
  :await readFile(resolve(appRoot,'src/ui/strict-actions.generated.js'),'utf8');
vm.runInContext(activeRegistry,sandbox);
vm.runInContext(appRoot===repo?compiled.sources.get('src/app/runtime-01.js'):fixture,sandbox);
const before=JSON.stringify(record);const rendered=sandbox.renderAdenda(record);
assert.equal(JSON.stringify(record),before,'rendering cannot mutate the signed original or its corrections');
assert.match(rendered,/ADENDOS \/ CORREÇÕES — 2/);assert.match(rendered,/original, preservado/);
assert.match(rendered,/Synthetic author &amp; &lt;script&gt;/);
assert.match(rendered,/&lt;img src=x onerror=&quot;/);assert.match(rendered,/&lt;script&gt;/);
assert.match(rendered,/Second correction: synthetic laboratory result\./);
assert.doesNotMatch(rendered,/<(?:script|img)\b/i);assert.doesNotMatch(rendered,/\s(?:style|on\w+)=['"]/i);
assert.equal(sandbox.__adendaXss,undefined);assert.equal(sandbox.renderAdenda(null),'');
assert.equal(sandbox.renderAdenda({_id:'synthetic-new'}),'');
// The external CSP runtime materializes authored styles through CSSOM.
const authored=[...rendered.matchAll(/data-soft-style="([^"]+)"/g)].map(m=>m[1]);
const ninePoint=authored.find(css=>/^font-size:9pt;/.test(css));
assert(ninePoint,'compiled correction text retains a 9pt authored style');
assert(authored.some(css=>css.includes('border:1px solid #8a1c1c')));assert(ninePoint.includes('white-space:pre-wrap'));
const item=new Element();item.nodeType=1;item.tagName='DIV';item.style={};
const attributes=new Map([['data-soft-style',ninePoint]]);
item.hasAttribute=name=>attributes.has(name);item.getAttribute=name=>attributes.get(name);
item.removeAttribute=name=>attributes.delete(name);item.attributes=[];
sandbox.SoftActions.scan(item);
assert.equal(item.style.cssText,ninePoint,'external runtime applies the complete legible style through CSSOM');
assert.equal(item.hasAttribute('data-soft-style'),false);
console.log('✓ PR226: corrections stay legible, counted, escaped and immutable after strict CSP compilation');

// PR227 compatibility: current clinical values come from accepted append-only
// events. The signed record, patient/case references and signatures stay intact.
const engine=sandbox.testAdendos;
let proofContext={verified:true,organizationId:'synthetic-org',userId:'synthetic-user',
  tabId:'synthetic-tab',deviceId:'synthetic-device',generation:1};
sandbox.contextoAba={capturar:()=>({...proofContext}),corresponde:c=>c.organizationId===proofContext.organizationId&&
  c.userId===proofContext.userId&&c.generation===proofContext.generation,organizationId:()=>proofContext.organizationId};
sandbox.store={list:()=>[],setList:()=>{}};sandbox.state={currentModule:'none'};
const trusted=row=>{engine.receberLinha(row);return engine._daLinha(row);};
const makeRow=(id,base,campos,revision,status='accepted',head=base)=>({
  organization_id:'synthetic-org',legacy_id:id,parent_table:'preanesthetic_assessments',parent_id:'synthetic-parent-uuid',parent_legacy_id:'synthetic-signed',
  reason:'correcao',texto:'Synthetic correction '+id,author_id:'synthetic-user-'+id,
  created_at:'2026-10-09T14:00:00Z',retification_revision:status==='accepted'?revision:null,
  data:{autor_exibicao:'Synthetic author '+id,retificacao:{schema:1,baseAdendoId:base,
    campos,status,revisao:revision,baseAtualId:head}}
});
const first=trusted(makeRow('accepted-1','',{nome:'Paciente Sintético Atual',cpf:'00000000000',
  lab_hb:'14,6',_labExtras:[{nome:'Exame sintético',valor:'32'}]},1));
const second=trusted(makeRow('accepted-2','accepted-1',{lab_hb:'15,0'},2));
const conflict=trusted(makeRow('conflict-1','',{lab_hb:'99,9'},2,'conflict','accepted-2'));
const pending={id:'pending-1',_pushed:false,texto:'Synthetic offline proposal',
  _retificacao:{schema:1,baseAdendoId:'accepted-2',campos:{lab_hb:'88,8'}}};
const signed=Object.freeze({_id:'synthetic-signed',_finalizado:true,nome:'Paciente Sintético',cpf:'11111111111',
  lab_hb:'13,2',_patientRef:'synthetic-patient-uuid',_patientKey:'synthetic-identity-key',
  _caseId:'synthetic-case-uuid',_relVersion:7,assinatura_dataurl:'synthetic-signature',
  _adendos:Object.freeze([Object.freeze(second),Object.freeze(pending),Object.freeze(first),Object.freeze(conflict)])});
const signedSnapshot=JSON.stringify(signed);
const projected=engine.vigente('pre',signed);
assert.equal(projected.lab_hb,'15,0');assert.equal(projected.nome,'Paciente Sintético Atual');
assert.equal(projected.cpf,'00000000000');assert.equal(projected._labExtras[0].valor,'32');
for(const key of ['_id','_patientRef','_patientKey','_caseId','_relVersion','assinatura_dataurl'])
  assert.equal(projected[key],signed[key],key+' cannot be replaced by a current clinical projection');
assert.equal(projected._retificadoPor,'synthetic-user-accepted-2');
assert.equal(projected._retificacoes,2);assert.equal(JSON.stringify(signed),signedSnapshot);
const currentState=engine.estadoRetificacoes(signed,'pre');
assert.equal(currentState.headId,'accepted-2');assert.equal(currentState.aplicadas.length,2);
assert.equal(currentState.conflitos.length,1);assert.equal(currentState.pendentes.length,1);
assert.match(engine._render(conflict),/campos não aplicados/);assert.match(engine._render(pending),/ainda não confirmados/);
const competing=trusted(makeRow('branch','',{lab_hb:'77,7'},1));
const forked=engine.estadoRetificacoes({...signed,_adendos:[first,competing]},'pre');
assert.equal(forked.vigente.lab_hb,'13,2');assert.equal(forked.conflitos.length,2,
  'two accepted branches never select a winner from event order');
const orphaned=engine.estadoRetificacoes({...signed,_adendos:[second]},'pre');
assert.equal(orphaned.vigente.lab_hb,'13,2');assert.equal(orphaned.conflitos.length,1);
const unsupportedProof=makeRow('unproved','',{lab_hb:'66,6'},1);delete unsupportedProof.retification_revision;
const historical=engine._daLinha(unsupportedProof);
assert.equal(engine.estadoRetificacoes({...signed,_adendos:[historical]},'pre').vigente.lab_hb,'13,2',
  'historical JSON claiming accepted cannot replace the server revision column');
for(const campos of [{_patientRef:'other-patient'},{paciente:{patient_id:'other-patient'}},
  {assinatura_dataurl:'different-signature'},{data_assinatura:'different-time'},
  JSON.parse('{"lab":{"__proto__":{"polluted":true}}}'),{_arbitrarySecret:'token'},
  {_labExtras:[{constructor:{prototype:{polluted:true}}}]}]) {
  assert.equal(engine._normalizarRetificacao({schema:1,baseAdendoId:'',campos}),null);
}
const validRow=makeRow('receipt-1','',{lab_hb:'14,6',nome:'Paciente Sintético Atual'},1);
const proposal={schema:1,baseAdendoId:'',campos:{nome:'Paciente Sintético Atual',lab_hb:'14,6'}};
assert(engine.propostaRetificacaoIgual(proposal,validRow.data.retificacao,validRow));
assert(!engine.propostaRetificacaoIgual({...proposal,campos:{lab_hb:'different'}},validRow.data.retificacao,validRow));
assert(!engine.propostaRetificacaoIgual({...proposal,baseAdendoId:'other-base'},validRow.data.retificacao,validRow));
assert(!engine.propostaRetificacaoIgual(proposal,{...validRow.data.retificacao,status:'client-guessed'},validRow));

// An open form retains its expected base even when a remote author advances
// the record. A stale edit becomes a preserved conflict, never a blind rebase.
const records=[JSON.parse(signedSnapshot)];let parentWrites=0,cloudNotifications=0;
const openForm={dataset:{retificacaoRegistro:'synthetic-signed',retificacaoBaseId:''}};
sandbox.document.getElementById=id=>id==='form-pre'?openForm:null;
sandbox.store={list:()=>records,getById:()=>records[0],setList:()=>{},_marcarPendente:()=>{},
  save(){parentWrites++;throw Error('Finalized parent cannot be written');},
  notificarNuvem(){cloudNotifications++;}};
sandbox.auth={usuarioAtual:()=>({nome:'Synthetic local author'})};sandbox.toast=()=>{};
engine._push=()=>Promise.resolve();engine.renderInline=()=>{};
engine.salvarComoCorrecao('pre',records[0],{...projected,lab_hb:'16,1',_patientRef:'wrong-patient',
  assinatura_dataurl:'wrong-signature'});
const submitted=records[0]._adendos.at(-1);
assert.equal(parentWrites,0);assert.equal(cloudNotifications,1);assert.equal(records[0].lab_hb,'13,2');
assert.equal(submitted._retificacao.baseAdendoId,'');assert.equal(submitted._retificacao.campos.lab_hb,'16,1');
assert.equal(submitted._retificacao.campos._patientRef,undefined);
assert.equal(submitted._retificacao.campos.assinatura_dataurl,undefined);
assert.equal(engine.vigente('pre',records[0]).lab_hb,'15,0','in-flight data is not a confirmed clinical value');

// Reopen/save round trips may populate empty rows and recalculate summaries.
// Neither action is a new clinical decision. Real fluid input and long-note
// changes still create complete append-only proposals.
const originalRecord=records[0];
const roundtrip={_id:'synthetic-roundtrip',_finalizado:true,
  paciente:{nome:'Paciente Sintético',peso:70},
  fluidos:{cristaloides:'1000',observacoes:'Fluidoterapia sintética original'},
  conclusao:{descricao_livre:'A'.repeat(240)},_labExtras:[{nome:'Exame sintético',valor:'1'}],_adendos:[]};
records[0]=roundtrip;
const restored={...roundtrip,paciente:{nome:'Paciente Sintético',peso:'70',nascimento:''},
  monitorizacao:{monitores:[],dispositivos:[]},medicacoes:[{hora:'',nome:'',dose:''}],
  fluidos:{...roundtrip.fluidos,total_entradas:'1000 mL',total_saidas:'0 mL',balanco:'1000 mL',
    total_infundido:'1000 mL',deficit_acum:'0 mL',reposicao_sug:'sem déficit relevante',insens_total:''}};
const noticesBefore=cloudNotifications;
engine.salvarComoCorrecao('anestesia',roundtrip,restored);
assert.equal(roundtrip._adendos.length,0,'reopening and saving unchanged data does not create a correction');
assert.equal(cloudNotifications,noticesBefore);
engine.salvarComoCorrecao('anestesia',roundtrip,{...restored,
  fluidos:{...restored.fluidos,cristaloides:'1500',hidratacao:[{hora:'12:00',tipo:'Cristaloide',volume:'500'}],
    observacoes:'Volume clínico sintético revisto',total_entradas:'1500 mL'},
  conclusao:{descricao_livre:'B'.repeat(240)},_labExtras:[{nome:'Exame sintético',valor:2}]});
assert.equal(roundtrip._adendos.length,1);
const changedClinical=roundtrip._adendos[0]._retificacao.campos;
assert.equal(changedClinical.fluidos.cristaloides,'1500');assert.equal(changedClinical.fluidos.total_entradas,'1500 mL');
assert.equal(changedClinical.fluidos.hidratacao[0].volume,'500');
assert.equal(changedClinical.conclusao.descricao_livre,'B'.repeat(240),
  'long notes must be compared in full, never through a truncated display diff');
assert.equal(changedClinical._labExtras[0].valor,2,'structured clinical extras preserve their JSON types');
assert.equal(roundtrip.fluidos.cristaloides,'1000');assert.equal(roundtrip.conclusao.descricao_livre,'A'.repeat(240));
records[0]=originalRecord;

const forged={...first,id:'forged-new',_retificacao:{...first._retificacao,campos:{lab_hb:'forged-value'}}};
assert.equal(engine.vigente('pre',{...signed,_adendos:[forged]}).lab_hb,'13,2',
  'serialized parent JSON cannot confer server receipt authority');
// The actual transport sends only the structured proposal. Canonical status
// and revision must originate at the server, including when replaying a WAL.
let sentBody;const context={...proofContext};
sandbox.persistenciaCloudFirst={TRANSPORTE_ADENDO:'synthetic-addendum'};
sandbox.cloud={_garantirToken:async()=>true,config:()=>({url:'https://synthetic.invalid'}),_headers:()=>({})};
sandbox.cloudRel={_contextoValido:()=>true,_lerAtualTab:async()=>({id:validRow.parent_id,finalized_at:'2026-10-09'})};
sandbox.fetch=async(url,init)=>{sentBody=JSON.parse(init.body);return{ok:true,json:async()=>[validRow]};};
const transported=await engine.enviarOperacao({contexto:context,payload:{transport:'synthetic-addendum',parentModule:'pre',
  parentTable:'preanesthetic_assessments',parentLegacyId:'synthetic-signed',
  adendo:{id:'receipt-1',texto:validRow.texto,motivo:'correcao',_retificacao:{...proposal,status:'accepted',revisao:100}}}});
assert.equal(transported.ok,true,'the transport returns the receipt only for its actual fetched parent');
assert.deepEqual(Object.keys(sentBody[0].data.retificacao).sort(),['baseAdendoId','campos','schema']);
assert.equal(sentBody[0].data.retificacao.campos.lab_hb,'14,6');
sandbox.fetch=async()=>({ok:true,json:async()=>[{...validRow,parent_id:'other-parent'}]});
const wrongParent=await engine.enviarOperacao({contexto:context,payload:{transport:'synthetic-addendum',parentModule:'pre',
  parentTable:'preanesthetic_assessments',parentLegacyId:'synthetic-signed',
  adendo:{id:'receipt-1',texto:validRow.texto,motivo:'correcao',_retificacao:proposal}}});
assert.equal(wrongParent.ok,false);assert.equal(wrongParent.motivo,'recibo_pai_divergente');
const untrusted=engine._daLinha(makeRow('untrusted-serialized','',{lab_hb:'forged-untrusted'},1));
assert.equal(engine.estadoRetificacoes({...signed,_adendos:[untrusted]},'pre').vigente.lab_hb,'13,2');
const changedText={...first,texto:'Forged audit text'};
assert.equal(engine.estadoRetificacoes({...signed,_adendos:[changedText]},'pre').vigente.lab_hb,'13,2');
assert.equal(engine.vigente('consulta',signed).lab_hb,'13,2','a receipt for pre cannot authorize a consultation');
assert.equal(engine.vigente('pre',{...signed,_relId:'different-parent-uuid'}).lab_hb,'13,2');
const changedDisplay={...first,autor:'FORGED DISPLAY LABEL',data:'2099-01-01'};
assert.equal(engine.vigente('pre',{...signed,_adendos:[changedDisplay]})._retificadoPor,first._authorId);
const fakeState=engine.estadoRetificacoes({...signed,_adendos:[untrusted]},'pre');
assert.match(engine._render(untrusted,fakeState),/Origem não confirmada/);
assert.doesNotMatch(engine._render(untrusted,fakeState),/☁️/);
proofContext={...proofContext,userId:'other-synthetic-user',generation:2};
assert.equal(engine.vigente('pre',signed).lab_hb,'13,2','proofs are not inherited by another user');
proofContext={...context};
assert.equal(engine.vigente('pre',signed).lab_hb,'13,2','returning to a prior context does not resurrect erased proofs');
console.log('✓ PR227: accepted current values, immutable parent/FKs/signature, stale-base conflict and canonical receipts');
