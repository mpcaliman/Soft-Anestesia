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

/* Filtro por trecho do nome: `node tests/smoke.mjs impressão` roda só o que
   casa. A suíte inteira leva minutos; consertar um teste sem poder rodá-lo
   isolado custa muito mais caro do que estas quatro linhas. */
const FILTRO = (process.argv[2] || '').toLowerCase();

async function test(name, fn) {
  if (FILTRO && name.toLowerCase().indexOf(FILTRO) < 0) return;
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
  /* NENHUM teste fala com a internet: salvar um registro dispara espelho na
     nuvem, e no CI essas chamadas ficavam pendentes até estourar o tempo do
     job. Cortadas na origem, falham na hora — que é o que o app espera de um
     aparelho offline. */
  await page.route('**://*.supabase.co/**', route => route.abort());
  await page.route('**://accounts.google.com/**', route => route.abort());
  await page.route('**://*.googleapis.com/**', route => route.abort());
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
    const all = JSON.parse(disco.get('medsys.v7.versions') || '{}');
    all['pre:velho'] = Array.from({ length: 6 }, (_, i) => ({ ts: 't' + i, snapshot: { nome: 'v' + i, foto: GORDO } }));
    disco.set('medsys.v7.versions', JSON.stringify(all));
    const antes = disco.get('medsys.v7.versions').length;
    armazenamento.compactarVersoes();
    const depoisAll = JSON.parse(disco.get('medsys.v7.versions'));
    out.compactou = depoisAll['pre:velho'].length === 3 &&
      depoisAll['pre:velho'].every(v => v.snapshot.foto !== GORDO) &&
      disco.get('medsys.v7.versions').length < antes;

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
    disco.set('medsys.v7.versions', JSON.stringify(all));
    armazenamento.autoManutencao();
    const depois = JSON.parse(disco.get('medsys.v7.versions'));
    out.limitou = depois['anestesia:legado'].length === 5;
    out.saneou = depois['anestesia:legado'].every(v => v.snapshot.assinatura_dataurl !== GORDO);
    out.flag = localStorage.getItem(armazenamento.FLAG_COMPACT) === '1';

    // idempotente: com a flag, uma nova versão gorda inserida à mão NÃO é tocada
    const all2 = JSON.parse(disco.get('medsys.v7.versions'));
    all2['anestesia:legado'].unshift({ ts: 'novo', snapshot: { foto: GORDO } });
    disco.set('medsys.v7.versions', JSON.stringify(all2));
    armazenamento.autoManutencao();
    const depois2 = JSON.parse(disco.get('medsys.v7.versions'));
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
    /* a conduta continua descrita — mudou o tempo verbal: o prontuário registra
       o que FOI feito ("insuflação interrompida"), não o que se deve fazer */
    out.condutaEmbolia = /Durant/.test(D['Embolia gasosa (CO₂)'] || '')
      && /insuflação interrompida/i.test(D['Embolia gasosa (CO₂)'] || '');
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
  assert(r.condutaEmbolia, 'a conduta da embolia gasosa continua registrada (insuflação interrompida, posição de Durant)');
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
    out.conjuntoTemAmbas = (ppp.match(/Paciente Conjunto/g) || []).length >= 2;
    /* ficha e SRPA são o mesmo ato: a SRPA continua na mesma página, sem
       quebra forçada — antes gastava uma folha por caso */
    out.semQuebraForcada = !ppp.includes('pp-quebra');
    /* capítulos: a SRPA vem DEPOIS da ficha completa, com capa de capítulo */
    out.capituloSrpa = ppp.includes('pp-capitulo') && ppp.includes('2ª parte — Recuperação pós-anestésica');
    out.fichaAntesDaSrpa = ppp.indexOf('pp-capitulo') > ppp.indexOf('RELATÓRIO') || ppp.indexOf('pp-capitulo') > 100;
    /* no PDF gerado (nuvem/backup) a SRPA também segue no fio, sem página nova
       só para separar — e o texto dela continua lá */
    const J = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
    const docPdf = printPreview._gerarDocDeTexto(J, pppEl);
    const nPag = docPdf.getNumberOfPages ? docPdf.getNumberOfPages() : docPdf.internal.getNumberOfPages();
    out.pdfSaiu = nPag >= 1;
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
  assert(r.conjuntoTemAmbas, 'o arquivo único deveria conter as duas fichas');
  assert(r.semQuebraForcada, 'ficha e SRPA são o mesmo ato — não se gasta uma folha para separar');
  assert(r.capituloSrpa, 'a SRPA deveria abrir como capítulo ("2ª parte — Recuperação pós-anestésica")');
  assert(r.pdfSaiu, 'o PDF do conjunto deveria ser gerado');
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
      /* descrições exatas da CBHPM: a importação acha o código e o porte, e é
         pelo porte que o sistema decide quem é o principal */
      procedimento: { descricao: 'Colecistectomia sem colangiografia', data: '2026-07-25',
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
    out.codigosImportados = rows.every(x => /^\d\.\d\d\./.test(x.querySelector('[name="fin_cod_codigo[]"]').value));

    /* código sem porte reconhecido não pode ser rebaixado por falta de dado */
    document.getElementById('fin-codigos-body').innerHTML = '';
    financeiro.codigos.add({ descricao: 'Sem porte', porte: '', grau: '100' });
    financeiro.codigos.add({ descricao: 'Com porte', porte: '5A', grau: '100' });
    financeiro.codigos.classificarGrau({ silent: true });
    out.semPorteIntacto = financeiro.codigos.coletar().map(c => c.grau).join('/') === '100/100';

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
  assert(r.grausImportados, 'o de maior porte entra 100% e o outro fica com 50% (mesma via)');
  assert(r.codigosImportados, 'a importação deveria achar o código CBHPM dos dois procedimentos');
  assert(r.semPorteIntacto, 'sem porte reconhecido, o grau não pode ser mexido por conta própria');
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
await test('Ajustes: cards do sistema viram grupos recolhíveis (o técnico em "Avançado") e a sincronização roda sozinha ao entrar', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    /* — grupos montados: cabeçalhos + cards movidos para dentro dos wrappers — */
    ajustesGrupos.montar();   /* idempotente (já montou no boot) */
    out.grupos = ['nuvem', 'equipe', 'modelos', 'avancado'].every(id =>
      document.getElementById('ajg-cab-' + id) && document.getElementById('ajg-' + id));
    out.cardsDentro = document.getElementById('ajg-nuvem').contains(document.getElementById('cloud-card'))
      && document.getElementById('ajg-nuvem').contains(document.getElementById('armazenamento-card'))
      && document.getElementById('ajg-equipe').contains(document.getElementById('equipe-nuvem-card'))
      && document.getElementById('ajg-modelos').contains(document.getElementById('logo-usuario-card'));
    /* o que é técnico saiu da frente: diagnóstico e migração só em "Avançado" */
    out.tecnicoEmAvancado = document.getElementById('ajg-avancado').contains(document.getElementById('clouddiag-card'))
      && document.getElementById('ajg-avancado').contains(document.getElementById('fase4-card'))
      && document.getElementById('ajg-cab-avancado').classList.contains('ajg-avancado');
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
  assert(r.grupos, 'os grupos (nuvem/equipe/modelos/avancado) deveriam existir em Ajustes');
  assert(r.cardsDentro, 'os cards do sistema deveriam estar DENTRO dos grupos');
  assert(r.tecnicoEmAvancado, 'diagnóstico e migração deveriam ficar no grupo "Avançado", fora do caminho do dia a dia');
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
    localStorage.setItem('medsys.v7.grafico_modo', 'tabela');
    configSync.checarMudancas();
    await new Promise(r => setTimeout(r, 120));
    const op = envios[envios.length - 1];
    out.subiu = !!op && op.modulo === 'config_sync' && op.doc_id === 'cfg'
      && op.dados.chaves['medsys.v7.grafico_modo'].v === 'tabela';

    /* 2) nuvem MAIS NOVA vence: valor remoto com carimbo no futuro é aplicado */
    const tFuturo = new Date(Date.now() + 60000).toISOString();
    window.fetch = async () => ({ ok: true, json: async () => ([{ dados: { chaves: {
      'medsys.v7.grafico_modo': { v: 'grafico', t: tFuturo },
      'medsys.v7.theme': { v: 'dark', t: tFuturo }
    } } }]) });
    const aplicadas = await configSync.puxarAplicar();
    out.aplicou = aplicadas === 2
      && localStorage.getItem('medsys.v7.grafico_modo') === 'grafico'
      && localStorage.getItem('medsys.v7.theme') === 'dark';

    /* 3) local MAIS NOVO vence e é reenviado para a nuvem */
    localStorage.setItem('medsys.v7.grafico_modo', 'tabela-nova');
    configSync.checarMudancas();
    const tPassado = new Date(Date.now() - 3600000).toISOString();
    window.fetch = async () => ({ ok: true, json: async () => ([{ dados: { chaves: {
      'medsys.v7.grafico_modo': { v: 'valor velho da nuvem', t: tPassado }
    } } }]) });
    const nEnvios = envios.length;
    await configSync.puxarAplicar();
    await new Promise(r => setTimeout(r, 120));
    out.localVence = localStorage.getItem('medsys.v7.grafico_modo') === 'tabela-nova'
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

    /* — checklist no formulário do financeiro: uma caixa por etapa do fluxo.
         Conta pela própria lista, senão incluir uma etapa nova (Cortesia)
         quebra o teste sem nada estar errado. — */
    pendencias.renderFinanceiro(finDepois);
    const boxFat = document.getElementById('fat-status-box');
    out.checklist = boxFat.style.display !== 'none'
      && boxFat.querySelectorAll('input[type="checkbox"]').length === pendencias.STATUS.length
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
  assert(r.checklist, 'o financeiro deveria mostrar o checklist com todas as etapas do fluxo');
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
await test('Auxiliar preenche a ficha inteira; finalizar continua sendo do médico', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    /* O pré-lançamento substituiu a trava campo a campo: ela prepara tudo e o
       médico confere depois. Travar campo agora só cria atrito. */
    auth.usuarioAtual = () => ({ id: 's1', nome: 'Sec', perfil: 'secretaria', role: 'auxiliar' });
    out.semTravaParcial = auth.edicaoParcialDe('pre') === null
      && auth.edicaoParcialDe('anestesia') === null;

    auth.podeEditar = () => true;
    auth.podeAcessar = () => true;
    auth._aplicarLeitura('pre');
    const mod = document.getElementById('module-pre');
    out.semClasseParcial = !mod.classList.contains('edicao-parcial');
    /* nenhum campo do formulário fica travado */
    /* a regra que travava os campos só vale sob a classe parcial, que saiu */
    out.camposLivres = !mod.classList.contains('edicao-parcial')
      && !mod.classList.contains('somente-impressao');
    /* mas Finalizar some para quem só pré-lança */
    const fin = Array.from(mod.querySelectorAll('.btn, button'))
      .filter(b => /\.finalizar/i.test(b.getAttribute('onclick') || ''));
    out.qtdFin = fin.length;
    out.finalizarEscondido = fin.length > 0 && fin.every(b => b.style.display === 'none');

    /* para o médico, nada muda */
    auth.usuarioAtual = () => ({ id: 'm1', nome: 'Dr.', perfil: 'admin', role: 'gestor' });
    auth._aplicarLeitura('pre');
    const fin2 = Array.from(mod.querySelectorAll('.btn, button'))
      .filter(b => /\.finalizar/i.test(b.getAttribute('onclick') || ''));
    out.medicoFinaliza = fin2.some(b => b.style.display !== 'none');
    return out;
  });
  assert(r.semTravaParcial, 'a edição parcial deixou de existir — o pré-lançamento ocupou o lugar dela');
  assert(r.semClasseParcial, 'o módulo não deveria mais entrar em modo parcial');
  assert(r.camposLivres, 'a auxiliar precisa poder preencher a ficha inteira');
  assert(r.finalizarEscondido, 'finalizar continua sendo ato do médico');
  assert(r.medicoFinaliza, 'para o médico, o finalizar continua disponível');
  await page.close();
});

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

    /* cabeçalho enxuto: logo + só o título centralizado */
    store.setList('cad_assinaturas', [{ _id: 'a1', nomeProfissional: 'Dr. Marcelo Caliman', crm: '1234', especialidade: 'Anestesiologia' }]);
    const htmlH = printPreview._buildAnestesia();
    out.temLogo = htmlH.indexOf('pp-logo') >= 0;
    out.temTitulo = htmlH.indexOf('FICHA DE ANESTESIA') >= 0;
    out.semProfNoTopo = htmlH.indexOf('pp-prof-nome') < 0 && htmlH.indexOf('pp-prof-reg') < 0;
    out.semMetaNoTopo = htmlH.indexOf('pp-doc-meta') < 0;
    /* mas o nome do paciente continua na identificação */
    out.nomeNaIdentificacao = htmlH.indexOf('Identificação do paciente') >= 0 && htmlH.indexOf('Teste Impressão') >= 0;
    /* a SRPA segue o mesmo padrão */
    const htmlS = printPreview._buildRecuperacao();
    out.srpaEnxuta = htmlS.indexOf('pp-prof-nome') < 0 && htmlS.indexOf('pp-doc-meta') < 0 && htmlS.indexOf('RECUPERAÇÃO PÓS-ANESTÉSICA') >= 0;
    /* outros documentos mantêm o timbre com nome e CRM */
    const htmlPre = printPreview._buildPre();
    out.preMantemTimbre = htmlPre.indexOf('Dr. Marcelo Caliman') >= 0;
    store.setList('cad_assinaturas', []);

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
  assert(r.temLogo && r.temTitulo, 'o topo deveria ter a logo e o título da ficha');
  assert(r.semProfNoTopo, 'nome e CRM não devem se repetir no topo da ficha');
  assert(r.semMetaNoTopo, 'o topo deveria ter apenas o título centralizado');
  assert(r.nomeNaIdentificacao, 'o nome do paciente continua na identificação');
  assert(r.srpaEnxuta, 'a SRPA deveria seguir o mesmo cabeçalho enxuto');
  assert(r.preMantemTimbre, 'os demais documentos mantêm o timbre com nome e CRM');
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

/* 56) CBHPM ampliável (ambulatoriais) + enfermaria no cadastro do paciente */
await test('CBHPM: procedimentos próprios entram na busca e no financeiro; paciente tem enfermaria', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    localStorage.removeItem(cbhpm.EXTRA_KEY); cbhpm._cache = null;

    /* a tabela oficial cobre os quatro capítulos da CBHPM 2022 */
    out.temAmbulatorial = ['1.', '2.', '3.', '4.'].every(p => cbhpm.tabela().some(c => String(c[0]).startsWith(p)));
    const totalAntes = cbhpm.tabela().length;

    /* importação em lote (código de convênio/pacote que a tabela não cobre),
       em formatos diferentes */
    const res = cbhpm.importarTexto(
      '9.01.01.01-2;Pacote negociado do convênio;;;\n' +
      '9.01.03.15-8\tAtendimento fora da tabela\t2A\t0\t\n' +
      '9.01.02.03-7 Código próprio da clínica\n' +
      'linha sem código nenhum\n'
    );
    out.importou = res.novos === 3 && res.ignorados === 1;
    out.cresceu = cbhpm.tabela().length === totalAntes + 3;

    /* busca por DESCRIÇÃO e por CÓDIGO */
    out.achaPorDescricao = cbhpm.buscar('pacote negociado').some(i => i.codigo === '9.01.01.01-2');
    out.achaPorCodigo = cbhpm.buscar('9.01.03').some(i => i.codigo === '9.01.03.15-8');
    out.achaPorCodigoParcial = cbhpm.buscar('9.01.02.03-7').some(i => i.descricao === 'Código próprio da clínica');
    /* separa código e descrição corretamente no formato "código espaço descrição" */
    const proprio = cbhpm.achar('9.01.02.03-7');
    out.parseCodigoEspaco = !!proprio && proprio[1] === 'Código próprio da clínica';

    /* o financeiro reconhece o código cadastrado (é o mesmo achar()) */
    out.financeiroAcha = !!cbhpm.achar('Pacote negociado do convênio') && cbhpm.achar('Pacote negociado do convênio')[0] === '9.01.01.01-2';

    /* não sobrescreve a tabela oficial embutida */
    const oficial = CBHPM_2022[0][0];
    const res2 = cbhpm.importarTexto(oficial + ';Descrição inventada;;;');
    out.protegeOficial = res2.ignorados === 1 && res2.novos === 0 && cbhpm.achar(oficial)[1] === CBHPM_2022[0][1];

    /* sobe junto das configurações (mesma nuvem dos ajustes) */
    out.vaiParaNuvem = !!clinicaSync.CHAVES[cbhpm.EXTRA_KEY];   /* agora é da clínica */

    /* a tela lista e remove */
    ajustesGrupos.abrirPara && ajustesGrupos.abrirPara('cbhpm-card');
    cbhpmUI.render();
    const lista = document.getElementById('cbhpm-lista');
    out.telaLista = !!lista && lista.textContent.indexOf('Pacote negociado do convênio') >= 0;
    const resumoTxt = (document.getElementById('cbhpm-resumo') || {}).textContent || '';
    out.telaResumo = resumoTxt.indexOf('3') >= 0 && resumoTxt.indexOf('CBHPM 2022') >= 0;

    /* ---- paciente: enfermaria ---- */
    const fp = document.getElementById('form-pacientes');
    const apt = fp.querySelector('[name="apartamento"]');
    const enf = fp.querySelector('[name="enfermaria"]');
    out.temEnfermaria = !!enf && !!apt;
    /* marcar um desmarca o outro */
    apt.checked = true; enf.checked = true; enf.dispatchEvent(new Event('change', { bubbles: true }));
    out.exclusivos = enf.checked && !apt.checked;

    store.setList('pacientes', []);
    store.save('pacientes', { nome: 'Paciente Enfermaria', enfermaria: '1' });
    store.save('pacientes', { nome: 'Paciente Apartamento', apartamento: '1' });
    out.acomEnf = anestesia.adicionais.acomodacaoDoPaciente('Paciente Enfermaria') === 'enfermaria';
    out.acomApt = anestesia.adicionais.acomodacaoDoPaciente('Paciente Apartamento') === 'apartamento';
    out.acomVazia = anestesia.adicionais.acomodacaoDoPaciente('Nao Cadastrado') === '';
    /* enfermaria NÃO vira adicional de faturamento */
    const f = document.getElementById('form-anestesia');
    f.querySelector('[name="paciente_nome"]').value = 'Paciente Enfermaria';
    out.enfSemAdicional = anestesia.adicionais._doCadastroPaciente().length === 0;
    f.querySelector('[name="paciente_nome"]').value = 'Paciente Apartamento';
    out.aptComAdicional = anestesia.adicionais._doCadastroPaciente().includes('apartamento');

    localStorage.removeItem(cbhpm.EXTRA_KEY); cbhpm._cache = null;
    store.setList('pacientes', []);
    return out;
  });
  assert(r.temAmbulatorial, 'a tabela oficial precisa cobrir os quatro capítulos da CBHPM');
  assert(r.importou && r.cresceu, 'a importação deveria aceitar os três formatos e ignorar lixo');
  assert(r.achaPorDescricao, 'deveria achar pelo texto da descrição');
  assert(r.achaPorCodigo && r.achaPorCodigoParcial, 'deveria achar pelo número do código');
  assert(r.parseCodigoEspaco, 'formato "código espaço descrição" deveria ser separado direito');
  assert(r.financeiroAcha, 'o financeiro deveria reconhecer o código cadastrado');
  assert(r.protegeOficial, 'a tabela oficial embutida não pode ser sobrescrita');
  assert(r.vaiParaNuvem, 'os procedimentos próprios devem subir para a clínica (todos os usuários)');
  assert(r.telaLista && r.telaResumo, 'a tela de ajustes deveria listar e contar');
  assert(r.temEnfermaria, 'o cadastro do paciente deveria ter enfermaria além de apartamento');
  assert(r.exclusivos, 'marcar enfermaria deveria desmarcar apartamento');
  assert(r.acomEnf && r.acomApt && r.acomVazia, 'a acomodação deveria vir do cadastro do paciente');
  assert(r.enfSemAdicional, 'enfermaria não gera adicional de faturamento');
  assert(r.aptComAdicional, 'apartamento continua gerando o adicional');
  await page.close();
});

/* 57) Pré → Termo: avançar ao finalizar e imprimir os dois num arquivo só */
await test('Pré finalizada oferece o Termo; pré + termo saem num arquivo único', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    store.setList('pre', []); store.setList('termo', []);

    /* ---- ao finalizar a pré, a janela oferece avançar/imprimir junto ---- */
    const docPre = store.save('pre', { nome: 'Maria das Dores', cirurgia: 'Colecistectomia', data: utils.hojeISO() });
    pre._perguntarTermo(docPre);
    const corpo = document.getElementById('modal-body');
    out.ofereceTermo = /Avançar para o Termo/i.test(corpo.textContent);
    out.ofereceConjunto = /Imprimir pré \+ termo juntos/i.test(corpo.textContent);
    out.ofereceSair = /Agora não/i.test(corpo.textContent);
    modal.close();

    /* se outra janela estiver aberta, espera a vez em vez de sumir */
    modal.open('Outra coisa', 'ocupado');
    pre._perguntarTermo(docPre);
    out.esperaAVez = document.getElementById('modal-title').textContent === 'Outra coisa';
    modal.close();

    /* ---- conjunto: pré no formulário + termo buscado pelo nome ---- */
    document.querySelector('#form-pre [name="nome"]').value = 'Maria das Dores';
    document.querySelector('#form-pre [name="cirurgia"]').value = 'Colecistectomia';
    store.save('termo', { nome: 'Maria das Dores', procedimento: 'Colecistectomia', data: utils.hojeISO() });
    document.querySelector('#form-termo [name="nome"]').value = '';

    printPreview.abrirPreTermo();
    const ppp = document.getElementById('ppp');
    out.abriu = document.getElementById('print-preview-overlay').classList.contains('show');
    out.temPre = ppp.innerHTML.indexOf('AVALIAÇÃO PRÉ-ANESTÉSICA') >= 0 || /pr[ée]-anest/i.test(ppp.innerHTML);
    out.temTermo = /TERMO/i.test(ppp.innerHTML);
    out.temQuebra = ppp.innerHTML.indexOf('pp-quebra') >= 0 && /2ª parte — Termo/.test(ppp.innerHTML);
    out.nomeArquivo = printPreview._gerarNomeArquivo().indexOf('Pre-Anestesica+Termo') >= 0;
    printPreview.fechar();

    /* só o termo cadastrado (sem pré) → imprime só o termo, sem quebrar */
    store.setList('pre', []);
    document.querySelector('#form-pre [name="nome"]').value = '';
    document.querySelector('#form-termo [name="nome"]').value = 'Maria das Dores';
    printPreview.abrirPreTermo();
    out.soTermo = /TERMO/i.test(ppp.innerHTML) && ppp.innerHTML.indexOf('pp-quebra') < 0;
    out.nomeSoTermo = printPreview._gerarNomeArquivo().indexOf('_Termo_') >= 0;
    printPreview.fechar();

    /* sem nome nenhum, avisa e não abre */
    document.querySelector('#form-termo [name="nome"]').value = '';
    document.getElementById('print-preview-overlay').classList.remove('show');
    printPreview.abrirPreTermo();
    out.semNomeNaoAbre = !document.getElementById('print-preview-overlay').classList.contains('show');

    /* o botão está nas duas barras de ação */
    out.botaoPre = !!document.querySelector('#module-pre [onclick="printPreview.abrirPreTermo()"]');
    out.botaoTermo = !!document.querySelector('#module-termo [onclick="printPreview.abrirPreTermo()"]');

    store.setList('pre', []); store.setList('termo', []);
    return out;
  });
  assert(r.ofereceTermo, 'ao finalizar a pré deveria oferecer avançar para o termo');
  assert(r.ofereceConjunto, 'a mesma janela deveria oferecer imprimir os dois juntos');
  assert(r.ofereceSair, 'deveria dar para dispensar');
  assert(r.esperaAVez, 'com outra janela aberta, o convite espera a vez');
  assert(r.abriu, 'a pré-visualização do conjunto deveria abrir');
  assert(r.temPre && r.temTermo, 'o conjunto deveria trazer a pré e o termo');
  assert(r.temQuebra, 'o termo deveria começar em página nova, com capa de capítulo');
  assert(r.nomeArquivo, 'o arquivo deveria se chamar Paciente_Pre-Anestesica+Termo_data');
  assert(r.soTermo && r.nomeSoTermo, 'sem pré, imprime só o termo e nomeia certo');
  assert(r.semNomeNaoAbre, 'sem paciente identificado, não abre');
  assert(r.botaoPre && r.botaoTermo, 'o botão deveria estar na pré e no termo');
  await page.close();
});

/* 58) Pré: data de realização dos exames (laboratoriais, ECG, ECO e outros) */
await test('Pré: datas dos exames são digitáveis, salvam e saem na impressão', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    store.setList('pre', []);
    const f = document.getElementById('form-pre');
    const campo = (n) => f.querySelector('[name="' + n + '"]');

    /* os quatro campos de data existem e são do tipo date */
    const nomes = ['lab_data', 'lab_ecg_data', 'lab_eco_data', 'exames_compl_data'];
    out.existem = nomes.every(n => { const el = campo(n); return !!el && el.type === 'date'; });
    /* também na consulta, que tem o mesmo bloco de exames */
    out.naConsulta = !!document.querySelector('#form-consulta [name="lab_data"]');

    campo('nome').value = 'Paciente Exames';
    campo('lab_hb').value = '13,2';
    campo('lab_data').value = '2026-07-15';
    campo('lab_ecg').value = 'Ritmo sinusal';
    campo('lab_ecg_data').value = '2026-07-10';
    campo('lab_eco').value = 'FEVE 65%';
    campo('lab_eco_data').value = '2026-06-02';
    campo('exames_compl').value = 'Rx de tórax normal';
    campo('exames_compl_data').value = '2026-07-12';

    /* salvam e voltam ao carregar */
    pre.salvar();
    const salvo = store.list('pre')[0];
    out.salvou = salvo.lab_data === '2026-07-15' && salvo.lab_ecg_data === '2026-07-10' &&
                 salvo.lab_eco_data === '2026-06-02' && salvo.exames_compl_data === '2026-07-12';
    utils.clearForm('form-pre');
    pre.carregar(salvo);
    out.recarregou = campo('lab_data').value === '2026-07-15' && campo('lab_eco_data').value === '2026-06-02';

    /* saem na impressão, junto do resultado */
    const html = printPreview._buildPre();
    out.imprimeLab = /Data dos exames laboratoriais/.test(html) && html.indexOf('15/07/2026') >= 0;
    out.imprimeEcg = html.indexOf('Ritmo sinusal') >= 0 && html.indexOf('realizado em 10/07/2026') >= 0;
    out.imprimeEco = html.indexOf('02/06/2026') >= 0;
    out.imprimeOutros = html.indexOf('12/07/2026') >= 0;

    /* helper: sem data mostra só o resultado; sem resultado mostra só a data */
    out.soTexto = printPreview._comData('FEVE 65%', '') === 'FEVE 65%';
    out.soData = printPreview._comData('', '2026-06-02') === '(realizado em 02/06/2026)';
    out.vazio = printPreview._comData('', '') === '';

    store.setList('pre', []);
    utils.clearForm('form-pre');
    return out;
  });
  assert(r.existem, 'a pré deveria ter data para laboratoriais, ECG, ECO e outros exames');
  assert(r.naConsulta, 'a consulta, que tem o mesmo bloco, também deveria ter a data');
  assert(r.salvou, 'as datas deveriam ser gravadas no registro');
  assert(r.recarregou, 'as datas deveriam voltar ao carregar o registro');
  assert(r.imprimeLab, 'a data dos laboratoriais deveria sair na impressão');
  assert(r.imprimeEcg, 'o ECG deveria sair com o resultado e a data');
  assert(r.imprimeEco && r.imprimeOutros, 'ECO e outros exames deveriam sair com a data');
  assert(r.soTexto && r.soData && r.vazio, 'o helper deveria lidar com resultado sem data e data sem resultado');
  await page.close();
});

/* 59) Ficha de anestesia aparece no Meu dia e no prontuário (não só a SRPA) */
await test('Dashboard e prontuário mostram a ficha de anestesia junto da SRPA', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    store.setList('anestesia', []); store.setList('recuperacao', []); store.setList('financeiro', []);
    const hoje = utils.hojeISO();
    const f = document.getElementById('form-anestesia');
    const set = (n, v) => { const el = f.querySelector('[name="' + n + '"]'); if (el) el.value = v; };
    set('paciente_nome', 'João Teste'); set('data_anestesia', hoje);
    set('procedimento', 'Colecistectomia'); set('cirurgiao', 'Dr. Fulano');
    set('hora_sala_entrada', '08:00'); set('hora_sala_saida', '09:30');
    anestesia.salvar({ finalizar: true });
    store.save('recuperacao', { nome: 'João Teste', data: hoje, procedimento: 'Colecistectomia', _finalizado: true });

    /* a ficha é gravada estruturada — é isso que quebrava as duas telas */
    const a = store.list('anestesia')[0];
    out.estruturada = !!(a.paciente && a.paciente.nome) && !a.paciente_nome && !a.data_anestesia;

    /* --- Meu dia: um caso só, com ficha E SRPA --- */
    const casos = meuDia.coletar();
    out.umCaso = casos.length === 1;
    out.temFicha = !!(casos[0] && casos[0].ficha);
    out.temSrpa = !!(casos[0] && casos[0].srpa);
    out.horaDaSala = casos[0] && casos[0].hora === '08:00';
    out.procedimentoTexto = casos[0] && casos[0].procedimento === 'Colecistectomia';
    meuDia.render();
    const lista = document.getElementById('meu-dia-lista').innerHTML;
    out.chipFicha = lista.indexOf('Ficha ✓') >= 0 && lista.indexOf('— ficha') < 0;
    out.chipSrpa = lista.indexOf('SRPA ✓') >= 0;

    /* ficha de OUTRO dia não entra no dia de hoje */
    store.save('anestesia', { paciente: { nome: 'Outro Paciente' }, procedimento: { data: '2020-01-02', descricao: 'X' } });
    out.filtraData = meuDia.coletar().length === 1;

    /* --- Prontuário: linha da ficha com data e procedimento certos --- */
    const html = historico._prontRender('João');
    out.prontTemFicha = html.indexOf('Ficha de Anestesia') >= 0;
    out.prontSemObjeto = html.indexOf('[object Object]') < 0;
    out.prontDetalhe = /Colecistectomia/.test(html) && /Dr\. Fulano/.test(html);
    out.prontData = historico._dataItem(a) === hoje;
    out.detalheFicha = historico._detalheItem('anestesia', a).indexOf('Colecistectomia') === 0;

    /* códigos combinados também entram no detalhe */
    const comExtras = { paciente: { nome: 'Z' }, procedimento: { data: hoje, descricao: 'Principal', cirurgias_extra: [{ procedimento: 'Extra 1' }] } };
    out.detalheExtras = historico._detalheItem('anestesia', comExtras).indexOf('Extra 1') >= 0;

    store.setList('anestesia', []); store.setList('recuperacao', []); store.setList('financeiro', []);
    return out;
  });
  assert(r.estruturada, 'o cenário parte da ficha salva no formato estruturado');
  assert(r.umCaso, 'ficha e SRPA do mesmo paciente deveriam formar UM caso');
  assert(r.temFicha, 'o caso deveria constar a ficha de anestesia');
  assert(r.temSrpa, 'e também a SRPA');
  assert(r.horaDaSala && r.procedimentoTexto, 'hora e procedimento deveriam vir da ficha');
  assert(r.chipFicha, 'o Meu dia deveria mostrar "Ficha ✓", não "— ficha"');
  assert(r.chipSrpa, 'e continuar mostrando a SRPA');
  assert(r.filtraData, 'ficha de outro dia não pode entrar no Meu dia de hoje');
  assert(r.prontTemFicha, 'o prontuário deveria listar a ficha de anestesia');
  assert(r.prontSemObjeto, 'o prontuário não pode mostrar "[object Object]"');
  assert(r.prontDetalhe, 'a linha deveria trazer procedimento e cirurgião');
  assert(r.prontData, 'a data da ficha deveria ser a do procedimento, não a da gravação');
  assert(r.detalheFicha, 'o detalhe começa pela descrição do procedimento');
  assert(r.detalheExtras, 'os códigos combinados também aparecem no detalhe');
  await page.close();
});

/* 60) O app atualiza ao voltar para a frente (celular ficava com dados velhos) */
await test('Voltar para o app baixa o que foi feito em outro aparelho (com intervalo mínimo)', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    cloud.estaConfigurado = () => true;
    cloud.estaLogado = () => true;
    cloud.divergencia = () => null;

    let pulls = 0;
    const original = cloud.autoSyncAoEntrar;
    cloud.autoSyncAoEntrar = () => { pulls++; cloud._ultimoPull = Date.now(); };

    /* primeira volta: puxa */
    cloud._ultimoPull = 0;
    out.puxouNaVolta = cloud.autoSyncAoVoltar() === true && pulls === 1;
    /* logo em seguida: NÃO repete (poupa dados no 4G) */
    out.naoRepete = cloud.autoSyncAoVoltar() === false && pulls === 1;
    /* forçando (reconexão, abertura do app): puxa mesmo assim */
    out.forcaFunciona = cloud.autoSyncAoVoltar({ forcar: true }) === true && pulls === 2;
    /* passado o intervalo, volta a puxar sozinho */
    cloud._ultimoPull = Date.now() - (cloud.INTERVALO_PULL + 1000);
    out.depoisDoIntervalo = cloud.autoSyncAoVoltar() === true && pulls === 3;

    /* trava de segurança: contas diferentes não puxam nada */
    cloud.divergencia = () => ({ app: 'a@x.com', nuvem: 'b@x.com' });
    out.divergenciaBloqueia = cloud.autoSyncAoVoltar({ forcar: true }) === false && pulls === 3;
    cloud.divergencia = () => null;
    /* deslogado também não */
    cloud.estaLogado = () => false;
    out.deslogadoNaoPuxa = cloud.autoSyncAoVoltar({ forcar: true }) === false && pulls === 3;
    cloud.estaLogado = () => true;
    cloud.autoSyncAoEntrar = original;

    /* o pull marca a hora, para o gatilho seguinte respeitar o intervalo */
    cloud._ultimoPull = 0;
    cloud.sincronizar = async () => {};
    cloud.autoSyncAoEntrar();
    out.marcaHora = cloud._ultimoPull > 0;

    /* a tela aberta é redesenhada depois do pull */
    state.currentModule = 'dashboard';
    let repintou = 0;
    const dOrig = dashboard.atualizar, mOrig = meuDia.render;
    dashboard.atualizar = () => { repintou++; };
    meuDia.render = () => { repintou++; };
    cloud._repintarTelaAtual();
    out.repintaDashboard = repintou >= 2;
    dashboard.atualizar = dOrig; meuDia.render = mOrig;

    /* e os gatilhos ficam ligados uma vez só */
    cloud._vigiandoRetorno = false;
    cloud.vigiarRetorno(); cloud.vigiarRetorno();
    out.vigiaUmaVez = cloud._vigiandoRetorno === true;
    return out;
  });
  assert(r.puxouNaVolta, 'ao voltar para o app, deveria baixar o que há de novo');
  assert(r.naoRepete, 'não deveria repetir o pull a cada troca de aba');
  assert(r.forcaFunciona, 'abertura do app e reconexão deveriam forçar o pull');
  assert(r.depoisDoIntervalo, 'passado o intervalo, volta a atualizar sozinho');
  assert(r.divergenciaBloqueia, 'com contas diferentes, nada é baixado');
  assert(r.deslogadoNaoPuxa, 'sem sessão na nuvem, nada é baixado');
  assert(r.marcaHora, 'o pull deveria marcar a hora para o próximo gatilho');
  assert(r.repintaDashboard, 'o Dashboard aberto deveria ser redesenhado após o pull');
  assert(r.vigiaUmaVez, 'os gatilhos deveriam ser registrados uma única vez');
  await page.close();
});

/* 61) Falha de rede não pode virar "conta sem clínica" (celular perdia a sync) */
await test('Consulta falha ≠ conta sem clínica: o aparelho lembra a clínica e não rebaixa ninguém', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    cloud.estaConfigurado = () => true;
    cloud.estaLogado = () => true;
    cloud._garantirToken = async () => true;
    cloud.session = () => ({ user: { id: 'uid-1', email: 'mpcaliman@hotmail.com' }, access_token: 't' });
    localStorage.removeItem(cloudRel.ORG_KEY);

    const fetchOrig = window.fetch;
    const respostaOk = (rows) => ({ ok: true, json: async () => rows });
    const respostaErro = () => ({ ok: false, status: 401, json: async () => ({}) });

    /* 1) servidor responde: a conta É gestora da clínica org-1 */
    window.fetch = async (url) => {
      const u = String(url);
      if (u.indexOf('/profiles?') >= 0) return respostaOk([{ id: 'uid-1', email: 'mpcaliman@hotmail.com', funcao: 'gestor', ativo: true }]);
      if (u.indexOf('organization_users?') >= 0) return respostaOk([{ organization_id: 'org-1', role: 'gestor', ativo: true }]);
      return fetchOrig(url);
    };
    const p1 = await cloud.buscarPerfil();
    out.achouOrg = p1 && p1.organization_id === 'org-1' && p1.role === 'gestor';
    auth._salvarUsuarios([{ id: 'u1', usuario: 'mpcaliman@hotmail.com', nome: 'dono', perfil: 'admin', senhaHash: 'x', nuvem: true }]);
    auth._definirSessao(auth._lerUsuarios()[0]);
    await auth.atualizarPapelDaNuvem();
    out.lembrouOrg = cloudRel._orgLembrada() === 'org-1';

    /* 2) agora a rede falha (4G ruim / token vencido) */
    window.fetch = async (url) => {
      const u = String(url);
      if (u.indexOf('/profiles?') >= 0 || u.indexOf('organization_users?') >= 0) return respostaErro();
      return fetchOrig(url);
    };
    const p2 = await cloud.buscarPerfil();
    out.falhaEhNull = p2 === null;                       /* não inventa "semVinculo" */
    /* a clínica continua conhecida → o aparelho segue sincronizando */
    out.orgSobrevive = (await cloudRel._orgAsync()) === 'org-1';
    /* e o usuário NÃO é rebaixado por causa da falha */
    const antes = JSON.stringify(auth.usuarioAtual().modulos);
    await auth.atualizarPapelDaNuvem();
    out.naoRebaixa = JSON.stringify(auth.usuarioAtual().modulos) === antes &&
                     auth.usuarioAtual().perfil === 'admin';

    /* 3) resposta clara de que não há clínica: aí sim esquece */
    window.fetch = async (url) => {
      const u = String(url);
      if (u.indexOf('/profiles?') >= 0 || u.indexOf('organization_users?') >= 0) return respostaOk([]);
      return fetchOrig(url);
    };
    const p3 = await cloud.buscarPerfil();
    out.semVinculoReal = !!(p3 && p3.semVinculo);
    await auth.atualizarPapelDaNuvem();   /* resposta clara → esquece a clínica */
    out.esqueceOrg = cloudRel._orgLembrada() === null && (await cloudRel._orgAsync()) === null;

    window.fetch = fetchOrig;
    auth._salvarUsuarios([]);
    localStorage.removeItem(cloudRel.ORG_KEY);
    return out;
  });
  assert(r.achouOrg, 'com o servidor respondendo, a clínica deveria ser encontrada');
  assert(r.lembrouOrg, 'a clínica deveria ficar lembrada no aparelho');
  assert(r.falhaEhNull, 'consulta que falha deve devolver "não sei", não "sem clínica"');
  assert(r.orgSobrevive, 'com a rede ruim, o aparelho continua sabendo a clínica');
  assert(r.naoRebaixa, 'falha de rede não pode rebaixar o acesso do usuário');
  assert(r.semVinculoReal, 'resposta vazia de verdade continua sendo "sem clínica"');
  assert(r.esqueceOrg, 'aí sim o aparelho esquece a clínica lembrada');
  await page.close();
});

