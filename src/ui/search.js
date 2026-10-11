'use strict';

/* Busca e histórico da camada de apresentação. Mantém os contratos globais
   dos handlers existentes; persistência e identidade continuam delegadas. */
/* =============================================================================
   HISTÓRICO / BUSCA DEDICADA POR MÓDULO ===
   Abre um modal de busca rico com filtro, ordenação e ações por linha:
   visualizar (abrir no form), editar (igual a abrir), duplicar, imprimir, excluir. */
const historico = {
  LABELS: {
    pre: 'Pré-anestésica',
    consulta: 'Consulta / Dor',
    anestesia: 'Ficha de Anestesia',
    recuperacao: 'Recuperação SRPA',
    termo: 'Termo (TCLE)',
    prescricao: 'Receituário',
    risco: 'Risco perioperatório',
    financeiro: 'Financeiro'
  },

  abrir(mod) {
    if (!historico.LABELS[mod]) { toast('Módulo inválido', 'warn'); return; }
    const html = historico._render(mod, '');
    modal.open('🔍 Buscar — ' + historico.LABELS[mod], html, '');
    /* Liga eventos do campo de busca */
    setTimeout(() => {
      const input = document.getElementById('hist-search-input');
      if (input) {
        input.focus();
        input.addEventListener('input', () => {
          const tbody = document.getElementById('hist-tbody');
          if (tbody) tbody.innerHTML = historico._renderLinhas(mod, input.value);
        });
      }
    }, 80);
  },

  /* Estado de ordenação da tabela de histórico (data | paciente | senha) */
  _sort: { campo: 'data', dir: -1 },

  ordenar(mod, campo) {
    if (historico._sort.campo === campo) historico._sort.dir *= -1;
    else { historico._sort.campo = campo; historico._sort.dir = (campo === 'data' ? -1 : 1); }
    /* Re-renderiza cabeçalho e corpo preservando o filtro atual */
    const input = document.getElementById('hist-search-input');
    const host = document.getElementById('hist-table-host');
    if (host) host.innerHTML = historico._tabelaHTML(mod, input ? input.value : '');
  },

  _setaSort(campo) {
    if (historico._sort.campo !== campo) return '';
    return historico._sort.dir < 0 ? ' ▼' : ' ▲';
  },

  _render(mod, filtro) {
    const total = store.list(mod).length;
    const naNuvem = (() => { try { return (arquivo._indice()[mod] || []).length; } catch (e) { return 0; } })();
    return `
      <div style="margin-bottom:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input id="hist-search-input" type="text" class="hist-search" value="${utils.escapeAttr(filtro)}"
               placeholder="Buscar por paciente, senha, procedimento, cirurgião..."
               style="flex:1;min-width:200px;padding:8px 12px;border:1px solid var(--border);border-radius:6px;font-size:.9rem">
        <span style="font-size:.78rem;color:var(--text-mute);white-space:nowrap">${total} nesta sessão${naNuvem ? ' · <b>' + naNuvem + '</b> na nuvem' : ''}</span>
        <button class="btn btn-sm" title="Varre o banco da clínica e o backup da conta pelo nome do paciente — acha até o que foi feito em outro aparelho"
                onclick="arquivo.uiProcurarNaNuvem((document.getElementById('hist-search-input')||{}).value)">🔎 Procurar na nuvem</button>
      </div>
      <div id="hist-table-host" style="max-height:60vh;overflow:auto">${historico._tabelaHTML(mod, filtro)}</div>
    `;
  },

  _tabelaHTML(mod, filtro) {
    const th = (campo, rot, extra) => `<th style="cursor:pointer;user-select:none;${extra || ''}" onclick="historico.ordenar(${utils.jsArg(mod)},${utils.jsArg(campo)})" title="Ordenar por ${utils.escapeAttr(rot.toLowerCase())}">${utils.escapeHTML(rot)}${historico._setaSort(campo)}</th>`;
    return `
      <table class="dash-detail-table" style="margin-top:0">
        <thead><tr>
          ${th('data', 'Data', 'width:92px')}
          ${th('senha', 'Senha', 'width:96px')}
          ${th('paciente', 'Paciente')}
          <th>Tipo / procedimento</th>
          <th style="width:104px">Status</th>
          <th style="width:216px;text-align:center">Ações</th>
        </tr></thead>
        <tbody id="hist-tbody">${historico._renderLinhas(mod, filtro)}</tbody>
      </table>`;
  },

  _renderLinhas(mod, filtro) {
    const list = store.list(mod);
    const q = (filtro || '').toLowerCase().trim();
    const filtradas = (q
      ? list.filter(it => historico._textoLinha(mod, it).toLowerCase().includes(q))
      : list).slice();
    /* Ordenação clicável por data, paciente ou senha */
    const s = historico._sort;
    filtradas.sort((a, b) => {
      let va, vb;
      if (s.campo === 'paciente') { va = historico._nomeDe(mod, a).toLowerCase(); vb = historico._nomeDe(mod, b).toLowerCase(); }
      else if (s.campo === 'senha') { va = (historico._senhaDe(mod, a) || '').toLowerCase(); vb = (historico._senhaDe(mod, b) || '').toLowerCase(); }
      else { va = historico._dataItem(a) || (a._updatedAt || ''); vb = historico._dataItem(b) || (b._updatedAt || ''); }
      if (va < vb) return -1 * s.dir;
      if (va > vb) return 1 * s.dir;
      return 0;
    });
    if (filtradas.length === 0) {
      /* AQUI ESTAVA O BURACO. As linhas do que está guardado na nuvem são
         acrescentadas no fim desta função — e este `return` passava por cima
         delas. Resultado: quando a busca local não achava nada (justamente o
         caso de quem procura uma ficha antiga, que o socorro de espaço mandou
         para a nuvem), a tela dizia "nenhum registro" com a ficha inteira
         guardada e localizável. */
      const arq = historico._linhasArquivadas(mod, q);
      if (arq) return arq;
      return `<tr><td colspan="6" style="text-align:center;color:var(--text-mute);padding:20px">` +
        `Nenhum registro ${q ? 'corresponde ao filtro' : 'carregado'} nesta sessão.` +
        (q ? `<div style="margin-top:10px">` +
             `<button class="btn btn-sm btn-primary" onclick="arquivo.uiProcurarNaNuvem(${utils.jsArg(q)})">🔎 Procurar na nuvem inteira</button>` +
             `</div><div style="font-size:.78rem;margin-top:8px">A memória desta aba conhece somente o que já foi carregado. ` +
             `Fichas feitas em outro aparelho continuam na clínica e aparecem pela busca na nuvem.</div>`
           : '') +
        `</td></tr>`;
    }
    return filtradas.map(it => {
      const dt = historico._fmtData(historico._dataItem(it)) || (it._updatedAt ? new Date(it._updatedAt).toLocaleDateString('pt-BR') : '—');
      const nome = utils.escapeHTML(historico._nomeDe(mod, it));
      const senha = historico._senhaDe(mod, it);
      const senhaTd = senha ? utils.escapeHTML(senha) : '<span style="color:var(--text-mute)">—</span>';
      const det = utils.escapeHTML(historico._detalheDe(mod, it).slice(0, 70)) || '<span style="color:var(--text-mute)">—</span>';
      const st = historico._statusDe(mod, it);
      const stTd = st.rot ? `<span class="status-pill ${st.cls}" style="font-size:.68rem">${utils.escapeHTML(st.rot)}</span>` : '<span style="color:var(--text-mute)">—</span>';
      const nAnexos = historico._contaAnexos(it);
      const anexoBtn = nAnexos
        ? `<button class="btn btn-xs" onclick="historico.abrirItem(${utils.jsArg(mod)},${utils.jsArg(it._id)})" title="${nAnexos} anexo(s)">📎${nAnexos}</button>`
        : '';
      return `<tr>
        <td style="font-size:.82rem;color:var(--text-soft);white-space:nowrap">${dt}</td>
        <td style="font-size:.82rem;white-space:nowrap">${senhaTd}</td>
        <td><strong>${nome}</strong></td>
        <td style="font-size:.82rem;color:var(--text-soft)">${det}</td>
        <td>${stTd}</td>
        <td style="white-space:nowrap;text-align:right">
          <button class="btn btn-xs" onclick="historico.visualizarItem(${utils.jsArg(mod)},${utils.jsArg(it._id)})" title="Visualizar">👁</button>
          <button class="btn btn-xs btn-primary" onclick="historico.abrirItem(${utils.jsArg(mod)},${utils.jsArg(it._id)})" title="Editar">✏️</button>
          <button class="btn btn-xs" onclick="historico.imprimirItem(${utils.jsArg(mod)},${utils.jsArg(it._id)})" title="Imprimir">🖨️</button>
          <button class="btn btn-xs" onclick="historico.pdfItem(${utils.jsArg(mod)},${utils.jsArg(it._id)})" title="Exportar PDF">📄</button>
          ${anexoBtn}
          <button class="btn btn-xs btn-danger" onclick="historico.excluirItem(${utils.jsArg(mod)},${utils.jsArg(it._id)})" title="Apagar">🗑</button>
        </td>
      </tr>`;
    }).join('') + historico._linhasArquivadas(mod, q);
  },

  /* Registros que estão NA NUVEM e ainda não foram carregados nesta sessão.
     Sem isto eles sumiam da busca e pareciam apagados — foi exatamente o susto
     de uma ficha "desaparecida". Clicar traz de volta e abre. */
  _linhasArquivadas(mod, q) {
    let itens = [];
    try { itens = (arquivo._indice()[mod] || []); } catch (e) { return ''; }
    if (!itens.length) return '';
    const filtradas = q
      ? itens.filter(e => ((e.nome || '') + ' ' + (e.data || '')).toLowerCase().includes(q))
      : itens;
    if (!filtradas.length) return '';
    return filtradas
      .sort((a, b) => String(b.data || '').localeCompare(String(a.data || '')))
      .map(e => `<tr style="background:var(--surface-alt)">
        <td style="font-size:.82rem;color:var(--text-soft);white-space:nowrap">${utils.escapeHTML(historico._fmtData(e.data) || '—')}</td>
        <td style="font-size:.82rem;color:var(--text-mute)">—</td>
        <td><strong>${utils.escapeHTML(e.nome || '(sem nome)')}</strong></td>
        <td style="font-size:.82rem;color:var(--text-mute)">☁️ guardado na nuvem — ainda não carregado nesta sessão</td>
        <td><span class="status-pill" style="font-size:.68rem">na nuvem</span></td>
        <td style="white-space:nowrap;text-align:right">
          <button class="btn btn-xs btn-primary" onclick="modal.close(); dashboard._abrirRegistro(${utils.jsArg(mod)},${utils.jsArg(e.id)})" title="Buscar na nuvem e abrir">☁️ Abrir</button>
        </td>
      </tr>`).join('');
  },

  _senhaDe(mod, it) {
    if (mod === 'anestesia') return (it.paciente && it.paciente.senha) || it.paciente_senha || '';
    return it.senha || '';
  },

  _statusDe(mod, it) {
    if (mod === 'financeiro') {
      const s = it.status || '';
      return { rot: s || '', cls: s };
    }
    if (it._finalizado) return { rot: 'Finalizado', cls: 'pago' };
    return { rot: 'Rascunho', cls: 'pendente' };
  },

  _contaAnexos(it) {
    return (Array.isArray(it._docs) ? it._docs.length : 0) +
           (Array.isArray(it.anexos) ? it.anexos.length : 0) +
           (Array.isArray(it._docsOrigem) ? it._docsOrigem.length : 0);
  },

  _nomeDe(mod, it) {
    if (mod === 'anestesia') return (it.paciente && it.paciente.nome) || it.paciente_nome || '(sem nome)';
    if (mod === 'financeiro') return it.paciente || '(sem nome)';
    return it.nome || '(sem nome)';
  },

  _detalheDe(mod, it) {
    if (mod === 'anestesia') {
      const p = (it.procedimento && it.procedimento.descricao) || '';
      const c = (it.procedimento && it.procedimento.cirurgiao) || '';
      return [p, c].filter(Boolean).join(' · ');
    }
    if (mod === 'pre') return [it.cirurgia, it.cirurgiao].filter(Boolean).join(' · ');
    if (mod === 'consulta') return [it.queixa, it.profissional].filter(Boolean).join(' · ');
    if (mod === 'recuperacao') return [it.procedimento, it.tipo_anestesia].filter(Boolean).join(' · ');
    if (mod === 'financeiro') return [it.procedimento, it.convenio, it.status].filter(Boolean).join(' · ');
    if (mod === 'documentos') { const t = { atestado: 'Atestado', declaracao: 'Declaração', laudo: 'Laudo' }[it.modelo] || 'Documento'; return t; }
    return '';
  },

  _textoLinha(mod, it) {
    return [historico._nomeDe(mod, it), historico._detalheDe(mod, it), historico._senhaDe(mod, it)].join(' ');
  },

  /* ======================= PRONTUÁRIO 360° DO PACIENTE =======================
     Busca por nome e reúne TUDO: pré, consultas, fichas, SRPA, termos,
     prescrições, riscos, financeiro, agenda, orçamentos e anexos. */
  MODS_PRONT: {
    pre: 'Pré-anestésica', consulta: 'Consulta / Dor', anestesia: 'Ficha de Anestesia',
    recuperacao: 'SRPA', termo: 'Termo (TCLE)', prescricao: 'Receituário', documentos: 'Documentos',
    risco: 'Risco perioperatório', financeiro: 'Financeiro', agenda: 'Agenda', orcamento: 'Orçamento'
  },
  _nomeItem(it) { return ((it.paciente && it.paciente.nome) || it.paciente_nome || it.nome || it.paciente || '').trim(); },
  _dataItem(it) {
    /* A ficha de anestesia é salva ESTRUTURADA (procedimento.data). Sem esta
       linha, ela caía no _updatedAt e aparecia com a data da gravação — ou
       fora de ordem — no prontuário. */
    return (it.procedimento && typeof it.procedimento === 'object' && it.procedimento.data) ||
           it.data_proc || it.data_avaliacao || it.data_anestesia || it.data_consulta || it.data_cirurgia || it.data ||
           (it._updatedAt || it._createdAt || '').slice(0, 10) || '';
  },
  _fmtData(d) {
    if (!d) return '—';
    const m = String(d).match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? m[3] + '/' + m[2] + '/' + m[1] : d;
  },
  _fmtRS(v) { return 'R$ ' + (parseFloat(v) || 0).toFixed(2).replace('.', ','); },

  /* ---- COMO CADA STATUS FINANCEIRO SE LÊ --------------------------------
     O status é o que o anestesista marcou; o "em aberto" é conta, e é ela que
     diz se ainda falta receber: previsto − recebido − glosa. Os dois aparecem
     lado a lado de propósito — um "faturado" com tudo recebido não é
     pendência, e um "recebido" com valor a menos é. */
  FIN_STATUS: {
    pendente:   { rot: 'Pendente',   cor: '#b3261e' },
    faturado:   { rot: 'Faturado',   cor: '#8a6d00' },
    recebido:   { rot: 'Recebido',   cor: '#0f7b4f' },
    periciado:  { rot: 'Periciado',  cor: '#8a6d00' },
    glosado:    { rot: 'Glosado',    cor: '#b3261e' },
    parcial:    { rot: 'Parcial',    cor: '#8a6d00' },
    cortesia:   { rot: 'Cortesia',   cor: '#6b7280' },
    finalizado: { rot: 'Finalizado', cor: '#0f7b4f' }
  },
  _finChip(st) {
    const d = historico.FIN_STATUS[String(st || '').toLowerCase()];
    const rot = d ? d.rot : (st || '—');
    const cor = d ? d.cor : '#6b7280';
    return '<span style="font-size:.7rem;border:1px solid ' + cor + ';color:' + cor +
           ';border-radius:10px;padding:1px 7px;white-space:nowrap">' + utils.escapeHTML(rot) + '</span>';
  },
  _ehCortesia(it) { return String(it.status || '').toLowerCase() === 'cortesia'; },
  _emAberto(it) {
    if (historico._ehCortesia(it)) return 0;
    const v = (parseFloat(it.valor_previsto) || 0) - (parseFloat(it.valor_recebido) || 0) - (parseFloat(it.glosa) || 0);
    return v > 0.005 ? v : 0;
  },

  /* Ficha do cadastro: quem é o paciente e desde quando ele existe aqui.
     Estava em toda parte menos no lugar onde se olha a história dele. */
  _prontCadastro(nq, norm, contexto) {
    const lista = (store.list('pacientes') || []).filter(p => {
      if (contexto && contexto.identityKey) return linker._chavePaciente(p) === contexto.identityKey;
      if (contexto && contexto.patientRef) return p._id === contexto.patientRef || p._patientRef === contexto.patientRef;
      return norm(p.nome || '').includes(nq);
    });
    if (!lista.length) {
      return '<div style="font-size:.78rem;color:var(--text-mute);margin-top:6px">' +
        'Sem ficha no cadastro central — os registros abaixo existem, mas o paciente nunca foi cadastrado.</div>';
    }
    const p = lista[0];
    const e = utils.escapeHTML;
    const quando = (d) => { try { return d ? new Date(d).toLocaleString('pt-BR') : ''; } catch (x) { return ''; } };
    const par = (rot, val) => val ? '<span style="margin-right:14px"><small style="color:var(--text-mute)">' + rot + '</small> ' + e(val) + '</span>' : '';
    return '<div style="font-size:.78rem;margin-top:8px;line-height:1.9">' +
      par('CPF', p.cpf) + par('Nascimento', utils.formatarData(p.nascimento)) +
      par('Plano', p.plano) + par('Carteirinha', p.carteirinha) + par('Telefone', p.telefone) +
      par('Cadastrado em', quando(p._createdAt)) + par('Atualizado em', quando(p._updatedAt)) +
      (lista.length > 1 ? '<div style="color:#8a6d00;margin-top:2px">⚠️ ' + lista.length +
        ' cadastros com este nome — use "Juntar cadastros repetidos" em Pacientes.</div>' : '') +
      '</div>';
  },

  /* O financeiro por extenso: cada cobrança com o que foi previsto, o que
     entrou, o que foi glosado e o que ainda falta. O resumo de uma linha só
     não respondia "qual delas está em aberto". */
  _prontFinanceiro(eventos) {
    const fins = eventos.filter(ev => ev.mod === 'financeiro')
      .sort((a, b) => (b.data || '0').localeCompare(a.data || '0'));
    if (!fins.length) {
      return '<h3 style="font-size:.85rem;margin:14px 0 6px">💰 Financeiro</h3>' +
        '<p style="font-size:.8rem;color:var(--text-mute);margin:0">Nenhum lançamento financeiro para este paciente.</p>';
    }
    const e = utils.escapeHTML;
    let tPrev = 0, tRec = 0, tGlo = 0, tAberto = 0, nAberto = 0;
    const linhas = fins.map(ev => {
      const it = ev.it;
      const prev = parseFloat(it.valor_previsto) || 0;
      const rec = parseFloat(it.valor_recebido) || 0;
      const glo = parseFloat(it.glosa) || 0;
      const ab = historico._emAberto(it);
      tPrev += prev; tRec += rec; tGlo += glo;
      if (ab > 0) { tAberto += ab; nAberto++; }
      const pago = it.pago ? '✅' : (historico._ehCortesia(it) ? '—' : '⬜');
      return '<tr>' +
        '<td style="white-space:nowrap">' + historico._fmtData(ev.data) + '</td>' +
        '<td style="font-size:.8rem">' + e(it.procedimento || '—') +
          (it.convenio ? ' <small style="color:var(--text-mute)">· ' + e(it.convenio) + '</small>' : '') +
          /* como e onde o dinheiro entrou — é o que se procura num particular */
          ((it.forma_pagamento || it.conta_recebeu)
            ? '<br><small style="color:var(--text-mute)">💵 ' +
              [it.forma_pagamento, it.conta_recebeu].filter(Boolean).map(e).join(' · ') +
              (it.data_pagamento ? ' · ' + historico._fmtData(it.data_pagamento) : '') + '</small>'
            : '') + '</td>' +
        '<td style="text-align:right;white-space:nowrap">' + historico._fmtRS(prev) + '</td>' +
        '<td style="text-align:right;white-space:nowrap">' + historico._fmtRS(rec) + '</td>' +
        '<td style="text-align:right;white-space:nowrap">' + (glo ? historico._fmtRS(glo) : '—') + '</td>' +
        '<td style="text-align:right;white-space:nowrap;font-weight:' + (ab ? '700' : '400') +
          ';color:' + (ab ? '#b3261e' : 'inherit') + '">' + (ab ? historico._fmtRS(ab) : '—') + '</td>' +
        '<td style="text-align:center">' + historico._finChip(it.status) + '</td>' +
        '<td style="text-align:center" title="Marcado como pago">' + pago + '</td>' +
        '<td style="text-align:center"><button class="btn btn-xs btn-primary" onclick="historico.abrirItem(\'financeiro\',' + utils.jsArg(it._id) + ')">📂</button></td>' +
        '</tr>';
    }).join('');
    const aviso = nAberto
      ? '<div style="margin-top:6px;font-size:.8rem;color:#b3261e"><b>⚠️ ' + nAberto +
        ' cobrança(s) em aberto</b> — total de ' + historico._fmtRS(tAberto) + ' ainda por receber.</div>'
      : '<div style="margin-top:6px;font-size:.8rem;color:#0f7b4f">✅ Nada em aberto para este paciente.</div>';
    return '<h3 style="font-size:.85rem;margin:14px 0 6px">💰 Financeiro (' + fins.length + ')</h3>' +
      '<table class="dash-detail-table" style="margin-top:0">' +
      '<thead><tr><th style="width:86px">Data</th><th>Procedimento / convênio</th>' +
      '<th style="width:92px;text-align:right">Previsto</th><th style="width:92px;text-align:right">Recebido</th>' +
      '<th style="width:80px;text-align:right">Glosa</th><th style="width:92px;text-align:right">Em aberto</th>' +
      '<th style="width:90px;text-align:center">Status</th><th style="width:50px;text-align:center">Pago</th>' +
      '<th style="width:44px"></th></tr></thead><tbody>' + linhas + '</tbody>' +
      '<tfoot><tr style="font-weight:700;background:var(--surface-alt)">' +
      '<td colspan="2">Totais</td>' +
      '<td style="text-align:right">' + historico._fmtRS(tPrev) + '</td>' +
      '<td style="text-align:right">' + historico._fmtRS(tRec) + '</td>' +
      '<td style="text-align:right">' + historico._fmtRS(tGlo) + '</td>' +
      '<td style="text-align:right;color:' + (tAberto > 0.005 ? '#b3261e' : 'inherit') + '">' + historico._fmtRS(tAberto) + '</td>' +
      '<td colspan="3"></td></tr></tfoot></table>' + aviso;
  },
  _detalheItem(mod, it) {
    const e = utils.escapeHTML;
    if (mod === 'financeiro') {
      const st = it.status ? ' · ' + it.status : '';
      return e((it.procedimento || '')) + ' · previsto ' + historico._fmtRS(it.valor_previsto) +
             ' · recebido ' + historico._fmtRS(it.valor_recebido) + e(st);
    }
    if (mod === 'orcamento') {
      const procs = (it.procedimentos || []).map(p => p.descricao).filter(Boolean).join(' + ');
      return e(procs) + (it.total_paciente ? ' · ' + historico._fmtRS(it.total_paciente) : '');
    }
    if (mod === 'agenda') return e(it.titulo || it.procedimento || '') + (it.hora ? ' · ' + e(it.hora) : '');
    /* Ficha de anestesia: procedimento é um OBJETO — sem tratar, a linha do
       prontuário saía "[object Object]" e o caso parecia não existir. */
    if (it.procedimento && typeof it.procedimento === 'object') {
      const pr = it.procedimento;
      const partes = [pr.descricao || '', pr.cirurgiao ? 'Cir.: ' + pr.cirurgiao : ''].filter(Boolean);
      const extras = (pr.cirurgias_extra || []).map(c => c && c.procedimento).filter(Boolean);
      if (extras.length) partes.push('+ ' + extras.join(' + '));
      return e(partes.join(' · '));
    }
    return e(it.cirurgia || it.procedimento || it.queixa_principal || it.diagnostico || '');
  },

  _prontEscolhas(opcoes) {
    const e = utils.escapeHTML;
    return '<p style="font-size:.84rem;color:var(--text-soft);margin:0 0 8px">Há mais de um paciente compatível. Escolha a pessoa correta:</p>' +
      '<div class="record-list">' + opcoes.map(o => {
        const id = window.SoftEncounterIdentity.fromRecord(o.item || {});
        const detalhes = [];
        if (id.nasc) detalhes.push(id.nasc.split('-').reverse().join('/'));
        if (window.SoftEncounterIdentity.validCpf(id.cpf)) detalhes.push('CPF •••' + id.cpf.slice(-4));
        if (o.origem) detalhes.push(o.origem);
        return '<button type="button" class="record-item" style="width:100%;text-align:left" onclick="historico._prontEscolherContext(' +
          utils.jsArg(o.nome) + ',' + utils.jsArg(o.identityKey || '') + ',' + utils.jsArg(o.patientRef || '') + ')">' +
          '<div class="ri-name">' + e(o.nome) + '</div>' +
          '<div class="ri-meta">' + e(detalhes.join(' · ') || 'sem identificador complementar') + '</div></button>';
      }).join('') + '</div>';
  },

  _prontEscolherContext(nome, identityKey, patientRef) {
    historico._prontContext = { nome: nome || '', identityKey: identityKey || '', patientRef: patientRef || '' };
    const inp = document.getElementById('pront-input');
    if (inp) inp.value = nome || '';
    const box = document.getElementById('pront-result');
    if (box) box.innerHTML = historico._prontRender(nome || '');
  },

  prontuario(nomeInicial, patientRef, patientKey) {
    historico._prontContext = (patientRef || patientKey) ? {
      nome: nomeInicial || '', patientRef: patientRef || '', identityKey: patientKey || ''
    } : null;
    const html = `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px">
        <input id="pront-input" type="text" value="${utils.escapeAttr(nomeInicial || '')}"
               placeholder="Digite o nome do paciente…"
               style="flex:1;padding:9px 12px;border:1px solid var(--border);border-radius:6px;font-size:.92rem">
      </div>
      <div id="pront-result" style="max-height:64vh;overflow-y:auto"></div>`;
    modal.open('📚 Prontuário do paciente', html, '');
    setTimeout(() => {
      const inp = document.getElementById('pront-input');
      if (!inp) return;
      const roda = () => {
        if (historico._prontContext &&
            linker._normNome(inp.value) !== linker._normNome(historico._prontContext.nome)) {
          historico._prontContext = null;
        }
        const box = document.getElementById('pront-result');
        if (box) box.innerHTML = historico._prontRender(inp.value);
      };
      inp.addEventListener('input', roda);
      inp.focus();
      roda();
    }, 80);
  },

  _prontRender(q) {
    const norm = s => (linker._normNome ? linker._normNome(s || '') : (s || '').toLowerCase().trim());
    const nq = norm(q);
    if (nq.length < 2) return '<p style="color:var(--text-mute);font-size:.85rem">Digite ao menos 2 letras do nome do paciente.</p>';
    let contexto = historico._prontContext;
    const candidatos = new Map();
    const fracos = [];
    const registrar = (item, nome, origem, patientRef) => {
      const identityKey = linker._chavePaciente(item) || '';
      const ref = patientRef || item._patientRef || item._paciente_id || '';
      const token = identityKey ? 'forte:' + identityKey : (ref ? 'ref:' + ref : '');
      if (!token) { fracos.push({ item, nome, origem }); return; }
      const atual = candidatos.get(token);
      if (!atual || origem === 'cadastro') candidatos.set(token, {
        item, nome, origem, identityKey, patientRef: ref
      });
    };
    if (!contexto) {
      (store.list('pacientes') || []).forEach(p => {
        if (norm(p.nome || '').includes(nq)) registrar(p, p.nome || '', 'cadastro', p._id || p._patientRef || '');
      });
      Object.keys(historico.MODS_PRONT).forEach(mod => {
        (store.list(mod) || []).forEach(it => {
          const nome = historico._nomeItem(it);
          if (nome && norm(nome).includes(nq)) registrar(it, nome, historico.MODS_PRONT[mod]);
        });
      });
      const opcoes = Array.from(candidatos.values());
      if (opcoes.length > 1) return historico._prontEscolhas(opcoes);
      if (opcoes.length === 1) contexto = opcoes[0];
      else if (fracos.length > 1) {
        return '<div style="border:1px solid #d8a24a;border-radius:8px;padding:10px 12px;color:#7a4b12;font-size:.84rem">' +
          '<b>Não é seguro montar um prontuário único.</b><br>Existem vários registros antigos encontrados apenas pelo nome, sem CPF, nascimento ou vínculo de cadastro. Abra-os individualmente no Histórico e identifique o paciente antes de reuni-los.</div>';
      }
    }
    const eventos = [];
    const vistos = new Set();
    Object.keys(historico.MODS_PRONT).forEach(mod => {
      (store.list(mod) || []).forEach(it => {
        const nome = historico._nomeItem(it);
        let pertence = false;
        if (contexto && contexto.identityKey) pertence = linker._chavePaciente(it) === contexto.identityKey;
        if (!pertence && contexto && contexto.patientRef) {
          pertence = it._patientRef === contexto.patientRef || it._paciente_id === contexto.patientRef;
        }
        if (!contexto) pertence = fracos.length === 1 && it === fracos[0].item;
        if (!pertence) return;
        const chave = mod + ':' + (it._id || nome);
        if (vistos.has(chave)) return;
        vistos.add(chave);
        eventos.push({ mod, it, nome: nome || '', data: historico._dataItem(it) });
      });
    });
    if (!eventos.length) {
      /* Paciente recém-cadastrado ainda não tem documento nenhum. Dizer só
         "nenhum registro" faria parecer que ele não existe — e a pergunta
         "quando foi cadastrado" tem resposta mesmo assim. */
      const so = (store.list('pacientes') || []).filter(p => {
        if (contexto && contexto.identityKey) return linker._chavePaciente(p) === contexto.identityKey;
        if (contexto && contexto.patientRef) return p._id === contexto.patientRef || p._patientRef === contexto.patientRef;
        return norm(p.nome || '').includes(nq);
      });
      if (so.length) {
        return '<div style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;background:var(--surface-alt)">' +
          '<b style="font-size:.95rem">' + utils.escapeHTML(so[0].nome || '') + '</b>' +
          '<span style="font-size:.76rem;color:var(--text-mute)"> — cadastrado, ainda sem documentos</span>' +
          historico._prontCadastro(nq, norm, contexto) + '</div>';
      }
      return '<p style="color:var(--text-mute);font-size:.85rem">Nenhum registro encontrado para "' + utils.escapeHTML(q) + '".</p>';
    }
    /* Ordena por data desc (sem data vai pro fim) */
    eventos.sort((a, b) => (b.data || '0').localeCompare(a.data || '0'));
    /* Cabeçalho-resumo */
    /* achado só pelo id (nome gravado diferente): o título vem do cadastro */
    const nomeTitulo = eventos.map(ev => ev.nome).find(Boolean)
      || (contexto && contexto.nome)
      || q;
    const porMod = {};
    eventos.forEach(ev => { porMod[ev.mod] = (porMod[ev.mod] || 0) + 1; });
    let fin = { prev: 0, rec: 0 };
    eventos.filter(ev => ev.mod === 'financeiro').forEach(ev => {
      fin.prev += parseFloat(ev.it.valor_previsto) || 0;
      fin.rec += parseFloat(ev.it.valor_recebido) || 0;
    });
    const chips = Object.keys(porMod).map(m =>
      '<span style="display:inline-block;background:var(--surface-alt);border:1px solid var(--border);border-radius:12px;padding:2px 10px;font-size:.72rem;margin:2px">' +
      historico.MODS_PRONT[m] + ': <b>' + porMod[m] + '</b></span>').join('');
    const resumoFin = porMod.financeiro ?
      '<div style="font-size:.78rem;margin-top:6px">💰 Previsto: <b>' + historico._fmtRS(fin.prev) + '</b> · Recebido: <b>' + historico._fmtRS(fin.rec) + '</b> · Em aberto: <b style="color:' + (fin.prev - fin.rec > 0.005 ? 'var(--danger, #b3261e)' : 'inherit') + '">' + historico._fmtRS(fin.prev - fin.rec) + '</b></div>' : '';
    /* Ficha do cadastro e o financeiro por extenso — o resumo de uma linha só
       não dizia desde quando o paciente existe aqui nem QUAL cobrança está em
       aberto, que é o que se quer saber ao abrir a história dele. */
    const cadastroHtml = historico._prontCadastro(nq, norm, contexto);
    const financeiroHtml = historico._prontFinanceiro(eventos);
    /* Anexos de todos os registros */
    let anexosHtml = '';
    const anexos = [];
    eventos.forEach(ev => {
      (ev.it._docs || []).forEach((d, i) => anexos.push({ ev, d, i }));
    });
    if (anexos.length) {
      anexosHtml = '<h3 style="font-size:.85rem;margin:14px 0 6px">📎 Documentos e exames (' + anexos.length + ')</h3>' +
        anexos.map(a =>
          '<div style="display:flex;gap:8px;align-items:center;font-size:.8rem;padding:5px 8px;border:1px solid var(--border);border-radius:6px;margin-top:4px">' +
          '<span>' + (a.d.tipo === 'pdf' ? '📄' : '🖼️') + '</span>' +
          '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
          utils.escapeHTML((a.d.categoria || 'Documento') + ' — ' + a.d.nome) +
          ' <small style="color:var(--text-mute)">(' + historico.MODS_PRONT[a.ev.mod] + ' · ' + historico._fmtData(a.ev.data) + ')</small></span>' +
          '<button class="btn btn-xs" onclick="historico._prontVerDoc(' + utils.jsArg(a.ev.mod) + ',' + utils.jsArg(a.ev.it._id) + ',' + a.i + ')">👁 Ver</button>' +
          '</div>').join('');
    }
    /* Linha do tempo agrupada por ATENDIMENTO */
    const linhaDoTempo = historico._prontLinhaDoTempo(eventos);
    return `
      <div style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;background:var(--surface-alt)">
        <b style="font-size:.95rem">${utils.escapeHTML(nomeTitulo)}</b>
        <span style="font-size:.76rem;color:var(--text-mute)"> — ${eventos.length} registro(s)</span>
        <div style="margin-top:4px">${chips}</div>
        ${resumoFin}
        ${cadastroHtml}
      </div>
      ${financeiroHtml}
      ${anexosHtml}
      ${linhaDoTempo}`;
  },

  /* ---- LINHA DO TEMPO POR ATENDIMENTO ------------------------------------
     Uma linha por documento punha ficha, SRPA e financeiro do MESMO ato em
     linhas separadas e distantes, repetindo a data e a descrição em cada uma.
     Num dia com dois atos ficava impossível dizer qual SRPA era de qual ficha.

     O agrupamento não é por data: é pelo VÍNCULO que os registros já carregam
     (_links entre si, e _origemId do financeiro para o documento que o gerou).
     Data agrupa dois atos do mesmo dia num bloco só — vínculo separa cada um
     com o que é dele. Dia é só o cabeçalho. */
  MOD_ICONE: {
    pre: '🫀', consulta: '🩺', anestesia: '💉', recuperacao: '🛏', termo: '📄',
    prescricao: '💊', documentos: '📎', risco: '⚠️', financeiro: '💰',
    agenda: '📅', orcamento: '🧾'
  },
  /* Quem manda no título do bloco: a ficha descreve o ato melhor que o
     lançamento financeiro que saiu dela. */
  _PESO_ANCORA: { anestesia: 1, pre: 2, consulta: 3, recuperacao: 4, orcamento: 5,
                  termo: 6, risco: 7, prescricao: 8, documentos: 9, agenda: 10, financeiro: 11 },

  _prontAgrupar(eventos) {
    const chave = ev => ev.mod + ':' + (ev.it._id || '');
    const pai = {};
    eventos.forEach(ev => { pai[chave(ev)] = chave(ev); });
    const existe = new Set(Object.keys(pai));
    const raiz = k => { while (pai[k] && pai[k] !== k) k = pai[k]; return k; };
    const une = (a, b) => { const ra = raiz(a), rb = raiz(b); if (ra !== rb) pai[rb] = ra; };

    eventos.forEach(ev => {
      const k = chave(ev);
      const links = ev.it._links || {};
      Object.keys(links).forEach(campo => {
        const mod = campo.replace(/_id$/, '');
        const alvo = mod + ':' + links[campo];
        if (existe.has(alvo)) une(k, alvo);
      });
      /* o financeiro sabe de que documento nasceu, mesmo sem _links */
      if (ev.mod === 'financeiro' && ev.it._origemId && ev.it._origemTipo) {
        const alvo = ev.it._origemTipo + ':' + ev.it._origemId;
        if (existe.has(alvo)) une(k, alvo);
      }
    });

    const porRaiz = new Map();
    eventos.forEach(ev => {
      const r = raiz(chave(ev));
      if (!porRaiz.has(r)) porRaiz.set(r, []);
      porRaiz.get(r).push(ev);
    });
    return Array.from(porRaiz.values()).map(itens => {
      itens.sort((a, b) => (historico._PESO_ANCORA[a.mod] || 99) - (historico._PESO_ANCORA[b.mod] || 99));
      const ancora = itens[0];
      /* a data do bloco é a mais antiga: é quando o atendimento aconteceu, não
         quando o financeiro foi lançado depois */
      const datas = itens.map(x => x.data).filter(Boolean).sort();
      return { itens, ancora, data: datas[0] || ancora.data || '' };
    }).sort((a, b) => (b.data || '0').localeCompare(a.data || '0'));
  },

  _prontChip(ev) {
    const e = utils.escapeHTML;
    const rot = historico.MODS_PRONT[ev.mod] || ev.mod;
    const icone = historico.MOD_ICONE[ev.mod] || '📄';
    let extra = '', cor = 'var(--border)';
    if (ev.mod === 'financeiro') {
      const ab = historico._emAberto(ev.it);
      extra = ' · ' + historico._fmtRS(ev.it.valor_previsto);
      if (ab > 0.005) { extra += ' · em aberto'; cor = '#b3261e'; }
      else if (historico._ehCortesia(ev.it)) { extra += ' · cortesia'; }
      else { extra += ' · quitado'; cor = '#0f7b4f'; }
    } else if (ev.it._finalizado) {
      extra = ' ✓';
      cor = '#0f7b4f';
    } else {
      extra = ' · rascunho';
      cor = '#8a6d00';
    }
    const anexos = (ev.it._docs && ev.it._docs.length) ? ' 📎' + ev.it._docs.length : '';
    const det = historico._detalheItem(ev.mod, ev.it) || '';
    return '<button type="button" class="pront-chip" ' +
      'style="border-color:' + cor + '" ' +
      'title="' + utils.escapeAttr(rot + (det ? ' — ' + det.replace(/<[^>]*>/g, '') : '') + ' · toque para abrir e editar') + '" ' +
      'onclick="historico.abrirItem(' + utils.jsArg(ev.mod) + ',' + utils.jsArg(ev.it._id) + ')">' +
      icone + ' ' + e(rot) + '<small style="opacity:.8">' + e(extra) + e(anexos) + '</small></button>';
  },

  _prontLinhaDoTempo(eventos) {
    const grupos = historico._prontAgrupar(eventos);
    if (!grupos.length) return '';
    const e = utils.escapeHTML;
    let html = '<h3 style="font-size:.85rem;margin:14px 0 6px">🕐 Linha do tempo ' +
      '<small style="font-weight:400;color:var(--text-mute)">— por atendimento: ficha, SRPA e financeiro do mesmo ato ficam juntos. Toque no que quiser abrir.</small></h3>';
    let diaAtual = null;
    grupos.forEach(g => {
      const dia = g.data || '';
      if (dia !== diaAtual) {
        diaAtual = dia;
        html += '<div style="font-size:.78rem;font-weight:700;color:var(--primary-darker);' +
          'margin:12px 0 4px;border-bottom:1px solid var(--border);padding-bottom:3px">📅 ' +
          historico._fmtData(dia) + '</div>';
      }
      const titulo = historico._detalheItem(g.ancora.mod, g.ancora.it) || historico.MODS_PRONT[g.ancora.mod];
      html += '<div class="pront-bloco">' +
        '<div class="pront-bloco-tit">' + titulo + '</div>' +
        '<div class="pront-bloco-chips">' + g.itens.map(historico._prontChip).join('') + '</div>' +
        '</div>';
    });
    return html;
  },

  async _prontVerDoc(mod, id, i) {
    const it = store.getById(mod, id);
    const d = it && it._docs && it._docs[i];
    if (!d) { toast('Anexo não encontrado', 'warn'); return; }
    if (d.storage_path) {
      toast('☁️ Abrindo…');
      const url = await prontuario._signedUrl(d.storage_path);
      if (!url) { toast('Não consegui gerar o link — verifique login na nuvem', 'warn'); return; }
      if (d.tipo === 'imagem') {
        modal.open(utils.escapeHTML((d.categoria || '') + ' — ' + d.nome),
          '<div style="text-align:center"><img src="' + utils.escapeAttr(url) + '" style="max-width:100%;max-height:70vh;border-radius:6px"></div>',
          '<button class="btn" onclick="modal.close(); historico.prontuario()">← Voltar ao prontuário</button>');
      } else {
        const w = window.open(url, '_blank');
        if (!w) toast('Permita pop-ups para visualizar o PDF', 'warn');
      }
      return;
    }
    if (d.dataurl && d.tipo === 'imagem') {
      modal.open(utils.escapeHTML((d.categoria || '') + ' — ' + d.nome),
        '<div style="text-align:center"><img src="' + utils.escapeAttr(d.dataurl) + '" style="max-width:100%;max-height:70vh;border-radius:6px"></div>',
        '<button class="btn" onclick="modal.close(); historico.prontuario()">← Voltar ao prontuário</button>');
      return;
    }
    if (d.dataurl) {
      try {
        const url = URL.createObjectURL(prontuario._dataurlParaBlob(d.dataurl, 'application/pdf'));
        const w = window.open(url, '_blank');
        if (!w) toast('Permita pop-ups para visualizar o PDF', 'warn');
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      } catch (e) { toast('Erro ao abrir o PDF: ' + e.message, 'error'); }
    }
  },

  abrirItem(mod, id) {
    modal.close();
    setTimeout(() => {
      const item = store.getById(mod, id);
      if (!item) { toast('Registro não encontrado', 'warn'); return; }
      ui.navegar(mod);
      setTimeout(() => {
        if (mod === 'financeiro') {
          financeiro.editar(id);
        } else if (window[mod] && typeof window[mod].carregar === 'function') {
          window[mod].carregar(item);
        }
      }, 200);
    }, 100);
  },

  duplicarItem(mod, id) {
    const item = store.getById(mod, id);
    if (!item) return;
    /* Cria cópia sem _id, _updatedAt */
    const copia = JSON.parse(JSON.stringify(item));
    delete copia._id; delete copia._updatedAt; delete copia._createdAt;
    delete copia._versoes; delete copia._links;
    const saved = store.save(mod, copia);
    store.notificarNuvem(saved, 'Cópia do registro');
    /* Re-renderiza a lista */
    const tbody = document.getElementById('hist-tbody');
    const input = document.getElementById('hist-search-input');
    if (tbody) tbody.innerHTML = historico._renderLinhas(mod, input ? input.value : '');
  },

  /* Carrega o registro no módulo e executa uma ação (preview/impressão/PDF) */
  _carregarEEntao(mod, id, depois) {
    modal.close();
    setTimeout(() => {
      const item = store.getById(mod, id);
      if (!item) { toast('Registro não encontrado', 'warn'); return; }
      ui.navegar(mod);
      setTimeout(() => {
        if (mod === 'financeiro') {
          financeiro.editar(id);
        } else if (window[mod] && typeof window[mod].carregar === 'function') {
          window[mod].carregar(item);
        }
        if (typeof depois === 'function') setTimeout(depois, 300);
      }, 200);
    }, 100);
  },

  visualizarItem(mod, id) {
    if (mod === 'financeiro') { historico.abrirItem(mod, id); return; }
    historico._carregarEEntao(mod, id, () => { try { printPreview.abrir(); } catch (e) {} });
  },

  imprimirItem(mod, id) {
    if (mod === 'financeiro') { historico.abrirItem(mod, id); return; }
    historico._carregarEEntao(mod, id, () => { try { printPreview.abrir(); } catch (e) {} });
  },

  pdfItem(mod, id) {
    if (mod === 'financeiro') { historico.abrirItem(mod, id); return; }
    historico._carregarEEntao(mod, id, () => {
      try {
        printPreview.abrir();
        toast('Use 🖨️ Imprimir / PDF e escolha "Salvar em PDF"');
      } catch (e) {}
    });
  },

  excluirItem(mod, id) {
    const item = store.getById(mod, id);
    if (!item) return;
    const nome = historico._nomeDe(mod, item);
    if (!confirm(`Excluir registro de "${nome}"?\nEsta ação não pode ser desfeita.`)) return;
    if (store.delete(mod, id) === false) return;
    store.notificarNuvem(item, 'Exclusão do registro');
    /* Re-renderiza a lista */
    const tbody = document.getElementById('hist-tbody');
    const input = document.getElementById('hist-search-input');
    if (tbody) tbody.innerHTML = historico._renderLinhas(mod, input ? input.value : '');
    /* Atualiza dashboard se estiver visível */
    try { dashboard.atualizar(); } catch (e) {}
  }
};

