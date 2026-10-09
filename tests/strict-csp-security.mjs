/** Hostile stored values must remain parameters of statically compiled callbacks. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileStrictAssets } from '../scripts/strict-csp.mjs';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const runtime=await readFile(resolve(repo,'src/ui/strict-actions.js'),'utf8');
const payload=`O'Connor & "Filhos" </button><img src=x onerror="globalThis.__xss=1">\u2028');globalThis.__xss=2;//`;
const fixture = `globalThis.fixture = '<button style="color:red" onclick="capture(' + utils.jsArg(value) + ',this,event); return false">OK</button>';\n`
  + 'globalThis.literal = `<button onclick="capture(${false ? \'true\' : \'false\'},${\'42\'})">literal</button>`;\n'
  + 'globalThis.raw = `<button onclick="capture(\'${value}\')">raw</button>`;\n'
  + 'globalThis.nested = `<div>${true ? `<button onclick="capture(${utils.jsArg(value)})">nested</button>` : ""}</div>`;\n';
const html='<html><head><style>body{color:black}</style><style>.ok{color:green}</style></head><body>'
  + '<button onclick="capture(7)" style="color:red">static</button>'
  + Array.from({length:16},(_,index)=>`<script>${index===0?fixture:''}</script>`).join('')+'</body></html>';
const compiled=compileStrictAssets(html,new Map([['src/ui/strict-actions.js',runtime]]));
assert(!compiled.policy.includes('unsafe-inline') && !compiled.policy.includes('unsafe-eval'));
assert.doesNotMatch(compiled.sources.get('index.html'),/\s(?:on\w+|style)=|<style\b|<script>(?!<\/script>)/i);
assert.doesNotMatch(runtime,/\beval\s*\(|\b(?:new\s+)?Function\s*\(/);
const escape=value=>String(value).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const decode=value=>String(value).replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
class Element {} class ShadowRoot {} class MutationObserver {observe(){}}
const document={nodeType:9,addEventListener(){}};
const captures=[];
const context=vm.createContext({window:{},document,Element,ShadowRoot,MutationObserver,value:payload,
  utils:{jsArg: value=>escape(JSON.stringify(value))},capture:(...values)=>captures.push(values)});
vm.runInContext(runtime,context);context.SoftActions=context.window.SoftActions;
let handlers;
const original=context.SoftActions;
context.SoftActions={...original,install(templates,registry,events,token){handlers=registry;original.install(templates,registry,events,token);}};
vm.runInContext(compiled.sources.get('src/ui/strict-actions.generated.js'),context);
vm.runInContext(compiled.sources.get('src/app/runtime-01.js'),context);
const self={id:'button'}, event={type:'click'};
for(const key of ['fixture','raw','nested']) {
  const output=original.sanitizeHTML(context[key]);
  assert.doesNotMatch(output.replace(/"[^"]*"/g, '""'),/\son(?:click|error)=/i);
  const id=output.match(/data-soft-onclick="([^"]+)"/)[1];
  const args=JSON.parse(decode(output.match(/data-soft-args-click="([^"]+)"/)[1]));
  const result=handlers[id].call(self,event,args);
  assert.equal(captures.at(-1)[0],payload);
  if(key==='fixture') { assert.equal(result,false);assert.equal(captures.at(-1)[1],self);assert.equal(captures.at(-1)[2],event); }
  assert.equal(context.__xss,undefined);
}
const literalId=context.literal.match(/data-soft-onclick="([^"]+)"/)[1];
const literalArgs=JSON.parse(decode(context.literal.match(/data-soft-args-click="([^"]+)"/)[1]));
handlers[literalId].call(self,event,literalArgs);
assert.equal(captures.at(-1)[0], false, 'bloquear conta deve passar boolean false, nunca texto truthy');
assert.equal(captures.at(-1)[1], 42);
const serialized = '<span style=\'font-family:"Arial";color:red\' onerror="evil()" data-note="onerror=&quot;stored value&quot;">OK</span>';
const sanitized = original.sanitizeHTML(serialized);
assert(sanitized.includes('data-soft-style=\'font-family:"Arial";color:red\''));
assert(sanitized.includes('data-note="onerror=&quot;stored value&quot;"'));
assert(!sanitized.includes('onerror="evil()"'));
assert.throws(() => original.html(0, [payload], 'another-release'), /versões diferentes/,
  'mistura de assets não pode despachar ações ou templates da versão errada');
assert.equal(compiled.statistics.actions,5);
console.log('✓ CSP estrita: valores hostis, strings, templates aninhados, this/event e return false preservados sem compilar dados');