/* 62) O que foi salvo sem clínica conhecida sobe sozinho na próxima entrada */
await test('Registros pendentes sobem para a clínica sozinhos (o que a secretária salvou aparece para o gestor)', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    store.setList('pacientes', []); store.setList('pre', []); store.setList('anestesia', []);
    cloud.estaConfigurado = () => true;
    cloud.estaLogado = () => true;
    cloud._garantirToken = async () => true;
    cloud.divergencia = () => null;
    cloudRel._lembrarOrg('org-1');

    /* salvos enquanto o aparelho não conhecia a clínica → sem _relUpdatedAt */
    store.save('pacientes', { nome: 'Paciente da Secretária' });
    store.save('pre', { nome: 'Paciente da Secretária', data: utils.hojeISO(), cirurgia: 'Hérnia' });
    /* este já está na clínica — não deve ser reenviado */
    const jaEnviado = store.save('pre', { nome: 'Outro', data: utils.hojeISO() });
    jaEnviado._relUpdatedAt = '2026-08-01T10:00:00Z';
    const lst = store.list('pre'); const ix = lst.findIndex(x => x._id === jaEnviado._id);
    lst[ix] = jaEnviado; store.setList('pre', lst);

    /* os stubs marcam _relUpdatedAt, como as funções reais fazem ao ter êxito */
    const marcar = (mod, item) => {
      const l = store.list(mod); const i = l.findIndex(x => x._id === item._id);
      if (i >= 0) { l[i]._relUpdatedAt = '2026-08-06T00:00:00Z'; store.setList(mod, l); }
    };
    const enviadosPac = [], enviadosReg = [];
    cloudRel.enviarPaciente = async (p) => { enviadosPac.push(p.nome); marcar('pacientes', p); return { ok: true }; };
    cloudRel.enviarRegistro = async (mod, it) => { enviadosReg.push(mod + ':' + (it.nome || '')); marcar(mod, it); return { ok: true }; };

    const res = await cloudRel.empurrarPendentes({ silent: true });
    out.enviouTudo = res && res.enviados === 2 && res.restantes === 0;
    out.mandouPaciente = enviadosPac.length === 1 && enviadosPac[0] === 'Paciente da Secretária';
    out.mandouPre = enviadosReg.length === 1 && enviadosReg[0] === 'pre:Paciente da Secretária';
    out.naoReenvia = enviadosReg.indexOf('pre:Outro') < 0;

    /* lote limitado: o resto fica para a próxima entrada (não trava o 4G).
       (grava direto na lista: store.save já dispara o espelho relacional) */
    const pend = store.list('anestesia');
    for (let i = 0; i < 5; i++) pend.push({ _id: 'anest-' + i, paciente: { nome: 'P' + i }, procedimento: { data: utils.hojeISO() } });
    store.setList('anestesia', pend);
    enviadosReg.length = 0;
    const res2 = await cloudRel.empurrarPendentes({ silent: true, limite: 3 });
    out.respeitaLimite = res2 && res2.enviados === 3 && res2.restantes === 2;

    /* sem clínica conhecida, não tenta nada */
    cloudRel._lembrarOrg(null);
    const sess = auth.usuarioAtual(); if (sess) { sess.organization_id = null; auth._definirSessao(sess); }
    cloud.buscarPerfil = async () => null;
    out.semOrgNaoTenta = (await cloudRel.empurrarPendentes({ silent: true })) === null;

    store.setList('pacientes', []); store.setList('pre', []); store.setList('anestesia', []);
    return out;
  });
  assert(r.enviouTudo, 'os pendentes deveriam subir para a clínica');
  assert(r.mandouPaciente, 'o paciente pendente deveria ser enviado');
  assert(r.mandouPre, 'a pré pendente deveria ser enviada');
  assert(r.naoReenvia, 'o que já está na clínica não deve ser reenviado');
  assert(r.respeitaLimite, 'o envio deveria ir em lotes, deixando o resto para depois');
  assert(r.semOrgNaoTenta, 'sem clínica conhecida, não tenta enviar nada');
  await page.close();
});

/* 63) Sessão da nuvem vencida é dita como tal (e não como "sem clínica") */
await test('Sessão vencida: o app diz a verdade e oferece entrar de novo', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    cloud.estaConfigurado = () => true;
    cloud.estaLogado = () => true;
    cloud._tokenFalhou = false;

    /* token velho + renovação que falha → sessão expirada */
    cloud.session = () => ({ user: { id: 'u1', email: 'mpcaliman@hotmail.com' }, expires_at: Date.now() - 60000, refresh_token: 'r' });
    cloud._renovarToken = async () => false;
    const ok = await cloud._garantirToken();
    out.tokenFalhou = ok === false && cloud.sessaoExpirada() === true;

    /* Equipe da nuvem: não acusa falta de vínculo — mostra o caminho certo */
    equipeNuvem.ehGestor = () => false;
    await equipeNuvem.render();
    const lista = document.getElementById('equipe-nuvem-lista').innerHTML;
    out.equipeFala = /sess[aã]o da nuvem expirou/i.test(lista) && lista.indexOf('cloud.reentrar()') >= 0;
    out.equipeNaoAcusa = lista.indexOf('não está vinculada') < 0;

    /* Diagnóstico: idem, com botão de entrar de novo */
    cloudRel._lembrarOrg(null);
    const sess = auth.usuarioAtual(); if (sess) { sess.organization_id = null; auth._definirSessao(sess); }
    cloud.buscarPerfil = async () => null;   /* consulta falhou */
    await cloudDiag.rodar();
    const diag = document.getElementById('clouddiag-tab').innerHTML;
    out.diagFala = /sess[aã]o da nuvem expirou/i.test(diag) && diag.indexOf('cloud.reentrar()') >= 0;
    out.diagMostraLocal = diag.indexOf('o que existe neste aparelho') >= 0 || diag.indexOf('Módulo') >= 0;

    /* a janela de reentrada já vem com o e-mail em uso */
    cloud.reentrar();
    out.modalComEmail = (document.getElementById('reent-email') || {}).value === 'mpcaliman@hotmail.com';
    modal.close();

    /* renovação voltando a funcionar → deixa de acusar sessão vencida */
    cloud._renovarToken = async () => true;
    const ok2 = await cloud._garantirToken();
    out.recupera = ok2 === true && cloud.sessaoExpirada() === false;

    /* conta REALMENTE sem clínica continua com a mensagem de vínculo */
    cloud.buscarPerfil = async () => ({ semVinculo: true, uid: 'u1', email: 'x@y.com', role: null, organization_id: null, ativo: true });
    await cloudDiag.rodar();
    const diag2 = document.getElementById('clouddiag-tab').innerHTML;
    out.semVinculoAindaFala = diag2.indexOf('não está vinculada a nenhuma clínica') >= 0;
    return out;
  });
  assert(r.tokenFalhou, 'renovação que falha deveria marcar a sessão como expirada');
  assert(r.equipeFala, 'Equipe da nuvem deveria falar em sessão expirada e oferecer entrar de novo');
  assert(r.equipeNaoAcusa, 'e NÃO deveria acusar falta de vínculo');
  assert(r.diagFala, 'o diagnóstico deveria dizer que a sessão expirou, com o botão de entrar');
  assert(r.diagMostraLocal, 'e continuar mostrando o que existe no aparelho');
  assert(r.modalComEmail, 'a janela de reentrada deveria vir com o e-mail em uso');
  assert(r.recupera, 'com a renovação funcionando, o estado de expirada some');
  assert(r.semVinculoAindaFala, 'conta realmente sem clínica continua com a mensagem de vínculo');
  await page.close();
});

/* 64) Corrigir nome errado numa ficha finalizada conserta de verdade */
await test('Correção de identificação vale no registro, no cadastro e nas outras fichas', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    store.setList('pacientes', []); store.setList('anestesia', []); store.setList('pre', []);

    /* cenário: nome digitado errado em toda parte */
    const errado = 'Maria dajida Machado', certo = 'Maria dajuda Machado';
    store.save('pacientes', { nome: errado, convenio: 'Unimed' });
    const outraFicha = store.save('pre', { nome: errado, data: utils.hojeISO(), cirurgia: 'Colecistectomia' });
    const ficha = store.save('anestesia', {
      paciente: { nome: errado, prontuario: '' },
      procedimento: { data: utils.hojeISO(), descricao: 'Colecistectomia' },
      pre_anestesico: { asa: 'II' },
      _finalizado: true
    });

    /* o usuário abre a ficha finalizada, corrige o nome E muda algo clínico */
    const novo = JSON.parse(JSON.stringify(ficha));
    novo.paciente.nome = certo;
    novo.paciente.prontuario = '12345';
    novo.pre_anestesico.asa = 'III';
    adendos.salvarComoCorrecao('anestesia', ficha, novo);

    const salvo = store.getById('anestesia', ficha._id);
    /* identificação: corrigida no próprio registro */
    out.nomeCorrigido = salvo.paciente.nome === certo;
    out.prontuarioCorrigido = salvo.paciente.prontuario === '12345';
    /* conteúdo clínico: original preservado */
    out.clinicoPreservado = salvo.pre_anestesico.asa === 'II';
    /* tudo fica registrado no adendo */
    const ad = (salvo._adendos || [])[0];
    out.adendoRegistra = !!ad && /CORREÇÃO/.test(ad.texto) &&
      ad.texto.indexOf(certo) >= 0 && /asa/i.test(ad.texto);
    out.adendoExplica = !!ad && /identifica/i.test(ad.texto);

    /* cadastro e as outras fichas passam a usar o nome certo */
    out.cadastroCorrigido = (store.list('pacientes')[0] || {}).nome === certo;
    out.outraFichaCorrigida = (store.getById('pre', outraFicha._id) || {}).nome === certo;
    /* e o paciente deixa de aparecer duplicado no histórico */
    out.umPacienteSo = store.list('pacientes').length === 1;

    /* correção direta pela tela de Pacientes */
    store.setList('pacientes', []); store.setList('pre', []);
    store.save('pacientes', { nome: 'Joao Errado' });
    store.save('pre', { nome: 'Joao Errado', data: utils.hojeISO() });
    const res = pacientes.renomear('Joao Errado', 'João Certo');
    out.renomeouTudo = res.cadastro === 1 && res.registros === 1 &&
      store.list('pacientes')[0].nome === 'João Certo' &&
      store.list('pre')[0].nome === 'João Certo';
    /* nome vazio ou igual não mexe em nada */
    const nada = pacientes.renomear('João Certo', '   ');
    out.ignoraVazio = nada.cadastro === 0 && nada.registros === 0 &&
      store.list('pacientes')[0].nome === 'João Certo';

    store.setList('pacientes', []); store.setList('anestesia', []); store.setList('pre', []);
    return out;
  });
  assert(r.nomeCorrigido, 'o nome deveria ser corrigido no próprio registro');
  assert(r.prontuarioCorrigido, 'os demais dados de identificação também');
  assert(r.clinicoPreservado, 'o conteúdo clínico original deve permanecer intacto');
  assert(r.adendoRegistra, 'o adendo deveria registrar a correção e a mudança clínica');
  assert(r.adendoExplica, 'o adendo deveria explicar que a identificação foi corrigida no registro');
  assert(r.cadastroCorrigido, 'o cadastro do paciente deveria passar a ter o nome certo');
  assert(r.outraFichaCorrigida, 'as outras fichas do paciente também');
  assert(r.umPacienteSo, 'a correção não pode criar um segundo paciente');
  assert(r.renomeouTudo, 'renomear pela tela de Pacientes deveria valer em tudo');
  assert(r.ignoraVazio, 'nome vazio não pode apagar o cadastro');
  await page.close();
});

/* 65) Impressão da pré: nome uma vez só, em uma linha; via aérea só a advertência */
await test('Pré impressa: sem nome duplicado, nome inteiro numa linha e via aérea resumida', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    store.setList('cad_assinaturas', [{ _id: 'a1', nomeProfissional: 'Dr. Marcelo Caliman', crm: '30801', especialidade: 'Anestesiologia' }]);
    const f = document.getElementById('form-pre');
    const set = (n, v) => { const el = f.querySelector('[name="' + n + '"]'); if (el) el.value = v; };
    const nome = 'POLLYANNA MAGALHAES DE SOUZA FERNANDES';
    set('nome', nome); set('data', utils.hojeISO()); set('nasc', '1979-08-13');
    set('sexo', 'Feminino'); set('cirurgia', 'Síndrome do túnel do carpo');
    set('via_aerea_resumo', 'Mallampati III. Preditores: Abertura bucal reduzida, Pescoço curto. ⚠ Via aérea potencialmente difícil — preparar plano e dispositivos (videolaringoscópio, bougie, plano B/C).');

    const html = printPreview._buildPre();

    /* o nome aparece UMA vez (na identificação), não no topo */
    const vezes = (html.match(new RegExp(nome, 'g')) || []).length;
    out.nomeUmaVez = vezes === 1;
    out.semMetaNoTopo = html.indexOf('pp-doc-meta') < 0 && html.indexOf('<strong>Paciente:</strong>') < 0;
    out.temIdentificacao = html.indexOf('Identificação') >= 0 && html.indexOf(nome) >= 0;
    /* nome ocupa a linha inteira (grid de 1 coluna) */
    out.nomeLinhaInteira = /pp-grid cols-1[\s\S]{0,200}POLLYANNA/.test(html);
    /* o timbre do profissional continua (a pré sai sozinha para o paciente) */
    out.mantemTimbre = html.indexOf('Dr. Marcelo Caliman') >= 0;

    /* via aérea desfavorável: só a advertência */
    out.soAdvertencia = html.indexOf('Possível via aérea difícil') >= 0 &&
      html.indexOf('preparar plano') < 0 &&
      html.indexOf('videolaringoscópio') < 0 &&
      html.indexOf('Mallampati III') < 0;

    /* helper isolado */
    out.favoravelMantem = printPreview._viaAereaImpressa('Mallampati I. Sem preditores maiores de via aérea difícil.')
      === 'Mallampati I. Sem preditores maiores de via aérea difícil.';
    out.tiraPreparo = printPreview._viaAereaImpressa('Mallampati II. Preditores: X — preparar plano e dispositivos (bougie).')
      .indexOf('preparar plano') < 0;
    out.vazioSegueVazio = printPreview._viaAereaImpressa('') === '';

    store.setList('cad_assinaturas', []);
    utils.clearForm('form-pre');
    return out;
  });
  assert(r.nomeUmaVez, 'o nome do paciente deveria aparecer uma única vez');
  assert(r.semMetaNoTopo, 'o topo não deveria repetir paciente e data');
  assert(r.temIdentificacao, 'o nome fica na seção de identificação');
  assert(r.nomeLinhaInteira, 'o nome deveria ocupar a linha inteira, sem quebrar');
  assert(r.mantemTimbre, 'a pré mantém o timbre com nome e CRM');
  assert(r.soAdvertencia, 'via aérea desfavorável deveria imprimir só a advertência');
  assert(r.favoravelMantem, 'via aérea favorável mantém o texto');
  assert(r.tiraPreparo, 'a parte de preparo/dispositivos sai da impressão');
  assert(r.vazioSegueVazio, 'campo vazio continua vazio');
  await page.close();
});

/* 66) Rascunho começado no celular aparece no computador */
await test('Rascunhos viajam entre aparelhos, juntando pelo mais recente', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    cloud.estaConfigurado = () => true;
    cloud.estaLogado = () => true;
    cloud._garantirToken = async () => true;
    cloud.divergencia = () => null;
    cloud.session = () => ({ user: { id: 'u1', email: 'mpcaliman@hotmail.com' }, access_token: 't' });

    /* nuvem de mentira: guarda o que sobe e devolve no pull */
    let naNuvem = [];
    const fetchOrig = window.fetch;
    window.fetch = async (url, opts) => {
      const u = String(url);
      if (u.indexOf('/documentos') < 0) return fetchOrig(url, opts);
      if (opts && opts.method === 'DELETE') {
        const m = u.match(/doc_id=eq\.([^&]+)/);
        if (m) naNuvem = naNuvem.filter(x => x.doc_id !== decodeURIComponent(m[1]));
        return { ok: true, json: async () => [] };
      }
      if (opts && opts.method === 'POST') {
        JSON.parse(opts.body).forEach(row => {
          naNuvem = naNuvem.filter(x => x.doc_id !== row.doc_id);
          naNuvem.push(row);
        });
        return { ok: true, json: async () => [] };
      }
      return { ok: true, json: async () => naNuvem.map(x => ({ doc_id: x.doc_id, dados: x.dados })) };
    };

    /* ---- "celular": um rascunho pela metade ---- */
    rascunhos.setList('anestesia', [
      { id: 'rasc_1', label: 'Maria', createdAt: '2026-08-07T10:00:00Z', updatedAt: '2026-08-07T10:00:00Z',
        dados: { paciente: { nome: 'Maria' }, procedimento: { descricao: 'Colecistectomia' } } }
    ]);
    const enviados = await rascunhosSync.enviar('anestesia');
    out.subiu = enviados === 1 && naNuvem.length === 1;

    /* ---- "computador": não tem nada, puxa e recebe ---- */
    rascunhos.setList('anestesia', []);
    const veio = await rascunhosSync.puxar('anestesia');
    const lista = rascunhos.list('anestesia');
    out.desceu = veio === 1 && lista.length === 1 && lista[0].dados.paciente.nome === 'Maria';

    /* o mais recente vence; o antigo não sobrescreve o novo */
    lista[0].updatedAt = '2026-08-07T12:00:00Z';
    lista[0].dados.procedimento.descricao = 'Colecistectomia videolaparoscópica';
    rascunhos.setList('anestesia', lista);
    await rascunhosSync.puxar('anestesia');   /* nuvem tem a versão das 10h */
    out.naoRegride = rascunhos.list('anestesia')[0].dados.procedimento.descricao === 'Colecistectomia videolaparoscópica';

    /* versão mais nova na nuvem entra no lugar */
    naNuvem = [{ doc_id: 'rasc_1', dados: { id: 'rasc_1', label: 'Maria', updatedAt: '2026-08-07T18:00:00Z',
      dados: { paciente: { nome: 'Maria' }, procedimento: { descricao: 'Versão do outro aparelho' } } } }];
    await rascunhosSync.puxar('anestesia');
    out.aceitaMaisNovo = rascunhos.list('anestesia')[0].dados.procedimento.descricao === 'Versão do outro aparelho';

    /* rascunho de outro aparelho não apaga o daqui */
    rascunhos.setList('anestesia', rascunhos.list('anestesia').concat([
      { id: 'rasc_2', label: 'Só daqui', updatedAt: '2026-08-07T19:00:00Z', dados: { paciente: { nome: 'João' } } }
    ]));
    await rascunhosSync.puxar('anestesia');
    out.preservaLocal = rascunhos.list('anestesia').length === 2;

    /* fechar apaga na nuvem também (senão o pull o ressuscitaria) */
    await rascunhosSync.apagar('anestesia', 'rasc_1');
    out.apagouNaNuvem = naNuvem.every(x => x.doc_id !== 'rasc_1');

    /* o botão da barra ABRE o rascunho que chegou (não basta trazer calado) */
    rascunhos.setList('anestesia', []);
    rascunhos.setAtivo('anestesia', null);
    naNuvem = [{ doc_id: 'rasc_9', dados: { id: 'rasc_9', label: 'Ana Vinda do Celular', updatedAt: '2026-08-07T20:00:00Z',
      dados: { paciente: { nome: 'Ana Vinda do Celular' }, procedimento: { descricao: 'Hernioplastia' } } } }];
    await rascunhos.buscarNaNuvem('anestesia');
    out.abriuNaTela = rascunhos.ativo('anestesia') === 'rasc_9';
    out.formPreenchido = (document.querySelector('#form-anestesia [name="paciente_nome"]') || {}).value === 'Ana Vinda do Celular';
    const barra = document.getElementById('rasc-tabs-anestesia');
    out.abaVisivel = !!barra && barra.textContent.indexOf('Ana Vinda do Celular') >= 0;

    /* contas diferentes travam o envio */
    cloud.divergencia = () => ({ app: 'a@x.com', nuvem: 'b@x.com' });
    out.divergenciaBloqueia = (await rascunhosSync.enviar('anestesia')) === 0;
    cloud.divergencia = () => null;

    window.fetch = fetchOrig;
    rascunhos.setList('anestesia', []);
    return out;
  });
  assert(r.subiu, 'o rascunho do celular deveria subir para a nuvem');
  assert(r.desceu, 'e descer no outro aparelho, com os dados preenchidos');
  assert(r.naoRegride, 'versão antiga da nuvem não pode sobrescrever a mais nova daqui');
  assert(r.aceitaMaisNovo, 'versão mais nova do outro aparelho deveria entrar');
  assert(r.preservaLocal, 'o rascunho só deste aparelho não pode sumir');
  assert(r.apagouNaNuvem, 'fechar o rascunho deveria apagá-lo na nuvem');
  assert(r.abaVisivel, 'a aba do rascunho trazido deveria aparecer na barra');
  assert(r.abriuNaTela, 'o rascunho trazido deveria ser ABERTO, não só listado');
  assert(r.formPreenchido, 'e o formulário deveria vir preenchido com os dados dele');
  assert(r.divergenciaBloqueia, 'com contas diferentes, nada sobe');
  await page.close();
});

/* 67) PDF ao finalizar: todos os módulos, regra da clínica e estado honesto */
await test('PDF automático ao finalizar cobre todos os módulos e pode ser exigido pela clínica', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    /* módulos que chamam o backup ao finalizar (o "em qualquer módulo") */
    const fonte = document.documentElement.innerHTML;
    out.modulosLigados = ['pre', 'consulta', 'recuperacao', 'termo', 'anestesia', 'prescricao']
      .every(m => fonte.indexOf("pdfBackup.autoAoFinalizar('" + m + "')") >= 0);

    /* preferência individual manda quando a clínica não exige */
    localStorage.setItem(orgSettings.CACHE_KEY, JSON.stringify({}));
    pdfBackup.salvarCfg({ autoFinalizar: false });
    out.desligadoIndividual = pdfBackup.autoLigado() === false;
    pdfBackup.salvarCfg({ autoFinalizar: true });
    out.ligadoIndividual = pdfBackup.autoLigado() === true;
    /* padrão de fábrica: ligado */
    localStorage.removeItem(pdfBackup.CFG_KEY);
    out.ligadoPorPadrao = pdfBackup.autoLigado() === true;

    /* regra da clínica vence a preferência individual */
    localStorage.setItem(orgSettings.CACHE_KEY, JSON.stringify({ pdf_auto_finalizar: true }));
    pdfBackup.salvarCfg({ autoFinalizar: false });
    out.clinicaObriga = pdfBackup.autoObrigatorioNaClinica() === true && pdfBackup.autoLigado() === true;

    /* sem destino ativo, avisa em vez de sair calado */
    cloud.estaConfigurado = () => false;
    cloud.estaLogado = () => false;
    pdfBackup.salvarCfg({ autoFinalizar: true, supabase: true, drive: false, driveClientId: '' });
    let avisou = '';
    const toastOrig = window.toast;
    window.toast = (m) => { avisou += String(m); };
    pdfBackup.autoAoFinalizar('pre');
    window.toast = toastOrig;
    out.avisaSemDestino = /nenhum destino/i.test(avisou);

    /* o card mostra o estado de verdade */
    pdfBackup.carregarUI();
    const est = document.getElementById('pdfbk-estado');
    out.cardAvisa = !!est && /sem destino ativo/i.test(est.textContent);
    /* com a nuvem ligada, mostra onde está guardando */
    cloud.estaConfigurado = () => true;
    cloud.estaLogado = () => true;
    pdfBackup.carregarUI();
    out.cardConfirma = /Supabase Storage/.test(document.getElementById('pdfbk-estado').textContent);
    /* e o gestor não consegue desligar no aparelho quando a clínica exige */
    out.travadoNaTela = document.getElementById('pdfbk-auto-finalizar').disabled === true;

    localStorage.setItem(orgSettings.CACHE_KEY, JSON.stringify({}));
    localStorage.removeItem(pdfBackup.CFG_KEY);
    return out;
  });
  assert(r.modulosLigados, 'todos os módulos deveriam disparar o PDF ao finalizar');
  assert(r.desligadoIndividual && r.ligadoIndividual, 'a preferência individual deveria valer sem regra da clínica');
  assert(r.ligadoPorPadrao, 'sem configuração nenhuma, o padrão é guardar o PDF');
  assert(r.clinicaObriga, 'a regra da clínica deveria vencer a preferência individual');
  assert(r.avisaSemDestino, 'sem destino ativo, o app deveria avisar em vez de não guardar calado');
  assert(r.cardAvisa, 'o card deveria mostrar que não há destino ativo');
  assert(r.cardConfirma, 'e mostrar onde está guardando quando há');
  assert(r.travadoNaTela, 'com a clínica exigindo, a caixa fica travada no aparelho');
  await page.close();
});

/* 68) Cadastros e modelos passam a ser DA CLÍNICA (valem para todos) */
await test('Cadastros da clínica sobem e descem por org_configs, valendo entre usuários', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    cloud.estaConfigurado = () => true;
    cloud.estaLogado = () => true;
    cloud._garantirToken = async () => true;
    cloud.divergencia = () => null;
    cloud.session = () => ({ user: { id: 'u1', email: 'medico@ex.com' }, access_token: 't' });
    cloudRel._lembrarOrg('org-1');
    localStorage.removeItem(clinicaSync.META_KEY);

    /* o que é da clínica saiu das preferências pessoais */
    out.separouCanais = configSync.CHAVES.indexOf('medsys.v5.cad.cirurgioes') < 0 &&
      configSync.CHAVES.indexOf('medsys.v7.logoCustom') < 0 &&
      !!clinicaSync.CHAVES['medsys.v5.cad.cirurgioes'] &&
      !!clinicaSync.CHAVES['medsys.v7.logoCustom'] &&
      configSync.CHAVES.indexOf('medsys.v7.theme') >= 0;   /* tema continua pessoal */

    /* nuvem de mentira para org_configs */
    let tabela = [];
    const fetchOrig = window.fetch;
    window.fetch = async (url, opts) => {
      const u = String(url);
      if (u.indexOf('/org_configs') < 0) return fetchOrig(url, opts);
      if (opts && opts.method === 'POST') {
        JSON.parse(opts.body).forEach(row => {
          tabela = tabela.filter(x => x.chave !== row.chave);
          tabela.push(row);
        });
        return { ok: true, json: async () => [] };
      }
      return { ok: true, json: async () => tabela.map(x => ({ chave: x.chave, dados: x.dados, updated_at: x.updated_at })) };
    };

    /* ---- aparelho do MÉDICO cadastra um cirurgião ---- */
    store.setList('cad_cirurgioes', [{ _id: 'c1', nome: 'Dr. Hugo Serrano', crm: '123' }]);
    const enviadas = await clinicaSync.enviar();
    out.subiu = enviadas >= 1 && tabela.some(x => x.chave === 'cad_cirurgioes');
    /* nada mudou → não reenvia (compara por hash) */
    out.naoReenvia = (await clinicaSync.enviar()) === 0;

    /* ---- aparelho da SECRETÁRIA: lista vazia, recebe o cadastro ---- */
    store.setList('cad_cirurgioes', []);
    localStorage.removeItem(clinicaSync.META_KEY);
    const baixadas = await clinicaSync.puxarAplicar({ silent: true });
    out.desceu = baixadas >= 1 && (store.list('cad_cirurgioes')[0] || {}).nome === 'Dr. Hugo Serrano';

    /* versão já vista não é reaplicada por cima do que foi editado aqui */
    store.setList('cad_cirurgioes', [{ _id: 'c1', nome: 'Dr. Hugo Serrano Alvarado', crm: '123' }]);
    await clinicaSync.puxarAplicar({ silent: true });
    out.naoAtropela = (store.list('cad_cirurgioes')[0] || {}).nome === 'Dr. Hugo Serrano Alvarado';

    /* versão mais nova da clínica entra */
    tabela = [{ chave: 'cad_cirurgioes', dados: { valor: [{ _id: 'c1', nome: 'Dr. Hugo (atualizado na clínica)' }] },
      updated_at: '2030-01-01T00:00:00.000Z' }];
    await clinicaSync.puxarAplicar({ silent: true });
    out.aceitaMaisNovo = (store.list('cad_cirurgioes')[0] || {}).nome === 'Dr. Hugo (atualizado na clínica)';

    /* sem clínica conhecida, não tenta nada */
    cloudRel._lembrarOrg(null);
    const sess = auth.usuarioAtual(); if (sess) { sess.organization_id = null; auth._definirSessao(sess); }
    cloud.buscarPerfil = async () => null;
    out.semOrgNaoTenta = (await clinicaSync.enviar()) === 0;

    window.fetch = fetchOrig;
    store.setList('cad_cirurgioes', []);
    localStorage.removeItem(clinicaSync.META_KEY);
    return out;
  });
  assert(r.separouCanais, 'cadastros/logo viram da clínica; tema segue pessoal');
  assert(r.subiu, 'o cadastro feito num aparelho deveria subir para a clínica');
  assert(r.naoReenvia, 'sem mudança, não deveria reenviar');
  assert(r.desceu, 'outro usuário deveria receber o cadastro');
  assert(r.naoAtropela, 'versão já vista não pode sobrescrever a edição local');
  assert(r.aceitaMaisNovo, 'versão mais nova da clínica deveria entrar');
  assert(r.semOrgNaoTenta, 'sem clínica conhecida, não envia nada');
  await page.close();
});

/* 69) Acesso da secretária conferido e editado pelo médico DE QUALQUER APARELHO.
   Antes só dava para mexer em "Usuários e segurança" — lista local: no
   computador novo do médico a secretária nem aparecia. */
await test('Equipe da nuvem mostra e edita o acesso de cada pessoa (vale em todos os aparelhos)', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    cloud.estaConfigurado = () => true;
    cloud.estaLogado = () => true;
    cloud._garantirToken = async () => true;
    cloud.config = () => ({ url: 'https://x.supabase.co', key: 'k' });
    cloud._headers = () => ({});
    cloudRel._orgAsync = async () => 'org-1';
    auth.usuarioAtual = () => ({ uid: 'uid-medico', role: 'gestor' });

    /* Sem personalização: a tela mostra o padrão do papel */
    const semPerso = { uid: 'uid-sec', role: 'auxiliar', ativo: true, nome: 'Secretária', email: 's@x.com', permissoes: null };
    const p1 = equipeNuvem._permsDe(semPerso);
    out.padraoDoPapel = p1.propria === false && p1.modulos.length > 0
      && /padrão do papel/.test(equipeNuvem._resumoAcesso(semPerso));

    /* Com personalização: é ELA que vale, e a tela diz isso */
    const comPerso = Object.assign({}, semPerso, { permissoes: { perfil: 'secretaria', modulos: ['pacientes', 'agenda', 'pre'], soImpressao: ['pre'] } });
    const p2 = equipeNuvem._permsDe(comPerso);
    out.personalizado = p2.propria === true && p2.modulos.join(',') === 'pacientes,agenda,pre'
      && p2.soImpressao.join(',') === 'pre'
      && /personalizado/.test(equipeNuvem._resumoAcesso(comPerso));

    /* O modal abre com a grade já marcada pelo que está na nuvem */
    equipeNuvem._ultimaLista = [comPerso];
    equipeNuvem.editarAcesso('uid-sec');
    const sels = Array.from(document.querySelectorAll('#modal-body select[name="perm-mod"]'));
    const val = (m) => (sels.find(s => s.dataset.mod === m) || {}).value;
    out.gradeMarcada = sels.length > 0 && val('pacientes') === 'edit' && val('pre') === 'print' && val('dashboard') === 'nenhum';

    /* Salvar grava NA NUVEM (organization_users.permissoes), não só aqui */
    let corpo = null, alvo = '';
    const fetchOrig = window.fetch;
    window.fetch = async (url, opts) => {
      alvo = String(url);
      try { corpo = JSON.parse(opts.body); } catch (e) {}
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const sel = sels.find(s => s.dataset.mod === 'financeiro'); if (sel) sel.value = 'edit';
    await equipeNuvem.salvarAcesso('uid-sec');
    window.fetch = fetchOrig;
    out.gravouNaNuvem = /organization_users/.test(alvo) && /uid-sec/.test(alvo) && /org-1/.test(alvo)
      && !!corpo && Array.isArray(corpo.permissoes.modulos)
      && corpo.permissoes.modulos.includes('financeiro')
      && corpo.permissoes.soImpressao.includes('pre');
    return out;
  });
  assert(r.padraoDoPapel, 'sem personalização, a equipe deveria mostrar o padrão do papel');
  assert(r.personalizado, 'com personalização na nuvem, é ela que vale e a tela deveria dizer');
  assert(r.gradeMarcada, 'o modal deveria abrir com a grade marcada pelo que está na nuvem');
  assert(r.gravouNaNuvem, 'salvar deveria gravar em organization_users.permissoes da clínica');
  await page.close();
});

/* 70) Atualizar a nuvem tem que estar no MENU: quem não acessa Ajustes (a
   secretária) ficava sem nenhum caminho para sincronizar o aparelho dela. */
await test('Botão de atualizar a nuvem fica no menu e sobrevive às permissões (secretária sem Ajustes)', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    const btn = document.getElementById('sidebar-nuvem-btn');
    out.existe = !!btn;
    /* fora de #sidebar-nav de propósito — é o que impede a regra de permissão
       de esconder junto com os módulos */
    out.foraDoNav = !!btn && !document.getElementById('sidebar-nav').contains(btn);

    /* secretária: sem Ajustes. O item de menu some; o botão da nuvem fica. */
    auth.podeAcessar = (m) => m !== 'ajustes';
    auth.usuarioAtual = () => ({ id: 'u1', nome: 'Secretária', perfil: 'secretaria' });
    auth._aplicarPermissoesUI();
    const itemAjustes = document.querySelector('#sidebar-nav .nav-item[data-module="ajustes"]');
    out.ajustesEscondido = itemAjustes.style.display === 'none';
    out.botaoContinua = btn.style.display !== 'none' && !btn.closest('[style*="display: none"]');

    /* a linha do botão diz a verdade em cada estado */
    cloud.estaConfigurado = () => false;
    out.semNuvem = nuvemEstado.situacao().estado === 'semNuvem';
    cloud.estaConfigurado = () => true;
    cloud.estaLogado = () => true;
    cloud.sessaoExpirada = () => false;
    cloud.divergencia = () => null;
    cloud._fila = () => [1, 2, 3];
    const sPend = nuvemEstado.situacao();
    nuvemEstado.renderMenu();
    out.pendente = sPend.estado === 'pendente'
      && /3 itens aguardando/.test(document.getElementById('sidebar-nuvem-msg').textContent)
      && btn.classList.contains('sn-alerta');
    cloud._fila = () => [];
    localStorage.setItem('medsys.v7.cloud.ultimo_sync', new Date().toISOString());
    nuvemEstado.renderMenu();
    out.emDia = nuvemEstado.situacao().estado === 'ok'
      && /em dia/.test(document.getElementById('sidebar-nuvem-msg').textContent)
      && !btn.classList.contains('sn-alerta');

    /* aparelho sem nuvem: o toque tem que LEVAR ao login, não morrer num aviso */
    cloud.estaLogado = () => false;
    cloud.session = () => null;
    await nuvemEstado.atualizarTudo();
    out.levaAoLogin = document.getElementById('modal-backdrop').classList.contains('show')
      && !!document.getElementById('reent-senha')
      && /ainda não está conectado/.test(document.getElementById('modal-body').textContent);
    modal.close();
    return out;
  });
  assert(r.existe && r.foraDoNav, 'o botão da nuvem deveria existir no menu, fora da lista de módulos');
  assert(r.ajustesEscondido && r.botaoContinua, 'sem acesso a Ajustes, o botão da nuvem tem que continuar visível');
  assert(r.semNuvem, 'aparelho sem nuvem deveria ser reportado como tal');
  assert(r.pendente, 'com fila, o botão deveria dizer quantos itens faltam e destacar');
  assert(r.emDia, 'sem fila, o botão deveria dizer que está em dia, sem destaque');
  assert(r.levaAoLogin, 'tocar sem nuvem deveria abrir o login, não só avisar');
  await page.close();
});

/* 71) Finalizar com registro do mesmo paciente/dia: substituir ou gravar nova.
   Era assim que apareciam 4 "Ficha de anestesia" do mesmo dia no prontuário. */