const globalSearch = {
  query(q) {
    if (!q || q.length < 2) return [];
    q = q.toLowerCase();
    const out = [];
    const push = (mod, item, nome, extra) => {
      if (!nome) return;
      out.push({ mod, item, nome, extra });
    };
    store.list('anestesia').forEach(it => {
      const n = it.paciente && it.paciente.nome;
      const p = it.procedimento && it.procedimento.descricao;
      const c = it.procedimento && it.procedimento.cirurgiao;
      const blob = ((n || '') + ' ' + (p || '') + ' ' + (c || '')).toLowerCase();
      if (blob.includes(q)) push('anestesia', it, n, p);
    });
    store.list('pre').forEach(it => {
      const blob = ((it.nome || '') + ' ' + (it.cirurgia || '') + ' ' + (it.cirurgiao || '')).toLowerCase();
      if (blob.includes(q)) push('pre', it, it.nome, it.cirurgia);
    });
    store.list('consulta').forEach(it => {
      const blob = ((it.nome || '') + ' ' + (it.queixa || '') + ' ' + (it.profissional || '')).toLowerCase();
      if (blob.includes(q)) push('consulta', it, it.nome, it.queixa);
    });
    store.list('recuperacao').forEach(it => {
      const blob = ((it.nome || '') + ' ' + (it.procedimento || '')).toLowerCase();
      if (blob.includes(q)) push('recuperacao', it, it.nome, it.procedimento);
    });
    store.list('financeiro').forEach(it => {
      const blob = ((it.paciente || '') + ' ' + (it.procedimento || '') + ' ' + (it.cirurgiao || '')).toLowerCase();
      if (blob.includes(q)) push('financeiro', it, it.paciente, it.procedimento);
    });
    store.list('termo').forEach(it => {
      const blob = ((it.nome || '') + ' ' + (it.procedimento || '')).toLowerCase();
      if (blob.includes(q)) push('termo', it, it.nome, it.procedimento);
    });
    store.list('prescricao').forEach(it => {
      const meds = (it.itens || []).map(x => x.nome).join(' ');
      const blob = ((it.nome || '') + ' ' + meds).toLowerCase();
      if (blob.includes(q)) push('prescricao', it, it.nome, (it.itens || []).length + ' medicamento(s)');
    });
    store.list('risco').forEach(it => {
      const blob = ((it.nome || '') + ' ' + (it.procBusca || '')).toLowerCase();
      if (blob.includes(q)) push('risco', it, it.nome, (it._resumo ? 'Risco global ≈' + it._resumo.global.toFixed(1) + '%' : 'Cálculo de risco'));
    });
    return out.slice(0, 20);
  },
  render() {
    const q = document.getElementById('global-search-input').value;
    const results = globalSearch.query(q);
    const out = document.getElementById('global-search-results');
    if (!q || q.length < 2) { out.classList.remove('show'); return; }
    if (results.length === 0) {
      out.innerHTML = '<div class="gsr-empty">Nenhum resultado</div>';
    } else {
      const labels = { anestesia: 'Anestesia', pre: 'Pré', consulta: 'Consulta', recuperacao: 'SRPA', financeiro: 'Financeiro' };
      out.innerHTML = results.map(r => `
        <div class="gsr-item" onclick="ui.abrirVinculo(${utils.jsArg(r.mod)},${utils.jsArg(r.item._id)}); globalSearch.fechar();">
          <span class="gsr-source">${labels[r.mod]}</span>
          <strong>${utils.escapeHTML(r.nome)}</strong>
          <span class="gsr-meta">${utils.escapeHTML(r.extra || '')}</span>
        </div>
      `).join('');
    }
    out.classList.add('show');
  },
  fechar() {
    document.getElementById('global-search-results').classList.remove('show');
    document.getElementById('global-search-input').value = '';
  }
};

/* FIM DA BUSCA E DO HISTÓRICO DE APRESENTAÇÃO */
