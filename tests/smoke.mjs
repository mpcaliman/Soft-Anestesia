/**
 * Soft Anestesia — testes de fumaça (smoke tests) com Playwright.
 *
 * Roda o app (index.html) num Chromium headless via file:// e verifica os
 * fluxos essenciais dos módulos que evoluímos: boot sem erros de JS, modo
 * demonstração, pré-anestésica (navegação + completude), SRPA (PADSS + resumo
 * de alta), financeiro (fechamento de caixa) e versionamento de documentos.
 *
 * Não precisa do runner @playwright/test — usa a biblioteca `playwright`
 * diretamente com um mini-harness. Sai com código !=0 se algo falhar (CI).
 *
 * Uso: `npm test`  (ou `node tests/smoke.mjs`)
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_URL = 'file://' + resolve(__dirname, '..', 'index.html');

/* Erros de rede são esperados offline (Supabase, Google Fonts) e não contam.
   O aviso de 'beforeunload' bloqueado é o guard de alterações não salvas
   reagindo a um reload programático — benigno. */
const isNetworkNoise = (t) =>
  /ERR_CONNECTION|Failed to load resource|ERR_NAME_NOT_RESOLVED|net::|favicon|beforeunload/i.test(t || '');

const results = [];
let currentErrors = [];

function assert(cond, msg) {
  if (!cond) throw new Error('Assert falhou: ' + msg);
}

async function test(name, fn) {
  currentErrors = [];
  try {
    await fn();
    const jsErr = currentErrors.filter(e => !isNetworkNoise(e));
    if (jsErr.length) throw new Error('Erros de JS no console: ' + JSON.stringify(jsErr));
    results.push({ name, ok: true });
    console.log('  ✓ ' + name);
  } catch (e) {
    results.push({ name, ok: false, err: e.message });
    console.log('  ✗ ' + name + '\n      ' + e.message);
  }
}

const browser = await chromium.launch();

async function novaPagina() {
  const page = await browser.newPage();
  page.on('console', m => { if (m.type() === 'error') currentErrors.push(m.text()); });
  page.on('pageerror', e => currentErrors.push('PAGEERROR: ' + e.message));
  page.on('dialog', d => d.accept());
  await page.goto(APP_URL);
  await page.waitForTimeout(900);
  return page;
}

console.log('\nSoft Anestesia — smoke tests\n' + APP_URL + '\n');

/* 1) Boot sem erros de JS + tela de login presente */
await test('App carrega sem erros de JS e mostra a tela de acesso', async () => {
  const page = await novaPagina();
  const temOverlay = await page.evaluate(() => !!document.getElementById('auth-overlay'));
  const objetosGlobais = await page.evaluate(() =>
    ['pre', 'recuperacao', 'financeiro', 'store', 'printPreview', 'auth'].every(k => typeof window[k] !== 'undefined'));
  assert(temOverlay, 'overlay de autenticação deveria existir');
  assert(objetosGlobais, 'objetos globais dos módulos deveriam estar definidos');
  await page.close();
});

/* 2) Modo demonstração desbloqueia o app (recarrega a página) */
await test('Modo demonstração entra e desbloqueia a interface', async () => {
  const page = await novaPagina();
  /* demo.entrar() grava o flag e dá location.reload(); o reload destrói o
     contexto de execução — por isso ignoramos o erro e esperamos o app
     recarregar e reanexar os globais antes de checar. */
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'load' }).catch(() => {}),
    page.evaluate(() => demo.entrar()).catch(() => {})
  ]);
  await page.waitForFunction(() => typeof window.demo !== 'undefined' && typeof window.auth !== 'undefined', null, { timeout: 8000 });
  await page.waitForTimeout(500);
  const r = await page.evaluate(() => {
    const ov = document.getElementById('auth-overlay');
    return {
      demoAtivo: demo.ativo(),
      escondido: !ov || ov.style.display === 'none',
      logado: (typeof auth.estaLogado === 'function') ? auth.estaLogado() : true
    };
  });
  assert(r.demoAtivo, 'flag de demonstração deveria estar ligado após entrar');
  assert(r.logado, 'sessão de demonstração deveria estar logada após o reload');
  assert(r.escondido, 'overlay deveria sumir no modo demonstração');
  /* Limpa o flag para não vazar para outros testes (mesmo perfil de storage). */
  await page.evaluate(() => { try { demo.sair && localStorage.removeItem('medsys.v7.demo'); } catch (e) {} }).catch(() => {});
  await page.close();
});