await test('Ao finalizar, registro repetido do mesmo paciente e dia pergunta: substituir ou gravar como nova', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    ['pre', 'anestesia', 'recuperacao'].forEach(m => store.setList(m, []));

    /* Um registro já finalizado da Maria, hoje */
    const hoje = '2026-08-07';
    const antigo = store.save('pre', { paciente_nome: 'Maria da Silva', data_avaliacao: hoje, _finalizado: true, obs: 'primeira' });

    /* Mesmo paciente + mesmo dia → acha; outro dia ou outro nome → não acha */
    out.acha = duplicados.achar('pre', { paciente_nome: 'MARIA DA SILVA', data_avaliacao: hoje }).length === 1;
    out.diaDiferente = duplicados.achar('pre', { paciente_nome: 'Maria da Silva', data_avaliacao: '2026-08-06' }).length === 0;
    out.outroPaciente = duplicados.achar('pre', { paciente_nome: 'João Souza', data_avaliacao: hoje }).length === 0;
    /* o próprio registro sendo re-salvo não conta como duplicado */
    out.naoSeAcusa = duplicados.achar('pre', { _id: antigo._id, paciente_nome: 'Maria da Silva', data_avaliacao: hoje }).length === 0;
    /* sem nome ou sem data não dá para afirmar nada — não incomoda */
    out.semDadosNaoPergunta = duplicados.achar('pre', { paciente_nome: '', data_avaliacao: hoje }).length === 0;

    /* A pergunta aparece e traz as duas saídas */
    let seguiu = null;
    const abriu = duplicados.perguntar('pre', { paciente_nome: 'Maria da Silva', data_avaliacao: hoje }, (modo) => { seguiu = modo; });
    const txt = document.getElementById('modal-body').textContent;
    out.perguntou = abriu === true
      && document.getElementById('modal-backdrop').classList.contains('show')
      && /Maria da Silva/.test(txt)
      && /07\/08\/2026/.test(txt);
    const rodape = document.getElementById('modal-footer').textContent;
    out.duasSaidas = /Substituir/.test(rodape) && /Gravar como nova/.test(rodape);

    /* GRAVAR COMO NOVA: os dois convivem */
    duplicados._escolher('nova');
    out.seguiuNova = seguiu === 'nova' && duplicados._pendente === null;
    store.save('pre', { paciente_nome: 'Maria da Silva', data_avaliacao: hoje, _finalizado: true, obs: 'segunda' });
    out.duasFicam = store.list('pre').length === 2;

    /* SUBSTITUIR: grava a nova e manda as anteriores para a Lixeira */
    localStorage.removeItem(lixeira.KEY);
    duplicados.perguntar('pre', { paciente_nome: 'Maria da Silva', data_avaliacao: hoje }, () => {});
    duplicados._escolher('substituir');
    out.marcouPendente = !!duplicados._pendente && duplicados._pendente.ids.length === 2;
    const nova = store.save('pre', { paciente_nome: 'Maria da Silva', data_avaliacao: hoje, _finalizado: true, obs: 'terceira' });
    const restantes = store.list('pre');
    out.sobrouSoUma = restantes.length === 1 && restantes[0]._id === nova._id && restantes[0].obs === 'terceira';
    out.foramParaLixeira = lixeira._ler().filter(e => e.mod === 'pre').length === 2;
    out.limpou = duplicados._pendente === null;

    /* Vale para a ficha de anestesia, que guarda a data dentro de procedimento */
    const f1 = store.save('anestesia', { paciente: { nome: 'Ana Lima' }, procedimento: { data: hoje, nome: 'Mastopexia' }, _finalizado: true });
    out.fichaAcha = duplicados.achar('anestesia', { paciente: { nome: 'Ana Lima' }, procedimento: { data: hoje } }).length === 1
      && duplicados.achar('anestesia', { _id: f1._id, paciente: { nome: 'Ana Lima' }, procedimento: { data: hoje } }).length === 0;

    ['pre', 'anestesia', 'recuperacao'].forEach(m => store.setList(m, []));
    localStorage.removeItem(lixeira.KEY);
    return out;
  });
  assert(r.acha, 'mesmo paciente e mesmo dia deveria ser detectado (ignorando maiúsculas)');
  assert(r.diaDiferente && r.outroPaciente, 'dia diferente ou outro paciente não é duplicidade');
  assert(r.naoSeAcusa, 'o próprio registro sendo re-salvo não pode se acusar de duplicado');
  assert(r.semDadosNaoPergunta, 'sem nome ou sem data, não deveria perguntar nada');
  assert(r.perguntou, 'a pergunta deveria abrir dizendo o paciente e a data');
  assert(r.duasSaidas, 'a pergunta deveria oferecer substituir E gravar como nova');
  assert(r.seguiuNova && r.duasFicam, '"gravar como nova" deveria deixar os dois registros');
  assert(r.marcouPendente, '"substituir" deveria marcar os anteriores para saírem');
  assert(r.sobrouSoUma, 'depois de substituir deveria ficar só o registro mais atual');
  assert(r.foramParaLixeira, 'os anteriores têm que ir para a Lixeira, não sumir');
  assert(r.limpou, 'a marcação não pode sobrar e apagar registros da próxima gravação');
  assert(r.fichaAcha, 'a ficha de anestesia guarda a data em procedimento.data e também deveria ser coberta');
  await page.close();
});

/* 72) Menu no celular: a barra de baixo tapava o fim da lista (Sair, nuvem) */
await test('Com o menu aberto, a barra de baixo sai da frente e o fim da lista fica alcançável', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    document.body.classList.remove('menu-aberto');
    ui.toggleSidebar();
    out.abriu = document.getElementById('sidebar').classList.contains('open')
      && document.body.classList.contains('menu-aberto');
    ui.toggleSidebar();
    out.fechou = !document.getElementById('sidebar').classList.contains('open')
      && !document.body.classList.contains('menu-aberto');
    /* a regra de CSS que tira a barra e a folga no fim do menu existem */
    const css = Array.from(document.styleSheets)
      .flatMap(s => { try { return Array.from(s.cssRules); } catch (e) { return []; } })
      .map(r => r.cssText).join('\n');
    out.regraBarra = /body\.menu-aberto\s+\.bottom-nav/.test(css);
    out.regraFolga = /\.sidebar\s*\{[^}]*padding-bottom:\s*calc\(env\(safe-area-inset-bottom/.test(css);
    return out;
  });
  assert(r.abriu, 'abrir o menu deveria marcar o body, para a barra de baixo poder sair');
  assert(r.fechou, 'fechar o menu deveria devolver a barra de baixo');
  assert(r.regraBarra, 'deveria existir a regra que esconde a barra de baixo com o menu aberto');
  assert(r.regraFolga, 'o menu deveria ter folga no fim para o último item não ficar sob a barra');
  await page.close();
});

/* 73) Limpeza do que JÁ está repetido (a pergunta ao finalizar só protege
   daqui para a frente) + "Cortesia" nas formas de pagamento. */
await test('Varredura acha o que já está repetido, mantém o mais recente na Lixeira e Cortesia entra no pagamento', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    ['pre', 'anestesia', 'financeiro', 'recuperacao'].forEach(m => store.setList(m, []));
    localStorage.removeItem(lixeira.KEY);
    const dia = '2026-08-07';

    /* O caso da vida real: 4 fichas + 2 financeiros do mesmo paciente no mesmo dia */
    const fichas = [];
    for (let i = 1; i <= 4; i++) {
      const f = store.save('anestesia', { paciente: { nome: 'Vivienne Braga' }, procedimento: { data: dia, nome: 'Mastopexia' }, _finalizado: true, marca: i });
      f._updatedAt = '2026-08-07T1' + i + ':00:00.000Z';
      fichas.push(f);
    }
    store.setList('anestesia', fichas.slice().reverse());
    const fins = [1, 2].map(i => {
      const x = store.save('financeiro', { paciente_nome: 'Vivienne Braga', data_proc: dia, procedimento: 'Mastopexia', marca: i });
      x._updatedAt = '2026-08-07T1' + i + ':30:00.000Z';
      return x;
    });
    store.setList('financeiro', fins);
    /* e um caso legítimo que NÃO deve virar grupo: paciente com um registro só */
    store.save('pre', { paciente_nome: 'João Souza', data_avaliacao: dia });

    const grupos = duplicados.varrer();
    out.achouDoisGrupos = grupos.length === 2
      && grupos.some(g => g.mod === 'anestesia' && g.itens.length === 4)
      && grupos.some(g => g.mod === 'financeiro' && g.itens.length === 2);
    const gA = grupos.find(g => g.mod === 'anestesia');
    out.maisRecentePrimeiro = gA.itens[0].marca === 4 && gA.itens[3].marca === 1;
    out.naoPegaSolitario = !grupos.some(g => g.mod === 'pre');

    /* Limpar um grupo: fica o mais recente, os outros vão para a Lixeira */
    const saiu = duplicados.manterUltimo('anestesia', 'Vivienne Braga', dia);
    const fichasRestantes = store.list('anestesia');
    out.limpouGrupo = saiu === 3 && fichasRestantes.length === 1 && fichasRestantes[0].marca === 4;
    out.foramParaLixeira = lixeira._ler().filter(e => e.mod === 'anestesia').length === 3;

    /* Financeiro: idem, fica o último */
    duplicados.manterUltimo('financeiro', 'Vivienne Braga', dia);
    const finRestante = store.list('financeiro');
    out.financeiroSoUm = finRestante.length === 1 && finRestante[0].marca === 2;

    out.zerou = duplicados.varrer().length === 0;

    /* A tela abre e diz que não há mais nada */
    duplicados.abrir();
    duplicados._render();
    out.telaLimpa = /Nenhum registro repetido/.test(document.getElementById('dup-corpo').textContent);
    modal.close();

    /* Cortesia disponível nos dois lugares onde se escolhe pagamento */
    const opts = (sel) => Array.from(document.querySelectorAll(sel + ' option')).map(o => o.textContent.trim());
    out.cortesiaFinanceiro = opts('[name="tipo_pagamento"]').includes('Cortesia');
    out.cortesiaOrcamento = opts('#orc-pgto-tipo').includes('Cortesia');

    ['pre', 'anestesia', 'financeiro', 'recuperacao'].forEach(m => store.setList(m, []));
    localStorage.removeItem(lixeira.KEY);
    return out;
  });
  assert(r.achouDoisGrupos, 'a varredura deveria achar as 4 fichas e os 2 financeiros repetidos');
  assert(r.maisRecentePrimeiro, 'dentro do grupo, o mais recente tem que vir primeiro');
  assert(r.naoPegaSolitario, 'paciente com um registro só não é caso de duplicidade');
  assert(r.limpouGrupo, 'limpar o grupo deveria deixar só a ficha mais recente');
  assert(r.foramParaLixeira, 'as fichas removidas têm que ir para a Lixeira, não sumir');
  assert(r.financeiroSoUm, 'no financeiro deveria ficar só o lançamento mais recente');
  assert(r.zerou, 'depois da limpeza não deveria sobrar nenhum caso');
  assert(r.telaLimpa, 'sem duplicados, a tela deveria dizer isso em vez de ficar vazia');
  assert(r.cortesiaFinanceiro && r.cortesiaOrcamento, '"Cortesia" deveria estar nas formas de pagamento');
  await page.close();
});

/* 74) Ficha, itens 3/4/5: o que se escolhe no card (técnica, agulha, calibre,
   sítio, dispositivo, horário) tem que aparecer JÁ ESCRITO no evento. */
await test('Ficha: técnica, agulha, sítio e horário escolhidos nos cards entram sozinhos no evento', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    location.hash = '#anestesia';
    anestesia.graficoUI._contexto = 'anestesia';
    document.getElementById('eventos-body').innerHTML = '';
    const f = document.getElementById('form-anestesia');
    const set = (n, v) => { const el = f.querySelector('[name="' + n + '"]'); if (el) el.value = v; return !!el; };

    /* --- CARD 3: raqui com todos os detalhes --- */
    out.temCampos = set('bloqueio_tipo', 'Raquianestesia') && set('bloqueio_espaco', 'L2-L3')
      && set('bloqueio_posicao', 'Sentado') && set('bloqueio_agulha', 'Whitacre')
      && set('bloqueio_calibre', '27G') && set('bloqueio_tentativas', '2')
      && set('bloqueio_puncao', 'Múltipla') && set('bloqueio_liquor', 'Cristalino')
      && set('bloqueio_hora', '08:15');

    const texto = anestesia.eventos.descricaoPara('Raquianestesia');
    out.descreveEscolhas = /L2-L3/.test(texto) && /Whitacre 27G/.test(texto) && /sentado/i.test(texto)
      && /2 tentativas/.test(texto) && /múltipla/i.test(texto) && /cristalino/i.test(texto)
      && !/L3–L4/.test(texto) && !/fino calibre/.test(texto);

    /* o horário do card cria/ajusta o evento na linha do tempo */
    anestesia.eventos.sincronizarDoBloqueio();
    const linhas = () => Array.from(document.querySelectorAll('#eventos-body tr')).map(tr => ({
      tr, tipo: (tr.querySelector('[name="evt_tipo[]"]') || {}).value,
      hora: (tr.querySelector('[name="evt_hora[]"]') || {}).value,
      obs: (tr.querySelector('[name="evt_obs[]"]') || {}).value
    }));
    const evRaqui = linhas().find(l => l.tipo === 'Raquianestesia');
    out.criouComHora = !!evRaqui && evRaqui.hora === '08:15';
    out.jaVemEscrito = !!evRaqui && /L2-L3/.test(evRaqui.obs) && /Whitacre 27G/.test(evRaqui.obs);

    /* mudar o card reescreve o evento */
    set('bloqueio_espaco', 'L4-L5');
    anestesia.eventos.atualizarDescricoes();
    out.acompanhaMudanca = /L4-L5/.test(linhas().find(l => l.tipo === 'Raquianestesia').obs);

    /* o que a pessoa digitou à mão é intocável */
    const alvo = linhas().find(l => l.tipo === 'Raquianestesia');
    alvo.tr.querySelector('[name="evt_obs[]"]').value = 'Meu texto próprio';
    anestesia.eventos._marcarManual(alvo.tr.querySelector('[name="evt_obs[]"]'));
    set('bloqueio_espaco', 'T8');
    anestesia.eventos.atualizarDescricoes();
    out.respeitaManual = linhas().find(l => l.tipo === 'Raquianestesia').obs === 'Meu texto próprio';

    /* --- CARD 5: via aérea e acesso venoso --- */
    document.getElementById('eventos-body').innerHTML = '';
    set('via_aerea_detalhe', 'TOT 7,5 com cuff · Cormack I · fixado a 21 cm');
    set('via_aerea_hora', '08:40');
    const selVia = f.querySelector('[name="via_aerea_uso"]');
    selVia.value = 'Intubação orotraqueal';
    anestesia.eventos.aoSelecionarViaAerea(selVia);
    const evIot = linhas().find(l => l.tipo === 'Intubação');
    out.viaAerea = !!evIot && evIot.hora === '08:40'
      && /TOT 7,5 com cuff/.test(evIot.obs) && /orotraqueal/.test(evIot.obs);

    /* detalhe do dispositivo entra na venoclise */
    const chk = Array.from(f.querySelectorAll('[name="dispositivos[]"]')).find(c => c.value === 'Acesso venoso periférico');
    chk.checked = true; anestesia.disp.alternar(chk);
    const det = Array.from(f.querySelectorAll('[name="disp_det[]"]')).find(x => x.getAttribute('data-disp') === 'Acesso venoso periférico');
    det.value = 'Jelco 18G em dorso da mão direita';
    anestesia.eventos.atualizarDescricoes();
    const evVeno = linhas().find(l => l.tipo === 'Venoclise');
    out.dispositivo = !!evVeno && /Jelco 18G em dorso da mão direita/.test(evVeno.obs);

    /* a marca "auto" sobrevive a salvar e reabrir */
    const coletado = anestesia.eventos.coletar();
    out.guardaMarca = coletado.some(e => e.tipo === 'Venoclise' && e.auto === true);
    anestesia.eventos.restaurar(coletado);
    det.value = 'Jelco 20G em antebraço esquerdo';
    anestesia.eventos.atualizarDescricoes();
    out.sobreviveAoSalvar = /Jelco 20G em antebraço esquerdo/.test(linhas().find(l => l.tipo === 'Venoclise').obs);

    document.getElementById('eventos-body').innerHTML = '';
    return out;
  });
  assert(r.temCampos, 'os campos de detalhe do bloqueio, incluindo o horário, deveriam existir');
  assert(r.descreveEscolhas, 'a descrição padrão deveria sair reescrita com o que foi escolhido, sem o texto genérico');
  assert(r.criouComHora, 'o horário digitado no card deveria criar o evento na hora certa');
  assert(r.jaVemEscrito, 'o evento deveria nascer já com os detalhes do card');
  assert(r.acompanhaMudanca, 'mudar o card deveria reescrever o evento');
  assert(r.respeitaManual, 'texto digitado à mão no evento não pode ser sobrescrito');
  assert(r.viaAerea, 'via aérea: detalhe e horário do card deveriam entrar no evento de intubação');
  assert(r.dispositivo, 'o detalhe do acesso venoso deveria entrar no evento de venoclise');
  assert(r.guardaMarca && r.sobreviveAoSalvar, 'a marca de texto automático precisa sobreviver a salvar e reabrir');
  await page.close();
});

/* 75) Símbolos do gráfico: cada sinal vital com cor E marca próprias, valendo
   igual na ficha e na SRPA — para o gráfico se ler sem depender da cor. */
await test('Gráfico: cada sinal vital tem cor e símbolo próprios, na ficha e na SRPA', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    const S = anestesia.graficoUI.SERIES;
    const campos = Object.keys(S);

    /* toda série tem cor, marca e rótulo */
    out.completo = campos.length >= 16 && campos.every(k => S[k].cor && S[k].marca && S[k].label);
    /* nenhuma cor repetida */
    out.coresUnicas = new Set(campos.map(k => S[k].cor.toUpperCase())).size === campos.length;
    /* nenhum par (cor, marca) repetido — se a cor se parecer, a forma separa */
    out.parUnico = new Set(campos.map(k => S[k].cor + '|' + S[k].marca)).size === campos.length;
    /* os seis que aparecem juntos o tempo todo têm marcas todas diferentes */
    const nucleo = ['pas', 'pad', 'pam', 'fc', 'spo2', 'etco2'];
    out.nucleoDistinto = new Set(nucleo.map(k => S[k].marca)).size === nucleo.length;
    /* a convenção da ficha de papel */
    out.tradicao = S.pas.marca === 'vDown' && S.pad.marca === 'vUp'
      && S.fc.marca === 'dot' && S.fr.marca === 'ring' && S.temp.marca === 'cross';

    /* as marcas realmente desenham algo diferente umas das outras */
    const assinatura = (marca) => {
      const cv = document.createElement('canvas');
      cv.width = 24; cv.height = 24;
      const c = cv.getContext('2d');
      anestesia.graficoUI.desenharMarca(c, marca, 12, 12, '#000000', 1.4);
      return cv.toDataURL();
    };
    const marcas = Array.from(new Set(campos.map(k => S[k].marca)));
    const desenhos = marcas.map(assinatura);
    out.desenhosDiferentes = new Set(desenhos).size === marcas.length
      && desenhos.every(d => d.length > 200);   /* nenhuma marca saiu em branco */

    /* legenda montada a partir da MESMA fonte, nas duas telas */
    anestesia.graficoUI.renderLegendaFixa();
    const lf = document.getElementById('legend-fixos');
    const ls = document.getElementById('srpa-legend-fixos');
    out.legendas = !!lf && !!ls && /PAS/.test(lf.textContent) && /EtCO₂/.test(lf.textContent)
      && /PAS/.test(ls.textContent) && /FR/.test(ls.textContent)
      && lf.querySelectorAll('img').length === 6 && ls.querySelectorAll('img').length === 6;
    /* botão de arrastar herda a cor da série (nada de hex solto divergindo) */
    const btnPas = document.querySelector('.gt-btn[data-mode="pas"]');
    out.botaoAlinhado = !!btnPas && btnPas.dataset.color === S.pas.cor;

    /* o gráfico da SRPA usa o mesmo motor: mesmos ids de série */
    anestesia.graficoUI._contexto = 'recuperacao';
    const idsSrpa = anestesia.graficoUI._ctxIds();
    anestesia.graficoUI._contexto = 'anestesia';
    out.mesmoMotor = idsSrpa.canvas === 'srpa-vitals-chart' && idsSrpa.vitaisBody === 'srpa-vitais-body';
    return out;
  });
  assert(r.completo, 'toda série precisa de cor, marca e rótulo');
  assert(r.coresUnicas, 'duas séries não podem dividir a mesma cor');
  assert(r.parUnico, 'duas séries não podem dividir cor e marca ao mesmo tempo');
  assert(r.nucleoDistinto, 'PAS/PAD/PAM/FC/SpO₂/EtCO₂ aparecem juntos: as marcas têm que ser todas diferentes');
  assert(r.tradicao, 'a convenção da ficha de papel deveria ser respeitada (∨ ∧ ● ○ ×)');
  assert(r.desenhosDiferentes, 'cada marca tem que desenhar algo visualmente distinto e não vazio');
  assert(r.legendas, 'as duas legendas deveriam sair da mesma fonte, com o símbolo desenhado');
  assert(r.botaoAlinhado, 'o botão de arrastar deveria herdar a cor da série');
  assert(r.mesmoMotor, 'a SRPA deveria usar o mesmo motor de gráfico da ficha');
  await page.close();
});

/* 76) Aparelho cheio: o app libera espaço sozinho e SALVA, em vez de engolir o
   erro e abrir uma janela a cada toque em Salvar. */
await test('Armazenamento cheio: libera espaço sozinho, salva de verdade e não bloqueia a tela', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    const setItemOrig = Storage.prototype.setItem;

    /* --- 1) a gravação que falha volta FALSE (antes engolia e devolvia nada) --- */
    let permitir = false;
    Storage.prototype.setItem = function (k, v) {
      if (!permitir && String(k).indexOf('medsys.v3.pre') === 0) {
        const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e;
      }
      return setItemOrig.call(this, k, v);
    };
    /* trava também o socorro: nenhuma etapa consegue destravar */
    const etapasOrig = espaco.ETAPAS.slice();
    espaco.ETAPAS = [{ nome: 'nada', fn: () => 0 }];
    localStorage.removeItem(espaco.AVISO_KEY);
    out.falhaVoltaFalse = store.setList('pre', [{ _id: 'x' }]) === false;
    /* e avisa numa FAIXA, não numa janela modal que bloqueia o trabalho */
    out.faixaNaoModal = !!document.getElementById('espaco-faixa')
      && !document.getElementById('modal-backdrop').classList.contains('show');
    /* segundo aviso dentro de 6 h não repete a faixa */
    espaco.fecharFaixa();
    store.setList('pre', [{ _id: 'x' }]);
    out.naoRepete = !document.getElementById('espaco-faixa');

    /* --- 2) socorro real: a etapa libera e a gravação passa --- */
    espaco.ETAPAS = [
      { nome: 'etapa que não resolve', fn: () => 10 },
      { nome: 'etapa que resolve', fn: () => { permitir = true; return 2048; } },
      { nome: 'etapa que nem deveria rodar', fn: () => { out.foiLonge = true; return 1; } }
    ];
    espaco.fecharFaixa();
    out.socorroSalvou = store.setList('pre', [{ _id: 'y' }]) === true;
    out.parouNaEtapaCerta = out.foiLonge !== true;
    out.semFaixaQuandoResolve = !document.getElementById('espaco-faixa');

    Storage.prototype.setItem = setItemOrig;
    espaco.ETAPAS = etapasOrig;

    /* --- 3) as etapas reais existem e vão da mais segura para a menos --- */
    const nomes = espaco.ETAPAS.map(e => e.nome);
    out.ordemSegura = nomes[0].includes('versões')
      && nomes.indexOf('lixeira vencida') < nomes.indexOf('lixeira')
      && nomes.some(n => n.includes('nuvem'));

    /* --- 4) só sai do aparelho o que está CONFIRMADO na nuvem --- */
    store.setList('pre', []);
    const antigo = '2020-01-01T00:00:00.000Z';
    store.setList('pre', [
      { _id: 'confirmado', nome: 'A', _updatedAt: antigo, _relUpdatedAt: antigo },
      { _id: 'so-local',   nome: 'B', _updatedAt: antigo }        /* nunca subiu */
    ]);
    localStorage.removeItem(arquivo.INDEX_KEY);
    espaco._arquivarAte(30);
    const restaram = store.list('pre').map(x => x._id);
    out.guardaOnaoSincronizado = restaram.includes('so-local') && !restaram.includes('confirmado');
    out.indiceLembra = arquivo.estaArquivado('pre', 'confirmado');

    /* --- 5) preventiva não arquiva nada: só mexe no que é descartável --- */
    store.setList('pre', [{ _id: 'recente', nome: 'C', _updatedAt: new Date().toISOString(), _relUpdatedAt: antigo }]);
    espaco.preventiva();
    out.preventivaNaoArquiva = store.list('pre').length === 1;

    store.setList('pre', []);
    localStorage.removeItem(arquivo.INDEX_KEY);
    localStorage.removeItem(espaco.AVISO_KEY);
    espaco.fecharFaixa();
    return out;
  });
  assert(r.falhaVoltaFalse, 'gravação que não coube tem que voltar false, não fingir sucesso');
  assert(r.faixaNaoModal, 'o aviso deveria ser uma faixa, não uma janela que bloqueia a tela');
  assert(r.naoRepete, 'o aviso não pode reaparecer a cada gravação');
  assert(r.socorroSalvou, 'o socorro deveria liberar espaço e conseguir salvar');
  assert(r.parouNaEtapaCerta, 'o socorro deveria parar assim que a gravação passar, sem liberar demais');
  assert(r.semFaixaQuandoResolve, 'resolvendo sozinho, não deveria incomodar ninguém');
  assert(r.ordemSegura, 'as etapas deveriam ir da mais segura para a menos');
  assert(r.guardaOnaoSincronizado, 'registro que ainda não subiu para a nuvem NUNCA pode sair do aparelho');
  assert(r.indiceLembra, 'o que foi arquivado tem que ficar no índice, para poder voltar');
  assert(r.preventivaNaoArquiva, 'a manutenção preventiva não pode arquivar registro nenhum');
  await page.close();
});

/* 77) A faixa tem que DIAGNOSTICAR, não só reclamar: dizer o que ocupa espaço e
   por que o app não consegue liberar mais. */
await test('Faixa de armazenamento diz o que ocupa espaço e por que não dá para liberar mais', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    ['pre', 'anestesia'].forEach(m => store.setList(m, []));
    localStorage.removeItem(espaco.AVISO_KEY);

    /* Caso A: registros ainda NÃO confirmados no banco da clínica.
       Não é lixo sobrando — é sincronização faltando, e a faixa tem que dizer. */
    cloud._fila = () => [];
    store.setList('pre', [
      { _id: 'a', nome: 'A', _updatedAt: '2020-01-01T00:00:00.000Z' },
      { _id: 'b', nome: 'B', _updatedAt: '2020-01-01T00:00:00.000Z' },
      { _id: 'c', nome: 'C', _updatedAt: '2020-01-01T00:00:00.000Z' }
    ]);
    let d = espaco.diagnostico();
    out.contaSemEspelho = d.semEspelho === 3 && d.comEspelho === 0;
    espaco.fecharFaixa();
    espaco.mostrarFaixa(0);
    let txt = document.getElementById('espaco-faixa').textContent;
    out.apontaSincronizacao = /não estão confirmados no banco da clínica/.test(txt)
      && /Enviar tudo para a minha clínica/.test(txt);
    out.mostraQuemOcupa = /Ocupando mais:/.test(txt);
    out.mostraTotal = /KB|MB/.test(txt);

    /* Caso B: fila pendente — a causa é outra, e a mensagem também */
    cloud._fila = () => [{}, {}];
    espaco.fecharFaixa();
    espaco.mostrarFaixa(2);
    txt = document.getElementById('espaco-faixa').textContent;
    out.apontaFila = /ainda não subiram/.test(txt) && /Atualizar tudo/.test(txt);

    /* Caso C: tudo confirmado — aí sim é falta de espaço mesmo */
    cloud._fila = () => [];
    store.setList('pre', [{ _id: 'a', nome: 'A', _relUpdatedAt: '2020-01-01T00:00:00.000Z' }]);
    espaco.fecharFaixa();
    espaco.mostrarFaixa(0);
    txt = document.getElementById('espaco-faixa').textContent;
    out.semDesculpa = /Liberei tudo o que era seguro liberar/.test(txt);

    /* As etapas novas existem e a de demonstração não roda dentro do demo */
    const nomes = espaco.ETAPAS.map(e => e.nome);
    out.temEtapasNovas = nomes.includes('dados de demonstração') && nomes.includes('cópia de recuperação do formulário');
    const demoOrig = demo.ativo;
    demo.ativo = () => true;
    localStorage.setItem('demo:teste', 'x'.repeat(500));
    const etapaDemo = espaco.ETAPAS.find(e => e.nome === 'dados de demonstração');
    out.respeitaDemo = etapaDemo.fn() === 0 && localStorage.getItem('demo:teste') !== null;
    demo.ativo = () => false;
    out.limpaDemoForaDele = etapaDemo.fn() > 0 && localStorage.getItem('demo:teste') === null;
    demo.ativo = demoOrig;

    espaco.fecharFaixa();
    ['pre', 'anestesia'].forEach(m => store.setList(m, []));
    localStorage.removeItem(espaco.AVISO_KEY);
    return out;
  });
  assert(r.contaSemEspelho, 'o diagnóstico deveria contar quantos registros ainda não foram confirmados na nuvem');
  assert(r.apontaSincronizacao, 'com registros não confirmados, a faixa deveria apontar o caminho da sincronização');
  assert(r.mostraQuemOcupa && r.mostraTotal, 'a faixa deveria dizer o total e o que mais ocupa espaço');
  assert(r.apontaFila, 'com fila pendente, a causa apontada deveria ser outra');
  assert(r.semDesculpa, 'com tudo confirmado, a faixa deveria admitir que é falta de espaço mesmo');
  assert(r.temEtapasNovas, 'demonstração e auto-save deveriam ser etapas de liberação');
  assert(r.respeitaDemo, 'nunca apagar os dados de demonstração de quem está usando o modo demo');
  assert(r.limpaDemoForaDele, 'fora do modo demo, esses dados podem sair');
  await page.close();
});

/* 78) "Pré-anestésicas: 1,2 MB" não é acionável. Precisa dizer o que há dentro. */
await test('Armazenamento mostra o que pesa DENTRO do módulo e o que já dá para liberar', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    const imagem = 'data:image/png;base64,' + 'A'.repeat(4000);
    store.setList('pre', [
      { _id: 'p1', nome: 'Paciente Pesado', data_avaliacao: '2026-08-01',
        _docs: [{ nome: 'ECG', dataurl: imagem, storage_path: 'org/1/ecg.png' }],   /* já na nuvem */
        assinatura_dataurl: imagem },                                               /* nunca sai */
      { _id: 'p2', nome: 'Paciente Leve', data_avaliacao: '2026-08-02', obs: 'texto curto' }
    ]);

    /* soma os binários coladinhos no registro */
    const bin = armazenamento._binariosDe(store.list('pre')[0]);
    out.contaBinarios = bin.n === 2 && bin.bytes > 15000;
    out.ignoraTextoCurto = armazenamento._binariosDe(store.list('pre')[1]).n === 0;

    armazenamento.detalhar('pre');
    const txt = document.getElementById('modal-body').textContent;
    out.abriuDetalhe = /imagem\(ns\)\/assinatura/.test(txt);
    out.dizOqueLibera = /já está na nuvem e pode sair daqui agora/.test(txt);
    out.listaMaisPesado = txt.indexOf('Paciente Pesado') >= 0
      && txt.indexOf('Paciente Pesado') < txt.indexOf('Paciente Leve');
    out.temBotaoLiberar = /Liberar/.test(document.getElementById('modal-body').innerHTML);
    modal.close();

    /* liberar tira só a cópia local do que TEM storage_path; a assinatura fica */
    armazenamento.liberarAnexos();
    const p1 = store.list('pre')[0];
    out.tirouSoOqueEstaNaNuvem = !p1._docs[0].dataurl && p1._docs[0].storage_path
      && p1.assinatura_dataurl === imagem;

    /* sem nada na nuvem, o detalhe é honesto: não dá para liberar */
    store.setList('pre', [{ _id: 'p3', nome: 'Sem nuvem', _docs: [{ nome: 'X', dataurl: imagem }] }]);
    armazenamento.detalhar('pre');
    const txt2 = document.getElementById('modal-body').textContent;
    out.honestoQuandoNaoDa = /Nenhuma dessas imagens foi enviada para a nuvem ainda/.test(txt2);
    modal.close();

    store.setList('pre', []);
    return out;
  });
  assert(r.contaBinarios, 'deveria somar as imagens e assinaturas coladas no registro');
  assert(r.ignoraTextoCurto, 'texto comum não pode ser contado como binário');
  assert(r.abriuDetalhe, 'o detalhe do módulo deveria abrir dizendo quanto é imagem');
  assert(r.dizOqueLibera && r.temBotaoLiberar, 'deveria dizer quanto dá para liberar e oferecer o botão');
  assert(r.listaMaisPesado, 'os registros deveriam vir do mais pesado para o mais leve');
  assert(r.tirouSoOqueEstaNaNuvem, 'liberar só pode tirar a cópia local do que já está na nuvem — assinatura fica');
  assert(r.honestoQuandoNaoDa, 'sem nada na nuvem, o detalhe tem que dizer que não dá para liberar');
  await page.close();
});

/* 79) Medir a cota de verdade. Aparelho com 200 GB livres acusando "cheio" em
   2 MB não se resolve por suposição — se mede. */
await test('Medidor de limite descobre quanto o navegador realmente aceita e não deixa lixo para trás', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    const setItemOrig = Storage.prototype.setItem;
    const TETO = 1500 * 1024;                    /* finge um navegador de ~1,5 MB livre */
    Storage.prototype.setItem = function (k, v) {
      if (k === '__medsys_teste_cota__' && String(v).length * 2 > TETO) {
        const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e;
      }
      return setItemOrig.call(this, k, v);
    };
    await armazenamento.testarLimite();
    Storage.prototype.setItem = setItemOrig;

    const txt = document.getElementById('armazenamento-limite').textContent;
    out.reportou = /Em uso:/.test(txt) && /ainda cabe:/.test(txt) && /teto deste navegador/.test(txt);
    /* achou perto do teto fingido (1,5 MB), não um número qualquer */
    const m = txt.match(/ainda cabe:\s*([\d.,]+)\s*(KB|MB)/);
    const val = m ? parseFloat(m[1].replace(',', '.')) * (m[2] === 'MB' ? 1024 : 1) : 0;
    out.acertouOTeto = val > 1300 && val < 1550;
    /* diagnostica em vez de só cuspir número */
    out.interpretou = /bem menos que os ~5 MB|não aceita nem 256 KB|Espaço normal/.test(txt);
    /* e não deixou a chave de teste para trás */
    out.limpou = localStorage.getItem('__medsys_teste_cota__') === null;
    return out;
  });
  assert(r.reportou, 'a medição deveria informar uso, folga e teto');
  assert(r.acertouOTeto, 'a busca deveria chegar perto do limite real do navegador');
  assert(r.interpretou, 'a medição deveria dizer o que aquele número significa, não só o número');
  assert(r.limpou, 'a chave de teste não pode sobrar ocupando espaço');
  await page.close();
});

/* 80) Modo nuvem: o aparelho guarda só a janela de trabalho e o resto volta
   sozinho ao abrir o paciente. */
await test('Modo nuvem: aparelho guarda só o que está em uso e busca o resto da nuvem sozinho', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    const antigo = new Date(Date.now() - 60 * 86400000).toISOString();
    const hoje = new Date().toISOString();
    localStorage.removeItem(arquivo.INDEX_KEY);
    localStorage.setItem(modoNuvem.KEY, '0');

    /* sem nuvem, ligar é recusado — arquivar sem nuvem seria perder */
    cloud.estaConfigurado = () => false;
    await modoNuvem.alternar(true);
    out.recusaSemNuvem = modoNuvem.ligado() === false;

    cloud.estaConfigurado = () => true;
    cloud.estaLogado = () => true;
    cloud.sessaoExpirada = () => false;

    store.setList('pre', [
      { _id: 'velho-ok',   nome: 'Antigo confirmado', _updatedAt: antigo, _relUpdatedAt: antigo },
      { _id: 'velho-solo', nome: 'Antigo só local',   _updatedAt: antigo },
      { _id: 'recente',    nome: 'Recente',           _updatedAt: hoje,   _relUpdatedAt: hoje },
      { _id: 'na-tela',    nome: 'Aberto agora',      _updatedAt: antigo, _relUpdatedAt: antigo }
    ]);
    /* simula o registro aberto na tela */
    const f = document.getElementById('form-pre');
    let hid = f.querySelector('[name="_id"]');
    if (!hid) { hid = document.createElement('input'); hid.type = 'hidden'; hid.name = '_id'; f.appendChild(hid); }
    hid.value = 'na-tela';

    localStorage.setItem(modoNuvem.KEY, '1');
    const saíram = modoNuvem.manutencao();
    const ficaram = store.list('pre').map(x => x._id);
    out.saiuSoOCerto = saíram === 1 && ficaram.includes('recente')
      && ficaram.includes('velho-solo') && ficaram.includes('na-tela')
      && !ficaram.includes('velho-ok');
    out.protegeNaoSincronizado = ficaram.includes('velho-solo');
    out.protegeAberto = ficaram.includes('na-tela');
    out.indiceLembra = arquivo.estaArquivado('pre', 'velho-ok');

    /* abrir o paciente arquivado busca da nuvem sozinho */
    let pedido = null;
    arquivo.restaurar = async (mod, id) => {
      pedido = mod + ':' + id;
      const l = store.list(mod); l.push({ _id: id, nome: 'Voltou da nuvem' }); store.setList(mod, l);
      return true;
    };
    let carregado = null;
    const carregarOrig = pre.carregar;
    pre.carregar = (item) => { carregado = item; };
    await dashboard._abrirRegistro('pre', 'velho-ok');
    await new Promise(r => setTimeout(r, 250));
    out.buscouSozinho = pedido === 'pre:velho-ok' && carregado && carregado._id === 'velho-ok';
    pre.carregar = carregarOrig;

    /* sem internet e sem cópia, diz a verdade em vez de abrir vazio */
    arquivo.restaurar = async () => false;
    let erro = '';
    const toastOrig = window.toast;
    window.toast = (m, t) => { if (t === 'error') erro = m; };
    await dashboard._abrirRegistro('pre', 'nao-existe');
    window.toast = toastOrig;
    out.avisaQuandoNaoAcha = /nem aqui, nem na nuvem/.test(erro);

    /* a janela de dias é configurável */
    modoNuvem.definirDias(30);
    out.janelaConfiguravel = modoNuvem.dias() === 30;

    localStorage.setItem(modoNuvem.KEY, '0');
    localStorage.removeItem(modoNuvem.DIAS_KEY);
    localStorage.removeItem(arquivo.INDEX_KEY);
    store.setList('pre', []);
    hid.value = '';
    return out;
  });
  assert(r.recusaSemNuvem, 'sem nuvem, o modo não pode ser ligado — seria perder registro');
  assert(r.saiuSoOCerto, 'só o registro antigo E confirmado na nuvem deveria sair do aparelho');
  assert(r.protegeNaoSincronizado, 'registro que ainda não subiu nunca sai');
  assert(r.protegeAberto, 'o registro aberto na tela nunca sai no meio do trabalho');
  assert(r.indiceLembra, 'o que saiu tem que ficar no índice para poder voltar');
  assert(r.buscouSozinho, 'abrir um paciente arquivado deveria buscar da nuvem sem o usuário pedir');
  assert(r.avisaQuandoNaoAcha, 'sem achar na nuvem, o app tem que dizer — não abrir ficha vazia');
  assert(r.janelaConfiguravel, 'a janela de dias guardados deveria ser configurável');
  await page.close();
});

