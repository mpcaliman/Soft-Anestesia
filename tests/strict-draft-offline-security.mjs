/** Literal Rule 4: draft/live/PDF durable payloads exist only after outage. */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readAppSource} from './helpers/read-app-source.mjs';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const arg=process.argv.find(a=>a.startsWith('--app-root='));
const root=arg?resolve(process.cwd(),arg.slice(11)):repo;
const html=await readAppSource(root);
const linker=await readFile(resolve(root,'src/domain/encounter-linker.js'),'utf8');
const vaultSource=await readFile(resolve(root,'src/platform/session-vault.js'),'utf8');
const transportSource=await readFile(resolve(root,'src/platform/cloud-first.js'),'utf8');
const object=(s,name)=>{const start=s.indexOf('const '+name+' = {');const end=s.indexOf('\n};',start);assert(start>=0&&end>start,name);return s.slice(start,end+3);};
let ctx={generation:1,userId:'doctor-a',organizationId:'clinic-a',deviceId:'device-a',tabId:'tab-a',verified:true};
const capture=()=>structuredClone(ctx),matches=c=>c&&['generation','userId','organizationId','tabId'].every(k=>c[k]===ctx[k]);
const snapshots=new Map(),keys=new Map(),disk=new Map(),server=new Map(),forms=new Map(),confirmed=new Map();
let writes=0,online=true,rejectedStatus=0;
const field={name:'paciente_nome',type:'text',value:''};
const form={dataset:{},querySelectorAll:()=>[field],querySelector:()=>field,addEventListener(){}};
forms.set('form-termo',form);
const sandbox={console,structuredClone,crypto:webcrypto,TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,Blob,atob,btoa,
  Map,Set,Promise,JSON,Date,navigator:{get onLine(){return online;}},indexedDB:{},
  localStorage:{getItem:k=>disk.get(k)??null,setItem:(k,v)=>disk.set(k,String(v)),removeItem:k=>disk.delete(k)},
  contextoAba:{atual:capture,capturar:capture,corresponde:matches,donoFila:capture,aoMudar(){},tabAtiva:()=>false},
  store:{cloudOnlyAtivo:()=>true,getById:(mod,id)=>confirmed.get(mod+':'+id)},
  auth:{usuarioAtual:()=>({id:ctx.userId,usuario:ctx.userId})},state:{dirty:true},
  cloud:{config:()=>({url:'https://unit.supabase.co',anonKey:'anon'}),session:()=>({user:{id:ctx.userId}}),_garantirToken:async()=>true,_headers:()=>({}),servidorFora:()=>false},
  cloudRel:{_capturarContexto:capture,_contextoValido:matches,_clone:structuredClone,_hashConflito:()=>'',registrarConflito(){}},
  document:{getElementById:id=>forms.get(id)||null},toast(){},utils:{escapeHTML:String,jsArg:JSON.stringify},
  setTimeout:()=>1,clearTimeout(){},window:{},fetch:async(url,opts={})=>{
    if(rejectedStatus)return{ok:false,status:rejectedStatus,json:async()=>[]};
    const parsed=new URL(url);const module=parsed.searchParams.get('module')?.slice(3);
    const id=parsed.searchParams.get('doc_id')?.slice(3);
    if(!opts.method)return{ok:true,json:async()=>[server.get([ctx.organizationId,ctx.userId,module,id].join('|'))].filter(Boolean)};
    const sent=JSON.parse(opts.body);
    const row=Array.isArray(sent)?sent[0]:{organization_id:ctx.organizationId,user_id:ctx.userId,module,doc_id:id,data:sent.data};
    const key=[row.organization_id,row.user_id,row.module,row.doc_id].join('|');
    row.version=(server.get(key)?.version||0)+1;row.updated_at='2026-10-09T00:00:00Z';row.updated_by=ctx.userId;
    server.set(key,structuredClone(row));return{ok:true,json:async()=>[structuredClone(row)]};
  }
};
sandbox.window=sandbox;sandbox.globalThis=sandbox;vm.createContext(sandbox);
vm.runInContext(object(vaultSource,'filaCifrada')+'\n'+object(transportSource,'persistenciaCloudFirst')+'\n'+
  object(linker,'rascunhosSync')+'\n'+object(linker,'rascunhos')+'\n'+object(html,'edicaoViva')+'\n'+object(html,'pdfFila')+
  '\nglobalThis.api={filaCifrada,rascunhosSync,rascunhos,edicaoViva,pdfFila};',sandbox);
