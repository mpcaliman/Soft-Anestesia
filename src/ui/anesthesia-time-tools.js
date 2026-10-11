'use strict';

/* ============================================================================
   CARIMBO DE HORA — botão flutuante (relógio) para anestesia/SRPA.
   Ao tocar, registra a HORA ATUAL como um evento na ficha (sem tipo definido),
   que o usuário detalha depois. O evento entra na tabela, no gráfico e no PDF
   exatamente como qualquer outro evento — reaproveita toda a infra existente.
============================================================================ */
const carimboHora = {
  /* Contador de carimbos pendentes (eventos sem tipo) para o badge */
  _pendentes: 0,

  /* Mostra/esconde o speed dial conforme o módulo ativo */
  atualizarVisibilidade() {
    const dial = document.getElementById('fab-dial');
    if (!dial) return;
    const mod = state.currentModule;
    const visivel = (mod === 'anestesia' || mod === 'recuperacao');
    dial.style.display = visivel ? 'flex' : 'none';
    if (!visivel) { try { fabDial.fechar(); } catch (e) {} }
    if (visivel) carimboHora.atualizarBadge();
    /* Cronômetros acompanham o mesmo escopo de módulo */
    try { cronometros.atualizarVisibilidade(); } catch (e) {}
  },

  /* Conta quantos eventos ainda não têm tipo (carimbos a detalhar) */
  atualizarBadge() {
    const ctx = (state.currentModule === 'recuperacao') ? 'recuperacao' : 'anestesia';
    const bodyId = ctx === 'recuperacao' ? 'srpa-eventos-body' : 'eventos-body';
    const tbody = document.getElementById(bodyId);
    let pend = 0;
    if (tbody) {
      tbody.querySelectorAll('tr').forEach(tr => {
        const hora = tr.querySelector('[name="evt_hora[]"]')?.value;
        const tipo = tr.querySelector('[name="evt_tipo[]"]')?.value;
        if (hora && !tipo) pend++;
      });
    }
    carimboHora._pendentes = pend;
    const badge = document.getElementById('fab-carimbo-badge');
    if (badge) {
      badge.textContent = pend;
      badge.style.display = pend > 0 ? 'flex' : 'none';
    }
  },

  /* Ação principal: carimba a hora atual criando um evento vazio para detalhar */
  carimbar() {
    const { hora, tr } = anesthesiaEventCommands.registrarCarimbo(state.currentModule);

    /* Feedback: pulso no botão do dial + toast + rola até o evento e foca o tipo */
    const fab = document.getElementById('fab-dial-main');
    if (fab) { fab.classList.remove('carimbou'); void fab.offsetWidth; fab.classList.add('carimbou'); }
    if (navigator.vibrate) { try { navigator.vibrate(25); } catch (e) {} }
    toast('🕐 Hora ' + hora + ' carimbada — toque no evento para escolher o tipo (intubação, incisão, etc.)');

    /* Destaca a linha criada e foca o seletor de tipo para detalhar já, se quiser */
    if (tr && tr.scrollIntoView) {
      try {
        tr.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const sel = tr.querySelector('[name="evt_tipo[]"]');
        if (sel) {
          tr.style.transition = 'background .3s';
          tr.style.background = '#fff6d5';
          setTimeout(() => { tr.style.background = ''; }, 1600);
        }
      } catch (e) {}
    }
    carimboHora.atualizarBadge();
  },

  /* Liga os handlers do FAB: toque curto = carimbar, toque longo = cronômetro.
     Idempotente — só liga uma vez. Não usa onclick para poder distinguir os gestos. */
  _fabLigado: false,
  initFab() {
    if (carimboHora._fabLigado) return;
    const fab = document.getElementById('fab-carimbo');
    if (!fab) return;
    let timer = null, longo = false, downT = 0;
    const LIMIAR = 550; /* ms para considerar toque longo */

    const iniciar = (ev) => {
      /* Não usa preventDefault aqui para permitir toques repetidos e rápidos */
      longo = false;
      downT = Date.now();
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        longo = true;
        /* Toque longo detectado: cria cronômetro */
        if (navigator.vibrate) { try { navigator.vibrate([20, 40, 20]); } catch (e) {} }
        cronometros.criar();
      }, LIMIAR);
    };
    const terminar = (ev) => {
      if (timer) { clearTimeout(timer); timer = null; }
      const dur = Date.now() - downT;
      /* Se não virou toque longo, é um toque curto → carimbar */
      if (!longo && dur < LIMIAR) {
        carimboHora.carimbar();
      }
      longo = false;
    };
    const cancelar = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      longo = false;
    };

    /* pointer events cobrem toque e mouse; cada gesto é independente do anterior */
    fab.addEventListener('pointerdown', iniciar);
    fab.addEventListener('pointerup', terminar);
    fab.addEventListener('pointercancel', cancelar);
    fab.addEventListener('pointerleave', cancelar);
    /* Evita menu de contexto no toque longo em alguns navegadores */
    fab.addEventListener('contextmenu', e => e.preventDefault());
    carimboHora._fabLigado = true;
  }
};

