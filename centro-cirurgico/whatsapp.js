// =====================================================================
//  whatsapp.js
//  Comunicação por WhatsApp em dois níveis:
//   Nível 1 — envio manual via link wa.me (sem enviar sem confirmação).
//   Nível 2 — gatilho da Edge Function 'whatsapp-notify' (token no servidor).
//
//  A mensagem é sempre NEUTRA: nunca inclui CPF, carteirinha, data de
//  nascimento, senha de autorização, dados clínicos ou arquivos.
// =====================================================================

import { supabase, state, escapeHtml, toast, formatDateBR, hhmm } from './supabase-client.js';

// Monta a mensagem padrão (neutra) a partir do template do centro.
export function buildMessage(name, dateISO, start, end) {
  const template = state.settings?.whatsapp_template
    || 'Olá, {nome}. Existe uma atualização em um procedimento no Centro Cirúrgico para {data}, das {hora_inicial} às {hora_final}. Acesse o sistema para consultar os detalhes.';
  return template
    .replaceAll('{nome}', name ?? '')
    .replaceAll('{data}', formatDateBR(dateISO))
    .replaceAll('{hora_inicial}', hhmm(start))
    .replaceAll('{hora_final}', hhmm(end));
}

// Normaliza o telefone para o formato aceito pelo wa.me (só dígitos,
// com DDI). Assume Brasil (55) quando não informado.
function normalizePhone(phone) {
  let digits = String(phone || '').replace(/\D+/g, '');
  if (!digits) return '';
  if (!digits.startsWith('55') && digits.length <= 11) digits = '55' + digits;
  return digits;
}

// Nível 1 — abre o WhatsApp/WhatsApp Web com a mensagem preenchida.
export function sendManual(phone, message) {
  const digits = normalizePhone(phone);
  if (!digits) { toast('Destinatário sem número de WhatsApp válido.', 'error'); return; }
  const url = `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
  window.open(url, '_blank', 'noopener');
}

// Nível 2 — dispara a Edge Function (usa o token do servidor).
export async function sendAutomatic(phone, name, dateISO, start, end) {
  const { data, error } = await supabase.functions.invoke('whatsapp-notify', {
    body: {
      to: normalizePhone(phone),
      name,
      date: formatDateBR(dateISO),
      start: hhmm(start),
      end: hhmm(end),
    },
  });
  if (error) throw new Error(error.message);
  return data;
}

// Modal de seleção de destinatário entre os profissionais associados.
export function openWhatsAppPicker({ appointment, professionals, people }) {
  // Reúne os profissionais associados com telefone.
  const ids = new Set(professionals.map((p) => p.user_id));
  if (appointment.surgeon_id) ids.add(appointment.surgeon_id);

  const recipients = people
    .filter((p) => ids.has(p.id))
    .map((p) => ({ id: p.id, name: p.full_name }));

  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal small">
      <header class="modal-header">
        <h2>Enviar pelo WhatsApp</h2>
        <button class="modal-close">&times;</button>
      </header>
      <div class="modal-body">
        <p class="hint">A mensagem é neutra e não contém dados sensíveis do paciente.</p>
        <label class="field"><span>Destinatário</span>
          <select id="wa-recipient">
            <option value="">— selecione um profissional associado —</option>
            ${recipients.map((r) => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('')}
          </select>
        </label>
        <label class="field"><span>Mensagem</span>
          <textarea id="wa-message" rows="4"></textarea>
        </label>
        <div class="wa-actions">
          <button class="btn primary" id="wa-manual">Abrir WhatsApp</button>
          ${state.settings?.whatsapp_enabled ? '<button class="btn" id="wa-auto">Enviar automático</button>' : ''}
        </div>
        <div id="wa-error" class="form-error"></div>
      </div>
    </div>`;

  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector('.modal-close').onclick = close;
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  const recipientSel = modal.querySelector('#wa-recipient');
  const messageEl = modal.querySelector('#wa-message');

  const refreshMessage = () => {
    const r = recipients.find((x) => x.id === recipientSel.value);
    messageEl.value = buildMessage(r?.name ?? '', appointment.appointment_date, appointment.start_time, appointment.end_time);
  };
  recipientSel.onchange = refreshMessage;

  // Precisamos do telefone do destinatário: buscamos sob demanda.
  async function recipientPhone(userId) {
    const { data } = await supabase.from('profiles').select('phone_whatsapp').eq('id', userId).single();
    return data?.phone_whatsapp ?? '';
  }

  modal.querySelector('#wa-manual').onclick = async () => {
    const err = modal.querySelector('#wa-error'); err.textContent = '';
    if (!recipientSel.value) { err.textContent = 'Escolha um destinatário.'; return; }
    const phone = await recipientPhone(recipientSel.value);
    sendManual(phone, messageEl.value);
  };

  modal.querySelector('#wa-auto')?.addEventListener('click', async () => {
    const err = modal.querySelector('#wa-error'); err.textContent = '';
    if (!recipientSel.value) { err.textContent = 'Escolha um destinatário.'; return; }
    const r = recipients.find((x) => x.id === recipientSel.value);
    const phone = await recipientPhone(recipientSel.value);
    try {
      await sendAutomatic(phone, r?.name, appointment.appointment_date, appointment.start_time, appointment.end_time);
      toast('Mensagem enviada pelo WhatsApp.', 'success');
      close();
    } catch (e) {
      err.textContent = 'Falha no envio automático: ' + e.message;
    }
  });
}
