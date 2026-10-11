/** Hostile stored values must remain parameters of statically compiled callbacks. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileStrictAssets } from '../scripts/strict-csp.mjs';
import { bindSyntheticPrintContext } from './helpers/bind-print-context.mjs';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const runtime=await readFile(resolve(repo,'src/ui/strict-actions.js'),'utf8');
const sessionVault=await readFile(resolve(repo,'src/platform/session-vault.js'),'utf8');
const cloudClient=await readFile(resolve(repo,'src/platform/cloud-client.js'),'utf8');
const authClient=await readFile(resolve(repo,'src/platform/auth.js'),'utf8');
class PrintSessionStorage {
  constructor(){this.values=new Map();}
  get length(){return this.values.size;}
  key(index){return [...this.values.keys()][index]??null;}
  getItem(key){return this.values.get(String(key))??null;}
  setItem(key,value){this.values.set(String(key),String(value));}
  removeItem(key){this.values.delete(String(key));}
  clear(){this.values.clear();}
}
const realSessionFixture={console,btoa,sessionStorage:new PrintSessionStorage(),localStorage:new PrintSessionStorage(),
  crypto:{randomUUID:()=> 'a09dce89-4b31-45ef-87c3-32b8014c999a'},setInterval:()=>1,
  addEventListener(){}};
realSessionFixture.window=realSessionFixture;
const realSessionVm=vm.createContext(realSessionFixture);
const contextStart=sessionVault.indexOf('const contextoAba = (() => {');
const contextEnd=sessionVault.indexOf('\nconst cofre = {',contextStart);
assert(contextStart>=0&&contextEnd>contextStart);
vm.runInContext(sessionVault.slice(contextStart,contextEnd)+'\n'+cloudClient+'\n'+authClient+
  '\nglobalThis.printContext={contextoAba,cloud,auth};',realSessionVm);
const realPrintContext=realSessionFixture.printContext;
assert.equal(realPrintContext.contextoAba.operational(),false);
const actualCloudSession=realPrintContext.cloud.session;
realPrintContext.cloud.session=()=>({user:{id:'csp-user'}});
realPrintContext.contextoAba.prepararUsuario('csp-user');
assert.equal(realPrintContext.contextoAba.vincular({uid:'csp-user',organization_id:'csp-org'}),false,
  'a cloud.session mock cannot authorize printing without a post-boot CLOUD_KEY session');
realPrintContext.cloud.session=actualCloudSession;
const confirmedPrintContext=vm.runInContext('('+bindSyntheticPrintContext.toString()+')()',realSessionVm);
assert.equal(confirmedPrintContext.organizationId,'csp-org');
assert(realPrintContext.contextoAba.corresponde(confirmedPrintContext));
assert(realPrintContext.contextoAba.compativelComSessoes(realPrintContext.cloud.session(),realPrintContext.auth.usuarioAtual()));
const mismatchedAuth={...realPrintContext.auth.usuarioAtual(),uid:'other-user',id:'other-user'};
realSessionFixture.sessionStorage.setItem(realPrintContext.auth.SESSION_KEY,JSON.stringify(mismatchedAuth));
assert.equal(realPrintContext.contextoAba.restaurarDeSessoes(),false);
assert.equal(realPrintContext.contextoAba.operational(),false,'mismatched accounts must invalidate the synthetic print context');
console.log('✓ CSP browser fixture: real post-boot cloud/auth sessions bind; mock-only and mismatched accounts remain blocked');
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

/* A popup must accept one document from its exact opener, origin and nonce.
   The DOM boundary below does not execute markup; the production parser,
   sanitizer, protocol handlers and handshake run unchanged in the VM. */
