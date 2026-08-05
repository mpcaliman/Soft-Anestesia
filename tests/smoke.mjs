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
    // Speed dial único visível na ficha; alça de rolagem removida
    out.dialVisivel = (document.getElementById('fab-dial') || {}).style.display;
    out.alcaSumiu = !document.getElementById('page-scroller');
    // abrir o dial lista as 8 ações da ficha (inclui calculadora e catálogo de eventos)
    fabDial.abrir();
    out.dialItens = document.querySelectorAll('#fab-dial-itens .fab-dial-item').length;   // 8
    out.dialTemCalc = document.getElementById('fab-dial-itens').innerHTML.includes('Calculadora');
    out.dialTemEvt = document.getElementById('fab-dial-itens').innerHTML.includes('Catálogo de eventos');
    fabDial.fechar();
    out.dialFechou = !document.getElementById('fab-dial').classList.contains('aberto');
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
    out.fabEscondido = getComputedStyle(document.getElementById('fab-dial')).display === 'none';
    anestesia.tempos.marcar('hora_sala_entrada');
    const f = document.getElementById('form-anestesia');
    out.horaMarcada = /^\d{2}:\d{2}/.test((f.querySelector('[name=hora_sala_entrada]') || {}).value || '');
    // depois de marcar, a linha vira feita e o próximo avança
    out.temFeito = !!document.querySelector('#tempos-modal-body .tp-feito');
    // fechar o modal devolve os flutuantes
    modal.close();
    out.fabVoltou = getComputedStyle(document.getElementById('fab-dial')).display !== 'none' &&
      !document.body.classList.contains('tem-modal');
    // nav.ir expande card recolhido
    const card = anestesia.nav._mapa()['8'];
    if (card) card.classList.add('collapsed');
    anestesia.nav.ir('8');
    out.irExpandiu = card ? !card.classList.contains('collapsed') : false;
    return out;
  });
  assert(r.nChips === 9, 'deveria haver 9 chips na ficha-nav, veio ' + r.nChips);
  assert(r.dialVisivel === 'flex', 'speed dial deveria estar visível na ficha, veio ' + r.dialVisivel);
  assert(r.alcaSumiu, 'a alça de rolagem (page-scroller) deveria ter sido removida');
  assert(r.dialItens === 8 && r.dialTemCalc && r.dialTemEvt, 'dial aberto deveria listar 8 ações incluindo calculadora e catálogo de eventos, veio ' + r.dialItens);
  assert(r.dialFechou, 'fechar() deveria recolher o dial');
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

/* 21) Cadastros — grupos do menu recolhíveis com preferência lembrada */
await test('Cadastros: grupos recolhíveis — só o ativo aberto, toggle persiste, selecionar reabre', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    localStorage.removeItem(ajustes.GRUPOS_KEY);
    location.hash = '#ajustes';
    await new Promise(r => setTimeout(r, 500));
    ajustes._activeCat = 'cad_assinaturas';   /* grupo Perfil e equipe */
    ajustes.render();
    const cats = () => document.getElementById('ajustes-cats');
    const visiveis = () => cats().querySelectorAll('.cadastro-cat').length;
    const cabecalhos = () => cats().querySelectorAll('.cg-toggle').length;

    // padrão: 3 cabeçalhos, só o grupo ativo expandido (3 categorias de Perfil e equipe)
    out.cabecalhos = cabecalhos();          // 3
    out.soAtivoAberto = visiveis() === 3;
    out.htmlTemTotal = cats().innerHTML.includes('cg-total');

    // expandir outro grupo → soma as categorias dele (4 de Locais e faturamento)
    ajustes.alternarGrupo('Locais e faturamento');
    out.aposAbrir = visiveis();             // 7
    // recolher o grupo ativo → some
    ajustes.alternarGrupo('Perfil e equipe');
    out.aposRecolher = visiveis();          // 4
    // preferência persiste na chave
    const salvos = JSON.parse(localStorage.getItem(ajustes.GRUPOS_KEY));
    out.persistiu = salvos['Locais e faturamento'] === true && salvos['Perfil e equipe'] === false;

    // selecionar categoria de grupo fechado reabre o grupo
    ajustes.selecionar('cad_anestesistas');  /* Perfil e equipe, que está fechado */
    out.reabriu = !!cats().querySelector('.cadastro-cat.active') &&
      JSON.parse(localStorage.getItem(ajustes.GRUPOS_KEY))['Perfil e equipe'] === true;
    return out;
  });
  assert(r.cabecalhos === 3, 'deveriam ser 3 cabeçalhos de grupo, veio ' + r.cabecalhos);
  assert(r.soAtivoAberto, 'por padrão só o grupo ativo deveria estar expandido (3 itens)');
  assert(r.htmlTemTotal, 'cabeçalho deveria mostrar o total do grupo');
  assert(r.aposAbrir === 7, 'abrir Locais e faturamento deveria mostrar 7 itens, veio ' + r.aposAbrir);
  assert(r.aposRecolher === 4, 'recolher Perfil e equipe deveria deixar 4, veio ' + r.aposRecolher);
  assert(r.persistiu, 'preferência de grupos deveria persistir no localStorage');
  assert(r.reabriu, 'selecionar categoria de grupo fechado deveria reabri-lo');
  await page.close();
});

/* 22) Cadastros na nuvem — perfil/carimbo sincronizam; envio único inicial */
await test('Cadastros: entram na sincronização (fila offline) e sobem uma única vez no primeiro sync', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    // todos os módulos de cadastro fazem parte da sincronização
    out.cadsNoMods = cloud.CAD_MODS.every(m => cloud.MODS.includes(m));
    out.temAssinaturas = cloud.MODS.includes('cad_assinaturas');   // perfil/carimbo

    /* Isola do ambiente real (mesma técnica do teste 14) */
    cloud.estaConfigurado = () => true;
    cloud.estaLogado = () => true;
    cloud._baixarTudo = async () => ({});
    let online = false;
    const enviados = [];
    cloud._enviarOp = async (op) => { if (online) { enviados.push(op.modulo); return true; } return false; };
    cloud._limparFila();

    // 1) salvar um cadastro com rede falhando → op vai para a fila (como registro clínico)
    store.save('cad_anestesistas', { _id: 'an-teste', nome: 'Dr. Teste', crm: '12345' });
    await new Promise(r => setTimeout(r, 100));
    const fila = cloud._fila();
    out.enfileirou = fila.some(o => o.modulo === 'cad_anestesistas' && o.doc_id === 'an-teste');

    // 2) primeiro sync online → envio único dos cadastros pré-existentes + flag gravada
    localStorage.removeItem('medsys.v7.cads_sync_v1');
    online = true;
    await cloud.sincronizar({ silent: true });
    out.flagGravada = localStorage.getItem('medsys.v7.cads_sync_v1') === '1';
    out.subiuCad = enviados.includes('cad_anestesistas');
    out.filaVazia = cloud._fila().length === 0;

    // 3) segundo sync → migração NÃO roda de novo (envio único de verdade)
    const antes = enviados.length;
    await cloud.sincronizar({ silent: true });
    out.naoRepetiu = enviados.length === antes;

    store.delete('cad_anestesistas', 'an-teste');
    cloud._limparFila();
    return out;
  });
  assert(r.cadsNoMods, 'todos os CAD_MODS deveriam estar em cloud.MODS');
  assert(r.temAssinaturas, 'cad_assinaturas (perfil/carimbo) deveria sincronizar');
  assert(r.enfileirou, 'salvar cadastro offline deveria enfileirar a operação');
  assert(r.flagGravada, 'primeiro sync deveria gravar a flag do envio único');
  assert(r.subiuCad, 'primeiro sync deveria subir os cadastros pré-existentes');
  assert(r.filaVazia, 'após sync online a fila deveria estar vazia');
  assert(r.naoRepetiu, 'segundo sync não deveria reenviar os cadastros (envio único)');
  await page.close();
});

/* 23) Visibilidade dos registros — gestor escolhe 'equipe' × 'proprios' */
await test('Visibilidade: opção do gestor, e no modo próprios o pull converge o aparelho', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    // padrão: sem configuração → 'equipe' (comportamento atual)
    localStorage.removeItem(orgSettings.CACHE_KEY);
    out.padrao = orgSettings.visibilidade();

    // UI: a opção existe e só aparece para o gestor
    out.temBox = !!document.getElementById('visibilidade-registros');
    const origUsuario = auth.usuarioAtual;
    auth.usuarioAtual = () => ({ usuario: 'dr', role: 'anestesiologista' });
    orgSettings.renderVisibilidade();
    out.escondeNaoGestor = document.getElementById('visibilidade-registros').style.display === 'none';
    auth.usuarioAtual = () => ({ usuario: 'chefe', role: 'gestor' });
    orgSettings._gravarCache({ visibilidade_registros: 'proprios' });
    orgSettings.renderVisibilidade();
    const box = document.getElementById('visibilidade-registros');
    out.mostraGestor = box.style.display !== 'none';
    out.radioCerto = !!box.querySelector('input[value=proprios]').checked;

    // convergência no pull: modo 'proprios' + papel anestesiologista →
    // o que veio da nuvem (_relUpdatedAt) e a RLS não devolveu mais é removido
    auth.usuarioAtual = () => ({ usuario: 'dr', role: 'anestesiologista' });
    store.setList('anestesia', [
      { _id: 'meu',       _relUpdatedAt: 't1', paciente: 'A' },
      { _id: 'do_colega', _relUpdatedAt: 't1', paciente: 'B' },
      { _id: 'so_local',  paciente: 'C' }
    ]);
    cloudRel.disponivel = () => true;
    cloudRel.puxarModulo = async () => ([{ _id: 'meu', _relUpdatedAt: 't2', paciente: 'A' }]);
    delete cloudRel._puxados['anestesia'];
    await cloudRel.autoPullModulo('anestesia');
    const ids = store.list('anestesia').map(x => x._id);
    out.manteveMeu = ids.includes('meu');
    out.removeuColega = !ids.includes('do_colega');
    out.manteveLocal = ids.includes('so_local');

    // modo 'equipe' → pull nunca remove nada (comportamento de sempre)
    orgSettings._gravarCache({});
    store.setList('anestesia', [{ _id: 'do_colega', _relUpdatedAt: 't1', paciente: 'B' }]);
    delete cloudRel._puxados['anestesia'];
    await cloudRel.autoPullModulo('anestesia');
    out.equipeNaoRemove = store.list('anestesia').some(x => x._id === 'do_colega');

    auth.usuarioAtual = origUsuario;
    store.setList('anestesia', []);
    return out;
  });
  assert(r.padrao === 'equipe', "sem configuração o padrão deveria ser 'equipe', veio " + r.padrao);
  assert(r.temBox, 'a seção de visibilidade deveria existir em Ajustes → Equipe da nuvem');
  assert(r.escondeNaoGestor, 'a opção deveria ficar oculta para quem não é gestor');
  assert(r.mostraGestor && r.radioCerto, 'para o gestor deveria aparecer com o modo atual marcado');
  assert(r.manteveMeu, 'o registro do próprio anestesista deveria permanecer');
  assert(r.removeuColega, 'o registro do colega (não devolvido pela RLS) deveria sair do aparelho');
  assert(r.manteveLocal, 'registro criado localmente e ainda não espelhado deveria permanecer');
  assert(r.equipeNaoRemove, "no modo 'equipe' o pull não deveria remover nada");
  await page.close();
});

/* 24) Ficha — editar horário fora do intervalo de sala AVISA mas não sobrescreve */
await test('Ficha: horário fora do intervalo de sala é mantido como digitado (avisa, não trava)', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    location.hash = '#anestesia';
    await new Promise(r => setTimeout(r, 400));
    const f = document.getElementById('form-anestesia');
    f.querySelector('[name=hora_sala_entrada]').value = '08:30';
    f.querySelector('[name=hora_sala_saida]').value = '12:00';
    anestesia.graficoUI._contexto = 'anestesia';

    // fora do intervalo (antes da entrada) → valor PERMANECE + aviso aparece
    const inp = document.createElement('input');
    inp.type = 'time'; inp.value = '07:50';
    anestesia.graficoUI.validarHoraInput(inp);
    out.manteve = inp.value === '07:50';
    await new Promise(r => setTimeout(r, 200));
    out.avisou = document.body.textContent.includes('fora do intervalo de sala');
    out.mostraFaixa = document.body.textContent.includes('08:30–12:00');

    // dentro do intervalo → nada muda e nenhum aviso novo
    const inp2 = document.createElement('input');
    inp2.type = 'time'; inp2.value = '09:15';
    anestesia.graficoUI.validarHoraInput(inp2);
    out.dentroOk = inp2.value === '09:15';

    // ao ADICIONAR linha o padrão continua entrando na janela (clampHora)
    out.clampAdd = anestesia.graficoUI.clampHora('07:50') === '08:30';

    f.querySelector('[name=hora_sala_entrada]').value = '';
    f.querySelector('[name=hora_sala_saida]').value = '';
    return out;
  });
  assert(r.manteve, 'o horário digitado fora do intervalo deveria ser MANTIDO (não sobrescrito)');
  assert(r.avisou, 'deveria avisar que o horário está fora do intervalo de sala');
  assert(r.mostraFaixa, 'o aviso deveria mostrar a janela da sala (08:30–12:00)');
  assert(r.dentroOk, 'horário dentro do intervalo não deveria ser alterado');
  assert(r.clampAdd, 'clampHora (linhas novas automáticas) deveria continuar ajustando para a borda');
  await page.close();
});

/* 25) Paciente — nome nunca vira JSON (gravador, pull, reparo e busca) */
await test('Pacientes: objeto serializado não vaza como nome — grava certo, repara o antigo e a busca fica limpa', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    const PAC_JSON = JSON.stringify({ nome: 'Mariana Teste Silva', nascimento: '1996-12-13', idade: '29', sexo: 'Feminino' });

    // helper: reconhece objeto serializado e rejeita o resto
    out.parseOk = (utils.pacienteDeJSON(PAC_JSON) || {}).nome === 'Mariana Teste Silva';
    out.parseNomeNormal = utils.pacienteDeJSON('Maria Andressa') === null;
    out.parseInvalido = utils.pacienteDeJSON('{quebrado') === null && utils.pacienteDeJSON('{}') === null;

    // GRAVADOR (causa raiz): ficha espelhada NÃO manda mais o objeto para a coluna nome
    let capturado = null;
    const origLer = cloudRel._lerAtualTab, origUpsert = migracaoFase4._upsert;
    cloudRel._lerAtualTab = async () => null;
    migracaoFase4._upsert = async (tab, rows) => { capturado = rows[0]; return [{ id: 'p1' }]; };
    cloudRel._cachePac = {};
    await cloudRel._garantirPaciente('org-teste', { paciente: { nome: 'Mariana Teste Silva', nascimento: '1996-12-13' }, convenio: 'Uni' });
    out.gravaNomeTexto = capturado && capturado.nome === 'Mariana Teste Silva';
    cloudRel._lerAtualTab = origLer; migracaoFase4._upsert = origUpsert;

    // PULL: linha antiga com nome-JSON volta saneada
    const item = cloudRel._rowParaItem({ id: 'abc123', nome: PAC_JSON, data: { origem: 'auto' }, updated_at: 't1' });
    out.pullSaneia = item.nome === 'Mariana Teste Silva' && item.sexo === 'Feminino';

    // REPARO no boot: cadastro + SRPA + ficha (paciente string) são consertados
    store.setList('pacientes', [{ _id: 'pj', nome: PAC_JSON }]);
    store.setList('recuperacao', [{ _id: 'rj', nome: PAC_JSON }]);
    store.setList('anestesia', [{ _id: 'aj', paciente: PAC_JSON }]);
    const n = armazenamento.repararNomesJSON();
    out.reparou3 = n === 3;
    out.cadastroOk = store.list('pacientes')[0].nome === 'Mariana Teste Silva';
    out.srpaOk = store.list('recuperacao')[0].nome === 'Mariana Teste Silva';
    out.fichaObjOk = (store.list('anestesia')[0].paciente || {}).nome === 'Mariana Teste Silva';

    // BUSCA: mesmo se um dado ruim sobrar, o autocomplete repara/descarta
    store.setList('pre', [{ _id: 'pj2', nome: PAC_JSON }]);
    const nomes = pacienteAutocomplete._coletarNomes().map(x => x.nome);
    out.buscaLimpa = nomes.includes('Mariana Teste Silva') && !nomes.some(x => x.charAt(0) === '{');

    store.setList('pacientes', []); store.setList('recuperacao', []);
    store.setList('anestesia', []); store.setList('pre', []);
    return out;
  });
  assert(r.parseOk, 'pacienteDeJSON deveria extrair o objeto do JSON');
  assert(r.parseNomeNormal && r.parseInvalido, 'nome normal e JSON inválido não deveriam ser tratados como objeto');
  assert(r.gravaNomeTexto, 'a ficha espelhada deveria gravar o NOME (texto) na coluna nome, não o objeto');
  assert(r.pullSaneia, 'o pull deveria sanear linha antiga com nome-JSON (e aproveitar sexo/nascimento)');
  assert(r.reparou3, 'o reparo do boot deveria consertar os 3 registros, consertou ' + r.reparou3);
  assert(r.cadastroOk && r.srpaOk && r.fichaObjOk, 'cadastro, SRPA e ficha deveriam ficar com o nome/objeto certos');
  assert(r.buscaLimpa, 'a busca nunca deveria exibir JSON como nome de paciente');
  await page.close();
});

