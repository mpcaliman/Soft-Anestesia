/** Real HTTP/Chromium validation of the deployed CSP and stored-field interactions. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { bindSyntheticPrintContext } from './helpers/bind-print-context.mjs';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const arg=process.argv.find(value=>value.startsWith('--app-root='));
const root=arg?resolve(process.cwd(),arg.slice('--app-root='.length)):resolve(repo,'dist');
const server=createServer(async(request,response)=>{
  try {
    const relative=decodeURIComponent(new URL(request.url,'http://localhost').pathname).replace(/^\/+/, '') || 'index.html';
    const path=resolve(root,relative);
    if (!path.startsWith(root+sep)) throw new Error('path');
    const bytes=await readFile(path);
    const mime={'.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json'}[extname(path)] || 'application/octet-stream';
    response.writeHead(200,{'Content-Type':mime+'; charset=utf-8'});response.end(bytes);
  } catch {response.writeHead(404);response.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try {
  browser=await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{});
  const context=await browser.newContext();
  await context.route('https://**/*',route=>route.abort());
  await context.addInitScript(()=>{
    window.__cspViolations=[];
    document.addEventListener('securitypolicyviolation',event=>window.__cspViolations.push({directive:event.effectiveDirective,blocked:event.blockedURI}));
    if (window.opener) {
      window.__printCalls=0;
      window.print=()=>{window.__printCalls++;};
      window.close=()=>{};
    }
  });
  const errors=[],page=await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`,{waitUntil:'load'});
  await page.waitForFunction(()=>window.pacientes && window.historico && window.printPreview);
  // Synthetic account/organization use the real tab-context API, never clinical production data.
  await page.evaluate(bindSyntheticPrintContext);
  const payload=`O'Connor & "Filhos" </button><img src=x onerror="window.__clinicalXss=1">\u2028');window.__clinicalXss=2;//`;
  const outcome=await page.evaluate(payload=>{
    const patient={_id:payload,nome:payload,cpf:payload,plano:payload,carteirinha:payload,telefone:payload};
    const clinical={_id:payload,paciente_nome:payload,paciente_cpf:payload,senha:payload,procedimento:payload,_updatedAt:'2026-10-09T12:00:00Z'};
    store.list=module=>module==='pacientes'?[patient]:module==='pre'?[clinical]:[];
    store.getById=(module,id)=>id===payload?(module==='pacientes'?patient:clinical):null;
    const captures=[];
    historico.prontuario=(...args)=>captures.push(['patient',...args]);
    pacientes.render();
    document.querySelector('[data-pac-action="historico"]').click();
    historico.abrirItem=(...args)=>captures.push(['edit',...args]);
    historico.abrir('pre');
    document.querySelector('#hist-tbody [data-soft-name-click="historico.abrirItem"]').click();
    pre.salvar=()=>captures.push(['save']);
    document.querySelector('#module-pre [data-soft-name-click="pre.salvar"]').click();
    // CSSOM styles become style= when serialized; copying that HTML must remain CSP-safe.
    const source = document.createElement('div');
    source.innerHTML = '<span style="color:rgb(12, 34, 56);display:none">reuse</span>';
    const copy = document.createElement('div'); copy.innerHTML = source.innerHTML;
    document.body.appendChild(copy);
    const reused = copy.firstElementChild;
    const styleReused = reused.style.color === 'rgb(12, 34, 56)';
    reused.style.display = '';
    const hiddenCanClear = getComputedStyle(reused).display !== 'none';
    copy.remove();
    const elements=[...document.querySelectorAll('*')];
    const inline=elements.flatMap(element=>[...element.attributes].filter(attr=>/^on[a-z]/i.test(attr.name)).map(attr=>attr.name));
    const patientText=document.getElementById('pacientes-tbody').textContent;
    const historyText=document.getElementById('hist-tbody').textContent;
    return {captures,inline,patientText,historyText,styleReused,hiddenCanClear,xss:window.__clinicalXss||null,violations:window.__cspViolations,
      scripts:[...document.scripts].every(script=>!!script.src),styleBlocks:document.querySelectorAll('style').length};
  },payload);
  assert.equal(outcome.xss,null);assert.deepEqual(outcome.inline,[]);assert(outcome.scripts);assert.equal(outcome.styleBlocks,0);
  assert(outcome.styleReused && outcome.hiddenCanClear, 'copied CSSOM styles must keep color and permit clearing display:none');
  assert(outcome.patientText.includes(payload) && outcome.historyText.includes(payload));
  assert(outcome.captures.some(row=>row[0]==='patient' && row[1]===payload && row[2]===payload));
  assert(outcome.captures.some(row=>row[0]==='edit' && row[1]==='pre' && row[2]===payload));
  assert(outcome.captures.some(row=>row[0]==='save'));
  assert.deepEqual(outcome.violations,[],'boot, rendering and clicks must not violate the deployed CSP');
  assert.deepEqual(errors,[],'deployed app must not produce JavaScript errors');
  // Inspect the real print popup with inherited CSP and external actions/styles.
  const popupErrors=[], popupRequests=[];
  context.on('page', opened => {
    if (opened === page) return;
    opened.on('pageerror',error=>popupErrors.push('PAGEERROR: '+error.message));
    opened.on('console',message=>{if(message.type()==='error')popupErrors.push(message.text());});
    opened.on('requestfailed',request=>popupRequests.push({url:request.url(),failed:request.failure()?.errorText}));
    opened.on('response',response=>popupRequests.push({url:response.url(),status:response.status()}));
  });
  const popupPromise=page.waitForEvent('popup');
  await page.evaluate(payload=>{
    document.getElementById('print-preview-overlay').classList.add('show');
    document.getElementById('ppp').textContent=payload;
    printPreview._gerarNomeArquivo=()=> 'Documento de teste';
    printPreview.imprimir();
  },payload);
  const popup=await popupPromise;
  // Wait for the real shell navigation and its authenticated document acknowledgement.
  try {
    await popup.waitForFunction(()=>document.body && window.SoftActions
      && document.querySelector('.pp-print-btn[data-soft-onclick][data-soft-name-click="print"]')
      && document.readyState==='complete' && window.softPrintRendered===true);
  } catch(error) {
    const diagnostic=await popup.evaluate(()=>({url:location.href,base:document.baseURI,title:document.title,
      ready:document.readyState,body:document.body?.innerHTML?.slice(0,900)||null,
      actions:typeof window.SoftActions,documentReady:window.softPrintRendered===true,
      scripts:[...document.scripts].map(script=>script.src),violations:window.__cspViolations||[]})).catch(()=>({closed:popup.isClosed()}));
    throw new Error('Print document failed to load: '+JSON.stringify({diagnostic,popupErrors,popupRequests}),{cause:error});
  }
  const printed=await popup.evaluate(()=>({inline:document.querySelectorAll('[onclick],[onload],style').length,text:document.body.textContent,
    violations:window.__cspViolations||[],sessionKeys:Object.keys(sessionStorage),
    button:!!document.querySelector('.pp-print-btn[data-soft-name-click="print"]')}));
  assert.equal(printed.inline,0);assert(printed.text.includes(payload));assert(printed.button);assert.deepEqual(printed.violations,[]);
  assert.deepEqual(printed.sessionKeys,[],'print shell must discard the sessionStorage copy inherited from its opener');
  assert(await page.evaluate(()=>contextoAba.compativelComSessoes(cloud.session(),auth.usuarioAtual())),
    'clearing copied popup credentials must preserve the opener authenticated context');
  const clickWorked=await popup.evaluate(()=>{
    const before=window.__printCalls;
    document.querySelector('.pp-print-btn[data-soft-name-click="print"]').click();
    return window.__printCalls===before+1;
  });
  assert(clickWorked,'external compiled print action must invoke window.print');
  assert.deepEqual(popupErrors,[],'print document must not produce JavaScript or CSP errors');
  assert(new URL(popup.url()).pathname.endsWith('/print-shell.html'), 'print actions must load through an actual same-origin navigation');
  await page.evaluate(()=>contextoAba.limpar());
  await popup.waitForFunction(()=>document.body.textContent==='' && window.softPrintRendered===false);
  const cleared=await popup.evaluate(()=>({text:document.body.textContent,actions:document.querySelectorAll('[data-soft-onclick]').length}));
  assert.equal(cleared.text,'');assert.equal(cleared.actions,0,'changing the parent user/context must remove all clinical print content and actions');
  assert.deepEqual(popupErrors,[]);assert.deepEqual(errors,[]);
  assert.deepEqual(await page.evaluate(()=>window.__cspViolations),[],
    'asynchronously dispatched CSP violations must remain empty after all rendering and print exercises');
  console.log('✓ Chromium/CSP: boot, stored patient/history fields, compiled edit/save clicks and print popup pass without inline code or policy violations');
} finally {
  if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));
}