/* 3) Pré-anestésica — navegação por seções e completude */
await test('Pré: nav de 6 seções, estados de preenchimento e checklist de finalização', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    location.hash = '#pre';
    await new Promise(r => setTimeout(r, 300));
    const f = document.getElementById('form-pre');
    const set = (n, v) => { const el = f.querySelector('[name="' + n + '"]'); if (el) el.value = v; };
    pre.nav.render();
    const nChips = document.querySelectorAll('#pre-nav .pre-nav-chip').length;
    set('comorbidades', 'HAS'); set('medicacoes', 'Losartana'); set('alergias', 'Nega');
    const anamnese = pre.nav._estado(pre.nav.SECOES[1]);        // completo
    set('asa', 'ASA II');
    const risco = pre.nav._estado(pre.nav.SECOES[4]);            // parcial
    const avisos = pre._checarCompletude();                     // faltam via aérea, jejum, conclusão, nome
    return { nChips, anamnese, risco, temViaAerea: avisos.some(a => /Via aérea/.test(a)) };
  });
  assert(r.nChips === 6, 'deveria haver 6 chips de seção, veio ' + r.nChips);
  assert(r.anamnese === 'completo', 'anamnese preenchida deveria ser completo');
  assert(r.risco === 'parcial', 'risco só com ASA deveria ser parcial');
  assert(r.temViaAerea, 'checklist deveria apontar via aérea faltante');
  await page.close();
});

/* 4) SRPA — PADSS e resumo de alta */
await test('SRPA: PADSS pontua e bloqueia critério zerado; resumo de alta gera texto', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    location.hash = '#recuperacao';
    await new Promise(r => setTimeout(r, 300));
    const f = document.getElementById('form-recuperacao');
    const set = (n, v) => { const el = f.querySelector('[name="' + n + '"]'); if (el) { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); } };
    ['pad_vitais', 'pad_deambulacao', 'pad_nausea', 'pad_dor', 'pad_sangramento'].forEach(n => set(n, '2'));
    recuperacao.padss.calc();
    const total = f.querySelector('[name=pad_total]').value;            // 10/10
    const apto = document.getElementById('padss-interpretacao').textContent.includes('Apto');
    set('pad_dor', '0'); recuperacao.padss.calc();
    const bloq = document.getElementById('padss-interpretacao').textContent.includes('critério pontuado 0');
    // resumo de alta
    set('pad_dor', '2');
    set('nome', 'Maria'); set('entrada', '14:00'); set('alta', '15:30'); set('destino', 'Alta hospitalar');
    ['aldk_atividade', 'aldk_respiracao', 'aldk_circulacao', 'aldk_consciencia', 'aldk_saturacao'].forEach(n => set(n, '2'));
    recuperacao.aldrete.calc();
    recuperacao.resumoAlta.gerar();
    const resumo = f.querySelector('[name=resumo_alta]').value;
    return { total, apto, bloq, temTempo: resumo.includes('1h30'), temEscalas: resumo.includes('PADSS') };
  });
  assert(r.total === '10/10', 'PADSS 5×2 deveria somar 10/10, veio ' + r.total);
  assert(r.apto, 'PADSS 10 deveria indicar apto');
  assert(r.bloq, 'critério 0 deveria bloquear a alta');
  assert(r.temTempo && r.temEscalas, 'resumo de alta deveria conter tempo e escalas');
  await page.close();
});

/* 5) Financeiro — fechamento de caixa */
await test('Financeiro: fechamento de caixa soma recebido/previsto e salva snapshot', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    location.hash = '#financeiro';
    await new Promise(r => setTimeout(r, 200));
    const hoje = utils.hojeISO();
    store.setList('financeiro', [
      { _id: 'f1', paciente: 'A', data_proc: hoje, valor_previsto: 1000, valor_recebido: 800, glosa: 100, data_recebimento: hoje, tipo_pagamento: 'Convênio', convenio: 'Unimed' },
      { _id: 'f2', paciente: 'B', data_proc: hoje, valor_previsto: 500, valor_recebido: 0, glosa: 0, tipo_pagamento: 'Convênio', convenio: 'Bradesco' },
      { _id: 'f3', paciente: 'C', data_proc: hoje, valor_previsto: 300, valor_pago: 300, data_pagamento: hoje, tipo_pagamento: 'Particular' }
    ]);
    const res = financeiro.caixa._resumo(hoje);
    financeiro.caixa.abrir(hoje);
    const modal = !!document.getElementById('caixa-data');
    financeiro.caixa.salvar(hoje);
    const fechs = store.list('fin_fechamentos');
    return { somaRec: res.somaRec, somaPrev: res.somaPrev, aReceber: res.aReceber, modal, nFech: fechs.length, fechRec: fechs[0] && fechs[0].somaRec };
  });
  assert(r.somaRec === 1100, 'recebido do dia deveria ser 1100, veio ' + r.somaRec);
  assert(r.somaPrev === 1800, 'previsto deveria ser 1800, veio ' + r.somaPrev);
  assert(r.aReceber === 900, 'a receber deveria ser 900, veio ' + r.aReceber);
  assert(r.modal, 'modal de caixa deveria abrir');
  assert(r.nFech === 1 && r.fechRec === 1100, 'snapshot deveria salvar com recebido 1100');
  await page.close();
});