/* 81) O carimbo do profissional era copiado inteiro dentro de CADA ficha
   (~149 KB por registro). Guardar uma vez só. */
await test('Carimbo repetido é guardado uma vez só, sem o resto do app perceber', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    localStorage.removeItem(store.BLOBS_KEY);
    localStorage.removeItem(armazenamento.FLAG_DEDUP);
    const carimbo = 'data:image/png;base64,' + 'K'.repeat(60000);   /* o mesmo em todas */
    const outro   = 'data:image/png;base64,' + 'Z'.repeat(60000);   /* de outro profissional */

    store.setList('pre', [
      { _id: 'f1', nome: 'A', assinatura_dataurl: carimbo },
      { _id: 'f2', nome: 'B', assinatura_dataurl: carimbo },
      { _id: 'f3', nome: 'C', assinatura_dataurl: carimbo },
      { _id: 'f4', nome: 'D', assinatura_dataurl: outro }
    ]);

    /* na guarda: referência, não a imagem */
    const cru = localStorage.getItem(STORAGE.pre);
    out.naoGuardaRepetido = cru.indexOf('KKKKKKKKKK') < 0 && /blob:/.test(cru);
    /* duas imagens distintas = dois blobs; três fichas iguais compartilham um */
    out.umBlobPorImagem = Object.keys(store._blobs()).length === 2;
    /* o peso caiu de ~4 cópias para 2 */
    out.encolheu = cru.length * 2 < 40000;

    /* na leitura: a imagem inteira volta, o resto do app não muda nada */
    const lidos = store.list('pre');
    out.leituraIntacta = lidos[0].assinatura_dataurl === carimbo
      && lidos[2].assinatura_dataurl === carimbo
      && lidos[3].assinatura_dataurl === outro;
    out.getByIdIntacto = store.getById('pre', 'f2').assinatura_dataurl === carimbo;

    /* trocar o carimbo depois NÃO altera ficha antiga (chave é o conteúdo) */
    const l = store.list('pre');
    l[0].assinatura_dataurl = outro;
    store.setList('pre', l);
    out.naoContaminaAntigas = store.getById('pre', 'f2').assinatura_dataurl === carimbo
      && store.getById('pre', 'f1').assinatura_dataurl === outro;

    /* texto pequeno continua inteiro — não vale referenciar tudo */
    store.setList('consulta', [{ _id: 'c1', obs: 'anotação curta', foto: 'data:image/png;base64,AAA' }]);
    out.ignoraPequeno = /data:image\/png;base64,AAA/.test(localStorage.getItem(STORAGE.consulta));

    /* migração do que já estava duplicado */
    localStorage.setItem(STORAGE.pre, JSON.stringify([
      { _id: 'v1', nome: 'Velho A', assinatura_dataurl: carimbo },
      { _id: 'v2', nome: 'Velho B', assinatura_dataurl: carimbo }
    ]));
    localStorage.removeItem(armazenamento.FLAG_DEDUP);
    const ganho = armazenamento.deduplicarImagens({ forcar: true });
    out.migrou = ganho > 50000 && localStorage.getItem(STORAGE.pre).indexOf('KKKKKKKKKK') < 0;
    out.migradoAindaLe = store.getById('pre', 'v2').assinatura_dataurl === carimbo;
    out.rodaUmaVez = armazenamento.deduplicarImagens() === 0;

    ['pre', 'consulta'].forEach(m => store.setList(m, []));
    localStorage.removeItem(store.BLOBS_KEY);
    return out;
  });
  assert(r.naoGuardaRepetido, 'a imagem grande não pode ser gravada dentro do registro');
  assert(r.umBlobPorImagem, 'imagens iguais deveriam compartilhar um único blob');
  assert(r.encolheu, 'o módulo deveria encolher de verdade, não só trocar de forma');
  assert(r.leituraIntacta && r.getByIdIntacto, 'na leitura a imagem tem que voltar inteira — nada no app pode notar');
  assert(r.naoContaminaAntigas, 'trocar o carimbo hoje não pode alterar a ficha assinada ontem');
  assert(r.ignoraPequeno, 'imagem pequena não precisa virar referência');
  assert(r.migrou && r.migradoAindaLe, 'a migração deveria desduplicar o que já estava gravado, sem perder nada');
  assert(r.rodaUmaVez, 'a migração não deveria repetir a cada abertura do app');
  await page.close();
});

/* 82) Carimbo trocado deixa a imagem velha guardada para sempre. Tem que sair. */
await test('Imagem que nenhum registro usa mais é descartada, e a que está em uso nunca', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    localStorage.removeItem(store.BLOBS_KEY);
    const velho = 'data:image/png;base64,' + 'V'.repeat(60000);
    const novo  = 'data:image/png;base64,' + 'N'.repeat(60000);

    store.setList('pre', [{ _id: 'x', nome: 'A', assinatura_dataurl: velho }]);
    out.guardouUm = Object.keys(store._blobs()).length === 1;

    /* troca o carimbo: o antigo fica órfão */
    store.setList('pre', [{ _id: 'x', nome: 'A', assinatura_dataurl: novo }]);
    out.doisGuardados = Object.keys(store._blobs()).length === 2;

    const liberto = armazenamento.limparImagensOrfas();
    const restantes = Object.keys(store._blobs());
    out.tirouOrfa = liberto > 50000 && restantes.length === 1;
    out.manteveEmUso = store.getById('pre', 'x').assinatura_dataurl === novo;

    /* imagem citada só pela LIXEIRA não é órfã: o registro ainda pode voltar */
    store.setList('pre', [{ _id: 'y', nome: 'B', assinatura_dataurl: velho }]);
    store.delete('pre', 'y');                       /* vai para a lixeira */
    store.setList('pre', []);                       /* nada mais referencia nada */
    const refVelho = store._refDe(velho);
    armazenamento.limparImagensOrfas();
    out.respeitaLixeira = !!store._blobs()[refVelho];
    /* e o registro volta da lixeira com a imagem inteira */
    out.lixeiraDevolveInteiro = (lixeira._ler().find(e => e.item && e.item._id === 'y') || {}).item.assinatura_dataurl === velho;

    /* rodar de novo sem nada a fazer não custa nem quebra */
    out.idempotente = armazenamento.limparImagensOrfas() === 0;
    /* e é uma etapa de liberação de espaço */
    out.ehEtapa = espaco.ETAPAS.some(e => e.nome === 'imagens que ninguém mais usa');
    /* a prateleira aparece com nome próprio, não some em "Configurações e outros" */
    out.temRotulo = /Carimbos e imagens/.test(armazenamento._rotulo(store.BLOBS_KEY));

    localStorage.removeItem(store.BLOBS_KEY);
    localStorage.removeItem(lixeira.KEY);
    store.setList('pre', []);
    return out;
  });
  assert(r.guardouUm && r.doisGuardados, 'cada imagem distinta deveria ocupar um lugar');
  assert(r.tirouOrfa, 'a imagem que ninguém mais referencia deveria ser descartada');
  assert(r.manteveEmUso, 'a imagem em uso não pode ser tocada');
  assert(r.respeitaLixeira, 'imagem citada pela lixeira ainda é necessária — não é órfã');
  assert(r.lixeiraDevolveInteiro, 'o registro na lixeira tem que voltar com a imagem inteira');
  assert(r.idempotente, 'rodar de novo sem órfãs não deveria fazer nada');
  assert(r.ehEtapa, 'limpar imagens órfãs deveria ser uma etapa de liberação de espaço');
  assert(r.temRotulo, 'a prateleira de imagens precisa de nome próprio na lista de armazenamento');
  await page.close();
});

/* 83) A autorização do Google vence em ~1 h. Isso não pode desfazer a
   configuração do médico nem obrigá-lo a autorizar todo dia. */
await test('Drive: token vencido não desliga a opção nem se perde ao recarregar', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    localStorage.removeItem(pdfBackup.TOKEN_KEY);
    localStorage.removeItem(pdfBackup.AVISO_DRIVE_KEY);
    pdfBackup.salvarCfg({ drive: true });

    /* falha automática NÃO pode desligar a opção — era o bug */
    pdfBackup._obterToken = async () => null;
    pdfBackup._accessToken = null;
    await pdfBackup.enviarDrive(new Blob(['x']), 'a.pdf');
    await pdfBackup.enviarDrive(new Blob(['x']), 'b.pdf');
    await pdfBackup.enviarDrive(new Blob(['x']), 'c.pdf');
    out.naoDesliga = pdfBackup.cfg().drive === true;
    /* avisa uma vez, não a cada PDF */
    out.avisouUmaVez = !!localStorage.getItem(pdfBackup.AVISO_DRIVE_KEY);
    const carimbo = localStorage.getItem(pdfBackup.AVISO_DRIVE_KEY);
    await pdfBackup.enviarDrive(new Blob(['x']), 'd.pdf');
    out.naoRepeteAviso = localStorage.getItem(pdfBackup.AVISO_DRIVE_KEY) === carimbo;

    /* o token sobrevive ao recarregar: era só memória, e recarregar pedia
       autorização de novo todo dia */
    pdfBackup._salvarToken('tk-123', Date.now() + 3600000);
    pdfBackup._accessToken = null; pdfBackup._tokenExpira = 0;      /* simula reload */
    const salvo = pdfBackup._lerTokenSalvo();
    out.tokenPersiste = !!salvo && salvo.access_token === 'tk-123';
    /* token vencido não é reaproveitado */
    pdfBackup._salvarToken('tk-velho', Date.now() - 1000);
    out.ignoraVencido = pdfBackup._lerTokenSalvo() === null;

    /* desligar continua existindo — mas como escolha explícita do usuário */
    pdfBackup.desligarDrive();
    out.desligaSePedirem = pdfBackup.cfg().drive === false;

    localStorage.removeItem(pdfBackup.TOKEN_KEY);
    localStorage.removeItem(pdfBackup.AVISO_DRIVE_KEY);
    return out;
  });
  assert(r.naoDesliga, 'falha de token NUNCA pode desfazer a configuração do usuário');
  assert(r.avisouUmaVez && r.naoRepeteAviso, 'o pedido de reautorização deveria vir uma vez, não a cada PDF');
  assert(r.tokenPersiste, 'o token precisa sobreviver ao recarregar a página');
  assert(r.ignoraVencido, 'token vencido não pode ser reaproveitado');
  assert(r.desligaSePedirem, 'desligar o Drive continua possível — mas só se o usuário mandar');
  await page.close();
});

/* 84) Topo da ficha recolhido num só lugar + Salvar/Finalizar no fim da página */
await test('Ficha: ações do topo viram um menu recolhível e Salvar/Finalizar aparecem no fim', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    localStorage.removeItem(acoesUI.KEY);
    acoesUI.montar();
    acoesUI.MODS.forEach(m => acoesUI._aplicar(m));

    const mods = ['pre', 'consulta', 'anestesia', 'recuperacao'];
    /* cabeçalho existe nos quatro módulos pedidos */
    out.cabecalhos = mods.every(m => !!document.getElementById('acoes-cab-' + m));
    /* a barra de botões e as abas de rascunho foram para dentro dele */
    out.recolheu = mods.every(m => {
      const caixa = document.getElementById('acoes-caixa-' + m);
      return caixa && caixa.querySelector('.action-bar') && caixa.style.display === 'none';
    });
    /* "Reaproveitar" segue o mesmo estado — é ação, não preenchimento */
    const tb = document.querySelector('#form-pre .form-toolbar');
    out.reaproveitarJunto = !tb || tb.style.display === 'none';

    /* abrir mostra tudo e a escolha é lembrada */
    acoesUI.alternar('pre');
    out.abre = document.getElementById('acoes-caixa-pre').style.display !== 'none'
      && JSON.parse(localStorage.getItem(acoesUI.KEY)).pre === true
      && (!tb || tb.style.display !== 'none');
    acoesUI.alternar('pre');
    out.fecha = document.getElementById('acoes-caixa-pre').style.display === 'none';

    /* Salvar e Finalizar no FIM da página, dentro do formulário */
    out.rodapes = mods.every(m => {
      const rod = document.getElementById('acoes-rodape-' + m);
      const form = document.getElementById('form-' + m);
      return rod && form && form.contains(rod)
        && form.lastElementChild === rod
        && /Salvar/.test(rod.textContent) && /Finalizar/.test(rod.textContent);
    });
    /* e os botões chamam de verdade o módulo certo */
    let chamou = '';
    const salvarOrig = pre.salvar, finalizarOrig = pre.finalizar;
    pre.salvar = () => { chamou += 'salvar;'; };
    pre.finalizar = () => { chamou += 'finalizar;'; };
    const rod = document.getElementById('acoes-rodape-pre');
    rod.querySelectorAll('button')[0].click();
    rod.querySelectorAll('button')[1].click();
    pre.salvar = salvarOrig; pre.finalizar = finalizarOrig;
    out.botoesFuncionam = chamou === 'salvar;finalizar;';

    /* montar de novo não duplica nada */
    acoesUI.montar();
    out.idempotente = document.querySelectorAll('#module-pre .acoes-cab').length === 1
      && document.querySelectorAll('#form-pre .acoes-rodape').length === 1;

    localStorage.removeItem(acoesUI.KEY);
    return out;
  });
  assert(r.cabecalhos, 'os quatro módulos deveriam ganhar o cabeçalho de ações');
  assert(r.recolheu, 'a barra de botões deveria ficar dentro dele, recolhida por padrão');
  assert(r.reaproveitarJunto, 'o bloco Reaproveitar deveria seguir o mesmo estado');
  assert(r.abre && r.fecha, 'abrir/fechar deveria funcionar e ser lembrado');
  assert(r.rodapes, 'Salvar e Finalizar deveriam existir no fim de cada ficha');
  assert(r.botoesFuncionam, 'os botões do rodapé precisam chamar salvar e finalizar de verdade');
  assert(r.idempotente, 'montar de novo não pode duplicar cabeçalho nem rodapé');
  await page.close();
});

/* 85) Códigos do MESMO ato entram junto do procedimento principal; a lista de
   baixo (outra equipe cirúrgica) continua existindo e é a mesma de sempre. */
await test('Ficha: códigos do mesmo ato (100/70/50%) entram junto do procedimento, sem mexer na lista de outra equipe', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    ['cir-mesma-body', 'cir-combo-body'].forEach(id => { const b = document.getElementById(id); if (b) b.innerHTML = ''; });

    const cima = document.getElementById('cir-mesma-body');
    const baixo = document.getElementById('cir-combo-body');
    out.existemOsDois = !!cima && !!baixo;
    /* o de cima fica ANTES dos horários/duração; o de baixo, depois */
    const proc = document.querySelector('#form-anestesia [name="procedimento"]');
    const dur = document.querySelector('#form-anestesia [name="duracao"]');
    const pos = (a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING;
    out.ordemCerta = !!pos(proc, cima) && !!pos(cima, dur) && !!pos(dur, baixo);

    /* linha de cima: mesma equipe, com o grau 100/70/50 */
    anestesia.cirurgias.add({}, { mesmaEquipe: true, alvo: 'cir-mesma-body' });
    const l1 = cima.querySelector('.grid');
    const sel = l1.querySelector('[name="cir_extra_grau[]"]');
    out.temProporcao = !!sel && Array.from(sel.options).map(o => o.value).join(',') === '100,70,50';
    out.ehMesmaEquipe = l1.classList.contains('cir-mesma-equipe');
    out.naoMexeuNoDeBaixo = baixo.children.length === 0;

    /* linha de baixo continua sendo a de outra equipe, com cirurgião e horários */
    anestesia.cirurgias.add({ procedimento: 'Colecistectomia', cirurgiao: 'Dr. Outro', inicio: '10:00' });
    out.deBaixoIntacto = baixo.children.length === 1
      && !baixo.querySelector('.grid').classList.contains('cir-mesma-equipe');

    /* os dois grupos são coletados juntos, na ordem da tela */
    cima.querySelector('[name="cir_extra_proc[]"]').value = 'Biópsia';
    cima.querySelector('[name="cir_extra_grau[]"]').value = '70';
    const col = anestesia.cirurgias.coletar();
    out.coletaOsDois = col.length === 2
      && col[0].procedimento === 'Biópsia' && col[0].grau === '70' && !col[0].cirurgiao
      && col[1].procedimento === 'Colecistectomia' && col[1].cirurgiao === 'Dr. Outro';

    /* ao reabrir a ficha, cada linha volta para a lista certa */
    anestesia.cirurgias.restaurar(col);
    out.restauraSeparado = cima.children.length === 1 && baixo.children.length === 1
      && cima.querySelector('[name="cir_extra_proc[]"]').value === 'Biópsia'
      && baixo.querySelector('[name="cir_extra_proc[]"]').value === 'Colecistectomia';

    ['cir-mesma-body', 'cir-combo-body'].forEach(id => { document.getElementById(id).innerHTML = ''; });
    return out;
  });
  assert(r.existemOsDois, 'as duas listas deveriam existir');
  assert(r.ordemCerta, 'a nova fica junto do procedimento; a antiga, depois dos horários');
  assert(r.temProporcao, 'a proporção 100/70/50% precisa estar na linha nova');
  assert(r.ehMesmaEquipe && r.naoMexeuNoDeBaixo, 'a linha nova é da mesma equipe e não toca na lista de baixo');
  assert(r.deBaixoIntacto, 'a lista de outra equipe continua como era');
  assert(r.coletaOsDois, 'as duas listas têm que ser coletadas juntas, na ordem da tela');
  assert(r.restauraSeparado, 'ao reabrir, cada linha deveria voltar para a lista de onde veio');
  await page.close();
});

/* 86) Registro guardado na nuvem NÃO pode sumir da busca — foi o susto de uma
   ficha que parecia apagada e só estava arquivada. */
await test('Busca mostra também o que está na nuvem, e a limpeza de duplicados nunca junta dias diferentes', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    store.setList('anestesia', []);
    localStorage.removeItem(arquivo.INDEX_KEY);

    /* dois procedimentos do MESMO paciente em dias diferentes nunca formam grupo */
    store.setList('anestesia', [
      { _id: 'd21', paciente: { nome: 'Abraão Santiago' }, procedimento: { data: '2026-07-21', nome: 'Hipospadia' }, _updatedAt: '2026-07-21T12:00:00.000Z' },
      { _id: 'd22', paciente: { nome: 'Abraão Santiago' }, procedimento: { data: '2026-07-22', nome: 'Reabordagem' }, _updatedAt: '2026-07-22T12:00:00.000Z' }
    ]);
    out.diasDiferentesNaoAgrupam = duplicados.varrer({ mods: ['anestesia'] }).length === 0;
    /* e a limpeza geral não remove nenhum dos dois */
    duplicados.manterUltimoEmTodos ? null : null;
    out.nadaSeriaRemovido = duplicados.achar('anestesia', store.list('anestesia')[0]).length === 0;

    /* agora o de 21 vai para a nuvem (arquivado) e some da lista local */
    const ix = {}; ix.anestesia = [{ id: 'd21', nome: 'Abraão Santiago', data: '2026-07-21' }];
    localStorage.setItem(arquivo.INDEX_KEY, JSON.stringify(ix));
    store.setList('anestesia', [store.list('anestesia').find(x => x._id === 'd22')]);

    const linhas = historico._renderLinhas('anestesia', '');
    out.apareceNaBusca = /Abra.{0,3}o Santiago/.test(linhas) && /guardado na nuvem/.test(linhas);
    out.temBotaoAbrir = /dashboard\._abrirRegistro\('anestesia','d21'\)/.test(linhas);
    /* o filtro também alcança o que está na nuvem */
    out.filtroAlcanca = /guardado na nuvem/.test(historico._renderLinhas('anestesia', 'abra'))
      && !/guardado na nuvem/.test(historico._renderLinhas('anestesia', 'zzzz'));
    /* e o contador avisa que há registros fora do aparelho */
    out.contadorAvisa = /na nuvem/.test(historico._render('anestesia', ''));

    store.setList('anestesia', []);
    localStorage.removeItem(arquivo.INDEX_KEY);
    return out;
  });
  assert(r.diasDiferentesNaoAgrupam, 'dois dias diferentes nunca podem virar duplicidade');
  assert(r.nadaSeriaRemovido, 'nenhum dos dois registros seria removido pela limpeza');
  assert(r.apareceNaBusca, 'registro arquivado na nuvem tem que aparecer na busca, não sumir');
  assert(r.temBotaoAbrir, 'deveria haver um botão que traz da nuvem e abre');
  assert(r.filtroAlcanca, 'o filtro por nome tem que alcançar o que está na nuvem');
  assert(r.contadorAvisa, 'o contador deveria dizer quantos estão fora do aparelho');
  await page.close();
});

/* 87) Resgate: procurar um paciente na nuvem inteira, não só no índice local */
await test('Resgate encontra o paciente no banco da clínica e no backup, e traz de volta', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    store.setList('anestesia', []); store.setList('pre', []);
    cloud.estaConfigurado = () => true; cloud.estaLogado = () => true;
    cloud._garantirToken = async () => true;
    cloud.config = () => ({ url: 'https://x.supabase.co', key: 'k' });
    cloud._headers = () => ({});
    cloud.session = () => ({ user: { id: 'u1' } });
    cloudRel._orgAsync = async () => 'org-1';

    const daClinica = { _id: 'd21', paciente: { nome: 'Abraão Santiago' }, procedimento: { data: '2026-07-21' } };
    const doBackup = { _id: 'p9', nome: 'Abraão Santiago', data_avaliacao: '2026-07-20' };
    window.fetch = async (url) => {
      const u = String(url);
      if (/anesthesia_records/.test(u) && /organization_id/.test(u)) {
        return { ok: true, json: async () => [{ id: 'x', legacy_id: 'd21', data: daClinica, updated_at: '2026-07-21' }] };
      }
      if (/documentos/.test(u)) {
        return { ok: true, json: async () => [{ modulo: 'pre', dados: doBackup }] };
      }
      return { ok: true, json: async () => [] };
    };

    const achados = await arquivo.procurarNaNuvem('abraão');
    out.achouNosDoisCanais = achados.length === 2
      && achados.some(a => a.mod === 'anestesia' && a.item._id === 'd21')
      && achados.some(a => a.mod === 'pre' && a.item._id === 'p9');
    /* nome que não existe não traz nada */
    out.filtraPorNome = (await arquivo.procurarNaNuvem('zzzz')).length === 0;

    /* trazer de volta coloca o registro no aparelho */
    arquivo._achados = achados;
    arquivo.trazerTodosAchados();
    out.trouxe = !!store.getById('anestesia', 'd21') && !!store.getById('pre', 'p9');
    /* e some do índice de arquivados, para não aparecer duplicado */
    out.saiuDoIndice = !arquivo.estaArquivado('anestesia', 'd21');

    store.setList('anestesia', []); store.setList('pre', []);
    return out;
  });
  assert(r.achouNosDoisCanais, 'o resgate deveria varrer o banco da clínica E o backup da conta');
  assert(r.filtraPorNome, 'nome que não existe não pode trazer registro de outro paciente');
  assert(r.trouxe, 'trazer deveria colocar o registro de volta no aparelho');
  assert(r.saiuDoIndice, 'o registro trazido não pode continuar listado como arquivado');
  await page.close();
});

/* 88) Eventos novos pedidos: sedação e sondas */
await test('Eventos: sedação e sondagens (oro/naso/vesical) entram no catálogo com descrição', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    const T = anestesia.eventos.TIPOS;
    out.temSedacao = T.includes('Sedação');
    out.temSondas = ['Sondagem orogástrica', 'Sondagem nasogástrica',
                     'Sondagem vesical (Foley)', 'Sondagem vesical de alívio'].every(x => T.includes(x));
    /* cada um traz a descrição técnica pronta */
    out.temDescricoes = ['Sedação', 'Sondagem orogástrica', 'Sondagem vesical (Foley)']
      .every(x => (anestesia.eventos.descricaoPara(x) || '').length > 40);
    out.foleyFalaDoBalao = /balão/i.test(anestesia.eventos.descricaoPara('Sondagem vesical (Foley)'));
    /* marcar "Sedação" no card 3 cria o evento de sedação, não o de indução */
    out.mapeiaTipo = anestesia.eventos.TIPO_EVENTO['Sedação'] === 'Sedação';
    return out;
  });
  assert(r.temSedacao, 'sedação deveria estar no catálogo de eventos');
  assert(r.temSondas, 'as sondagens oro, naso e vesicais deveriam estar no catálogo');
  assert(r.temDescricoes, 'cada evento novo precisa da descrição técnica pronta');
  assert(r.foleyFalaDoBalao, 'a descrição da Foley deveria citar a insuflação do balão');
  assert(r.mapeiaTipo, 'marcar Sedação no card da técnica deveria criar o evento de sedação');
  await page.close();
});

/* 89) Dashboard contava pela data em que o ARQUIVO foi salvo. Com a nuvem
   regravando registros, o dia de ontem "perdia" as anestesias. */
await test('Dashboard conta pela data do procedimento, não pela data da última gravação', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    const hoje = utils.hojeISO();
    const ontem = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
    /* ficha de ONTEM, mas regravada HOJE pela sincronização — o caso real */
    const ficha = { _id: 'f1', paciente: { nome: 'A' },
                    procedimento: { data: ontem, descricao: 'Colecistectomia' },
                    _finalizado: true, _updatedAt: new Date().toISOString() };
    out.usaDataDoProcedimento = String(dashboard._dataClinica(ficha)).slice(0, 10) === ontem;
    /* pré usa a data da avaliação */
    out.preTambem = String(dashboard._dataClinica({ _id: 'p', data_avaliacao: ontem, _updatedAt: new Date().toISOString() })).slice(0, 10) === ontem;
    /* sem data clínica, cai na data de gravação — não some do painel */
    out.semDataNaoSome = !!dashboard._dataClinica({ _id: 'x', _updatedAt: '2026-08-01T10:00:00.000Z' });

    /* o filtro de período passa a separar os dias corretamente */
    const lista = [ficha, { _id: 'f2', paciente: { nome: 'B' },
                            procedimento: { data: hoje, descricao: 'Hérnia' },
                            _updatedAt: new Date().toISOString() }]
      .map(it => Object.assign({}, it, { _dataClinica: dashboard._dataClinica(it) }));
    /* janela curta: pela data clínica, a de ontem fica de fora; pelo carimbo
       de gravação as duas entrariam, que era exatamente o defeito */
    const porClinica = dashboard.filtrarPorPeriodo(lista, '1', '_dataClinica');
    const porGravacao = dashboard.filtrarPorPeriodo(lista, '1', '_updatedAt');
    out.separaOsDias = porClinica.length === 1 && porClinica[0]._id === 'f2'
      && porGravacao.length === 2;
    return out;
  });
  assert(r.usaDataDoProcedimento, 'a ficha deveria contar na data do procedimento, não na data em que foi regravada');
  assert(r.preTambem, 'a pré deveria contar na data da avaliação');
  assert(r.semDataNaoSome, 'registro sem data clínica não pode sumir do painel');
  assert(r.separaOsDias, 'o filtro de período tem que separar ontem de hoje pela data clínica');
  await page.close();
});

/* 90) Pré-lançamento: auxiliar prepara e ENVIA; médico confere, devolve ou
   finaliza. Enviar não é salvar — o registro sobe o tempo todo. */
await test('Pré-lançamento: só entra na fila do médico depois de enviado, e pode ser devolvido', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    store.setList('pre', []); store.setList('anestesia', []);
    const auxiliar = { id: 'sec1', nome: 'Secretária', perfil: 'secretaria', role: 'auxiliar' };
    const medico = { id: 'med1', nome: 'Dr. Marcelo', perfil: 'admin', role: 'gestor' };
    auth.usuarioAtual = () => auxiliar;

    /* a auxiliar salva: vira rascunho DELA e NÃO aparece para o médico */
    const rec = store.save('pre', { nome: 'Paciente X', data_avaliacao: '2026-08-11' });
    out.nasceRascunho = preLanc.estado(store.getById('pre', rec._id)) === 'rascunho'
      && store.getById('pre', rec._id)._preLanc.porNome === 'Secretária';
    auth.usuarioAtual = () => medico;
    out.filaVaziaAntesDeEnviar = preLanc.fila().length === 0;

    /* ela envia */
    auth.usuarioAtual = () => auxiliar;
    const f = document.getElementById('form-pre');
    let hid = f.querySelector('[name="_id"]');
    if (!hid) { hid = document.createElement('input'); hid.type = 'hidden'; hid.name = '_id'; f.appendChild(hid); }
    hid.value = rec._id;
    markClean();                       /* ficha gravada: nada pendente na tela */
    preLanc.enviar('pre');
    out.enviouComCarimbo = preLanc.estado(store.getById('pre', rec._id)) === 'enviado'
      && !!store.getById('pre', rec._id)._preLanc.enviadoEm;
    /* enviar = salvar + fechar: o formulário fica limpo para o próximo */
    out.fechouAFicha = !preLanc._idAtual('pre');

    /* agora aparece na fila do médico, com quem lançou */
    auth.usuarioAtual = () => medico;
    const fila = preLanc.fila();
    out.entrouNaFila = fila.length === 1 && fila[0].por === 'Secretária' && fila[0].mod === 'pre';

    /* o médico devolve com motivo */
    window.prompt = () => 'Falta a carteirinha do convênio';
    preLanc.devolver('pre', rec._id);
    const dev = store.getById('pre', rec._id);
    out.devolveu = preLanc.estado(dev) === 'devolvido' && /carteirinha/.test(dev._preLanc.motivo);
    out.saiuDaFila = preLanc.fila().length === 0;

    /* ela mexe de novo: volta a ser rascunho e precisa reenviar */
    auth.usuarioAtual = () => auxiliar;
    store.save('pre', Object.assign({}, dev, { obs: 'corrigido' }));
    out.voltaARascunho = preLanc.estado(store.getById('pre', rec._id)) === 'rascunho';
    out.contaPendentes = preLanc.meusPendentes().rascunho.length === 1;
    hid = document.getElementById('form-pre').querySelector('[name="_id"]');   /* o envio fechou a ficha; ela reabre */
    if (!hid) {
      const f2 = document.getElementById('form-pre');
      hid = document.createElement('input'); hid.type = 'hidden'; hid.name = '_id'; f2.appendChild(hid);
    }
    hid.value = rec._id;
    markClean();
    preLanc.enviar('pre');

    /* o médico finaliza: sai da fila de vez */
    auth.usuarioAtual = () => medico;
    const atual = store.getById('pre', rec._id);
    store.save('pre', Object.assign({}, atual, { _finalizado: true }));
    const fim = store.getById('pre', rec._id);
    out.conferido = fim._preLanc.estado === 'conferido' && fim._preLanc.conferidoPor === 'Dr. Marcelo';
    out.filaLimpa = preLanc.fila().length === 0;

    /* a auxiliar nunca é tratada como médica */
    auth.usuarioAtual = () => auxiliar;
    out.papeis = preLanc.ehAuxiliar() && !preLanc.ehMedico();
    auth.usuarioAtual = () => medico;
    out.papeisMedico = preLanc.ehMedico() && !preLanc.ehAuxiliar();

    store.setList('pre', []); store.setList('anestesia', []);
    return out;
  });
  assert(r.nasceRascunho, 'o que a auxiliar salva nasce como rascunho dela, com o nome de quem lançou');
  assert(r.filaVaziaAntesDeEnviar, 'antes de enviar, nada pode aparecer para o médico');
  assert(r.enviouComCarimbo, 'enviar deveria mudar o estado e carimbar a hora');
  assert(r.fechouAFicha, 'enviar é salvar-e-fechar: a ficha tem que sair da tela');
  assert(r.entrouNaFila, 'depois de enviado, entra na fila do médico com quem lançou');
  assert(r.devolveu && r.saiuDaFila, 'devolver deveria registrar o motivo e tirar da fila');
  assert(r.voltaARascunho && r.contaPendentes, 'ao mexer de novo, volta a rascunho e conta como não enviado');
  assert(r.conferido && r.filaLimpa, 'o Finalizar do médico deveria marcar como conferido e limpar a fila');
  assert(r.papeis && r.papeisMedico, 'os papéis não podem se confundir');
  await page.close();
});

/* 91) Entrar sempre começa no Dashboard — e quem não tem acesso a ele cai no
   primeiro módulo permitido, nunca numa tela em branco. */
await test('Ao entrar, o app abre no Dashboard (ou no primeiro módulo permitido)', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    auth._aplicarPermissoesUI = () => {};
    auth._iniciarTimer = () => {};
    auth.usuarioAtual = () => ({ id: 'u', nome: 'Teste', perfil: 'admin' });

    /* estava noutro módulo antes de entrar: vai para o Dashboard mesmo assim */
    location.hash = '#anestesia';
    await new Promise(r => setTimeout(r, 60));
    auth.podeAcessar = () => true;
    auth._desbloquear();
    await new Promise(r => setTimeout(r, 120));
    out.vaiParaDashboard = location.hash === '#dashboard';

    /* secretária sem Dashboard: cai no primeiro módulo que ela pode abrir */
    location.hash = '#anestesia';
    await new Promise(r => setTimeout(r, 60));
    auth.podeAcessar = (m) => m === 'pacientes' || m === 'agenda';
    auth._desbloquear();
    await new Promise(r => setTimeout(r, 120));
    out.caiNoPermitido = location.hash === '#pacientes';

    /* já estando no Dashboard, entrar não quebra nada */
    auth.podeAcessar = () => true;
    location.hash = '#dashboard';
    await new Promise(r => setTimeout(r, 60));
    auth._desbloquear();
    await new Promise(r => setTimeout(r, 120));
    out.mantemDashboard = location.hash === '#dashboard';
    return out;
  });
  assert(r.vaiParaDashboard, 'entrar deveria abrir o Dashboard, mesmo vindo de outro módulo');
  assert(r.caiNoPermitido, 'quem não tem Dashboard deveria cair no primeiro módulo permitido');
  assert(r.mantemDashboard, 'já estando no Dashboard, entrar deveria mantê-lo');
  await page.close();
});

/* 92) Dashboard da auxiliar: só o trabalho dela, sem os números do médico */
await test('Dashboard da auxiliar mostra só pendências e pré-lançamentos', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    const aux = { id: 's1', nome: 'Secretária', perfil: 'secretaria', role: 'auxiliar' };
    const med = { id: 'm1', nome: 'Dr.', perfil: 'admin', role: 'gestor' };

    auth.usuarioAtual = () => aux;
    preLanc.ajustarDashboard();
    out.marcaAuxiliar = document.body.classList.contains('dash-auxiliar');
    const vis = (el) => !!el && getComputedStyle(el).display !== 'none';
    out.escondeAnalitico = !vis(document.getElementById('kpi-grid'))
      && !vis(document.getElementById('meu-dia-card'));
    out.subtituloProprio = /pré-lançamentos e pendências/i.test(
      document.querySelector('#module-dashboard .page-title .subtitle').textContent);

    /* cartão vazio não pode ser forçado a aparecer */
    const fila = document.getElementById('pl-fila-card');
    fila.style.display = 'none';
    out.naoForcaCartaoVazio = !vis(fila);
    /* com conteúdo, aparece normalmente */
    fila.style.display = '';
    out.mostraQuandoTemConteudo = vis(fila);

    /* médico volta a ver tudo */
    auth.usuarioAtual = () => med;
    preLanc.ajustarDashboard();
    out.medicoVeTudo = !document.body.classList.contains('dash-auxiliar')
      && vis(document.getElementById('kpi-grid'))
      && vis(document.getElementById('meu-dia-card'))
      && /analítica/i.test(document.querySelector('#module-dashboard .page-title .subtitle').textContent);
    return out;
  });
  assert(r.marcaAuxiliar, 'o Dashboard deveria entrar no modo auxiliar');
  assert(r.escondeAnalitico, 'KPIs e Meu dia não deveriam aparecer para a auxiliar');
  assert(r.subtituloProprio, 'o subtítulo deveria dizer do que é a tela dela');
  assert(r.naoForcaCartaoVazio, 'cartão sem conteúdo não pode ser forçado a aparecer');
  assert(r.mostraQuandoTemConteudo, 'com conteúdo, o cartão dela precisa aparecer');
  assert(r.medicoVeTudo, 'o médico continua com o Dashboard analítico completo');
  await page.close();
});

/* 93) Dashboard: escopo (pessoal/clínica) e os períodos pedidos */
await test('Dashboard tem escopo pessoal/clínica e períodos hoje/semana/mês/6m/12m/tudo', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    const opts = (id) => Array.from(document.querySelectorAll('#' + id + ' option')).map(o => o.value);
    out.temEscopo = opts('dash-escopo').join(',') === 'pessoal,clinica';
    out.temPeriodos = opts('dash-periodo').join(',') === 'hoje,7,30,180,365,all';

    /* "Hoje" é o dia do calendário: ficha das 8h continua contando às 23h */
    const hoje = utils.hojeISO();
    const ontem = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const lista = [
      { _id: 'a', _dataClinica: hoje + 'T08:00:00.000Z' },
      { _id: 'b', _dataClinica: ontem + 'T23:00:00.000Z' }
    ];
    const doDia = dashboard.filtrarPorPeriodo(lista, 'hoje', '_dataClinica');
    out.hojeEhOdia = doDia.length === 1 && doDia[0]._id === 'a';
    out.tudoNaoFiltra = dashboard.filtrarPorPeriodo(lista, 'all', '_dataClinica').length === 2;

    /* escopo pessoal separa por autoria; clínica traz tudo */
    auth.usuarioAtual = () => ({ nome: 'Dr. Marcelo', usuario: 'mpcaliman' });
    const regs = [
      { _id: '1', _updatedBy: 'mpcaliman' },
      { _id: '2', _updatedBy: 'secretaria' },
      { _id: '3' }                                   /* sem autoria: conta como meu */
    ];
    const meus = dashboard._filtrarEscopo(regs, 'pessoal').map(x => x._id);
    out.pessoal = meus.join(',') === '1,3';
    out.clinica = dashboard._filtrarEscopo(regs, 'clinica').length === 3;
    return out;
  });
  assert(r.temEscopo, 'deveria existir o seletor pessoal/clínica');
  assert(r.temPeriodos, 'os períodos deveriam ser hoje, semana, mês, 6 e 12 meses e tudo');
  assert(r.hojeEhOdia, '"Hoje" tem que ser o dia do calendário, não as últimas 24 h');
  assert(r.tudoNaoFiltra, '"Tudo" não pode filtrar nada');
  assert(r.pessoal, 'pessoal deveria trazer os meus e os sem autoria registrada');
  assert(r.clinica, 'clínica deveria trazer tudo');
  await page.close();
});