/* 26) Assinatura — carimbo do "Meu perfil" é achado pelo nome (parcial, sem acento) */
await test('Carimbo: busca acha o perfil profissional por nome exato, parcial e sem acento', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    const PNG = 'data:image/png;base64,iVBORw0KGgo=';
    store.setList('cad_assinaturas', [{ _id: 'perfil1', nomeProfissional: 'Marcelo Pândolfi Caliman', crm: '12345', carimbo: PNG }]);
    store.setList('cad_anestesistas', []);
    store.setList('cad_cirurgioes', []);

    // ANTES o perfil (cad_assinaturas) nem era pesquisado — agora é a 1ª fonte
    const exato = utils.getCarimboDoProfissional('Marcelo Pândolfi Caliman');
    out.achouPerfil = !!(exato && exato.carimbo === PNG && exato.crm === '12345');
    // sem acento e caixa diferente
    out.semAcento = !!(utils.getCarimboDoProfissional('marcelo pandolfi caliman') || {}).carimbo;
    // parcial: só o primeiro nome, único candidato → acha
    out.parcial = !!(utils.getCarimboDoProfissional('Marcelo') || {}).carimbo;
    // por _id
    out.porId = !!(utils.getCarimboDoProfissional('perfil1') || {}).carimbo;

    // ambiguidade: outro "Marcelo" no cadastro → parcial deixa de valer…
    store.setList('cad_anestesistas', [{ _id: 'an1', nome: 'Marcelo Silva' }]);
    out.ambiguoNull = utils.getCarimboDoProfissional('Marcelo') === null;
    // …mas o nome completo continua achando o certo (e prefere quem tem carimbo)
    out.exatoComAmbiguo = !!(utils.getCarimboDoProfissional('Marcelo Pandolfi Caliman') || {}).carimbo;

    store.setList('cad_assinaturas', []); store.setList('cad_anestesistas', []);
    return out;
  });
  assert(r.achouPerfil, 'o carimbo do Meu perfil profissional deveria ser achado pelo nome');
  assert(r.semAcento, 'a busca deveria ignorar acentos e caixa');
  assert(r.parcial, 'nome parcial único (ex.: primeiro nome) deveria achar o profissional');
  assert(r.porId, 'busca por _id deveria continuar funcionando');
  assert(r.ambiguoNull, 'nome parcial ambíguo não deveria escolher sozinho');
  assert(r.exatoComAmbiguo, 'nome completo deveria achar mesmo com homônimo parcial');
  await page.close();
});

/* 27) Arquivamento — antigos sincronizados saem do aparelho e voltam sob demanda */
await test('Arquivamento: antigos+sincronizados saem, prazos por módulo, pull não traz de volta, restaurar funciona', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    localStorage.removeItem(arquivo.INDEX_KEY);
    const D = n => new Date(Date.now() - n * 86400000).toISOString();
    store.setList('anestesia', [
      { _id: 'velho_sync',  _relUpdatedAt: 't', _updatedAt: D(120), paciente: { nome: 'Antigo Sincronizado' } },
      { _id: 'velho_local',                     _updatedAt: D(120), paciente: { nome: 'Antigo Só Local' } },
      { _id: 'recente',     _relUpdatedAt: 't', _updatedAt: D(10),  paciente: { nome: 'Recente' } }
    ]);
    store.setList('financeiro', [
      { _id: 'fin_meio_ano', _relUpdatedAt: 't', _updatedAt: D(200), paciente: 'Fin Meio Ano' },
      { _id: 'fin_2anos',    _relUpdatedAt: 't', _updatedAt: D(400), paciente: 'Fin Dois Anos' }
    ]);
    out.arquivou = arquivo.arquivarAntigos();      // velho_sync + fin_2anos = 2
    const idsA = store.list('anestesia').map(x => x._id);
    out.soSaiuOCerto = !idsA.includes('velho_sync') && idsA.includes('velho_local') && idsA.includes('recente');
    out.finRespeitaPrazo = store.list('financeiro').map(x => x._id).join(',') === 'fin_meio_ano';
    out.indexado = arquivo.estaArquivado('anestesia', 'velho_sync') && arquivo.total() === 2;

    // pull relacional NÃO traz o arquivado de volta
    cloudRel.disponivel = () => true;
    cloudRel.puxarModulo = async () => ([{ _id: 'velho_sync', _relUpdatedAt: 't2', paciente: { nome: 'Antigo Sincronizado' } }]);
    delete cloudRel._puxados['anestesia'];
    await cloudRel.autoPullModulo('anestesia');
    out.pullNaoVolta = !store.list('anestesia').some(x => x._id === 'velho_sync');

    // restaurar (nuvem mockada) → volta ao aparelho e sai do índice
    cloud._garantirToken = async () => true;
    cloudRel._orgAsync = async () => 'org1';
    cloudRel._lerAtualTab = async () => ({ id: 'u1', legacy_id: 'velho_sync',
      data: { _id: 'velho_sync', paciente: { nome: 'Antigo Sincronizado' } }, updated_at: 't3' });
    const ok = await arquivo.restaurar('anestesia', 'velho_sync');
    out.restaurou = ok && store.list('anestesia').some(x => x._id === 'velho_sync')
      && !arquivo.estaArquivado('anestesia', 'velho_sync');

    store.setList('anestesia', []); store.setList('financeiro', []);
    localStorage.removeItem(arquivo.INDEX_KEY);
    return out;
  });
  assert(r.arquivou === 2, 'deveriam sair exatamente 2 registros (ficha 120d + financeiro 400d), saiu ' + r.arquivou);
  assert(r.soSaiuOCerto, 'rascunho só-local e registro recente deveriam FICAR no aparelho');
  assert(r.finRespeitaPrazo, 'financeiro com 200 dias deveria ficar (prazo do financeiro é 1 ano)');
  assert(r.indexado, 'os arquivados deveriam entrar no índice');
  assert(r.pullNaoVolta, 'o pull não deveria trazer de volta um registro arquivado');
  assert(r.restaurou, 'restaurar deveria trazer o registro da nuvem e tirá-lo do índice');
  await page.close();
});

/* 28) Eventos — laparoscopia: pneumoperitônio + crises com conduta passo a passo */
await test('Eventos: pneumoperitônio (início/fim) e crises da laparoscopia com conduta técnica', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    const T = anestesia.eventos.TIPOS;
    out.temInicio = T.includes('Início do pneumoperitônio');
    out.temFim = T.includes('Fim do pneumoperitônio');
    out.temCrises = T.includes('Embolia gasosa (CO₂)') && T.includes('Enfisema subcutâneo') && T.includes('Pneumotórax');
    const D = anestesia.eventos.DESCRICOES;
    out.descInsuflacao = /12–15 mmHg/.test(D['Início do pneumoperitônio'] || '');
    out.condutaEmbolia = /Durant/.test(D['Embolia gasosa (CO₂)'] || '') && /INTERROMPER/.test(D['Embolia gasosa (CO₂)'] || '');
    out.condutaPntx = /descompress/i.test(D['Pneumotórax'] || '');
    // o select de evento da ficha é gerado de TIPOS → novo evento aparece
    location.hash = '#anestesia';
    await new Promise(r => setTimeout(r, 400));
    anestesia.eventos.add();
    const sel = document.querySelector('#eventos-body [name="evt_tipo[]"]');
    out.noSelect = !!sel && sel.innerHTML.includes('Início do pneumoperitônio');
    // e o checklist de intercorrências (seção 11) também tem as crises
    out.noChecklist = !!document.querySelector('#form-anestesia [name="intercorrencias[]"][value="Embolia gasosa (CO₂)"]');
    return out;
  });
  assert(r.temInicio && r.temFim, 'TIPOS deveria ter início e fim do pneumoperitônio');
  assert(r.temCrises, 'TIPOS deveria ter embolia gasosa, enfisema subcutâneo e pneumotórax');
  assert(r.descInsuflacao, 'descrição da insuflação deveria citar a pressão alvo (12–15 mmHg)');
  assert(r.condutaEmbolia, 'conduta da embolia gasosa deveria incluir interromper insuflação e posição de Durant');
  assert(r.condutaPntx, 'conduta do pneumotórax deveria incluir descompressão');
  assert(r.noSelect, 'o select de eventos da ficha deveria listar o pneumoperitônio');
  assert(r.noChecklist, 'o checklist de intercorrências deveria ter as crises da laparoscopia');
  await page.close();
});

/* 29) Finalizar ficha → SRPA automática (só entrada/saída) + impressão conjunta */
await test('SRPA automática: gera finalizada e vinculada a partir da ficha; impressão sai num arquivo único', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    store.setList('anestesia', []); store.setList('recuperacao', []);
    location.hash = '#anestesia';
    await new Promise(r => setTimeout(r, 400));
    const f = document.getElementById('form-anestesia');
    const set = (n, v) => { const el = f.querySelector('[name="' + n + '"]'); if (el) el.value = v; };
    set('paciente_nome', 'Paciente Conjunto'); set('data_anestesia', '2026-07-25');
    set('procedimento', 'Colecistectomia videolaparoscópica');
    set('hora_sala_saida', '12:00'); set('anestesiologista', 'Dr. Fluxo');
    anestesia.vitais.add(false, { hora: '11:50', pas: '120', pad: '80', fc: '72', spo2: '98' });

    // finalizar → o modal oferece a SRPA automática (agora em TODA finalização sem SRPA)
    anestesia.salvar({ finalizar: true });
    await new Promise(r => setTimeout(r, 600));
    out.modalOferece = document.body.textContent.includes('SRPA automática s/ intercorrências');
    /* ao finalizar o rascunho fecha e o form é limpo — o id vive no registro */
    const fichaId = store.list('anestesia')[0]._id;
    modal.close();

    // abre o mini-modal (entrada pré-preenchida com a saída de sala) e gera
    anestesia._srpaAutomatica(fichaId);
    await new Promise(r => setTimeout(r, 100));
    out.entradaPrefill = (document.getElementById('srpa-auto-entrada') || {}).value === '12:00';
    document.getElementById('srpa-auto-alta').value = '13:00';
    document.getElementById('srpa-auto-imprimir').checked = false;   // imprime manualmente depois
    anestesia._gerarSrpaAutomatica(fichaId);
    await new Promise(r => setTimeout(r, 1300));

    const srpa = store.list('recuperacao')[0];
    out.srpaFinalizada = !!(srpa && srpa._finalizado);
    out.dadosCertos = !!(srpa && srpa.nome === 'Paciente Conjunto' && srpa.entrada === '12:00' && srpa.alta === '13:00'
      && srpa.procedencia === 'Centro cirúrgico' && String(srpa.aldk_total).startsWith('10'));
    out.textoPadrao = !!(srpa && /sem intercorrências/i.test(srpa.observacoes || ''));
    /* vitais padrão-normal preenchendo a JANELA inteira (12:00→13:00, 15/15min) */
    const vit = (srpa && srpa.grafico && srpa.grafico.vitais) || [];
    out.vitaisJanela = vit.length >= 4 && vit[0].hora === '12:00' && vit[vit.length - 1].hora === '13:00'
      && vit.every(v => v.pas && v.fc && v.spo2);
    const ficha = store.getById('anestesia', fichaId);
    out.vinculada = !!(ficha && ficha._links && ficha._links.recuperacao_id === srpa._id
      && srpa._links && srpa._links.anestesia_id === fichaId);

    // impressão conjunta: um único arquivo com as DUAS fichas e quebra de página.
    // Reproduz o cenário real do bug: ao finalizar, os formulários são LIMPOS
    // (fechamento do rascunho) — o fluxo recarrega os DOIS registros salvos.
    utils.clearForm('form-recuperacao');
    document.getElementById('srpa-vitais-body').innerHTML = '';
    anestesia.carregar(store.getById('anestesia', fichaId));
    recuperacao.carregar(store.getById('recuperacao', srpa._id));
    printPreview.abrirConjunto();
    await new Promise(r => setTimeout(r, 200));
    const pppEl = document.getElementById('ppp');
    const ppp = pppEl.innerHTML;
    out.conjuntoTemAmbas = ppp.includes('pp-quebra') &&
      (ppp.match(/Paciente Conjunto/g) || []).length >= 2;
    /* capítulos: a SRPA vem DEPOIS da ficha completa, com capa de capítulo */
    out.capituloSrpa = ppp.includes('pp-capitulo') && ppp.includes('2ª parte — Recuperação pós-anestésica');
    out.fichaAntesDaSrpa = ppp.indexOf('pp-capitulo') > ppp.indexOf('RELATÓRIO') || ppp.indexOf('pp-capitulo') > 100;
    /* no PDF gerado (nuvem/backup), a quebra vira página nova de verdade */
    const J = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
    const docPdf = printPreview._gerarDocDeTexto(J, pppEl);
    const nPag = docPdf.getNumberOfPages ? docPdf.getNumberOfPages() : docPdf.internal.getNumberOfPages();
    out.pdfDuasPaginas = nPag >= 2;
    /* Convenção: Paciente primeiro, depois o tipo, e a data é SEMPRE a de criação (hoje) */
    const hoje = new Date();
    const hojeStr = String(hoje.getDate()).padStart(2, '0') + String(hoje.getMonth() + 1).padStart(2, '0') + hoje.getFullYear();
    const nomeGerado = printPreview._gerarNomeArquivo();
    out.nomeArquivo = nomeGerado.startsWith('Paciente-Conjunto')
      && nomeGerado.includes('Ficha-Anestesia+SRPA')
      && nomeGerado.indexOf('Paciente-Conjunto') < nomeGerado.indexOf('Ficha-Anestesia+SRPA')
      && nomeGerado.endsWith(hojeStr);
    /* REGRESSÃO (bug do contexto): recarregar a ficha NÃO pode despejar os
       vitais/meds dela nas tabelas da SRPA nem apagar os vitais da SRPA */
    out.fichaNaFicha = document.querySelectorAll('#vitais-body tr').length === 1;
    out.srpaSoDela = document.querySelectorAll('#srpa-vitais-body tr').length === vit.length
      && document.querySelectorAll('#srpa-medicacoes-body tr').length === 0;
    /* o capítulo da SRPA no arquivo único tem CONTEÚDO (vitais da janela) */
    const posCapitulo = ppp.indexOf('pp-capitulo');
    out.srpaComDados = posCapitulo > -1 && ppp.slice(posCapitulo).includes('12:15');
    printPreview.fechar();

    // botão 🧪 da SRPA: preenche padrão numa SRPA vazia (entrada→alta)
    recuperacao.novo();
    const fr = document.getElementById('form-recuperacao');
    fr.querySelector('[name=nome]').value = 'Paciente Botao';
    fr.querySelector('[name=entrada]').value = '14:00';
    fr.querySelector('[name=alta]').value = '14:30';
    const criadas = recuperacao.gerarPadraoNormal({});
    out.botaoPadrao = criadas >= 2
      && document.querySelectorAll('#srpa-vitais-body tr').length >= 3
      && /10/.test(fr.querySelector('[name=aldk_total]').value || '')
      && /sem intercorrências/i.test(fr.querySelector('[name=observacoes]').value || '');

    // botão "+ SRPA" na ficha reabre o conjunto (SRPA vinculada é carregada)
    location.hash = '#anestesia';
    await new Promise(r => setTimeout(r, 300));
    anestesia.carregar(store.getById('anestesia', fichaId));   /* reabre a ficha */
    anestesia.imprimirComSrpa();
    await new Promise(r => setTimeout(r, 500));
    out.botaoConjunto = document.getElementById('print-preview-overlay').classList.contains('show');
    printPreview.fechar();

    store.setList('anestesia', []); store.setList('recuperacao', []);
    return out;
  });
  assert(r.modalOferece, 'ao finalizar deveria oferecer a SRPA automática');
  assert(r.entradaPrefill, 'entrada da SRPA deveria vir pré-preenchida com a saída de sala');
  assert(r.srpaFinalizada, 'a SRPA automática deveria nascer FINALIZADA');
  assert(r.dadosCertos, 'nome/horários/procedência/Aldrete 10 deveriam estar preenchidos');
  assert(r.textoPadrao, 'observações deveriam ter o texto padrão sem intercorrências');
  assert(r.vitaisJanela, 'os vitais padrão-normal deveriam cobrir a janela inteira (entrada→alta, 15/15min)');
  assert(r.fichaNaFicha, 'os vitais da FICHA deveriam estar na tabela da ficha (bug de contexto)');
  assert(r.srpaSoDela, 'a SRPA deveria manter SÓ os vitais dela, sem meds/vitais da ficha');
  assert(r.srpaComDados, 'o capítulo da SRPA no arquivo único deveria ter os vitais da janela (não sair vazio)');
  assert(r.botaoPadrao, 'o botão 🧪 da SRPA deveria gerar vitais normais + Aldrete 10/10 + sem intercorrências');
  assert(r.vinculada, 'ficha e SRPA deveriam ficar vinculadas nos dois sentidos');
  assert(r.conjuntoTemAmbas, 'o arquivo único deveria conter as duas fichas com quebra de página');
  assert(r.capituloSrpa, 'a SRPA deveria abrir como capítulo ("2ª parte — Recuperação pós-anestésica")');
  assert(r.pdfDuasPaginas, 'no PDF gerado, a SRPA deveria começar em página nova (>= 2 páginas)');
  assert(r.nomeArquivo, 'o nome do arquivo deveria ser Paciente_Ficha-Anestesia+SRPA_data-de-criação (hoje)');
  assert(r.botaoConjunto, 'o botão "+ SRPA" da ficha deveria abrir a impressão conjunta');
  await page.close();
});

