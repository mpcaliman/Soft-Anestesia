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

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_URL = 'file://' + resolve(__dirname, '..', 'index.html');

/* Erros de rede são esperados offline (Supabase, Google Fonts) e não contam. */
const isNetworkNoise = (t) =>
  /ERR_CONNECTION|Failed to load resource|ERR_NAME_NOT_RESOLVED|net::|favicon/i.test(t || '');

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