/* 94) O painel tem que contar o que está na nuvem — e dizer o que fica de fora */
await test('Dashboard soma os registros que estão na nuvem e avisa o que não entra nos gráficos', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    const hoje = utils.hojeISO();
    const antigo = '2020-03-01';
    localStorage.setItem(arquivo.INDEX_KEY, JSON.stringify({
      anestesia: [{ id: 'n1', nome: 'A', data: hoje }, { id: 'n2', nome: 'B', data: antigo }],
      pre: [{ id: 'n3', nome: 'C', data: hoje }]
    }));

    /* respeita o período: só o de hoje entra em "Hoje" */
    const hojeN = dashboard._naNuvem('hoje', 'clinica');
    out.respeitaPeriodo = hojeN.total === 2 && hojeN.porMod.anestesia === 1 && hojeN.porMod.pre === 1;
    const tudoN = dashboard._naNuvem('all', 'clinica');
    out.tudoSomaGeral = tudoN.total === 3 && tudoN.porMod.anestesia === 2;

    /* o aviso aparece e diz o que fica de fora */
    dashboard._avisoNuvem(hojeN);
    const av = document.getElementById('dash-aviso-nuvem');
    out.avisa = av.style.display !== 'none'
      && /entram nos totais/.test(av.textContent)
      && /não nos gráficos/.test(av.textContent)
      && /2/.test(av.textContent);
    /* e some quando não há nada fora do aparelho */
    dashboard._avisoNuvem({ porMod: {}, total: 0 });
    out.somenteQuandoPreciso = av.style.display === 'none';

    localStorage.removeItem(arquivo.INDEX_KEY);
    out.semIndiceZero = dashboard._naNuvem('all', 'clinica').total === 0;
    return out;
  });
  assert(r.respeitaPeriodo, 'o que está na nuvem tem que respeitar o período escolhido');
  assert(r.tudoSomaGeral, 'em "Tudo", todos os registros da nuvem deveriam contar');
  assert(r.avisa, 'o painel precisa dizer quantos estão na nuvem e o que não entra nos gráficos');
  assert(r.somenteQuandoPreciso, 'sem nada fora do aparelho, o aviso não deveria aparecer');
  assert(r.semIndiceZero, 'sem índice, a conta da nuvem é zero — não pode quebrar');
  await page.close();
});

/* 95) O botão de enviar pré-lançamento não aparecia: o rodapé é montado no
   boot, quando ninguém está logado ainda. Tem que ser recalculado depois. */
await test('Botão de enviar pré-lançamento aparece para a auxiliar em pré e ficha', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    const aux = { id: 's1', nome: 'Secretária', perfil: 'secretaria', role: 'auxiliar' };
    const med = { id: 'm1', nome: 'Dr.', perfil: 'admin', role: 'gestor' };

    /* no boot ninguém está logado: o botão não existe — era aqui que parava */
    auth.usuarioAtual = () => null;
    ['pre', 'anestesia'].forEach(m => preLanc.renderBotao(m));
    out.semLoginNaoTem = !document.getElementById('pl-btn-pre');

    /* ela entra: os dois módulos ganham o botão */
    auth.usuarioAtual = () => aux;
    ['pre', 'anestesia'].forEach(m => preLanc.renderBotao(m));
    out.preTem = !!document.getElementById('pl-btn-pre')
      && /Enviar pré-lançamento/.test(document.getElementById('pl-btn-pre').textContent);
    out.fichaTem = !!document.getElementById('pl-btn-anestesia')
      && /Enviar pré-lançamento/.test(document.getElementById('pl-btn-anestesia').textContent);
    const btn = document.getElementById('pl-btn-pre');
    /* fica no módulo, mas FORA do form: dentro dele o modo "edição parcial"
       aplica pointer-events:none e o toque nunca acontece */
    out.dentroDoRodape = !!btn && !!btn.closest('#module-pre') && !btn.closest('#form-pre');

    /* recalcular não duplica */
    preLanc.renderBotao('pre');
    out.naoDuplica = document.querySelectorAll('[id="pl-btn-pre"]').length === 1
      && document.querySelectorAll('[id="pl-host-pre"]').length <= 1;

    /* o médico não vê */
    auth.usuarioAtual = () => med;
    ['pre', 'anestesia'].forEach(m => preLanc.renderBotao(m));
    out.medicoNaoVe = !document.getElementById('pl-btn-pre') && !document.getElementById('pl-btn-anestesia');

    /* atualizarDocStatus (salvar/carregar/novo) recalcula sozinho */
    auth.usuarioAtual = () => aux;
    ui.atualizarDocStatus('pre', null);
    out.recalculaAoSalvar = !!document.getElementById('pl-btn-pre');
    return out;
  });
  assert(r.semLoginNaoTem, 'sem usuário logado o botão não deve existir');
  assert(r.preTem && r.fichaTem, 'a auxiliar deveria ver o botão na pré E na ficha de anestesia');
  assert(r.dentroDoRodape, 'o botão fica no módulo mas FORA do formulário, senão a edição parcial o trava');
  assert(r.naoDuplica, 'recalcular não pode duplicar o botão');
  assert(r.medicoNaoVe, 'o médico não envia pré-lançamento — ele confere');
  assert(r.recalculaAoSalvar, 'salvar/carregar deveria recalcular o botão sozinho');
  await page.close();
});

/* 96) Enviar sem ter salvado antes não pode ser um beco: enviar implica salvar */
await test('Enviar pré-lançamento salva a ficha antes, em vez de não fazer nada', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    store.setList('pre', []);
    auth.usuarioAtual = () => ({ id: 's1', nome: 'Sec', perfil: 'secretaria', role: 'auxiliar' });
    const f = document.getElementById('form-pre');
    let hid = f.querySelector('[name="_id"]');
    if (hid) hid.value = '';

    /* sem registro salvo: enviar chama o salvar do módulo e continua */
    let salvou = 0;
    const orig = pre.salvar;
    pre.salvar = () => {
      salvou++;
      const rec = store.save('pre', { nome: 'Nova' });
      let h = f.querySelector('[name="_id"]');
      if (!h) { h = document.createElement('input'); h.type = 'hidden'; h.name = '_id'; f.appendChild(h); }
      h.value = rec._id;
      markClean();                     /* como o salvar de verdade faz */
    };
    preLanc.enviar('pre');
    pre.salvar = orig;
    out.salvouSozinho = salvou === 1;
    const rec = store.list('pre')[0];
    out.enviouMesmoAssim = preLanc.estado(rec) === 'enviado';

    /* ficha já finalizada pelo médico não pode ser reenviada */
    const fin = store.save('pre', { _id: rec._id, nome: 'Nova', _finalizado: true });
    let h2 = f.querySelector('[name="_id"]');    /* o envio anterior fechou a ficha; ela reabre */
    if (!h2) { h2 = document.createElement('input'); h2.type = 'hidden'; h2.name = '_id'; f.appendChild(h2); }
    h2.value = rec._id;
    markClean();
    let erro = '';
    const tOrig = window.toast;
    window.toast = (m, t) => { if (t === 'warn') erro = m; };
    preLanc.enviar('pre');
    window.toast = tOrig;
    out.naoReenviaFinalizada = /já foi finalizada/.test(erro);

    store.setList('pre', []);
    return out;
  });
  assert(r.salvouSozinho, 'enviar sem ter salvado deveria salvar primeiro');
  assert(r.enviouMesmoAssim, 'depois de salvar, o envio tem que acontecer');
  assert(r.naoReenviaFinalizada, 'ficha já finalizada pelo médico não volta para a fila');
  await page.close();
});

/* 97) O botão não pode depender de variável global: se o boot falhar antes de
   publicá-la, o onclick vira um botão morto — sem erro, sem aviso. */
await test('O clique do enviar é ligado direto no botão, sem depender do window', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    auth.usuarioAtual = () => ({ id: 's1', nome: 'Sec', perfil: 'secretaria', role: 'auxiliar' });
    preLanc.renderBotao('pre');
    const btn = document.querySelector('#pl-btn-pre button');
    out.temBotao = !!btn;
    /* nada de onclick no HTML — o vínculo é por listener */
    out.semOnclickNoHTML = !!btn && !btn.getAttribute('onclick');

    /* mesmo sem preLanc publicado no window, o clique funciona */
    const salvo = window.preLanc;
    let chamou = false;
    const orig = preLanc.enviar;
    preLanc.enviar = () => { chamou = true; };
    delete window.preLanc;
    btn.click();
    window.preLanc = salvo;
    preLanc.enviar = orig;
    out.funcionaSemGlobal = chamou;

    /* e um erro dentro do envio vira aviso, não silêncio */
    let erro = '';
    const tOrig = window.toast;
    window.toast = (m, t) => { if (t === 'error') erro = m; };
    const orig2 = preLanc.enviar;
    preLanc.enviar = () => { throw new Error('falha de teste'); };
    document.querySelector('#pl-btn-pre button').click();
    preLanc.enviar = orig2;
    window.toast = tOrig;
    out.erroVisivel = /falha de teste/.test(erro);
    return out;
  });
  assert(r.temBotao, 'o botão deveria existir para a auxiliar');
  assert(r.semOnclickNoHTML, 'o clique não pode ser um atributo onclick no HTML');
  assert(r.funcionaSemGlobal, 'o botão precisa funcionar mesmo sem a variável global publicada');
  assert(r.erroVisivel, 'erro no envio tem que virar aviso, nunca silêncio');
  await page.close();
});

/* 98) A CAUSA REAL: no modo "edição parcial" o app aplica pointer-events:none
   em todo botão dentro do formulário. O botão existia, aparecia, e o toque
   simplesmente não acontecia — nem clique, nem erro. */
await test('Edição parcial não pode travar o botão de enviar pré-lançamento', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    auth.usuarioAtual = () => ({ id: 's1', nome: 'Sec', perfil: 'secretaria', role: 'auxiliar' });
    const mod = document.getElementById('module-pre');
    mod.classList.add('edicao-parcial');           /* é o estado real dela */
    preLanc.renderBotao('pre');

    const btn = document.querySelector('#pl-btn-pre button');
    out.existe = !!btn;
    /* fora do formulário — é o que impede a regra de travar o botão */
    out.foraDoForm = !!btn && !btn.closest('#form-pre');
    /* e, mesmo assim, garantido clicável */
    out.clicavel = !!btn && getComputedStyle(btn).pointerEvents !== 'none' && !btn.disabled;
    /* um botão qualquer DENTRO do form continua travado — a regra segue valendo */
    const dentro = document.querySelector('#form-pre button');
    out.regraContinua = !dentro || getComputedStyle(dentro).pointerEvents === 'none';
    /* o clique chega mesmo com a classe ativa */
    let chamou = false;
    const orig = preLanc.enviar;
    preLanc.enviar = () => { chamou = true; };
    btn.click();
    preLanc.enviar = orig;
    out.cliqueChega = chamou;

    mod.classList.remove('edicao-parcial');
    return out;
  });
  assert(r.existe, 'o botão precisa existir no modo edição parcial');
  assert(r.foraDoForm, 'o botão tem que ficar fora do formulário para escapar da trava');
  assert(r.clicavel, 'o botão não pode ficar com pointer-events desligado');
  assert(r.regraContinua, 'a trava dos campos do médico continua valendo');
  assert(r.cliqueChega, 'o clique tem que chegar à função mesmo em edição parcial');
  await page.close();
});

/* 99) Enviar é um ato só: salva, manda e fecha. E se a gravação não passar,
   NÃO fecha — fechar ali jogaria fora o que ela acabou de digitar. */
await test('Enviar salva, fecha a ficha e volta ao Dashboard — mas não fecha se não conseguiu salvar', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    store.setList('pre', []);
    auth.usuarioAtual = () => ({ id: 's1', nome: 'Sec', perfil: 'secretaria', role: 'auxiliar' });
    auth.podeAcessar = () => true;
    const f = document.getElementById('form-pre');
    const setId = v => {
      let h = f.querySelector('[name="_id"]');
      if (!h) { h = document.createElement('input'); h.type = 'hidden'; h.name = '_id'; f.appendChild(h); }
      h.value = v;
    };

    /* caminho feliz: salva, fecha e vai para o Dashboard */
    const rec = store.save('pre', { nome: 'Ana', data: '2026-08-12' });
    setId(rec._id);
    let salvou = 0;
    const orig = pre.salvar;
    pre.salvar = () => { salvou++; markClean(); };
    preLanc.enviar('pre');
    pre.salvar = orig;
    out.salvouAntes = salvou === 1;                       /* salva SEMPRE, não só quando falta id */
    out.enviou = preLanc.estado(store.getById('pre', rec._id)) === 'enviado';
    out.fechou = !preLanc._idAtual('pre');
    out.foiProDashboard = (document.getElementById('module-dashboard') || {}).classList
      ? document.getElementById('module-dashboard').classList.contains('active') : false;

    /* gravação que não passou (campo obrigatório em branco): não fecha nem envia */
    const rec2 = store.save('pre', { nome: 'Bia', data: '2026-08-12' });
    setId(rec2._id);
    const orig2 = pre.salvar;
    pre.salvar = () => {};                                 /* falhou: state.dirty continua */
    state.dirty = true;
    let aviso = '';
    const tOrig = window.toast;
    window.toast = (m, t) => { if (t === 'warn') aviso = m; };
    preLanc.enviar('pre');
    window.toast = tOrig;
    pre.salvar = orig2;
    out.avisouQueNaoSalvou = /confira os campos obrigat/i.test(aviso);
    out.naoEnviouSemSalvar = preLanc.estado(store.getById('pre', rec2._id)) !== 'enviado';
    out.naoFechou = preLanc._idAtual('pre') === rec2._id;
    markClean();

    store.setList('pre', []);
    return out;
  });
  assert(r.salvouAntes, 'enviar tem que salvar o que está na tela antes de fechar');
  assert(r.enviou && r.fechou, 'depois de enviar, a ficha sai da tela');
  assert(r.foiProDashboard, 'ao fechar, a auxiliar volta para o Dashboard dela');
  assert(r.avisouQueNaoSalvou, 'se a gravação não passou, ela precisa saber');
  assert(r.naoEnviouSemSalvar && r.naoFechou, 'sem salvar não se envia nem se fecha — o que ela digitou não pode sumir');
  await page.close();
});

/* 100) Devolver dentro da ficha: quem confere decide ali, sem ter que fechar o
   que está lendo e caçar o item na lista do Dashboard. */
await test('Devolver aparece dentro da ficha para o médico, não só no Dashboard', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    store.setList('pre', []);
    const f = document.getElementById('form-pre');
    const setId = v => {
      let h = f.querySelector('[name="_id"]');
      if (!h) { h = document.createElement('input'); h.type = 'hidden'; h.name = '_id'; f.appendChild(h); }
      h.value = v;
    };
    /* uma ficha enviada pela auxiliar */
    auth.usuarioAtual = () => ({ id: 's1', nome: 'Sec', perfil: 'secretaria', role: 'auxiliar' });
    const rec = store.save('pre', { nome: 'Ana', data: '2026-08-12' });
    rec._preLanc.estado = 'enviado';
    rec._preLanc.enviadoEm = new Date().toISOString();
    store.setList('pre', store.list('pre').map(x => x._id === rec._id ? rec : x));
    setId(rec._id);

    /* para ela, nada de devolver — o botão dela é o de enviar */
    preLanc.renderBotao('pre');
    out.auxNaoDevolve = !document.querySelector('#pl-btn-pre .pl-conf');

    /* para o médico, a faixa com quem lançou e o botão de devolver */
    auth.usuarioAtual = () => ({ id: 'm1', nome: 'Dr.', perfil: 'admin', role: 'gestor' });
    preLanc.renderBotao('pre');
    const faixa = document.querySelector('#pl-btn-pre .pl-conf');
    out.temFaixa = !!faixa && /Sec/.test(faixa.textContent);
    const btn = faixa && Array.from(faixa.querySelectorAll('button'))
      .find(b => /devolver/i.test(b.textContent));
    out.temBotao = !!btn;
    out.clicavel = !!btn && getComputedStyle(btn).pointerEvents !== 'none';

    /* clicar devolve de verdade, com o motivo, e mantém a ficha aberta */
    window.prompt = () => 'Falta o peso';
    if (btn) btn.click();
    const dev = store.getById('pre', rec._id);
    out.devolveu = preLanc.estado(dev) === 'devolvido' && /peso/.test(dev._preLanc.motivo || '');
    out.continuaAberta = preLanc._idAtual('pre') === rec._id;
    /* e a faixa passa a dizer que está devolvido */
    const faixa2 = document.querySelector('#pl-btn-pre .pl-conf');
    out.faixaVirouDevolvido = !!faixa2 && /devolvid/i.test(faixa2.textContent) && /peso/.test(faixa2.textContent);

    /* ficha sem pré-lançamento nenhum: nada aparece */
    const solta = store.save('pre', { nome: 'Sem fila', data: '2026-08-12' });
    setId(solta._id);
    preLanc.renderBotao('pre');
    out.semPreLancNadaAparece = !document.querySelector('#pl-btn-pre .pl-conf');

    store.setList('pre', []);
    return out;
  });
  assert(r.auxNaoDevolve, 'quem pré-lança não devolve para si mesma');
  assert(r.temFaixa && r.temBotao, 'o médico precisa ver, dentro da ficha, quem lançou e o botão de devolver');
  assert(r.clicavel, 'o botão de devolver não pode ficar travado');
  assert(r.devolveu, 'o clique tem que devolver de verdade, com o motivo');
  assert(r.continuaAberta, 'devolver de dentro da ficha não pode fechar o que ele está lendo');
  assert(r.faixaVirouDevolvido, 'depois de devolver, a faixa mostra o estado novo');
  assert(r.semPreLancNadaAparece, 'ficha que ninguém pré-lançou não mostra faixa de conferência');
  await page.close();
});

/* 101) O aviso no alto do Dashboard dela: o que voltou devolvido e o que ainda
   não foi enviado. O cartão da lista ficava dentro da grade — e a grade some
   inteira para quem só pré-lança. */
await test('Dashboard da auxiliar avisa, no topo, o que foi devolvido e o que falta enviar', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    store.setList('pre', []); store.setList('anestesia', []);
    const aux = { id: 's1', nome: 'Sec', perfil: 'secretaria', role: 'auxiliar' };
    auth.usuarioAtual = () => aux;

    /* sem nada pendente, o aviso não aparece */
    preLanc.renderFila();
    const host = document.getElementById('pl-alerta');
    out.existeHost = !!host;
    out.calaQuandoNaoTemNada = !!host && host.style.display === 'none';

    /* um devolvido e um não enviado */
    const a = store.save('pre', { nome: 'Ana', data: '2026-08-12' });
    a._preLanc.estado = 'devolvido'; a._preLanc.motivo = 'Falta a carteirinha';
    store.setList('pre', store.list('pre').map(x => x._id === a._id ? a : x));
    store.save('anestesia', { nome: 'Bia', data: '2026-08-12' });

    preLanc.renderFila();
    out.apareceu = !!host && host.style.display !== 'none';
    const txt = host ? host.textContent : '';
    out.falaDoDevolvido = /devolvid/i.test(txt) && /carteirinha/.test(txt);
    out.falaDoNaoEnviado = /não enviado/i.test(txt);
    out.temAtalho = !!host && host.querySelectorAll('button').length >= 2;

    /* o cartão da lista tem que ficar FORA da grade que some para ela */
    const card = document.getElementById('pl-fila-card');
    out.cardForaDaGrade = !!card && !card.closest('.dash-grid');
    preLanc.ajustarDashboard();
    out.cardVisivelParaEla = !!card && card.offsetParent !== null;

    /* para o médico, o aviso dela não aparece */
    auth.usuarioAtual = () => ({ id: 'm1', nome: 'Dr.', perfil: 'admin', role: 'gestor' });
    preLanc.renderFila();
    out.medicoNaoVeOAviso = !!host && host.style.display === 'none';

    store.setList('pre', []); store.setList('anestesia', []);
    return out;
  });
  assert(r.existeHost, 'o Dashboard precisa ter onde mostrar o aviso');
  assert(r.calaQuandoNaoTemNada, 'sem pendência, o aviso fica calado');
  assert(r.apareceu, 'com pendência, o aviso aparece');
  assert(r.falaDoDevolvido, 'o aviso tem que dizer o que foi devolvido e por quê');
  assert(r.falaDoNaoEnviado, 'o aviso tem que lembrar o que ainda não foi enviado');
  assert(r.temAtalho, 'de cada aviso ela precisa conseguir abrir a ficha');
  assert(r.cardForaDaGrade, 'o cartão dela não pode morar na grade de gráficos, que some para ela');
  assert(r.cardVisivelParaEla, 'o cartão de pré-lançamentos precisa aparecer no Dashboard dela');
  assert(r.medicoNaoVeOAviso, 'o aviso é do trabalho dela; para o médico ele não aparece');
  await page.close();
});

/* 102) A sincronização era só de inserção: o registro que JÁ existia aqui era
   descartado, por mais novo que estivesse na clínica. Era por isso que o
   pré-lançamento enviado por ela nunca chegava no aparelho dele. */
await test('O que já existe no aparelho também se atualiza — a versão mais nova da clínica vence', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    store.setList('pre', []);
    const f = document.getElementById('form-pre');
    const setId = v => {
      let h = f.querySelector('[name="_id"]');
      if (!h) { h = document.createElement('input'); h.type = 'hidden'; h.name = '_id'; f.appendChild(h); }
      h.value = v;
    };
    setId('');

    /* o aparelho dele tem a versão rascunho; a clínica tem a versão enviada */
    store.setList('pre', [
      { _id: 'a', nome: 'Ana', _updatedAt: '2026-08-13T10:00:00.000Z',
        _preLanc: { estado: 'rascunho', porNome: 'Sec' } },
      { _id: 'b', nome: 'Bia', _updatedAt: '2026-08-13T12:00:00.000Z', obs: 'editei aqui agora' }
    ]);
    const m = cloudRel.mesclarLocal('pre', [
      { _id: 'a', nome: 'Ana', _updatedAt: '2026-08-13T11:00:00.000Z',
        _preLanc: { estado: 'enviado', porNome: 'Sec' } },                 /* mais nova: entra */
      { _id: 'b', nome: 'Bia', _updatedAt: '2026-08-13T09:00:00.000Z' },   /* mais velha: não */
      { _id: 'c', nome: 'Caio', _updatedAt: '2026-08-13T11:30:00.000Z' }   /* nova: insere */
    ]);
    out.contou = m.novos === 1 && m.atualizados === 1 && m.iguais === 1;
    out.atualizouOEnviado = preLanc.estado(store.getById('pre', 'a')) === 'enviado';
    out.naoPisouNoMaisNovo = (store.getById('pre', 'b') || {}).obs === 'editei aqui agora';
    out.trouxeONovo = !!store.getById('pre', 'c');
    out.entraNaFila = preLanc.fila().some(x => x.rec._id === 'a');

    /* registro ABERTO na tela não é trocado por baixo de quem está digitando */
    setId('a');
    const m2 = cloudRel.mesclarLocal('pre', [
      { _id: 'a', nome: 'Ana', _updatedAt: '2026-08-13T13:00:00.000Z', obs: 'da nuvem' }
    ]);
    out.adiouOAberto = m2.adiados === 1 && (store.getById('pre', 'a') || {}).obs !== 'da nuvem';
    setId('');

    store.setList('pre', []);
    return out;
  });
  assert(r.contou, 'a mescla precisa separar o que é novo, o que atualizou e o que já estava igual');
  assert(r.atualizouOEnviado, 'a versão enviada da clínica tem que substituir o rascunho local');
  assert(r.naoPisouNoMaisNovo, 'o que foi editado aqui e é mais recente não pode ser sobrescrito');
  assert(r.trouxeONovo, 'registro que não existe aqui continua sendo trazido');
  assert(r.entraNaFila, 'depois de atualizado, o pré-lançamento entra na fila do médico');
  assert(r.adiouOAberto, 'registro aberto na tela não pode ser trocado por baixo de quem está digitando');
  await page.close();
});

/* 103) A fila é lida do que está NESTE aparelho — então ela precisa ir buscar
   sozinha, senão o médico espera um envio que já aconteceu. */
await test('A fila do médico vai buscar os pré-lançamentos na clínica sozinha', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    store.setList('pre', []); store.setList('anestesia', []);
    auth.usuarioAtual = () => ({ id: 'm1', nome: 'Dr.', perfil: 'admin', role: 'gestor' });

    /* clínica de mentira: devolve um pré-lançamento enviado */
    const pedidos = [];
    const origDisp = cloudRel.disponivel, origPuxa = cloudRel.puxarModulo, origTok = cloud._garantirToken;
    const origCfg = cloud.estaConfigurado, origLog = cloud.estaLogado, origExp = cloud.sessaoExpirada;
    cloudRel.disponivel = () => true;
    cloud._garantirToken = async () => true;
    cloud.estaConfigurado = () => true; cloud.estaLogado = () => true; cloud.sessaoExpirada = () => false;
    cloudRel.puxarModulo = async (mod) => {
      pedidos.push(mod);
      return mod === 'pre'
        ? [{ _id: 'z1', nome: 'Teste', data: '2026-08-13', _updatedAt: '2026-08-13T12:00:00.000Z',
             _preLanc: { estado: 'enviado', porNome: 'mpcanestesiologia', enviadoEm: '2026-08-13T12:00:00.000Z' } }]
        : [];
    };

    preLanc._ultimaBusca = 0;
    const res = await preLanc.sincronizarFila({ forcar: true, silent: true });
    out.perguntouNosDois = pedidos.indexOf('pre') >= 0 && pedidos.indexOf('anestesia') >= 0;
    out.trouxe = !!res && res.novos === 1;
    out.entrouNaFila = preLanc.fila().some(x => x.rec._id === 'z1');
    const card = document.getElementById('pl-fila-card');
    out.mostrouOCartao = !!card && card.style.display !== 'none' && /Teste/.test(card.textContent);

    /* não fica batendo na nuvem a cada render: uma vez por minuto basta */
    pedidos.length = 0;
    await preLanc.sincronizarFila({ silent: true });
    out.naoRepete = pedidos.length === 0;

    cloudRel.disponivel = origDisp; cloudRel.puxarModulo = origPuxa; cloud._garantirToken = origTok;
    cloud.estaConfigurado = origCfg; cloud.estaLogado = origLog; cloud.sessaoExpirada = origExp;
    store.setList('pre', []); store.setList('anestesia', []);
    return out;
  });
  assert(r.perguntouNosDois, 'tem que buscar tanto a pré quanto a ficha de anestesia');
  assert(r.trouxe, 'o que está na clínica e não aqui precisa ser trazido');
  assert(r.entrouNaFila && r.mostrouOCartao, 'o pré-lançamento enviado tem que aparecer na fila sem ninguém mandar');
  assert(r.naoRepete, 'a busca automática não pode virar uma consulta a cada render');
  await page.close();
});

/* 104) "Era pra aparecer 13 e aparecem 8." Sem conferir as contas, não dá para
   saber se o que falta não CHEGOU aqui ou não SUBIU no aparelho de quem
   lançou. O app tem os dois números — então que ele diga. */
await test('Quando a conta não fecha, o app diz de que lado o pré-lançamento parou', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    store.setList('pre', []); store.setList('anestesia', []);
    const origDisp = cloudRel.disponivel, origPuxa = cloudRel.puxarModulo, origTok = cloud._garantirToken;
    const origCfg = cloud.estaConfigurado, origLog = cloud.estaLogado, origExp = cloud.sessaoExpirada;
    cloudRel.disponivel = () => true;
    cloud._garantirToken = async () => true;
    cloud.estaConfigurado = () => true; cloud.estaLogado = () => true; cloud.sessaoExpirada = () => false;

    /* LADO DELE: a clínica tem 3 enviados, mas só 1 coube no aparelho */
    auth.usuarioAtual = () => ({ id: 'm1', nome: 'Dr.', perfil: 'admin', role: 'gestor' });
    const naNuvem = ['n1', 'n2', 'n3'].map((id, i) => ({
      _id: id, nome: 'P' + i, data: '2026-08-13', _updatedAt: '2026-08-13T12:0' + i + ':00.000Z',
      _preLanc: { estado: 'enviado', porNome: 'Sec', enviadoEm: '2026-08-13T12:00:00.000Z' }
    }));
    cloudRel.puxarModulo = async (mod) => (mod === 'pre' ? naNuvem : []);
    /* o aparelho aceita gravar só o primeiro (simula falta de espaço) */
    const origSet = store.setList;
    store.setList = (m, arr) => origSet.call(store, m, m === 'pre' ? (arr || []).slice(0, 1) : arr);
    preLanc._ultimaBusca = 0;
    const res = await preLanc.sincronizarFila({ forcar: true, silent: true });
    store.setList = origSet;
    out.viuTresNaClinica = !!res && res.naClinica === 3;
    out.percebeuQueFaltou = !!res && res.naoCouberam >= 1;
    preLanc.renderFila();
    const card = document.getElementById('pl-fila-card');
    const txt = card ? card.textContent : '';
    out.explicouParaEle = /A clínica tem/.test(txt) && /3/.test(txt);

    /* LADO DELA: enviou, mas o registro nunca subiu (sem _relUpdatedAt) */
    store.setList('pre', [{
      _id: 'x1', nome: 'Ana', data: '2026-08-13', _updatedAt: '2026-08-13T12:00:00.000Z',
      _preLanc: { estado: 'enviado', por: 's1', porNome: 'Sec', enviadoEm: '2026-08-13T12:00:00.000Z' }
    }]);
    auth.usuarioAtual = () => ({ id: 's1', nome: 'Sec', perfil: 'secretaria', role: 'auxiliar' });
    out.achouOPreso = preLanc.naoSubiram().length === 1;
    preLanc.renderFila();
    const alerta = document.getElementById('pl-alerta');
    out.avisouAEla = !!alerta && alerta.style.display !== 'none' && /não chegou/.test(alerta.textContent);
    out.temBotaoSubir = !!alerta && /Subir agora/.test(alerta.innerHTML);

    /* o que já subiu não fica cobrando */
    store.setList('pre', store.list('pre').map(x => Object.assign({}, x, { _relUpdatedAt: '2026-08-13T12:00:01Z' })));
    out.paraDeCobrarDepoisDeSubir = preLanc.naoSubiram().length === 0;

    cloudRel.disponivel = origDisp; cloudRel.puxarModulo = origPuxa; cloud._garantirToken = origTok;
    cloud.estaConfigurado = origCfg; cloud.estaLogado = origLog; cloud.sessaoExpirada = origExp;
    preLanc._diag = null;
    store.setList('pre', []); store.setList('anestesia', []);
    return out;
  });
  assert(r.viuTresNaClinica, 'a busca precisa saber quantos existem na clínica, não só quantos entraram');
  assert(r.percebeuQueFaltou, 'registro que não coube no aparelho não pode sumir em silêncio');
  assert(r.explicouParaEle, 'o cartão tem que dizer que a clínica tem mais do que apareceu aqui');
  assert(r.achouOPreso, 'enviado sem espelho na clínica precisa ser identificado');
  assert(r.avisouAEla, 'ela precisa saber que o envio dela não chegou no médico');
  assert(r.temBotaoSubir, 'e precisa conseguir resolver com um toque');
  assert(r.paraDeCobrarDepoisDeSubir, 'depois de subir, o aviso some');
  await page.close();
});

/* 105) Botão que não responde nada é indistinguível de botão quebrado. O
   "Buscar" saía calado em todo caminho de erro — sem nuvem, sem sessão, sem
   clínica. Agora todo caminho fala, e o clique é ligado no próprio botão. */
await test('O botão Buscar da fila responde sempre — inclusive quando não dá para buscar', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    store.setList('pre', []); store.setList('anestesia', []);
    auth.usuarioAtual = () => ({ id: 'm1', nome: 'Dr.', perfil: 'admin', role: 'gestor' });
    preLanc.renderFila();
    const btn = document.getElementById('pl-buscar-btn');
    out.existe = !!btn;
    out.semOnclickNoHtml = !!btn && !btn.getAttribute('onclick');

    /* o clique chega à função */
    let chamou = 0;
    const orig = preLanc.sincronizarFila;
    preLanc.sincronizarFila = async () => { chamou++; };
    btn.click();
    await new Promise(r2 => setTimeout(r2, 0));
    preLanc.sincronizarFila = orig;
    out.cliqueChega = chamou === 1;

    /* ligar duas vezes não pode disparar duas buscas */
    preLanc.renderFila(); preLanc.renderFila();
    let chamou2 = 0;
    const orig2 = preLanc.sincronizarFila;
    preLanc.sincronizarFila = async () => { chamou2++; };
    document.getElementById('pl-buscar-btn').click();
    await new Promise(r2 => setTimeout(r2, 0));
    preLanc.sincronizarFila = orig2;
    out.naoDuplicaOClique = chamou2 === 1;

    /* sem nuvem configurada: fala em vez de sair calado */
    const avisos = [];
    const tOrig = window.toast;
    window.toast = (m) => { avisos.push(String(m)); };
    const origCfg = cloud.estaConfigurado;
    cloud.estaConfigurado = () => false;
    preLanc._ultimaBusca = 0;
    await preLanc.sincronizarFila({ forcar: true });
    out.avisaSemNuvem = avisos.some(m => /não está conectado à nuvem/i.test(m));

    /* sessão vencida: fala e chama o login de volta */
    avisos.length = 0;
    cloud.estaConfigurado = () => true;
    const origLog = cloud.estaLogado, origRe = cloud.reentrar;
    let pediuLogin = 0;
    cloud.estaLogado = () => false;
    cloud.reentrar = () => { pediuLogin++; };
    preLanc._ultimaBusca = 0;
    await preLanc.sincronizarFila({ forcar: true });
    out.avisaSessao = avisos.some(m => /sessão da nuvem vencida/i.test(m)) && pediuLogin === 1;

    /* deu tudo certo e não havia nada novo: também fala */
    avisos.length = 0;
    cloud.estaLogado = () => true;
    const origExp = cloud.sessaoExpirada, origDisp = cloudRel.disponivel,
          origTok = cloud._garantirToken, origPuxa = cloudRel.puxarModulo;
    cloud.sessaoExpirada = () => false;
    cloudRel.disponivel = () => true;
    cloud._garantirToken = async () => true;
    cloudRel.puxarModulo = async () => [];
    preLanc._ultimaBusca = 0;
    await preLanc.sincronizarFila({ forcar: true });
    out.avisaQuandoNaoTemNada = avisos.some(m => /em dia/i.test(m));

    /* a clínica caiu no meio: não pode ficar mudo nem mentir que está em dia */
    avisos.length = 0;
    cloudRel.puxarModulo = async () => null;
    preLanc._ultimaBusca = 0;
    await preLanc.sincronizarFila({ forcar: true });
    out.avisaFalhaDeLeitura = avisos.some(m => /não consegui ler a clínica/i.test(m));

    window.toast = tOrig;
    cloud.estaConfigurado = origCfg; cloud.estaLogado = origLog; cloud.reentrar = origRe;
    cloud.sessaoExpirada = origExp; cloudRel.disponivel = origDisp;
    cloud._garantirToken = origTok; cloudRel.puxarModulo = origPuxa;
    preLanc._diag = null;
    store.setList('pre', []); store.setList('anestesia', []);
    return out;
  });
  assert(r.existe, 'o cartão da fila precisa do botão de buscar');
  assert(r.semOnclickNoHtml, 'o clique tem que ser ligado no botão, não por atributo no HTML');
  assert(r.cliqueChega, 'o clique precisa chegar à função');
  assert(r.naoDuplicaOClique, 'rerenderizar o cartão não pode empilhar cliques');
  assert(r.avisaSemNuvem, 'sem nuvem, o botão tem que explicar — não sair calado');
  assert(r.avisaSessao, 'com a sessão vencida, avisa e leva de volta ao login');
  assert(r.avisaQuandoNaoTemNada, 'quando não há novidade, o botão precisa dizer isso');
  assert(r.avisaFalhaDeLeitura, 'se a leitura da clínica falhou, não pode dizer que está tudo em dia');
  await page.close();
});

/* 106) O teto de 5 MB do localStorage não se resolve com faxina: é limite do
   navegador. O que é pesado — imagens, versões, lixeira — mudou de casa para o
   IndexedDB, que trabalha na casa de centenas de MB. */
await test('O que é pesado sai do localStorage e vai para o disco grande do aparelho', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    out.abriu = disco._pronto === true;
    out.saoAsPesadas = disco.CHAVES.indexOf('medsys.v7.blobs') >= 0
      && disco.CHAVES.indexOf('medsys.v7.versions') >= 0
      && disco.CHAVES.indexOf('medsys.v7.lixeira') >= 0;

    /* imagem grande num registro: o registro guarda só a referência, e a
       imagem não ocupa uma vírgula do localStorage */
    const img = 'data:image/png;base64,' + 'A'.repeat(60000);
    store.setList('pre', []);
    const rec = store.save('pre', { nome: 'Com carimbo', data: '2026-08-13', carimbo: img });
    const cru = localStorage.getItem(STORAGE['pre']) || '';
    out.registroFicouLeve = cru.length < 5000 && /blob:/.test(cru);
    out.imagemForaDoLocalStorage = (localStorage.getItem('medsys.v7.blobs') || '') === '';
    out.imagemNoDiscoGrande = (disco.get('medsys.v7.blobs') || '').length > 50000;
    /* e o app continua enxergando a imagem inteira, sem saber de nada disso */
    out.appVeAImagemInteira = (store.getById('pre', rec._id) || {}).carimbo === img;

    /* a gravação chega mesmo ao IndexedDB, não só à memória */
    await new Promise(r2 => setTimeout(r2, 700));
    const doDisco = await disco._ler('medsys.v7.blobs');
    out.gravouNoIndexedDB = typeof doDisco === 'string' && doDisco.length > 50000;

    /* a tela de armazenamento não pode mentir por omissão */
    const u = armazenamento.uso();
    out.contaSeparado = u.grande > 50000 && u.itens.some(it => it.noDiscoGrande);

    store.setList('pre', []);
    return out;
  });
  assert(r.abriu, 'o disco grande precisa abrir no boot');
  assert(r.saoAsPesadas, 'imagens, versões e lixeira são o que pesa — é o que muda de casa');
  assert(r.registroFicouLeve, 'o registro guarda a referência, não a imagem');
  assert(r.imagemForaDoLocalStorage, 'a imagem não pode mais ocupar o espaço apertado de 5 MB');
  assert(r.imagemNoDiscoGrande, 'a imagem tem que estar no disco grande');
  assert(r.appVeAImagemInteira, 'para o resto do app nada muda: a imagem volta inteira');
  assert(r.gravouNoIndexedDB, 'a gravação precisa chegar ao IndexedDB, não parar na memória');
  assert(r.contaSeparado, 'a tela de armazenamento precisa mostrar o que está no disco grande');
  await page.close();
});