const printShellSource=await readFile(resolve(repo,'src/print/print-shell.js'),'utf8');
assert.doesNotMatch(printShellSource,/\beval\s*\(|\b(?:new\s+)?Function\s*\(/);
const printOrigin='https://soft.example.test';
const printBase=printOrigin+'/app/index.html';
const printNonce='d75dce89-4b31-45ef-87c3-32b8014c999a';
const flushPrint=()=>new Promise(resolve=>setImmediate(resolve));
function events(){
  const listeners=new Map();return{
    addEventListener(type,fn){if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(fn);},
    removeEventListener(type,fn){listeners.get(type)?.delete(fn);},
    emit(type,event){for(const fn of [...(listeners.get(type)||[])])fn(event);}
  };
}
function parsedDocument(markup){
  let html=String(markup);const removed=[];
  const links=[...html.matchAll(/<link\b[^>]*>/gi)].map(match=>({tagName:'LINK',
    matches:selector=>selector==='link[rel="stylesheet"][href]'&&/\brel=["']stylesheet["']/i.test(match[0]),
    getAttribute:name=>name==='href'?(match[0].match(/\bhref=["']([^"']*)["']/i)||[])[1]:null}));
  const body={nodeType:1,tagName:'BODY',attributes:[],hasAttribute:()=>false,querySelectorAll:()=>[],
    get innerHTML(){return (html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)||[])[1]??html;}};
  return {body,title:(html.match(/<title>([\s\S]*?)<\/title>/i)||[])[1]||'',removed,
    head:{children:links,querySelectorAll:()=>[]},
    documentElement:{get outerHTML(){return html;}},
    querySelectorAll(selector){
      if(!/script|base|http-equiv/.test(selector))return[];
      const nodes=[...html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script\s*>|<base\b[^>]*>|<meta\b[^>]*http-equiv[^>]*>/gi)].map(m=>m[0]);
      return nodes.map(token=>({remove(){removed.push(token);html=html.replace(token,'');}}));
    }};
}
const parsedPrintDocuments=[];
class PrintDOMParser{parseFromString(html){const parsed=parsedDocument(html);parsedPrintDocuments.push(parsed);return parsed;}}
const clinicalMarkup='<html><head><title>Synthetic clinical print</title>'
  +'<script>globalThis.__printXss=1</script><base href="https://evil.example/">'
  +'<meta http-equiv="refresh" content="0;url=https://evil.example/"></head><body>'
  +'<p>Synthetic clinical correction</p><img src=x onerror="globalThis.__printXss=2">'
  +'<script>globalThis.__printXss=3</script></body></html>';
function shellHarness(origin=printOrigin){
  const replies=[],shellEvents=events(),timers=new Map(),styles=[];let timer=0,mounts=0,current=true;
  const inheritedSession=new PrintSessionStorage();
  inheritedSession.setItem('medsys.v7.cloud.session','copied-cloud-credential');
  inheritedSession.setItem('medsys.v7.auth.session','copied-auth-credential');
  inheritedSession.setItem('old-clinical-draft','copied-clinical-data');
  const opener={closed:false,postMessage:(data,target)=>replies.push({data,target}),
    SoftActions:{isPrintCurrent:(win,nonce)=>current&&win===shellWindow&&nonce===printNonce}};
  const document={nodeType:9,baseURI:printOrigin+'/app/print-shell.html',title:'Shell',
    adoptedStyleSheets:[],addEventListener(){},querySelectorAll:()=>[],
    head:{appendChild(node){styles.push(node);},querySelectorAll:()=>[]},
    body:{innerHTML:'',replaceWith(body){mounts++;document.body=body;body.replaceWith=this.replaceWith;},
      replaceChildren(){this.innerHTML='';}},
    importNode(node){if(node.tagName==='LINK')return{...events(),tagName:'LINK'};
      return{nodeType:1,tagName:'BODY',attributes:[],hasAttribute:()=>false,querySelectorAll:()=>[],
        innerHTML:node.innerHTML,replaceChildren(){this.innerHTML='';}};}};
  const shellWindow={...shellEvents,opener,closed:false,close(){this.closed=true;}};
  const context=vm.createContext({window:shellWindow,document,sessionStorage:inheritedSession,Element,ShadowRoot,MutationObserver,
    location:{origin,href:document.baseURI+'#'+printNonce,hash:'#'+printNonce,
      pathname:'/app/print-shell.html',search:''},
    history:{replaceState(){}},URL,DOMParser:PrintDOMParser,console,Promise,
    setInterval(fn){const id=++timer;timers.set(id,fn);return id;},clearInterval:id=>timers.delete(id),
    setTimeout:fn=>{fn();return 0;},clearTimeout(){}});
  vm.runInContext(runtime,context);context.SoftActions=shellWindow.SoftActions;
  vm.runInContext(compiled.sources.get('src/ui/strict-actions.generated.js'),context);
  vm.runInContext(printShellSource,context);
  return{replies,events:shellEvents,timers,styles,opener,document,sessionStorage:inheritedSession,window:shellWindow,context,
    get mounts(){return mounts;},setCurrent(value){current=value;},
    send(data){shellEvents.emit('message',{source:opener,origin,data});}};
}
const shell=shellHarness();
assert.equal(shell.sessionStorage.length,0,'print-shell boot must discard copied credentials and clinical session data');
const {replies:shellReplies,events:shellEvents,opener,document:shellDocument,window:shellWindow,context:shellContext}=shell;
assert(shellReplies.some(({data,target})=>data.type==='soft-print-ready'&&data.nonce===printNonce&&target===printOrigin));
const printMessage={type:'soft-print-document',nonce:printNonce,html:clinicalMarkup,build:compiled.statistics.buildToken};
for(const event of [
  {source:{},origin:printOrigin,data:printMessage},
  {source:opener,origin:'https://evil.example',data:printMessage},
  {source:opener,origin:printOrigin,data:{...printMessage,nonce:'wrong-nonce'}},
  {source:opener,origin:printOrigin,data:{...printMessage,type:'unknown-print-type'}}
])shellEvents.emit('message',event);
await Promise.resolve();assert.equal(shell.mounts,0,'forged messages cannot mount or consume a print document');
shellEvents.emit('message',{source:opener,origin:printOrigin,data:printMessage});
await flushPrint();
assert.equal(shell.mounts,1,'the matching authenticated document mounts once');
assert.match(shellDocument.body.innerHTML,/Synthetic clinical correction/);
assert.doesNotMatch(shellDocument.body.innerHTML,/<script\b|\sonerror=/i);
assert.equal(parsedPrintDocuments.at(-1).removed.length,4,'both scripts, base and redirect meta are removed before mounting');
assert.equal(shellContext.__printXss,undefined);
assert(shellReplies.some(({data,target})=>data.type==='soft-print-rendered'&&data.nonce===printNonce&&target===printOrigin));
shellEvents.emit('message',{source:opener,origin:printOrigin,data:{...printMessage,html:'<body>Replace with forged content</body>'}});
await Promise.resolve();assert.equal(shell.mounts,1,'the nonce cannot render a second document');
assert.doesNotMatch(shellDocument.body.innerHTML,/forged content/);
for(const event of [
  {source:{},origin:printOrigin,data:{type:'soft-print-invalidate',nonce:printNonce}},
  {source:opener,origin:'https://evil.example',data:{type:'soft-print-invalidate',nonce:printNonce}},
  {source:opener,origin:printOrigin,data:{type:'soft-print-invalidate',nonce:'wrong-nonce'}}
])shellEvents.emit('message',event);
assert.match(shellDocument.body.innerHTML,/Synthetic clinical correction/);
assert.equal(shellWindow.closed,false,'forged invalidation cannot clear an authenticated print document');
shellDocument.adoptedStyleSheets=[{synthetic:true}];
shellEvents.emit('message',{source:opener,origin:printOrigin,data:{type:'soft-print-invalidate',nonce:printNonce}});
assert.equal(shellDocument.body.innerHTML,'');
assert.equal(shellDocument.adoptedStyleSheets.length,0);
assert.equal(shellDocument.title,'Impressão encerrada');
assert.equal(shellWindow.closed,true,'authenticated invalidation removes the clinical view and closes the shell');

const opaqueShell=shellHarness('null');opaqueShell.send(printMessage);
assert.equal(opaqueShell.mounts,0);assert.equal(opaqueShell.replies.length,0,'opaque shell origins never receive or disclose clinical content');
const hiddenShell=shellHarness();hiddenShell.send(printMessage);
await flushPrint();assert.match(hiddenShell.document.body.innerHTML,/Synthetic clinical correction/);
hiddenShell.document.adoptedStyleSheets=[{synthetic:true}];
hiddenShell.events.emit('pagehide',{persisted:true});
assert.equal(hiddenShell.document.body.innerHTML,'');assert.equal(hiddenShell.document.adoptedStyleSheets.length,0);
assert.equal(hiddenShell.window.closed,true,'a print document cannot retain clinical contents for BFCache restoration');
const staleShell=shellHarness();staleShell.setCurrent(false);staleShell.send(printMessage);
await Promise.resolve();assert.equal(staleShell.mounts,0);assert.equal(staleShell.window.closed,true,
  'a stale opener lease prevents clinical parsing and mounting');
const badBuildShell=shellHarness();badBuildShell.send({...printMessage,build:'another-release'});
await Promise.resolve();assert.equal(badBuildShell.mounts,0);assert.equal(badBuildShell.window.closed,true);
assert(badBuildShell.replies.some(({data})=>data.type==='soft-print-failed'),'mixed release assets fail closed');
const monitoredShell=shellHarness();monitoredShell.send(printMessage);
await flushPrint();assert.equal(monitoredShell.mounts,1);
delete monitoredShell.opener.SoftActions;
for(const timer of monitoredShell.timers.values())timer();
assert.equal(monitoredShell.document.body.innerHTML,'');assert.equal(monitoredShell.window.closed,true,
  'an opener reload without its lease registry clears the old clinical print');

const cssMarkup=clinicalMarkup.replace('</head>',
  '<link rel="stylesheet" href="/app/print.css"><link rel="stylesheet" href="https://evil.example/print.css"></head>');
const cssShell=shellHarness();cssShell.send({...printMessage,html:cssMarkup});
await flushPrint();assert.equal(cssShell.mounts,1);assert.equal(cssShell.styles.length,1);
assert.equal(cssShell.styles[0].href,printOrigin+'/app/print.css');
assert(!cssShell.replies.some(({data})=>data.type==='soft-print-rendered'),'CSS still loading prevents a premature render ACK');
cssShell.styles[0].emit('load',{});await flushPrint();
assert(cssShell.replies.some(({data})=>data.type==='soft-print-rendered'),'same-origin CSS load completes the render receipt');
const cssFailureShell=shellHarness();cssFailureShell.send({...printMessage,html:cssMarkup});
cssFailureShell.styles[0].emit('error',{});await flushPrint();
assert(!cssFailureShell.replies.some(({data})=>data.type==='soft-print-rendered'));
assert(cssFailureShell.replies.some(({data})=>data.type==='soft-print-failed'));
assert.equal(cssFailureShell.document.body.innerHTML,'');assert.equal(cssFailureShell.window.closed,true,
  'failed required print CSS clears the clinical view and reports failure');
const cssStaleShell=shellHarness();cssStaleShell.send({...printMessage,html:cssMarkup});
cssStaleShell.setCurrent(false);cssStaleShell.styles[0].emit('load',{});
await flushPrint();
assert(!cssStaleShell.replies.some(({data})=>data.type==='soft-print-rendered'));
assert.equal(cssStaleShell.document.body.innerHTML,'');assert.equal(cssStaleShell.window.closed,true,
  'a session change while CSS loads cannot release a clinical render receipt');

/* Sender readiness must wait for the exact target window's render ACK;
   navigating/replacing its document cannot release the parent promise. */
const parentEvents=events(),parentTimers=new Map(),sent=[],contextListeners=[];let parentTimer=0,parentGeneration=1;
const parentWindow={...parentEvents};
const popup={closed:false,document:{nodeType:9,createElement(){}},
  location:{replace(url){this.href=url;}},postMessage:(data,target)=>sent.push({data,target}),close(){this.closed=true;}};
const parentContext=vm.createContext({window:parentWindow,document:{nodeType:9,baseURI:printBase,addEventListener(){},querySelectorAll:()=>[]},
  Element,ShadowRoot,MutationObserver,DOMParser:PrintDOMParser,URL,console,Promise,
  location:{origin:printOrigin},crypto:{randomUUID:()=>printNonce},
  setTimeout(fn){const id=++parentTimer;parentTimers.set(id,fn);return id;},clearTimeout:id=>parentTimers.delete(id),
  setInterval(fn){const id=++parentTimer;parentTimers.set(id,fn);return id;},clearInterval:id=>parentTimers.delete(id),
  contextoAba:{operational:()=>true,capturar:()=>({generation:parentGeneration}),
    corresponde:snapshot=>snapshot?.generation===parentGeneration,aoMudar:fn=>contextListeners.push(fn)}});
vm.runInContext(runtime,parentContext);parentContext.SoftActions=parentWindow.SoftActions;
vm.runInContext(compiled.sources.get('src/ui/strict-actions.generated.js'),parentContext);
const popupReady=parentWindow.SoftActions.writeDocument(popup,clinicalMarkup);let ready=false;
popupReady.then(()=>{ready=true;});assert(popup.location.href.includes('print-shell.html#'+printNonce));
assert.equal(parentWindow.SoftActions.isPrintCurrent(popup,printNonce),true,'the active print lease binds its window, nonce and authenticated context');
assert.equal(parentWindow.SoftActions.isPrintCurrent({},printNonce),false);
assert.equal(parentWindow.SoftActions.isPrintCurrent(popup,'wrong-nonce'),false);
popup.document={nodeType:9,createElement(){}};delete popup.softDocumentReady;
for(const event of [
  {source:{},origin:printOrigin,data:{type:'soft-print-ready',nonce:printNonce}},
  {source:popup,origin:'https://evil.example',data:{type:'soft-print-ready',nonce:printNonce}},
  {source:popup,origin:printOrigin,data:{type:'soft-print-ready',nonce:'wrong-nonce'}}
])parentEvents.emit('message',event);
assert.equal(sent.length,0);
parentEvents.emit('message',{source:popup,origin:printOrigin,data:{type:'soft-print-rendered',nonce:printNonce}});
await Promise.resolve();assert.equal(ready,false,'a matching ACK cannot release a document that was never sent');
parentEvents.emit('message',{source:popup,origin:printOrigin,data:{type:'soft-print-ready',nonce:printNonce}});
assert.equal(sent.length,1);assert.equal(sent[0].target,printOrigin);assert.equal(sent[0].data.build,compiled.statistics.buildToken);
assert.doesNotMatch(sent[0].data.html,/\sonerror=/i,'the sender also removes executable attributes before transmission');
parentEvents.emit('message',{source:popup,origin:printOrigin,data:{type:'soft-print-ready',nonce:printNonce}});
assert.equal(sent.length,1,'a duplicate ready handshake cannot transmit clinical content twice');
await Promise.resolve();assert.equal(ready,false,'ready handshake is not a rendered acknowledgement');
for(const event of [
  {source:{},origin:printOrigin,data:{type:'soft-print-rendered',nonce:printNonce}},
  {source:popup,origin:'https://evil.example',data:{type:'soft-print-rendered',nonce:printNonce}},
  {source:popup,origin:printOrigin,data:{type:'soft-print-rendered',nonce:'wrong-nonce'}}
])parentEvents.emit('message',event);
await Promise.resolve();assert.equal(ready,false);
parentEvents.emit('message',{source:popup,origin:printOrigin,data:{type:'soft-print-rendered',nonce:printNonce}});
await popupReady;assert.equal(ready,true,'the matching shell render ACK releases the original parent promise');
parentGeneration++;for(const listener of contextListeners)listener();
assert.equal(popup.closed,true,'changing authenticated context closes clinical print windows');
assert.equal(parentWindow.SoftActions.isPrintCurrent(popup,printNonce),false,'a context change revokes the print lease');
parentContext.location.origin='null';
const opaquePopup={closed:false,document:{nodeType:9,createElement(){}},
  location:{replace(){assert.fail('opaque origins cannot navigate a clinical popup');}},
  postMessage(){assert.fail('opaque origins cannot transmit clinical content');},close(){this.closed=true;}};
await assert.rejects(parentWindow.SoftActions.writeDocument(opaquePopup,clinicalMarkup),/endereço/i);
assert.equal(parentWindow.SoftActions.isPrintCurrent(opaquePopup,printNonce),false);
console.log('✓ Print shell: exact opener/origin/nonce, single render, script removal, CSS readiness, opaque origin denial and session-bound lease');