const{filaCifrada:vault,rascunhosSync:sync,rascunhos:drafts,edicaoViva:live,pdfFila:pdf}=sandbox.api;
vault._driverAtual=()=>({
  async putSnapshot(reg){writes++;const old=snapshots.get(reg.snapshotId);if(old&&old.updatedAt>reg.updatedAt)return false;snapshots.set(reg.snapshotId,structuredClone(reg));return true;},
  async listSnapshots(ownerKey){return[...snapshots.values()].filter(s=>s.ownerKey===ownerKey).map(s=>structuredClone(s));}
});
vault.preparar=async()=>{const ownerKey=vault._donoKey(vault._dono());if(!keys.has(ownerKey))keys.set(ownerKey,await webcrypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']));return{ownerKey,key:keys.get(ownerKey)};};
pdf._migrarLegado=async()=>{};
pdf._loja=async()=>({getAll(){const r={};queueMicrotask(()=>{r.result=[];r.onsuccess?.();});return r;}});
const draft=(id,text,time)=>({id,updatedAt:time,dados:{paciente_nome:text}});
const initial=draft('draft-a','Clinical secret','2026-10-09T00:01:00Z');
drafts.setList('pre',[initial]);drafts.setAtivo('pre',initial.id);await drafts.aguardarPersistencia('pre');
assert.equal(writes,0,'online editing/selection creates no durable draft');assert.equal(disk.size,0);
assert.equal(await sync.enviar('pre'),1);assert.equal(writes,0,'verified online draft acknowledgement does not create snapshot');
const ack=drafts.list('pre')[0];assert.equal(ack._draftSyncedLocalAt,initial.updatedAt);
// Network outage creates ciphertext; reopening the correct owner recovers only unconfirmed work.
online=false;const changed={...ack,updatedAt:'2026-10-09T00:02:00Z',dados:{paciente_nome:'Offline clinical secret'}};
drafts.setList('pre',[changed]);await drafts.aguardarPersistencia('pre');
assert.equal((await vault.listarSnapshots('drafts'))[0].payload.lista.length,1);
assert.doesNotMatch(JSON.stringify([...snapshots.values()]),/clinical secret|Clinical secret|paciente_nome/);
ctx={...ctx,generation:2,userId:'doctor-b',tabId:'tab-b'};await drafts.restaurarCifrado();assert.equal(drafts.list('pre').length,0);
ctx={...ctx,generation:3,userId:'doctor-a',tabId:'tab-a2'};await drafts.restaurarCifrado();assert.equal(drafts.list('pre')[0].dados.paciente_nome,'Offline clinical secret');
online=true;assert.equal(await sync.enviar('pre'),1);assert.equal((await vault.listarSnapshots('drafts')).length,0);
assert([...snapshots.values()].filter(s=>s.namespace==='drafts').every(s=>s.deleted&&!s.ciphertext),'ack removes ciphertext with metadata-only late-write fence');
// Old all-confirmed snapshots are removed; opening the record is memory-only.
await vault.salvarSnapshot('drafts','consulta',{lista:[{...initial,_draftSyncedLocalAt:initial.updatedAt}],ativo:initial.id,lapides:[]});
await drafts.restaurarCifrado();assert.equal(drafts.list('consulta').length,0);assert.equal((await vault.listarSnapshots('drafts')).length,0);
const beforeRead=writes;field.value='Confirmed view';sandbox.state.dirty=false;assert.equal(live.guardar('termo'),false);assert.equal(writes,beforeRead);
sandbox.state.dirty=true;
confirmed.set('termo:signed-view',{_id:'signed-view',_finalizado:true,_relUpdatedAt:'receipt'});
form.querySelectorAll=()=>[{name:'_id',type:'hidden',value:'signed-view'},field];
assert.equal(live.guardar('termo',{mudou:true}),false,'finalized viewing never becomes live draft even if a stale dirty flag exists');
assert.equal(writes,beforeRead);form.querySelectorAll=()=>[field];
field.value='Unsaved online live edit';live.guardar('termo',{mudou:true});await live.aguardarPersistencia('termo');assert.equal(writes,beforeRead,'online live form remains volatile until cloud autosave');
assert.equal(await live._enviar('termo'),true);assert.equal((await vault.listarSnapshots('live-edit')).length,0);
online=false;field.value='Offline live clinical secret';live.guardar('termo',{mudou:true});await live.aguardarPersistencia('termo');assert.equal((await vault.listarSnapshots('live-edit'))[0].payload.dados.paciente_nome,field.value);
assert.doesNotMatch(JSON.stringify([...snapshots.values()]),/Offline live clinical secret/);
online=true;assert.equal(await live._enviar('termo'),true);assert.equal((await vault.listarSnapshots('live-edit')).length,0);
// HTTP authorization rejection cannot masquerade as offline durability.
rejectedStatus=403;field.value='Rejected online draft';const rejectBefore=writes;live.guardar('termo',{mudou:true});assert.equal(await live._enviar('termo'),false);assert.equal(writes,rejectBefore);rejectedStatus=0;
// PDF bytes and filename/patient must never enter a plaintext durable queue.
const blob=new Blob(['PRIVATE PDF BYTES'],{type:'application/pdf'});const pdfBefore=writes;
assert.equal(await pdf.guardar(blob,'patient-secret.pdf','supabase',{paciente:'Secret name'}),false);assert.equal(writes,pdfBefore);
online=false;assert.equal(await pdf.guardar(blob,'patient-secret.pdf','supabase',{paciente:'Secret name'}),true);
assert.doesNotMatch(JSON.stringify([...snapshots.values()]),/PRIVATE PDF BYTES|patient-secret|Secret name/);
assert.equal(await(await pdf.listar())[0].blob.text(),'PRIVATE PDF BYTES');
const item=(await pdf.listar())[0];ctx={...ctx,generation:4,userId:'doctor-b',tabId:'tab-b2'};assert.equal((await pdf.listar()).length,0);
ctx={...ctx,generation:5,userId:'doctor-a',tabId:'tab-a3'};assert.equal((await pdf.listar()).length,1);
pdf.MAX_ITENS=1;assert.equal(await pdf.guardar(blob,'second.pdf','supabase'),false);assert.equal((await pdf.listar()).length,1,'capacity barrier preserves oldest pending PDF');
online=true;await pdf.remover(item.id);assert.equal((await pdf.listar()).length,0);
// An encryption that began before cloud acknowledgement cannot resurrect it.
let release;const gate=new Promise(r=>{release=r;});const prepare=vault.preparar;
vault.preparar=async()=>{await gate;return prepare();};
const stale=vault.salvarSnapshot('live-edit','race',{dados:{paciente_nome:'Stale secret'}});
await vault.removerSnapshot('live-edit','race');release();await stale;
assert.equal((await vault.listarSnapshots('live-edit')).length,0,'late pre-ack encryption loses to deletion revision');
// Insert with an empty representation requires a scoped GET; errors are never absence.
const regularFetch=sandbox.fetch;
const fallbackDraft=draft('fallback-503','Unconfirmed outage draft','2026-10-09T00:06:00Z');
drafts.setList('consulta',[fallbackDraft]);
sandbox.fetch=async(url,opts={})=>opts.method
  ? {ok:true,status:201,json:async()=>[]}
  : {ok:false,status:503,json:async()=>[]};
const outageResult=await sync.gravarUnico('consulta',fallbackDraft,capture());
assert.equal(outageResult.remoteConfirmed,undefined);assert.equal(outageResult.indisponivel,true);assert.equal(outageResult.status,503);
assert.equal(await sync.enviar('consulta'),0);
const protectedFallback=(await vault.listarSnapshots('drafts')).find(s=>s.key==='consulta');
assert.equal(protectedFallback.payload.lista[0].dados.paciente_nome,'Unconfirmed outage draft',
  'POST empty then GET503 preserves the only pending draft in ciphertext');
assert.doesNotMatch(JSON.stringify([...snapshots.values()]),/Unconfirmed outage draft/);
await assert.rejects(sync._lerAtual('consulta',fallbackDraft.id,ctx.organizationId,ctx.userId,capture()),
  e=>e.name==='CloudReadError'&&e.status===503);
sandbox.fetch=async(url,opts={})=>opts.method?{ok:true,status:201,json:async()=>[]}:{ok:false,status:403};
const rejectedDraft=draft('fallback-403','Rejected scoped draft','2026-10-09T00:07:00Z');
drafts.setList('pre',[rejectedDraft]);const authorizationBefore=writes;
const rejectedRead=await sync.gravarUnico('pre',rejectedDraft,capture());
assert.equal(rejectedRead.indisponivel,false);assert.equal(rejectedRead.status,403);
assert.equal(await sync.enviar('pre'),0);assert.equal(writes,authorizationBefore,'POST empty plus GET403 cannot produce offline snapshots');
sandbox.fetch=async(url,opts={})=>({ok:true,status:opts.method?201:200,json:async()=>[]});
assert.equal(await sync._lerAtual('pre',rejectedDraft.id,ctx.organizationId,ctx.userId,capture()),null);
const trulyAbsent=await sync.gravarUnico('pre',rejectedDraft,capture());
assert.equal(trulyAbsent.ok,false);assert.equal(trulyAbsent.remoteConfirmed,undefined);assert.equal(trulyAbsent.motivo,'recibo_invalido');
assert.equal(writes,authorizationBefore,'200[] confirms absence, never a successful write');
sandbox.fetch=async()=>({ok:true,status:200,json:async()=>{throw new SyntaxError('Bad JSON');}});
await assert.rejects(sync._lerAtual('pre',rejectedDraft.id,ctx.organizationId,ctx.userId,capture()),e=>e.code==='resposta_invalida');
sandbox.fetch=async()=>({ok:true,status:200,json:async()=>[{organization_id:'other-clinic',user_id:ctx.userId,module:'pre',doc_id:rejectedDraft.id,version:1,data:{}}]});
await assert.rejects(sync._lerAtual('pre',rejectedDraft.id,ctx.organizationId,ctx.userId,capture()),e=>e.code==='resposta_invalida');
sandbox.fetch=async()=>{throw new TypeError('Failed to fetch');};
const brokenNetwork=await sync.gravarUnico('pre',rejectedDraft,capture());assert.equal(brokenNetwork.indisponivel,true);
// An outage while deleting preserves the tombstone; a denied read does not claim success.
drafts.setList('pre',[]);drafts.marcarFechado('pre','delete-pending',{_draftVersion:1,_draftOrg:ctx.organizationId});
sandbox.fetch=async()=>({ok:false,status:503});
assert.equal(await sync.apagar('pre','delete-pending',1,{contexto:capture()}),false);
assert((await vault.listarSnapshots('drafts')).find(s=>s.key==='pre').payload.lapides.some(t=>t.id==='delete-pending'));
sandbox.fetch=async()=>({ok:false,status:403});const deniedDeletionWrites=writes;
assert.equal(await sync.apagar('pre','delete-pending',1,{contexto:capture()}),false);
assert.equal(writes,deniedDeletionWrites,'denied deletion never becomes offline');
sandbox.fetch=regularFetch;
// Reading a file or uploading in an old session cannot attach it to the next user's form.
sandbox.cloud.estaLogado=()=>true;
let dirtyEvents=0;sandbox.markDirty=()=>{dirtyEvents++;};
const readers=[];sandbox.FileReader=class{constructor(){readers.push(this);}readAsDataURL(){}};
vm.runInContext(object(html,'prontuario')+'\nglobalThis.attachmentApi=prontuario;',sandbox);
const attachments=sandbox.attachmentApi;attachments.render=()=>{};
attachments.adicionar('pre',[{type:'application/pdf',name:'old-session.pdf',size:20}]);
assert.equal(readers.length,1);
ctx={...ctx,generation:6,userId:'doctor-b',tabId:'tab-b4'};
readers[0].result='data:application/pdf;base64,U0VDUkVU';readers[0].onload();
assert.equal(attachments._lista('pre').length,0,'late file read does not enter next session');
let finishUpload;attachments._upload=()=>new Promise(r=>{finishUpload=r;});
const uploading=attachments._registrar('pre','old.pdf','pdf','data:application/pdf;base64,U0VDUkVU',6,'application/pdf');
ctx={...ctx,generation:7,userId:'doctor-a',tabId:'tab-a4'};
finishUpload({path:'clinic-a/doctor-b/anexos/old'});
assert.equal(await uploading,false);assert.equal(attachments._lista('pre').length,0);assert.equal(dirtyEvents,0,
  'late upload cannot mark or paint a new user form');
console.log('  ✓ Rule 4: online drafts/live/PDF carry no durable clinical payload; outages encrypt, owner recovery is isolated and ACK removes payload');
