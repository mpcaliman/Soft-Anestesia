'use strict';

/* Apresentação da lista de pacientes. Este componente lê o store e delega
   ações pelo ID; não salva, exclui ou sincroniza registros diretamente. */
const patientsView = {
  _wireActions(tbody) {
    if (!tbody || tbody.dataset.pacActionsWired === '1') return;
    tbody.dataset.pacActionsWired = '1';
    tbody.addEventListener('click', event => {
      const alvo = event.target && event.target.closest
        ? event.target.closest('[data-pac-action][data-pac-id]')
        : null;
      if (!alvo || !tbody.contains(alvo)) return;
      const id = alvo.dataset.pacId || '';
      const p = store.getById('pacientes', id);
      if (!p) { toast('Paciente não encontrado', 'warn'); return; }
      switch (alvo.dataset.pacAction) {
        case 'editar': pacientes.editar(id); break;
        case 'corrigir-nome': pacientes.corrigirNome(id); break;
        case 'historico': historico.prontuario(p.nome || '', p._id || p._patientRef || '', linker._chavePaciente(p) || ''); break;
        case 'resumo': pacientes.resumo(p.nome || '', p._id || p._patientRef || '', linker._chavePaciente(p) || ''); break;
        case 'acoes': quickActions.abrir(id); break;
        case 'excluir': pacientes.excluir(id); break;
      }
    });
  },

  /* Preenche o filtro de planos com os que EXISTEM no cadastro — oferecer um
     plano que ninguém tem é oferecer uma lista vazia. */
  _planosNoCadastro() {
    const set = new Set();
    pacientes.list().forEach(p => { const v = String(p.plano || '').trim(); if (v) set.add(v); });
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'pt-BR'));
  },
  _encherPlanos() {
    const sel = document.getElementById('pac-f-plano');
    if (!sel) return;
    const atual = sel.value;
    const planos = pacientes._planosNoCadastro();
    sel.innerHTML = '<option value="">Todos os planos</option>' +
      planos.map(v => '<option value="' + utils.escapeAttr(v) + '">' + utils.escapeHTML(v) + '</option>').join('');
    if (atual && planos.indexOf(atual) >= 0) sel.value = atual;
  },
  /* Clique no cabeçalho: mesma coluna de novo inverte, quando faz sentido. */
  /* A seta no cabeçalho diz por onde a lista está ordenada. Sem ela, clicar
     numa coluna e ver a lista mudar não explica o que aconteceu. */
  _marcarSetaOrdem() {
    const sel = document.getElementById('pac-f-ordem');
    const atual = sel ? sel.value : 'nome';
    const seta = { nome: '▲', nome_desc: '▼', nasc_novo: '▼', nasc_velho: '▲', plano: '▲' };
    document.querySelectorAll('#pacientes-table th[data-ord]').forEach(th => {
      const chave = th.getAttribute('data-ord');
      const casa = (chave === atual) ||
        (chave === 'nome' && atual === 'nome_desc') ||
        (chave === 'nasc_novo' && atual === 'nasc_velho');
      const antiga = th.querySelector('.ord-seta');
      if (antiga) antiga.remove();
      if (!casa) return;
      const el = document.createElement('span');
      el.className = 'ord-seta';
      el.textContent = seta[atual] || '▲';
      th.appendChild(el);
    });
  },
  ordenarPor(chave) {
    const sel = document.getElementById('pac-f-ordem');
    if (!sel) return;
    const par = { nome: 'nome_desc', nome_desc: 'nome', nasc_novo: 'nasc_velho', nasc_velho: 'nasc_novo' };
    sel.value = (sel.value === chave && par[chave]) ? par[chave] : chave;
    pacientes.render();
  },
  limparFiltros() {
    const b = document.getElementById('pac-f-busca'); if (b) b.value = '';
    const p = document.getElementById('pac-f-plano'); if (p) p.value = '';
    const o = document.getElementById('pac-f-ordem'); if (o) o.value = 'nome';
    pacientes.render();
  },
  filtrar() {
    const q = (document.getElementById('pac-f-busca')?.value || '').toLowerCase().trim();
    const plano = (document.getElementById('pac-f-plano')?.value || '').trim();
    const ordem = (document.getElementById('pac-f-ordem')?.value || 'nome');
    let list = pacientes.list();
    if (plano) list = list.filter(p => String(p.plano || '').trim() === plano);
    if (q) list = list.filter(p => {
      const blob = ((p.nome || '') + ' ' + (p.cpf || '') + ' ' + (p.plano || '') + ' ' + (p.carteirinha || '')).toLowerCase();
      return blob.includes(q);
    });
    const cmp = pacientes.ORDENS[ordem] || pacientes.ORDENS.nome;
    /* cópia: ordenar a lista do store trocaria a ordem de gravação */
    return list.slice().sort(cmp);
  },
  render() {
    pacientes._encherPlanos();
    pacientes._marcarSetaOrdem();
    const listaCompleta = pacientes.filtrar();
    const tbody = document.getElementById('pacientes-tbody');
    if (!tbody) return;
    pacientes._wireActions(tbody);
    if (listaCompleta.length === 0) {
      /* "Nenhum paciente cadastrado" com filtro ligado é mentira: há
         cadastro, o filtro é que não deixou passar. */
      const total = pacientes.list().length;
      tbody.innerHTML = '<tr class="empty-row"><td colspan="7">' +
        (total ? 'Nenhum paciente com este filtro — há <b>' + total + '</b> no cadastro. ' +
                 '<button type="button" class="btn btn-xs" onclick="pacientes.limparFiltros()">Limpar filtros</button>'
               : 'Nenhum paciente cadastrado') + '</td></tr>';
      return;
    }
    /* Performance: renderiza no máximo 100 por vez. Com muitos pacientes,
       orienta o usuário a refinar a busca em vez de travar a tela. */
    const LIMITE = 100;
    const list = listaCompleta.slice(0, LIMITE);
    const excedente = listaCompleta.length - list.length;
    tbody.innerHTML = list.map(p => `
      <tr>
        <td data-label="Nome"><strong>${utils.escapeHTML(p.nome || '')}</strong>${(p.apartamento === true || p.apartamento === '1' || p.apartamento === 1) ? ' <span style="font-size:.66rem;background:#e8f1fa;color:#1c64a9;padding:2px 7px;border-radius:10px;font-weight:600;white-space:nowrap">🏨 Apto</span>' : ''}</td>
        <td data-label="CPF">${utils.escapeHTML(p.cpf || '')}</td>
        <td data-label="Nascimento">${utils.formatarData(p.nascimento)}</td>
        <td data-label="Plano">${utils.escapeHTML(p.plano || '')}</td>
        <td data-label="Carteirinha">${utils.escapeHTML(p.carteirinha || '')}</td>
        <td data-label="Telefone">${utils.escapeHTML(p.telefone || '')}</td>
        <td class="actions-cell">
          <button class="btn btn-xs" data-pac-action="editar" data-pac-id="${utils.escapeAttr(p._id || '')}">Editar</button>
          <button class="btn btn-xs" data-pac-action="corrigir-nome" data-pac-id="${utils.escapeAttr(p._id || '')}" title="Corrige o nome no cadastro E em todos os registros deste paciente">✏️ Nome</button>
          <button class="btn btn-xs" data-pac-action="historico" data-pac-id="${utils.escapeAttr(p._id || '')}" title="Tudo deste paciente: cadastro, documentos com data, financeiro, o que está pago e o que está em aberto">📚 Histórico</button>
          <button class="btn btn-xs" data-pac-action="resumo" data-pac-id="${utils.escapeAttr(p._id || '')}" title="Resumo clínico com evolução da dor (EVA)">📋 Resumo</button>
          <button class="btn btn-xs" data-pac-action="acoes" data-pac-id="${utils.escapeAttr(p._id || '')}">⚡ Ações</button>
          <button class="btn btn-xs btn-danger" data-pac-action="excluir" data-pac-id="${utils.escapeAttr(p._id || '')}">×</button>
        </td>
      </tr>
    `).join('') + (excedente > 0 ? `
      <tr class="empty-row"><td colspan="7" style="color:var(--text-mute);font-style:italic">Mostrando os primeiros ${LIMITE} de ${listaCompleta.length}. Use a busca acima para refinar e encontrar um paciente específico.</td></tr>` : '');
  },
};

/* FIM DA APRESENTAÇÃO DE PACIENTES */
