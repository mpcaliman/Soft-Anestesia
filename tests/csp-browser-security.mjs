/** Real HTTP/Chromium validation of the deployed CSP and stored-field interactions. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
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
  });
  const errors=[],page=await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`,{waitUntil:'load'});
  await page.waitForFunction(()=>window.pacientes && window.historico && window.printPreview);
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
  const popupPromise=page.waitForEvent('popup');
  await page.evaluate(payload=>{
    const original=window.open.bind(window);
    window.open=(...args)=>{const popup=original(...args);if(popup){popup.__printCalls=0;popup.print=()=>{popup.__printCalls++;};popup.close=()=>{};popup.__cspViolations=[];const docOpen=popup.document.open.bind(popup.document);popup.document.open=(...args)=>{const result=docOpen(...args);popup.document.addEventListener('securitypolicyviolation',event=>popup.__cspViolations.push(event.effectiveDirective));return result;};}return popup;};
    document.getElementById('print-preview-overlay').classList.add('show');
    document.getElementById('ppp').textContent=payload;
    printPreview._gerarNomeArquivo=()=> 'Documento de teste';
    printPreview.imprimir();
  },payload);
  const popup=await popupPromise;
  const popupErrors=[];
  popup.on('pageerror',error=>popupErrors.push('PAGEERROR: '+error.message));
  popup.on('console',message=>{if(message.type()==='error')popupErrors.push(message.text());});
  // The initial about:blank load can finish before document.write's external scripts.
  // Wait for the actual print DOM and registry, not that earlier navigation event.
  try {
    await popup.waitForFunction(()=>document.body && window.SoftActions
      && document.querySelector('[data-soft-name-click="window.print"]')
      && document.readyState==='complete');
  } catch(error) {
    const diagnostic=await popup.evaluate(()=>({url:location.href,base:document.baseURI,title:document.title,
      ready:document.readyState,body:document.body?.innerHTML?.slice(0,900)||null,
      scripts:[...document.scripts].map(script=>script.src),violations:window.__cspViolations||[]})).catch(()=>({closed:popup.isClosed()}));
    throw new Error('Print document failed to load: '+JSON.stringify({diagnostic,popupErrors}),{cause:error});
  }
  const printed=await popup.evaluate(()=>({inline:document.querySelectorAll('[onclick],[onload],style').length,text:document.body.textContent,
    violations:window.__cspViolations||[],button:!!document.querySelector('[data-soft-name-click="window.print"]')}));
  assert.equal(printed.inline,0);assert(printed.text.includes(payload));assert(printed.button);assert.deepEqual(printed.violations,[]);
  const clickWorked=await popup.evaluate(()=>{
    const before=window.__printCalls;
    document.querySelector('[data-soft-name-click="window.print"]').click();
    return window.__printCalls===before+1;
  });
  assert(clickWorked,'external compiled print action must invoke window.print');
  assert.deepEqual(popupErrors,[],'print document must not produce JavaScript or CSP errors');
  console.log('✓ Chromium/CSP: boot, stored patient/history fields, compiled edit/save clicks and print popup pass without inline code or policy violations');
} finally {
  if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));
}