/* 6) Versionamento — _rev incrementa e carimbo aparece no rodapé */
await test('Versionamento: _rev incrementa a cada save e o carimbo entra no rodapé do PDF', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    location.hash = '#pre';
    await new Promise(r => setTimeout(r, 300));
    const f = document.getElementById('form-pre');
    const set = (n, v) => { const el = f.querySelector('[name="' + n + '"]'); if (el) el.value = v; };
    set('nome', 'João'); set('data', '2026-07-23');
    pre.salvar();
    const id = f.querySelector('[name="_id"]').value;
    const rev1 = store.getById('pre', id)._rev;
    set('asa', 'ASA II'); pre.salvar();
    const rev2 = store.getById('pre', id)._rev;
    printPreview._verCtx = { mod: 'pre', formId: 'form-pre' };
    const stamp = printPreview._versaoStamp();
    const footer = printPreview._footer('Avaliação pré-anestésica');
    return { rev1, rev2, stampTemRev: /Rev\. 2/.test(stamp), footerTemDoc: /Doc /.test(footer) };
  });
  assert(r.rev1 === 1 && r.rev2 === 2, 'rev deveria ir 1 → 2, veio ' + r.rev1 + '/' + r.rev2);
  assert(r.stampTemRev, 'carimbo deveria mostrar Rev. 2');
  assert(r.footerTemDoc, 'rodapé deveria conter o código do documento');
  await page.close();
});

/* 7) Risco — escores clínicos (funções puras do protocolo) */
await test('Risco: escores (ARISCAT, RCRI, STOP-Bang, Caprini, ASA) calculam certo', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => ({
    ariscatBaixo: risco._ariscatRisk(20),        // ['Baixo', 1.6]
    ariscatInter: risco._ariscatRisk(30)[0],     // 'Intermediário'
    ariscatAlto: risco._ariscatRisk(50)[0],      // 'Alto'
    rcri0: risco._rcriRisk(0),                    // 3.9
    rcri2: risco._rcriRisk(2),                    // 10.1
    stopBaixo: risco._stopRisk(1)[0],             // 'Baixo'
    stopAlto: risco._stopRisk(5)[0],              // 'Alto'
    capMuitoBaixo: risco._capRisk(0)[0],          // 'Muito baixo'
    asa3: risco._asaRisk(3)                       // 3.5
  }));
  assert(r.ariscatBaixo[0] === 'Baixo' && r.ariscatBaixo[1] === 1.6, 'ARISCAT baixo errado');
  assert(r.ariscatInter === 'Intermediário' && r.ariscatAlto === 'Alto', 'ARISCAT faixas erradas');
  assert(r.rcri0 === 3.9 && r.rcri2 === 10.1, 'RCRI errado');
  assert(r.stopBaixo === 'Baixo' && r.stopAlto === 'Alto', 'STOP-Bang errado');
  assert(r.capMuitoBaixo === 'Muito baixo', 'Caprini errado');
  assert(r.asa3 === 3.5, 'ASA errado');
  await page.close();
});

/* 8) Impressão — todos os construtores de PDF geram HTML sem lançar erro */
await test('Impressão: todos os builders de documento geram HTML válido', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const nomes = ['Pre', 'Consulta', 'Anestesia', 'Recuperacao', 'Termo', 'Prescricao', 'Documento', 'Risco', 'Financeiro', 'Agenda'];
    const out = {};
    nomes.forEach(n => {
      const fn = printPreview['_build' + n];
      try {
        const html = fn ? fn() : null;
        out[n] = (typeof html === 'string' && html.length > 100) ? 'ok' : 'vazio';
      } catch (e) { out[n] = 'ERRO: ' + e.message; }
    });
    return out;
  });
  const falhas = Object.entries(r).filter(([, v]) => v !== 'ok');
  assert(falhas.length === 0, 'builders com problema: ' + JSON.stringify(r));
  await page.close();
});

/* 9) Store — persistência: salvar, buscar por id e excluir */
await test('Store: salvar, buscar por id e excluir mantêm a consistência', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const antes = store.list('agenda').length;
    const saved = store.save('agenda', { paciente: 'Teste Store', data: utils.hojeISO() });
    const temId = !!saved._id && saved._rev === 1;
    const achado = store.getById('agenda', saved._id);
    const depoisSalvar = store.list('agenda').length;
    store.delete('agenda', saved._id);
    const removido = !store.getById('agenda', saved._id);
    return { temId, achado: !!achado && achado.paciente === 'Teste Store', cresceu: depoisSalvar === antes + 1, removido };
  });
  assert(r.temId, 'save deveria gerar _id e _rev=1');
  assert(r.achado, 'getById deveria retornar o registro salvo');
  assert(r.cresceu, 'a lista deveria crescer em 1 após salvar');
  assert(r.removido, 'delete deveria remover o registro');
  await page.close();
});

/* 10) Adendos — correção anexada a um registro finalizado, sem alterar o original */
await test('Adendos: correção é anexada ao registro finalizado (append-only)', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    store.setList('anestesia', [{ _id: 'a1', _finalizado: true, paciente: 'X', procedimento: 'Colecistectomia' }]);
    const f = document.getElementById('form-anestesia');
    let h = f.querySelector('[name="_id"]');
    if (!h) { h = document.createElement('input'); h.type = 'hidden'; h.name = '_id'; f.appendChild(h); }
    h.value = 'a1';
    adendos.abrir('anestesia');
    const ta = document.getElementById('adendo-texto');
    if (ta) ta.value = 'Onde se lê X, leia-se Y.';
    adendos.salvar('anestesia', 'a1');
    const rec = store.getById('anestesia', 'a1');
    return {
      n: (rec._adendos || []).length,
      texto: rec._adendos && rec._adendos[0] && rec._adendos[0].texto,
      originalIntacto: rec.procedimento === 'Colecistectomia'
    };
  });
  assert(r.n === 1, 'deveria haver 1 adendo, veio ' + r.n);
  assert(/leia-se Y/.test(r.texto || ''), 'texto do adendo não persistiu');
  assert(r.originalIntacto, 'o registro original deveria permanecer intacto');
  await page.close();
});

