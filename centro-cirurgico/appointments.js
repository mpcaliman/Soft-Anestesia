// =====================================================================
//  appointments.js
//  Cadastro, edição, visualização e exclusão de agendamentos, incluindo
//  profissionais, equipamentos e arquivos anexados (Storage).
//
//  A gravação passa pela RPC segura save_appointment(), que verifica
//  conflitos no servidor e registra justificativa para a auditoria.
// =====================================================================

import {
  supabase, state, toast, setLoading, escapeHtml,
  formatDateBR, hhmm, timeToMinutes, minutesToTime,
} from './supabase-client.js';
import { CONFIG } from './config.js';

// Papéis de profissionais exibidos no formulário.
export const PROFESSIONAL_ROLES = [
  { key: 'cirurgiao_principal', label: 'Cirurgião principal', single: true },
  { key: 'cirurgiao_adicional', label: 'Cirurgião adicional', single: false },
  { key: 'cirurgiao_auxiliar', label: 'Cirurgião auxiliar', single: false },
  { key: 'anestesiologista', label: 'Anestesiologista', single: false },
  { key: 'pediatra', label: 'Pediatra', single: false },
  { key: 'auxiliar', label: 'Auxiliar', single: false },
  { key: 'empresa', label: 'Empresa prestadora', single: false },
];

export const PRIORITIES = [
  { key: 'eletiva', label: 'Eletiva' },
  { key: 'urgencia', label: 'Urgência' },
  { key: 'emergencia', label: 'Emergência' },
];

// Caches simples de listas de apoio.
let cache = {
  rooms: [], statuses: [], accommodations: [], equipment: [], people: [],
};

export async function loadReferenceData() {
  const center = state.profile.surgical_center_id;
  const [rooms, statuses, accommodations, equipment, people] = await Promise.all([
    supabase.from('rooms').select('*').eq('surgical_center_id', center).eq('active', true).order('sort_order'),
    supabase.from('appointment_statuses').select('*').eq('surgical_center_id', center).eq('active', true).order('sort_order'),
    supabase.from('accommodation_types').select('*').eq('surgical_center_id', center).eq('active', true).order('name'),
    supabase.from('equipment').select('*').eq('surgical_center_id', center).eq('active', true).order('name'),
    supabase.from('profiles').select('id, full_name, is_company').eq('surgical_center_id', center).eq('status', 'ativo').order('full_name'),
  ]);
  cache.rooms = rooms.data ?? [];
  cache.statuses = statuses.data ?? [];
  cache.accommodations = accommodations.data ?? [];
  cache.equipment = equipment.data ?? [];
  cache.people = people.data ?? [];
  return cache;
}

export function getReference() {
  return cache;
}

// --- Carrega um agendamento completo (para visualização/edição) ------
export async function fetchAppointment(id) {
  const { data: appt, error } = await supabase
    .from('appointments')
    .select('*')
    .eq('id', id)
    .single();
  if (error) throw new Error(error.message);

  const [profs, equips, files] = await Promise.all([
    supabase.from('appointment_professionals').select('*').eq('appointment_id', id),
    supabase.from('appointment_equipment').select('*').eq('appointment_id', id),
    supabase.from('appointment_files').select('*').eq('appointment_id', id).order('uploaded_at'),
  ]);

  return {
    appt,
    professionals: profs.data ?? [],
    equipment: equips.data ?? [],
    files: files.data ?? [],
  };
}

// --- Verificação de conflito (server-side) ---------------------------
export async function checkConflict(roomId, date, start, end, excludeId) {
  const { data, error } = await supabase.rpc('check_appointment_conflict', {
    p_room_id: roomId,
    p_date: date,
    p_start_time: start,
    p_end_time: end,
    p_exclude_id: excludeId ?? null,
  });
  if (error) throw new Error(error.message);
  return data ?? [];
}