/* 107) Cortar a lista local é legítimo; derrubar o que ainda não está na nuvem
   é perder trabalho. E o ciclo automático existe para o fluxo não depender de
   ninguém apertar botão. */
await test('O corte local nunca derruba o que ainda não subiu, e a sincronia roda sozinha', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    /* --- poda --- */
    const lista = [];
    for (let i = 0; i < HISTORY_MAX + 5; i++) {
      lista.push({ _id: 'c' + i, nome: 'na nuvem ' + i, _relUpdatedAt: '2026-08-13T10:00:00Z' });
    }
    lista.push({ _id: 'so-aqui', nome: 'ainda não subiu' });     /* sem _relUpdatedAt */
    store._podar(lista);
    out.cortouNoTeto = lista.length === HISTORY_MAX;
    out.preservouOQueNaoSubiu = lista.some(x => x._id === 'so-aqui');

    /* uma lista inteira de não-sincronizados não é cortada: seria perda */
    const soLocais = [];
    for (let i = 0; i < HISTORY_MAX + 3; i++) soLocais.push({ _id: 'l' + i, nome: 'local ' + i });
    store._podar(soLocais);
    out.naoJogaForaTrabalho = soLocais.length === HISTORY_MAX + 3;

    /* --- sincronia automática --- */
    out.temCiclo = typeof sincronia !== 'undefined' && typeof sincronia.ciclo === 'function';
    const origDisp = cloudRel.disponivel, origPuxa = cloudRel.puxarModulo,
          origTok = cloud._garantirToken, origEmp = cloudRel.empurrarPendentes,
          origCfg = cloud.estaConfigurado, origLog = cloud.estaLogado, origExp = cloud.sessaoExpirada;
    cloud.estaConfigurado = () => true; cloud.estaLogado = () => true; cloud.sessaoExpirada = () => false;
    cloudRel.disponivel = () => true; cloud._garantirToken = async () => true;
    let empurrou = 0;
    cloudRel.empurrarPendentes = async () => { empurrou++; return { enviados: 0 }; };
    const pedidos = [];
    cloudRel.puxarModulo = async (mod, opts) => {
      pedidos.push({ mod, desde: (opts || {}).desde || '' });
      return mod === 'pre'
        ? [{ _id: 'auto1', nome: 'Vindo sozinho', _updatedAt: '2026-08-13T12:00:00.000Z',
             _relUpdatedAt: '2026-08-13T12:00:05.000Z',
             _preLanc: { estado: 'enviado', porNome: 'Sec' } }]
        : [];
    };
    localStorage.removeItem(sincronia.MARCAS_KEY);
    dashboard._puxouVazio = true;      /* fora da medição: o painel vazio tem busca própria */
    store.setList('pre', []);
    /* o ciclo do boot pode estar em curso: esperar por ele evita medir a
       passada errada (foi assim que este teste falhou da primeira vez) */
    const ciclo = async () => {
      while (sincronia._rodando) await new Promise(r2 => setTimeout(r2, 10));
      try { clearTimeout(sincronia._timer); } catch (e) {}
      await sincronia.ciclo();
      try { clearTimeout(sincronia._timer); } catch (e) {}
    };
    await ciclo();
    out.empurrouPendentes = empurrou === 1;
    out.trouxeSozinho = !!store.getById('pre', 'auto1');
    out.pediuSemFiltroNaPrimeira = pedidos.length > 0 && pedidos[0].desde === '';

    /* segunda passada: só o que mudou desde a última — leitura barata */
    pedidos.length = 0;
    await ciclo();
    /* outras rotinas (fila, painel vazio) também leem a clínica: o que importa
       é que o CICLO peça a pré a partir da última marca */
    out.segundaEIncremental = pedidos.some(p => p.mod === 'pre' && p.desde === '2026-08-13T12:00:05.000Z');

    /* clínica fora do ar: espera mais na próxima, em vez de martelar */
    cloudRel.puxarModulo = async () => null;
    sincronia._espera = sincronia.INTERVALO;
    await ciclo();
    out.recuaQuandoFalha = sincronia._espera > sincronia.INTERVALO;
    cloudRel.puxarModulo = async () => [];
    await ciclo();
    out.voltaAoRitmoQuandoVolta = sincronia._espera === sincronia.INTERVALO;

    /* sem nuvem não fica tentando à toa */
    cloud.estaConfigurado = () => false;
    out.naoTentaSemNuvem = sincronia.podeRodar() === false;

    cloudRel.disponivel = origDisp; cloudRel.puxarModulo = origPuxa;
    cloud._garantirToken = origTok; cloudRel.empurrarPendentes = origEmp;
    cloud.estaConfigurado = origCfg; cloud.estaLogado = origLog; cloud.sessaoExpirada = origExp;
    try { clearTimeout(sincronia._timer); } catch (e) {}
    store.setList('pre', []);
    return out;
  });
  assert(r.cortouNoTeto, 'a lista local continua tendo um teto');
  assert(r.preservouOQueNaoSubiu, 'o corte não pode derrubar registro que ainda não está na nuvem');
  assert(r.naoJogaForaTrabalho, 'se nada subiu ainda, é melhor a lista passar do teto do que perder trabalho');
  assert(r.temCiclo, 'a sincronia automática precisa existir');
  assert(r.empurrouPendentes, 'cada ciclo sobe o que ficou para trás');
  assert(r.trouxeSozinho, 'o que está na clínica chega sem ninguém apertar botão');
  assert(r.pediuSemFiltroNaPrimeira, 'a primeira leitura vem inteira');
  assert(r.segundaEIncremental, 'as seguintes trazem só o que mudou — é o que deixa repetir de minuto em minuto');
  assert(r.recuaQuandoFalha, 'falhou, espera mais na próxima em vez de martelar a rede');
  assert(r.voltaAoRitmoQuandoVolta, 'voltou a funcionar, volta ao ritmo normal');
  assert(r.naoTentaSemNuvem, 'sem nuvem configurada não adianta tentar');
  await page.close();
});

/* 108) O botão travou em "⏳ Buscando…" para sempre: a busca automática do
   painel e o toque na tela se cruzaram, e a segunda chamada guardou o rótulo
   de ocupado como se fosse o normal. E "não subiu" sem motivo é um beco. */
await test('O Buscar volta ao normal mesmo com duas buscas cruzadas, e "não subiu" vem com o motivo', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    store.setList('pre', []); store.setList('anestesia', []);
    const origCfg = cloud.estaConfigurado, origLog = cloud.estaLogado, origExp = cloud.sessaoExpirada,
          origDisp = cloudRel.disponivel, origTok = cloud._garantirToken, origPuxa = cloudRel.puxarModulo,
          origEnv = cloudRel.enviarRegistro;
    cloud.estaConfigurado = () => true; cloud.estaLogado = () => true; cloud.sessaoExpirada = () => false;
    cloudRel.disponivel = () => true; cloud._garantirToken = async () => true;

    /* O defeito era o rótulo GUARDADO: a segunda chamada lia o texto atual do
       botão — que já era "⏳ Buscando…" — e o devolvia no fim como se fosse o
       normal. Reproduzir isso não exige corrida (que aqui só tornava o teste
       instável): basta o botão já estar com o texto de ocupado quando uma
       busca completa acontece. */
    auth.usuarioAtual = () => ({ id: 'm1', nome: 'Dr.', perfil: 'admin', role: 'gestor' });
    preLanc.renderFila();
    cloudRel.puxarModulo = async () => [];
    const btn = document.getElementById('pl-buscar-btn');
    btn.textContent = '⏳ Buscando…';
    btn.disabled = true;
    preLanc._ultimaBusca = 0;
    await preLanc.sincronizarFila({ forcar: true, silent: true });
    const b2 = document.getElementById('pl-buscar-btn');
    out.voltouAoNormal = b2.textContent.indexOf('Buscando') < 0 && b2.textContent.indexOf('Buscar') >= 0;
    out.destravou = b2.disabled === false;

    /* com uma busca em curso, a outra não entra */
    preLanc._buscando = true;
    preLanc._ultimaBusca = 0;
    const cruzada = await preLanc.sincronizarFila({ forcar: true, silent: true });
    out.naoEntraCruzada = cruzada === null;
    preLanc._buscando = false;

    /* e durante a busca o botão mostra que está trabalhando */
    let vistoDurante = '';
    cloudRel.puxarModulo = async () => {
      vistoDurante = document.getElementById('pl-buscar-btn').textContent;
      return [];
    };
    preLanc._ultimaBusca = 0;
    await preLanc.sincronizarFila({ forcar: true, silent: true });
    out.mostraOcupado = vistoDurante.indexOf('Buscando') >= 0;

    /* motivo da recusa em português, na tela de quem lançou */
    auth.usuarioAtual = () => ({ id: 's1', nome: 'Sec', perfil: 'secretaria', role: 'auxiliar' });
    store.setList('pre', [{
      _id: 'p1', nome: 'Ana', data: '2026-08-13', _updatedAt: '2026-08-13T12:00:00.000Z',
      _preLanc: { estado: 'enviado', por: 's1', porNome: 'Sec', enviadoEm: '2026-08-13T12:00:00.000Z' }
    }]);
    cloudRel.enviarRegistro = async () => ({ ok: false, motivo: 'org' });
    const res = await preLanc.subirPendentes({ silent: true });
    out.contouAFalha = !!res && res.falhou === 1;
    out.traduziuOMotivo = /clínica na nuvem/i.test(res.motivo || '');
    const alerta = document.getElementById('pl-alerta');
    out.mostrouOMotivo = !!alerta && /Motivo/.test(alerta.textContent) && /clínica na nuvem/i.test(alerta.textContent);

    /* subiu: o aviso e o motivo somem */
    cloudRel.enviarRegistro = async (mod, rec) => {
      const l = store.list(mod);
      const i = l.findIndex(x => x._id === rec._id);
      if (i >= 0) { l[i]._relUpdatedAt = '2026-08-13T12:00:10.000Z'; store.setList(mod, l); }
      return { ok: true };
    };
    await preLanc.subirPendentes({ silent: true });
    out.limpouDepoisDeSubir = preLanc.naoSubiram().length === 0 && !preLanc._erroSubida;

    cloud.estaConfigurado = origCfg; cloud.estaLogado = origLog; cloud.sessaoExpirada = origExp;
    cloudRel.disponivel = origDisp; cloud._garantirToken = origTok; cloudRel.puxarModulo = origPuxa;
    cloudRel.enviarRegistro = origEnv;
    preLanc._diag = null; preLanc._erroSubida = '';
    store.setList('pre', []); store.setList('anestesia', []);
    return out;
  });
  assert(r.mostraOcupado, 'enquanto busca, o botão precisa mostrar que está trabalhando');
  assert(r.voltouAoNormal, 'o botão não pode ficar preso em "Buscando…" por ter guardado o rótulo errado');
  assert(r.destravou, 'e o botão precisa voltar a aceitar toque');
  assert(r.naoEntraCruzada, 'com uma busca em curso, a outra não entra');
  assert(r.contouAFalha, 'a recusa da clínica precisa ser contada');
  assert(r.traduziuOMotivo, 'o motivo tem que estar em português, não em código');
  assert(r.mostrouOMotivo, 'e precisa aparecer na tela de quem lançou');
  assert(r.limpouDepoisDeSubir, 'depois que sobe, o aviso e o motivo somem');
  await page.close();
});

/* 109) Ao finalizar, o passo seguinte é o papel: pré e termo vão direto para a
   impressão. E a pré tem que gerar o financeiro COM o pagador — sem convênio o
   lançamento nasce sem saber de quem cobrar. */
await test('Pré e Termo vão para a impressão ao finalizar, e a pré gera o financeiro com o convênio', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    store.setList('pre', []); store.setList('termo', []); store.setList('financeiro', []);
    /* A impressão é montada a partir do FORMULÁRIO. Contar chamadas não basta:
       da primeira vez ela abria DEPOIS do descarte do rascunho, que limpa a
       tela, e saía em branco. Aqui olhamos o que foi realmente montado. */
    let imprimiu = 0, conteudo = '';
    const origPrint = printPreview.abrir;
    printPreview.abrir = function () {
      imprimiu++;
      const r2 = origPrint.apply(printPreview, arguments);
      try { conteudo = (document.getElementById('ppp') || {}).innerHTML || ''; } catch (e) {}
      try { document.getElementById('print-preview-overlay').classList.remove('show'); } catch (e) {}
      return r2;
    };
    const origModal = modal.open;
    modal.open = () => {};                       /* a pergunta do termo não interessa aqui */

    /* como no uso real: finaliza de dentro do módulo aberto */
    ui.navegar('pre');
    /* a pré agora tem onde guardar o convênio */
    const f = document.getElementById('form-pre');
    out.temCampoConvenio = !!f.querySelector('[name="convenio"]');
    f.querySelector('[name="_id"]') && (f.querySelector('[name="_id"]').value = '');
    f.querySelector('[name="nome"]').value = 'Ana Souza';
    f.querySelector('[name="data"]').value = '2026-08-13';
    f.querySelector('[name="cirurgia"]').value = 'Colecistectomia';
    f.querySelector('[name="cirurgiao"]').value = 'Dr. Paulo';
    f.querySelector('[name="hospital"]').value = 'Hospital X';
    f.querySelector('[name="convenio"]').value = 'Bradesco Saúde';
    pre.salvar({ finalizar: true, _dupOk: true });
    const rec = store.list('pre')[0];
    out.finalizou = !!rec && rec._finalizado === true && rec.convenio === 'Bradesco Saúde';

    /* financeiro criado, com pagador */
    const lanc = store.list('financeiro').filter(x => x._origemId === rec._id);
    out.gerouFinanceiro = lanc.length === 1;
    out.levouOConvenio = lanc.length === 1 && lanc[0].convenio === 'Bradesco Saúde';
    out.levouOTipo = lanc.length === 1 && lanc[0].tipo_pagamento === 'Convênio';
    out.levouOResto = lanc.length === 1 && lanc[0].paciente === 'Ana Souza'
      && lanc[0].hospital === 'Hospital X' && lanc[0].cirurgiao === 'Dr. Paulo';

    await new Promise(r2 => setTimeout(r2, 400));
    out.abriuImpressaoDaPre = imprimiu >= 1;
    out.impressaoDaPreTemConteudo = /Ana Souza/.test(conteudo) && /Colecistectomia/.test(conteudo);

    /* termo: mesma coisa */
    imprimiu = 0; conteudo = '';
    ui.navegar('termo');
    const ft = document.getElementById('form-termo');
    ft.querySelector('[name="_id"]') && (ft.querySelector('[name="_id"]').value = '');
    ft.querySelector('[name="nome"]').value = 'Ana Souza';
    const dt = ft.querySelector('[name="data"]'); if (dt) dt.value = '2026-08-13';
    termo.salvar({ finalizar: true, _dupOk: true });
    await new Promise(r2 => setTimeout(r2, 400));
    out.abriuImpressaoDoTermo = imprimiu >= 1;
    out.impressaoDoTermoTemConteudo = /Ana Souza/.test(conteudo);

    /* a janela de pendências não volta a interromper de meia em meia hora */
    let abriu = 0, pintou = 0;
    const origAbrir = pendencias.abrir, origRender = pendencias.renderDashboard,
          origPode = pendencias.podeVer, origInterval = window.setInterval;
    pendencias.abrir = () => { abriu++; };
    pendencias.renderDashboard = () => { pintou++; };
    pendencias.podeVer = () => true;
    let tarefa = null;
    window.setInterval = (fn) => { tarefa = fn; return 0; };
    pendencias.iniciarTimer();
    window.setInterval = origInterval;
    if (tarefa) tarefa();
    out.naoInterrompeDeNovo = abriu === 0 && pintou === 1;
    /* mas ao ENTRAR continua avisando (com a tela livre: por regra, ela não
       interrompe janela já aberta) */
    try { document.getElementById('modal-backdrop').classList.remove('show'); } catch (e) {}
    pendencias.checarAoEntrar();
    out.avisaAoEntrar = abriu === 1;

    pendencias.abrir = origAbrir; pendencias.renderDashboard = origRender; pendencias.podeVer = origPode;
    printPreview.abrir = origPrint; modal.open = origModal;
    store.setList('pre', []); store.setList('termo', []); store.setList('financeiro', []);
    return out;
  });
  assert(r.temCampoConvenio, 'a pré-anestésica precisa ter onde guardar o convênio');
  assert(r.finalizou, 'a finalização precisa gravar o registro com o convênio');
  assert(r.gerouFinanceiro, 'finalizar a pré tem que gerar o lançamento financeiro');
  assert(r.levouOConvenio && r.levouOTipo, 'o lançamento não pode nascer sem saber de quem cobrar');
  assert(r.levouOResto, 'paciente, hospital e cirurgião viajam junto');
  assert(r.abriuImpressaoDaPre, 'ao finalizar a pré, a impressão abre sozinha');
  assert(r.impressaoDaPreTemConteudo, 'a impressão não pode sair em branco: tem que trazer o paciente e o procedimento');
  assert(r.abriuImpressaoDoTermo, 'ao finalizar o termo, a impressão abre sozinha');
  assert(r.impressaoDoTermoTemConteudo, 'a impressão do termo também precisa vir preenchida');
  assert(r.naoInterrompeDeNovo, 'a janela de pendências não pode voltar a interromper de meia em meia hora');
  assert(r.avisaAoEntrar, 'mas ao entrar ela continua avisando');
  await page.close();
});

/* 110) Impressão da pré e do termo: menor, sem o traço embaixo de cada valor,
   e com a logomarca reduzida. São documentos de leitura — não precisam do
   corpo de texto da ficha de anestesia, que é preenchida à mão. */
await test('Impressão da pré e do termo sai compacta, sem sublinhado e com logo menor', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    /* os dois documentos pedem o modo compacto */
    ui.navegar('pre');
    document.querySelector('#form-pre [name="nome"]').value = 'Ana Souza';
    out.preCompacta = /pp-compacto/.test(printPreview._buildPre());
    ui.navegar('termo');
    document.querySelector('#form-termo [name="nome"]').value = 'Ana Souza';
    out.termoCompacto = /pp-compacto/.test(printPreview._buildTermo());

    /* mede no papel de verdade: mesmo campo dentro e fora do modo compacto */
    const ppp = document.getElementById('ppp');
    ppp.innerHTML =
      '<div id="tst-normal"><img class="pp-logo" src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==">' +
      '<div class="pp-field"><span class="pp-label">L</span><span class="pp-value">V</span></div></div>' +
      '<div id="tst-comp" class="pp-compacto"><img class="pp-logo" src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==">' +
      '<div class="pp-field"><span class="pp-label">L</span><span class="pp-value">V</span></div></div>';
    const cs = (sel) => getComputedStyle(document.querySelector(sel));
    const normal = cs('#tst-normal .pp-value'), comp = cs('#tst-comp .pp-value');
    const fN = parseFloat(normal.fontSize), fC = parseFloat(comp.fontSize);
    out.reduziuOTexto = fN > 0 && Math.abs((fC / fN) - 0.8) < 0.03;
    out.reduziuORotulo = (() => {
      const a = parseFloat(cs('#tst-normal .pp-label').fontSize);
      const b = parseFloat(cs('#tst-comp .pp-label').fontSize);
      return a > 0 && Math.abs((b / a) - 0.8) < 0.03;
    })();
    const lN = parseFloat(cs('#tst-normal .pp-logo').height), lC = parseFloat(cs('#tst-comp .pp-logo').height);
    out.reduziuALogo = lN > 0 && lC < lN * 0.7;

    /* o traço embaixo do valor sai — em toda impressão, não só na compacta */
    out.semTracoNaCompacta = parseFloat(comp.borderBottomWidth || '0') === 0;
    out.semTracoTambemNoResto = parseFloat(normal.borderBottomWidth || '0') === 0;

    ppp.innerHTML = '';
    return out;
  });
  assert(r.preCompacta && r.termoCompacto, 'pré e termo têm que pedir o modo compacto');
  assert(r.reduziuOTexto, 'o texto do documento precisa sair ~20% menor');
  assert(r.reduziuORotulo, 'os rótulos acompanham a redução');
  assert(r.reduziuALogo, 'a logomarca precisa reduzir mais que o texto');
  assert(r.semTracoNaCompacta && r.semTracoTambemNoResto, 'o traço embaixo de cada valor sai da impressão');
  await page.close();
});

/* 111) Cortesia entre as ações da pendência: não é etapa de faturamento, é o
   fim dele. Sem essa opção o caso cobrava baixa para sempre, ou era resolvido
   sem dizer por quê — e o valor seguia contando como "a receber". */
await test('Cortesia é uma das ações da pendência de convênio e chega ao financeiro', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    store.setList('pre', []); store.setList('financeiro', []);
    out.estaNasOpcoes = pendencias.STATUS.some(([k, rot]) => k === 'cortesia' && /cortesia/i.test(rot));

    /* uma pré de plano, com o lançamento financeiro que ela gerou */
    const pre1 = store.save('pre', {
      nome: 'Ana Souza', data: '2026-08-13', convenio: 'Bradesco Saúde', cirurgia: 'Colecistectomia'
    });
    const lanc = store.save('financeiro', {
      _origemId: pre1._id, paciente: 'Ana Souza', convenio: 'Bradesco Saúde',
      data_proc: '2026-08-13', valor_previsto: 1200, status: 'pendente', pago: false
    });
    out.entrouNaLista = pendencias.listar().some(p => p.id === pre1._id);

    /* marca cortesia pela janela */
    pendencias.marcarStatus('pre', pre1._id, 'cortesia', true);
    const dep = store.getById('pre', pre1._id);
    out.carimbouNoRegistro = !!(dep._faturamento && dep._faturamento.cortesia);
    out.saiuDaPendencia = !pendencias.listar().some(p => p.id === pre1._id);

    const fin1 = store.getById('financeiro', lanc._id);
    out.marcouNoFinanceiro = fin1.tipo_pagamento === 'Cortesia' && fin1.pago === true;
    out.naoApagouOValor = Number(fin1.valor_previsto) === 1200;   /* o dado do usuário fica */
    out.deixouORastro = /cortesia/i.test(fin1.observacoes || '');

    /* marcada direto no próprio lançamento financeiro, funciona igual */
    const solto = store.save('financeiro', {
      paciente: 'Bia', convenio: 'Amil', data_proc: '2026-08-13',
      valor_previsto: 800, status: 'pendente', pago: false
    });
    pendencias.marcarStatus('financeiro', solto._id, 'cortesia', true);
    const fin2 = store.getById('financeiro', solto._id);
    out.funcionaNoProprioLancamento = fin2.tipo_pagamento === 'Cortesia' && fin2.pago === true;

    store.setList('pre', []); store.setList('financeiro', []);
    return out;
  });
  assert(r.estaNasOpcoes, 'Cortesia precisa estar entre as ações da pendência');
  assert(r.entrouNaLista, 'a pendência de plano precisa existir antes de ser resolvida');
  assert(r.carimbouNoRegistro && r.saiuDaPendencia, 'marcar cortesia dá baixa e deixa registrado o porquê');
  assert(r.marcouNoFinanceiro, 'a cortesia tem que chegar ao financeiro — senão o valor fica como "a receber"');
  assert(r.naoApagouOValor, 'o valor digitado pelo usuário não é apagado');
  assert(r.deixouORastro, 'fica escrito no lançamento que foi cortesia');
  assert(r.funcionaNoProprioLancamento, 'marcada direto no lançamento financeiro, funciona igual');
  await page.close();
});

/* 112) Produtividade é o que ficou PRONTO. Rascunho e pré-lançamento não são
   produção: o painel contando trabalho em curso vira promessa, não medida. E o
   painel precisa abrir mostrando NÚMERO, não recado. */
await test('Dashboard conta só o que foi finalizado, e os números vêm antes dos avisos', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    store.setList('anestesia', []); store.setList('pre', []);
    store.setList('consulta', []); store.setList('financeiro', []);
    auth.usuarioAtual = () => ({ id: 'm1', nome: 'Dr.', perfil: 'admin', role: 'gestor' });
    const hoje = new Date().toISOString().slice(0, 10);

    /* uma finalizada, um rascunho e um pré-lançamento enviado (não conferido) */
    store.setList('pre', [
      { _id: 'f1', nome: 'Finalizada', data: hoje, _finalizado: true, _updatedAt: new Date().toISOString() },
      { _id: 'r1', nome: 'Rascunho', data: hoje, _updatedAt: new Date().toISOString() },
      { _id: 'p1', nome: 'Pré-lançada', data: hoje, _updatedAt: new Date().toISOString(),
        _preLanc: { estado: 'enviado', porNome: 'Sec' } }
    ]);
    document.getElementById('dash-escopo').value = 'clinica';
    document.getElementById('dash-periodo').value = 'hoje';
    dashboard.atualizar();
    const kpi = document.getElementById('kpi-grid');
    const cartaoPre = kpi.querySelector('[data-detail="pre"] .kpi-value');
    out.contouSoAFinalizada = cartaoPre && cartaoPre.textContent.trim() === '1';
    out.dizQueEhFinalizada = /finalizad/i.test(kpi.querySelector('[data-detail="pre"] .kpi-sub').textContent);

    /* o helper é a régua única, e o financeiro não passa por ela (não tem
       "finalizar": ele nasce já lançado) */
    out.regraUnica = dashboard._soProducao([{ _finalizado: true }, {}, { _finalizado: false }]).length === 1;

    /* números antes dos avisos, na ordem da página */
    const mod = document.getElementById('module-dashboard');
    const pos = (sel) => {
      const el = mod.querySelector(sel);
      if (!el) return -1;
      return Array.prototype.indexOf.call(mod.querySelectorAll('*'), el);
    };
    out.numerosPrimeiro = pos('#kpi-grid') > 0 && pos('#kpi-grid') < pos('#pl-fila-card')
      && pos('#kpi-grid') < pos('#pl-alerta');

    /* painel zerado busca a produção na clínica em vez de aceitar o zero */
    const origDisp = cloudRel.disponivel, origTok = cloud._garantirToken, origPuxa = cloudRel.puxarModulo;
    cloudRel.disponivel = () => true;
    cloud._garantirToken = async () => true;
    let pediu = 0;
    cloudRel.puxarModulo = async (m) => {
      pediu++;
      return m === 'anestesia'
        ? [{ _id: 'nuvem1', paciente: { nome: 'Da clínica' }, procedimento: { data: hoje },
             _finalizado: true, _updatedAt: new Date().toISOString(), _relUpdatedAt: '2026-08-13T12:00:00Z' }]
        : [];
    };
    store.setList('pre', []); store.setList('anestesia', []);
    dashboard._puxouVazio = false;
    await dashboard._puxarSeVazio(0);
    out.foiBuscar = pediu > 0;
    out.trouxe = !!store.getById('anestesia', 'nuvem1');
    /* e não fica repetindo a cada render */
    pediu = 0;
    await dashboard._puxarSeVazio(0);
    out.naoRepete = pediu === 0;
    /* com produção na tela, nem tenta */
    dashboard._puxouVazio = false;
    pediu = 0;
    await dashboard._puxarSeVazio(5);
    out.naoBuscaSeTemDados = pediu === 0;

    cloudRel.disponivel = origDisp; cloud._garantirToken = origTok; cloudRel.puxarModulo = origPuxa;
    store.setList('anestesia', []); store.setList('pre', []);
    store.setList('consulta', []); store.setList('financeiro', []);
    return out;
  });
  assert(r.contouSoAFinalizada, 'rascunho e pré-lançamento não podem contar como produção');
  assert(r.dizQueEhFinalizada, 'o cartão precisa dizer que conta o que foi finalizado');
  assert(r.regraUnica, 'a régua de produção é uma só');
  assert(r.numerosPrimeiro, 'os números vêm antes dos avisos — senão o painel vira quadro de aviso');
  assert(r.foiBuscar && r.trouxe, 'painel zerado vai buscar a produção na clínica');
  assert(r.naoRepete, 'a busca do painel vazio não pode repetir a cada render');
  assert(r.naoBuscaSeTemDados, 'com dados na tela, não há o que buscar');
  await page.close();
});

/* 113a) Zero mudo faz duvidar do sistema inteiro: o painel tem que dizer onde
   a produção está — e o filtro de autoria não pode esconder ficha assinada
   pela própria pessoa. */
await test('Painel zerado explica o porquê e leva até a produção', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    ['anestesia', 'pre', 'consulta', 'recuperacao', 'financeiro'].forEach(m => store.setList(m, []));
    auth.usuarioAtual = () => ({ id: 'm1', nome: 'Marcelo', usuario: 'mpcaliman', perfil: 'admin', role: 'gestor' });
    const hoje = new Date().toISOString().slice(0, 10);
    const ontemD = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);

    /* autoria pelo campo de quem assina — era o buraco: 'anestesiologista' não
       entrava na conta e a ficha do próprio médico sumia do painel dele */
    out.reconheceQuemAssina = dashboard._filtrarEscopo(
      [{ _id: 'x', anestesiologista: 'Marcelo' }, { _id: 'y', anestesiologista: 'Outra pessoa' }], 'pessoal'
    ).length === 1;

    /* caso 1: tudo em aberto (nada finalizado) */
    store.setList('pre', [{ _id: 'a1', nome: 'Em aberto', data: hoje, _updatedBy: 'mpcaliman' }]);
    document.getElementById('dash-escopo').value = 'pessoal';
    document.getElementById('dash-periodo').value = 'hoje';
    dashboard.atualizar();
    const aviso = document.getElementById('dash-vazio');
    out.explicouNaoFinalizado = aviso.style.display !== 'none' && /não finalizado/i.test(aviso.textContent);

    /* caso 2: finalizado, mas de outra pessoa da clínica */
    store.setList('pre', [{ _id: 'b1', nome: 'De outro', data: hoje, _finalizado: true, _updatedBy: 'mpcanestesiologia' }]);
    dashboard.atualizar();
    out.explicouDeOutro = /de outra pessoa/i.test(aviso.textContent) && /Ver clínica/.test(aviso.innerHTML);
    /* e o atalho troca o filtro de verdade */
    dashboard._verComo('clinica');
    out.atalhoFunciona = document.getElementById('dash-escopo').value === 'clinica'
      && document.querySelector('#kpi-grid [data-detail="pre"] .kpi-value').textContent.trim() === '1';

    /* caso 3: finalizado meu, mas fora do período */
    document.getElementById('dash-escopo').value = 'pessoal';
    store.setList('pre', [{ _id: 'c1', nome: 'Antigo', data: ontemD, _finalizado: true, _updatedBy: 'mpcaliman' }]);
    document.getElementById('dash-periodo').value = 'hoje';
    dashboard.atualizar();
    out.explicouForaDoPeriodo = /fora deste período/i.test(aviso.textContent);
    dashboard._verComo(null, 'all');
    out.atalhoDoPeriodo = document.getElementById('dash-periodo').value === 'all'
      && document.querySelector('#kpi-grid [data-detail="pre"] .kpi-value').textContent.trim() === '1';

    /* com produção na tela, o aviso some */
    out.some = document.getElementById('dash-vazio').style.display === 'none';

    ['anestesia', 'pre', 'consulta', 'recuperacao', 'financeiro'].forEach(m => store.setList(m, []));
    return out;
  });
  assert(r.reconheceQuemAssina, 'quem assina a ficha é autor dela — senão ela some do painel do próprio médico');
  assert(r.explicouNaoFinalizado, 'se há registro em aberto, o painel precisa dizer que produção só conta finalizada');
  assert(r.explicouDeOutro, 'se a produção do período é de outra pessoa, o painel diz e oferece ver a clínica');
  assert(r.atalhoFunciona, 'o atalho tem que trocar o filtro de verdade');
  assert(r.explicouForaDoPeriodo, 'produção fora do período precisa ser apontada');
  assert(r.atalhoDoPeriodo, 'e alcançável em um toque');
  assert(r.some, 'com produção na tela, o aviso some');
  await page.close();
});

/* 113b) O aviso dizia "eles entram nos totais", mas só o cartão de anestesia
   somava a nuvem — os outros mostravam zero enquanto o aviso prometia o
   contrário. E, com o disco grande, arquivar deixou de ser necessário. */
await test('O que está na nuvem soma em todos os cartões, e dá para trazer tudo de volta', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    ['anestesia', 'pre', 'consulta', 'recuperacao', 'financeiro'].forEach(m => store.setList(m, []));
    auth.usuarioAtual = () => ({ id: 'm1', nome: 'Dr.', perfil: 'admin', role: 'gestor' });
    const hoje = new Date().toISOString().slice(0, 10);

    /* índice de arquivados: 2 finalizados e 1 rascunho em cada módulo */
    const entrada = (i, fin) => ({ id: 'arq' + i, nome: 'P' + i, data: hoje, fin });
    localStorage.setItem(arquivo.INDEX_KEY, JSON.stringify({
      pre: [entrada(1, true), entrada(2, true), entrada(3, false)],
      consulta: [entrada(4, true)],
      recuperacao: [entrada(5, true)],
      anestesia: [entrada(6, true)]
    }));
    document.getElementById('dash-escopo').value = 'clinica';
    document.getElementById('dash-periodo').value = 'hoje';
    dashboard.atualizar();
    const valor = (mod) => document.querySelector('#kpi-grid [data-detail="' + mod + '"] .kpi-value').textContent.trim();
    out.preSomou = valor('pre') === '2';                 /* o rascunho arquivado não conta */
    out.consultaSomou = valor('consulta') === '1';
    out.srpaSomou = valor('recuperacao') === '1';
    out.anestesiaSomou = valor('anestesia') === '1';

    /* entrada antiga, sem a marca, continua contando (não esconder produção) */
    localStorage.setItem(arquivo.INDEX_KEY, JSON.stringify({ pre: [{ id: 'velho', nome: 'V', data: hoje }] }));
    dashboard.atualizar();
    out.entradaAntigaConta = valor('pre') === '1';

    /* e o painel oferece trazer tudo de volta quando o disco grande está ativo */
    const aviso = document.getElementById('dash-aviso-nuvem');
    localStorage.setItem(modoNuvem.KEY, '1');
    dashboard.atualizar();
    out.ofereceVoltar = disco._pronto && /parar de arquivar/i.test(aviso.innerHTML);

    let restaurou = 0;
    const origRest = arquivo.restaurarTodos;
    arquivo.restaurarTodos = async () => { restaurou++; };
    await dashboard._voltarTudoParaCa();
    arquivo.restaurarTodos = origRest;
    out.desligouOArquivamento = modoNuvem.ligado() === false && arquivo.autoLigado() === false;
    out.trouxeDeVolta = restaurou >= 1;   /* desligar o modo nuvem já restaura; a chamada extra é idempotente */

    localStorage.removeItem(arquivo.INDEX_KEY);
    ['anestesia', 'pre', 'consulta', 'recuperacao', 'financeiro'].forEach(m => store.setList(m, []));
    return out;
  });
  assert(r.preSomou && r.consultaSomou && r.srpaSomou && r.anestesiaSomou,
    'o que está na nuvem tem que somar em TODOS os cartões, não só no de anestesia');
  assert(r.entradaAntigaConta, 'arquivo antigo sem a marca continua contando — esconder produção real seria pior');
  assert(r.ofereceVoltar, 'com o disco grande, o painel oferece trazer tudo de volta');
  assert(r.desligouOArquivamento && r.trouxeDeVolta, 'trazer de volta também desliga o arquivamento — senão sai tudo de novo');
  await page.close();
});

/* 113) O termo é documento, não produção faturável: não gera financeiro. */
await test('Termo de consentimento não gera lançamento financeiro', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    store.setList('termo', []); store.setList('financeiro', []);
    ui.navegar('termo');
    const ft = document.getElementById('form-termo');
    const h = ft.querySelector('[name="_id"]'); if (h) h.value = '';
    ft.querySelector('[name="nome"]').value = 'Ana Souza';
    const dt = ft.querySelector('[name="data"]'); if (dt) dt.value = '2026-08-13';
    const origPrint = printPreview.abrir; printPreview.abrir = () => {};
    termo.salvar({ finalizar: true, _dupOk: true });
    printPreview.abrir = origPrint;
    const t = store.list('termo')[0];
    out.finalizou = !!t && t._finalizado === true;
    out.semFinanceiro = store.list('financeiro').length === 0;
    /* e o gerador de lançamentos não conhece o termo */
    out.semRegraDeTermo = fin.fromDoc('termo', t || { _id: 'x', nome: 'Ana' }) === null;
    store.setList('termo', []); store.setList('financeiro', []);
    return out;
  });
  assert(r.finalizou, 'o termo precisa finalizar normalmente');
  assert(r.semFinanceiro, 'finalizar o termo não pode gerar lançamento financeiro');
  assert(r.semRegraDeTermo, 'não existe regra de financeiro para o termo — nem por outro caminho');
  await page.close();
});

/* 114) Medicação: digitar sugere, e escolher preenche o padrão de uso. A mesma
   droga é lançada do mesmo jeito dezenas de vezes por semana — via, unidade e
   modo não deviam ser redigitados a cada caso. */