/* 11) Doses — cálculo de infusão contínua (mL/h) por unidade */
await test('Doses: conversão de dose para mL/h (mcg/kg/min, mcg/min, mg/h) está correta', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => ({
    // 0,1 mcg/kg/min · 70 kg · conc 50 mcg/mL = 0,1*70*60/50 = 8,4 mL/h
    mcgKgMin: doses._mlh(0.1, 'mcg/kg/min', 50, 70),
    // 5 mcg/min · conc 50 = 5*60/50 = 6 mL/h
    mcgMin: doses._mlh(5, 'mcg/min', 50, null),
    // 2 mg/h · conc 1000 mcg/mL = 2*1000/1000 = 2 mL/h
    mgH: doses._mlh(2, 'mg/h', 1000, null),
    // 1 UI/h · conc 100 UI/mL = 0,01 mL/h
    uiH: doses._mlh(1, 'UI/h', 100, null),
    // sem peso numa dose /kg → null (não calcula às cegas)
    semPeso: doses._mlh(0.1, 'mcg/kg/min', 50, null)
  }));
  const perto = (a, b) => Math.abs(a - b) < 1e-6;
  assert(perto(r.mcgKgMin, 8.4), 'mcg/kg/min deveria dar 8.4, veio ' + r.mcgKgMin);
  assert(perto(r.mcgMin, 6), 'mcg/min deveria dar 6, veio ' + r.mcgMin);
  assert(perto(r.mgH, 2), 'mg/h deveria dar 2, veio ' + r.mgH);
  assert(perto(r.uiH, 0.01), 'UI/h deveria dar 0.01, veio ' + r.uiH);
  assert(r.semPeso === null, 'dose /kg sem peso deveria retornar null');
  await page.close();
});

/* 12) RBAC — permissões por papel governam acesso e edição */
await test('RBAC: papel governa podeAcessar/podeEditar (admin, secretária só-impressão)', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    // Admin enxerga e edita tudo
    auth._definirSessao({ id: 'adm', usuario: 'adm', nome: 'Admin', perfil: 'admin', modulos: [], soImpressao: [] });
    out.admAcessa = auth.podeAcessar('financeiro');
    out.admEdita = auth.podeEditar('anestesia');
    // Secretária: acessa pré e agenda; pré é só-impressão; não acessa anestesia
    auth._definirSessao({ id: 'sec', usuario: 'sec', nome: 'Bete', perfil: 'secretaria', modulos: ['pre', 'agenda'], soImpressao: ['pre'] });
    out.secAcessaPre = auth.podeAcessar('pre');
    out.secEditaPre = auth.podeEditar('pre');        // false — só impressão
    out.secEditaAgenda = auth.podeEditar('agenda');  // true
    out.secAcessaAnest = auth.podeAcessar('anestesia'); // false
    // limpa a sessão de teste
    try { sessionStorage.removeItem(auth.SESSION_KEY); } catch (e) {}
    return out;
  });
  assert(r.admAcessa && r.admEdita, 'admin deveria acessar e editar tudo');
  assert(r.secAcessaPre === true, 'secretária deveria acessar a pré');
  assert(r.secEditaPre === false, 'secretária não deveria editar a pré (só impressão)');
  assert(r.secEditaAgenda === true, 'secretária deveria editar a agenda');
  assert(r.secAcessaAnest === false, 'secretária não deveria acessar a anestesia');
  await page.close();
});

/* 13) Fila offline — operações idempotentes com dedup por documento */
await test('Sync: fila offline dedupa por documento e carimba operation_id/base_version', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    cloud._limparFila();
    const op1 = cloud._novaOp('pre', { _id: 'x', _updatedAt: 't1' }, 'upsert');
    cloud._enfileirar(op1);
    const op1b = cloud._novaOp('pre', { _id: 'x', _updatedAt: 't2' }, 'upsert'); // mesmo doc
    cloud._enfileirar(op1b);
    const op2 = cloud._novaOp('pre', { _id: 'y', _updatedAt: 't3' }, 'delete');  // outro doc
    cloud._enfileirar(op2);
    const fila = cloud._fila();
    const xOp = fila.find(o => o.doc_id === 'x');
    const out = {
      len: fila.length,
      xBaseVersion: xOp && xOp.base_version,          // 't2' — última vence
      retryZero: fila.every(o => o.retry_count === 0),
      temOpId: fila.every(o => !!o.operation_id),
      idsUnicos: new Set(fila.map(o => o.operation_id)).size === fila.length
    };
    cloud._limparFila();
    out.aposLimpar = cloud._fila().length;
    return out;
  });
  assert(r.len === 2, 'fila deveria ter 2 ops (x deduplicada, y à parte), veio ' + r.len);
  assert(r.xBaseVersion === 't2', 'dedup deveria manter a última versão de x (t2), veio ' + r.xBaseVersion);
  assert(r.retryZero, 'ops nascem com retry_count 0');
  assert(r.temOpId && r.idsUnicos, 'cada op deveria ter operation_id único');
  assert(r.aposLimpar === 0, '_limparFila deveria esvaziar a fila');
  await page.close();
});

