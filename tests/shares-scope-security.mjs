import { readAppSource, readCompiledActions } from './helpers/read-app-source.mjs';
/** Regra 2: exceção entre clínicas exige decisão manual, escopo e prazo. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv.find(x => x.startsWith('--app-root='));
const appRoot = arg ? resolve(process.cwd(),arg.slice('--app-root='.length)) : repo;
const html = await readAppSource(appRoot);
const SoftActions = await readCompiledActions(appRoot);
const migration = await readFile(resolve(repo,'database/migrations/0028_programmer_scoped_org_shares.sql'),'utf8');
const drafts = await readFile(resolve(repo,'database/migrations/0029_cloud_live_draft_modules.sql'),'utf8');
const start = html.indexOf('const programador = {');
const end = html.indexOf('\n};',start);
assert(start >= 0 && end > start);
const fields = new Map();
let checked = ['anestesia'], programmer = true, confirmed = true;
let revokeReason = 'Encerramento da autorização temporária';
const calls = [], notices = [];
const escape = text => String(text ?? '').replace(/[&<>"']/g,c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sandbox = vm.createContext({ SoftActions,
  console, document: {
    getElementById:id => fields.has(id) ? {value:fields.get(id)} : null,
    querySelectorAll:() => checked.map(value=>({value}))
  },
  toast:(...args)=>notices.push(args),confirm:()=>confirmed,prompt:()=>revokeReason,
  utils:{escapeHTML:escape,jsArg:text=>JSON.stringify(String(text))}
});
vm.runInContext(html.slice(start,end+3)+'\nglobalThis.api=programador;',sandbox);
const programador = sandbox.api;
programador.souProgramador=()=>programmer;
programador.render=async()=>{};
programador._rpc=async(name,body)=>{calls.push({name,body:JSON.parse(JSON.stringify(body))}); return true;};
programador._mostrarErro=message=>notices.push(['error',message]);
const reset=()=>{
  calls.length=0; notices.length=0; checked=['anestesia']; programmer=true; confirmed=true;
  fields.set('prog-share-origem','org-a'); fields.set('prog-share-destino','org-b');
  fields.set('prog-share-motivo','Leitura temporária autorizada para revisão');
  fields.set('prog-share-expira',new Date(Date.now()+86400000).toISOString());
};
for (const invalidate of [
  ()=>{programmer=false;},()=>{fields.set('prog-share-origem','');},
  ()=>{fields.set('prog-share-destino','org-a');},()=>{checked=[];},
  ()=>{checked=['ajustes'];},()=>{fields.set('prog-share-motivo','');},
  ()=>{fields.set('prog-share-expira','');},
  ()=>{fields.set('prog-share-expira',new Date(Date.now()-1000).toISOString());},
  ()=>{fields.set('prog-share-expira',new Date(Date.now()+91*86400000).toISOString());},
  ()=>{confirmed=false;}
]) {
  reset(); invalidate(); await programador.criarShare();
  assert.equal(calls.length,0,'entrada inválida/cancelada não solicita autorização');
}
reset(); checked=['anestesia','pre','anestesia'];
await programador.criarShare();
assert.equal(calls.length,1);
assert.equal(calls[0].name,'prog_authorize_org_share');
assert.deepEqual(calls[0].body.p_modulos,['anestesia','pre']);
assert.equal(calls[0].body.p_org_origem,'org-a');
assert.equal(calls[0].body.p_org_destino,'org-b');
assert.equal(calls[0].body.p_motivo,fields.get('prog-share-motivo'));
assert(Date.parse(calls[0].body.p_expira_em)>Date.now());
assert.equal(calls[0].body.user_id,undefined,'o autor é derivado no servidor');
reset(); revokeReason='curto'; await programador.removerShare('share-1');
assert.equal(calls.length,0);
revokeReason='Encerramento da autorização temporária';
await programador.removerShare('share-1');
assert.equal(calls[0].name,'prog_revoke_org_share');
assert.equal(calls[0].body.p_share_id,'share-1');
assert.equal(calls[0].body.p_motivo,revokeReason);

programador._orgs=[{id:'org-a',nome:'Origem'},{id:'org-b',nome:'Destino'}];
programador._shares=[
  {id:'legacy',org_origem:'org-a',org_destino:'org-b',modulos:[]},
  {id:'active',org_origem:'org-a',org_destino:'org-b',modulos:['pre'],ativo:true,
   expira_em:new Date(Date.now()+86400000).toISOString(),motivo:'<img src=x onerror=alert(1)>'}
];
const box={innerHTML:''}; programador._renderConteudo(box);
assert.match(box.innerHTML,/Inativo — exige reaprovação/);
assert.match(box.innerHTML,/Sem escopo autorizado/);
assert.match(box.innerHTML,/Somente leitura/);
assert.match(box.innerHTML,/&lt;img src=x onerror=alert\(1\)&gt;/);
assert.doesNotMatch(box.innerHTML,/<img src=x/);
assert.doesNotMatch(html,/nenhum marcado = todos/);

// Contratos SQL complementam os testes de UI. Integração RLS real permanece
// uma verificação separada em staging; estas asserções não a substituem.
assert.match(migration,/ativo boolean not null default false/i);
assert.match(migration,/array_position\(p_modulos,null\) is not null/i);
assert.match(migration,/p_expira_em > statement_timestamp\(\) \+ interval '90 days'/i);
assert.match(migration,/s\.expira_em > statement_timestamp\(\)/i);
assert.match(migration,/app\.pode_modulo\(s\.org_destino,p_modulo\)/i);
assert.doesNotMatch(migration,/cardinality\(s\.modulos\) = 0 or/i);
assert.match(migration,/auth\.uid\(\) is null or not app\.eh_programador\(\)/i);
assert.match(migration,/revoke insert,update,delete,truncate on table public\.org_shares/i);
assert.match(migration,/insert into public\.audit_logs/i);
for(const action of ['org_share_authorized','org_share_reauthorized','org_share_revoked','org_share_expired']) assert(migration.includes(action));
assert.match(migration,/new\.org_origem is distinct from old\.org_origem/i);
assert.match(migration,/new\.org_destino is distinct from old\.org_destino/i);
assert.match(migration,/new\.criado_por is distinct from old\.criado_por/i);
assert.match(migration,/Revogue o compartilhamento; seu histórico não pode ser apagado/i);
assert.match(drafts,/user_id = \(select auth\.uid\(\)\)/i);
assert.match(drafts,/organization_id in \(select app\.org_ids\(\)\)/i);
assert.match(drafts,/app\.pode_editar_modulo\(organization_id,app\.draft_permission_module\(module\)\)/i);
assert.doesNotMatch(drafts,/security definer/i);
for(const mod of ['termo','prescricao','risco','documentos','orcamento','financeiro','agenda']) assert(drafts.includes("'live:"+mod+"'"));
console.log('✓ Exceções entre clínicas exigem programador, módulos, motivo e prazo; revogação preserva histórico');