/* ============================================================================
   CRONÔMETROS FLUTUANTES — criados por toque longo no relógio.
   Vários independentes, empilhados. Cada um: correr/pausar, zerar, apagar,
   e nome editável. Rodam sem impedir novos toques no FAB.
   ============================================================================ */
/* ============================================================================
   ⚡ SPEED DIAL — botão flutuante único da ficha/SRPA. Concentra os atalhos
   que antes eram 6 botões soltos (vitais, dose rápida, catálogo, evento,
   tempos, cronômetro) + a calculadora de doses. Toque abre/fecha; qualquer
   ação fecha; toque fora fecha.
============================================================================ */
const fabDial = {
  ITENS: [
    { ico: '🩺', rot: 'Vitais', cor: '#0e9f6e', mods: ['anestesia', 'recuperacao'],
      acao: function () { if (state.currentModule === 'anestesia' && window.vitaisRapidos) vitaisRapidos.abrir(); else anestesia.vitais.registrarAgora(); } },
    { ico: '💉', rot: 'Dose rápida', cor: '#128a7d', mods: ['anestesia'], acao: function () { doseRapida.abrir(); } },
    { ico: '📋', rot: 'Catálogo de meds', cor: '#7c3aed', mods: ['anestesia'], acao: function () { anestesia.meds.abrirCatalogo(); } },
    { ico: '📍', rot: 'Catálogo de eventos', cor: '#b45309', mods: ['anestesia'], acao: function () { anestesia.eventos.abrirCatalogo(); } },
    { ico: '🕐', rot: 'Carimbar evento', cor: '#1c64a9', mods: ['anestesia', 'recuperacao'], acao: function () { carimboHora.carimbar(); } },
    { ico: '⏱️', rot: 'Tempos do caso', cor: '#d97706', mods: ['anestesia'], acao: function () { anestesia.tempos.abrir(); } },
    { ico: '⏲️', rot: 'Cronômetro', cor: '#64748b', mods: ['anestesia', 'recuperacao'], acao: function () { cronometros.criar(); } },
    { ico: '🧮', rot: 'Calculadora de doses', cor: '#0f2540', mods: ['anestesia', 'recuperacao'], acao: function () { ui.navegar('doses'); } }
  ],
  _aberto: false,
  alternar() { fabDial._aberto ? fabDial.fechar() : fabDial.abrir(); },
  abrir() {
    const host = document.getElementById('fab-dial-itens');
    const dial = document.getElementById('fab-dial');
    if (!host || !dial) return;
    const mod = state.currentModule;
    host.innerHTML = fabDial.ITENS
      .map((it, i) => ({ it, i }))
      .filter(x => x.it.mods.indexOf(mod) >= 0)
      .map(x => '<button type="button" class="fab-dial-item" onclick="fabDial.executar(' + x.i + ')">' +
        '<span class="fd-rot">' + x.it.rot + '</span>' +
        '<span class="fd-ico" style="background:' + x.it.cor + '">' + x.it.ico + '</span>' +
        '</button>').join('');
    dial.classList.add('aberto');
    fabDial._aberto = true;
    if (navigator.vibrate) { try { navigator.vibrate(15); } catch (e) {} }
  },
  fechar() {
    const dial = document.getElementById('fab-dial');
    if (dial) dial.classList.remove('aberto');
    fabDial._aberto = false;
  },
  executar(i) {
    fabDial.fechar();
    const it = fabDial.ITENS[i];
    if (!it) return;
    try { it.acao(); } catch (e) { toast('Não consegui abrir: ' + (e.message || e), 'warn'); }
  }
};
/* Toque fora do dial fecha */
document.addEventListener('click', function (e) {
  if (fabDial._aberto && !(e.target.closest && e.target.closest('#fab-dial'))) fabDial.fechar();
});