/* 14) Sync — push falho enfileira; sincronizar reenvia; retry incrementa */
await test('Sync: push offline enfileira, sincronização drena a fila e conta retry', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    /* Isola do ambiente real: força "configurado + logado" e intercepta o
       envio de rede (que normalmente falaria com o Supabase). */
    cloud.estaConfigurado = () => true;
    cloud.estaLogado = () => true;
    cloud._baixarTudo = async () => ({});   // nada a baixar
    let online = false;
    cloud._enviarOp = async () => online;   // false = "offline"
    cloud._limparFila();

    // 1) push com rede falhando → operação vai para a fila
    await cloud.pushDoc('pre', { _id: 'd1', _updatedAt: 't1' }, 'upsert');
    const aposPush = cloud._fila().length;

    // 2) rede volta → sincronizar drena a fila
    online = true;
    await cloud.sincronizar({ silent: true });
    const aposSyncOk = cloud._fila().length;

    // 3) rede cai de novo → op permanece e retry_count incrementa
    online = false;
    cloud._enfileirar(cloud._novaOp('pre', { _id: 'd2', _updatedAt: 't2' }, 'upsert'));
    await cloud.sincronizar({ silent: true });
    const fila = cloud._fila();
    return { aposPush, aposSyncOk, aindaNaFila: fila.length, retry: fila[0] && fila[0].retry_count };
  });
  assert(r.aposPush === 1, 'push com rede falhando deveria enfileirar (1), veio ' + r.aposPush);
  assert(r.aposSyncOk === 0, 'sincronização com rede OK deveria drenar a fila, sobrou ' + r.aposSyncOk);
  assert(r.aindaNaFila === 1, 'op não enviada deveria permanecer na fila');
  assert(r.retry === 1, 'retry_count deveria incrementar para 1, veio ' + r.retry);
  await page.close();
});

/* 15) Ficha — modo cirurgia: nav de seções + FAB de tempos + FAB de medicação */
await test('Ficha: nav de seções com contadores, FAB tempos carimba e FAB med existe', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    location.hash = '#anestesia';
    await new Promise(r => setTimeout(r, 400));
    anestesia.nav._wire(); anestesia.nav.render();
    out.nChips = document.querySelectorAll('#ficha-nav .pre-nav-chip').length;   // 9
    // FABs visíveis na ficha
    out.fabMed = (document.getElementById('fab-med') || {}).style.display;
    out.fabTempos = (document.getElementById('fab-tempos') || {}).style.display;
    // adicionar uma linha de vitais → contador aparece
    anestesia.vitais.add(true);
    await new Promise(r => setTimeout(r, 300));
    out.navTemContador = document.getElementById('ficha-nav').innerHTML.includes('pn-num');
    // tempos: abrir modal, próximo destacado, carimbar entrada em sala
    anestesia.tempos.abrir();
    out.modalLinhas = document.querySelectorAll('#tempos-modal-body .tempos-row').length; // 6
    out.temProximo = !!document.querySelector('#tempos-modal-body .tp-proximo');
    // com modal aberto, os flutuantes somem (não podem cobrir o modal)
    out.bodyTemModal = document.body.classList.contains('tem-modal');
    out.fabEscondido = getComputedStyle(document.getElementById('fab-med')).display === 'none';
    anestesia.tempos.marcar('hora_sala_entrada');
    const f = document.getElementById('form-anestesia');
    out.horaMarcada = /^\d{2}:\d{2}/.test((f.querySelector('[name=hora_sala_entrada]') || {}).value || '');
    // depois de marcar, a linha vira feita e o próximo avança
    out.temFeito = !!document.querySelector('#tempos-modal-body .tp-feito');
    // fechar o modal devolve os flutuantes
    modal.close();
    out.fabVoltou = getComputedStyle(document.getElementById('fab-med')).display !== 'none' &&
      !document.body.classList.contains('tem-modal');
    // nav.ir expande card recolhido
    const card = anestesia.nav._mapa()['8'];
    if (card) card.classList.add('collapsed');
    anestesia.nav.ir('8');
    out.irExpandiu = card ? !card.classList.contains('collapsed') : false;
    return out;
  });
  assert(r.nChips === 9, 'deveria haver 9 chips na ficha-nav, veio ' + r.nChips);
  assert(r.fabMed === 'flex' && r.fabTempos === 'flex', 'FABs de med/tempos deveriam estar visíveis na ficha');
  assert(r.navTemContador, 'chip de vitais deveria mostrar contador de linhas');
  assert(r.modalLinhas === 6 && r.temProximo, 'modal de tempos deveria ter 6 linhas com próximo destacado');
  assert(r.bodyTemModal && r.fabEscondido, 'com modal aberto, os FABs deveriam sumir (não cobrir o modal)');
  assert(r.fabVoltou, 'ao fechar o modal, os FABs deveriam voltar');
  assert(r.horaMarcada, 'marcar() deveria carimbar HH:MM na entrada em sala');
  assert(r.temFeito, 'linha carimbada deveria ficar como feita');
  assert(r.irExpandiu, 'nav.ir deveria expandir o card recolhido');
  await page.close();
});

