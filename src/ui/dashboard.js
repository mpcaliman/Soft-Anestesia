'use strict';

/* Painel analítico e operacional. Leituras e ações explícitas continuam
   delegadas aos contratos de persistência, nuvem e módulos clínicos. */
/* ============================================================================
   MÓDULO — DASHBOARD
============================================================================ */

const dashboard = {
  /* Os módulos de que o painel vive. Estava escrito à mão em outro lugar — e
     lá faltava `consulta`, que é um dos cartões daqui: as consultas nunca
     eram buscadas na clínica ao entrar, então só apareciam as do aparelho.
     Uma lista só, para as duas pontas não voltarem a divergir. */
  MODULOS_DADOS: ['pre', 'anestesia', 'recuperacao', 'consulta', 'financeiro'],

  /* Busca na clínica tudo o que o painel conta e repinta QUANDO CHEGAR.
     `forcar` limpa a marca de "já puxei nesta sessão" — é o que faz o botão
     Atualizar e a entrada no módulo trazerem coisa nova de verdade. */
  async puxarDaClinica(opts = {}) {
    try {
      if (typeof cloudRel === 'undefined' || !cloudRel.autoPullModulo) return false;
      if (!cloudRel.disponivel || !cloudRel.disponivel()) return false;
      if (dashboard._puxando) return false;
      if (opts.forcar) {
        try { dashboard.MODULOS_DADOS.forEach(m => { cloudRel._puxados[m] = false; }); } catch (e) {}
      }
      /* Nada por buscar: sai sem redesenhar. Redesenhar aqui faria toda
         entrada no painel desenhar duas vezes o mesmo quadro. */
      const precisam = dashboard.MODULOS_DADOS.filter(m => !cloudRel._puxados[m]);
      if (!precisam.length) return false;
      dashboard._puxando = true;
      dashboard._marcarBusca(true);
      try {
        await Promise.all(precisam.map(m => {
          try { return Promise.resolve(cloudRel.autoPullModulo(m)).catch(() => {}); }
          catch (e) { return Promise.resolve(); }
        }));
      } finally {
        dashboard._puxando = false;
        dashboard._ultimoPull = Date.now();
        dashboard._marcarBusca(false);
      }
      /* chegou: redesenha com o que veio, sem esperar relógio nenhum */
      try { if (state.currentModule === 'dashboard') dashboard.atualizar({ semPuxar: true }); } catch (e) {}
      return true;
    } catch (e) { dashboard._puxando = false; return false; }
  },
  _puxando: false,
  _marcarBusca(ligado) {
    const el = document.getElementById('dash-frescor');
    if (!el) return;
    if (ligado) { el.textContent = '⟳ buscando na clínica…'; el.title = ''; return; }
    dashboard._carimbarFrescor();
  },
  /* Diz de quando são os números que estão na tela. Sem isto não há como
     saber se o painel está velho — e um número velho parece um número certo. */
  _carimbarFrescor() {
    const el = document.getElementById('dash-frescor');
    if (!el) return;
    const t = dashboard._ultimaAtualizacao;
    if (!t) { el.textContent = ''; return; }
    const d = new Date(t);
    const hh = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    let fonte = 'só deste aparelho';
    try { if (cloudRel.disponivel && cloudRel.disponivel() && dashboard._ultimoPull) fonte = 'com a clínica'; } catch (e) {}
    el.textContent = 'atualizado ' + hh + ' · ' + fonte;
    el.title = 'Números e gráficos desenhados às ' + hh + '.';
  },
  _ultimaAtualizacao: 0,
  _ultimoPull: 0,

  /* ===== GRÁFICOS SVG (offline, sem libs) ===== */

  /* Paleta consistente */
  _paleta: ['#1c64a9', '#17a2b8', '#28a745', '#f0a500', '#e8590c', '#c92a52', '#6f42c1', '#5a6472', '#20a4b8', '#8bb63e'],

  /* Donut/rosca com legenda — data: {label: valor} */
  renderDonut(elId, data, opts = {}) {
    const el = document.getElementById(elId);
    if (!el) return;
    const entries = Object.entries(data).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((s, [, v]) => s + v, 0);
    if (!total) { el.innerHTML = '<div class="empty-state">Sem registros ainda — cadastre atendimentos para ver o gráfico</div>'; return; }

    const cat = opts.categoria || elId;   /* identificador p/ o clique */
    const R = 60, r = 38, cx = 70, cy = 70;
    let acc = 0;
    const segs = entries.map(([k, v], i) => {
      const frac = v / total;
      const a0 = acc * 2 * Math.PI - Math.PI / 2;
      acc += frac;
      const a1 = acc * 2 * Math.PI - Math.PI / 2;
      const large = frac > 0.5 ? 1 : 0;
      const x0 = cx + R * Math.cos(a0), y0 = cy + R * Math.sin(a0);
      const x1 = cx + R * Math.cos(a1), y1 = cy + R * Math.sin(a1);
      const xi1 = cx + r * Math.cos(a1), yi1 = cy + r * Math.sin(a1);
      const xi0 = cx + r * Math.cos(a0), yi0 = cy + r * Math.sin(a0);
      const cor = dashboard._paleta[i % dashboard._paleta.length];
      const path = (entries.length === 1)
        ? `M ${cx - R} ${cy} A ${R} ${R} 0 1 1 ${cx + R} ${cy} A ${R} ${R} 0 1 1 ${cx - R} ${cy} M ${cx - r} ${cy} A ${r} ${r} 0 1 0 ${cx + r} ${cy} A ${r} ${r} 0 1 0 ${cx - r} ${cy} Z`
        : `M ${x0} ${y0} A ${R} ${R} 0 ${large} 1 ${x1} ${y1} L ${xi1} ${yi1} A ${r} ${r} 0 ${large} 0 ${xi0} ${yi0} Z`;
      return { path, cor, k, v, pct: (frac * 100) };
    });

    const svg = `<svg viewBox="0 0 140 140" class="dash-donut-svg">
      ${segs.map(s => `<path d="${s.path}" fill="${s.cor}" fill-rule="evenodd" class="dash-clickable" onclick="event.stopPropagation(); dashboard.detalhar(${utils.jsArg(cat)}, ${utils.jsArg(s.k)})"><title>${utils.escapeHTML(s.k)}: ${s.v} (${s.pct.toFixed(1)}%) — toque para detalhes</title></path>`).join('')}
      <text x="70" y="66" text-anchor="middle" class="dash-donut-total">${total}</text>
      <text x="70" y="80" text-anchor="middle" class="dash-donut-cap">${opts.centerLabel || 'total'}</text>
    </svg>`;

    const legenda = `<div class="dash-legend">${segs.map(s => `
      <div class="dash-legend-item dash-clickable" onclick="event.stopPropagation(); dashboard.detalhar(${utils.jsArg(cat)}, ${utils.jsArg(s.k)})">
        <span class="dash-legend-dot" style="background:${s.cor}"></span>
        <span class="dash-legend-label">${utils.escapeHTML(s.k)}</span>
        <span class="dash-legend-val" title="${s.v} de ${total}">${s.v} · ${s.pct.toFixed(0)}%</span>
      </div>`).join('')}</div>`;

    el.innerHTML = `<div class="dash-donut-wrap">${svg}${legenda}</div>`;
  },

  /* Barras horizontais SVG coloridas — data: {label: valor} */
  renderBarsSVG(elId, data, opts = {}) {
    const el = document.getElementById(elId);
    if (!el) return;
    const todas = Object.entries(data).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    const entries = todas.slice(0, opts.limit || 8);
    if (!entries.length) { el.innerHTML = '<div class="empty-state">Sem registros ainda — cadastre atendimentos para ver o gráfico</div>'; return; }
    const cat = opts.categoria || elId;
    const max = entries[0][1];
    /* A porcentagem é do TOTAL do gráfico, não da maior barra. O comprimento
       da barra é que se mede pela maior — é o que faz a comparação visual
       funcionar; a porcentagem responde outra pergunta: "quanto do meu
       trabalho é isto". Usar a mesma base para as duas coisas faria a maior
       barra marcar sempre 100%. O gráfico mostra as primeiras, mas a conta
       leva TODAS: senão o que ficou de fora sumiria da porcentagem também. */
    const total = todas.reduce((acc, [, v]) => acc + v, 0);
    const rows = entries.map(([k, v], i) => {
      const larg = max ? (v / max) * 100 : 0;
      const pct = total ? (v / total) * 100 : 0;
      const cor = opts.corFixa || dashboard._paleta[i % dashboard._paleta.length];
      return `<div class="dash-bar-row dash-clickable" onclick="event.stopPropagation(); dashboard.detalhar(${utils.jsArg(cat)}, ${utils.jsArg(k)})" title="${v} de ${total} — toque para ver os registros">
        <div class="dash-bar-label">${utils.escapeHTML(k)}</div>
        <div class="dash-bar-track"><div class="dash-bar-fill" style="width:${larg}%;background:${cor}"></div></div>
        <div class="dash-bar-val">${v} · ${pct.toFixed(0)}%</div>
      </div>`;
    }).join('');
    el.innerHTML = `<div class="dash-bars">${rows}</div>`;
  },

  /* Abre modal com o histórico/detalhes dos registros de uma fatia/barra clicada */
  detalhar(categoria, valor) {
    const periodo = (document.getElementById('dash-periodo') || {}).value || 'all';
    const filt = list => dashboard.filtrarPorPeriodo(list, periodo, '_updatedAt');
    const anest = filt(store.list('anestesia'));
    let registros = [];   /* {mod, item, nome, extra} */
    let titulo = valor;

    const nomeDe = it => it.paciente_nome || it.nome || (it.paciente && it.paciente.nome) || it.paciente || '(sem nome)';

    if (categoria === 'dash-total-atend') {
      /* fatia por módulo */
      const mapMod = { 'Anestesia': 'anestesia', 'Pré-anestésica': 'pre', 'Consulta/Dor': 'consulta', 'Recuperação': 'recuperacao' };
      const mod = mapMod[valor];
      if (mod) {
        filt(store.list(mod)).forEach(it => registros.push({ mod, item: it, nome: nomeDe(it) }));
      }
      titulo = 'Atendimentos — ' + valor;
    } else if (categoria === 'dash-pagadora') {
      anest.forEach(a => {
        if (dashboard._catPagadora(a.paciente && a.paciente.convenio) === valor) {
          registros.push({ mod: 'anestesia', item: a, nome: nomeDe(a), extra: (a.paciente && a.paciente.convenio) || '' });
        }
      });
      titulo = 'Fonte pagadora — ' + valor;
    } else if (categoria === 'dash-cirurgioes') {
      anest.forEach(a => { if ((a.procedimento && a.procedimento.cirurgiao) === valor) registros.push({ mod: 'anestesia', item: a, nome: nomeDe(a), extra: (a.procedimento && a.procedimento.descricao) || '' }); });
      titulo = 'Cirurgião — ' + valor;
    } else if (categoria === 'dash-convenios') {
      anest.forEach(a => { if (((a.paciente && a.paciente.convenio) || 'Não informado') === valor) registros.push({ mod: 'anestesia', item: a, nome: nomeDe(a), extra: (a.procedimento && a.procedimento.descricao) || '' }); });
      titulo = 'Convênio — ' + valor;
    } else if (categoria === 'dash-hospitais') {
      anest.forEach(a => { if ((a.procedimento && a.procedimento.hospital) === valor) registros.push({ mod: 'anestesia', item: a, nome: nomeDe(a), extra: (a.procedimento && a.procedimento.descricao) || '' }); });
      titulo = 'Hospital — ' + valor;
    } else if (categoria === 'dash-procedimentos') {
      anest.forEach(a => { if ((a.procedimento && a.procedimento.descricao) === valor) registros.push({ mod: 'anestesia', item: a, nome: nomeDe(a), extra: (a.procedimento && a.procedimento.cirurgiao) || '' }); });
      titulo = 'Procedimento — ' + valor;
    } else if (categoria === 'dash-tipos') {
      anest.forEach(a => { const ts = (a.tecnica && a.tecnica.tipos) || []; if (ts.includes(valor)) registros.push({ mod: 'anestesia', item: a, nome: nomeDe(a), extra: (a.procedimento && a.procedimento.descricao) || '' }); });
      titulo = 'Tipo de anestesia — ' + valor;
    }

    /* ordena por data desc */
    registros.sort((a, b) => new Date(b.item._updatedAt || 0) - new Date(a.item._updatedAt || 0));

    const LABELS = { anestesia: 'Anestesia', pre: 'Pré', consulta: 'Consulta', recuperacao: 'SRPA' };
    let body;
    if (!registros.length) {
      body = '<div class="empty-state">Nenhum registro encontrado.</div>';
    } else {
      body = `<div class="dash-detalhe-count">${registros.length} registro(s)</div>
        <div class="dash-detalhe-lista">` + registros.map(r => {
        const dt = r.item._updatedAt ? utils.formatarDataHora(r.item._updatedAt) : '';
        return `<div class="dash-detalhe-item" onclick="modal.close(); dashboard._abrirRegistro(${utils.jsArg(r.mod)}, ${utils.jsArg(r.item._id)})">
          <div class="dash-detalhe-main">
            <span class="dash-search-mod">${LABELS[r.mod] || r.mod}</span>
            <span class="dash-detalhe-nome">${utils.escapeHTML(r.nome)}</span>
          </div>
          ${r.extra ? `<div class="dash-detalhe-extra">${utils.escapeHTML(r.extra)}</div>` : ''}
          <div class="dash-detalhe-dt">${dt}</div>
        </div>`;
      }).join('') + '</div>';
    }
    modal.open('📊 ' + utils.escapeHTML(titulo), body, `<button class="btn" onclick="modal.close()">Fechar</button>`);
  },

  /* Categoriza convênio em Particular / SUS / Convênio */
  _catPagadora(conv) {
    const c = (conv || '').toLowerCase().trim();
    if (!c) return 'Não informado';
    if (c.includes('particular')) return 'Particular';
    if (c === 'sus' || c.includes('sus')) return 'SUS';
    return 'Convênio/Plano';
  },

  /* Filtra por período em dias (a partir de hoje) */
  filtrarPorPeriodo(list, periodo, dateField) {
    if (periodo === 'all') return list;
    /* "Hoje" é o dia do calendário, não as últimas 24 h — uma ficha das 8 h da
       manhã não pode sair da conta às 9 h do dia seguinte. */
    if (periodo === 'hoje') {
      const hoje = utils.hojeISO();
      return list.filter(item => {
        const d = item[dateField] || item._updatedAt || item._createdAt || '';
        return String(d).slice(0, 10) === hoje;
      });
    }
    const dias = parseInt(periodo, 10);
    if (!dias) return list;
    const limite = Date.now() - dias * 86400000;
    return list.filter(item => {
      const d = item[dateField] || item._updatedAt || item._createdAt;
      if (!d) return false;
      const t = new Date(d.length === 10 ? d + 'T00:00:00' : d).getTime();
      return !isNaN(t) && t >= limite;
    });
  },

  atualizar(opts = {}) {
    /* Abrir o painel passa a BUSCAR na clínica, não só reler o aparelho.
       Antes, entrar no Dashboard redesenhava o que já estava aqui: quem
       trabalhou no outro computador não aparecia até alguém abrir o módulo
       daquele registro. `semPuxar` evita o laço quando é o próprio pull que
       está mandando redesenhar. */
    if (!opts.semPuxar) {
      try { dashboard.puxarDaClinica({ forcar: !!opts.forcar }); } catch (e) {}
    }
    dashboard._restaurarFiltros();
    const periodo = document.getElementById('dash-periodo').value;
    const anestesias  = dashboard.filtrarPorPeriodo(store.list('anestesia'),  periodo, 'procedimento') /* fallback p/ updatedAt */
                          .filter(_ => true); // simplificação: usa _updatedAt
    /* Usa _updatedAt como referência de período pq é confiável */
    /* A data que importa é a do PROCEDIMENTO, não a da última gravação.
       Filtrar por _updatedAt fazia o Dashboard contar quando o ARQUIVO foi
       salvo: bastava a nuvem regravar os registros para o dia de ontem
       "perder" as anestesias e hoje ganhar todas de uma vez. */
    const escopo = (document.getElementById('dash-escopo') || {}).value || 'pessoal';
    const filtPorMeta = list => dashboard.filtrarPorPeriodo(
      dashboard._filtrarEscopo(list, escopo)
        .map(it => Object.assign({}, it, { _dataClinica: dashboard._dataClinica(it) })),
      periodo, '_dataClinica');
    /* PRODUÇÃO = o que foi FINALIZADO. Rascunho e pré-lançamento são trabalho
       em curso: contá-los inflaria o painel com o que ainda pode mudar (e o
       pré-lançamento nem é seu até você conferir). É a mesma régua do
       financeiro, que só nasce na finalização. */
    const allAnest = dashboard._soProducao(filtPorMeta(store.list('anestesia')));
    const allPre = dashboard._soProducao(filtPorMeta(store.list('pre')));
    const allCons = dashboard._soProducao(filtPorMeta(store.list('consulta')));
    const allRecup = dashboard._soProducao(filtPorMeta(store.list('recuperacao')));
    const allFin = filtPorMeta(store.list('financeiro'));   /* financeiro não tem "finalizar" */

    /* O "Atualizar" do painel também vai buscar os pré-lançamentos na clínica:
       clicar em atualizar e a fila continuar vazia era o pior dos mundos. */
    try { preLanc.sincronizarFila({ silent: true }); } catch (e) {}
    /* KPIs */
    const nuvem = dashboard._naNuvem(periodo, escopo);
    dashboard._avisoNuvem(nuvem);
    const maisNuvem = (mod) => (nuvem.porMod[mod] || 0);

    /* Painel zerado: explica o zero e busca a produção na clínica antes de
       aceitá-lo. Um "0" mudo faz duvidar do sistema inteiro. O que está na
       nuvem entra nos totais — então, se há isso, o painel NÃO está vazio. */
    const totalProducao = allAnest.length + allPre.length + allCons.length + allRecup.length;
    try { dashboard._explicarVazio(periodo, escopo, totalProducao + (nuvem.total || 0)); } catch (e) {}
    try { dashboard._puxarSeVazio(totalProducao + allFin.length); } catch (e) {}
    const kpiGrid = document.getElementById('kpi-grid');
    const totFinPrev = allFin.reduce((s, x) => s + (parseFloat(x.valor_previsto) || 0), 0);
    const totFinRec  = allFin.reduce((s, x) => s + (parseFloat(x.valor_recebido) || 0), 0);
    const totFinGlo  = allFin.reduce((s, x) => s + (parseFloat(x.glosa) || 0), 0);
    const totFinPend = totFinPrev - totFinRec - totFinGlo;
    const finPendentes = allFin.filter(x => !x.pago && (x.status === 'pendente' || x.status === 'faturado' || !x.status)).length;
    kpiGrid.innerHTML = `
      <div class="kpi-card" data-detail="anestesia">
        <div class="kpi-label">Anestesias</div>
        <div class="kpi-value">${allAnest.length + maisNuvem('anestesia')}</div>
        <div class="kpi-sub">fichas finalizadas${maisNuvem('anestesia') ? ' · ' + maisNuvem('anestesia') + ' na nuvem' : ''}</div>
      </div>
      <div class="kpi-card accent" data-detail="pre">
        <div class="kpi-label">Pré-anestésica</div>
        <div class="kpi-value">${allPre.length + maisNuvem('pre')}</div>
        <div class="kpi-sub">avaliações finalizadas${maisNuvem('pre') ? ' · ' + maisNuvem('pre') + ' na nuvem' : ''}</div>
      </div>
      <div class="kpi-card" data-detail="consulta">
        <div class="kpi-label">Consultas / Dor</div>
        <div class="kpi-value">${allCons.length + maisNuvem('consulta')}</div>
        <div class="kpi-sub">atendimentos finalizados${maisNuvem('consulta') ? ' · ' + maisNuvem('consulta') + ' na nuvem' : ''}</div>
      </div>
      <div class="kpi-card accent" data-detail="recuperacao">
        <div class="kpi-label">Recuperação pós</div>
        <div class="kpi-value">${allRecup.length + maisNuvem('recuperacao')}</div>
        <div class="kpi-sub">fichas SRPA finalizadas${maisNuvem('recuperacao') ? ' · ' + maisNuvem('recuperacao') + ' na nuvem' : ''}</div>
      </div>
      <div class="kpi-card warn" data-detail="pacientes_unicos">
        <div class="kpi-label">Pacientes únicos</div>
        <div class="kpi-value">${dashboard.contarPacientesUnicos(allAnest, allPre, allCons, allRecup)}</div>
        <div class="kpi-sub">no período</div>
      </div>
      <div class="kpi-card warn" data-detail="fin_pendentes">
        <div class="kpi-label">Pendências financeiras</div>
        <div class="kpi-value">${finPendentes}</div>
        <div class="kpi-sub">a receber</div>
      </div>
      <div class="kpi-card accent" data-detail="fin_recebido">
        <div class="kpi-label">Total recebido</div>
        <div class="kpi-value" style="font-size:1.3rem">R$ ${utils.formatarBR(totFinRec)}</div>
        <div class="kpi-sub">no período</div>
      </div>
      <div class="kpi-card warn" data-detail="fin_a_receber">
        <div class="kpi-label">Total pendente</div>
        <div class="kpi-value" style="font-size:1.3rem">R$ ${utils.formatarBR(totFinPend > 0 ? totFinPend : 0)}</div>
        <div class="kpi-sub">a receber</div>
      </div>
      <div class="kpi-card danger" data-detail="fin_glosa">
        <div class="kpi-label">Total glosado</div>
        <div class="kpi-value" style="font-size:1.3rem">R$ ${utils.formatarBR(totFinGlo)}</div>
        <div class="kpi-sub">no período</div>
      </div>
    `;

    /* Total de atendimentos (donut por módulo) */
    dashboard.renderDonut('dash-total-atend', {
      'Anestesia': allAnest.length,
      'Pré-anestésica': allPre.length,
      'Consulta/Dor': allCons.length,
      'Recuperação': allRecup.length
    }, { centerLabel: 'atend.', categoria: 'dash-total-atend' });

    /* Fonte pagadora (Particular / SUS / Convênio) — donut */
    const pagadora = {};
    allAnest.forEach(a => {
      const cat = dashboard._catPagadora(a.paciente && a.paciente.convenio);
      pagadora[cat] = (pagadora[cat] || 0) + 1;
    });
    dashboard.renderDonut('dash-pagadora', pagadora, { centerLabel: 'pacientes', categoria: 'dash-pagadora' });

    /* Tipos de anestesia */
    const tipos = {};
    allAnest.forEach(a => {
      const ts = (a.tecnica && a.tecnica.tipos) || [];
      ts.forEach(t => { tipos[t] = (tipos[t] || 0) + 1; });
    });
    dashboard.renderBarsSVG('dash-tipos', tipos, { categoria: 'dash-tipos' });

    /* Cirurgiões */
    const cirurgioes = {};
    allAnest.forEach(a => {
      const c = a.procedimento && a.procedimento.cirurgiao;
      if (c) cirurgioes[c] = (cirurgioes[c] || 0) + 1;
    });
    dashboard.renderBarsSVG('dash-cirurgioes', cirurgioes, { categoria: 'dash-cirurgioes' });

    /* Hospitais */
    const hospitais = {};
    allAnest.forEach(a => {
      const h = a.procedimento && a.procedimento.hospital;
      if (h) hospitais[h] = (hospitais[h] || 0) + 1;
    });
    dashboard.renderBarsSVG('dash-hospitais', hospitais, { categoria: 'dash-hospitais' });

    /* Convênios detalhados (todos os nomes) — barras */
    const convenios = {};
    allAnest.forEach(a => {
      const c = (a.paciente && a.paciente.convenio) || 'Não informado';
      convenios[c] = (convenios[c] || 0) + 1;
    });
    dashboard.renderBarsSVG('dash-convenios', convenios, { categoria: 'dash-convenios' });

    /* Procedimentos */
    const procs = {};
    allAnest.forEach(a => {
      const p = a.procedimento && a.procedimento.descricao;
      if (p) procs[p] = (procs[p] || 0) + 1;
    });
    dashboard.renderBarsSVG('dash-procedimentos', procs, { categoria: 'dash-procedimentos' });

    /* Financeiro */
    dashboard.renderFinanceiroResumo(allFin);

    /* Busca — atualiza índice e re-renderiza resultados se houver termo */
    dashboard.buscar();

    /* Liga event delegation para abrir relatórios expandidos ao clicar */
    dashboard._ligarHandlers();

    /* "Meu dia" é parte do mesmo painel e vive dos mesmos registros. Ficava de
       fora daqui: quando as consultas chegavam da clínica, os cartões e os
       gráficos se atualizavam e o Meu dia seguia com o dia de antes, até
       alguém sair do módulo e voltar. */
    try { if (typeof meuDia !== 'undefined' && meuDia.render) meuDia.render(); } catch (e) {}

    dashboard._ultimaAtualizacao = Date.now();
    if (!dashboard._puxando) dashboard._carimbarFrescor();
  },

  /* Data clínica do registro (procedimento/avaliação); só cai na data de
     gravação quando o registro não tem data própria. */
  /* "Pessoal" = o que eu criei/assinei. "Clínica" = tudo o que está aqui,
     inclusive o que as auxiliares lançaram e o que outro anestesista fez. */
  /* Nome comparável: sem acento, sem título, sem espaço sobrando. "Dr. Marcelo
     Pandolfi Caliman" e "marcelo pandolfi caliman" são a mesma pessoa, e o
     painel não pode achar que não são. */
  _normAutor(v) {
    return String(v || '').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/^\s*(dr|dra|drª|prof|profa)\.?\s+/, '')
      .replace(/\s+/g, ' ').trim();
  },
  /* Tudo que identifica ESTA pessoa: a conta, o login do aparelho e o nome
     profissional configurado (o mesmo que sai no cabeçalho dos documentos). */
  _souEu() {
    const meus = new Set();
    const por = (v) => { const t = dashboard._normAutor(v); if (t) meus.add(t); };
    try {
      const u = auth.usuarioAtual() || {};
      [u.nome, u.usuario, u.id, u.uid].forEach(por);
      if (u.usuario && u.usuario.indexOf('@') > 0) por(u.usuario.split('@')[0]);
    } catch (e) {}
    try { por(localStorage.getItem('medsys.v7.usuario')); } catch (e) {}
    /* o nome que assina os documentos é o mesmo que vai no campo
       "anestesiologista" das fichas — é por ele que o caso é meu */
    try { por(((orcamento.cfg() || {}).cabecalho || {}).profissional); } catch (e) {}
    return meus;
  },
  _filtrarEscopo(list, escopo) {
    if (escopo !== 'pessoal') return list;
    const meus = dashboard._souEu();
    if (!meus.size) return list;
    const bate = (v) => dashboard._mesmaPessoa(v, meus);
    const sozinho = dashboard._souOUnicoAnestesista();
    return list.filter(it => {
      /* QUEM CONFERIU É O DONO DO CASO. No pré-lançamento a secretária digita
         e o médico confere e finaliza: se "meu" fosse só "quem digitou", o
         painel do médico ficaria permanentemente vazio num consultório onde a
         secretária prepara tudo — que é exatamente o que acontecia. */
      try {
        const pl = it._preLanc || {};
        if (pl.conferidoPor && bate(pl.conferidoPor)) return true;
      } catch (e) {}
      /* O PROFISSIONAL vem antes de quem digitou. Produção é de quem atendeu,
         não de quem salvou o arquivo por último. */
      const profissionais = [it.anestesista, it.anestesiologista, it.profissional, it.responsavel];
      if (profissionais.some(v => String(v || '').trim())) return profissionais.some(bate);

      /* Nenhum profissional registrado. Aqui estava o buraco: caía-se em
         `_updatedBy`, que é QUEM SALVOU POR ÚLTIMO — e num consultório onde a
         secretária prepara e corrige os registros, isso tira do painel do
         médico a produção que é dele. "Minha produção tem que ser igual à da
         clínica, pois só eu produzo nela."

         Quando o cadastro diz que há UM anestesista só, e sou eu, não há o que
         classificar: o caso é meu. Se um dia houver sócio no cadastro, a regra
         se desliga sozinha e volta a olhar a autoria. */
      if (sozinho) return true;
      const autores = [it._updatedBy, it._criadoPor];
      if (!autores.some(v => String(v || '').trim())) return true;
      return autores.some(bate);
    });
  },

  /* É a mesma pessoa? O nome de um médico raramente é escrito duas vezes do
     mesmo jeito: "Marcelo Pandolfi Caliman", "Marcelo Caliman", "Dr. Marcelo P.
     Caliman". A regra anterior era substring — e ela NÃO resolve justamente
     esse caso: nenhum dos dois contém o outro, porque o nome do meio quebra a
     sequência. Comparar por PARTES resolve: primeiro nome igual e sobrenome
     igual é a mesma pessoa; o meio pode faltar, abreviar ou sobrar. */
  _mesmaPessoa(v, meus) {
    const t = dashboard._normAutor(v);
    if (!t) return false;
    if (meus.has(t)) return true;
    const partes = s => String(s).split(/[\s.]+/).filter(x => x.length > 1);
    const a = partes(t);
    for (const m of meus) {
      if (m.length < 4) continue;
      if (t === m) return true;
      /* login/e-mail: comparação direta, sem partir em nomes */
      if (m.indexOf('@') >= 0 || t.indexOf('@') >= 0) { if (t === m) return true; continue; }
      const b = partes(m);
      if (a.length >= 2 && b.length >= 2 && a[0] === b[0] && a[a.length - 1] === b[b.length - 1]) return true;
      /* um lado só tem uma palavra (apelido, usuário): exige conter a outra */
      if ((a.length === 1 || b.length === 1) && m.length >= 6 && (t.includes(m) || m.includes(t))) return true;
    }
    return false;
  },

  /* O cadastro de profissionais tem um anestesista só, e ele sou eu? */
  _souOUnicoAnestesista() {
    try {
      const anest = (ajustes.list('cad_anestesistas') || []).filter(p => p && p.nome);
      if (anest.length !== 1) return false;
      if (dashboard._mesmaPessoa(anest[0].nome, dashboard._souEu())) return true;
      /* o próprio cadastro diz que este é o profissional responsável, e é o
         único: num aparelho configurado assim, ele é o dono do painel */
      return anest[0].responsavel === true || anest[0].responsavel === 'true';
    } catch (e) { return false; }
  },

  /* Registros que estão na NUVEM e ainda não foram carregados nesta sessão.
     O índice guarda id, nome e data — dá para CONTAR e respeitar o período,
     mas não dá para alimentar os gráficos (não traz cirurgião, hospital,
     convênio). Então: somo nos totais e digo, na cara, o que fica de fora. */
  _naNuvem(periodo, escopo) {
    const out = { porMod: {}, total: 0 };
    if (escopo === 'pessoal') { /* o índice não guarda autoria: só conta em Clínica */ }
    let ix = {};
    try { ix = arquivo._indice() || {}; } catch (e) { return out; }
    Object.keys(ix).forEach(mod => {
      const itens = (ix[mod] || [])
        /* produção é o que foi finalizado; entrada antiga (sem a marca) conta,
           porque esconder produção real seria pior do que somar um rascunho */
        .filter(e => e.fin !== false)
        .map(e => ({ _dataClinica: e.data ? e.data + 'T12:00:00.000Z' : '' }))
        .filter(e => e._dataClinica);
      const n = dashboard.filtrarPorPeriodo(itens, periodo, '_dataClinica').length;
      if (n) { out.porMod[mod] = n; out.total += n; }
    });
    return out;
  },
  /* Aviso honesto no topo do painel quando a conta não está completa */
  _avisoNuvem(nuvem) {
    const host = document.getElementById('dash-aviso-nuvem');
    if (!host) return;
    if (!nuvem || !nuvem.total) { host.style.display = 'none'; host.innerHTML = ''; return; }
    host.style.display = '';
    host.innerHTML =
      '<span>☁️ <b>' + nuvem.total + '</b> registro(s) deste período estão na nuvem e ainda não foram carregados nesta sessão. ' +
      'Eles <b>entram nos totais</b>, mas não nos gráficos por cirurgião, hospital e convênio.</span>' +
      /* Traz só os DESTE período. O botão antigo chamava restaurarTodos(): para
         corrigir o gráfico do mês baixava o histórico inteiro. */
      '<button type="button" class="btn btn-xs btn-primary" onclick="dashboard._completarGraficos()">⬇ Completar os gráficos deste período</button>';
  },
  /* O que falta aos gráficos é exatamente o que foi arquivado NESTE período.
     Traz só isso e redesenha. */
  async _completarGraficos() {
    const periodo = (document.getElementById('dash-periodo') || {}).value || '30';
    try { await arquivo.restaurarPeriodo(periodo); } catch (e) {}
    try { dashboard.atualizar({ semPuxar: true }); } catch (e) {}
  },

  /* Produção é o que ficou pronto. Rascunho e pré-lançamento ficam de fora do
     painel — eles têm o lugar deles (rascunhos, fila de conferência). */
  _soProducao(list) { return (list || []).filter(x => x && x._finalizado); },

  /* ZERO TEM QUE SE EXPLICAR. Um painel zerado pode ser dia parado, filtro
     errado (período/escopo) ou registro que ficou de fora por não estar
     finalizado. Mostrar só o "0" faz a pessoa duvidar do sistema inteiro —
     aconteceu. Aqui o painel conta onde a produção está e leva até ela. */
  _explicarVazio(periodo, escopo, totalProducao) {
    const host = document.getElementById('dash-vazio');
    if (!host) return;
    if (totalProducao > 0) { host.style.display = 'none'; host.innerHTML = ''; return; }
    const MODS = ['anestesia', 'pre', 'consulta', 'recuperacao'];
    const conta = (esc, per, exigirFinal) => {
      let n = 0;
      MODS.forEach(mod => {
        let l = dashboard._filtrarEscopo(store.list(mod) || [], esc)
          .map(it => Object.assign({}, it, { _dataClinica: dashboard._dataClinica(it) }));
        l = dashboard.filtrarPorPeriodo(l, per, '_dataClinica');
        if (exigirFinal) l = dashboard._soProducao(l);
        n += l.length;
      });
      return n;
    };
    const emAberto = conta(escopo, periodo, false);
    const naClinica = escopo === 'pessoal' ? conta('clinica', periodo, true) : 0;
    const emTudo = conta(escopo, 'all', true);
    const pedaco = [];
    if (emAberto) pedaco.push('<b>' + emAberto + '</b> registro(s) neste período ainda <b>não finalizado(s)</b> — produção conta só depois de finalizar');
    if (naClinica) pedaco.push('<b>' + naClinica + '</b> finalizado(s) no período são <b>de outra pessoa da clínica</b> ' +
      '<button type="button" class="btn btn-xs" onclick="dashboard._verComo(\'clinica\')">Ver clínica</button>');
    if (emTudo) pedaco.push('<b>' + emTudo + '</b> finalizado(s) seu(s) estão <b>fora deste período</b> ' +
      '<button type="button" class="btn btn-xs" onclick="dashboard._verComo(null, \'all\')">Ver tudo</button>');
    /* Se este aparelho nunca falou com a clínica, o painel zerado não é
       resultado — é falta de resposta. Dizer isso vale mais que qualquer
       contagem, porque muda o que a pessoa faz em seguida. */
    const naoCarregou = (() => {
      try { return cloudRel.porQueVazio('anestesia') || cloudRel.porQueVazio('financeiro'); }
      catch (e) { return ''; }
    })();
    /* O aviso SOMA, não substitui. "Há 3 em aberto" continua sendo verdade e
       continua sendo acionável mesmo que o módulo ainda não tenha carregado —
       trocar uma informação pela outra foi erro meu, e o teste pegou. */
    host.innerHTML = '📭 Nenhuma produção finalizada neste filtro.' +
      (pedaco.length ? '<br>' + pedaco.join('<br>')
                     : (naoCarregou ? '' : ' Não encontrei registros deste período nesta sessão — se você lançou em outro aparelho, o app está buscando na clínica.')) +
      (naoCarregou ? '<br><b style="color:var(--warning,#8a4b1c)">⚠️ ' + utils.escapeHTML(naoCarregou) + '</b>' : '');
    host.style.display = '';
  },
  /* O filtro escolhido é uma DECISÃO, e decisão não se desfaz sozinha.
     "Ver clínica" trocava o seletor e o próximo carregamento devolvia
     "Pessoal" — num consultório onde a secretária prepara tudo, isso é voltar
     ao painel zerado toda vez que se abre o app. */
  ESCOPO_KEY: 'medsys.v7.dash.escopo',
  PERIODO_KEY: 'medsys.v7.dash.periodo',
  _restaurados: false,
  _restaurarFiltros() {
    if (dashboard._restaurados) return;
    dashboard._restaurados = true;
    try {
      const e = document.getElementById('dash-escopo');
      const p = document.getElementById('dash-periodo');
      const ge = localStorage.getItem(dashboard.ESCOPO_KEY);
      const gp = localStorage.getItem(dashboard.PERIODO_KEY);
      if (e && ge && e.querySelector('option[value="' + ge + '"]')) e.value = ge;
      if (p && gp && p.querySelector('option[value="' + gp + '"]')) p.value = gp;
    } catch (er) {}
  },
  _guardarFiltros() {
    try {
      const e = document.getElementById('dash-escopo');
      const p = document.getElementById('dash-periodo');
      if (e) localStorage.setItem(dashboard.ESCOPO_KEY, e.value);
      if (p) localStorage.setItem(dashboard.PERIODO_KEY, p.value);
    } catch (er) {}
  },
  _verComo(escopo, periodo) {
    try {
      if (escopo) { const e = document.getElementById('dash-escopo'); if (e) e.value = escopo; }
      if (periodo) { const p = document.getElementById('dash-periodo'); if (p) p.value = periodo; }
      dashboard._guardarFiltros();
      dashboard.atualizar();
    } catch (e) {}
  },

  /* Painel zerado num aparelho que acabou de entrar quase nunca significa "não
     trabalhei": significa que os registros estão na clínica e ainda não aqui.
     Em vez de mostrar zero e deixar a pessoa procurando botão, vai buscar. */
  _puxouVazio: false,
  async _puxarSeVazio(total) {
    try {
      if (total > 0 || dashboard._puxouVazio) return;
      if (typeof cloudRel === 'undefined' || !cloudRel.disponivel()) return;
      if (!(await cloud._garantirToken())) return;
      dashboard._puxouVazio = true;
      let trouxe = 0;
      for (const mod of ['anestesia', 'pre', 'consulta', 'recuperacao', 'financeiro']) {
        const res = await cloudRel.puxarModuloIncremental(mod);
        if (!res) continue;
        trouxe += res.novos + res.atualizados;
      }
      if (trouxe) {
        toast('☁️ ' + trouxe + ' registro(s) carregados da clínica nesta sessão');
        dashboard.atualizar();
      }
    } catch (e) {}
  },

  /* A data pela qual a PRODUÇÃO é contada.
     É a da FINALIZAÇÃO — o dia em que o trabalho foi fechado —, não a da
     criação do rascunho nem a da última gravação. O carimbo é posto uma vez
     e não se move: correção feita depois não muda o mês que já foi contado.

     Registro antigo (anterior ao carimbo) e registro ainda em rascunho caem
     na data clínica de sempre, que é o melhor que se tem para eles. */
  _dataClinica(it) {
    if (it && it._finalizadoEm) return it._finalizadoEm;
    let d = '';
    try { d = historico._dataItem(it) || ''; } catch (e) {}
    if (d) return String(d).length === 10 ? d + 'T12:00:00.000Z' : d;
    return it._updatedAt || it._createdAt || '';
  },

  /* ===== BUSCA NO BANCO DE DADOS ===== */
  buscar() {
    const inp = document.getElementById('dash-search-input');
    const selMod = document.getElementById('dash-search-mod');
    const out = document.getElementById('dash-search-results');
    if (!out) return;
    const termo = (inp ? inp.value : '').toLowerCase().trim();
    const filtroMod = selMod ? selMod.value : 'all';

    if (!termo) {
      out.innerHTML = '<div class="dash-search-hint">Digite acima para pesquisar em todos os registros salvos.</div>';
      return;
    }

    const mods = filtroMod === 'all'
      ? ['anestesia', 'pre', 'consulta', 'recuperacao', 'termo', 'prescricao', 'risco', 'financeiro']
      : [filtroMod];
    const LABELS = { anestesia: 'Anestesia', pre: 'Pré', consulta: 'Consulta', recuperacao: 'SRPA', termo: 'Termo', prescricao: 'Receituário', risco: 'Risco', financeiro: 'Financeiro' };

    const resultados = [];
    mods.forEach(m => {
      store.list(m).forEach(it => {
        const nome = it.paciente_nome || it.nome || (it.paciente && it.paciente.nome) || it.paciente || '';
        const cir = (it.procedimento && it.procedimento.cirurgiao) || '';
        const proc = (it.procedimento && it.procedimento.descricao) || it.descricao || '';
        const conv = (it.paciente && it.paciente.convenio) || it.convenio || '';
        const blob = [nome, cir, proc, conv, it.hospital, (it.procedimento && it.procedimento.hospital)].join(' ').toLowerCase();
        if (blob.includes(termo)) {
          resultados.push({ mod: m, item: it, nome: nome || '(sem nome)', cir, proc, conv, data: it._updatedAt });
        }
      });
    });
    resultados.sort((a, b) => new Date(b.data || 0) - new Date(a.data || 0));

    if (!resultados.length) {
      out.innerHTML = `<div class="dash-search-hint">Nenhum registro encontrado para "${utils.escapeHTML(termo)}".</div>`;
      return;
    }

    const linhas = resultados.slice(0, 50).map(r => {
      const det = [r.cir && ('Cir: ' + r.cir), r.proc, r.conv].filter(Boolean).join(' · ');
      const dt = r.data ? utils.formatarDataHora(r.data) : '';
      return `<div class="dash-search-item" onclick="dashboard._abrirRegistro(${utils.jsArg(r.mod)}, ${utils.jsArg(r.item._id)})">
        <div class="dash-search-main">
          <span class="dash-search-mod">${LABELS[r.mod] || r.mod}</span>
          <span class="dash-search-nome">${utils.escapeHTML(r.nome)}</span>
        </div>
        <div class="dash-search-det">${utils.escapeHTML(det)}</div>
        <div class="dash-search-dt">${dt}</div>
      </div>`;
    }).join('');
    out.innerHTML = `<div class="dash-search-count">${resultados.length} registro(s) encontrado(s)${resultados.length > 50 ? ' — mostrando 50' : ''}</div>` + linhas;
  },

  async _abrirRegistro(mod, id) {
    /* No modo nuvem o registro pode não estar neste aparelho. Buscar é
       trabalho do app, não do usuário — ele só clicou num paciente. */
    let item = store.getById(mod, id);
    if (!item) {
      const t = toast('☁️ Buscando na nuvem…');
      const veio = await arquivo.restaurar(mod, id, { silent: true });
      if (veio) item = store.getById(mod, id);
    }
    if (!item) {
      toast('Não encontrei este registro — nem aqui, nem na nuvem. Confira a conexão.', 'error');
      return;
    }
    const handlers = { pre, consulta, anestesia, recuperacao, termo, prescricao, risco, financeiro };
    ui.navegar(mod);
    setTimeout(() => {
      try {
        if (handlers[mod] && handlers[mod].carregar) handlers[mod].carregar(item);
        else if (mod === 'financeiro' && financeiro.editar) financeiro.editar(id);
      } catch (e) { console.error(e); }
    }, 150);
  },


  _ligarHandlers() {
    const mod = document.getElementById('module-dashboard');
    if (!mod || mod.dataset.detailHandlerLigado) return;
    mod.addEventListener('click', (ev) => {
      const el = ev.target.closest('[data-detail]');
      if (!el) return;
      const tipo = el.dataset.detail;
      if (!tipo) return;
      dashboard.verDetalhes(tipo);
    });
    mod.dataset.detailHandlerLigado = '1';
  },

  /* Abre modal expandido com relatório detalhado para o item clicado */
  verDetalhes(tipo) {
    const periodo = document.getElementById('dash-periodo').value;
    /* A data que importa é a do PROCEDIMENTO, não a da última gravação.
       Filtrar por _updatedAt fazia o Dashboard contar quando o ARQUIVO foi
       salvo: bastava a nuvem regravar os registros para o dia de ontem
       "perder" as anestesias e hoje ganhar todas de uma vez. */
    const escopo = (document.getElementById('dash-escopo') || {}).value || 'pessoal';
    const filtPorMeta = list => dashboard.filtrarPorPeriodo(
      dashboard._filtrarEscopo(list, escopo)
        .map(it => Object.assign({}, it, { _dataClinica: dashboard._dataClinica(it) })),
      periodo, '_dataClinica');
    /* o detalhe segue a mesma régua do painel: só produção finalizada */
    const allAnest = dashboard._soProducao(filtPorMeta(store.list('anestesia')));
    const allPre   = dashboard._soProducao(filtPorMeta(store.list('pre')));
    const allCons  = dashboard._soProducao(filtPorMeta(store.list('consulta')));
    const allRecup = dashboard._soProducao(filtPorMeta(store.list('recuperacao')));
    const allFin   = filtPorMeta(store.list('financeiro'));

    const periodoLabel = { all: 'Todos os períodos', '7': 'Últimos 7 dias', '30': 'Últimos 30 dias', '90': 'Últimos 90 dias', '365': 'Último ano' }[periodo] || periodo;

    let titulo = '', html = '';

    /* Helpers de tabela */
    const tabelaFichas = (list, modKey, dataField, nomeField, extras = []) => {
      if (!list.length) return '<div class="empty-state">Nenhum registro encontrado neste período.</div>';
      const linhas = list
        .map(it => ({ it, ts: new Date(it._updatedAt || it._createdAt || 0).getTime() }))
        .sort((a, b) => b.ts - a.ts)
        .map(({ it }) => {
          const nome = (it.paciente && it.paciente.nome) || it.paciente_nome || it.nome || it.paciente || '—';
          const data = it[dataField] || (it.procedimento && it.procedimento.data) || it._updatedAt?.slice(0, 10) || '—';
          const procPaciente = (it.paciente && it.paciente.convenio) || it.convenio || '';
          const ex = extras.map(e => e(it)).join('');
          return `<tr class="dash-row-link" onclick="dashboard._abrirFicha(${utils.jsArg(modKey)},${utils.jsArg(it._id)})">
            <td>${utils.escapeHTML(data)}</td>
            <td>${utils.escapeHTML(nome)}</td>
            <td style="color:var(--text-soft)">${utils.escapeHTML(procPaciente)}</td>
            ${ex}
          </tr>`;
        }).join('');
      const cabExtras = extras.length ? extras.map(() => '<th></th>').join('') : '';
      return `
        <p style="font-size:.78rem;color:var(--text-mute);margin-bottom:8px">${list.length} registro(s). Clique em uma linha para abrir a ficha.</p>
        <table class="dash-detail-table">
          <thead><tr><th>Data</th><th>Paciente</th><th>Convênio</th>${cabExtras}</tr></thead>
          <tbody>${linhas}</tbody>
        </table>`;
    };

    const agrupar = (list, getter) => {
      const m = {};
      list.forEach(it => {
        const k = getter(it);
        if (k) m[k] = (m[k] || 0) + 1;
      });
      return Object.entries(m).sort((a, b) => b[1] - a[1]);
    };
    const tabelaAgrupada = (entries, labelCol = 'Item', total) => {
      if (!entries.length) return '<div class="empty-state">Sem dados no período.</div>';
      const tot = total || entries.reduce((s, [, v]) => s + v, 0);
      return `<table class="dash-detail-table">
        <thead><tr><th>${labelCol}</th><th class="dash-detail-num">Qtd</th><th class="dash-detail-num">%</th></tr></thead>
        <tbody>${entries.map(([k, v]) => `
          <tr><td>${utils.escapeHTML(k)}</td>
              <td class="dash-detail-num">${v}</td>
              <td class="dash-detail-num">${tot ? (100*v/tot).toFixed(1) : '0'}%</td></tr>
        `).join('')}</tbody>
        <tfoot><tr style="font-weight:600;background:var(--surface-alt)">
          <td>Total</td><td class="dash-detail-num">${tot}</td><td class="dash-detail-num">100%</td>
        </tr></tfoot>
      </table>`;
    };

    switch (tipo) {
      case 'anestesia':
        titulo = '💉 Anestesias — ' + periodoLabel;
        html = `<div class="dash-modal-summary">
          <div class="totalizador"><div class="lbl">Total</div><div class="val">${allAnest.length}</div></div>
          <div class="totalizador"><div class="lbl">Pacientes únicos</div><div class="val accent">${dashboard.contarPacientesUnicos(allAnest)}</div></div>
        </div>` + tabelaFichas(allAnest, 'anestesia', 'data_anestesia');
        break;
      case 'pre':
        titulo = '📋 Avaliações pré-anestésicas — ' + periodoLabel;
        html = `<div class="dash-modal-summary">
          <div class="totalizador"><div class="lbl">Total</div><div class="val">${allPre.length}</div></div>
        </div>` + tabelaFichas(allPre, 'pre', 'data');
        break;
      case 'consulta':
        titulo = '🩺 Consultas / Atendimentos de dor — ' + periodoLabel;
        html = `<div class="dash-modal-summary">
          <div class="totalizador"><div class="lbl">Total</div><div class="val">${allCons.length}</div></div>
        </div>` + tabelaFichas(allCons, 'consulta', 'data');
        break;
      case 'recuperacao':
        titulo = '🏥 Fichas de Recuperação Pós-anestésica — ' + periodoLabel;
        html = `<div class="dash-modal-summary">
          <div class="totalizador"><div class="lbl">Total</div><div class="val">${allRecup.length}</div></div>
        </div>` + tabelaFichas(allRecup, 'recuperacao', 'data');
        break;
      case 'pacientes_unicos': {
        titulo = '👤 Pacientes únicos — ' + periodoLabel;
        const mapa = {};
        const incluir = (it, campo) => {
          const n = ((it.paciente && it.paciente.nome) || it.paciente_nome || it.nome || it.paciente || '').trim();
          if (!n) return;
          const key = dashboard._tokenPaciente(it);
          if (!key) return;
          if (!mapa[key]) mapa[key] = { nome: n, total: 0, anest: 0, pre: 0, cons: 0, recup: 0 };
          mapa[key].total++;
          mapa[key][campo]++;
        };
        allAnest.forEach(it => incluir(it, 'anest'));
        allPre.forEach(it => incluir(it, 'pre'));
        allCons.forEach(it => incluir(it, 'cons'));
        allRecup.forEach(it => incluir(it, 'recup'));
        const lista = Object.values(mapa).sort((a, b) => b.total - a.total);
        html = `<div class="dash-modal-summary">
          <div class="totalizador"><div class="lbl">Pacientes únicos</div><div class="val accent">${lista.length}</div></div>
          <div class="totalizador"><div class="lbl">Total de fichas</div><div class="val">${allAnest.length + allPre.length + allCons.length + allRecup.length}</div></div>
        </div>
        <table class="dash-detail-table">
          <thead><tr><th>Paciente</th><th class="dash-detail-num">Anestesias</th><th class="dash-detail-num">Pré</th><th class="dash-detail-num">Consultas</th><th class="dash-detail-num">SRPA</th><th class="dash-detail-num">Total</th></tr></thead>
          <tbody>${lista.map(p => `<tr>
            <td>${utils.escapeHTML(p.nome)}</td>
            <td class="dash-detail-num">${p.anest}</td>
            <td class="dash-detail-num">${p.pre}</td>
            <td class="dash-detail-num">${p.cons}</td>
            <td class="dash-detail-num">${p.recup}</td>
            <td class="dash-detail-num" style="font-weight:600">${p.total}</td>
          </tr>`).join('')}</tbody>
        </table>`;
        break;
      }
      case 'fin_pendentes':
      case 'fin_recebido':
      case 'fin_a_receber':
      case 'fin_glosa':
      case 'financeiro': {
        const tit = {
          fin_pendentes: 'Pendências financeiras',
          fin_recebido: 'Recebimentos',
          fin_a_receber: 'A receber',
          fin_glosa: 'Glosas',
          financeiro: 'Resumo financeiro completo'
        }[tipo];
        titulo = '💰 ' + tit + ' — ' + periodoLabel;
        let list = allFin;
        if (tipo === 'fin_pendentes' || tipo === 'fin_a_receber') {
          list = allFin.filter(x => !x.pago && (x.status === 'pendente' || x.status === 'faturado' || !x.status));
        } else if (tipo === 'fin_recebido') {
          list = allFin.filter(x => (parseFloat(x.valor_recebido) || 0) > 0);
        } else if (tipo === 'fin_glosa') {
          list = allFin.filter(x => (parseFloat(x.glosa) || 0) > 0);
        }
        const sPrev = list.reduce((s, x) => s + (parseFloat(x.valor_previsto) || 0), 0);
        const sRec = list.reduce((s, x) => s + (parseFloat(x.valor_recebido) || 0), 0);
        const sGlo = list.reduce((s, x) => s + (parseFloat(x.glosa) || 0), 0);
        html = `<div class="dash-modal-summary">
          <div class="totalizador"><div class="lbl">Previsto</div><div class="val">R$ ${utils.formatarBR(sPrev)}</div></div>
          <div class="totalizador"><div class="lbl">Recebido</div><div class="val accent">R$ ${utils.formatarBR(sRec)}</div></div>
          <div class="totalizador"><div class="lbl">Glosa</div><div class="val danger">R$ ${utils.formatarBR(sGlo)}</div></div>
          <div class="totalizador"><div class="lbl">A receber</div><div class="val warn">R$ ${utils.formatarBR(sPrev - sRec - sGlo)}</div></div>
          <div class="totalizador"><div class="lbl">Itens</div><div class="val">${list.length}</div></div>
        </div>`;
        if (list.length === 0) {
          html += '<div class="empty-state">Nenhum registro neste filtro.</div>';
        } else {
          const linhas = list
            .map(it => ({ it, ts: new Date(it.data_competencia || it._updatedAt || 0).getTime() }))
            .sort((a, b) => b.ts - a.ts)
            .map(({ it }) => {
              const pago = it.pago ? '✓' : '';
              return `<tr class="dash-row-link" onclick="dashboard._abrirFicha('financeiro',${utils.jsArg(it._id)})">
                <td>${utils.escapeHTML(it.data_competencia || it._updatedAt?.slice(0, 10) || '')}</td>
                <td>${utils.escapeHTML(it.paciente || '—')}</td>
                <td>${utils.escapeHTML(it.procedimento || '')}</td>
                <td>${utils.escapeHTML(it.convenio || '')}</td>
                <td>${utils.escapeHTML(it.status || '')}</td>
                <td class="dash-detail-num">R$ ${utils.formatarBR(parseFloat(it.valor_previsto) || 0)}</td>
                <td class="dash-detail-num">R$ ${utils.formatarBR(parseFloat(it.valor_recebido) || 0)}</td>
                <td class="dash-detail-num">R$ ${utils.formatarBR(parseFloat(it.glosa) || 0)}</td>
                <td style="text-align:center">${pago}</td>
              </tr>`;
            }).join('');
          html += `
            <p style="font-size:.78rem;color:var(--text-mute);margin-bottom:8px">Clique em uma linha para abrir o registro financeiro.</p>
            <table class="dash-detail-table">
              <thead><tr><th>Data</th><th>Paciente</th><th>Procedimento</th><th>Convênio</th><th>Status</th><th class="dash-detail-num">Previsto</th><th class="dash-detail-num">Recebido</th><th class="dash-detail-num">Glosa</th><th>Pago</th></tr></thead>
              <tbody>${linhas}</tbody>
            </table>`;
        }
        break;
      }
      case 'tipos': {
        titulo = '📊 Tipos de anestesia — ' + periodoLabel;
        const map = {};
        allAnest.forEach(a => {
          const ts = (a.tecnica && a.tecnica.tipos) || [];
          ts.forEach(t => {
            if (!map[t]) map[t] = { count: 0, fichas: [] };
            map[t].count++; map[t].fichas.push(a);
          });
        });
        const entries = Object.entries(map).map(([k, v]) => [k, v.count]).sort((a, b) => b[1] - a[1]);
        html = `<div class="dash-modal-summary">
          <div class="totalizador"><div class="lbl">Total de fichas</div><div class="val">${allAnest.length}</div></div>
          <div class="totalizador"><div class="lbl">Tipos distintos</div><div class="val">${entries.length}</div></div>
        </div>` + tabelaAgrupada(entries, 'Tipo de anestesia');
        break;
      }
      case 'cirurgioes': {
        titulo = '👨‍⚕️ Cirurgiões — ' + periodoLabel;
        const entries = agrupar(allAnest, a => a.procedimento && a.procedimento.cirurgiao);
        html = `<div class="dash-modal-summary">
          <div class="totalizador"><div class="lbl">Cirurgiões distintos</div><div class="val">${entries.length}</div></div>
          <div class="totalizador"><div class="lbl">Total de procedimentos</div><div class="val">${entries.reduce((s, [, v]) => s + v, 0)}</div></div>
        </div>` + tabelaAgrupada(entries, 'Cirurgião');
        break;
      }
      case 'hospitais': {
        titulo = '🏥 Hospitais / clínicas — ' + periodoLabel;
        const entries = agrupar(allAnest, a => a.procedimento && a.procedimento.hospital);
        html = `<div class="dash-modal-summary">
          <div class="totalizador"><div class="lbl">Locais distintos</div><div class="val">${entries.length}</div></div>
          <div class="totalizador"><div class="lbl">Total de procedimentos</div><div class="val">${entries.reduce((s, [, v]) => s + v, 0)}</div></div>
        </div>` + tabelaAgrupada(entries, 'Hospital / clínica');
        break;
      }
      case 'convenios': {
        titulo = '💳 Convênios — ' + periodoLabel;
        const entries = agrupar(allAnest, a => (a.paciente && a.paciente.convenio) || 'Não informado');
        html = `<div class="dash-modal-summary">
          <div class="totalizador"><div class="lbl">Convênios distintos</div><div class="val">${entries.length}</div></div>
        </div>` + tabelaAgrupada(entries, 'Convênio');
        break;
      }
      case 'procedimentos': {
        titulo = '🩻 Procedimentos cirúrgicos — ' + periodoLabel;
        const entries = agrupar(allAnest, a => a.procedimento && a.procedimento.descricao);
        html = `<div class="dash-modal-summary">
          <div class="totalizador"><div class="lbl">Procedimentos distintos</div><div class="val">${entries.length}</div></div>
        </div>` + tabelaAgrupada(entries, 'Procedimento');
        break;
      }
      default:
        titulo = 'Detalhes';
        html = '<div class="empty-state">Tipo de detalhe não disponível.</div>';
    }

    modal.open(titulo, html, '');
  },

  _abrirFicha(mod, id) {
    modal.close();
    setTimeout(() => {
      try {
        ui.navegar(mod);
        setTimeout(() => {
          if (!window[mod]) return;
          /* Financeiro recebe ID; outros módulos recebem o ITEM completo */
          if (mod === 'financeiro') {
            if (typeof financeiro.editar === 'function') financeiro.editar(id);
          } else {
            const item = store.getById(mod, id);
            if (!item) { toast('Registro não encontrado', 'warn'); return; }
            if (typeof window[mod].carregar === 'function') {
              window[mod].carregar(item);
            }
          }
        }, 200);
      } catch (e) { console.error('Erro abrir ficha:', e); }
    }, 100);
  },

  _tokenPaciente(it) {
    if (!it) return '';
    const forte = linker._chavePaciente(it);
    const ref = it._patientRef || it._paciente_id;
    if (forte) return 'forte:' + forte;
    if (ref) return 'ref:' + ref;
    return it._id ? 'registro:' + it._id : '';
  },
  contarPacientesUnicos(...lists) {
    const set = new Set();
    lists.forEach(l => l.forEach(it => {
      const token = dashboard._tokenPaciente(it);
      if (token) set.add(token);
    }));
    return set.size;
  },

  renderBars(elId, obj, color = '') {
    const el = document.getElementById(elId);
    const entries = Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (entries.length === 0) {
      el.innerHTML = '<div class="empty-state">Sem dados no período</div>';
      return;
    }
    const max = entries[0][1];
    el.innerHTML = '<div class="bar-chart">' + entries.map(([k, v]) => {
      const pct = max ? (v / max) * 100 : 0;
      return `
        <div class="bar-row">
          <div class="bar-label" title="${utils.escapeAttr(k)}">${utils.escapeHTML(k)}</div>
          <div class="bar-track"><div class="bar-fill ${color}" style="width:${pct}%"></div></div>
          <div class="bar-value">${v}</div>
        </div>
      `;
    }).join('') + '</div>';
  },

  renderFinanceiroResumo(list) {
    const el = document.getElementById('dash-financeiro');
    if (list.length === 0) {
      el.innerHTML = '<div class="empty-state">Sem registros financeiros no período</div>';
      return;
    }
    const previsto = list.reduce((s, x) => s + (parseFloat(x.valor_previsto) || 0), 0);
    const recebido = list.reduce((s, x) => s + (parseFloat(x.valor_recebido) || 0), 0);
    const glosa    = list.reduce((s, x) => s + (parseFloat(x.glosa) || 0), 0);
    const dif = previsto - recebido;
    const porStatus = {};
    list.forEach(x => { const s = x.status || 'sem status'; porStatus[s] = (porStatus[s] || 0) + 1; });
    el.innerHTML = `
      <div class="totalizadores" style="margin-bottom:10px">
        <div class="totalizador"><div class="lbl">Previsto</div><div class="val">R$ ${utils.formatarBR(previsto)}</div></div>
        <div class="totalizador"><div class="lbl">Recebido</div><div class="val accent">R$ ${utils.formatarBR(recebido)}</div></div>
        <div class="totalizador"><div class="lbl">Glosa</div><div class="val danger">R$ ${utils.formatarBR(glosa)}</div></div>
        <div class="totalizador"><div class="lbl">A receber</div><div class="val warn">R$ ${utils.formatarBR(dif)}</div></div>
      </div>
      <div class="bar-chart">
        ${Object.entries(porStatus).map(([k, v]) => `
          <div class="bar-row">
            <div class="bar-label">${utils.escapeHTML(k)}</div>
            <div class="bar-track"><div class="bar-fill" style="width:${(v / list.length) * 100}%"></div></div>
            <div class="bar-value">${v}</div>
          </div>
        `).join('')}
      </div>
    `;
  }
};

/* FIM DO DASHBOARD DE APRESENTAÇÃO */