/* 30) Login 1× por dia (aparelho individual) — senha só na primeira entrada do dia */
await test('Login diário: sessão do dia sobrevive ao fechar, expira ao virar o dia e Bloquear agora derruba', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    const sessDemo = auth.usuarioAtual();
    const origAtivo = demo.ativo; demo.ativo = () => false;   /* sai da exceção do demo */

    // a opção existe no seletor de bloqueio
    out.temOpcao = !!document.querySelector('#seg-timeout option[value="-1"]');

    // modo diário: sem timer de inatividade + login grava a sessão do dia
    localStorage.setItem(auth.TIMEOUT_KEY, '-1');
    out.modo = auth._modoDiario() === true && auth._timeoutMs() === 0;
    auth._definirSessao({ id: 'u1', usuario: 'dr', nome: 'Dr', perfil: 'admin', modulos: [] });
    const d = JSON.parse(localStorage.getItem(auth.DIA_KEY) || 'null');
    out.gravouDia = !!(d && d.dia === utils.hojeISO() && d.sess.usuario === 'dr');

    // "fechar o app" (sessionStorage some) → reabre sem senha no mesmo dia
    sessionStorage.removeItem(auth.SESSION_KEY);
    out.restaurou = auth._restaurarSessaoDiaria() === true && auth.estaLogado();

    // virou o dia → sessão expira e o carimbo é apagado
    sessionStorage.removeItem(auth.SESSION_KEY);
    localStorage.setItem(auth.DIA_KEY, JSON.stringify({ dia: '2000-01-01', sess: d.sess }));
    out.expirou = auth._restaurarSessaoDiaria() === false && !auth.estaLogado()
      && !localStorage.getItem(auth.DIA_KEY);

    // Bloquear agora / sair derruba a sessão do dia (pede senha de novo)
    auth._definirSessao({ id: 'u1', usuario: 'dr', nome: 'Dr', perfil: 'admin', modulos: [] });
    out.regravou = !!localStorage.getItem(auth.DIA_KEY);
    auth.logout();
    out.logoutLimpa = !localStorage.getItem(auth.DIA_KEY) && !auth.estaLogado();

    // no modo normal (5 min) o login NÃO persiste sessão diária
    localStorage.setItem(auth.TIMEOUT_KEY, '5');
    auth._definirSessao({ id: 'u1', usuario: 'dr', nome: 'Dr', perfil: 'admin', modulos: [] });
    out.normalNaoGrava = !localStorage.getItem(auth.DIA_KEY);

    /* restaura o ambiente do teste */
    demo.ativo = origAtivo;
    if (sessDemo) sessionStorage.setItem(auth.SESSION_KEY, JSON.stringify(sessDemo));
    auth._desbloquear();
    return out;
  });
  assert(r.temOpcao, 'o seletor de bloqueio deveria ter a opção "1× por dia"');
  assert(r.modo, 'modo diário deveria desligar o timer de inatividade');
  assert(r.gravouDia, 'o login no modo diário deveria carimbar a sessão do dia');
  assert(r.restaurou, 'reabrir no mesmo dia deveria entrar SEM pedir senha');
  assert(r.expirou, 'ao virar o dia a sessão deveria expirar e o carimbo sumir');
  assert(r.regravou && r.logoutLimpa, 'Bloquear agora/sair deveria derrubar a sessão do dia');
  assert(r.normalNaoGrava, 'nos modos por minutos nada deveria ser persistido');
  await page.close();
});

/* 31) Padrão endoscopia/colonoscopia + ritmo Sinusal no preenchimento padrão */
await test('Endo/colono: medicações padrão com O₂ e SF, sem capnografia; padrão de vitais gera ritmo Sinusal', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    const MEDS = ['Propofol', 'Midazolam', 'Fentanil', 'Lidocaína', 'Escopolamina (hioscina)',
                  'Escetamina', 'Oxigênio (cateter nasal)', 'Soro fisiológico 0,9%'];
    const eda = PROCEDIMENTOS_PADRAO.eda, col = PROCEDIMENTOS_PADRAO.colonoscopia;
    out.medsCertas = MEDS.every(n => eda.medicacoes.some(m => m.nome === n) && col.medicacoes.some(m => m.nome === n));
    out.semCapno = !eda.monitores.includes('Capnografia') && !col.monitores.includes('Capnografia')
      && !/EtCO/.test(eda.monitorizacao) && !/EtCO/.test(col.monitorizacao);

    // aplicar o padrão numa ficha limpa
    location.hash = '#anestesia';
    await new Promise(r => setTimeout(r, 400));
    modelos.aplicarProcedimento('eda');
    await new Promise(r => setTimeout(r, 200));
    out.medsNaTabela = document.querySelectorAll('#medicacoes-body tr').length >= 8;
    out.capnoDesmarcada = !document.querySelector('#form-anestesia [name="monitores[]"][value="Capnografia"]').checked;
    out.ecgMarcado = document.querySelector('#form-anestesia [name="monitores[]"][value="ECG"]').checked;

    // preencher padrão de vitais → toda linha gerada tem ritmo SINUSAL e sem EtCO₂
    const f = document.getElementById('form-anestesia');
    f.querySelector('[name=hora_sala_entrada]').value = '08:00';
    f.querySelector('[name=hora_sala_saida]').value = '08:30';
    anestesia.graficoUI._contexto = 'anestesia';
    anestesia.vitais._gerarPadrao(10);
    await new Promise(r => setTimeout(r, 300));
    const linhas = Array.from(document.querySelectorAll('#vitais-body tr'));
    out.gerou = linhas.length >= 3;
    out.ritmoSinusal = linhas.every(tr => (tr.querySelector('[name="vit_ritmo[]"]') || {}).value === 'Sinusal');
    out.semEtco2 = linhas.every(tr => !((tr.querySelector('[name="vit_etco2[]"]') || {}).value || '').trim());

    return out;
  });
  assert(r.medsCertas, 'endo e colono deveriam ter as 8 medicações padrão (incl. O₂ e SF)');
  assert(r.semCapno, 'capnografia não deveria estar nos monitores/monitorização de endo/colono');
  assert(r.medsNaTabela, 'aplicar o padrão deveria lançar as medicações na tabela');
  assert(r.capnoDesmarcada && r.ecgMarcado, 'ECG marcado e capnografia desmarcada após aplicar o padrão');
  assert(r.gerou, 'o preenchimento padrão deveria gerar as linhas de vitais');
  assert(r.ritmoSinusal, 'todas as linhas geradas deveriam ter ritmo Sinusal');
  assert(r.semEtco2, 'nenhuma linha gerada deveria ter EtCO₂ (capnografia fora do padrão)');
  await page.close();
});

/* 32) Financeiro — lançamento rápido avulso (caso sem consulta/ficha no sistema) */
await test('Financeiro: lançamento rápido cria registro pendente sem precisar de ficha', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    store.setList('financeiro', []);
    location.hash = '#financeiro';
    await new Promise(r => setTimeout(r, 400));

    // botão na barra do módulo
    out.temBotao = document.querySelector('#module-financeiro .action-bar').textContent.includes('Lançamento rápido');

    // modal com os campos essenciais (procedimentos agora são linhas múltiplas)
    financeiro.lancamentoRapido();
    await new Promise(r => setTimeout(r, 100));
    out.camposOk = ['fin-rap-paciente', 'fin-rap-data', 'fin-rap-conv', 'fin-rap-valor', 'fin-rap-senha']
      .every(id => !!document.getElementById(id)) && !!document.querySelector('#fin-rap-procs .fin-rap-proc');
    out.dataHoje = document.getElementById('fin-rap-data').value === utils.hojeISO();

    // preencher (2 procedimentos: 1º 100%, 2º com grau 50%) e lançar
    document.getElementById('fin-rap-paciente').value = 'Paciente Avulso';
    document.querySelector('#fin-rap-procs .fin-rap-proc').value = 'Colonoscopia';
    financeiro._rapAddProc();
    const linhas2 = document.querySelectorAll('#fin-rap-procs > div');
    linhas2[1].querySelector('.fin-rap-proc').value = 'Endoscopia digestiva alta';
    linhas2[1].querySelector('.fin-rap-grau').value = '50';
    document.getElementById('fin-rap-conv').value = 'Unimed';
    document.getElementById('fin-rap-valor').value = '800';
    document.getElementById('fin-rap-senha').value = 'AUT123';
    financeiro._salvarRapido();
    await new Promise(r => setTimeout(r, 200));

    const reg = store.list('financeiro')[0];
    out.criou = !!(reg && reg.paciente === 'Paciente Avulso' && reg.status === 'pendente'
      && reg._origemTipo === 'avulso' && /Colonoscopia/i.test(reg.procedimento)
      && reg.valor_previsto === '800' && reg.senha === 'AUT123' && reg.senha_data === utils.hojeISO());
    /* a hierarquia automática escolhe o 100% pelo MAIOR PORTE — o que importa
       é sair exatamente um código 100% e um 50% */
    out.codigosComGrau = !!(reg && Array.isArray(reg.codigos) && reg.codigos.length === 2
      && reg.codigos.filter(c => c.grau === 100).length === 1
      && reg.codigos.filter(c => c.grau === 50).length === 1);
    out.fechouModal = !document.getElementById('modal-backdrop').classList.contains('show');

    // sem paciente → não lança (avisa)
    financeiro.lancamentoRapido();
    await new Promise(r => setTimeout(r, 100));
    document.getElementById('fin-rap-paciente').value = '';
    financeiro._salvarRapido();
    out.validaPaciente = store.list('financeiro').length === 1;
    modal.close();

    store.setList('financeiro', []);
    return out;
  });
  assert(r.temBotao, 'a barra do Financeiro deveria ter o botão Lançamento rápido');
  assert(r.camposOk, 'o modal deveria ter paciente, data, procedimento, convênio, valor e senha');
  assert(r.dataHoje, 'a data deveria vir pré-preenchida com hoje');
  assert(r.criou, 'o lançamento deveria criar registro pendente/avulso com os dados informados');
  assert(r.codigosComGrau, 'os 2 procedimentos deveriam virar códigos com grau 100% e 50%');
  assert(r.fechouModal, 'lançar deveria fechar o modal');
  assert(r.validaPaciente, 'sem paciente não deveria lançar');
  await page.close();
});

/* 33) Grau 100/70/50% por código — ficha, financeiro e importação */
await test('Grau: cirurgias da ficha têm grau, previsto = unit × qtd × grau, e a importação traz as combinadas', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    store.setList('anestesia', []); store.setList('financeiro', []);

    // FICHA: cirurgia combinada com grau (padrão 70%, editável para 50/100)
    location.hash = '#anestesia';
    await new Promise(r => setTimeout(r, 400));
    document.getElementById('cir-combo-body').innerHTML = '';
    anestesia.cirurgias.add({ procedimento: 'Endoscopia digestiva alta', grau: '70' });
    anestesia.cirurgias.add({ procedimento: 'Outro procedimento' });      // sem grau → 50 (mesma via)
    const cirs = anestesia.cirurgias.coletar();
    out.grauFicha = cirs[0].grau === '70' && cirs[1].grau === '50';
    // bloco reposicionado: comunica "vários códigos do mesmo ato" e botão claro
    out.blocoCodigos = document.body.innerHTML.includes('Procedimentos / códigos adicionais')
      && document.getElementById('cir-combo-wrap').innerHTML.includes('Adicionar procedimento');

    // FINANCEIRO: previsto respeita o grau (1000 × 1 × 70% = 700)
    location.hash = '#financeiro';
    await new Promise(r => setTimeout(r, 300));
    financeiro.editar(null);
    const tr = financeiro.codigos.add({ descricao: 'Proc teste', grau: '70' });
    tr.querySelector('[name="fin_cod_unit[]"]').value = '1000';
    financeiro.codigos._onQtdUnit(tr.querySelector('[name="fin_cod_unit[]"]'));
    out.previstoComGrau = tr.querySelector('[name="fin_cod_previsto[]"]').value === '700.00';
    // previsto digitado → deduz o unitário considerando o grau (350 ÷ 1 ÷ 70% = 500)
    tr.querySelector('[name="fin_cod_previsto[]"]').value = '350';
    financeiro.codigos._onPrevisto(tr.querySelector('[name="fin_cod_previsto[]"]'));
    out.unitComGrau = tr.querySelector('[name="fin_cod_unit[]"]').value === '500.00';
    out.coletaGrau = financeiro.codigos.coletar()[0].grau === 70;

    // CLASSIFICAR: maior porte vira 100%, demais 50%; linha 70% é preservada
    document.getElementById('fin-codigos-body').innerHTML = '';
    financeiro.codigos.add({ descricao: 'Menor', porte: '3C', grau: '100' });
    financeiro.codigos.add({ descricao: 'Maior', porte: '10A', grau: '50' });
    financeiro.codigos.add({ descricao: 'Via diferente', porte: '2B', grau: '70' });
    financeiro.codigos.classificarGrau({ silent: true });
    const g = financeiro.codigos.coletar().map(c => c.grau);
    out.classificou = g[0] === 50 && g[1] === 100 && g[2] === 70;

    // IMPORTAÇÃO da ficha: principal 100% + combinada com o grau dela
    // (antes as combinadas nem eram importadas — a ficha salva c.procedimento)
    store.setList('anestesia', [{
      _id: 'fx', paciente: { nome: 'Grau Teste' },
      procedimento: { descricao: 'Colonoscopia', data: '2026-07-25',
        cirurgias_extra: [{ procedimento: 'Endoscopia digestiva alta', grau: '50' }] }
    }]);
    financeiro.editar(null);
    document.querySelector('#form-financeiro [name="paciente"]').value = 'Grau Teste';
    linker.importarAnestesiaParaFinanceiro('Grau Teste', { force: true, silent: true });
    await new Promise(r => setTimeout(r, 200));
    const rows = Array.from(document.querySelectorAll('#fin-codigos-body tr'));
    out.importou2 = rows.length === 2;
    const graus = rows.map(x => x.querySelector('[name="fin_cod_grau[]"]').value);
    out.grausImportados = graus[0] === '100' && graus[1] === '50';

    financeiro.cancelar();
    document.getElementById('cir-combo-body').innerHTML = '';
    store.setList('anestesia', []); store.setList('financeiro', []);
    return out;
  });
  assert(r.grauFicha, 'as cirurgias combinadas da ficha deveriam guardar o grau (padrão 50% = mesma via)');
  assert(r.blocoCodigos, 'o bloco de múltiplos códigos deveria estar rotulado e com botão claro');
  assert(r.previstoComGrau, 'previsto deveria ser unit × qtd × grau (1000 × 70% = 700)');
  assert(r.unitComGrau, 'previsto digitado deveria deduzir o unitário considerando o grau');
  assert(r.coletaGrau, 'o grau deveria ser salvo com o código');
  assert(r.classificou, 'classificar: maior porte → 100%, demais → 50%, e o 70% manual preservado');
  assert(r.importou2, 'a importação deveria trazer principal + combinada (bug do c.descricao corrigido)');
  assert(r.grausImportados, 'principal deveria entrar 100% e a combinada com o grau da ficha (50%)');
  await page.close();
});

/* 34) Backup automático ao FINALIZAR — PDF vai para a nuvem (Drive/Supabase) sozinho */
await test('Finalizar salva PDF na nuvem automaticamente (com destino configurado; desligável)', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    store.setList('pre', []);
    // opção existe em Ajustes e vem LIGADA por padrão
    out.temCheckbox = !!document.getElementById('pdfbk-auto-finalizar');
    out.padraoLigado = pdfBackup.cfg().autoFinalizar !== false;

    // destino mockado (Drive configurado) + captura do envio
    const enviados = [];
    pdfBackup.cfg = () => ({ drive: true, driveClientId: 'cid-teste', autoFinalizar: true });
    pdfBackup.enviarTodos = async (doc, nomeArq) => { enviados.push({ nomeArq, temDoc: !!doc && typeof doc.output === 'function' }); };

    // finalizar uma pré → PDF gerado e enviado sem nenhum toque extra
    location.hash = '#pre';
    await new Promise(r => setTimeout(r, 400));
    const f = document.getElementById('form-pre');
    f.querySelector('[name=nome]').value = 'Paciente Drive';
    const dEl = f.querySelector('[name=data]'); if (dEl) dEl.value = utils.hojeISO();
    pre.salvar({ finalizar: true });
    await new Promise(r => setTimeout(r, 500));
    out.enviou = enviados.length === 1;
    /* Convenção: começa pelo PACIENTE, depois o tipo, e termina na data de CRIAÇÃO (hoje) */
    const hj = new Date();
    const hjStr = String(hj.getDate()).padStart(2, '0') + String(hj.getMonth() + 1).padStart(2, '0') + hj.getFullYear();
    out.nomePdf = enviados.length === 1 && /^Paciente.Drive_APA_/i.test(enviados[0].nomeArq) && enviados[0].nomeArq.endsWith(hjStr + '.pdf');
    out.docReal = enviados.length === 1 && enviados[0].temDoc;

    // desligado → não envia
    pdfBackup.cfg = () => ({ drive: true, driveClientId: 'cid-teste', autoFinalizar: false });
    pre.novo();
    f.querySelector('[name=nome]').value = 'Paciente Sem Backup';
    if (dEl) dEl.value = utils.hojeISO();
    pre.salvar({ finalizar: true });
    await new Promise(r => setTimeout(r, 300));
    out.desligadoNaoEnvia = enviados.length === 1;

    store.setList('pre', []);
    return out;
  });
  assert(r.temCheckbox && r.padraoLigado, 'a opção deveria existir em Ajustes e vir ligada por padrão');
  assert(r.enviou, 'finalizar deveria enviar exatamente 1 PDF para a nuvem');
  assert(r.nomePdf, 'o .pdf deveria começar pelo paciente, depois o tipo, e terminar na data de criação (hoje)');
  assert(r.docReal, 'o documento enviado deveria ser um PDF de verdade (jsPDF)');
  assert(r.desligadoNaoEnvia, 'com a opção desligada, nada deveria ser enviado');
  await page.close();
});