/* 16) Vitais — auto-avanço na GRADE da ficha (superfície real de digitação) */
await test('Vitais: grade auto-insere a barra da PA e desce a coluna ao completar valores', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    location.hash = '#anestesia';
    await new Promise(r => setTimeout(r, 400));
    ui.expandirTodos('anestesia');   /* cards recolhidos não recebem foco */
    anestesia.vitais.autoAvanco.wire();
    anestesia.vitais._gradeAddCol();  /* cria a coluna do horário atual */
    await new Promise(r => setTimeout(r, 200));
    const grade = document.getElementById('vitais-grade');
    const cel = (sel) => grade.querySelector(sel);
    const digita = (el, v) => { el.focus(); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };

    const pa = cel('input[data-kind="pa"]');
    // PAS "12" ainda pode virar 120 → nada acontece
    digita(pa, '12');
    out.pa12 = pa.value;                                   // '12'
    // PAS "120" completa → barra entra sozinha
    digita(pa, '120');
    out.pa120 = pa.value;                                  // '120/'
    // PAD "80" completa → grava e desce a coluna (pulando a PAM automática)
    digita(pa, '120/80');
    out.focoAposPA = (document.activeElement.dataset || {}).field;   // 'fc'
    // valores gravados no modelo interno
    const tr0 = document.querySelector('#vitais-body tr');
    out.modeloPas = tr0.querySelector('[name="vit_pas[]"]').value;   // '120'
    out.modeloPad = tr0.querySelector('[name="vit_pad[]"]').value;   // '80'
    out.modeloPam = tr0.querySelector('[name="vit_pam[]"]').value;   // calculada
    // FC "68" completa → desce para o próximo campo numérico da coluna (SpO₂; Ritmo é select)
    digita(document.activeElement, '68');
    out.focoAposFC = (document.activeElement.dataset || {}).field;   // 'spo2'
    // SpO₂ "10" pode virar 100 → fica
    digita(document.activeElement, '10');
    out.foco10 = (document.activeElement.dataset || {}).field;       // 'spo2'
    digita(document.activeElement, '100');
    out.foco100 = (document.activeElement.dataset || {}).field;      // 'etco2'
    return out;
  });
  assert(r.pa12 === '12', 'PAS 12 ainda pode crescer — não deveria ganhar barra, veio ' + r.pa12);
  assert(r.pa120 === '120/', 'PAS 120 deveria ganhar a barra sozinha, veio ' + r.pa120);
  assert(r.focoAposPA === 'fc', 'PAD completa deveria descer para a FC (pulando PAM), foco em ' + r.focoAposPA);
  assert(r.modeloPas === '120' && r.modeloPad === '80' && r.modeloPam !== '', 'PA deveria gravar no modelo com PAM calculada');
  assert(r.focoAposFC === 'spo2', 'FC completa deveria descer para a SpO₂, foco em ' + r.focoAposFC);
  assert(r.foco10 === 'spo2', 'SpO₂ 10 pode virar 100 — não deveria avançar');
  assert(r.foco100 === 'etco2', 'SpO₂ 100 deveria descer para o EtCO₂, foco em ' + r.foco100);
  await page.close();
});

