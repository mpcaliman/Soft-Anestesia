import { readAppSource, readCompiledActions } from './helpers/read-app-source.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootArg = process.argv.find(arg => arg.startsWith('--app-root='));
const appRoot = rootArg ? resolve(process.cwd(), rootArg.slice('--app-root='.length)) : repo;
const indexArg = process.argv.find(arg => arg.startsWith('--index='));
const html = indexArg ? await readFile(indexArg.slice('--index='.length), 'utf8') : await readAppSource(appRoot);
const SoftActions = await readCompiledActions(appRoot);
const vaultSource = await readFile(resolve(appRoot, 'src/platform/session-vault.js'), 'utf8');
function objectSource(text, name) {
  const start = text.indexOf('const ' + name + ' = {');
  const end = text.indexOf('\n};',start);
  assert(start >= 0 && end > start,name + ' deve existir');
  return text.slice(start,end + 3);
}
let context = {userId:'doctor-1',organizationId:'org-1',deviceId:'device-1',tabId:'tab-1',generation:1};
const current = () => ({...context});
const matches = ctx => !!ctx && ['userId','organizationId','tabId','generation']
  .every(key => ctx[key] === context[key]);
const cfg = new Map();
const records = new Map();
const snapshots = new Map();
const blobs = new Map();
const keys = new Map();
const nodes = new Map();
const notices = [];
const cleaned = [];
let abortNext = false;
let nextBlobId = 0;
let wakeGenerator;
let generatorStarted;
const waitingForGenerator = () => new Promise(resolve => {generatorStarted = resolve;});
const sandbox = vm.createContext({ SoftActions,
  console,crypto:webcrypto,TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,Blob,atob,btoa,structuredClone,
  localStorage: {
    getItem: key => cfg.get(context.organizationId + '|' + key) ?? null,
    setItem: (key,value) => cfg.set(context.organizationId + '|' + key,String(value)),
    removeItem: key => cfg.delete(context.organizationId + '|' + key)
  },
  sessionStorage: {removeItem() {}}, indexedDB:{},
  setTimeout(fn,ms) {
    if (ms === 700) {wakeGenerator = fn; generatorStarted?.(); return 1;}
    return setTimeout(fn,ms);
  },
  clearTimeout,window:{},state:{dirty:false,currentModule:'ajustes'},
  document:{getElementById:id => nodes.get(id) || null},
  toast: message => notices.push(message),markClean() {sandbox.state.dirty = false;},
  utils:{escapeHTML:String,clearForm:id => cleaned.push(id)},
  auth:{usuarioAtual:() => ({id:context.userId})},
  contextoAba:{capturar:current,atual:current,donoFila:current,operational:() => true,
    corresponde:matches,tabAtiva:() => false},
  cloudRel:{_contextoValido:matches},
  rascunhosSync:{_indisponivel:(res,error) => !!error && /network|failed to fetch/i.test(error.message || '')},
  cloud:{estaConfigurado:() => true,estaLogado:() => true},
  historico:{_dataItem:rec => rec.data},arquivo:{_nomeDe:rec => rec.nome},
  store:{list:mod => structuredClone(records.get(context.organizationId + '|' + mod) || []),
    getById:(mod,id) => sandbox.store.list(mod).find(rec => rec._id === id),
    save() {throw new Error('regenerar não pode regravar documento canônico');}},
  anestesia:{limparSilencioso:() => cleaned.push('anestesia')}
});
vm.runInContext(objectSource(vaultSource,'filaCifrada') + '\n' + objectSource(html,'pdfFila') +
  '\n' + objectSource(html,'pdfBackup') + '\nglobalThis.api = {filaCifrada,pdfFila,pdfBackup};',sandbox);
const {filaCifrada:vault,pdfFila:queue,pdfBackup:backup} = sandbox.api;

/* Run the actual AES-GCM snapshot implementation. The driver is in memory;
   only authentication/key retrieval is replaced at this test boundary. */
