/** PR226: clinical corrections remain visible and safe under strict CSP. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compileStrictAssets} from '../scripts/strict-csp.mjs';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const source=await readFile(resolve(repo,'index.html'),'utf8');
const runtime=await readFile(resolve(repo,'src/ui/strict-actions.js'),'utf8');
function object(name){const start=source.indexOf('const '+name+' = {');const end=source.indexOf('\n};',start);assert(start>=0&&end>start,name);return source.slice(start,end+3);}
const payload=`Synthetic correction\nO'Connor & "Team" </div><img src=x onerror="globalThis.__adendaXss=1"><script>globalThis.__adendaXss=2</script>\u2028');evil();//`;
const record=Object.freeze({_id:'synthetic-signed',_finalizado:true,nome:'Synthetic patient',
  _adendos:Object.freeze([Object.freeze({id:'a1',data:'2026-10-09T12:00:00Z',autor:'Synthetic author & <script>',texto:payload}),
    Object.freeze({id:'a2',data:'2026-10-09T13:00:00Z',autor:'Synthetic author',texto:'Second correction: synthetic laboratory result.'})])});
const fixture=object('utils')+'\n'+object('adendos')+'\nglobalThis.renderAdenda=record=>adendos.htmlParaImpressao(record);';
const html='<html><head><style>body{color:black}</style><style>.print-adendos{break-inside:avoid}</style></head><body>'
  +Array.from({length:16},(_,i)=>`<script>${i===0?fixture:''}</script>`).join('')+'</body></html>';
const compiled=compileStrictAssets(html,new Map([['src/ui/strict-actions.js',runtime]]));
assert(!compiled.policy.includes('unsafe-inline')&&!compiled.policy.includes('unsafe-eval'));
class Element{}class ShadowRoot{}class MutationObserver{observe(){}}
const document={nodeType:9,addEventListener(){}};
const sandbox=vm.createContext({window:{},document,Element,ShadowRoot,MutationObserver,console});
vm.runInContext(runtime,sandbox);sandbox.SoftActions=sandbox.window.SoftActions;
vm.runInContext(compiled.sources.get('src/ui/strict-actions.generated.js'),sandbox);
vm.runInContext(compiled.sources.get('src/app/runtime-01.js'),sandbox);
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