// --- Salvamento via RPC segura ---------------------------------------
export async function saveAppointment(payload, justification) {
  const { data, error } = await supabase.rpc('save_appointment', {
    p_payload: payload,
    p_justification: justification ?? null,
  });
  if (error) {
    const msg = String(error.message);
    // Conflito de equipamento exclusivo: sinaliza e sugere outro horário/dia.
    if (msg.includes('EQUIP_CONFLITO')) {
      const name = msg.split('EQUIP_CONFLITO:')[1]?.trim() || 'equipamento';
      throw new Error(
        `Equipamento indisponível neste horário: ${name}. ` +
        'Ele já está reservado por outro agendamento no período. ' +
        'Escolha outro horário ou dia, ou remova o equipamento.',
      );
    }
    if (msg.includes('CONFLITO')) {
      throw new Error('Horário indisponível: já existe um agendamento ou bloqueio nesse período. Escolha outro horário ou dia.');
    }
    throw new Error(msg);
  }
  return data; // id do agendamento
}

export async function deleteAppointment(id) {
  const { error } = await supabase.from('appointments').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

// =====================================================================
//  ARQUIVOS (Supabase Storage — bucket privado)
// =====================================================================

// Caminho no bucket: {appointment_id}/{timestamp}-{nome}
function buildStoragePath(appointmentId, fileName) {
  const safe = fileName.replace(/[^\w.\-]+/g, '_');
  const stamp = Date.now();
  return `${appointmentId}/${stamp}-${safe}`;
}

export async function uploadFiles(appointmentId, fileList) {
  const results = [];
  for (const file of fileList) {
    if (!CONFIG.ALLOWED_FILE_TYPES.includes(file.type)) {
      toast(`Tipo não permitido: ${file.name}`, 'error');
      continue;
    }
    if (file.size > CONFIG.MAX_FILE_SIZE) {
      toast(`Arquivo muito grande (máx. ${Math.round(CONFIG.MAX_FILE_SIZE / 1048576)}MB): ${file.name}`, 'error');
      continue;
    }
    const path = buildStoragePath(appointmentId, file.name);
    const { error: upErr } = await supabase.storage
      .from(CONFIG.STORAGE_BUCKET)
      .upload(path, file, { contentType: file.type, upsert: false });
    if (upErr) {
      toast(`Falha ao enviar ${file.name}: ${upErr.message}`, 'error');
      continue;
    }
    const { error: metaErr } = await supabase.from('appointment_files').insert({
      appointment_id: appointmentId,
      storage_path: path,
      file_name: file.name,
      file_type: file.type,
      file_size: file.size,
      uploaded_by: state.profile.id,
    });
    if (metaErr) {
      // Reverte o upload se o metadado falhar.
      await supabase.storage.from(CONFIG.STORAGE_BUCKET).remove([path]);
      toast(`Falha ao registrar ${file.name}: ${metaErr.message}`, 'error');
      continue;
    }
    results.push(path);
  }
  return results;
}

// Gera URL assinada temporária para visualizar/baixar um arquivo.
export async function getSignedUrl(path, expiresIn = 300) {
  const { data, error } = await supabase.storage
    .from(CONFIG.STORAGE_BUCKET)
    .createSignedUrl(path, expiresIn);
  if (error) throw new Error(error.message);
  return data.signedUrl;
}

export async function deleteFile(fileRow) {
  const { error: sErr } = await supabase.storage
    .from(CONFIG.STORAGE_BUCKET)
    .remove([fileRow.storage_path]);
  if (sErr) throw new Error(sErr.message);
  const { error: mErr } = await supabase.from('appointment_files').delete().eq('id', fileRow.id);
  if (mErr) throw new Error(mErr.message);
}

// =====================================================================
//  FORMULÁRIO DE AGENDAMENTO (modal)
// =====================================================================

function optionList(items, valueKey, labelKey, selected) {
  return items
    .map((i) => `<option value="${escapeHtml(i[valueKey])}" ${String(i[valueKey]) === String(selected) ? 'selected' : ''}>${escapeHtml(i[labelKey])}</option>`)
    .join('');
}

// Abre o modal de agendamento. `prefill` pode conter { room_id, date,
// start_time, end_time }. `existingId` edita um agendamento existente.
export async function openAppointmentModal({ prefill = {}, existingId = null, onSaved } = {}) {
  await loadReferenceData();
  const ref = getReference();

  let data = null;
  if (existingId) {
    setLoading(true);
    try {
      data = await fetchAppointment(existingId);
    } catch (e) {
      toast('Erro ao carregar agendamento: ' + e.message, 'error');
      setLoading(false);
      return;
    }
    setLoading(false);
  }

  const a = data?.appt ?? {};
  const profs = data?.professionals ?? [];
  const files = data?.files ?? [];
  const equips = data?.equipment ?? [];

  const requireAuth = state.settings?.require_authorization ?? true;
  const allowNA = state.settings?.allow_auth_not_applicable ?? false;

  // Constrói os seletores de profissionais por papel.
  const profByRole = (role) => profs.filter((p) => p.role === role).map((p) => p.user_id);

  const professionalFields = PROFESSIONAL_ROLES.map((r) => {
    const selectedIds = r.key === 'cirurgiao_principal'
      ? [a.surgeon_id].filter(Boolean)
      : profByRole(r.key);
    if (r.single) {
      return `
        <label class="field">
          <span>${r.label}</span>
          <select data-prof-role="${r.key}">
            <option value="">— selecione —</option>
            ${optionList(ref.people, 'id', 'full_name', selectedIds[0])}
          </select>
        </label>`;
    }
    return `
      <label class="field">
        <span>${r.label}</span>
        <select data-prof-role="${r.key}" multiple size="3">
          ${ref.people.map((p) => `<option value="${p.id}" ${selectedIds.includes(p.id) ? 'selected' : ''}>${escapeHtml(p.full_name)}</option>`).join('')}
        </select>
      </label>`;
  }).join('');

  const equipChecks = ref.equipment.map((e) => {
    const found = equips.find((x) => x.equipment_id === e.id);
    // 🔒 sinaliza equipamento exclusivo (não permite uso simultâneo).
    const lock = e.block_simultaneous
      ? '<span class="excl-icon" title="Uso exclusivo: não permite agendamentos simultâneos">🔒</span>'
      : '';
    return `
      <label class="chk">
        <input type="checkbox" data-equip="${e.id}" ${found ? 'checked' : ''}>
        <span>${escapeHtml(e.name)} ${lock}</span>
        <input type="number" min="1" value="${found?.quantity ?? 1}" data-equip-qty="${e.id}" class="qty">
      </label>`;
  }).join('');

  const filesList = files.map((f) => `
    <li data-file-id="${f.id}">
      <span class="file-name">${escapeHtml(f.file_name)}</span>
      <span class="file-meta">${escapeHtml(f.file_type)} · ${formatDateBR(f.uploaded_at)}</span>
      <button type="button" class="btn-link" data-view-file="${escapeHtml(f.storage_path)}">Ver</button>
      <button type="button" class="btn-link danger" data-del-file="${f.id}">Excluir</button>
    </li>`).join('');

  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-label="Agendamento">
      <header class="modal-header">
        <h2>${existingId ? 'Editar agendamento' : 'Novo agendamento'}</h2>
        <button class="modal-close" aria-label="Fechar">&times;</button>
      </header>
      <form id="appt-form" class="modal-body">
        <fieldset>
          <legend>Paciente</legend>
          <label class="field"><span>Nome completo do paciente *</span>
            <input name="patient_name" required value="${escapeHtml(a.patient_name ?? '')}"></label>
          <div class="grid-2">
            <label class="field"><span>Data de nascimento</span>
              <input type="date" name="patient_birthdate" value="${a.patient_birthdate ?? ''}"></label>
            <label class="field"><span>Tipo de acomodação</span>
              <select name="accommodation_type_id">
                <option value="">— selecione —</option>
                ${optionList(ref.accommodations, 'id', 'name', a.accommodation_type_id)}
              </select></label>
          </div>
          <div class="grid-2">
            <label class="field"><span>CPF</span>
              <input name="patient_cpf" value="${escapeHtml(a.patient_cpf ?? '')}" placeholder="Obrigatório CPF ou carteirinha"></label>
            <label class="field"><span>Carteirinha do convênio</span>
              <input name="patient_insurance_card" value="${escapeHtml(a.patient_insurance_card ?? '')}"></label>
          </div>
          <div class="grid-2">
            <label class="field"><span>Convênio</span>
              <input name="insurance_name" value="${escapeHtml(a.insurance_name ?? '')}"></label>
            <label class="field"><span>Senha de autorização ${requireAuth ? '*' : ''}</span>
              <input name="authorization_password" value="${escapeHtml(a.authorization_password ?? '')}"></label>
          </div>
          ${allowNA ? `<label class="chk"><input type="checkbox" name="authorization_not_applicable" ${a.authorization_not_applicable ? 'checked' : ''}><span>Autorização não se aplica (particular)</span></label>` : ''}
        </fieldset>

        <fieldset>
          <legend>Procedimento</legend>
          <label class="field"><span>Nome da cirurgia/procedimento *</span>
            <input name="procedure_name" required value="${escapeHtml(a.procedure_name ?? '')}"></label>
          <div class="grid-3">
            <label class="field"><span>Data *</span>
              <input type="date" name="appointment_date" required value="${a.appointment_date ?? prefill.date ?? ''}"></label>
            <label class="field"><span>Hora inicial *</span>
              <input type="time" name="start_time" required value="${hhmm(a.start_time ?? prefill.start_time ?? '')}"></label>
            <label class="field"><span>Hora final *</span>
              <input type="time" name="end_time" required value="${hhmm(a.end_time ?? prefill.end_time ?? '')}"></label>
          </div>
          <div class="grid-3">
            <label class="field"><span>Sala *</span>
              <select name="room_id" required>
                <option value="">— selecione —</option>
                ${optionList(ref.rooms, 'id', 'name', a.room_id ?? prefill.room_id)}
              </select></label>
            <label class="field"><span>Status</span>
              <select name="status_id">
                ${optionList(ref.statuses, 'id', 'name', a.status_id ?? ref.statuses.find(s => s.is_default)?.id)}
              </select></label>
            <label class="field"><span>Prioridade</span>
              <select name="priority">
                ${PRIORITIES.map(p => `<option value="${p.key}" ${(a.priority ?? 'eletiva') === p.key ? 'selected' : ''}>${p.label}</option>`).join('')}
              </select></label>
          </div>
          <div class="grid-2">
            <label class="chk"><input type="checkbox" name="needs_pediatrician" ${a.needs_pediatrician ? 'checked' : ''}><span>Necessita pediatra</span></label>
            <label class="chk"><input type="checkbox" name="needs_company" ${a.needs_company ? 'checked' : ''}><span>Necessita empresa prestadora</span></label>
          </div>
          <label class="field"><span>Observações operacionais</span>
            <textarea name="notes" rows="2">${escapeHtml(a.notes ?? '')}</textarea></label>
        </fieldset>

        <fieldset>
          <legend>Requisitos especiais</legend>
          <div class="chip-group" role="group" aria-label="Requisitos especiais">
            <label class="chip"><input type="checkbox" name="needs_uti" ${a.needs_uti ? 'checked' : ''}><span>UTI</span></label>
            <label class="chip"><input type="checkbox" name="needs_hemoba" ${a.needs_hemoba ? 'checked' : ''}><span>HEMOBA</span></label>
            <label class="chip"><input type="checkbox" name="latex_allergy" ${a.latex_allergy ? 'checked' : ''}><span>Alergia a látex</span></label>
          </div>
          <label class="field"><span>Observação dos requisitos especiais</span>
            <textarea name="special_notes" rows="2" placeholder="Campo livre para observações">${escapeHtml(a.special_notes ?? '')}</textarea></label>
        </fieldset>

        <fieldset>
          <legend>Profissionais</legend>
          ${professionalFields}
        </fieldset>

        <fieldset>
          <legend>Equipamentos</legend>
          <div class="equip-grid">${equipChecks || '<em>Nenhum equipamento cadastrado.</em>'}</div>
        </fieldset>

        <fieldset>
          <legend>Arquivos anexados (foto ou PDF)</legend>
          <input type="file" id="appt-files" multiple accept=".jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf">
          <small>Máx. ${Math.round(CONFIG.MAX_FILE_SIZE / 1048576)}MB por arquivo. Somente usuários associados ou gestor visualizam.</small>
          <ul class="files-list" id="files-list">${filesList}</ul>
        </fieldset>

        ${existingId ? `<label class="field"><span>Justificativa (alteração excepcional)</span>
          <input name="justification" placeholder="Obrigatória para alterações do gestor"></label>` : ''}

        <div id="appt-error" class="form-error"></div>
        <footer class="modal-footer">
          <button type="button" class="btn ghost modal-cancel">Cancelar</button>
          <button type="submit" class="btn primary">${existingId ? 'Salvar alterações' : 'Agendar'}</button>
        </footer>
      </form>
    </div>`;

  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector('.modal-close').onclick = close;
  modal.querySelector('.modal-cancel').onclick = close;
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  // Ações sobre arquivos existentes.
  modal.querySelectorAll('[data-view-file]').forEach((btn) => {
    btn.onclick = async () => {
      try {
        const url = await getSignedUrl(btn.dataset.viewFile);
        window.open(url, '_blank', 'noopener');
      } catch (e) { toast('Erro ao abrir arquivo: ' + e.message, 'error'); }
    };
  });
  modal.querySelectorAll('[data-del-file]').forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm('Excluir este arquivo?')) return;
      const row = files.find((f) => f.id === btn.dataset.delFile);
      try {
        await deleteFile(row);
        btn.closest('li')?.remove();
        toast('Arquivo excluído.', 'success');
      } catch (e) { toast('Erro: ' + e.message, 'error'); }
    };
  });

  // Submissão do formulário.
  modal.querySelector('#appt-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = modal.querySelector('#appt-error');
    errEl.textContent = '';
    const form = e.target;

    const cpf = form.patient_cpf.value.trim();
    const card = form.patient_insurance_card.value.trim();
    if (!cpf && !card) {
      errEl.textContent = 'Informe ao menos o CPF ou a carteirinha do convênio.';
      return;
    }

    const authNA = form.authorization_not_applicable?.checked ?? false;
    if (requireAuth && !authNA && !form.authorization_password.value.trim()) {
      errEl.textContent = 'A senha de autorização é obrigatória.';
      return;
    }

    if (timeToMinutes(form.end_time.value) <= timeToMinutes(form.start_time.value)) {
      errEl.textContent = 'A hora final deve ser maior que a hora inicial.';
      return;
    }

    // Monta a lista de profissionais.
    const professionals = [];
    modal.querySelectorAll('[data-prof-role]').forEach((sel) => {
      const role = sel.dataset.profRole;
      if (sel.multiple) {
        Array.from(sel.selectedOptions).forEach((o) => {
          if (o.value) professionals.push({ user_id: o.value, role });
        });
      } else if (sel.value) {
        professionals.push({ user_id: sel.value, role });
      }
    });

    // Equipamentos marcados.
    const equipment = [];
    modal.querySelectorAll('[data-equip]').forEach((chk) => {
      if (chk.checked) {
        const id = chk.dataset.equip;
        const qty = modal.querySelector(`[data-equip-qty="${id}"]`)?.value ?? 1;
        equipment.push({ equipment_id: id, quantity: Number(qty) || 1 });
      }
    });

    const surgeonMain = professionals.find((p) => p.role === 'cirurgiao_principal')?.user_id ?? null;

    const payload = {
      id: existingId ?? '',
      room_id: form.room_id.value,
      patient_name: form.patient_name.value.trim(),
      patient_birthdate: form.patient_birthdate.value || '',
      patient_cpf: cpf,
      patient_insurance_card: card,
      insurance_name: form.insurance_name.value.trim(),
      accommodation_type_id: form.accommodation_type_id.value || '',
      authorization_password: form.authorization_password.value.trim(),
      authorization_not_applicable: authNA,
      procedure_name: form.procedure_name.value.trim(),
      appointment_date: form.appointment_date.value,
      start_time: form.start_time.value,
      end_time: form.end_time.value,
      status_id: form.status_id.value || '',
      priority: form.priority.value,
      needs_pediatrician: form.needs_pediatrician.checked,
      needs_company: form.needs_company.checked,
      needs_uti: form.needs_uti.checked,
      needs_hemoba: form.needs_hemoba.checked,
      latex_allergy: form.latex_allergy.checked,
      special_notes: form.special_notes.value.trim(),
      notes: form.notes.value.trim(),
      surgeon_id: surgeonMain,
      professionals,
      equipment,
    };

    const justification = form.justification?.value?.trim() || null;

    setLoading(true);
    try {
      const id = await saveAppointment(payload, justification);
      // Upload de novos arquivos, se houver.
      const fileInput = modal.querySelector('#appt-files');
      if (fileInput?.files?.length) {
        await uploadFiles(id, Array.from(fileInput.files));
      }
      toast('Agendamento salvo com sucesso.', 'success');
      close();
      onSaved?.(id);
    } catch (err) {
      errEl.textContent = err.message;
    } finally {
      setLoading(false);
    }
  });
}

// =====================================================================
//  DETALHES (somente leitura) — respeita associação via RLS
// =====================================================================
export async function openAppointmentDetails(id, { onEdit } = {}) {
  setLoading(true);
  let data;
  try {
    data = await fetchAppointment(id);
  } catch (e) {
    // RLS negou o acesso: usuário não associado.
    setLoading(false);
    toast('Sala ocupada. Você não tem acesso aos detalhes deste procedimento.', 'info', 5000);
    return;
  }
  await loadReferenceData();
  setLoading(false);

  const ref = getReference();
  const a = data.appt;
  const roomName = ref.rooms.find((r) => r.id === a.room_id)?.name ?? '—';
  const statusName = ref.statuses.find((s) => s.id === a.status_id)?.name ?? '—';
  const accName = ref.accommodations.find((x) => x.id === a.accommodation_type_id)?.name ?? '—';
  const peopleName = (uid) => ref.people.find((p) => p.id === uid)?.full_name ?? uid;

  const profsHtml = data.professionals.length
    ? data.professionals.map((p) => `<li><strong>${escapeHtml(labelForRole(p.role))}:</strong> ${escapeHtml(peopleName(p.user_id))}</li>`).join('')
    : '<li>—</li>';

  const equipHtml = data.equipment.length
    ? data.equipment.map((e) => {
        const name = ref.equipment.find((x) => x.id === e.equipment_id)?.name ?? e.equipment_id;
        return `<li>${escapeHtml(name)} (${e.quantity})</li>`;
      }).join('')
    : '<li>—</li>';

  const filesHtml = data.files.length
    ? data.files.map((f) => `<li><button class="btn-link" data-view="${escapeHtml(f.storage_path)}">${escapeHtml(f.file_name)}</button> <span class="file-meta">${escapeHtml(f.file_type)} · ${formatDateBR(f.uploaded_at)}</span></li>`).join('')
    : '<li>Nenhum arquivo anexado.</li>';

  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <header class="modal-header">
        <h2>Detalhes do procedimento</h2>
        <button class="modal-close" aria-label="Fechar">&times;</button>
      </header>
      <div class="modal-body details">
        <div class="detail-grid">
          <div><label>Paciente</label><p>${escapeHtml(a.patient_name)}</p></div>
          <div><label>Nascimento</label><p>${formatDateBR(a.patient_birthdate) || '—'}</p></div>
          <div><label>CPF</label><p>${escapeHtml(a.patient_cpf || '—')}</p></div>
          <div><label>Carteirinha</label><p>${escapeHtml(a.patient_insurance_card || '—')}</p></div>
          <div><label>Convênio</label><p>${escapeHtml(a.insurance_name || '—')}</p></div>
          <div><label>Acomodação</label><p>${escapeHtml(accName)}</p></div>
          <div><label>Senha de autorização</label><p>${a.authorization_not_applicable ? 'Não se aplica' : escapeHtml(a.authorization_password || '—')}</p></div>
          <div><label>Procedimento</label><p>${escapeHtml(a.procedure_name)}</p></div>
          <div><label>Data</label><p>${formatDateBR(a.appointment_date)}</p></div>
          <div><label>Horário</label><p>${hhmm(a.start_time)} às ${hhmm(a.end_time)}</p></div>
          <div><label>Sala</label><p>${escapeHtml(roomName)}</p></div>
          <div><label>Status</label><p>${escapeHtml(statusName)}</p></div>
          <div><label>Prioridade</label><p>${escapeHtml(labelForPriority(a.priority))}</p></div>
        </div>
        <h3>Requisitos especiais</h3>
        <p>${[a.needs_uti ? 'UTI' : null, a.needs_hemoba ? 'HEMOBA' : null, a.latex_allergy ? 'Alergia a látex' : null].filter(Boolean).map(escapeHtml).join(' · ') || '—'}</p>
        ${a.special_notes ? `<p class="detail-obs">${escapeHtml(a.special_notes)}</p>` : ''}
        <h3>Profissionais</h3><ul class="plain">${profsHtml}</ul>
        <h3>Equipamentos</h3><ul class="plain">${equipHtml}</ul>
        <h3>Observações</h3><p>${escapeHtml(a.notes || '—')}</p>
        <h3>Arquivos anexados</h3><ul class="plain files">${filesHtml}</ul>
      </div>
      <footer class="modal-footer">
        <button class="btn ghost modal-cancel">Fechar</button>
        <button class="btn primary" id="edit-appt">Editar</button>
        <button class="btn" id="wa-appt">Enviar pelo WhatsApp</button>
      </footer>
    </div>`;

  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector('.modal-close').onclick = close;
  modal.querySelector('.modal-cancel').onclick = close;
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  modal.querySelectorAll('[data-view]').forEach((btn) => {
    btn.onclick = async () => {
      try {
        const url = await getSignedUrl(btn.dataset.view);
        window.open(url, '_blank', 'noopener');
      } catch (e) { toast('Erro: ' + e.message, 'error'); }
    };
  });

  modal.querySelector('#edit-appt').onclick = () => {
    close();
    onEdit?.(id);
  };

  modal.querySelector('#wa-appt').onclick = async () => {
    const { openWhatsAppPicker } = await import('./whatsapp.js');
    openWhatsAppPicker({ appointment: a, professionals: data.professionals, people: ref.people });
  };
}

export function labelForRole(role) {
  return PROFESSIONAL_ROLES.find((r) => r.key === role)?.label ?? role;
}
export function labelForPriority(p) {
  return PRIORITIES.find((x) => x.key === p)?.label ?? p;
}