await test('Ficha: digitar a medicação sugere e o padrão (via, modo, diluição) vem junto', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    ui.navegar('anestesia');
    const v = (tr, n) => (tr.querySelector('[name="' + n + '"]') || {}).value || '';

    /* infusão contínua: vem com bomba e diluição usual */
    const tr1 = anestesia.meds.add({});
    const n1 = tr1.querySelector('[name="med_nome[]"]');
    n1.value = 'remi';
    anestesia.meds.sugerir(n1);
    const box = document.getElementById('med-sug-box');
    out.sugeriu = !!box && box.style.display !== 'none' && /Remifentanil/.test(box.textContent);
    anestesia.meds.escolher(0);
    out.preencheuInfusao = v(tr1, 'med_nome[]') === 'Remifentanil'
      && v(tr1, 'med_via[]') === 'EV'
      && v(tr1, 'med_tipo[]').indexOf('bomba') >= 0
      && /mcg\/mL/.test(v(tr1, 'med_diluicao[]'))
      && !!v(tr1, 'med_hora[]');
    out.fechouACaixa = box.style.display === 'none';

    /* bolus com dose habitual */
    const tr2 = anestesia.meds.add({});
    const n2 = tr2.querySelector('[name="med_nome[]"]');
    n2.value = 'ondan';
    anestesia.meds.sugerir(n2);
    anestesia.meds.escolher(0);
    out.preencheuBolus = v(tr2, 'med_nome[]') === 'Ondansetrona' && v(tr2, 'med_dose[]') === '4'
      && v(tr2, 'med_unidade[]') === 'mg' && v(tr2, 'med_tipo[]') === 'Bolus';

    /* inalatório entra como inalatório, não como bolus */
    const tr3 = anestesia.meds.add({});
    const n3 = tr3.querySelector('[name="med_nome[]"]');
    n3.value = 'sevo';
    anestesia.meds.sugerir(n3);
    anestesia.meds.escolher(0);
    out.inalatorio = v(tr3, 'med_tipo[]') === 'Inalatório' && v(tr3, 'med_via[]') === 'Inalatória';

    /* NÃO sobrescreve o que já foi digitado */
    const tr4 = anestesia.meds.add({});
    const n4 = tr4.querySelector('[name="med_nome[]"]');
    tr4.querySelector('[name="med_dose[]"]').value = '2';
    tr4.querySelector('[name="med_via[]"]').value = 'IM';
    n4.value = 'dipiro';
    anestesia.meds.sugerir(n4);
    anestesia.meds.escolher(0);
    out.naoPisouNoDigitado = v(tr4, 'med_dose[]') === '2' && v(tr4, 'med_via[]') === 'IM'
      && v(tr4, 'med_nome[]') === 'Dipirona';

    /* uma letra não sugere nada (ruído); duas já sugerem */
    out.soComDuasLetras = anestesia.meds._achar('d').length === 0 && anestesia.meds._achar('di').length > 0;
    /* quem começa com o texto vem antes de quem só contém */
    out.ordemUtil = (anestesia.meds._achar('morf')[0] || {}).nome.indexOf('Morfina') === 0;

    /* fármacos usados na rotina precisam estar no catálogo — sugestão e
       lista de marcação saem da mesma fonte */
    const acharNo = nome => {
      const m = anestesia.meds._catalogoPlano().find(x => x.nome === nome);
      return m ? m.grupo : '';
    };
    out.etilefrina = acharNo('Etilefrina') === 'Vasoativos';
    out.pantoprazol = !!acharNo('Pantoprazol');
    return out;
  });
  assert(r.sugeriu, 'digitar parte do nome tem que sugerir a medicação');
  assert(r.preencheuInfusao, 'escolher uma infusão traz bomba, unidade e diluição usual');
  assert(r.fechouACaixa, 'depois de escolher, a lista some');
  assert(r.preencheuBolus, 'bolus com dose habitual vem pronto');
  assert(r.inalatorio, 'inalatório não pode entrar como bolus');
  assert(r.naoPisouNoDigitado, 'o padrão nunca sobrescreve o que a pessoa já digitou');
  assert(r.soComDuasLetras, 'uma letra só sugeriria meio catálogo');
  assert(r.ordemUtil, 'quem começa com o que foi digitado vem primeiro');
  assert(r.etilefrina, 'etilefrina precisa estar entre os vasoativos');
  assert(r.pantoprazol, 'pantoprazol precisa estar no catálogo');
  await page.close();
});

/* 115) Diurese junto dos sinais vitais: é ali que ela é lida. Cada volume é o
   do intervalo, o app calcula o ritmo na hora, o débito no fim, e leva tudo
   para o balanço hídrico sem digitação dupla. */
await test('Ficha: diurese entra na grade dos sinais vitais, calcula ritmo e alimenta o balanço', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    ui.navegar('anestesia');
    const f = document.getElementById('form-anestesia');
    f.querySelector('[name="paciente_peso"]').value = '70';
    f.querySelector('[name="hora_inicio"]').value = '08:00';
    f.querySelector('[name="hora_fim"]').value = '12:00';

    /* sem sonda e sem registro, a linha não polui a grade */
    anestesia.vitais.add(false, { hora: '09:00', fc: '70' });
    anestesia.vitais._renderGrade();
    out.semSondaNaoAparece = !document.querySelector('#vitais-grade tr.vg-diurese');

    const sonda = Array.from(document.querySelectorAll('[name="dispositivos[]"]')).find(el => el.value === 'Sonda vesical');
    sonda.checked = true;
    anestesia.diurese.sincronizar();
    anestesia.vitais.add(false, { hora: '10:00', fc: '72' });
    anestesia.vitais._renderGrade();
    out.apareceComSonda = !!document.querySelector('#vitais-grade tr.vg-diurese');
    out.explicaOQuePreencher = /desde o anterior/i.test(
      document.querySelector('#vitais-grade tr.vg-diurese th').textContent);

    /* 100 mL na primeira hora, 30 mL na segunda */
    const cels = () => document.querySelectorAll('#vitais-grade tr.vg-diurese input');
    const c1 = cels(); c1[0].value = '100'; anestesia.diurese._daGrade(c1[0]);
    const c2 = cels(); c2[1].value = '30'; anestesia.diurese._daGrade(c2[1]);

    out.virouRegistro = anestesia.diurese._parciais()
      .map(p => p.hora + '=' + p.vol).join('|') === '09:00=100|10:00=30';
    out.foiParaOBalanco = (f.querySelector('[name="diurese"]') || {}).value === '130';

    const ritmos = Array.from(document.querySelectorAll('#vitais-grade tr.vg-diurese td div'))
      .map(d => d.textContent.trim());
    out.ritmoDoIntervalo = /1,4 mL\/kg\/h/.test(ritmos[0]) && /0,4 mL\/kg\/h/.test(ritmos[1]);
    /* abaixo de 0,5 mL/kg/h o número aparece em vermelho — é o alerta */
    const tds = document.querySelectorAll('#vitais-grade tr.vg-diurese td');
    out.alertouOligúria = /rgb\(192, 57, 43\)|#c0392b/.test(tds[1].querySelector('div').getAttribute('style') || '');
    out.debitoDoCaso = /0,46 mL\/kg\/h/.test((document.getElementById('diurese-resultado') || {}).value || '');

    /* apagar o valor tira o registro (e o balanço acompanha) */
    const c3 = cels(); c3[1].value = ''; anestesia.diurese._daGrade(c3[1]);
    out.apagarRemove = anestesia.diurese._parciais().length === 1
      && (f.querySelector('[name="diurese"]') || {}).value === '100';

    /* débito urinário como MONITOR: vale sem sonda (coletor externo, micção
       medida) — marcar abre o painel e a coluna, e o total vai para as saídas */
    document.querySelectorAll('[name="dispositivos[]"]:checked').forEach(el => {
      el.checked = false; anestesia.disp.alternar(el);
    });
    document.getElementById('diurese-body').innerHTML = '';
    anestesia.diurese.recalcular();
    const monDU = Array.from(f.querySelectorAll('[name="monitores[]"]')).find(e => e.value === 'Débito urinário');
    monDU.checked = true;
    anestesia.disp.sincronizarVitais();
    out.monitorAbre = !!monDU && document.getElementById('diurese-painel').style.display === 'block'
      && anestesia.diurese.mostrarNaGrade() === true;
    anestesia.diurese.addParcial();
    const trM = document.querySelector('#diurese-body tr');
    trM.querySelector('[name="diurese_hora[]"]').value = '09:00';
    trM.querySelector('[name="diurese_vol[]"]').value = '150';
    anestesia.diurese.recalcular();
    out.monitorNoBalanco = (f.querySelector('[name="diurese"]') || {}).value === '150';
    /* desmarcar não pode esconder o que já foi medido */
    monDU.checked = false;
    anestesia.disp.sincronizarVitais();
    out.naoSomeComDado = document.getElementById('diurese-painel').style.display === 'block';
    return out;
  });
  assert(r.semSondaNaoAparece, 'sem sonda e sem registro, a diurese não polui a grade');
  assert(r.apareceComSonda, 'com sonda vesical, a diurese entra na grade dos sinais vitais');
  assert(r.explicaOQuePreencher, 'a grade precisa dizer que o volume é o do intervalo');
  assert(r.virouRegistro, 'o que é lançado na grade vira registro de diurese');
  assert(r.foiParaOBalanco, 'a diurese registrada alimenta o balanço hídrico sozinha');
  assert(r.ritmoDoIntervalo, 'cada intervalo mostra o próprio ritmo urinário');
  assert(r.alertouOligúria, 'ritmo abaixo de 0,5 mL/kg/h precisa saltar aos olhos');
  assert(r.debitoDoCaso, 'o débito do caso continua sendo calculado no fim');
  assert(r.apagarRemove, 'apagar o valor desfaz o registro e corrige o balanço');
  assert(r.monitorAbre, 'débito urinário marcado nos monitores abre o painel e a coluna, sem depender da sonda');
  assert(r.monitorNoBalanco, 'e o total medido continua indo sozinho para as saídas do balanço');
  assert(r.naoSomeComDado, 'desmarcar não pode esconder um volume já registrado');
  await page.close();
});

/* 116) Técnica, via aérea e acessos: escolher uma vez basta. O que foi marcado
   no card vira o texto do evento, a ventilação certa e a faixa no gráfico. */
await test('Ficha: técnica define a ventilação, e tubo/cateter escolhidos escrevem o evento', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    ui.navegar('anestesia');
    const f = document.getElementById('form-anestesia');
    const descDe = tipo => {
      const tr = Array.from(document.querySelectorAll('#eventos-body tr'))
        .find(x => (x.querySelector('[name="evt_tipo[]"]') || {}).value === tipo);
      return tr ? (tr.querySelector('[name="evt_obs[]"]') || {}).value : '';
    };

    /* técnica geral → ventilação mecânica marcada e período na linha do tempo */
    const geral = f.querySelector('[name="tipo[]"][value="Anestesia geral"]');
    geral.checked = true;
    anestesia.eventos.aoSelecionarTipo(geral);
    out.ventDaTecnica = (f.querySelector('[name="vent_modo_geral"]:checked') || {}).value === 'mecanica';
    out.marcouInicioVent = anestesia.eventos.existeEvento('Início da ventilação mecânica');

    /* escolha do anestesista não é revista: já marcado, o app não muda */
    f.querySelector('[name="vent_modo_geral"][value="espontanea"]').checked = true;
    const sed = f.querySelector('[name="tipo[]"][value="Sedação"]');
    sed.checked = true; anestesia.eventos.aoSelecionarTipo(sed);
    out.naoRevisaEscolha = (f.querySelector('[name="vent_modo_geral"]:checked') || {}).value === 'espontanea';

    /* voltar para espontânea marca o FIM da ventilação mecânica */
    anestesia.vent.alternar();
    out.marcouFimVent = anestesia.eventos.existeEvento('Fim da ventilação mecânica');

    /* tubo: tamanho/cuff/Cormack/fixação viram texto e entram no evento */
    const va = f.querySelector('[name="via_aerea_uso"]');
    va.value = 'Intubação orotraqueal';
    anestesia.eventos.aoSelecionarViaAerea(va);
    f.querySelector('[name="via_aerea_tamanho"]').value = '7,5';
    f.querySelector('[name="via_aerea_cuff"]').value = 'com cuff';
    f.querySelector('[name="via_aerea_cormack"]').value = 'I';
    f.querySelector('[name="via_aerea_fixacao"]').value = '21';
    anestesia.viaAerea.montarDetalhe();
    out.montouTubo = f.querySelector('[name="via_aerea_detalhe"]').value === 'TOT 7,5 com cuff · Cormack I · fixado a 21 cm';
    out.tuboNoEvento = /TOT 7,5 com cuff · Cormack I · fixado a 21 cm/.test(descDe('Intubação'));

    /* escrever à mão manda mais que o padrão */
    const det = f.querySelector('[name="via_aerea_detalhe"]');
    det.value = 'TOT 8,0 — Cormack IIa'; det.dataset.manual = '1';
    anestesia.viaAerea.montarDetalhe();
    out.respeitaOManual = det.value === 'TOT 8,0 — Cormack IIa';

    /* venoclise: tipo e calibre selecionados escrevem o evento */
    const acesso = Array.from(document.querySelectorAll('[name="dispositivos[]"]')).find(el => el.value === 'Acesso venoso periférico');
    acesso.checked = true; anestesia.disp.alternar(acesso);
    document.querySelector('[data-campo="tipo"][data-disp="Acesso venoso periférico"]').value = 'Cateter sobre agulha (Jelco)';
    document.querySelector('[data-campo="calibre"][data-disp="Acesso venoso periférico"]').value = '18G';
    document.querySelector('[data-campo="local"][data-disp="Acesso venoso periférico"]').value = 'dorso da mão D';
    anestesia.disp.montarDet('Acesso venoso periférico');
    out.venoclise = /Cateter sobre agulha \(Jelco\) 18G em dorso da mão D/.test(descDe('Venoclise'));

    /* seleções sobrevivem ao salvar/reabrir */
    const guardado = anestesia.disp.coletarDetalhes();
    document.querySelector('[data-campo="calibre"][data-disp="Acesso venoso periférico"]').value = '';
    document.querySelector('[name="disp_det[]"][data-disp="Acesso venoso periférico"]').value = '';
    anestesia.disp.restaurarDetalhes(guardado);
    out.voltaDepoisDeReabrir = document.querySelector('[data-campo="calibre"][data-disp="Acesso venoso periférico"]').value === '18G'
      && /18G/.test(document.querySelector('[name="disp_det[]"][data-disp="Acesso venoso periférico"]').value);

    /* descrições: registro do que foi feito, não manual de conduta */
    const D = anestesia.eventos.DESCRICOES;
    const orientacao = /vigiar|avisar a equipe|considerar|se indicado|conforme necessário|suspeitar|crise —/i;
    out.semOrientacoes = !orientacao.test(D['Pneumotórax'] + ' ' + D['Embolia gasosa (CO₂)'] + ' ' +
      D['Início do pneumoperitônio'] + ' ' + D['Fim do pneumoperitônio'] + ' ' + D['Enfisema subcutâneo']);
    out.temDescricaoDeVent = !!D['Início da ventilação mecânica'] && !!D['Fim da ventilação mecânica'];
    return out;
  });
  assert(r.ventDaTecnica, 'anestesia geral implica ventilação mecânica — não deveria ser remarcada à mão');
  assert(r.marcouInicioVent, 'o início da ventilação mecânica entra na linha do tempo');
  assert(r.naoRevisaEscolha, 'escolha já feita pelo anestesista não é revista pelo sistema');
  assert(r.marcouFimVent, 'voltar à espontânea marca o fim da ventilação mecânica');
  assert(r.montouTubo, 'tamanho, cuff, Cormack e fixação montam o texto do dispositivo');
  assert(r.tuboNoEvento, 'e esse texto entra na descrição da intubação');
  assert(r.respeitaOManual, 'o que foi escrito à mão vale mais que o padrão');
  assert(r.venoclise, 'tipo e calibre do cateter escrevem a descrição da venoclise');
  assert(r.voltaDepoisDeReabrir, 'as seleções precisam sobreviver ao salvar e reabrir');
  assert(r.semOrientacoes, 'a descrição do evento é o registro do que foi feito, não orientação ao profissional');
  assert(r.temDescricaoDeVent, 'os eventos novos de ventilação precisam de descrição técnica');
  await page.close();
});

/* 117) Exame fora da faixa é marca de CONFERÊNCIA: ajuda quem preenche, não é
   conteúdo do documento. Não imprime e não fica na ficha finalizada. */
await test('Pré: exame fora da faixa é marcado na tela, mas não imprime nem fica após finalizar', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    store.setList('pre', []);
    ui.navegar('pre');
    const f = document.getElementById('form-pre');
    const set = (n, v) => { const el = f.querySelector('[name="' + n + '"]'); if (el) el.value = v; };
    const marcado = n => /lab-fora/.test((f.querySelector('[name="' + n + '"]') || {}).className || '');

    set('sexo', 'Feminino');
    set('lab_hb', '9,5');      /* baixa */
    set('lab_k', '4,2');       /* normal */
    set('lab_na', '150');      /* alto */
    set('lab_creat', '1,0');   /* normal para mulher (0,6–1,1) */
    set('lab_plt', '90');      /* 90 mil — o hemograma é lido dos dois jeitos */
    pre.labs.marcar(f);
    out.marcouBaixo = marcado('lab_hb');
    out.marcouAlto = marcado('lab_na');
    out.deixouNormalEmPaz = !marcado('lab_k') && !marcado('lab_creat');
    out.entendeuMilhar = marcado('lab_plt');
    out.explicaNoTitulo = /faixa de referência/.test((f.querySelector('[name="lab_hb"]') || {}).title || '');

    /* a faixa segue o sexo: creatinina 1,2 é normal em homem e alta em mulher */
    set('lab_creat', '1,2');
    pre.labs.marcar(f);
    out.mulherAlta = marcado('lab_creat');
    set('sexo', 'Masculino');
    pre.labs.marcar(f);
    out.homemNormal = !marcado('lab_creat');

    /* finalizada: a marca sai — o documento assinado mostra o valor, sem grifo */
    const rec = store.save('pre', { nome: 'Ana', data: '2026-08-14', lab_hb: '9,5', _finalizado: true });
    let h = f.querySelector('[name="_id"]');
    if (!h) { h = document.createElement('input'); h.type = 'hidden'; h.name = '_id'; f.appendChild(h); }
    h.value = rec._id;
    pre.labs.marcar(f);
    out.finalizadaLimpa = !marcado('lab_hb');

    /* a impressão é montada do valor, não do campo: a marca nunca viaja */
    h.value = '';
    pre.labs.marcar(f);
    const html = printPreview._buildPre();
    out.naoVaiParaImpressao = html.indexOf('lab-fora') < 0 && /9,5/.test(html);

    store.setList('pre', []);
    return out;
  });
  assert(r.marcouBaixo && r.marcouAlto, 'valor fora da faixa precisa saltar aos olhos de quem preenche');
  assert(r.deixouNormalEmPaz, 'valor normal não pode ser marcado — marca demais é o mesmo que marca nenhuma');
  assert(r.entendeuMilhar, 'plaqueta escrita em milhares ("90") é 90 mil');
  assert(r.explicaNoTitulo, 'a marca precisa dizer qual é a faixa');
  assert(r.mulherAlta && r.homemNormal, 'a faixa acompanha o sexo do paciente');
  assert(r.finalizadaLimpa, 'ficha finalizada não carrega marca de conferência');
  assert(r.naoVaiParaImpressao, 'a marca não vai para o papel — mas o valor vai');
  await page.close();
});

/* 118) A data de nascimento não vinha do cadastro: o mapa procurava um campo
   chamado "nascimento" e a pré chama o dele de "nasc". Um apelido diferente
   derrubava o preenchimento inteiro daquele dado. */
await test('Pré: nascimento (e o resto da identificação) vêm do cadastro do paciente', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    ['pacientes', 'pre', 'anestesia'].forEach(m => store.setList(m, []));
    store.save('pacientes', {
      nome: 'Ana Souza', nascimento: '1980-05-10', sexo: 'Feminino',
      convenio: 'Amil', peso: '70', altura: '165'
    });
    ui.navegar('pre');
    const f = document.getElementById('form-pre');
    const v = n => (f.querySelector('[name="' + n + '"]') || {}).value || '';

    /* ao sair do campo do nome, a identificação vem sozinha */
    f.querySelector('[name="nome"]').value = 'Ana Souza';
    linker.autoPreencherDadosPaciente('Ana Souza', 'pre');
    out.trouxeNascimento = v('nasc') === '1980-05-10';
    out.derivouIdade = /^\d+$/.test(v('idade'));
    out.trouxeResto = v('sexo') === 'Feminino' && v('convenio') === 'Amil' && v('peso') === '70';

    /* não sobrescreve o que já está preenchido */
    pre.novo();
    f.querySelector('[name="nome"]').value = 'Ana Souza';
    f.querySelector('[name="nasc"]').value = '1979-01-02';
    linker.autoPreencherDadosPaciente('Ana Souza', 'pre');
    out.respeitaOQueJaEstava = v('nasc') === '1979-01-02';

    /* e pelo botão "Importar dados de paciente", que agora enxerga o cadastro */
    pre.novo();
    const pac = store.list('pacientes')[0];
    modelos.importarRegistro('pre', 'pacientes', pac._id);
    out.importouDoCadastro = v('nasc') === '1980-05-10' && v('nome') === 'Ana Souza';

    /* a ficha de anestesia guarda o nascimento como paciente.nasc */
    pre.novo();
    const fa = store.save('anestesia', {
      paciente: { nome: 'Bia Lima', nasc: '1990-03-04', sexo: 'Feminino', peso: '60' },
      procedimento: { descricao: 'Colecistectomia' }
    });
    modelos.importarRegistro('pre', 'anestesia', fa._id);
    out.importouDaFicha = v('nasc') === '1990-03-04';

    ['pacientes', 'pre', 'anestesia'].forEach(m => store.setList(m, []));
    return out;
  });
  assert(r.trouxeNascimento, 'a data de nascimento tem que vir do cadastro do paciente');
  assert(r.derivouIdade, 'com o nascimento, a idade sai sozinha');
  assert(r.trouxeResto, 'sexo, convênio e peso continuam vindo junto');
  assert(r.respeitaOQueJaEstava, 'o preenchimento automático nunca sobrescreve o que já está lá');
  assert(r.importouDoCadastro, 'o botão "Importar dados de paciente" precisa enxergar o cadastro de pacientes');
  assert(r.importouDaFicha, 'e o nascimento guardado na ficha de anestesia também serve');
  await page.close();
});

/* 119) Cirurgia proposta: nome longo e vários procedimentos encadeados não
   cabiam numa linha — o começo saía da vista e conferir exigia rolar dentro do
   campo. Campo alto, que cresce com o texto e continua sugerindo a CBHPM. */
await test('Pré: campo da cirurgia proposta ocupa a linha, cresce com o texto e mantém a CBHPM', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    ui.navegar('pre');
    document.querySelectorAll('#module-pre .card').forEach(c => c.classList.remove('collapsed'));
    const f = document.getElementById('form-pre');
    const el = f.querySelector('[name="cirurgia"]');
    out.ehCampoAlto = el.tagName === 'TEXTAREA';

    const antes = el.getBoundingClientRect().height;
    /* texto que não cabe nem em duas linhas: é aí que o campo tem que crescer */
    el.value = 'Colecistectomia videolaparoscópica + colangiografia intraoperatória + '
      + 'hernioplastia umbilical com tela + biópsia hepática + enterectomia segmentar + '
      + 'adesiólise extensa + colocação de dreno de cavidade + revisão de hemostasia + '
      + 'gastrostomia endoscópica percutânea + jejunostomia para nutrição enteral';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r2 => setTimeout(r2, 80));
    const depois = el.getBoundingClientRect().height;
    out.cresceuComOTexto = depois > antes;
    out.ocupaALinha = el.getBoundingClientRect().width > 400;
    out.semRolagemInterna = el.scrollHeight <= el.clientHeight + 4;

    /* Enter não quebra linha: o valor é uma descrição só (vários vão com " + ") */
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    out.enterNaoQuebra = ev.defaultPrevented;

    /* a sugestão da CBHPM continua funcionando no campo alto */
    el.value = 'coleci';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r2 => setTimeout(r2, 260));
    out.sugereCBHPM = !!(el._cbhpmBox && el._cbhpmBox.querySelectorAll('.cbhpm-item').length);

    /* e o valor continua sendo coletado como texto simples */
    el.value = 'Colecistectomia';
    out.coletaNormal = utils.formData('form-pre').cirurgia === 'Colecistectomia';
    return out;
  });
  assert(r.ehCampoAlto, 'o campo precisa comportar mais de uma linha');
  assert(r.ocupaALinha, 'e ocupar a largura da linha, não o tamanho padrão de um input');
  assert(r.cresceuComOTexto, 'com texto longo, o campo cresce em vez de esconder o começo');
  assert(r.semRolagemInterna, 'nada de rolar dentro do campo para ler o que foi escrito');
  assert(r.enterNaoQuebra, 'Enter não pode quebrar linha num campo que é uma descrição só');
  assert(r.sugereCBHPM, 'a sugestão da CBHPM continua valendo no campo alto');
  assert(r.coletaNormal, 'o valor continua sendo gravado como texto simples');
  await page.close();
});

/* 120) Uma linha de campos DENTRO de outra linha entrava como item qualquer e
   ocupava 1 das 12 colunas: os campos espremiam e os rótulos se atropelavam.
   Apareceu na via aérea do card 3, mas valia para qualquer grade aninhada. */
await test('Ficha: a linha da via aérea ocupa a largura toda e os campos não se espremem', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    ui.navegar('anestesia');
    document.querySelectorAll('#module-anestesia .card').forEach(c => c.classList.remove('collapsed'));
    const f = document.getElementById('form-anestesia');
    const va = f.querySelector('[name="via_aerea_uso"]');
    const linha = va.closest('.grid');
    const pai = linha.parentElement;

    out.estaAninhada = pai.classList.contains('grid');
    out.linhaOcupaTudo = Math.round(linha.getBoundingClientRect().width)
      >= Math.round(pai.getBoundingClientRect().width) - 2;

    /* a linha fecha em 12 colunas: nada é empurrado para fora */
    const cols = Array.from(linha.children)
      .map(el => (String(el.className).match(/col-(\d+)/) || [0, 0])[1])
      .reduce((s, n) => s + Number(n), 0);
    out.fechaEm12 = cols === 12;

    /* e o campo tem largura de campo, não de coluninha */
    out.campoUsavel = va.getBoundingClientRect().width > 150;

    /* detalhes e horário foram para a linha de baixo, também completa */
    const det = f.querySelector('[name="via_aerea_detalhe"]');
    out.detalheEmOutraLinha = det.closest('.grid') !== linha;
    out.detalheLargo = det.getBoundingClientRect().width > 300;
    return out;
  });
  assert(r.estaAninhada, 'a linha da via aérea é uma grade dentro de outra — é esse o caso que quebrava');
  assert(r.linhaOcupaTudo, 'grade aninhada precisa ocupar a largura inteira, não uma coluna');
  assert(r.fechaEm12, 'a linha tem que fechar em 12 colunas — passar disso espreme tudo');
  assert(r.campoUsavel, 'o campo precisa ter largura de campo');
  assert(r.detalheEmOutraLinha && r.detalheLargo, 'detalhes e horário ficam na linha de baixo, com espaço');
  await page.close();
});

/* 121) Bloqueio de plano (TAP, PEC, ESP, serrátil, QL) deposita entre fáscias,
   não ao redor do nervo: chamar de perineural descreveria errado o ato. */
await test('Bloqueio: via Interfascial existe e sobrevive ao espelho na tabela de medicações', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    ui.navegar('anestesia');
    const chk = document.querySelector('[name="bloqueio_realizado"]');
    chk.checked = true;
    anestesia.bloqueio.alternar(chk);
    anestesia.bloqueio.addMed({ nome: 'Ropivacaína 0,25%', dose: '200', unidade: 'mg', via: 'Interfascial' });

    const sel = document.querySelector('#bloq-meds-body [name="bloq_med_via[]"]');
    const vias = Array.from(sel.options).map(o => o.value);
    out.temOpcao = vias.indexOf('Interfascial') >= 0;
    out.ficouSelecionada = sel.value === 'Interfascial';
    /* ordem clínica: fica junto de perineural, antes de caudal */
    out.ordemUtil = vias.indexOf('Interfascial') === vias.indexOf('Perineural') + 1;

    /* a medicação do bloqueio é espelhada na seção 6: via que não existe na
       lista de lá não cola no campo, e a linha aparecia sem via nenhuma */
    const ids = anestesia.graficoUI._ctxIds();
    const espelho = Array.from(document.querySelectorAll('#' + ids.medsBody + ' tr'))
      .find(tr => (tr.querySelector('[name="med_nome[]"]') || {}).value === 'Ropivacaína 0,25%');
    out.espelhouComVia = !!espelho && (espelho.querySelector('[name="med_via[]"]') || {}).value === 'Interfascial';
    /* perineural tinha o mesmo problema e também precisa existir lá */
    out.perineuralTambem = VIAS.indexOf('Perineural') >= 0;
    return out;
  });
  assert(r.temOpcao, 'a via interfascial precisa existir no bloqueio');
  assert(r.ficouSelecionada, 'e ser aceita quando escolhida');
  assert(r.ordemUtil, 'fica ao lado de perineural, que é a via mais próxima');
  assert(r.espelhouComVia, 'a via tem que sobreviver ao espelho na tabela de medicações');
  assert(r.perineuralTambem, 'perineural também precisa existir lá — se perdia do mesmo jeito');
  await page.close();
});

/* 122) Acessos e dispositivos (card 5): marcar o acesso É registrar o
   procedimento — o evento entra sozinho e o cateter escolhido vira a descrição. */
await test('Ficha: acesso marcado no card 5 vira evento na linha do tempo', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    ui.navegar('anestesia');
    const f = document.getElementById('form-anestesia');
    document.getElementById('eventos-body').innerHTML = '';
    const marcar = (valor, on) => {
      const el = Array.from(f.querySelectorAll('[name="dispositivos[]"]')).find(c => c.value === valor);
      el.checked = on !== false;
      anestesia.disp.alternar(el);
      return el;
    };
    const descDe = tipo => {
      const tr = Array.from(document.querySelectorAll('#eventos-body tr'))
        .find(x => (x.querySelector('[name="evt_tipo[]"]') || {}).value === tipo);
      return tr ? (tr.querySelector('[name="evt_obs[]"]') || {}).value : null;
    };
    const quantos = tipo => Array.from(document.querySelectorAll('#eventos-body [name="evt_tipo[]"]'))
      .filter(el => el.value === tipo).length;

    /* AVP: o evento nasce ao marcar, antes mesmo de detalhar */
    marcar('Acesso venoso periférico');
    out.criouVenoclise = descDe('Venoclise') !== null;

    /* e o que se escolhe depois desce sozinho para a descrição */
    document.querySelector('[data-campo="tipo"][data-disp="Acesso venoso periférico"]').value = 'Cateter sobre agulha (Jelco)';
    document.querySelector('[data-campo="calibre"][data-disp="Acesso venoso periférico"]').value = '20G';
    document.querySelector('[data-campo="local"][data-disp="Acesso venoso periférico"]').value = 'fossa antecubital E';
    anestesia.disp.montarDet('Acesso venoso periférico');
    out.detalheDesceu = /Cateter sobre agulha \(Jelco\) 20G em fossa antecubital E/.test(descDe('Venoclise'));

    /* os demais acessos e sondas seguem o mesmo caminho */
    marcar('Acesso arterial');
    marcar('Acesso venoso central');
    marcar('Sonda vesical');
    marcar('Sonda gástrica');
    out.arterial = descDe('Punção arterial') !== null;
    out.central = descDe('Acesso venoso central') !== null;
    out.vesical = descDe('Sondagem vesical (Foley)') !== null;
    out.gastrica = descDe('Sondagem orogástrica') !== null;

    /* detalhe em texto livre da sonda também entra na descrição */
    const detSonda = Array.from(f.querySelectorAll('[name="disp_det[]"]')).find(x => x.getAttribute('data-disp') === 'Sonda gástrica');
    detSonda.value = 'sonda 16Fr, narina D';
    anestesia.eventos.atualizarDescricoes();
    out.sondaDetalhada = /sonda 16Fr, narina D/.test(descDe('Sondagem orogástrica'));

    /* dreno não é procedimento com evento próprio: nada é inventado */
    marcar('Dreno torácico');
    out.drenoNaoInventa = quantos('Venoclise') === 1 &&
      !Array.from(document.querySelectorAll('#eventos-body [name="evt_tipo[]"]')).some(el => /dreno/i.test(el.value));

    /* desmarcar e marcar de novo não duplica */
    marcar('Acesso arterial', false);
    marcar('Acesso arterial');
    out.naoDuplica = quantos('Punção arterial') === 1;

    /* trocar Foley por alívio é o mesmo procedimento: remarcar não repete */
    const trVes = Array.from(document.querySelectorAll('#eventos-body tr'))
      .find(x => (x.querySelector('[name="evt_tipo[]"]') || {}).value === 'Sondagem vesical (Foley)');
    trVes.querySelector('[name="evt_tipo[]"]').value = 'Sondagem vesical de alívio';
    marcar('Sonda vesical', false);
    marcar('Sonda vesical');
    out.varianteNaoDuplica = quantos('Sondagem vesical de alívio') + quantos('Sondagem vesical (Foley)') === 1;

    /* desmarcar tira o evento que o sistema escreveu... */
    marcar('Acesso venoso central', false);
    out.desmarcarLimpa = descDe('Acesso venoso central') === null;

    /* ...mas nunca o que o anestesista escreveu à mão */
    const trVeno = Array.from(document.querySelectorAll('#eventos-body tr'))
      .find(x => (x.querySelector('[name="evt_tipo[]"]') || {}).value === 'Venoclise');
    const obsVeno = trVeno.querySelector('[name="evt_obs[]"]');
    obsVeno.value = 'Punção difícil, 2 tentativas.';
    anestesia.eventos._marcarManual(obsVeno);
    marcar('Acesso venoso periférico', false);
    out.preservaOManual = descDe('Venoclise') === 'Punção difícil, 2 tentativas.';

    /* reabrir a ficha não pode duplicar o que já está gravado */
    const gravado = anestesia.eventos.coletar();
    anestesia.eventos.restaurar(gravado);
    const el = Array.from(f.querySelectorAll('[name="dispositivos[]"]')).find(c => c.value === 'Acesso arterial');
    anestesia.disp.alternar(el, { restaurando: true });
    out.reabrirNaoDuplica = quantos('Punção arterial') === 1;
    return out;
  });
  assert(r.criouVenoclise, 'marcar o acesso venoso já registra a venoclise na linha do tempo');
  assert(r.detalheDesceu, 'o cateter escolhido no card escreve a descrição do evento');
  assert(r.arterial && r.central, 'acesso arterial e central também registram o procedimento');
  assert(r.vesical && r.gastrica, 'sondas vesical e gástrica idem');
  assert(r.sondaDetalhada, 'o detalhe da sonda entra na descrição do evento');
  assert(r.drenoNaoInventa, 'dreno não é procedimento com evento próprio — nada inventado');
  assert(r.naoDuplica, 'remarcar o mesmo acesso não pode duplicar o evento');
  assert(r.varianteNaoDuplica, 'Foley e alívio são o mesmo registro — não duplicam');
  assert(r.desmarcarLimpa, 'desmarcar retira o evento que o sistema tinha escrito');
  assert(r.preservaOManual, 'o que foi escrito à mão fica, mesmo desmarcando');
  assert(r.reabrirNaoDuplica, 'reabrir a ficha não pode multiplicar os eventos gravados');
  await page.close();
});

/* 123) CBHPM 2022 completa: fonte única de código e descrição. Busca por
   descrição, por código formatado e por código só numérico; classificação
   (porte, AN, código anestésico próprio) disponível para o financeiro. */
await test('CBHPM 2022: tabela completa, busca por número e classificação anestésica', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    out.versao = CBHPM_VERSAO;
    out.tamanho = CBHPM_2022.length;
    out.capitulos = ['1.', '2.', '3.', '4.'].filter(p => CBHPM_2022.some(c => c[0].startsWith(p))).length;

    /* teste 1 do pacote: "colecist" só sugere CBHPM */
    const colecist = cbhpm.buscar('colecist', 10);
    out.colecist = colecist.length > 0 && colecist.every(i => !!cbhpm.achar(i.codigo));

    /* teste 2: o código numérico acha a consulta */
    out.porNumero = (cbhpm.buscar('10101012')[0] || {}).codigo === '1.01.01.01-2' &&
      (cbhpm.achar('10101012') || [])[1] === 'Consulta em horário normal ou preestabelecido';
    out.porCodigo = (cbhpm.buscar('1.01.01.01-2')[0] || {}).codigo === '1.01.01.01-2';

    /* sem acento e sem caixa */
    out.semAcento = cbhpm.buscar('cesarea').some(i => /Cesariana|cesárea/i.test(i.descricao));
    out.semCaixa = cbhpm.buscar('COLECIST').length === cbhpm.buscar('colecist').length;

    /* relevância: quem começa pelo que foi digitado vem antes */
    out.relevancia = /^Colecist/i.test((cbhpm.buscar('colecist')[0] || {}).descricao || '');

    /* teste 9 e 10: endoscopia diagnóstica × intervencionista */
    const colono = cbhpm.anestesiaDe('4.02.01.08-2');
    const polip = cbhpm.anestesiaDe('4.02.02.54-2');
    out.colono = colono.codigo === '3.16.02.23-1' && colono.porte_anest === 2 && colono.porte_ref === '3C';
    out.polip = polip.codigo === '3.16.02.24-0' && polip.porte_anest === 3 && polip.porte_ref === '4C';

    /* AN ↔ porte de referência (classificação, não preço) */
    out.anPorte = cbhpm.porteDoAN(0) === '' && cbhpm.porteDoAN(1) === '3A' && cbhpm.porteDoAN(2) === '3C' &&
      cbhpm.porteDoAN(3) === '4C' && cbhpm.porteDoAN(4) === '6B' && cbhpm.porteDoAN(5) === '7C' &&
      cbhpm.porteDoAN(6) === '9B' && cbhpm.porteDoAN(7) === '10C' && cbhpm.porteDoAN(8) === '12A';

    /* classificação completa disponível */
    const i = cbhpm.info('4.02.01.08-2');
    out.info = i.codigo_numerico === '40201082' && !!i.capitulo && !!i.grupo && !!i.subgrupo &&
      i.porte === '6A' && i.pagina > 0 && i.versao === CBHPM_VERSAO;

    /* teste 15: código da tabela anterior que saiu da 2022 continua sendo
       resolvido (registro antigo não perde a descrição), mas não é sugerido */
    out.legadoResolve = (cbhpm.achar('3.06.02.02-5') || [])[1] === 'Coleta de fluxo papilar de mama';
    out.legadoNaoSugere = !cbhpm.buscar('coleta de fluxo papilar').some(x => x.codigo === '3.06.02.02-5');

    /* nunca sugerir grupo/observação: só entram registros selecionáveis */
    out.soProcedimento = !cbhpm.buscar('consulta', 40).some(x => /^[A-ZÇÃÕÁÉÍÓÚ\s\/,-]+$/.test(x.descricao));
    return out;
  });
  assert(r.versao === 'CBHPM 2022 — agosto/2023', 'a versão da tabela precisa ficar registrada');
  assert(r.tamanho === 4882, 'a tabela deveria trazer os 4.882 procedimentos selecionáveis, veio ' + r.tamanho);
  assert(r.capitulos === 4, 'os quatro capítulos precisam estar na tabela');
  assert(r.colecist, 'digitar "colecist" tem que sugerir só procedimento da CBHPM');
  assert(r.porNumero, 'o código numérico (10101012) tem que achar a consulta');
  assert(r.porCodigo, 'e o código formatado também');
  assert(r.semAcento && r.semCaixa, 'a busca não pode depender de acento nem de maiúscula');
  assert(r.relevancia, 'quem começa pelo que foi digitado vem primeiro');
  assert(r.colono, 'colonoscopia diagnóstica → 3.16.02.23-1, AN 2');
  assert(r.polip, 'polipectomia de cólon → 3.16.02.24-0, AN 3');
  assert(r.anPorte, 'a relação AN ↔ porte de referência precisa estar completa');
  assert(r.info, 'classificação (capítulo, grupo, porte, página) precisa vir junto');
  assert(r.legadoResolve, 'código da tabela anterior continua sendo resolvido');
  assert(r.legadoNaoSugere, 'mas não pode ser sugerido — não está na tabela vigente');
  assert(r.soProcedimento, 'grupo e observação nunca podem virar sugestão');
  await page.close();
});