/* 35) Importação do Drive ano a ano — pastas navegáveis + convenção nova de nomes */
await test('Drive: importador navega pastas (ano a ano) e entende os nomes novos e antigos', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    const it = n => driveImport._interpretar(n);

    /* Convenção NOVA (Paciente_Tipo_Data) */
    let a = it('Eduarda-Carvalho-Araujo_Ficha-Anestesia_24072026.pdf');
    out.novaFicha = a.nome === 'Eduarda Carvalho Araujo' && a.dataISO === '2026-07-24' && !a.ehAPA;
    a = it('Benildes-Pandolfi-Caliman_APA_06072026.pdf');
    out.novaApa = a.nome === 'Benildes Pandolfi Caliman' && a.dataISO === '2026-07-06' && a.ehAPA;
    a = it('MAILLY-DE-OLIVEIRA-SILVA - Ficha-Anestesia+SRPA - 29072026.pdf');
    out.novaConjunto = a.nome === 'MAILLY DE OLIVEIRA SILVA' && a.dataISO === '2026-07-29' && !a.ehAPA && /SRPA/i.test(a.tipo);
    a = it('JOAO PEDRO ESCARLATE PIANCA guia internacao 26072026.pdf');
    out.novaGuia = a.nome === 'JOAO PEDRO ESCARLATE PIANCA' && a.dataISO === '2026-07-26';

    /* Convenção ANTIGA continua funcionando */
    a = it('Maria Silva APA 03052024 Unimed.pdf');
    out.antigaApa = a.nome === 'Maria Silva' && a.dataISO === '2024-05-03' && a.ehAPA && a.convenio === 'Unimed';
    a = it('Luzinete de Jesus Aguiar 22072026.pdf');
    out.antigaFicha = a.nome === 'Luzinete de Jesus Aguiar' && a.dataISO === '2026-07-22' && !a.ehAPA;

    /* UI: modal tem o botão de pastas; navegação lista pastas e os PDFs da pasta */
    pdfBackup.clientId = () => 'cid-teste';
    cloud.estaLogado = () => true;
    driveImport._tokenLeitura = async () => 'tk-teste';
    driveImport.abrir();
    await new Promise(r => setTimeout(r, 100));
    out.temBotaoPastas = (document.getElementById('modal-body').innerHTML || '').includes('Pastas (ano a ano)');

    const chamadas = [];
    window.fetch = async (url) => {
      chamadas.push(decodeURIComponent(String(url)));
      const corpo = String(url).includes('vnd.google-apps.folder')
        ? { files: [{ id: 'p2025', name: 'AA Prontuário Eletrônico - 2025' }] }
        : { files: [{ id: 'f1', name: 'Abraao-Santiago-Nascimento_Ficha-Anestesia_20072026.pdf', size: '1000' }] };
      return { ok: true, json: async () => corpo };
    };
    await driveImport.pastas();
    out.listouPastas = (document.getElementById('dimp-lista').innerHTML || '').includes('2025')
      && chamadas.some(u => u.includes("vnd.google-apps.folder") && u.includes('Prontuário'));
    await driveImport.buscarPastaIdx(0);
    out.listouPdfsDaPasta = chamadas.some(u => u.includes("'p2025' in parents") && u.includes('application/pdf'))
      && driveImport._arquivos.length === 1
      && driveImport._arquivos[0].nome === 'Abraao Santiago Nascimento'
      && (document.getElementById('dimp-lista').innerHTML || '').includes('voltar às pastas');
    modal.close();
    return out;
  });
  assert(r.novaFicha, 'Paciente_Ficha-Anestesia_data deveria separar nome, tipo e data');
  assert(r.novaApa, 'Paciente_APA_data deveria virar pré-anestésica');
  assert(r.novaConjunto, 'o arquivo único ficha+SRPA deveria ser reconhecido sem sujar o nome');
  assert(r.novaGuia, 'guia de internação deveria manter o nome do paciente limpo');
  assert(r.antigaApa && r.antigaFicha, 'a convenção antiga (Nome [APA] ddmmaaaa [convênio]) deveria continuar valendo');
  assert(r.temBotaoPastas, 'o importador deveria oferecer navegação por pastas (ano a ano)');
  assert(r.listouPastas, 'buscar pastas por nome deveria listar as pastas do Drive');
  assert(r.listouPdfsDaPasta, 'listar uma pasta deveria trazer só os PDFs dela, interpretados');
  await page.close();
});

/* 36) Eventos da ficha: catálogo multiseleção (como o de medicações) */
await test('Eventos: catálogo agrupado com multiseleção adiciona à tabela com descrição técnica', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    location.hash = '#anestesia';
    await new Promise(r => setTimeout(r, 400));

    /* TIPOS continua completo (derivado dos GRUPOS) — nada sumiu do select */
    const tipos = anestesia.eventos.TIPOS;
    out.tiposOk = Array.isArray(tipos) && tipos.includes('Início do pneumoperitônio')
      && tipos.includes('Intubação') && tipos.includes('Outro') && tipos.length >= 50;

    /* botão existe na seção de eventos */
    out.temBotao = !!document.querySelector('button[onclick="anestesia.eventos.abrirCatalogo()"]');

    /* abre o catálogo, filtra e confirma uma multiseleção */
    document.getElementById('eventos-body').innerHTML = '';
    anestesia.eventos.abrirCatalogo();
    await new Promise(r => setTimeout(r, 100));
    const lista = document.getElementById('cat-evt-lista');
    out.abriu = !!lista && lista.querySelectorAll('.cat-evt-item').length >= 50
      && lista.querySelectorAll('.cat-evt-grupo').length >= 10;

    anestesia.eventos._catalogoFiltrar('intuba');
    const visiveis = Array.from(lista.querySelectorAll('.cat-evt-item')).filter(el => el.style.display !== 'none');
    out.filtrou = visiveis.length >= 1 && visiveis.every(el => (el.dataset.nome || '').includes('intuba'));
    anestesia.eventos._catalogoFiltrar('');

    const marcar = ['Intubação', 'Início do pneumoperitônio', 'Antibioticoprofilaxia'];
    lista.querySelectorAll('.cat-evt-item').forEach(el => {
      const gi = +el.querySelector('input').dataset.g, ti = +el.querySelector('input').dataset.i;
      if (marcar.includes(anestesia.eventos.GRUPOS[gi].itens[ti])) el.querySelector('input').checked = true;
    });
    anestesia.eventos._catalogoConfirmar();
    await new Promise(r => setTimeout(r, 100));

    const linhas = Array.from(document.querySelectorAll('#eventos-body tr'));
    const tiposAdicionados = linhas.map(tr => tr.querySelector('[name="evt_tipo[]"]').value);
    out.adicionou = linhas.length === 3 && marcar.every(t => tiposAdicionados.includes(t));
    out.comHora = linhas.every(tr => /\d{2}:\d{2}/.test(tr.querySelector('[name="evt_hora[]"]').value || ''));
    const obsIntub = linhas.find(tr => tr.querySelector('[name="evt_tipo[]"]').value === 'Intubação')
      ?.querySelector('[name="evt_obs[]"]').value || '';
    out.comDescricao = /laringoscopia/i.test(obsIntub);

    document.getElementById('eventos-body').innerHTML = '';
    return out;
  });
  assert(r.tiposOk, 'TIPOS deveria continuar completo, derivado dos grupos do catálogo');
  assert(r.temBotao, 'a seção de eventos deveria ter o botão 📋 Catálogo (multiseleção)');
  assert(r.abriu, 'o catálogo deveria abrir com os eventos agrupados por categoria');
  assert(r.filtrou, 'o filtro deveria esconder o que não bate com a busca');
  assert(r.adicionou, 'confirmar deveria adicionar os 3 eventos marcados à tabela');
  assert(r.comHora, 'cada evento adicionado deveria entrar com a hora atual');
  assert(r.comDescricao, 'eventos com descrição técnica deveriam entrar com ela nos detalhes');
  await page.close();
});

/* 37) Ajustes prático: cards do sistema em 3 grupos recolhíveis + sync automática ao entrar */
await test('Ajustes: 12 cards viram 3 grupos recolhíveis e a sincronização roda sozinha ao entrar', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    /* — grupos montados: cabeçalhos + cards movidos para dentro dos wrappers — */
    ajustesGrupos.montar();   /* idempotente (já montou no boot) */
    out.grupos = ['nuvem', 'equipe', 'modelos'].every(id =>
      document.getElementById('ajg-cab-' + id) && document.getElementById('ajg-' + id));
    out.cardsDentro = document.getElementById('ajg-nuvem').contains(document.getElementById('cloud-card'))
      && document.getElementById('ajg-nuvem').contains(document.getElementById('armazenamento-card'))
      && document.getElementById('ajg-equipe').contains(document.getElementById('equipe-nuvem-card'))
      && document.getElementById('ajg-modelos').contains(document.getElementById('logo-usuario-card'));
    /* fechados por padrão (tela compacta) */
    localStorage.removeItem(ajustesGrupos.KEY);
    ajustesGrupos._aplicar();
    out.fechadoPadrao = document.getElementById('ajg-nuvem').style.display === 'none';
    /* abrir/fechar com toque, lembrado */
    ajustesGrupos.alternar('nuvem');
    out.abriu = document.getElementById('ajg-nuvem').style.display !== 'none'
      && JSON.parse(localStorage.getItem(ajustesGrupos.KEY)).nuvem === true;
    ajustesGrupos.alternar('nuvem');
    out.fechou = document.getElementById('ajg-nuvem').style.display === 'none';
    /* atalho abrirPara abre o grupo certo e devolve o card */
    const c = ajustesGrupos.abrirPara('armazenamento-card');
    out.abrirPara = c && c.id === 'armazenamento-card'
      && document.getElementById('ajg-nuvem').style.display !== 'none';

    /* — sync automática ao entrar — */
    const chamadas = { legado: 0, mods: [], pacientes: 0 };
    cloud.estaConfigurado = () => true;
    cloud.estaLogado = () => true;
    cloud.sincronizar = (o) => { if (o && o.silent) chamadas.legado++; };
    cloudRel._puxados = { anestesia: true, pre: true };   /* já puxados nesta sessão */
    cloudRel.autoPullModulo = async (m) => { chamadas.mods.push(m); };
    pacientes._puxouNestaSessao = true;
    pacientes.sincronizarNuvem = (o) => { if (o && o.silent) chamadas.pacientes++; };
    cloud.autoSyncAoEntrar();
    await new Promise(r => setTimeout(r, 2200));
    out.syncLegado = chamadas.legado >= 1;
    out.pullNovo = Object.keys(cloudRel._puxados).length === 0
      && ['pre', 'anestesia', 'recuperacao', 'financeiro'].every(m => chamadas.mods.includes(m));
    out.syncPacientes = chamadas.pacientes >= 1 && pacientes._puxouNestaSessao === false;
    return out;
  });
  assert(r.grupos, 'os 3 grupos (nuvem/equipe/modelos) deveriam existir em Ajustes');
  assert(r.cardsDentro, 'os cards do sistema deveriam estar DENTRO dos grupos');
  assert(r.fechadoPadrao, 'os grupos deveriam vir fechados por padrão (tela compacta)');
  assert(r.abriu && r.fechou, 'o toque no cabeçalho deveria abrir/fechar e lembrar a escolha');
  assert(r.abrirPara, 'abrirPara deveria abrir o grupo que contém o card e devolvê-lo');
  assert(r.syncLegado, 'entrar deveria disparar a sincronização silenciosa do canal legado');
  assert(r.pullNovo, 'entrar deveria zerar os pulls da sessão e puxar os módulos principais');
  assert(r.syncPacientes, 'entrar deveria sincronizar os pacientes sem nenhum toque');
  await page.close();
});

/* 38) Configurações na nuvem (configSync) + login sem demo/usuário local */
await test('Configurações sobem para a nuvem, descem ao entrar (vence a mais nova) e o login fica só com a conta da nuvem', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    /* ambiente: nuvem "logada" e fora do modo demo (o teste roda dentro dele) */
    demo.ativo = () => false;
    cloud.estaConfigurado = () => true;
    cloud.estaLogado = () => true;
    cloud._garantirToken = async () => true;
    cloud.config = () => ({ url: 'http://nuvem.teste', anonKey: 'k' });
    cloud.session = () => ({ user: { id: 'u-cfg' } });
    cloud._headers = () => ({});
    const envios = [];
    cloud._enviarOp = async (op) => { envios.push(op); return true; };

    /* 1) mudança local é detectada e sobe num doc modulo=config_sync */
    localStorage.removeItem(configSync.META_KEY);
    localStorage.setItem('medsys.v7.termo_padrao', 'TERMO LOCAL A');
    configSync.checarMudancas();
    await new Promise(r => setTimeout(r, 120));
    const op = envios[envios.length - 1];
    out.subiu = !!op && op.modulo === 'config_sync' && op.doc_id === 'cfg'
      && op.dados.chaves['medsys.v7.termo_padrao'].v === 'TERMO LOCAL A';

    /* 2) nuvem MAIS NOVA vence: valor remoto com carimbo no futuro é aplicado */
    const tFuturo = new Date(Date.now() + 60000).toISOString();
    window.fetch = async () => ({ ok: true, json: async () => ([{ dados: { chaves: {
      'medsys.v7.termo_padrao': { v: 'TERMO DA NUVEM', t: tFuturo },
      'medsys.v7.theme': { v: 'dark', t: tFuturo }
    } } }]) });
    const aplicadas = await configSync.puxarAplicar();
    out.aplicou = aplicadas === 2
      && localStorage.getItem('medsys.v7.termo_padrao') === 'TERMO DA NUVEM'
      && localStorage.getItem('medsys.v7.theme') === 'dark';

    /* 3) local MAIS NOVO vence e é reenviado para a nuvem */
    localStorage.setItem('medsys.v7.termo_padrao', 'TERMO LOCAL NOVO');
    configSync.checarMudancas();
    const tPassado = new Date(Date.now() - 3600000).toISOString();
    window.fetch = async () => ({ ok: true, json: async () => ([{ dados: { chaves: {
      'medsys.v7.termo_padrao': { v: 'TERMO VELHO DA NUVEM', t: tPassado }
    } } }]) });
    const nEnvios = envios.length;
    await configSync.puxarAplicar();
    await new Promise(r => setTimeout(r, 120));
    out.localVence = localStorage.getItem('medsys.v7.termo_padrao') === 'TERMO LOCAL NOVO'
      && envios.length > nEnvios;

    /* 4) o pull normal (legado) ignora o doc de config (não vira "módulo") */
    out.foraDoSyncNormal = cloud.MODS.indexOf('config_sync') < 0;

    /* 5) tela de login: sem modo demonstração e sem usuário local */
    auth._render();
    const foot = (document.getElementById('auth-foot') || {}).innerHTML || '';
    out.loginLimpo = !/demonstra/i.test(foot) && !/usuário local/i.test(foot)
      && /Criar conta/i.test(foot);

    /* 6) criação de usuário local desativada na tela de Usuários */
    out.semCriarLocal = !document.querySelector('#usuarios-card button[onclick="ajustesUsuarios.abrirNovo()"]');
    return out;
  });
  assert(r.subiu, 'mudar uma configuração deveria subir o doc config_sync para a nuvem');
  assert(r.aplicou, 'ao entrar, configurações mais novas da nuvem deveriam ser aplicadas no aparelho');
  assert(r.localVence, 'configuração local mais nova deveria vencer e ser reenviada para a nuvem');
  assert(r.foraDoSyncNormal, 'config_sync não deve entrar no pull normal de módulos');
  assert(r.loginLimpo, 'a tela de login não deveria mais oferecer demonstração nem usuário local');
  assert(r.semCriarLocal, 'o botão de criar usuário local deveria ter saído de Usuários e segurança');
  await page.close();
});