const cronometros = {
  _lista: [],        /* { id, nome, elapsedMs, running, startTs, el, elTempo } */
  _seq: 0,
  _tick: null,       /* intervalo único que atualiza todos os mostradores */

  /* Formata ms em HH:MM:SS (ou MM:SS se < 1h) */
  _fmt(ms) {
    const totalSeg = Math.floor(ms / 1000);
    const h = Math.floor(totalSeg / 3600);
    const m = Math.floor((totalSeg % 3600) / 60);
    const s = totalSeg % 60;
    const p2 = n => String(n).padStart(2, '0');
    return h > 0 ? `${p2(h)}:${p2(m)}:${p2(s)}` : `${p2(m)}:${p2(s)}`;
  },

  /* Tempo decorrido atual de um cronômetro (considera se está correndo) */
  _decorrido(c) {
    return c.elapsedMs + (c.running ? (Date.now() - c.startTs) : 0);
  },

  /* Garante que o loop de atualização esteja ativo se houver algum correndo */
  _garantirTick() {
    if (cronometros._tick) return;
    cronometros._tick = setInterval(() => {
      let algumRodando = false;
      cronometros._lista.forEach(c => {
        if (c.elTempo) c.elTempo.textContent = cronometros._fmt(cronometros._decorrido(c));
        if (c.running) algumRodando = true;
      });
      if (!algumRodando) { clearInterval(cronometros._tick); cronometros._tick = null; }
    }, 250);
  },

  /* Cria um novo cronômetro já correndo */
  criar() {
    const wrap = document.getElementById('cronometros-wrap');
    if (!wrap) return;
    wrap.style.display = 'flex';
    const id = 'crono-' + (++cronometros._seq);
    const nome = 'Cronômetro ' + cronometros._seq;
    const c = { id, nome, elapsedMs: 0, running: true, startTs: Date.now(), el: null, elTempo: null };

    const card = document.createElement('div');
    card.className = 'crono-card';
    card.id = id;
    card.innerHTML = `
      <div class="crono-top">
        <input class="crono-nome" type="text" value="${utils.escapeAttr(nome)}" maxlength="24" title="Toque para renomear">
        <button type="button" class="crono-fechar" title="Apagar cronômetro">✕</button>
      </div>
      <div class="crono-tempo">00:00</div>
      <div class="crono-btns">
        <button type="button" class="crono-btn crono-toggle crono-btn-pause">⏸ Pausar</button>
        <button type="button" class="crono-btn crono-zerar">↺ Zerar</button>
      </div>
    `;
    wrap.appendChild(card);
    c.el = card;
    c.elTempo = card.querySelector('.crono-tempo');

    /* Renomear */
    const inpNome = card.querySelector('.crono-nome');
    inpNome.addEventListener('change', () => { c.nome = inpNome.value || nome; });
    inpNome.addEventListener('click', e => e.stopPropagation());

    /* Pausar / continuar */
    const btnToggle = card.querySelector('.crono-toggle');
    btnToggle.addEventListener('click', () => cronometros.toggle(id));

    /* Zerar */
    card.querySelector('.crono-zerar').addEventListener('click', () => cronometros.zerar(id));

    /* Apagar */
    card.querySelector('.crono-fechar').addEventListener('click', () => cronometros.apagar(id));

    cronometros._lista.push(c);
    c.elTempo.textContent = '00:00';
    cronometros._garantirTick();
    toast('⏱ Cronômetro iniciado.');
    if (navigator.vibrate) { try { navigator.vibrate(15); } catch (e) {} }
    return c;
  },

  _acha(id) { return cronometros._lista.find(c => c.id === id); },

  /* Alterna entre correr e pausar */
  toggle(id) {
    const c = cronometros._acha(id);
    if (!c) return;
    const btn = c.el.querySelector('.crono-toggle');
    if (c.running) {
      /* pausa: acumula o tempo decorrido */
      c.elapsedMs = cronometros._decorrido(c);
      c.running = false;
      c.el.classList.add('pausado');
      if (btn) { btn.textContent = '▶ Continuar'; btn.classList.remove('crono-btn-pause'); btn.classList.add('crono-btn-play'); }
    } else {
      /* continua */
      c.startTs = Date.now();
      c.running = true;
      c.el.classList.remove('pausado');
      if (btn) { btn.textContent = '⏸ Pausar'; btn.classList.remove('crono-btn-play'); btn.classList.add('crono-btn-pause'); }
      cronometros._garantirTick();
    }
  },

  /* Zera o tempo (mantém correndo se estava correndo) */
  zerar(id) {
    const c = cronometros._acha(id);
    if (!c) return;
    c.elapsedMs = 0;
    c.startTs = Date.now();
    if (c.elTempo) c.elTempo.textContent = '00:00';
  },

  /* Remove o cronômetro */
  apagar(id) {
    const idx = cronometros._lista.findIndex(c => c.id === id);
    if (idx < 0) return;
    const c = cronometros._lista[idx];
    if (c.el && c.el.parentNode) c.el.parentNode.removeChild(c.el);
    cronometros._lista.splice(idx, 1);
    const wrap = document.getElementById('cronometros-wrap');
    if (wrap && cronometros._lista.length === 0) wrap.style.display = 'none';
  },

  /* Esconde/mostra o wrap conforme o módulo (junto do FAB) */
  atualizarVisibilidade() {
    const wrap = document.getElementById('cronometros-wrap');
    if (!wrap) return;
    const mod = state.currentModule;
    const visivel = (mod === 'anestesia' || mod === 'recuperacao') && cronometros._lista.length > 0;
    wrap.style.display = visivel ? 'flex' : 'none';
  }
};

/* FIM DAS FERRAMENTAS TEMPORAIS DE APRESENTAÇÃO */
