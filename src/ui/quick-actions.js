'use strict';

/* Ações rápidas da camada visual. O paciente é sempre resolvido pelo ID;
   preenchimento e identidade continuam delegados ao autocomplete/linker. */
/* ============================================================================
   QUICK ACTIONS — ações rápidas por procedimento/paciente
============================================================================ */
const quickActions = {
  /* Abre menu para criar/abrir documentos vinculados a um paciente */
  abrir(pacienteId) {
    const p = store.getById('pacientes', pacienteId);
    if (!p) { toast('Paciente não encontrado', 'error'); return; }
    const html = `
      <p style="margin-bottom:14px;color:var(--text-soft);font-size:.88rem">
        Paciente: <strong>${utils.escapeHTML(p.nome)}</strong>
        ${p.cpf ? '· CPF: ' + utils.escapeHTML(p.cpf) : ''}
      </p>
      <div class="quick-action-grid">
        <div class="quick-action-card" onclick="quickActions.criar(${utils.jsArg(p._id)},'consulta'); modal.close();">
          <span class="qa-icon">🩺</span>
          <div class="qa-label">Consulta / Dor</div>
          <div class="qa-desc">Iniciar atendimento</div>
        </div>
        <div class="quick-action-card" onclick="quickActions.criar(${utils.jsArg(p._id)},'pre'); modal.close();">
          <span class="qa-icon">📋</span>
          <div class="qa-label">Pré-anestésica</div>
          <div class="qa-desc">Avaliação clínica</div>
        </div>
        <div class="quick-action-card" onclick="quickActions.criar(${utils.jsArg(p._id)},'anestesia'); modal.close();">
          <span class="qa-icon">💉</span>
          <div class="qa-label">Ficha de Anestesia</div>
          <div class="qa-desc">Registro do ato</div>
        </div>
        <div class="quick-action-card" onclick="quickActions.criar(${utils.jsArg(p._id)},'recuperacao'); modal.close();">
          <span class="qa-icon">🛏️</span>
          <div class="qa-label">Recuperação pós</div>
          <div class="qa-desc">Ficha de SRPA</div>
        </div>
        <div class="quick-action-card" onclick="quickActions.criar(${utils.jsArg(p._id)},'financeiro'); modal.close();">
          <span class="qa-icon">💰</span>
          <div class="qa-label">Financeiro</div>
          <div class="qa-desc">Lançamento</div>
        </div>
        <div class="quick-action-card" onclick="quickActions.criar(${utils.jsArg(p._id)},'agenda'); modal.close();">
          <span class="qa-icon">📅</span>
          <div class="qa-label">Agendar</div>
          <div class="qa-desc">Novo compromisso</div>
        </div>
      </div>
    `;
    modal.open('⚡ Ações rápidas', html, '<button class="btn" onclick="modal.close()">Fechar</button>');
  },
  /* Criar registro vazio em módulo destino, pré-preenchido com dados do paciente */
  criar(pacienteId, mod) {
    const p = store.getById('pacientes', pacienteId);
    if (!p) return;
    if (mod === 'consulta') {
      window.location.hash = 'consulta';
      setTimeout(() => {
        consulta.novo();
        autocomplete._aplicarPaciente('form-consulta', p);
      }, 200);
    } else if (mod === 'pre') {
      window.location.hash = 'pre';
      setTimeout(() => {
        pre.novo();
        autocomplete._aplicarPaciente('form-pre', p);
      }, 200);
    } else if (mod === 'anestesia') {
      window.location.hash = 'anestesia';
      setTimeout(() => {
        anestesia.novo();
        autocomplete._aplicarPaciente('form-anestesia', p);
      }, 250);
    } else if (mod === 'recuperacao') {
      window.location.hash = 'recuperacao';
      setTimeout(() => {
        recuperacao.novo();
        autocomplete._aplicarPaciente('form-recuperacao', p);
      }, 200);
    } else if (mod === 'financeiro') {
      window.location.hash = 'financeiro';
      setTimeout(() => {
        financeiro.editar(null);
        autocomplete._aplicarPaciente('form-financeiro', p);
      }, 250);
    } else if (mod === 'agenda') {
      window.location.hash = 'agenda';
      setTimeout(() => {
        agenda.editar(null);
        autocomplete._aplicarPaciente('form-agenda', p);
      }, 250);
    }
  }
};

/* FIM DAS AÇÕES RÁPIDAS DE APRESENTAÇÃO */