/* 17) Meu dia — cruza agenda × ficha × SRPA × financeiro de hoje por paciente */
await test('Meu dia: casos de hoje cruzados por paciente com estados de cada etapa', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const hoje = utils.hojeISO();
    store.setList('agenda', [
      { _id: 'ag1', paciente: 'Ana Souza', data: hoje, hora: '07:30', tipo: 'Cirurgia', procedimento: 'Cesárea' },
      { _id: 'ag2', paciente: 'Bruno Lima', data: hoje, hora: '10:00', tipo: 'Cirurgia', procedimento: 'Hernioplastia' }
    ]);
    store.setList('anestesia', [
      { _id: 'an1', paciente_nome: 'ANA SOUZA', data_anestesia: hoje, _finalizado: true, procedimento: 'Cesárea', hora_sala_entrada: '07:35' },
      { _id: 'an2', paciente_nome: 'Carla Nunes', data_anestesia: hoje, procedimento: 'Colecistectomia' }
    ]);
    store.setList('recuperacao', [{ _id: 'sr1', nome: 'Ana Souza', data: hoje }]);
    store.setList('financeiro', [{ _id: 'f1', paciente: 'ana souza', data_proc: hoje, status: 'pendente' }]);

    const casos = meuDia.coletar();
    const ana = casos.find(c => meuDia._norm(c.nome) === 'ana souza');
    const bruno = casos.find(c => meuDia._norm(c.nome) === 'bruno lima');
    const carla = casos.find(c => meuDia._norm(c.nome) === 'carla nunes');

    location.hash = '#dashboard';
    await new Promise(r => setTimeout(r, 400));
    meuDia.render();
    const html = document.getElementById('meu-dia-lista').innerHTML;
    const resumo = document.getElementById('meu-dia-resumo').innerHTML;
    return {
      nCasos: casos.length,                                    // 3 (Ana unificada apesar de caixa/caixa-baixa)
      anaCompleta: !!(ana && ana.agenda && ana.ficha && ana.srpa && ana.fin),
      anaFichaFinal: !!(ana && ana.ficha && ana.ficha._finalizado),
      brunoSoAgenda: !!(bruno && bruno.agenda && !bruno.ficha),
      carlaSoFicha: !!(carla && !carla.agenda && carla.ficha && !carla.ficha._finalizado),
      ordemHora: casos[0] && casos[0].hora === '07:30',
      temIniciar: html.includes('▶ Iniciar'),                  // Bruno
      temFichaOk: html.includes('Ficha ✓'),                    // Ana
      temFichaRasc: html.includes('Ficha…'),                   // Carla
      temFinPend: html.includes('Fin…'),                       // Ana (pendente)
      resumoTemCasos: resumo.includes('Casos hoje')
    };
  });
  assert(r.nCasos === 3, 'deveriam ser 3 casos (Ana unificada), veio ' + r.nCasos);
  assert(r.anaCompleta && r.anaFichaFinal, 'Ana deveria ter as 4 etapas com ficha finalizada');
  assert(r.brunoSoAgenda, 'Bruno deveria estar só na agenda');
  assert(r.carlaSoFicha, 'Carla deveria ter só a ficha em rascunho');
  assert(r.ordemHora, 'casos deveriam ordenar por hora (07:30 primeiro)');
  assert(r.temIniciar && r.temFichaOk && r.temFichaRasc && r.temFinPend, 'chips de estado deveriam refletir cada situação');
  assert(r.resumoTemCasos, 'resumo do plantão deveria aparecer');
  await page.close();
});

/* 18) Service worker — o app abre OFFLINE depois da primeira visita (http) */
await test('Offline: service worker cacheia o app e o reload sem rede funciona', async () => {
  /* servidor estático mínimo do repositório (index.html + sw.js) */
  const raiz = resolve(__dirname, '..');
  const server = createServer(async (req, res) => {
    const p = req.url.split('?')[0];
    const arquivo = p === '/' ? '/index.html' : p;
    try {
      const data = await readFile(resolve(raiz, '.' + arquivo));
      const ct = arquivo.endsWith('.js') ? 'text/javascript; charset=utf-8'
        : arquivo.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': ct });
      res.end(data);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const porta = server.address().port;
  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    page.on('console', m => { if (m.type() === 'error') currentErrors.push(m.text()); });
    page.on('pageerror', e => currentErrors.push('PAGEERROR: ' + e.message));
    page.on('dialog', d => d.accept());

    await page.goto('http://127.0.0.1:' + porta + '/index.html');
    await page.waitForTimeout(800);
    const swAtivo = await page.evaluate(() =>
      navigator.serviceWorker.ready.then(r => !!r.active).catch(() => false));
    assert(swAtivo, 'service worker deveria registrar e ativar em http');

    /* 1º reload ONLINE: agora a navegação passa pelo SW e o index entra no cache */
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(1200);

    /* derruba a rede e recarrega — o app deve abrir do cache */
    await ctx.setOffline(true);
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(800);
    const r = await page.evaluate(() => ({
      temApp: !!document.getElementById('auth-overlay'),
      temStore: typeof window.store !== 'undefined'
    }));
    assert(r.temApp && r.temStore, 'app deveria abrir OFFLINE a partir do cache do service worker');
    await ctx.setOffline(false);
  } finally {
    await ctx.close();
    await new Promise(r => server.close(r));
  }
});

/* 19) Armazenamento — versões saneadas + limpezas de um toque */
await test('Armazenamento: histórico sem base64, compactação e liberação de anexos duplicados', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    const GORDO = 'data:image/png;base64,' + 'A'.repeat(60000);

    // 1) salvar 2x um doc com assinatura pesada → snapshot da versão é saneado
    const doc = store.save('pre', { nome: 'Pac Storage', assinatura_dataurl: GORDO });
    store.save('pre', { _id: doc._id, nome: 'Pac Storage v2', assinatura_dataurl: GORDO });
    const vers = store.listVersions('pre', doc._id);
    out.temVersao = vers.length === 1;
    out.versaoSaneada = vers[0] && vers[0].snapshot.assinatura_dataurl === '[binário removido do histórico de versões]';
    out.docIntacto = store.getById('pre', doc._id).assinatura_dataurl === GORDO;   // o documento REAL não muda

    // 2) compactar: semeia 6 versões gordas antigas → fica ≤3, todas saneadas, tamanho cai
    const all = JSON.parse(localStorage.getItem('medsys.v7.versions') || '{}');
    all['pre:velho'] = Array.from({ length: 6 }, (_, i) => ({ ts: 't' + i, snapshot: { nome: 'v' + i, foto: GORDO } }));
    localStorage.setItem('medsys.v7.versions', JSON.stringify(all));
    const antes = localStorage.getItem('medsys.v7.versions').length;
    armazenamento.compactarVersoes();
    const depoisAll = JSON.parse(localStorage.getItem('medsys.v7.versions'));
    out.compactou = depoisAll['pre:velho'].length === 3 &&
      depoisAll['pre:velho'].every(v => v.snapshot.foto !== GORDO) &&
      localStorage.getItem('medsys.v7.versions').length < antes;

    // 3) liberar anexos: doc com dataurl + storage_path perde o dataurl; pendente (sem path) fica
    store.setList('anestesia', [{ _id: 'ax', paciente_nome: 'X', _docs: [
      { nome: 'exame.jpg', storage_path: 'uid/anexos/exame.jpg', dataurl: GORDO },
      { nome: 'pendente.jpg', dataurl: GORDO }
    ] }]);
    armazenamento.liberarAnexos();
    const rec = store.getById('anestesia', 'ax');
    out.liberou = !rec._docs[0].dataurl && rec._docs[0].storage_path === 'uid/anexos/exame.jpg';
    out.pendenteFicou = rec._docs[1].dataurl === GORDO;

    // 4) uso() responde com total e rótulos amigáveis
    const u = armazenamento.uso();
    out.usoOk = u.total > 0 && u.itens.length > 0;
    out.rotuloVersoes = armazenamento._rotulo('medsys.v7.versions').includes('versões');
    return out;
  });
  assert(r.temVersao && r.versaoSaneada, 'snapshot de versão deveria ser saneado (sem base64)');
  assert(r.docIntacto, 'o documento atual NÃO deveria ser alterado pelo saneamento');
  assert(r.compactou, 'compactarVersoes deveria limitar a 3 e remover base64, reduzindo o tamanho');
  assert(r.liberou, 'anexo já na nuvem deveria perder a cópia local');
  assert(r.pendenteFicou, 'anexo pendente (sem storage_path) deveria ser preservado');
  assert(r.usoOk && r.rotuloVersoes, 'uso() e rótulos deveriam funcionar');
  await page.close();
});