/* 39) CBHPM em todo campo: segmentos com ➕, multiplicador xN e auxiliares do cirurgião */
await test('CBHPM: vários códigos no mesmo campo (➕/x2) em todo o app e auxiliares do cirurgião na ficha', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    /* — helpers de segmento e multiplicador — */
    out.parseMult = cbhpm.parseMult('Apendicectomia x2').mult === 2
      && cbhpm.parseMult('Apendicectomia x2').texto === 'Apendicectomia'
      && cbhpm.parseMult('3.01.01.01-8 ×3').mult === 3
      && cbhpm.parseMult('Colecistectomia').mult === 1;
    out.segmento = cbhpm._segmento('A + Bx').seg === 'Bx' && cbhpm._segmento('A + Bx').prefixo === 'A +'
      && cbhpm._segmento('Só um').prefixo === '';

    /* — todo campo CBHPM estático ganhou o botão ➕ — */
    const camposComMais = document.querySelectorAll('.cbhpm-linha .cbhpm-mais').length;
    out.temBotoesMais = camposComMais >= 5;   /* pré, consulta, ficha, SRPA, termo, financeiro, agenda */

    /* — busca por segmento: só o trecho após o último ' + ' é pesquisado — */
    location.hash = '#recuperacao';
    await new Promise(r => setTimeout(r, 400));
    const inp = document.querySelector('#form-recuperacao [name="procedimento"]');
    inp.value = 'Colecistectomia + apendicectomia';
    cbhpm._abrir(inp);
    const itens = inp._cbhpmItens || [];
    out.buscaSegmento = itens.length >= 1 && /apendicectomia/i.test(itens[0].descricao);
    /* escolher preserva o que já estava antes do ' + ' */
    const el0 = inp._cbhpmBox && inp._cbhpmBox.querySelector('.cbhpm-item');
    if (el0) cbhpm._escolher(el0);
    out.escolhaPreserva = inp.value.startsWith('Colecistectomia +') && new RegExp(itens[0].descricao.slice(0, 12)).test(inp.value);
    /* botão ➕ acrescenta ' + ' no fim */
    const btnMais = inp.closest('.cbhpm-linha').querySelector('.cbhpm-mais');
    btnMais.click();
    out.maisAcrescenta = /\+\s$/.test(inp.value);
    inp.value = '';

    /* — na ficha, o ➕ do procedimento principal cria linha no bloco de códigos — */
    location.hash = '#anestesia';
    await new Promise(r => setTimeout(r, 400));
    document.getElementById('cir-combo-body').innerHTML = '';
    const inpFicha = document.querySelector('#form-anestesia [name="procedimento"]');
    const btnFicha = inpFicha.closest('.cbhpm-linha').querySelector('.cbhpm-mais');
    btnFicha.click();
    out.fichaCriaLinha = document.querySelectorAll('#cir-combo-body [name="cir_extra_proc[]"]').length === 1;
    document.getElementById('cir-combo-body').innerHTML = '';

    /* — auxiliares do cirurgião: ➕ ao lado do campo, coleta, impressão — */
    const f = document.getElementById('form-anestesia');
    f.querySelector('[name="cirurgiao"]').value = 'Dr. Principal';
    anestesia.equipeAux.add('Dr. Aux Um');
    anestesia.equipeAux.add('Dra. Aux Dois');
    const estr = anestesia.coletarEstruturado();
    out.auxColeta = JSON.stringify(estr.procedimento.auxiliares) === JSON.stringify(['Dr. Aux Um', 'Dra. Aux Dois']);
    f.querySelector('[name="paciente_nome"]').value = 'Paciente Aux';
    const htmlFicha = printPreview._buildAnestesia();
    out.auxImpressao = htmlFicha.includes('Auxiliares') && htmlFicha.includes('Dr. Aux Um') && htmlFicha.includes('Dra. Aux Dois');
    anestesia.equipeAux.restaurar([]);
    out.auxLimpa = anestesia.equipeAux.coletar().length === 0;

    /* — lançamento rápido entende "código + código x2" no mesmo campo — */
    store.setList('financeiro', []);
    financeiro.lancamentoRapido();
    await new Promise(r => setTimeout(r, 150));
    document.getElementById('fin-rap-paciente').value = 'Paciente Mult';
    document.getElementById('fin-rap-data').value = '2026-07-30';
    document.querySelector('#fin-rap-procs .fin-rap-proc').value = '3.01.01.97-2 + 3.01.01.01-8 x2';
    financeiro._salvarRapido();
    await new Promise(r => setTimeout(r, 150));
    const fin = store.list('financeiro')[0] || {};
    const cods = fin.codigos || [];
    const c97 = cods.find(c => c.codigo === '3.01.01.97-2');
    const c01 = cods.find(c => c.codigo === '3.01.01.01-8');
    out.multQtd = cods.length === 2 && !!c97 && !!c01 && c01.qtd === 2
      && c97.grau === 100 && c01.grau === 50;   /* maior porte (10A) principal */
    store.setList('financeiro', []);
    modal.close();
    return out;
  });
  assert(r.parseMult, 'parseMult deveria entender x2/×3 e devolver o texto limpo');
  assert(r.segmento, '_segmento deveria separar o trecho após o último " + "');
  assert(r.temBotoesMais, 'os campos CBHPM deveriam ganhar o botão ➕ automaticamente');
  assert(r.buscaSegmento, 'a busca deveria valer só para o segmento sendo digitado');
  assert(r.escolhaPreserva, 'escolher uma sugestão deveria preservar os procedimentos anteriores');
  assert(r.maisAcrescenta, 'o ➕ deveria acrescentar " + " e focar o campo');
  assert(r.fichaCriaLinha, 'na ficha, o ➕ do principal deveria criar linha no bloco de códigos');
  assert(r.auxColeta, 'os auxiliares deveriam ser coletados com a ficha');
  assert(r.auxImpressao, 'os auxiliares deveriam sair na impressão da ficha');
  assert(r.auxLimpa, 'restaurar([]) deveria limpar os auxiliares');
  assert(r.multQtd, 'lançamento rápido deveria virar 2 códigos, com x2 → Qtd 2 e hierarquia de grau');
  await page.close();
});

/* 40) Programador: aba exclusiva + ambientes + compartilhamento entre ambientes */
await test('Programador: aba só para a conta dele; ambientes, membros e acesso entre ambientes', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    /* — escondida por padrão (sessão demo/admin comum não é o programador) — */
    out.escondidaPadrao = document.getElementById('nav-programador').style.display === 'none';
    out.bloqueadoComum = auth.podeAcessar('programador') === false;   /* mesmo sendo admin */

    /* — vira o programador (conta da nuvem dele) — */
    cloud.session = () => ({ user: { id: 'u-prog', email: 'mpcaliman@hotmail.com' } });
    out.souProg = programador.souProgramador() === true;
    programador.atualizarVisibilidade();
    out.navAparece = document.getElementById('nav-programador').style.display !== 'none';
    out.podeAcessar = auth.podeAcessar('programador') === true;

    /* — render com nuvem simulada — */
    const chamadas = [];
    programador._req = async (path, opts) => {
      chamadas.push({ path, opts });
      if (path.startsWith('organizations')) return [{ id: 'org-a', nome: 'Ambiente A' }, { id: 'org-b', nome: 'Ambiente B' }];
      if (path.startsWith('organization_users')) return [
        { organization_id: 'org-a', user_id: 'u-med', role: 'gestor', ativo: true },
        { organization_id: 'org-b', user_id: 'u-prog', role: 'gestor', ativo: true }];
      if (path.startsWith('profiles')) return [{ id: 'u-med', nome: 'Medico', email: 'medico@ex.com' }, { id: 'u-prog', email: 'mpcaliman@hotmail.com' }];
      if (path.startsWith('org_shares')) return [{ id: 'sh1', org_origem: 'org-a', org_destino: 'org-b', modulos: ['anestesia'] }];
      return [];
    };
    location.hash = '#programador';
    /* espera ativa: sob carga, o render (navegar → setTimeout → awaits) pode
       demorar mais que um sleep fixo */
    for (let t = 0; t < 40 && !document.getElementById('prog-amb-nome'); t++) {
      await new Promise(r => setTimeout(r, 150));
      if (t === 20) { try { await programador.render(); } catch (e) {} }
    }
    const html = document.getElementById('prog-conteudo').innerHTML;
    out.moduloAtivo = document.getElementById('module-programador').classList.contains('active');
    out.listouAmbientes = html.includes('Ambiente A') && html.includes('Ambiente B') && html.includes('medico@ex.com');
    out.listouShare = html.includes('anestesia') && html.includes('Liberar acesso');
    out.temFormularios = !!document.getElementById('prog-amb-nome') && !!document.getElementById('prog-mem-org') && !!document.getElementById('prog-share-origem');

    /* — criar ambiente chama a RPC certa — */
    programador._rpc = async (nome, body) => { chamadas.push({ rpc: nome, body }); return null; };
    document.getElementById('prog-amb-nome').value = 'Clinica Nova';
    document.getElementById('prog-amb-email').value = 'novo.gestor@ex.com';
    await programador.criarAmbiente();
    const rpc = chamadas.find(c => c.rpc === 'prog_criar_ambiente');
    out.rpcCriar = !!rpc && rpc.body.p_nome === 'Clinica Nova' && rpc.body.p_email_gestor === 'novo.gestor@ex.com';

    /* — origem = destino é bloqueado no share —
       (criarAmbiente dispara um re-render assíncrono; espera a tela voltar) */
    for (let t = 0; t < 40 && !document.getElementById('prog-share-origem'); t++) {
      await new Promise(r => setTimeout(r, 150));
    }
    document.getElementById('prog-share-origem').value = 'org-a';
    document.getElementById('prog-share-destino').value = 'org-a';
    const antes = chamadas.length;
    await programador.criarShare();
    out.bloqueiaMesmoAmbiente = chamadas.length === antes;   /* nenhuma chamada feita */

    /* — a migração 0009 existe no repositório (canal do SQL) — */
    location.hash = '#dashboard';
    return out;
  });
  assert(r.escondidaPadrao, 'a aba Programador deveria vir escondida');
  assert(r.bloqueadoComum, 'nem um admin comum deveria acessar o módulo programador');
  assert(r.souProg && r.navAparece && r.podeAcessar, 'a conta do programador deveria ver e acessar a aba');
  assert(r.moduloAtivo, 'navegar para #programador deveria abrir o módulo');
  assert(r.listouAmbientes, 'a tela deveria listar os ambientes com seus gestores');
  assert(r.listouShare, 'a tela deveria listar os acessos entre ambientes');
  assert(r.temFormularios, 'deveria haver formulários de ambiente, membro e compartilhamento');
  assert(r.rpcCriar, 'criar ambiente deveria chamar a RPC prog_criar_ambiente');
  assert(r.bloqueiaMesmoAmbiente, 'origem = destino não deveria gerar chamada');
  await page.close();
});

/* 41) Impressão: gráfico da ficha sai mesmo com o módulo oculto + ordenar por horário */
await test('Impressão: gráfico de vitais sai no conjunto (módulo oculto) e Horário ordena meds/eventos', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    location.hash = '#anestesia';
    await new Promise(r => setTimeout(r, 400));
    const f = document.getElementById('form-anestesia');
    f.querySelector('[name="paciente_nome"]').value = 'Paciente Grafico';
    anestesia.graficoUI._contexto = 'anestesia';
    document.getElementById('vitais-body').innerHTML = '';
    anestesia.vitais.add(false, { hora: '10:00', pas: '120', pad: '80', fc: '70', spo2: '98' });
    anestesia.vitais.add(false, { hora: '10:15', pas: '118', pad: '78', fc: '72', spo2: '98' });

    /* sai da ficha — o módulo fica OCULTO (o cenário do bug: imprimir ficha+SRPA
       estando na SRPA fazia o canvas ter largura 0 e o gráfico sumia) */
    location.hash = '#recuperacao';
    await new Promise(r => setTimeout(r, 400));
    out.moduloOculto = getComputedStyle(document.getElementById('module-anestesia')).display === 'none';
    const html = printPreview._buildAnestesia();
    out.temGrafico = html.includes('pp-grafico-img') && html.includes('data:image');

    /* o conversor de PDF (nuvem/backup) agora inclui a imagem sem quebrar */
    const ppp = document.getElementById('ppp');
    ppp.innerHTML = html;
    const J = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
    let doc = null;
    try { doc = printPreview._gerarDocDeTexto(J, ppp); } catch (e) { doc = null; }
    out.pdfOk = !!doc;
    ppp.innerHTML = '';

    /* — clicar em "Horário" ordena eventos e medicações (crescente; sem hora vai pro fim) — */
    location.hash = '#anestesia';
    await new Promise(r => setTimeout(r, 300));
    out.thClicavel = !!document.querySelector('#tab-eventos th[onclick*="ordenarPorHorario"]')
      && !!document.querySelector('#tab-medicacoes th[onclick*="ordenarPorHorario"]');
    document.getElementById('eventos-body').innerHTML = '';
    anestesia.eventos.add({ tipo: 'Extubação', hora: '12:30' });
    anestesia.eventos.add({ tipo: 'Indução', hora: '09:10' });
    anestesia.eventos.add({ tipo: 'Intubação', hora: '10:05' });
    anestesia.ordenarPorHorario('eventos-body');
    const horasEvt = Array.from(document.querySelectorAll('#eventos-body [name="evt_hora[]"]')).map(i => i.value);
    out.evtOrdenado = JSON.stringify(horasEvt) === JSON.stringify(['09:10', '10:05', '12:30']);

    document.getElementById('medicacoes-body').innerHTML = '';
    anestesia.meds.add({ hora: '11:00', nome: 'Propofol' });
    anestesia.meds.add({ hora: '', nome: 'SemHora' });
    anestesia.meds.add({ hora: '08:30', nome: 'Midazolam' });
    anestesia.ordenarPorHorario('medicacoes-body');
    const nomes = Array.from(document.querySelectorAll('#medicacoes-body [name="med_nome[]"]')).map(i => i.value);
    out.medOrdenado = nomes[0] === 'Midazolam' && nomes[1] === 'Propofol' && nomes[2] === 'SemHora';

    document.getElementById('eventos-body').innerHTML = '';
    document.getElementById('medicacoes-body').innerHTML = '';
    document.getElementById('vitais-body').innerHTML = '';
    return out;
  });
  assert(r.moduloOculto, 'o cenário exige o módulo da ficha oculto');
  assert(r.temGrafico, 'o gráfico de vitais deveria sair na impressão mesmo com o módulo oculto');
  assert(r.pdfOk, 'o PDF gerado (nuvem/backup) deveria incluir o gráfico sem quebrar');
  assert(r.thClicavel, 'os cabeçalhos "Horário" de eventos e medicações deveriam ser clicáveis');
  assert(r.evtOrdenado, 'os eventos deveriam ficar em ordem crescente de horário');
  assert(r.medOrdenado, 'as medicações deveriam ordenar por horário, sem-hora por último');
  await page.close();
});

/* 42) Pendências de convênio (≠ Unimed): janela, fluxo de faturamento e card no Dashboard */
await test('Pendências: plano ≠ Unimed vira alerta com guia/plano; fluxo de faturamento dá baixa; card no Dashboard', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    const hoje = (typeof utils !== 'undefined' && utils.hojeISO) ? utils.hojeISO() : new Date().toISOString().slice(0, 10);

    /* — regra do plano: tudo exceto Unimed (particular/SUS não são plano) — */
    out.regra = pendencias.ehPlanoPendente('Bradesco Saúde') === true
      && pendencias.ehPlanoPendente('Amil') === true
      && pendencias.ehPlanoPendente('Unimed') === false
      && pendencias.ehPlanoPendente('UNIMED Vitória') === false
      && pendencias.ehPlanoPendente('Particular') === false
      && pendencias.ehPlanoPendente('SUS') === false
      && pendencias.ehPlanoPendente('') === false;

    /* — registros dos 4 módulos (Unimed NÃO entra) — */
    ['consulta', 'pre', 'anestesia', 'financeiro'].forEach(m => store.setList(m, []));
    store.save('pre', { nome: 'Paciente Pre', data: hoje, convenio: 'Bradesco Saúde', senha: 'G-111' });
    store.save('consulta', { nome: 'Paciente Unimed', data: hoje, convenio: 'Unimed' });
    store.save('anestesia', { paciente: { nome: 'Paciente Ficha', convenio: 'Amil', senha: 'G-222' }, procedimento: { data: hoje } });
    const fin = store.save('financeiro', { paciente: 'Paciente Fin', data_proc: hoje, convenio: 'SulAmérica', senha: 'G-333' });

    const lista = pendencias.listar();
    out.lista = lista.length === 3
      && !lista.some(p => /unimed/i.test(p.convenio))
      && lista.some(p => p.nome === 'Paciente Ficha' && p.guia === 'G-222' && p.convenio === 'Amil');

    /* — janela: dados + Fechar — */
    pendencias.abrir(false);
    await new Promise(r => setTimeout(r, 100));
    const corpo = document.getElementById('modal-body').innerHTML;
    const rodape = document.getElementById('modal-footer') ? document.getElementById('modal-footer').innerHTML : document.querySelector('#modal-backdrop').innerHTML;
    out.janela = corpo.includes('Paciente Pre') && corpo.includes('G-111') && corpo.includes('SulAmérica')
      && /Fechar/.test(rodape);

    /* — ✔ Resolver dá baixa — */
    const pPre = lista.find(p => p.mod === 'pre');
    pendencias.resolver('pre', pPre.id);
    await new Promise(r => setTimeout(r, 100));
    out.resolveu = pendencias.listar().length === 2;

    /* — marcar etapa do fluxo dá baixa e fica gravada com carimbo — */
    pendencias.marcarStatus('financeiro', fin._id, 'faturado', true);
    const finDepois = store.getById('financeiro', fin._id);
    out.fluxo = pendencias.listar().length === 1
      && !!(finDepois._faturamento && finDepois._faturamento.faturado)
      && !!finDepois._pendResolvida;

    /* — checklist no formulário do financeiro (8 etapas) — */
    pendencias.renderFinanceiro(finDepois);
    const boxFat = document.getElementById('fat-status-box');
    out.checklist = boxFat.style.display !== 'none'
      && boxFat.querySelectorAll('input[type="checkbox"]').length === 8
      && /Recurso de glosa/.test(boxFat.innerHTML)
      && boxFat.querySelectorAll('input:checked').length === 1;

    /* — card no Dashboard com o total (visível p/ quem acessa o financeiro) — */
    auth.estaLogado = () => true;
    auth.podeAcessar = (m) => true;
    pendencias.renderDashboard();
    const card = document.getElementById('pendencias-card');
    out.dashboard = !!card && card.style.display !== 'none' && card.innerHTML.includes('Ver pendências (1)');

    /* — resolvida a última, o card some — */
    const resta = pendencias.listar()[0];
    pendencias.resolver(resta.mod, resta.id);
    await new Promise(r => setTimeout(r, 100));
    pendencias.renderDashboard();
    out.cardSome = document.getElementById('pendencias-card').style.display === 'none';

    modal.close();
    ['consulta', 'pre', 'anestesia', 'financeiro'].forEach(m => store.setList(m, []));
    return out;
  });
  assert(r.regra, 'a regra deveria pegar todo plano exceto Unimed (particular/SUS fora)');
  assert(r.lista, 'consulta/pré/ficha/financeiro de plano ≠ Unimed deveriam virar pendência com guia e plano');
  assert(r.janela, 'a janela deveria mostrar data/paciente/plano/guia e ter o botão Fechar');
  assert(r.resolveu, '✔ Resolver deveria dar baixa na pendência');
  assert(r.fluxo, 'marcar uma etapa do fluxo deveria dar baixa e gravar o carimbo');
  assert(r.checklist, 'o financeiro deveria mostrar o checklist com as 8 etapas do fluxo');
  assert(r.dashboard, 'o Dashboard deveria mostrar o card de pendências com o total');
  assert(r.cardSome, 'sem pendências, o card do Dashboard deveria sumir');
  await page.close();
});