/* 124) Consulta gera Financeiro: a consulta em si + cada procedimento
   realizado, cada um com o seu código, fração e rastreabilidade. Editar
   atualiza as mesmas linhas; retirar um procedimento não deixa linha órfã. */
await test('Consulta → Financeiro: 1 linha da consulta + 1 por procedimento, sem duplicar', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    store.setList('financeiro', []); store.setList('consulta', []); store.setList('pre', []);
    ui.navegar('consulta');
    const f = document.getElementById('form-consulta');
    f.querySelector('[name="nome"]').value = 'Paciente da Consulta';
    f.querySelector('[name="data"]').value = utils.hojeISO();

    /* dois procedimentos além da consulta */
    consulta.procs.add({ codigo: '4.02.01.08-2' });   /* colonoscopia */
    consulta.procs.add({ codigo: '3.01.01.01-8' });   /* abrasão cirúrgica */
    document.querySelectorAll('#consulta-procs-body tr')
      .forEach(tr => consulta.procs._onCodigo(tr.querySelector('[name="cproc_cod[]"]')));
    out.descricoesVieram = Array.from(document.querySelectorAll('#consulta-procs-body [name="cproc_desc[]"]'))
      .every(el => el.value.length > 3);
    /* valor-base veio da tabela de preços configurada, não de lugar nenhum */
    out.baseDaTabela = Array.from(document.querySelectorAll('#consulta-procs-body [name="cproc_base[]"]'))
      .every(el => Number(el.value) > 0);

    consulta.salvar();
    out.semFinanceiroAoSalvar = store.list('financeiro').length === 0;   /* só na finalização */

    const doc = store.last('consulta');
    fin.fromDoc('consulta', doc);
    const linhas = store.list('financeiro');
    out.tresLinhas = linhas.length === 3;
    out.umaDeConsulta = linhas.filter(x => x.tipo_honorario === 'consulta').length === 1;
    out.codigoDaConsulta = (linhas.find(x => x.tipo_honorario === 'consulta') || {}).cbhpm_codigo === '1.01.01.01-2';
    out.doisProcedimentos = linhas.filter(x => x.tipo_honorario === 'procedimento').length === 2;
    /* rastreabilidade exigida: de onde veio, qual linha, qual código, com que regra */
    out.rastreio = linhas.every(x => x._origemTipo === 'consulta' && x._origemId === doc._id &&
      x._origemLinhaId !== undefined && x.cbhpm_versao === CBHPM_VERSAO &&
      x.quantidade >= 1 && x.fracao != null && x.tipo_honorario);
    /* valor não é inventado: sai de base × qtd × fração */
    const proc = linhas.find(x => x.cbhpm_codigo === '4.02.01.08-2');
    out.valorCalculado = Math.abs(proc.valor_final - proc.valor_base * proc.quantidade * (proc.fracao / 100)) < 0.01;

    /* idempotência: gerar de novo atualiza as MESMAS linhas */
    const res2 = fin.fromDoc('consulta', doc);
    out.naoDuplicou = store.list('financeiro').length === 3 && res2.criadas === 0 && res2.atualizadas === 3;

    /* retirar um procedimento não pode deixar cobrança fantasma */
    const doc2 = Object.assign({}, doc, { _procsRealizados: doc._procsRealizados.slice(0, 1) });
    store.save('consulta', doc2);
    fin.fromDoc('consulta', doc2);
    out.duasAposRetirar = store.list('financeiro').length === 2;

    /* ...mas linha já paga não some: fica cancelada, com o motivo */
    const paga = store.list('financeiro').find(x => x._origemLinhaId === 'cproc-0');
    store.save('financeiro', Object.assign({}, paga, { pago: true }));
    fin.fromDoc('consulta', Object.assign({}, doc2, { _procsRealizados: [] }));
    const restante = store.list('financeiro').find(x => x._origemLinhaId === 'cproc-0');
    out.pagaViraCancelada = !!restante && restante.status === 'cancelado' && /retirado/i.test(restante.observacoes || '');

    /* pré-anestésica gera a linha de consulta, e só uma */
    store.setList('financeiro', []);
    const pre1 = store.save('pre', { nome: 'Paciente da Pré', data: utils.hojeISO(), cirurgia: 'Colecistectomia sem colangiografia' });
    fin.fromDoc('pre', pre1);
    const fp = store.list('financeiro');
    out.preGeraConsulta = fp.length === 1 && fp[0].cbhpm_codigo === '1.01.01.01-2' && fp[0].tipo_honorario === 'consulta';
    out.prePrecoDaTabela = fp[0].valor_base > 0;
    fin.fromDoc('pre', pre1);
    out.preNaoDuplica = store.list('financeiro').length === 1;

    /* o documento impresso diz o que foi feito (código e descrição), sem preço */
    ui.navegar('consulta');
    consulta.procs.limpar();
    const tri = consulta.procs.add({ codigo: '3.10.05.12-8', quantidade: 2 });
    consulta.procs._onCodigo(tri.querySelector('[name="cproc_cod[]"]'));
    const html = printPreview._buildConsulta();
    out.impressaoLista = html.indexOf('Procedimentos realizados nesta consulta') >= 0 &&
      html.indexOf('3.10.05.12-8') >= 0 && html.indexOf('×2') >= 0;
    const baseImp = (consulta.procs.coletar()[0] || {}).valor_base;
    out.impressaoSemValor = !!baseImp && html.indexOf(String(Math.floor(baseImp))) < 0;
    consulta.procs.limpar();

    store.setList('financeiro', []); store.setList('consulta', []); store.setList('pre', []);
    return out;
  });
  assert(r.descricoesVieram, 'o código digitado tem que trazer a descrição da CBHPM');
  assert(r.baseDaTabela, 'o valor-base tem que vir da tabela de preços configurada');
  assert(r.semFinanceiroAoSalvar, 'salvar sem finalizar não gera financeiro');
  assert(r.tresLinhas, 'consulta + 2 procedimentos = 3 linhas financeiras');
  assert(r.umaDeConsulta && r.codigoDaConsulta, 'exatamente 1 linha de consulta, no código 1.01.01.01-2');
  assert(r.doisProcedimentos, 'e 1 linha para cada procedimento realizado');
  assert(r.rastreio, 'cada linha precisa dizer de onde veio, com que código e com que regra');
  assert(r.valorCalculado, 'valor final = base × quantidade × fração');
  assert(r.naoDuplicou, 'editar o mesmo registro atualiza as linhas, nunca duplica');
  assert(r.duasAposRetirar, 'procedimento retirado leva a sua linha junto');
  assert(r.pagaViraCancelada, 'linha já paga não é apagada: fica cancelada com o motivo');
  assert(r.preGeraConsulta, 'a pré-anestésica gera a linha de consulta');
  assert(r.prePrecoDaTabela, 'com o preço vindo da configuração, não do código');
  assert(r.preNaoDuplica, 'e salvar de novo não cria uma segunda');
  assert(r.impressaoLista, 'o documento da consulta precisa listar o que foi feito, com o código');
  assert(r.impressaoSemValor, 'valor e fração são conta interna — não vão para o documento do paciente');
  await page.close();
});

/* 125) Frações em múltiplos procedimentos: a regra sugere, o usuário decide.
   E o código oficial fica guardado junto do texto, em todo campo CBHPM. */
await test('CBHPM: fração sugerida e editável, AN 0 sem honorário e código guardado como chave', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    ui.navegar('consulta');
    const f = document.getElementById('form-consulta');
    consulta.procs.limpar();
    consulta.procs.add({ codigo: '3.10.05.12-8' });   /* colecistectomia — porte maior */
    consulta.procs.add({ codigo: '3.01.01.01-8' });   /* abrasão — porte menor */
    const linhas = () => Array.from(document.querySelectorAll('#consulta-procs-body tr'));
    linhas().forEach(tr => consulta.procs._onCodigo(tr.querySelector('[name="cproc_cod[]"]')));
    consulta.procs.sugerirFracoes();
    const fr = () => linhas().map(tr => Number(tr.querySelector('[name="cproc_fracao[]"]').value));
    out.principal100 = fr()[0] === 100;
    out.mesmaVia50 = fr()[1] === 50;
    /* via diferente sugere 70% */
    const via = linhas()[1].querySelector('[name="cproc_via[]"]');
    via.value = 'diferente';
    consulta.procs.sugerirFracoes();
    out.viaDiferente70 = fr()[1] === 70;
    /* e o ajuste manual manda: contrato de convênio pode ter regra própria */
    const frEl = linhas()[1].querySelector('[name="cproc_fracao[]"]');
    frEl.value = '85';
    consulta.procs.recalcular();
    const calc = Number(linhas()[1].querySelector('[name="cproc_valor[]"]').value);
    const base = Number(linhas()[1].querySelector('[name="cproc_base[]"]').value);
    out.manualVale = Math.abs(calc - base * 0.85) < 0.01;

    /* AN 0 = anestesia local: não se inventa honorário anestésico */
    const an0 = CBHPM_2022.find(c => c[3] === 0 && c[0].startsWith('3.'));
    out.an0SemValor = precos.base(an0[0], 'anestesia').valor === null &&
      precos.base(an0[0], 'anestesia').origem === 'an0';
    /* AN 5 usa a tabela configurada — nada de valor fixo no código */
    const an5 = CBHPM_2022.find(c => c[3] === 5);
    const p5 = precos.base(an5[0], 'anestesia');
    out.an5DaTabela = p5.valor > 0 && p5.origem === 'porte_anest' && !!p5.tabela;
    /* preço específico por código tem precedência sobre o porte */
    precos.definirPorCodigo(an5[0], 123.45);
    const p5b = precos.base(an5[0], 'anestesia');
    out.codigoTemPrecedencia = p5b.valor === 123.45 && p5b.origem === 'codigo';
    precos.definirPorCodigo(an5[0], '');

    /* o código escolhido fica guardado junto do texto (chave da guia) */
    ui.navegar('pre');
    const cir = document.querySelector('#form-pre [name="cirurgia"]');
    cbhpm.aplicarTodos(document.getElementById('form-pre'));
    const hidden = document.querySelector('#form-pre [name="cirurgia_cbhpm"]');
    out.temCampoCodigo = !!hidden;
    cir.value = 'coleciste';
    cbhpm._abrir(cir);
    const item = document.querySelector('#form-pre .cbhpm-box .cbhpm-item');
    if (item) cbhpm._escolher(item);
    out.escolheuNoTextarea = cir.value.length > 5;               /* textarea aceita a escolha */
    out.guardouCodigo = !!hidden && /^\d\.\d\d\./.test(hidden.value);
    /* trocar o texto à mão derruba o código: nada de código oficial em silêncio */
    cir.value = 'outra coisa qualquer';
    cbhpm._conferirCodigo(cir);
    out.textoTrocadoDerrubaCodigo = hidden.value === '';

    /* código inventado não é aceito em silêncio: fica marcado no campo */
    ui.navegar('consulta');
    consulta.procs.limpar();
    const linha = consulta.procs.add({});
    const codEl = linha.querySelector('[name="cproc_cod[]"]');
    codEl.value = '9.99.99.99-9'; cbhpm._conferirExiste(codEl);
    const marcou = codEl.classList.contains('cbhpm-cod-invalido');
    codEl.value = '1.01.01.01-2'; cbhpm._conferirExiste(codEl);
    out.codigoInventadoMarcado = marcou && !codEl.classList.contains('cbhpm-cod-invalido');

    /* endoscopia alta + baixa no mesmo dia = vias independentes: a segunda
       entra a 70%, não a 50% */
    consulta.procs.limpar();
    const tBaixa = consulta.procs.add({ codigo: '4.02.01.08-2' });   /* colonoscopia */
    const tAlta = consulta.procs.add({ codigo: '4.02.01.12-0' });    /* endoscopia digestiva alta */
    [tBaixa, tAlta].forEach(tr => consulta.procs._onCodigo(tr.querySelector('[name="cproc_cod[]"]')));
    consulta.procs.sugerirFracoes();
    const viaDe = tr => (tr.querySelector('[name="cproc_via[]"]') || {}).value;
    const fracDe = tr => (tr.querySelector('[name="cproc_fracao[]"]') || {}).value;
    out.viaEndoscopica = cbhpm.viaEndoscopica('4.02.01.08-2') === 'baixa' &&
      cbhpm.viaEndoscopica('4.02.01.12-0') === 'alta' &&
      cbhpm.viaEndoscopica('3.10.05.12-8') === '' &&
      viaDe(tAlta) === 'diferente' && fracDe(tAlta) === '70';

    /* mas via escolhida à mão manda mais que a sugestão */
    const selVia = tAlta.querySelector('[name="cproc_via[]"]');
    selVia.value = 'mesma';
    consulta.procs._viaManual(selVia);
    out.viaManualManda = viaDe(tAlta) === 'mesma' && fracDe(tAlta) === '50';

    /* trocar o código depois tem de deixar dono e rastro */
    const codTroca = tAlta.querySelector('[name="cproc_cod[]"]');
    codTroca.value = '3.10.05.12-8';
    consulta.procs._onCodigo(codTroca);
    const linhaTroca = consulta.procs.coletar()[1];
    out.trocaDeCodigoTemDono = linhaTroca.codigo_trocado === true &&
      linhaTroca.codigo_anterior === '4.02.01.12-0' && !!linhaTroca.codigo_trocado_em;

    consulta.procs.limpar();
    return out;
  });
  assert(r.principal100, 'o de maior valor entra a 100%');
  assert(r.mesmaVia50, 'os demais, na mesma via, a 50%');
  assert(r.viaDiferente70, 'via de acesso diferente sugere 70%');
  assert(r.manualVale, 'a fração ajustada à mão é a que vale');
  assert(r.an0SemValor, 'AN 0 não gera honorário anestésico automático');
  assert(r.an5DaTabela, 'AN 5 usa a tabela de preços configurada, sem valor fixo no código');
  assert(r.codigoTemPrecedencia, 'preço específico do código tem precedência sobre o porte');
  assert(r.temCampoCodigo, 'todo campo CBHPM guarda o código escolhido');
  assert(r.escolheuNoTextarea, 'escolher a sugestão precisa funcionar no campo alto da cirurgia proposta');
  assert(r.guardouCodigo, 'e o código oficial fica guardado como chave');
  assert(r.textoTrocadoDerrubaCodigo, 'trocar a descrição à mão não pode manter o código antigo pendurado');
  assert(r.codigoInventadoMarcado, 'código que não existe na tabela precisa ficar marcado antes de virar guia');
  assert(r.viaEndoscopica, 'endoscopia alta e baixa são vias independentes — a via já vem sugerida como diferente');
  assert(r.viaManualManda, 'via escolhida à mão não é revista pela sugestão');
  assert(r.trocaDeCodigoTemDono, 'trocar o código depois precisa registrar quem trocou e de qual código');
  await page.close();
});

/* 126) Orçamento: só CBHPM, com porte à vista, fração por linha e preço da
   configuração do sistema — o seed da CBHPM não redefine preço nenhum. */
await test('Orçamento: fração por linha editável e preço vindo da tabela configurada', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    ui.navegar('orcamento');
    orcamento.init();
    document.getElementById('orcamento-body').innerHTML = '';
    orcamento.addProc({ codigo: '3.10.05.12-8' });   /* colecistectomia — AN maior */
    orcamento.addProc({ codigo: '3.01.01.01-8' });   /* abrasão — AN menor */
    const linhas = () => Array.from(document.querySelectorAll('#orcamento-body tr'));
    linhas().forEach(tr => orcamento._onCodigo(tr.querySelector('[name="orc_cod[]"]')));
    orcamento.recalcular();
    const val = n => linhas().map(tr => (tr.querySelector('[name="' + n + '[]"]') || {}).value);
    out.descricaoVeio = val('orc_desc').every(v => v.length > 3);
    out.porteAparece = val('orc_pcir').every(v => v) && val('orc_panest').every(v => v !== '');
    out.fracaoPadrao = val('orc_frac').join('/') === '100/50';
    out.refCalculado = val('orc_ref').every(v => /R\$/.test(v));

    /* via diferente → 70% */
    const vias = document.querySelectorAll('#orcamento-body [name="orc_via[]"]');
    vias[1].value = 'diferente'; orcamento._onVia(vias[1]);
    out.viaDiferente = val('orc_frac')[1] === '70';

    /* e a fração ajustada à mão manda no valor de referência */
    const f2 = document.querySelectorAll('#orcamento-body [name="orc_frac[]"]')[1];
    const antes = parseFloat(val('orc_ref')[1].replace(/[^\d,]/g, '').replace(',', '.'));
    f2.value = '85'; f2.dispatchEvent(new Event('input', { bubbles: true }));
    const depois = parseFloat(val('orc_ref')[1].replace(/[^\d,]/g, '').replace(',', '.'));
    out.manualManda = depois > antes && /85%/.test(val('orc_ref')[1]);
    out.fracaoSalva = orcamento.coletar().procedimentos[1].fracao === '85';

    /* preço próprio do código tem precedência — e some quando removido */
    const antesPreco = precos.base('3.10.05.12-8', 'medico');
    precos.definirPorCodigo('3.10.05.12-8', 999.99);
    const comPreco = precos.base('3.10.05.12-8', 'medico');
    precos.definirPorCodigo('3.10.05.12-8', '');
    const semPreco = precos.base('3.10.05.12-8', 'medico');
    out.precedencia = comPreco.valor === 999.99 && comPreco.origem === 'codigo' &&
      semPreco.origem === antesPreco.origem && semPreco.valor === antesPreco.valor;
    /* o valor nunca sai da CBHPM: sai da tabela configurada */
    out.valorDaConfiguracao = antesPreco.origem === 'porte_cir' && !!antesPreco.tabela;

    /* AN → porte tem uma fonte só: a relação da CBHPM vale para classificar
       E para derivar valor, senão haveria dois números verdadeiros ao mesmo tempo */
    const tabs = orcamento.tabelasAnest();
    const cir = tabs.cir2018.valores;
    const der = tabs.anest2018_conv.valores;
    out.derivaPelaCBHPM = [1, 2, 3, 4, 5, 6, 7, 8]
      .every(an => Math.abs(der[an] - cir[cbhpm.AN_PORTE[an]]) < 0.01) && der[0] === 0;
    /* tabela com valores próprios por AN não é derivada de nada */
    out.fixasIntactas = tabs.cbhpm2015.valores[3] === 292.50 && tabs.unimed.valores[8] === 1874.88;
    return out;
  });
  assert(r.descricaoVeio, 'o código escolhido traz a descrição oficial');
  assert(r.porteAparece, 'porte médico e anestésico ficam à vista no orçamento');
  assert(r.fracaoPadrao, 'principal 100% e o seguinte 50% na mesma via');
  assert(r.refCalculado, 'o valor de referência sai da tabela configurada');
  assert(r.viaDiferente, 'via de acesso diferente sugere 70%');
  assert(r.manualManda, 'a fração ajustada à mão é a que vale no cálculo');
  assert(r.fracaoSalva, 'e é gravada junto do orçamento');
  assert(r.precedencia, 'preço próprio do código vence o porte, e removê-lo devolve o valor por porte');
  assert(r.valorDaConfiguracao, 'o preço vem da configuração do sistema, nunca da CBHPM');
  assert(r.derivaPelaCBHPM, 'a tabela derivada tem que usar a relação AN → porte da CBHPM, a mesma da classificação');
  assert(r.fixasIntactas, 'tabela com valor próprio por AN não passa por conversão — fica como foi cadastrada');
  await page.close();
});

/* 127) Rascunho fechado fica fechado. A aba voltava porque a exclusão na
   nuvem era disparada sem conferir o resultado, e porque cada aparelho
   mandava o seu "Rascunho 1" em branco para os outros. */
await test('Rascunhos: fechar não deixa a aba voltar, e aba em branco não se multiplica', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    const M = 'anestesia';
    const vazio = { paciente: { nome: '' }, procedimento: { data: '2026-08-14' } };
    localStorage.removeItem(rascunhos.LAPIDES_KEY + M);

    /* o que se vê na tela: três abas "Rascunho 1" em branco + a do paciente */
    rascunhos.setList(M, [
      { id: 'a1', label: 'Rascunho 1', dados: vazio, updatedAt: '2026-08-14T10:00:00Z' },
      { id: 'a2', label: 'Rascunho 1', dados: vazio, updatedAt: '2026-08-14T11:00:00Z' },
      { id: 'a3', label: 'Rascunho 1', dados: vazio, updatedAt: '2026-08-14T12:00:00Z' },
      { id: 'a4', label: 'LAIS', dados: { paciente: { nome: 'LAIS' } }, updatedAt: '2026-08-14T12:30:00Z' }
    ]);
    rascunhos.setAtivo(M, 'a4');
    rascunhos.limparVazios(M);
    const ids = rascunhos.list(M).map(x => x.id);
    out.sobrouUmaEmBranco = ids.length === 2 && ids.indexOf('a4') >= 0;
    out.oTrabalhoFicou = !!rascunhos.list(M).find(x => x.id === 'a4');
    out.sobrasComLapide = ['a1', 'a2'].every(id => rascunhos.fechadoAqui(M, id));

    /* a aba em branco que sobrou não sobe para a nuvem */
    demo.ativo = () => false;
    cloud.estaConfigurado = () => true;
    cloud.estaLogado = () => true;
    cloud._garantirToken = async () => true;
    cloud.config = () => ({ url: 'http://nuvem.teste', anonKey: 'k' });
    cloud.session = () => ({ user: { id: 'u1' } });
    cloud._headers = () => ({});
    const enviados = [];
    const apagados = [];
    const fetchOriginal = window.fetch;
    window.fetch = async (url, opts) => {
      const o = opts || {};
      if (o.method === 'DELETE') { apagados.push(String(url)); return { ok: true, json: async () => [] }; }
      if (o.method === 'POST') { enviados.push(JSON.parse(o.body || '[]')); return { ok: true, json: async () => [] }; }
      /* pull: a nuvem ainda tem o fechado e um vazio de outro aparelho */
      return { ok: true, json: async () => ([
        { doc_id: 'a1', dados: { id: 'a1', label: 'Rascunho 1', dados: vazio, updatedAt: '2026-08-14T10:00:00Z' } },
        { doc_id: 'b9', dados: { id: 'b9', label: 'Rascunho 1', dados: vazio, updatedAt: '2026-08-14T13:00:00Z' } },
        { doc_id: 'a4', dados: { id: 'a4', label: 'LAIS', dados: { paciente: { nome: 'LAIS' } }, updatedAt: '2026-08-14T12:30:00Z' } }
      ]) };
    };
    await rascunhosSync.enviar(M);
    const subiram = (enviados[0] || []).map(x => x.doc_id);
    out.soSobeComConteudo = subiram.length === 1 && subiram[0] === 'a4';
    out.retentouApagar = apagados.some(u => u.indexOf('a1') >= 0) && apagados.some(u => u.indexOf('a2') >= 0);

    /* e o pull não ressuscita o que foi fechado nem traz aba em branco */
    await rascunhosSync.puxar(M);
    const depois = rascunhos.list(M).map(x => x.id);
    out.naoRessuscita = depois.indexOf('a1') < 0;
    out.naoTrazVazioDeFora = depois.indexOf('b9') < 0;
    out.mantemOTrabalho = depois.indexOf('a4') >= 0;
    window.fetch = fetchOriginal;

    /* numeração não repete mais */
    rascunhos.setList(M, [{ id: 'x', label: 'Rascunho 3', dados: null }]);
    rascunhos.setAtivo(M, null);
    rascunhos.novo(M);
    out.numeraDireito = rascunhos.list(M).map(x => x.label).join('/') === 'Rascunho 3/Rascunho 4';

    /* o que conta como vazio é conservador: dois campos de rotina */
    out.vazioEhVazio = rascunhos.temConteudo(M, { dados: vazio }) === false;
    out.comNomeConta = rascunhos.temConteudo(M, { dados: { paciente: { nome: 'X' } } }) === true;
    out.semNomeMasPreenchidoConta = rascunhos.temConteudo(M, { dados: {
      paciente: { nome: '', peso: '70', idade: '31' }, procedimento: { descricao: 'Colecistectomia' } } }) === true;

    localStorage.removeItem(rascunhos.LAPIDES_KEY + M);
    rascunhos.setList(M, []); rascunhos.setAtivo(M, null);
    return out;
  });
  assert(r.sobrouUmaEmBranco, 'três abas em branco viram uma — as outras são sobra de sincronização');
  assert(r.oTrabalhoFicou, 'e a aba com paciente nunca é tocada');
  assert(r.sobrasComLapide, 'o que foi retirado fica registrado, para não voltar');
  assert(r.soSobeComConteudo, 'aba em branco não sobe para a nuvem');
  assert(r.retentouApagar, 'exclusão que falhou é tentada de novo na sincronização seguinte');
  assert(r.naoRessuscita, 'rascunho fechado aqui não pode voltar no próximo pull');
  assert(r.naoTrazVazioDeFora, 'nem aba em branco de outro aparelho vira aba aqui');
  assert(r.mantemOTrabalho, 'o rascunho com trabalho continua chegando normalmente');
  assert(r.numeraDireito, 'o número da aba nova não repete o de outra');
  assert(r.vazioEhVazio && r.comNomeConta && r.semNomeMasPreenchidoConta,
    'o corte do que é "vazio" precisa ser conservador — na dúvida, o rascunho fica');
  await page.close();
});

/* 128) Cortesia na conciliação: atendimento sem cobrança é desfecho, não
   etapa. Sem essa classe ele ficava para sempre "pendente" na conciliação,
   ou virava "concluído" sem dizer por quê. */
await test('Conciliação: cortesia é uma classificação, e nenhum cálculo a desfaz', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(async () => {
    const out = {};
    store.setList('financeiro', []);
    const it = store.save('financeiro', {
      paciente: 'Paciente Cortesia', data_proc: utils.hojeISO(),
      valor_previsto: 500, status: 'pendente'
    });
    out.temNaLista = !!financeiro.STATUS_LABELS.cortesia;

    financeiro.conciliar();
    await new Promise(r => setTimeout(r, 300));
    out.opcaoNoSelect = document.getElementById('conc-result').innerHTML.indexOf('value="cortesia"') >= 0;

    financeiro._concStatus(it._id, 'cortesia');
    const dep = store.getById('financeiro', it._id);
    out.gravou = dep.status === 'cortesia';
    /* o app sugere classe a partir dos valores — mas não desfaz a cortesia */
    out.sugestaoRespeita = financeiro._sugerirStatus(dep) === 'cortesia';
    out.chipAparece = document.getElementById('conc-chips').textContent.indexOf('Cortesia') >= 0;
    out.badge = financeiro._statusBadge('cortesia').indexOf('Cortesia') >= 0;
    try { modal.close(); } catch (e) {}

    /* o recálculo dos códigos também não pode desfazer a decisão */
    financeiro.editar(null);
    const form = document.getElementById('form-financeiro');
    form.querySelector('[name="status"]').value = 'cortesia';
    document.getElementById('fin-codigos-body').innerHTML = '';
    financeiro.codigos.add({ descricao: 'Proc', porte: '3A', valor_previsto: 100, status: 'aguardando' });
    financeiro.codigos.recalcular();
    out.recalculoRespeita = form.querySelector('[name="status"]').value === 'cortesia';

    /* linha de código também pode ser cortesia, e todas cortesia = registro cortesia */
    out.opcaoPorCodigo = financeiro.codigos.STATUS_OPCOES.indexOf('cortesia') >= 0;
    form.querySelector('[name="status"]').value = 'pendente';
    document.querySelector('#fin-codigos-body [name="fin_cod_status[]"]').value = 'cortesia';
    financeiro.codigos.recalcular();
    out.todasCortesia = form.querySelector('[name="status"]').value === 'cortesia';

    /* o fluxo de faturamento marca a cortesia com esse nome no financeiro */
    store.setList('financeiro', []);
    const reg = store.save('financeiro', { paciente: 'Fluxo Cortesia', valor_previsto: 300, status: 'pendente' });
    pendencias._aplicarCortesia('financeiro', reg);
    const dep2 = store.getById('financeiro', reg._id);
    out.fluxoMarca = dep2.status === 'cortesia' && dep2.pago === true && dep2.tipo_pagamento === 'Cortesia';

    store.setList('financeiro', []);
    return out;
  });
  assert(r.temNaLista, 'cortesia precisa existir entre as classificações');
  assert(r.opcaoNoSelect, 'e aparecer no seletor de cada linha da conciliação');
  assert(r.gravou, 'classificar como cortesia grava no registro');
  assert(r.sugestaoRespeita, 'a sugestão automática não pode desfazer a cortesia');
  assert(r.chipAparece, 'a classe aparece nos chips, para poder rastrear');
  assert(r.badge, 'e tem etiqueta própria na tabela');
  assert(r.recalculoRespeita, 'o recálculo dos códigos não desfaz a decisão de quem atendeu');
  assert(r.opcaoPorCodigo, 'um código específico também pode ser cortesia');
  assert(r.todasCortesia, 'todos os códigos em cortesia = registro em cortesia');
  assert(r.fluxoMarca, 'a cortesia do fluxo de faturamento chega ao financeiro com esse nome');
  await page.close();
});

/* 129) Equivalência de noradrenalina: comparar a intensidade do suporte
   vasopressor entre drogas. Os fatores são conferidos contra a própria fonte —
   cada dose equivalente publicada tem de devolver 0,1 mcg/kg/min. */
await test('Doses: equivalência de noradrenalina bate com a fonte e converte nos dois sentidos', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    ui.navegar('doses');
    doses.equiv.init();
    const eq = doses.equiv;

    /* conferência contra a tabela publicada (Crit Care 2023;27:2):
       na dose equivalente de cada droga, o resultado é a dose de referência */
    const publicadas = [
      ['Adrenalina', 0.1], ['Vasopressina', 0.04], ['Metaraminol', 0.8],
      ['Fenilefrina', 1.66], ['Dopamina', 10], ['Angiotensina II', 40]
    ];
    out.bateComAFonte = publicadas.every(([nome, dose]) =>
      Math.abs(eq.paraNora(nome, dose) - eq.REF) < 0.005);

    /* ida e volta: converter e desconverter devolve a mesma dose */
    out.idaEVolta = publicadas.every(([nome, dose]) =>
      Math.abs(eq.deNora(nome, eq.paraNora(nome, dose)) - dose) < 0.001);

    /* a unidade acompanha a droga — dose sem unidade é o começo de um erro */
    out.unidades = eq._dr('Vasopressina').unidade === 'U/min' &&
      eq._dr('Angiotensina II').unidade === 'ng/kg/min' &&
      eq._dr('Noradrenalina').unidade === 'mcg/kg/min';

    /* na tela: escolher a droga troca a unidade e calcula */
    document.getElementById('eq-droga').value = 'Metaraminol';
    document.getElementById('eq-dose').value = '0.8';
    document.getElementById('eq-peso').value = '70';
    eq.calcular();
    const txt = document.getElementById('eq-resultado').textContent;
    out.naTela = document.getElementById('eq-unidade').value === 'mcg/kg/min' &&
      /0,1 mcg\/kg\/min de noradrenalina/.test(txt) && /7 mcg\/min/.test(txt);
    out.tabelaComparativa = document.getElementById('eq-tabela').textContent.indexOf('Vasopressina') >= 0;

    /* sem dose, não inventa resultado */
    document.getElementById('eq-dose').value = '';
    eq.calcular();
    out.semDoseSemResultado = document.getElementById('eq-resultado').innerHTML === '';

    /* os vasopressores da tabela também entram no catálogo da ficha */
    const cat = anestesia.meds._catalogoPlano();
    out.noCatalogo = ['Vasopressina', 'Terlipressina', 'Dopamina', 'Noradrenalina', 'Metaraminol']
      .every(n => !!cat.find(m => m.nome === n));
    return out;
  });
  assert(r.bateComAFonte, 'cada dose equivalente publicada tem de devolver a dose de referência');
  assert(r.idaEVolta, 'converter e desconverter precisa devolver a mesma dose');
  assert(r.unidades, 'cada droga carrega a sua unidade — vasopressina em U/min, angiotensina em ng/kg/min');
  assert(r.naTela, 'a tela converte e mostra também o total em mcg/min para o peso');
  assert(r.tabelaComparativa, 'a tabela comparativa mostra a mesma equivalência nas outras drogas');
  assert(r.semDoseSemResultado, 'sem dose informada não se inventa resultado');
  assert(r.noCatalogo, 'os vasopressores da tabela precisam existir no catálogo da ficha');
  await page.close();
});

/* 130) Hidratação de manutenção pediátrica (Holliday-Segar): a conta que se
   fazia no papel, conferida contra o exemplo publicado, e disponível também
   dentro da hidratação da ficha, com o peso do próprio paciente. */
await test('Doses: manutenção pediátrica (Holliday) bate com o exemplo e entra na hidratação da ficha', async () => {
  const page = await novaPagina();
  const r = await page.evaluate(() => {
    const out = {};
    ui.navegar('doses');
    const ph = doses.pedHidra;

    /* faixas da regra, nos pontos de virada */
    out.faixas = ph.volumeDia(8) === 800 && ph.volumeDia(10) === 1000 &&
      ph.volumeDia(15) === 1250 && ph.volumeDia(20) === 1500 && ph.volumeDia(30) === 1700;
    out.semPesoSemConta = ph.volumeDia('') === null && ph.volumeDia(0) === null;

    /* exemplo publicado: 12 kg, TIG 5 */
    const r12 = ph.calcularDe(12, 5);
    out.exemplo = r12.volume === 1100 && r12.kcal === 11 && r12.na_meq === 33 &&
      Math.abs(r12.na_ml - 9.7) < 0.05 && r12.k_meq === 22 && Math.abs(r12.glicose_g - 86.4) < 0.05;
    out.mlh = Math.abs(r12.mlh - 45.83) < 0.02;
    /* a mistura para chegar à glicose dentro do volume do dia fecha a conta */
    const m = r12.mistura;
    out.mistura = !m.impossivel &&
      Math.abs((m.sg5 * 0.05 + m.sg50 * 0.5) - r12.glicose_g) < 0.01 &&
      Math.abs((m.sg5 + m.sg50) - r12.volume) < 0.01;
    /* TIG que pede menos glicose do que o próprio SG 5% do volume já traz
       (12 kg, TIG 2 → 34,6 g em 1100 mL = 3,1%) não vira mistura inventada */
    out.tigForaAvisa = ph.calcularDe(12, 2).mistura.impossivel === true;
    /* mas TIG alta que ainda cabe entre 5% e 50% continua sendo calculada */
    out.tigAltaCabe = ph.calcularDe(12, 20).mistura.impossivel !== true;

    /* número grande não pode encolher na formatação (1100 ≠ 11) */
    out.formata = ph._n(1100, 0) === '1100' && ph._n(45.83, 1) === '45,8' &&
      doses.equiv._fmt(100) === '100' && doses.equiv._fmt(10) === '10';

    document.getElementById('ph-peso').value = '12';
    document.getElementById('ph-tig').value = '5';
    ph.calcular();
    const tela = document.getElementById('ph-resultado').textContent;
    out.naTela = /1100 mL\/dia/.test(tela) && /33 mEq/.test(tela) && /9,7 mL de NaCl 20%/.test(tela);

    /* na ficha: usa o peso do paciente e lança a linha na hidratação */
    ui.navegar('anestesia');
    document.querySelector('#form-anestesia [name="paciente_peso"]').value = '12';
    document.getElementById('hidra-body').innerHTML = '';
    anestesia.hidra.abrirPediatrica();
    return new Promise(res => setTimeout(() => {
      out.modalCalculou = /1100 mL\/dia/.test(document.getElementById('phm-res').textContent);
      anestesia.hidra._lancarPed();
      const tr = document.querySelector('#hidra-body tr');
      out.lancou = !!tr &&
        /Holliday/.test(tr.querySelector('[name="hidra_tipo[]"]').value) &&
        Math.abs(parseFloat(tr.querySelector('[name="hidra_velocidade[]"]').value) - 45.8) < 0.1 &&
        tr.querySelector('[name="hidra_un_vel[]"]').value === 'mL/h' &&
        /Na 33 mEq/.test(tr.querySelector('[name="hidra_obs[]"]').value);
      document.getElementById('hidra-body').innerHTML = '';
      res(out);
    }, 250));
  });
  assert(r.faixas, 'as três faixas de Holliday-Segar precisam bater nos pontos de virada');
  assert(r.semPesoSemConta, 'sem peso não se calcula nada');
  assert(r.exemplo, 'o exemplo de 12 kg tem de dar 1100 mL, Na 33 mEq (9,7 mL), K 22 mEq e 86,4 g de glicose');
  assert(r.mlh, 'e a velocidade em mL/h sai do volume do dia');
  assert(r.mistura, 'a mistura de SG 5% e 50% tem de fechar volume e gramas');
  assert(r.tigForaAvisa, 'glicose fora da faixa de SG 5%–50% avisa, em vez de inventar mistura');
  assert(r.tigAltaCabe, 'e o que cabe entre 5% e 50% continua sendo calculado');
  assert(r.formata, 'número grande não pode encolher na formatação — 1100 não é 11');
  assert(r.naTela, 'a tela mostra volume, eletrólitos e o volume de cada sal');
  assert(r.modalCalculou, 'na ficha, a conta usa o peso do paciente');
  assert(r.lancou, 'e lança a linha na hidratação com velocidade, unidade e o resumo da conta');
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
