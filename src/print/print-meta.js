'use strict';

/* Prepara somente a apresentação de impressão; não altera o registro clínico. */
function atualizarMetaImpressao() {
  document.querySelectorAll('.module').forEach(modulo => modulo.classList.remove('print-active'));
  const active = document.querySelector('.module.active');
  if (active) active.classList.add('print-active');

  const setMeta = (id, html) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  };
  const hoje = new Date().toLocaleDateString('pt-BR');
  const periodoEl = document.getElementById('dash-periodo');
  const periodo = periodoEl && periodoEl.selectedOptions && periodoEl.selectedOptions[0]
    ? periodoEl.selectedOptions[0].text
    : '—';
  setMeta('print-meta-dashboard',
    `<strong>Período:</strong> ${utils.escapeHTML(periodo)}<br>${hoje}`);

  const getNome = formId => (document.querySelector(`#${formId} [name="nome"]`) || {}).value
    || (document.querySelector(`#${formId} [name="paciente"]`) || {}).value
    || (document.querySelector(`#${formId} [name="paciente_nome"]`) || {}).value || '—';

  setMeta('print-meta-pre', `<strong>${utils.escapeHTML(getNome('form-pre'))}</strong><br>${hoje}`);
  setMeta('print-meta-consulta', `<strong>${utils.escapeHTML(getNome('form-consulta'))}</strong><br>${hoje}`);
  setMeta('print-meta-recuperacao', `<strong>${utils.escapeHTML(getNome('form-recuperacao'))}</strong><br>${hoje}`);

  const procA = (document.querySelector('#form-anestesia [name="procedimento"]') || {}).value || '';
  const dataA = (document.querySelector('#form-anestesia [name="data_anestesia"]') || {}).value || '';
  const dataMeta = dataA ? utils.escapeHTML(utils.formatarData(dataA)) : hoje;
  setMeta('print-meta-anestesia',
    `<strong>${utils.escapeHTML(getNome('form-anestesia'))}</strong>` +
    `<br>${dataMeta}` +
    (procA ? `<br>${utils.escapeHTML(procA)}` : ''));

  setMeta('print-meta-financeiro', `<strong>Conciliação</strong><br>${hoje}`);
  setMeta('print-meta-agenda', `<strong>Agenda</strong><br>${hoje}`);
}

window.addEventListener('beforeprint', atualizarMetaImpressao);

/* FIM DOS METADADOS DE IMPRESSÃO */