/* 43) Impressão da ficha: medicações COMPLETAS (fim de gases/halogenados, fluxo, diluição, obs) */
await test('Impressão: medicações saem completas (Tipo, Diluição, Fluxo, FIM e Observação)', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    location.hash = '#anestesia';
    await new Promise(r => setTimeout(r, 400));
    const f = document.getElementById('form-anestesia');
    f.querySelector('[name="paciente_nome"]').value = 'Paciente Meds';
    anestesia.graficoUI._contexto = 'anestesia';
    document.getElementById('medicacoes-body').innerHTML = '';
    anestesia.meds.add({ hora: '10:00', nome: 'Sevoflurano', dose: '2', unidade: '%', via: 'Inalatória', tipo: 'Inalatório', velocidade: '2 L/min', horaFim: '11:30' });
    anestesia.meds.add({ hora: '10:05', nome: 'Propofol', dose: '200', unidade: 'mg', via: 'EV', tipo: 'Infusão contínua', diluicao: '500mg/50mL', velocidade: '20 mL/h', horaFim: '11:20', obs: 'TCI 3,0' });
    anestesia.meds.add({ hora: '10:10', nome: 'Dipirona', dose: '2', unidade: 'g', via: 'EV', obs: 'lento, diluído' });

    const html = printPreview._buildAnestesia();
    /* colunas opcionais aparecem porque há conteúdo */
    out.temFim = html.includes('<th>Fim</th>') && html.includes('11:30') && html.includes('11:20');
    out.temFluxo = /Fluxo \/ Veloc\./.test(html) && html.includes('2 L/min') && html.includes('20 mL/h');
    out.temDiluicao = /Diluição \/ Solução/.test(html) && html.includes('500mg/50mL');
    out.temTipo = html.includes('<th>Tipo</th>') && html.includes('Inalatório');
    out.temObs = html.includes('TCI 3,0') && html.includes('lento, diluído');

    /* sem infusões/gases: fluxo/diluição/tipo não poluem, mas FIM é fixo */
    document.getElementById('medicacoes-body').innerHTML = '';
    anestesia.meds.add({ hora: '10:10', nome: 'Dipirona', dose: '2', unidade: 'g', via: 'EV' });
    const html2 = printPreview._buildAnestesia();
    out.limpaSemExtras = html2.includes('<th>Fim</th>') && !/Fluxo \/ Veloc\./.test(html2) && !html2.includes('<th>Tipo</th>');

    document.getElementById('medicacoes-body').innerHTML = '';

    /* — menu "Carregar ▾": nome certo (sem [object Object]), fecha ao escolher e ao clicar fora — */
    store.setList('anestesia', []);
    store.save('anestesia', { paciente: { nome: 'Fulano Objeto' }, procedimento: { data: '2026-07-30' } });
    ui.toggleDropdown('dd-anestesia');
    await new Promise(r => setTimeout(r, 120));
    const menu = document.getElementById('dd-anestesia-menu');
    out.ddNome = menu.innerHTML.includes('Fulano Objeto') && !menu.innerHTML.includes('object Object');
    menu.querySelector('.dropdown-item').onclick();
    await new Promise(r => setTimeout(r, 200));
    out.ddFechaAoEscolher = !document.querySelector('.dropdown-menu.open');
    ui.toggleDropdown('dd-anestesia');
    await new Promise(r => setTimeout(r, 120));
    const abriuDeNovo = !!document.querySelector('.dropdown-menu.open');
    document.body.click();   /* clique FORA */
    await new Promise(r => setTimeout(r, 120));
    out.ddFechaForaClique = abriuDeNovo && !document.querySelector('.dropdown-menu.open');
    store.setList('anestesia', []);
    return out;
  });
  assert(r.ddNome, 'o menu Carregar deveria mostrar o nome do paciente (não [object Object])');
  assert(r.ddFechaAoEscolher, 'escolher um item deveria fechar o menu de verdade');
  assert(r.ddFechaForaClique, 'clicar fora deveria fechar o menu');
  assert(r.temFim, 'o horário de FIM (gases/halogenados/infusões) deveria sair na impressão');
  assert(r.temFluxo, 'o fluxo/velocidade deveria sair na impressão');
  assert(r.temDiluicao, 'a diluição/solução deveria sair na impressão');
  assert(r.temTipo, 'o tipo da medicação deveria sair na impressão');
  assert(r.temObs, 'as observações das medicações deveriam sair na impressão');
  assert(r.limpaSemExtras, 'sem infusões/gases, as colunas extras não deveriam poluir a impressão');
  await page.close();
});

/* 44) Nada de um paciente vaza para o próximo: zera após finalizar+imprimir; rascunho não captura finalizado */
await test('Rascunhos: zera após finalizar+imprimir e nunca capturam registro finalizado', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    store.setList('anestesia', []); store.setList('recuperacao', []);
    localStorage.removeItem('medsys.v7.rascunhos.anestesia');
    localStorage.removeItem('medsys.v7.rascunho_ativo.anestesia');
    location.hash = '#anestesia';
    await new Promise(r => setTimeout(r, 400));

    /* caso completo finalizado com SRPA automática + IMPRESSÃO conjunta */
    const f = document.getElementById('form-anestesia');
    const set = (n, v) => { const el = f.querySelector('[name="' + n + '"]'); if (el) el.value = v; };
    set('paciente_nome', 'Paciente Antigo'); set('data_anestesia', '2026-07-30');
    set('procedimento', 'Colecistectomia videolaparoscópica');
    set('hora_sala_saida', '12:00'); set('anestesiologista', 'Dr. Vazamento');
    anestesia.vitais.add(false, { hora: '11:50', pas: '120', pad: '80', fc: '72', spo2: '98' });
    anestesia.salvar({ finalizar: true });
    await new Promise(r => setTimeout(r, 600));
    const fichaId = store.list('anestesia')[0]._id;
    modal.close();
    anestesia._srpaAutomatica(fichaId);
    await new Promise(r => setTimeout(r, 150));
    document.getElementById('srpa-auto-alta').value = '13:00';
    document.getElementById('srpa-auto-imprimir').checked = true;   /* COM impressão */
    anestesia._gerarSrpaAutomatica(fichaId);
    await new Promise(r => setTimeout(r, 1800));
    /* o preview conjunto abriu com a ficha recarregada no form */
    out.previewAberto = document.getElementById('print-preview-overlay').classList.contains('show');
    out.formComCaso = (f.querySelector('[name="paciente_nome"]') || {}).value === 'Paciente Antigo';

    /* enquanto o finalizado está no form, auto-save e rascunho NÃO capturam */
    state.dirty = true; state.autosaveEnabled = true; state.currentModule = 'anestesia';
    localStorage.removeItem('medsys.v3.autosave.anestesia');
    autoSaveAnestesia();
    out.autosaveNaoCaptura = !localStorage.getItem('medsys.v3.autosave.anestesia');
    rascunhos.garantirAtivo('anestesia');
    rascunhos.salvarAtual('anestesia');
    const rasc1 = rascunhos.list('anestesia')[0] || {};
    out.rascunhoNaoCaptura = !(rasc1.dados && rasc1.dados.paciente && rasc1.dados.paciente.nome === 'Paciente Antigo')
      && (rasc1.label || '').indexOf('Paciente Antigo') < 0;

    /* FECHAR o preview zera a ficha e a SRPA — nada sobra para o próximo */
    printPreview.fechar();
    await new Promise(r => setTimeout(r, 200));
    out.fichaZerada = (f.querySelector('[name="paciente_nome"]') || {}).value === ''
      && document.querySelectorAll('#vitais-body tr').length === 0
      && document.querySelectorAll('#medicacoes-body tr').length === 0;
    const fr = document.getElementById('form-recuperacao');
    out.srpaZerada = ((fr.querySelector('[name="nome"]') || {}).value || '') === ''
      && document.querySelectorAll('#srpa-vitais-body tr').length === 0;

    store.setList('anestesia', []); store.setList('recuperacao', []);
    localStorage.removeItem('medsys.v7.rascunhos.anestesia');
    localStorage.removeItem('medsys.v7.rascunho_ativo.anestesia');
    return out;
  });
  assert(r.previewAberto && r.formComCaso, 'o cenário exige o preview conjunto aberto com a ficha recarregada');
  assert(r.autosaveNaoCaptura, 'o auto-save não deveria fotografar um registro finalizado');
  assert(r.rascunhoNaoCaptura, 'o Rascunho 1 não deveria receber dados do caso finalizado');
  assert(r.fichaZerada, 'fechar o preview deveria ZERAR a ficha (nada do paciente anterior)');
  assert(r.srpaZerada, 'fechar o preview deveria ZERAR também a SRPA');
  await page.close();
});

/* 45) Editar registro FINALIZADO → salva como CORREÇÃO (só o diff), original intacto */
await test('Correção: editar e salvar um registro finalizado gera adendo com o diff; original não muda', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    store.setList('pre', []); store.setList('anestesia', []); store.setList('recuperacao', []);

    /* — motor de diff: só o que mudou, com antes → depois — */
    const reg = store.save('pre', { nome: 'Paciente Original', alergias: 'Nega', convenio: 'Unimed', _finalizado: true });
    const linhas = adendos.diffRegistro(reg, { nome: 'Paciente Original', alergias: 'Dipirona', convenio: 'Unimed', campo_novo: 'apareceu' });
    out.diff = linhas.some(l => l.includes('alergias') && l.includes('"Nega"') && l.includes('"Dipirona"'))
      && linhas.some(l => l.includes('campo novo') && l.includes('—') && l.includes('"apareceu"'))
      && !linhas.some(l => l.includes('• nome:'));

    /* — salvarComoCorrecao: original intacto + adendo CORREÇÃO — */
    adendos.salvarComoCorrecao('pre', reg, Object.assign({}, JSON.parse(JSON.stringify(reg)), { alergias: 'Dipirona' }));
    const depois = store.getById('pre', reg._id);
    out.originalIntacto = depois.alergias === 'Nega' && depois._finalizado === true;
    out.adendoCorrecao = (depois._adendos || []).length === 1
      && /CORREÇÃO/.test(depois._adendos[0].texto)
      && depois._adendos[0].texto.includes('Dipirona');

    /* — fluxo real na FICHA: finaliza, reabre, edita e clica Salvar — */
    location.hash = '#anestesia';
    await new Promise(r => setTimeout(r, 400));
    const f = document.getElementById('form-anestesia');
    const set = (n, v) => { const el = f.querySelector('[name="' + n + '"]'); if (el) el.value = v; };
    set('paciente_nome', 'Paciente Corrigivel'); set('data_anestesia', '2026-07-30');
    set('procedimento', 'Colecistectomia videolaparoscópica');
    anestesia.salvar({ finalizar: true });
    await new Promise(r => setTimeout(r, 500));
    modal.close();
    const fichaId = store.list('anestesia')[0]._id;
    anestesia.carregar(store.getById('anestesia', fichaId));
    await new Promise(r => setTimeout(r, 300));
    set('procedimento', 'Colecistectomia + biópsia hepática');
    anestesia.salvar();
    await new Promise(r => setTimeout(r, 300));
    const ficha = store.getById('anestesia', fichaId);
    out.fichaOriginalIntacta = ficha.procedimento.descricao === 'Colecistectomia videolaparoscópica';
    out.fichaCorrecao = (ficha._adendos || []).some(a => /CORREÇÃO/.test(a.texto)
      && a.texto.includes('biópsia hepática') && a.texto.includes('descricao'));

    /* — salvar SEM mudar nada não cria correção — */
    anestesia.carregar(store.getById('anestesia', fichaId));
    await new Promise(r => setTimeout(r, 300));
    const nAntes = (store.getById('anestesia', fichaId)._adendos || []).length;
    anestesia.salvar();
    await new Promise(r => setTimeout(r, 200));
    out.semMudancaSemCorrecao = (store.getById('anestesia', fichaId)._adendos || []).length === nAntes;

    store.setList('pre', []); store.setList('anestesia', []); store.setList('recuperacao', []);
    modal.close();
    return out;
  });
  assert(r.diff, 'o diff deveria listar só os campos alterados, com antes → depois');
  assert(r.originalIntacto, 'o registro original deveria permanecer intacto');
  assert(r.adendoCorrecao, 'as mudanças deveriam virar um adendo CORREÇÃO');
  assert(r.fichaOriginalIntacta, 'no fluxo real, salvar uma ficha finalizada editada não pode sobrescrevê-la');
  assert(r.fichaCorrecao, 'a edição da ficha deveria virar CORREÇÃO com o campo alterado');
  assert(r.semMudancaSemCorrecao, 'salvar sem mudar nada não deveria criar correção');
  await page.close();
});

/* 46) Usuários: espelho da nuvem com id (✏️/🗑️ funcionam), "(você)" certo e caminho para virar gestor */
await test('Usuários: editar funciona nos espelhos da nuvem, só um "(você)", e há caminho para virar gestor', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    /* cenário do print: dois espelhos da nuvem criados SEM id (versão antiga) */
    auth._salvarUsuarios([
      { usuario: 'mpcaliman@hotmail.com', nome: 'mpcaliman', perfil: 'admin', senhaHash: 'x', nuvem: true },
      { usuario: 'mpcanestesiologia@gmail.com', nome: 'mpcanestesiologia', perfil: 'admin', senhaHash: 'x', nuvem: true }
    ]);
    out.reparou = auth._repararIds() === true
      && auth._lerUsuarios().every(u => !!u.id)
      && new Set(auth._lerUsuarios().map(u => u.id)).size === 2;

    /* sessão = primeiro usuário → só ele é "(você)" */
    auth._definirSessao(auth._lerUsuarios()[0]);
    location.hash = '#ajustes';
    await new Promise(r => setTimeout(r, 500));
    ajustesUsuarios.render();
    const html = document.getElementById('usuarios-lista').innerHTML;
    out.umVoce = (html.match(/\(você\)/g) || []).length === 1;

    /* ✏️ abre o modal do usuário CERTO (era o bug: id undefined → sem ação) */
    const users = auth._lerUsuarios();
    modal.close();
    ajustesUsuarios.editar(users[1].id);
    await new Promise(r => setTimeout(r, 150));
    out.editarAbre = document.getElementById('modal-backdrop').classList.contains('show')
      && (document.getElementById('modal-body').innerHTML || '').includes('mpcanestesiologia@gmail.com');
    out.avisoNuvem = (document.getElementById('modal-body').innerHTML || '').includes('conta da nuvem');
    /* trocar para Secretária/Auxiliar aplica as permissões restritas */
    document.getElementById('user-perfil').value = 'secretaria';
    ajustesUsuarios._sincronizarPerfil(false);
    await ajustesUsuarios.salvarEdicao(users[1].id);
    await new Promise(r => setTimeout(r, 200));
    const dep = auth._lerUsuarios().find(u => u.usuario === 'mpcanestesiologia@gmail.com');
    out.virouSecretaria = dep.perfil === 'secretaria' && !dep.modulos.includes('anestesia') && !dep.modulos.includes('ajustes');

    /* Equipe da nuvem sem gestor: em vez de aviso morto, botões de ação */
    cloud.estaConfigurado = () => true;
    cloud.estaLogado = () => true;
    cloud.session = () => ({ user: { id: 'u1', email: 'mpcaliman@hotmail.com' } });
    auth._definirSessao(Object.assign({}, auth._lerUsuarios()[0], { role: null }));
    await equipeNuvem.render();
    const eq = document.getElementById('equipe-nuvem-lista').innerHTML;
    out.temCaminho = eq.includes('criarMinhaClinica') && eq.includes('atualizarMeuPapel');

    /* criar clínica chama a RPC certa e o papel vira gestor no aparelho */
    const chamadas = [];   /* acumula: o render seguinte também usa fetch */
    cloud._garantirToken = async () => true;
    cloud.config = () => ({ url: 'http://nuvem.teste', anonKey: 'k' });
    cloud._headers = () => ({});
    window.prompt = () => 'Clinica Teste';
    window.fetch = async (url, opts) => { chamadas.push({ url: String(url), body: (opts && opts.body) || '' }); return { ok: true, json: async () => 'org-1' }; };
    cloud.buscarPerfil = async () => ({ uid: 'u1', email: 'mpcaliman@hotmail.com', role: 'gestor', organization_id: 'org-1', ativo: true });
    await equipeNuvem.criarMinhaClinica();
    await new Promise(r => setTimeout(r, 200));
    out.rpcCerta = chamadas.some(c => c.url.includes('rpc/criar_minha_organizacao') && c.body.includes('Clinica Teste'));
    out.virouGestor = equipeNuvem.ehGestor() === true
      && (auth._lerUsuarios().find(u => u.usuario === 'mpcaliman@hotmail.com') || {}).role === 'gestor';

    auth._salvarUsuarios([]);
    modal.close();
    return out;
  });
  assert(r.reparou, 'espelhos antigos sem id deveriam ganhar ids únicos');
  assert(r.umVoce, 'apenas o usuário logado deveria aparecer como "(você)"');
  assert(r.editarAbre, 'o ✏️ deveria abrir o modal do usuário certo');
  assert(r.avisoNuvem, 'editar conta da nuvem deveria avisar que o papel definitivo é o da nuvem');
  assert(r.virouSecretaria, 'mudar para Secretária deveria restringir os módulos');
  assert(r.temCaminho, 'sem gestor, a Equipe da nuvem deveria oferecer criar clínica / atualizar papel');
  assert(r.rpcCerta, 'criar clínica deveria chamar a RPC criar_minha_organizacao');
  assert(r.virouGestor, 'após criar a clínica, o usuário deveria virar gestor no aparelho');
  await page.close();
});