vault._driverAtual = () => ({
  async putSnapshot(value) {
    if(abortNext){abortNext=false;throw new Error('IndexedDB transaction aborted');}
    const old=snapshots.get(value.snapshotId);if(old && old.updatedAt > value.updatedAt)return false;
    snapshots.set(value.snapshotId,structuredClone(value)); return true;},
  async listSnapshots(ownerKey) {return [...snapshots.values()].filter(s => s.ownerKey === ownerKey).map(value => structuredClone(value));}
});
vault.preparar = async () => {
  const ownerKey = vault._donoKey(vault._dono());
  if (!keys.has(ownerKey)) keys.set(ownerKey,await webcrypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']));
  return {ownerKey,key:keys.get(ownerKey)};
};
queue._migrarLegado = async () => {};
/* The fake IDB deliberately permits request success followed by transaction
   abort, which must NEVER be advertised as a durable PDF. */
queue._loja = async () => {
  const transaction = {};
  const request = () => ({});
  return {
    transaction,
    put(item) {
      const req = request();
      const shouldAbort = abortNext; abortNext = false;
      queueMicrotask(() => {
        req.onsuccess?.();
        if (shouldAbort) transaction.onabort?.();
        else {blobs.set(item.id || 'pdf-' + (++nextBlobId),structuredClone(item));transaction.oncomplete?.();}
      });
      return req;
    },
    getAll() {const req = request();queueMicrotask(() => {req.result = [...blobs.values()].map(value => structuredClone(value));req.onsuccess?.();});return req;},
    delete(id) {const req = request();queueMicrotask(() => {blobs.delete(id);req.onsuccess?.();});return req;}
  };
};
const record = {_id:'signed-1',nome:'Patient Secret',data:'2026-09-01',_finalizado:true,
  _finalizadoEm:'2026-09-01T12:00:00Z',_patientRef:'patient-1',_caseId:'case-1',
  _adendos:[{id:'ad-1',texto:'Secret correction'}]};
records.set('org-1|pre',[record]);
const realGenerator = backup.regen._gerar;
backup.regen._gerar = async (mod,rec) => ({nomeArq:mod + '-' + rec._id + '.pdf',
  doc:{output:() => new Blob([rec.nome + ':' + rec._id + ':' + rec._adendos[0].texto],{type:'application/pdf'})}});
let sent = 0;
backup.enviarSupabase = async () => {sent++;return true;};
backup.salvarCfg({supabase:true,drive:false});
await backup.regen.rodar({de:'2026-09-01',ate:'2026-09-30'});
assert.equal(sent,1);
assert.equal(snapshots.size,1);
assert.deepEqual(sandbox.store.getById('pre',record._id),record,
  'regenerar conserva todo o original, carimbo e adendos');
assert.doesNotMatch(JSON.stringify([...snapshots.values()]),/Patient Secret|Secret correction/,
  'recibos com referências ao documento ficam cifrados, sem dados clínicos em claro');
assert.equal((await vault.listarSnapshots(backup.regen.RECIBOS_NS))[0].payload.remoto,true);

/* Clear RAM and restore receipts as after reopening the same authenticated
   device. The PDF stays deduplicated without touching the clinical record. */
backup.regen._recibos.clear();
await backup.regen.rodar({de:'2026-09-01',ate:'2026-09-30'});
assert.equal(sent,1,'segunda passada/restauração não repete upload confirmado');
await backup.regen.rodar({de:'2026-09-01',ate:'2026-09-30',forcar:true});
assert.equal(sent,2,'forçar permite repetir deliberadamente');

backup.enviarSupabase = async (blob,name,owner,operation={}) => {sent++;operation.falha?.(new TypeError('Failed to fetch'));return false;};
await backup.regen.rodar({de:'2026-09-01',ate:'2026-09-30',forcar:true});
assert.equal((await queue.listar()).length,1);
const queuedReceipt = (await vault.listarSnapshots(backup.regen.RECIBOS_NS))[0].payload;
assert.equal(queuedReceipt.remoto,false,'fila durável não é confirmação de upload');
assert.equal(queuedReceipt.queued,true);
await backup.regen.rodar({de:'2026-09-01',ate:'2026-09-30'});
assert.equal(sent,3,'cópia pendente já durável não é regenerada à toa');
await queue.limpar();
await backup.regen.rodar({de:'2026-09-01',ate:'2026-09-30'});
assert.equal(sent,4,'fila descartada não impede recuperar um PDF ainda não enviado');

/* IDB request success without transaction commit must report failure. */
abortNext = true;
const receiptCount = snapshots.size;
const failed = await backup.enviarTodos({output:() => new Blob(['PDF'])},'failed.pdf');
assert.equal(failed.durable,false);
assert.equal(failed.ok,false);
assert.equal(await backup.regen._guardarRecibo(current(),'failure','failure',failed),false);
assert.equal(snapshots.size,receiptCount,'falha sem cópia durável não fabrica recibo');

/* Confirmed drain promotes only that destination. Reopening after the
   queued PDF is delivered must keep the now-remote receipt deduplicated. */
backup.enviarSupabase = async () => {sent++;return true;};
const drained = await backup.drenarFila();
assert.equal(drained.enviados,1);
assert.equal(drained.restam,0);
const afterDrain = (await vault.listarSnapshots(backup.regen.RECIBOS_NS))[0].payload;
assert.equal(afterDrain.remoto,true,'upload confirmado promove recibo pendente para remoto');
assert.equal(afterDrain.queued,false);
assert.equal(afterDrain.destinos[0].destino,'supabase');
assert.equal(afterDrain.destinos[0].remoto,true);
backup.regen._recibos.clear();
const countAfterDrain = sent;
await backup.regen.rodar({de:'2026-09-01',ate:'2026-09-30'});
assert.equal(sent,countAfterDrain,'recibo remoto reidratado não repete PDF já entregue pela fila');

/* With two expected destinations, discarding Drive is not evidence that
   Drive received it. Only Supabase's later confirmed upload is promoted. */
backup.salvarCfg({supabase:true,drive:true,driveClientId:'test-drive'});
backup.enviarSupabase = async (blob,name,owner,operation={}) => {sent++;operation.falha?.(new TypeError('Failed to fetch'));return false;};
backup.enviarDrive = async (blob,name,interactive,operation={}) => {operation.falha?.(new TypeError('Failed to fetch'));return false;};
await backup.regen.rodar({de:'2026-09-01',ate:'2026-09-30',forcar:true});
const bothQueued = await queue.listar();
assert.equal(bothQueued.length,2);
const driveItem = bothQueued.find(item => item.destino === 'drive');
const multiKey = driveItem.receiptKey;
await queue.remover(driveItem.id);
backup.enviarSupabase = async () => {sent++;return true;};
const partialDrain = await backup.drenarFila();
assert.equal(partialDrain.enviados,1);
assert.equal(partialDrain.restam,0);
const partialReceipt = (await vault.listarSnapshots(backup.regen.RECIBOS_NS))
  .find(snap => snap.key === multiKey).payload;
assert.equal(partialReceipt.destinos.find(d => d.destino === 'supabase').remoto,true);
assert.equal(partialReceipt.destinos.find(d => d.destino === 'drive').remoto,false);
assert.equal(partialReceipt.remoto,false,'ausência do Drive descartado não confirma ambos os destinos');
backup.regen._recibos.clear();
await backup.regen._carregarRecibos(current());
assert.equal(backup.regen.candidatos('2026-09-01','2026-09-30',false).length,1,
  'o destino perdido continua recuperável após restaurar os recibos');
assert.equal(await backup.regen._confirmarDestino(current(),multiKey,'unknown'),false);
backup.salvarCfg({supabase:true,drive:false});

const beforeDirty = sent;
sandbox.state.dirty = true;
await backup.regen.rodar({forcar:true});
assert.equal(sent,beforeDirty,'alteração na tela bloqueia regeneração');
sandbox.state.dirty = false;

/* Same labels/IDs in another org/user/device receive no old receipts. */
context = {...context,organizationId:'org-2',generation:2};
backup.invalidarContexto();
records.set('org-2|pre',[record]);
await backup.regen._carregarRecibos(current());
assert.equal(backup.regen._recibos.size,0);
assert.equal(backup.regen.candidatos('2026-09-01','2026-09-30',false).length,1);
context = {...context,organizationId:'org-1',userId:'doctor-2',generation:3};
backup.invalidarContexto();
await backup.regen._carregarRecibos(current());
assert.equal(backup.regen._recibos.size,0,'outro usuário não herda recibos');
context = {...context,userId:'doctor-1',deviceId:'device-2',generation:4};
backup.invalidarContexto();
await backup.regen._carregarRecibos(current());
assert.equal(backup.regen._recibos.size,0,'dedupe local não promete recibo de outro aparelho');

/* Changing sessions during the real delayed builder cannot paint, restore
   ppp, or generate the earlier patient's PDF in the new session. */
backup.regen._gerar = realGenerator;
let built = 0;
const ppp = {innerHTML:'OLD USER MARKUP'};
nodes.set('ppp',ppp);
sandbox.window.pre = {carregar() {}};
sandbox.window.jspdf = {jsPDF:class {}};
sandbox.printPreview = {_buildPre:() => {built++;return 'OLD PATIENT PDF';}};
const builderWaiting = waitingForGenerator();
const building = backup.regen._gerar('pre',record,current());
await builderWaiting;
context = {...context,userId:'doctor-3',generation:5};
backup.invalidarContexto();
ppp.innerHTML = 'NEW USER MARKUP';
wakeGenerator();
assert.equal(await building,null);
assert.equal(built,0);
assert.equal(ppp.innerHTML,'NEW USER MARKUP','builder tardio não restaura HTML clínico antigo');

/* Late upload failure after logout cannot enqueue in the new user's queue. */
let releaseUpload;
backup.enviarSupabase = () => new Promise(resolve => {releaseUpload = resolve;});
const queueSize = blobs.size;
const uploading = backup.enviarTodos({output:() => new Blob(['old patient'])},'old.pdf');
await Promise.resolve();
context = {...context,userId:'doctor-4',generation:6};
backup.invalidarContexto();
releaseUpload(false);
assert.equal((await uploading).durable,false);
assert.equal(blobs.size,queueSize);
assert.deepEqual(sandbox.store.getById('pre',record._id),record);

/* A receipt lookup started in the previous session cannot write a promoted
   snapshot or populate the next user's memory after its delayed read. */
const realListSnapshots = vault.listarSnapshots;
let releaseReceiptRead;
vault.listarSnapshots = () => new Promise(resolve => {releaseReceiptRead = resolve;});
const receiptContext = current();
const beforePromotion = snapshots.size;
const promoting = backup.regen._confirmarDestino(receiptContext,'receipt-race','drive');
context = {...context,userId:'doctor-5',generation:7};
backup.invalidarContexto();
releaseReceiptRead([{key:'receipt-race',payload:{assinatura:'race',
  organizationId:receiptContext.organizationId,userId:receiptContext.userId,
  destinos:[{destino:'drive',remoto:false}]}}]);
assert.equal(await promoting,false);
assert.equal(snapshots.size,beforePromotion);
assert.equal(backup.regen._recibos.size,0,'resposta tardia não promove recibo na memória do novo dono');
vault.listarSnapshots = realListSnapshots;
console.log('PDF regeneration VM: encrypted receipts, restored dedupe after drain, destination confirmation, IDB abort and session races passed');
