'use strict';

/* Apresentação da Agenda. Lê compromissos e delega ações explícitas ao
   módulo agenda; não salva, exclui, sincroniza ou inicia atendimentos. */
const agendaView = {
  /* ===== CALENDÁRIO MENSAL ===== */
  cal: {
    _ref: null,   /* Date do mês exibido */
    _diaAberto: null,

    _init() { if (!agenda.cal._ref) agenda.cal._ref = new Date(); },
    mes(delta) {
      agenda.cal._init();
      agenda.cal._ref.setMonth(agenda.cal._ref.getMonth() + delta);
      agenda.cal._diaAberto = null;
      agenda.cal.render();
    },
    hoje() {
      agenda.cal._ref = new Date();
      agenda.cal._diaAberto = utils.hojeISO();
      agenda.cal.render();
      agenda.cal.abrirDia(utils.hojeISO());
    },
    render() {
      agenda.cal._init();
      const ref = agenda.cal._ref;
      const ano = ref.getFullYear(), mes = ref.getMonth();
      const titulo = document.getElementById('ag-cal-titulo');
      if (titulo) titulo.textContent = ref.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
      const grid = document.getElementById('ag-cal-grid');
      if (!grid) return;

      /* agrupa compromissos por dia (YYYY-MM-DD) */
      const porDia = {};
      store.list('agenda').forEach(a => {
        if (!a.data) return;
        (porDia[a.data] = porDia[a.data] || []).push(a);
      });

      const primeiro = new Date(ano, mes, 1);
      const inicioSemana = primeiro.getDay();            /* 0=Dom */
      const diasNoMes = new Date(ano, mes + 1, 0).getDate();
      const hoje = utils.hojeISO();

      let cells = '';
      /* células vazias antes do dia 1 */
      for (let i = 0; i < inicioSemana; i++) cells += '<div class="ag-cal-cell empty"></div>';
      for (let d = 1; d <= diasNoMes; d++) {
        const iso = `${ano}-${String(mes + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const items = porDia[iso] || [];
        const isHoje = iso === hoje;
        const aberto = iso === agenda.cal._diaAberto;
        /* pontinhos por status */
        let dots = '';
        if (items.length) {
          const cores = { agendado: '#f0a500', confirmado: '#1c64a9', realizado: '#28a745', cancelado: '#c92a52' };
          const uniq = [...new Set(items.map(i => i.status || 'agendado'))].slice(0, 4);
          dots = '<div class="ag-cal-dots">' + uniq.map(s => `<span style="background:${cores[s] || '#888'}"></span>`).join('') + '</div>';
        }
        const badge = items.length ? `<span class="ag-cal-badge">${items.length}</span>` : '';
        cells += `<div class="ag-cal-cell${isHoje ? ' hoje' : ''}${aberto ? ' aberto' : ''}${items.length ? ' tem' : ''}" data-ag-day="${utils.escapeAttr(iso)}" onclick="agenda.cal.abrirDia(${utils.jsArg(iso)})">
          <span class="ag-cal-num">${d}</span>${badge}${dots}
        </div>`;
      }
      grid.innerHTML = cells;
      /* Reabre o dia se havia um aberto no mês exibido */
      if (agenda.cal._diaAberto && agenda.cal._diaAberto.startsWith(`${ano}-${String(mes + 1).padStart(2, '0')}`)) {
        agenda.cal.abrirDia(agenda.cal._diaAberto);
      } else {
        const box = document.getElementById('ag-cal-dia');
        if (box) box.style.display = 'none';
      }
    },
    abrirDia(iso) {
      agenda.cal._diaAberto = iso;
      document.querySelectorAll('.ag-cal-cell').forEach(c => {
        c.classList.toggle('aberto', c.getAttribute('data-ag-day') === iso);
      });
      const box = document.getElementById('ag-cal-dia');
      if (!box) return;
      const items = store.list('agenda').filter(a => a.data === iso)
        .sort((a, b) => (a.hora || '').localeCompare(b.hora || ''));
      const dataFmt = new Date(iso + 'T00:00:00').toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

      let lista;
      if (!items.length) {
        lista = '<div class="ag-dia-vazio">Nenhum compromisso neste dia.</div>';
      } else {
        lista = items.map(x => {
          const cores = { agendado: '#f0a500', confirmado: '#1c64a9', realizado: '#28a745', cancelado: '#c92a52' };
          return `<div class="ag-dia-item" style="border-left:3px solid ${cores[x.status] || '#888'}">
            <div class="ag-dia-item-top">
              <span class="ag-dia-hora">${utils.escapeHTML(x.hora || '--:--')}</span>
              <span class="ag-dia-pac">${utils.escapeHTML(x.paciente || '(sem nome)')}</span>
              <span class="status-pill ${x.status || ''}">${utils.escapeHTML(x.status || '—')}</span>
            </div>
            <div class="ag-dia-item-sub">${utils.escapeHTML([x.tipo, x.procedimento, x.cirurgiao, x.local].filter(Boolean).join(' · '))}</div>
            <div class="ag-dia-item-acoes">
              <button class="btn btn-xs btn-success" onclick="agenda.atender(${utils.jsArg(x._id)})">▶ Atender</button>
              <button class="btn btn-xs" onclick="agenda.editar(${utils.jsArg(x._id)})">Editar</button>
              <button class="btn btn-xs btn-danger" onclick="agenda.excluir(${utils.jsArg(x._id)}); agenda.cal.render();">Excluir</button>
            </div>
          </div>`;
        }).join('');
      }
      box.innerHTML = `
        <div class="ag-dia-header">
          <b>${dataFmt}</b>
          <button class="btn btn-primary btn-sm" onclick="agenda.editar(null, ${utils.jsArg(iso)})">+ Adicionar tarefa</button>
        </div>
        ${lista}`;
      box.style.display = 'block';
    }
  },

  /* Atualiza o card de contadores do dia (chamado sempre que render rola) */
  _atualizarContador() {
    const hoje = utils.hojeISO();
    const elData = document.getElementById('ag-contador-data');
    if (!elData) return;  /* card pode não existir em alguma renderização */
    const data = new Date(hoje + 'T00:00:00');
    elData.textContent = data.toLocaleDateString('pt-BR', {
      weekday: 'long', day: 'numeric', month: 'long'
    });
    const todos = store.list('agenda').filter(x => x.data === hoje);
    const contar = (st) => todos.filter(x => x.status === st).length;
    const pend = todos.filter(x => !x.status || x.status === 'agendado').length;
    const setN = (id, n) => { const e = document.getElementById(id); if (e) e.textContent = n; };
    setN('ag-c-total', todos.length);
    setN('ag-c-pend', pend);
    setN('ag-c-conf', contar('confirmado'));
    setN('ag-c-real', contar('realizado'));
    setN('ag-c-canc', contar('cancelado'));
  },

  /* Aplica filtro de hoje + status específico ao clicar em um card */
  _filtrarHoje(status) {
    const hoje = utils.hojeISO();
    const setV = (id, v) => { const e = document.getElementById(id); if (e) e.value = v; };
    setV('ag-f-de', hoje);
    setV('ag-f-ate', hoje);
    setV('ag-f-tipo', '');
    setV('ag-f-status', status);
    setV('ag-f-busca', '');
    agenda.render();
    /* Rola até a tabela */
    setTimeout(() => {
      const tbody = document.getElementById('agenda-tbody');
      if (tbody) tbody.closest('.card, table')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);
  },

  filtrar() {
    const list = store.list('agenda');
    const fDe = document.getElementById('ag-f-de').value;
    const fAte = document.getElementById('ag-f-ate').value;
    const fTipo = document.getElementById('ag-f-tipo').value;
    const fStatus = document.getElementById('ag-f-status').value;
    const fBusca = (document.getElementById('ag-f-busca').value || '').toLowerCase();
    return list.filter(x => {
      if (fDe && (!x.data || x.data < fDe)) return false;
      if (fAte && (!x.data || x.data > fAte)) return false;
      if (fTipo && x.tipo !== fTipo) return false;
      if (fStatus && x.status !== fStatus) return false;
      if (fBusca) {
        const blob = ((x.paciente || '') + ' ' + (x.cirurgiao || '') + ' ' + (x.procedimento || '')).toLowerCase();
        if (!blob.includes(fBusca)) return false;
      }
      return true;
    }).sort((a, b) => {
      /* ordena por data + hora ASC */
      const da = (a.data || '') + ' ' + (a.hora || '');
      const db = (b.data || '') + ' ' + (b.hora || '');
      return da.localeCompare(db);
    });
  },
  render() {
    /* Renderiza o calendário mensal */
    try { agenda.cal.render(); } catch (e) {}
    /* Atualiza os contadores do dia (sempre, mesmo se a lista estiver vazia) */
    agenda._atualizarContador();
    const list = agenda.filtrar();
    const tbody = document.getElementById('agenda-tbody');
    if (list.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="10">Nenhum compromisso encontrado</td></tr>';
      return;
    }
    tbody.innerHTML = list.map(x => {
      /* Mostra botão "Confirmar" apenas se status permite */
      const podeConfirmar = !x.status || x.status === 'agendado';
      const btnConfirmar = podeConfirmar
        ? `<button class="btn btn-xs btn-primary" onclick="agenda.confirmar(${utils.jsArg(x._id)})" title="Marcar como confirmado">✓ Confirmar</button>`
        : '';
      return `
      <tr>
        <td data-label="Data">${utils.formatarData(x.data)}</td>
        <td data-label="Hora">${utils.escapeHTML(x.hora || '')}</td>
        <td data-label="Tipo">${utils.escapeHTML(x.tipo || '')}</td>
        <td data-label="Paciente">${utils.escapeHTML(x.paciente || '')}</td>
        <td data-label="Procedimento">${utils.escapeHTML(x.procedimento || '')}</td>
        <td data-label="Profissional">${utils.escapeHTML(x.cirurgiao || '')}</td>
        <td data-label="Local">${utils.escapeHTML(x.local || '')}</td>
        <td data-label="Convênio">${utils.escapeHTML(x.convenio || '')}</td>
        <td data-label="Status"><span class="status-pill ${x.status || ''}">${utils.escapeHTML(x.status || '—')}</span></td>
        <td class="actions-cell">
          ${btnConfirmar}
          <button class="btn btn-xs btn-success" onclick="agenda.atender(${utils.jsArg(x._id)})" title="Iniciar atendimento (Consulta/Pré/Anestesia conforme o tipo)">▶ Atender</button>
          <button class="btn btn-xs" onclick="agenda.editar(${utils.jsArg(x._id)})">Editar</button>
          <button class="btn btn-xs btn-danger" onclick="agenda.excluir(${utils.jsArg(x._id)})">Excluir</button>
        </td>
      </tr>`;
    }).join('');
  },
  limparFiltros() {
    ['ag-f-de', 'ag-f-ate', 'ag-f-tipo', 'ag-f-status', 'ag-f-busca'].forEach(id => {
      document.getElementById(id).value = '';
    });
    agenda.render();
  },
};

/* FIM DA APRESENTAÇÃO DA AGENDA */