/* 47) Recuperação em lote, transferir para a clínica e conta nova SEM acesso total */
await test('Recuperação: restaurar todos os arquivados, enviar tudo p/ a clínica e conta nova entra restrita', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};

    /* — arquivamento automático agora é OPT-IN (padrão desligado) — */
    localStorage.removeItem(arquivo.AUTO_KEY);
    out.autoDesligado = arquivo.autoLigado() === false;
    store.setList('anestesia', []);
    const antigo = store.save('anestesia', {
      paciente: { nome: 'Caso Antigo' }, procedimento: { data: '2020-01-10' },
      _relUpdatedAt: '2020-01-10T10:00:00Z'
    });
    const lst = store.list('anestesia');
    lst[0]._updatedAt = '2020-01-10T10:00:00Z';
    store.setList('anestesia', lst);
    armazenamento.autoManutencao();
    out.naoArquivouSozinho = store.list('anestesia').length === 1 && arquivo.total() === 0;

    /* manual continua funcionando */
    arquivo.arquivarAntigos();
    out.arquivouManual = store.list('anestesia').length === 0 && arquivo.total() === 1;

    /* — restaurarTodos traz de volta em lote (da nuvem) — */
    cloudRel.disponivel = () => true;
    cloud._garantirToken = async () => true;
    cloud.config = () => ({ url: 'http://nuvem.teste', anonKey: 'k' });
    cloud.session = () => ({ user: { id: 'u1', email: 'mpcaliman@hotmail.com' } });
    cloud._headers = () => ({});
    cloudRel._orgAsync = async () => 'org-1';
    cloudRel._lerAtualTab = async () => ({ legacy_id: antigo._id, data: { _id: antigo._id, paciente: { nome: 'Caso Antigo' } }, updated_at: '2020-01-10T10:00:00Z' });
    cloudRel._rowParaRegistro = (row) => Object.assign({}, row.data, { _relUpdatedAt: row.updated_at });
    const res = await arquivo.restaurarTodos({ silent: true });
    out.restaurouTodos = res.ok === 1 && store.list('anestesia').length === 1 && arquivo.total() === 0;

    /* — enviarTudoParaClinica manda cada registro para a organização — */
    const enviados = [];
    cloudRel.enviarRegistro = async (mod, item) => { enviados.push(mod + ':' + item._id); return { ok: true }; };
    cloudRel.enviarPaciente = async () => ({ ok: true });
    store.setList('pacientes', [{ _id: 'p1', nome: 'Paciente Um' }]);
    const env = await cloudRel.enviarTudoParaClinica({ silent: true });
    out.enviouTudo = env && env.ok >= 2 && enviados.some(e => e.startsWith('anestesia:'));

    /* — SEGURANÇA: conta NOVA num aparelho que já tem usuário NÃO vira admin — */
    auth._salvarUsuarios([{ id: 'u_1', usuario: 'mpcaliman@hotmail.com', nome: 'dono', perfil: 'admin', senhaHash: 'x', nuvem: true, role: 'gestor' }]);
    const nova = await auth._espelharUsuarioNuvem('mpcanestesiologia@gmail.com', 'senha123', null);
    out.novaRestrita = nova.perfil === 'secretaria'
      && !nova.modulos.includes('anestesia') && !nova.modulos.includes('ajustes') && !nova.modulos.includes('financeiro') === false;
    /* e o papel do SERVIDOR sempre manda (mesmo com espelho antigo permissivo) */
    const comPapel = await auth._espelharUsuarioNuvem('mpcanestesiologia@gmail.com', 'senha123', { role: 'auxiliar', uid: 'u2', organization_id: 'org-1' });
    out.papelDoServidorManda = comPapel.perfil === 'secretaria' && comPapel.role === 'auxiliar'
      && !comPapel.modulos.includes('anestesia');
    /* primeira conta do aparelho continua sendo o dono (admin) */
    auth._salvarUsuarios([]);
    const dono = await auth._espelharUsuarioNuvem('mpcaliman@hotmail.com', 'senha123', null);
    out.donoAdmin = dono.perfil === 'admin';

    auth._salvarUsuarios([]);
    store.setList('anestesia', []); store.setList('pacientes', []);
    return out;
  });
  assert(r.autoDesligado, 'o arquivamento automático deveria vir DESLIGADO');
  assert(r.naoArquivouSozinho, 'a manutenção automática não pode arquivar registros sozinha');
  assert(r.arquivouManual, 'o arquivamento manual deveria continuar funcionando');
  assert(r.restaurouTodos, '"Trazer TODOS de volta" deveria restaurar os arquivados em lote');
  assert(r.enviouTudo, '"Enviar tudo para a minha clínica" deveria espelhar os registros na organização');
  assert(r.novaRestrita, 'conta nova em aparelho com usuários deveria entrar RESTRITA (não admin)');
  assert(r.papelDoServidorManda, 'o papel definido na nuvem deveria mandar sempre');
  assert(r.donoAdmin, 'a primeira conta do aparelho continua sendo o dono (admin)');
  await page.close();
});

/* 48) Restauração completa da nuvem: backup legado + clínica, com relatório */
await test('Restaurar tudo da nuvem: traz do backup da conta e da clínica, sem duplicar', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    ['anestesia', 'pre', 'consulta'].forEach(m => store.setList(m, []));
    /* já existe 1 ficha no aparelho — não pode duplicar */
    store.setList('anestesia', [{ _id: 'fx-1', paciente: { nome: 'Já tinha' } }]);

    cloud.estaConfigurado = () => true;
    cloud.estaLogado = () => true;
    cloud._garantirToken = async () => true;
    cloud.config = () => ({ url: 'http://nuvem.teste', anonKey: 'k' });
    cloud.session = () => ({ user: { id: 'u1', email: 'mpcaliman@hotmail.com' } });
    cloud._headers = () => ({});

    /* canal LEGADO devolve 3 docs (1 repetido) */
    let pagina = 0;
    window.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/documentos?')) {
        pagina++;
        if (pagina > 1) return { ok: true, json: async () => [] };
        return { ok: true, json: async () => ([
          { modulo: 'anestesia', doc_id: 'fx-1', dados: { _id: 'fx-1', paciente: { nome: 'Já tinha' } }, atualizado_em: '2026-01-01' },
          { modulo: 'anestesia', doc_id: 'fx-2', dados: { _id: 'fx-2', paciente: { nome: 'Voltou da nuvem' } }, atualizado_em: '2026-01-02' },
          { modulo: 'pre', doc_id: 'pre-1', dados: { _id: 'pre-1', nome: 'Pre da nuvem' }, atualizado_em: '2026-01-03' }
        ]) };
      }
      return { ok: true, json: async () => [] };
    };
    /* canal RELACIONAL devolve 1 consulta */
    cloudRel.disponivel = () => true;
    cloudRel._orgAsync = async () => 'org-1';
    cloudRel.puxarModulo = async (mod) => (mod === 'consulta' ? [{ _id: 'c-1', nome: 'Consulta da clínica' }] : []);
    pacientes.sincronizarNuvem = async () => {};

    const rel = await cloud.restaurarTudoDaNuvem({ silent: true });
    out.novos = rel.novos === 3 && rel.jaTinha === 1;
    out.semDuplicar = store.list('anestesia').length === 2
      && store.list('anestesia').filter(x => x._id === 'fx-1').length === 1;
    out.trouxeLegado = !!store.getById('anestesia', 'fx-2') && !!store.getById('pre', 'pre-1');
    out.trouxeRelacional = !!store.getById('consulta', 'c-1');
    out.contagemPorModulo = rel.legado.anestesia === 2 && rel.legado.pre === 1 && rel.relacional.consulta === 1;

    /* relatório na tela */
    cloud._mostrarRelatorioRestauracao(rel);
    await new Promise(r => setTimeout(r, 120));
    const corpo = document.getElementById('modal-body').innerHTML;
    out.relatorio = corpo.includes('3') && /Fichas de anestesia/.test(corpo) && /Backup \(nuvem\)/.test(corpo);
    modal.close();

    /* botão na tela de armazenamento */
    out.temBotao = !!document.querySelector('button[onclick="cloud.restaurarTudoDaNuvem()"]');

    ['anestesia', 'pre', 'consulta'].forEach(m => store.setList(m, []));
    return out;
  });
  assert(r.novos, 'deveria trazer 3 registros novos e reconhecer 1 que já existia');
  assert(r.semDuplicar, 'não deveria duplicar o registro que já estava no aparelho');
  assert(r.trouxeLegado, 'deveria trazer os registros do backup da conta (canal legado)');
  assert(r.trouxeRelacional, 'deveria trazer os registros da clínica (canal relacional)');
  assert(r.contagemPorModulo, 'o relatório deveria contar por módulo e por canal');
  assert(r.relatorio, 'o relatório na tela deveria mostrar os números por módulo');
  assert(r.temBotao, 'a tela de Armazenamento deveria ter o botão de restaurar tudo da nuvem');
  await page.close();
});

/* 49) Conta da nuvem SEM clínica entra restrita (e o gestor mantém o papel dela) */
await test('Sem clínica vinculada = acesso restrito; o papel do gestor rebaixa o espelho antigo', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    cloud.estaConfigurado = () => true;
    cloud.estaLogado = () => true;

    /* espelho ANTIGO da secretária, criado como Administrador */
    auth._salvarUsuarios([
      { id: 'u_1', usuario: 'mpcaliman@hotmail.com', nome: 'dono', perfil: 'admin', senhaHash: 'x', nuvem: true, role: 'gestor' },
      { id: 'u_2', usuario: 'mpcanestesiologia@gmail.com', nome: 'secre', perfil: 'admin', senhaHash: 'x', nuvem: true,
        modulos: auth.MODULOS.map(m => m.key), soImpressao: [] }
    ]);
    auth._definirSessao(auth._lerUsuarios()[1]);
    out.antesAdmin = auth.usuarioAtual().perfil === 'admin' && auth.podeAcessar('anestesia') === true;

    /* a nuvem responde: conta existe, mas NÃO pertence a nenhuma clínica */
    cloud.buscarPerfil = async () => ({ semVinculo: true, uid: 'u2', email: 'mpcanestesiologia@gmail.com', role: null, organization_id: null, ativo: true });
    const u = await auth.atualizarPapelDaNuvem();
    out.rebaixou = u && u.perfil === 'secretaria' && !u.modulos.includes('anestesia')
      && !u.modulos.includes('ajustes') && u.role === null;
    out.uiRestrita = auth.podeAcessar('anestesia') === false && auth.podeAcessar('ajustes') === false
      && auth.podeAcessar('pre') === true;   /* a secretária mantém o fluxo dela */

    /* login novo dessa conta também entra restrito */
    const esp = await auth._espelharUsuarioNuvem('mpcanestesiologia@gmail.com', 'senha', { semVinculo: true, uid: 'u2', role: null });
    out.loginRestrito = esp.perfil === 'secretaria' && !esp.modulos.includes('financeiro') === false;

    /* quando o gestor vincula como auxiliar, o papel do servidor manda */
    cloud.buscarPerfil = async () => ({ uid: 'u2', email: 'mpcanestesiologia@gmail.com', role: 'auxiliar', organization_id: 'org-1', ativo: true });
    const u2 = await auth.atualizarPapelDaNuvem();
    out.viraAuxiliar = u2 && u2.role === 'auxiliar' && u2.perfil === 'secretaria';

    /* o PROGRAMADOR nunca é rebaixado por falta de vínculo */
    auth._definirSessao(auth._lerUsuarios()[0]);
    cloud.buscarPerfil = async () => ({ semVinculo: true, uid: 'u1', email: 'mpcaliman@hotmail.com', role: null, organization_id: null, ativo: true });
    const dono = await auth.atualizarPapelDaNuvem();
    out.programadorIntacto = dono && dono.perfil === 'admin';

    auth._salvarUsuarios([]);
    return out;
  });
  assert(r.antesAdmin, 'o cenário parte do espelho antigo com acesso total');
  assert(r.rebaixou, 'conta sem clínica deveria cair para acesso restrito');
  assert(r.uiRestrita, 'a UI deveria bloquear ficha/ajustes e manter o fluxo da secretária');
  assert(r.loginRestrito, 'um login novo sem vínculo também deveria entrar restrito');
  assert(r.viraAuxiliar, 'vinculada como auxiliar, o papel do servidor deveria mandar');
  assert(r.programadorIntacto, 'o programador não pode ser rebaixado por falta de vínculo');
  await page.close();
});

/* 50) Contas diferentes (app × nuvem): detecta, bloqueia a sync e corrige em um toque */
await test('App em uma conta e nuvem em outra: sincronização travada + correção em um toque', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    cloud.estaConfigurado = () => true;
    cloud.estaLogado = () => true;

    /* app logado como mpcaliman, nuvem conectada como a conta da secretária */
    auth._salvarUsuarios([{ id: 'u_1', usuario: 'mpcaliman@hotmail.com', nome: 'dono', perfil: 'admin', senhaHash: 'x', nuvem: true }]);
    auth._definirSessao(auth._lerUsuarios()[0]);
    cloud.session = () => ({ user: { id: 'u2', email: 'mpcanestesiologia@gmail.com' } });

    const d = cloud.divergencia();
    out.detecta = !!d && d.app === 'mpcaliman@hotmail.com' && d.nuvem === 'mpcanestesiologia@gmail.com';

    /* nada sobe para a conta errada */
    let subiu = false;
    const fetchOrig = window.fetch;
    window.fetch = async (...a) => { subiu = true; return fetchOrig(...a); };
    await cloud.pushDoc('anestesia', { id: 'x1', paciente: { nome: 'Teste' } }, 'upsert');
    out.naoSobe = subiu === false;

    /* sincronizar para e chama a correção */
    let abriuModal = false;
    const resolverOrig = cloud.resolverDivergencia;
    cloud.resolverDivergencia = () => { abriuModal = true; };
    await cloud.sincronizar({ enviarTudo: true });
    out.syncTravada = abriuModal === true && subiu === false;
    cloud.resolverDivergencia = resolverOrig;
    window.fetch = fetchOrig;

    /* aviso visível com o botão de correção */
    cloud._renderAvisoDivergencia();
    const box = document.getElementById('cloud-divergencia');
    out.avisoVisivel = !!box && box.innerHTML.indexOf('Corrigir agora') >= 0
      && box.innerHTML.indexOf('mpcanestesiologia@gmail.com') >= 0;

    /* correção: reconecta a nuvem na conta do app */
    let deslogou = false, entrouCom = null;
    cloud.logout = () => { deslogou = true; };
    cloud.login = async (email) => { entrouCom = email; cloud.session = () => ({ user: { id: 'u1', email } }); return true; };
    cloud.autoSyncAoEntrar = () => {};
    cloud.resolverDivergencia();
    const inp = document.getElementById('div-senha');
    if (inp) inp.value = 'senha123';
    await cloud._reconectarComoApp();
    out.reconectou = deslogou && entrouCom === 'mpcaliman@hotmail.com';

    /* contas iguais → sem divergência e o aviso some */
    out.semDivergencia = cloud.divergencia() === null;
    cloud._renderAvisoDivergencia();
    out.avisoSumiu = !document.getElementById('cloud-divergencia');

    /* login pelo espelho local realinha a nuvem sozinho (causa raiz) */
    cloud.session = () => ({ user: { id: 'u2', email: 'mpcanestesiologia@gmail.com' } });
    entrouCom = null; deslogou = false;
    await auth._alinharNuvem('mpcaliman@hotmail.com', 'senha123');
    out.alinhaNoLogin = entrouCom === 'mpcaliman@hotmail.com';

    /* se não conseguir entrar, desconecta em vez de gravar na conta errada */
    cloud.session = () => ({ user: { id: 'u2', email: 'mpcanestesiologia@gmail.com' } });
    cloud.login = async () => false;
    deslogou = false;
    await auth._alinharNuvem('mpcaliman@hotmail.com', 'errada');
    out.desconectaSeFalhar = deslogou === true;

    /* login local antigo (sem e-mail) não conta como divergência */
    auth._salvarUsuarios([{ id: 'u_9', usuario: 'admin', nome: 'local', perfil: 'admin', senhaHash: 'x' }]);
    auth._definirSessao(auth._lerUsuarios()[0]);
    cloud.session = () => ({ user: { id: 'u2', email: 'qualquer@ex.com' } });
    out.ignoraLocal = cloud.divergencia() === null;

    auth._salvarUsuarios([]);
    return out;
  });
  assert(r.detecta, 'deveria detectar app e nuvem em contas diferentes');
  assert(r.naoSobe, 'nada pode subir para a nuvem enquanto as contas estiverem diferentes');
  assert(r.syncTravada, 'sincronizar deveria parar e abrir a correção');
  assert(r.avisoVisivel, 'o card da nuvem deveria mostrar o aviso com "Corrigir agora"');
  assert(r.reconectou, 'a correção deveria desconectar e entrar com a conta do app');
  assert(r.semDivergencia, 'com as contas iguais não há divergência');
  assert(r.avisoSumiu, 'resolvido o problema, o aviso deveria sumir');
  assert(r.alinhaNoLogin, 'entrar pelo espelho local deveria realinhar a nuvem com a conta do app');
  assert(r.desconectaSeFalhar, 'sem conseguir realinhar, a nuvem deveria ser desconectada');
  assert(r.ignoraLocal, 'login local sem e-mail não deveria virar alarme falso');
  await page.close();
});