/* 20) Armazenamento — auto-manutenção na inicialização */
await test('Armazenamento: auto-manutenção compacta o histórico antigo uma única vez e avisa antes de encher', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    const GORDO = 'data:image/png;base64,' + 'B'.repeat(50000);

    // histórico antigo gordo + sem flag → autoManutencao sanitiza e limita a 5
    localStorage.removeItem(armazenamento.FLAG_COMPACT);
    const all = {};
    all['anestesia:legado'] = Array.from({ length: 8 }, (_, i) => ({ ts: 't' + i, snapshot: { nome: 'v' + i, assinatura_dataurl: GORDO } }));
    localStorage.setItem('medsys.v7.versions', JSON.stringify(all));
    armazenamento.autoManutencao();
    const depois = JSON.parse(localStorage.getItem('medsys.v7.versions'));
    out.limitou = depois['anestesia:legado'].length === 5;
    out.saneou = depois['anestesia:legado'].every(v => v.snapshot.assinatura_dataurl !== GORDO);
    out.flag = localStorage.getItem(armazenamento.FLAG_COMPACT) === '1';

    // idempotente: com a flag, uma nova versão gorda inserida à mão NÃO é tocada
    const all2 = JSON.parse(localStorage.getItem('medsys.v7.versions'));
    all2['anestesia:legado'].unshift({ ts: 'novo', snapshot: { foto: GORDO } });
    localStorage.setItem('medsys.v7.versions', JSON.stringify(all2));
    armazenamento.autoManutencao();
    const depois2 = JSON.parse(localStorage.getItem('medsys.v7.versions'));
    out.idempotente = depois2['anestesia:legado'][0].snapshot.foto === GORDO;

    // aviso preventivo: uso > 4 MB → toast aparece
    localStorage.setItem('teste.gordura', 'X'.repeat(2200000));   // ~4,4 MB em UTF-16
    armazenamento.autoManutencao();
    await new Promise(r => setTimeout(r, 200));
    out.avisou = document.body.textContent.includes('libere espaço em Ajustes');
    localStorage.removeItem('teste.gordura');

    // teto local de anexos compatível com o celular
    out.tetoLocal = prontuario.MAX_LOCAL_TOTAL === 3 * 1024 * 1024;
    return out;
  });
  assert(r.limitou && r.saneou, 'auto-manutenção deveria limitar a 5 e sanear o histórico antigo');
  assert(r.flag, 'flag de compactação deveria ser gravada');
  assert(r.idempotente, 'com a flag presente, não deveria mexer de novo no histórico');
  assert(r.avisou, 'acima de ~4 MB deveria avisar antes de encher');
  assert(r.tetoLocal, 'teto local de anexos deveria ser 3 MB');
  await page.close();
});

await browser.close();

/* Resumo */
const falhas = results.filter(r => !r.ok);
console.log('\n' + (results.length - falhas.length) + '/' + results.length + ' testes passaram.');
if (falhas.length) {
  console.log('\nFalhas:');
  falhas.forEach(f => console.log('  ✗ ' + f.name + ' — ' + f.err));
  process.exit(1);
}
console.log('Tudo verde ✅\n');
process.exit(0);