/* 51) Pacientes repetidos: a nuvem identifica pelo nome — contagem justa + fusão */
await test('Pacientes duplicados: diagnóstico não acusa pendência falsa e a fusão junta os cadastros', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    store.setList('pacientes', []);
    store.setList('anestesia', []);

    const a = store.save('pacientes', { nome: 'Andrea Soares Santos', telefone: '27999990000' });
    const b = store.save('pacientes', { nome: 'ANDREA SOARES SANTOS', cpf: '12345678901', plano: 'Unimed' });
    const c = store.save('pacientes', { nome: 'Joao da Silva' });
    const ficha = store.save('anestesia', { paciente: { nome: 'Andrea Soares Santos' }, _paciente_id: b._id });

    out.tresCadastros = store.list('pacientes').length === 3;
    out.doisDistintos = pacientes.contarUnicos() === 2;         /* a nuvem verá 2 */
    out.achaGrupo = pacientes.duplicados().length === 1;

    const res = pacientes.mesclarDuplicados({ silent: true });
    out.fundiu = res && res.grupos === 1 && res.removidos === 1;

    const lst = store.list('pacientes');
    out.sobraramDois = lst.length === 2;
    const andrea = lst.find(p => /andrea/i.test(p.nome || ''));
    /* o cadastro que fica herda o que faltava no outro */
    out.herdouCampos = !!andrea && andrea.cpf === '12345678901' && andrea.plano === 'Unimed' && andrea.telefone === '27999990000';
    /* a ficha continua ligada a um cadastro que existe */
    const f2 = store.getById('anestesia', ficha._id);
    out.fichaReligada = !!f2 && f2._paciente_id === andrea._id && !!store.getById('pacientes', f2._paciente_id);
    /* nada some do histórico clínico */
    out.fichaIntacta = store.list('anestesia').length === 1;
    /* rodar de novo não faz nada */
    const res2 = pacientes.mesclarDuplicados({ silent: true });
    out.idempotente = res2 && res2.grupos === 0 && res2.removidos === 0;

    store.setList('pacientes', []); store.setList('anestesia', []);
    return out;
  });
  assert(r.tresCadastros, 'o cenário parte de 3 cadastros com 1 repetido');
  assert(r.doisDistintos, 'a contagem justa (como a nuvem vê) deveria ser 2');
  assert(r.achaGrupo, 'deveria achar exatamente 1 grupo de duplicados');
  assert(r.fundiu, 'a fusão deveria juntar 1 grupo removendo 1 cópia');
  assert(r.sobraramDois, 'deveriam sobrar 2 cadastros');
  assert(r.herdouCampos, 'o cadastro que fica deveria herdar os campos vazios da cópia');
  assert(r.fichaReligada, 'a ficha deveria passar a apontar para o cadastro que ficou');
  assert(r.fichaIntacta, 'nenhuma ficha pode sumir na fusão');
  assert(r.idempotente, 'rodar a fusão de novo não deveria mexer em nada');
  await page.close();
});

/* 52) Acesso personalizado pelo gestor vale em QUALQUER aparelho (nuvem) */
await test('Permissões personalizadas sobem para a nuvem e vencem o padrão do papel', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    cloud.estaConfigurado = () => true;
    cloud.estaLogado = () => true;
    cloud._garantirToken = async () => true;

    /* --- no aparelho do GESTOR: tira o Dashboard da secretária --- */
    let patch = null;
    const fetchOrig = window.fetch;
    window.fetch = async (url, opts) => {
      if (String(url).indexOf('organization_users') >= 0 && opts && opts.method === 'PATCH') {
        patch = { url: String(url), body: JSON.parse(opts.body) };
        return { ok: true, json: async () => ([]) };
      }
      return fetchOrig(url, opts);
    };
    auth._salvarUsuarios([
      { id: 'u_1', usuario: 'mpcaliman@hotmail.com', nome: 'gestor', perfil: 'admin', senhaHash: 'x', nuvem: true, role: 'gestor' },
      { id: 'u_2', usuario: 'secretaria@ex.com', nome: 'secre', perfil: 'secretaria', senhaHash: 'x', nuvem: true,
        role: 'auxiliar', uid: 'uid-2', organization_id: 'org-1',
        modulos: ['dashboard', 'pacientes', 'agenda'], soImpressao: [] }
    ]);
    const ok = await auth.salvarPermissoesNaNuvem('uid-2', 'org-1', { perfil: 'secretaria', modulos: ['pacientes', 'agenda'], soImpressao: ['pre'] });
    out.gravouNaNuvem = ok === true && !!patch
      && patch.url.indexOf('user_id=eq.uid-2') >= 0 && patch.url.indexOf('organization_id=eq.org-1') >= 0
      && patch.body.permissoes.modulos.join(',') === 'pacientes,agenda'
      && patch.body.permissoes.soImpressao.join(',') === 'pre';
    window.fetch = fetchOrig;

    /* --- no aparelho DELA: o login lê a personalização e o Dashboard some --- */
    const perfilNuvem = {
      uid: 'uid-2', email: 'secretaria@ex.com', role: 'auxiliar', organization_id: 'org-1', ativo: true,
      permissoes: { perfil: 'secretaria', modulos: ['pacientes', 'agenda'], soImpressao: ['pre'] }
    };
    auth._salvarUsuarios([]);
    const esp = await auth._espelharUsuarioNuvem('secretaria@ex.com', 'senha', perfilNuvem);
    out.loginRespeita = esp && !esp.modulos.includes('dashboard') && esp.modulos.includes('pacientes')
      && esp.soImpressao.includes('pre');
    auth._definirSessao(esp);
    out.uiBloqueia = auth.podeAcessar('dashboard') === false && auth.podeAcessar('pacientes') === true;

    /* o papel sozinho daria Dashboard — a personalização é que manda */
    out.papelDariaDashboard = auth._permsDoPapel('auxiliar').modulos.includes('dashboard');

    /* atualizar o papel na sessão também respeita a personalização */
    cloud.buscarPerfil = async () => perfilNuvem;
    const u2 = await auth.atualizarPapelDaNuvem();
    out.atualizarRespeita = u2 && !u2.modulos.includes('dashboard');

    /* sem personalização, volta a valer o padrão do papel */
    cloud.buscarPerfil = async () => ({ uid: 'uid-2', email: 'secretaria@ex.com', role: 'auxiliar', organization_id: 'org-1', ativo: true, permissoes: null });
    const u3 = await auth.atualizarPapelDaNuvem();
    out.semPersonalizacao = u3 && u3.modulos.includes('dashboard');

    auth._salvarUsuarios([]);
    return out;
  });
  assert(r.gravouNaNuvem, 'o gestor deveria gravar o acesso personalizado na nuvem');
  assert(r.papelDariaDashboard, 'o papel auxiliar sozinho daria acesso ao Dashboard');
  assert(r.loginRespeita, 'o login no aparelho dela deveria aplicar a personalização');
  assert(r.uiBloqueia, 'a UI deveria bloquear o Dashboard e manter Pacientes');
  assert(r.atualizarRespeita, 'atualizar o papel não pode devolver o Dashboard');
  assert(r.semPersonalizacao, 'sem personalização, o padrão do papel volta a valer');
  await page.close();
});

/* 53) Pré: o que a secretária pode preencher (edição parcial por seção) */
await test('Pré: secretária edita identificação, anamnese, sinais vitais/exames e pareceres — o resto é do médico', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    auth._salvarUsuarios([{
      id: 'u_s', usuario: 'secretaria@ex.com', nome: 'secre', perfil: 'secretaria', senhaHash: 'x',
      nuvem: true, role: 'auxiliar', modulos: auth._permsDoPapel('auxiliar').modulos.slice(), soImpressao: []
    }]);
    auth._definirSessao(auth._lerUsuarios()[0]);

    out.podeEditarPre = auth.podeEditar('pre') === true;
    out.temParcial = auth.edicaoParcialDe('pre') === '[data-sec-edit]';

    auth._aplicarLeitura('pre');
    const mod = document.getElementById('module-pre');
    out.modoParcial = mod.classList.contains('edicao-parcial') && !mod.classList.contains('somente-impressao');

    const liberada = (secId) => {
      const body = document.querySelector('#' + secId + ' .card-body');
      return !!body && body.classList.contains('campo-liberado');
    };
    out.ident = liberada('pre-sec-ident');
    out.anamnese = liberada('pre-sec-anamnese');
    out.exames = liberada('pre-sec-exames');
    out.pareceres = liberada('pre-sec-pareceres');
    /* risco e conclusão continuam travados */
    out.riscoTravado = !liberada('pre-sec-risco');
    out.conclusaoTravada = !liberada('pre-sec-conclusao');
    /* exame físico é ato médico, mesmo dentro da seção liberada */
    const ef = document.querySelector('#form-pre [name="exame_fisico"]');
    out.exameFisicoTravado = !!ef && !!ef.closest('.campo-travado');
    /* aviso na tela explica o que ela pode preencher */
    const banner = document.getElementById('pp-banner-pre');
    out.avisoCerto = !!banner && /identifica/i.test(banner.textContent) && /pareceres/i.test(banner.textContent);

    /* o médico não entra em modo parcial */
    auth._salvarUsuarios([{ id: 'u_m', usuario: 'medico@ex.com', nome: 'med', perfil: 'medico', senhaHash: 'x',
      nuvem: true, role: 'anestesiologista', modulos: auth._permsDoPapel('anestesiologista').modulos.slice(), soImpressao: [] }]);
    auth._definirSessao(auth._lerUsuarios()[0]);
    auth._aplicarLeitura('pre');
    out.medicoLivre = !document.getElementById('module-pre').classList.contains('edicao-parcial');

    auth._salvarUsuarios([]);
    return out;
  });
  assert(r.podeEditarPre, 'a secretária precisa poder editar a pré (modo parcial)');
  assert(r.temParcial, 'o papel auxiliar deveria ter edição parcial na pré');
  assert(r.modoParcial, 'o módulo deveria entrar em edição parcial, não em só-impressão');
  assert(r.ident, 'identificação deveria estar liberada');
  assert(r.anamnese, 'anamnese deveria estar liberada');
  assert(r.exames, 'sinais vitais e exames deveriam estar liberados');
  assert(r.pareceres, 'pareceres de outras clínicas deveriam estar liberados');
  assert(r.riscoTravado, 'classificação de risco continua sendo do anestesiologista');
  assert(r.conclusaoTravada, 'a conclusão continua sendo do anestesiologista');
  assert(r.exameFisicoTravado, 'o exame físico não pode ser liberado para a secretária');
  assert(r.avisoCerto, 'o aviso deveria listar as seções liberadas');
  assert(r.medicoLivre, 'o anestesiologista não entra em edição parcial');
  await page.close();
});

/* 54) A logomarca sai no PDF (orçamento, documentos e receituário) */
await test('Logomarca aparece no PDF do orçamento, nos documentos e no receituário', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    /* jsPDF falso: registra o que foi desenhado */
    const imagens = [];
    const docFake = {
      addImage: (src, fmt, x, y, w, h) => imagens.push({ src: String(src).slice(0, 30), fmt, x, y, w, h }),
      getImageProperties: () => ({ width: 900, height: 300 })
    };

    /* helper desenha e devolve y avançado */
    const y1 = printPreview._logoPDF(docFake, 20, 16, 62, 22);
    out.desenhou = imagens.length === 1 && imagens[0].src.indexOf('data:image') === 0;
    out.proporcao = imagens.length === 1 && Math.abs(imagens[0].w / imagens[0].h - 3) < 0.05;   /* 900x300 */
    out.respeitaLargura = imagens.length === 1 && imagens[0].w <= 62 && imagens[0].h <= 22;
    out.avancouY = y1 > 16;

    /* teto de altura obedecido mesmo com logo alta */
    imagens.length = 0;
    docFake.getImageProperties = () => ({ width: 300, height: 900 });
    printPreview._logoPDF(docFake, 20, 16, 62, 22);
    out.respeitaAltura = imagens.length === 1 && imagens[0].h <= 22;

    /* sem logo utilizável, não quebra nem avança */
    imagens.length = 0;
    const orig = LOGOS.horizontal;
    LOGOS.horizontal = '';
    const y2 = printPreview._logoPDF(docFake, 20, 16, 62, 22);
    out.semLogoSeguro = imagens.length === 0 && y2 === 16;
    LOGOS.horizontal = orig;

    /* o PDF do orçamento chama o helper */
    let chamou = 0;
    const logoOrig = printPreview._logoPDF;
    printPreview._logoPDF = (doc, x, y) => { chamou++; return y; };
    try {
      document.querySelector('#form-orcamento [name="paciente"]').value = 'Fulano de Tal';
      await orcamento.gerarPDF();
    } catch (e) { out.erroPDF = String(e && e.message); }
    out.orcamentoUsaLogo = chamou >= 1;
    printPreview._logoPDF = logoOrig;
    return out;
  });
  assert(r.desenhou, 'o helper deveria desenhar a logo no PDF');
  assert(r.proporcao, 'a logo deveria manter a proporção original');
  assert(r.respeitaLargura, 'a logo não pode ultrapassar a área reservada');
  assert(r.respeitaAltura, 'logo alta deveria ser limitada pela altura máxima');
  assert(r.avancouY, 'o cursor vertical deveria avançar depois da logo');
  assert(r.semLogoSeguro, 'sem logo configurada, o PDF segue normalmente');
  assert(r.orcamentoUsaLogo, 'o PDF do orçamento deveria desenhar a logomarca');
  await page.close();
});

/* 55) Ficha: tempo do procedimento = sala; ➕ abre linha da MESMA equipe */
await test('Ficha: procedimento começa na entrada e termina na saída de sala; ➕ é da mesma equipe', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    const f = document.getElementById('form-anestesia');
    const set = (n, v) => { const el = f.querySelector('[name="' + n + '"]'); if (el) { el.value = v; return true; } return false; };

    /* duração entre horários, inclusive virando o dia */
    out.dur = printPreview._durEntre('07:30', '09:05') === '1h 35min';
    out.durVirada = printPreview._durEntre('23:40', '00:20') === '0h 40min';
    out.durVazia = printPreview._durEntre('', '09:00') === '';

    set('paciente_nome', 'Teste Impressão');
    set('procedimento', 'Colecistectomia videolaparoscópica');
    set('cirurgiao', 'Dr. Fulano');
    set('hora_sala_entrada', '07:30');
    set('hora_inicio', '07:45');
    set('hora_cir_inicio', '08:00');
    set('hora_cir_fim', '08:50');
    set('hora_fim', '09:00');
    set('hora_sala_saida', '09:10');

    const html = printPreview._buildAnestesia();
    out.temEntrada = /Início \(entrada em sala\)/.test(html) && html.indexOf('07:30') >= 0;
    out.temSaida = /Término \(saída de sala\)/.test(html) && html.indexOf('09:10') >= 0;
    out.temDuracaoProc = /Duração do procedimento/.test(html) && html.indexOf('1h 40min') >= 0;
    out.temAnestesia = /Início da anestesia/.test(html) && /Fim da anestesia/.test(html);
    out.temCirurgia = /Início da cirurgia/.test(html) && /Fim da cirurgia/.test(html);

    /* ➕ do campo principal: linha enxuta, da mesma equipe */
    document.getElementById('cir-combo-body').innerHTML = '';
    const linha = anestesia.cirurgias.add({}, { mesmaEquipe: true });
    out.linhaCriada = !!linha && linha.classList.contains('cir-mesma-equipe');
    out.temCodigo = !!linha.querySelector('[name="cir_extra_proc[]"]') && !!linha.querySelector('[name="cir_extra_grau[]"]');
    /* os campos de outra equipe existem (o financeiro depende deles) mas ficam escondidos */
    const cir = linha.querySelector('[name="cir_extra_cir[]"]');
    out.cirurgiaoExiste = !!cir;
    out.cirurgiaoOculto = !!cir && !!cir.closest('.cir-extra-detalhe');
    out.avisoMesmaEquipe = /Mesma equipe/i.test(linha.textContent);

    /* dá para abrir os detalhes quando for outra equipe mesmo */
    anestesia.cirurgias.abrirDetalhes(linha.querySelector('.cir-abrir-detalhe'));
    out.abriuDetalhes = !linha.classList.contains('cir-mesma-equipe');

    /* linha vinda de registro salvo com cirurgião continua completa */
    document.getElementById('cir-combo-body').innerHTML = '';
    const l2 = anestesia.cirurgias.add({ procedimento: 'Hernioplastia', cirurgiao: 'Dr. Beltrano', grau: '70' }, { mesmaEquipe: true });
    out.comCirurgiaoCompleta = !l2.classList.contains('cir-mesma-equipe');

    /* na impressão, linha sem cirurgião sai como "mesma equipe" */
    document.getElementById('cir-combo-body').innerHTML = '';
    anestesia.cirurgias.add({ procedimento: 'Apendicectomia', grau: '50' }, { mesmaEquipe: true });
    const html2 = printPreview._buildAnestesia();
    out.imprimeMesmaEquipe = /mesma equipe/i.test(html2) && html2.indexOf('Dr. Fulano') >= 0 && html2.indexOf('50%') >= 0;

    /* campo CBHPM não deixa o navegador abrir a lista dele por cima */
    const inp = f.querySelector('[name="procedimento"]');
    const ac = inp.getAttribute('autocomplete') || '';
    out.semAutofill = ac !== 'on' && ac !== '' && !inp.hasAttribute('list');
    return out;
  });
  assert(r.dur && r.durVirada && r.durVazia, 'o cálculo de duração deveria cobrir virada de dia e campo vazio');
  assert(r.temEntrada, 'a impressão deveria mostrar a entrada em sala como início');
  assert(r.temSaida, 'a impressão deveria mostrar a saída de sala como término');
  assert(r.temDuracaoProc, 'a duração do procedimento deveria ser calculada pela sala (1h 40min)');
  assert(r.temAnestesia && r.temCirurgia, 'os tempos de anestesia e cirurgia continuam na impressão');
  assert(r.linhaCriada, 'o ➕ deveria criar uma linha marcada como mesma equipe');
  assert(r.temCodigo, 'a linha deveria ter procedimento e grau');
  assert(r.cirurgiaoExiste && r.cirurgiaoOculto, 'o campo cirurgião existe, mas fica recolhido');
  assert(r.avisoMesmaEquipe, 'a linha deveria avisar que é da mesma equipe');
  assert(r.abriuDetalhes, 'deveria dar para abrir os detalhes de outra equipe');
  assert(r.comCirurgiaoCompleta, 'linha restaurada com cirurgião deve vir completa');
  assert(r.imprimeMesmaEquipe, 'na impressão, a linha sem cirurgião sai com a equipe principal e o grau');
  assert(r.semAutofill, 'o campo CBHPM não pode aceitar a lista do navegador por cima');
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
