// =====================================================================
//  settings.js
//  Módulo "Ajustes" — exclusivo do gestor. Gerencia usuários, salas,
//  equipamentos, acomodações, status, matriz de permissões, bloqueios
//  de sala, solicitações de disponibilidade e configurações gerais
//  (intervalo da grade, horário de funcionamento, WhatsApp).
// =====================================================================

import { supabase, state, escapeHtml, toast, setLoading, formatDateBR, hhmm } from './supabase-client.js';
import { PROFESSIONAL_ROLES } from './appointments.js';

const ROLE_LABELS = {
  gestor: 'Gestor', cirurgiao: 'Cirurgião', cirurgiao_auxiliar: 'Cirurgião auxiliar',
  anestesiologista: 'Anestesiologista', pediatra: 'Pediatra', auxiliar: 'Auxiliar', empresa: 'Empresa prestadora',
};
const ALL_ROLES = Object.keys(ROLE_LABELS);

const TABS = [
  { key: 'usuarios', label: 'Usuários' },
  { key: 'salas', label: 'Salas' },
  { key: 'equipamentos', label: 'Equipamentos' },
  { key: 'acomodacoes', label: 'Acomodações' },
  { key: 'status', label: 'Status' },
  { key: 'permissoes', label: 'Matriz de permissões' },
  { key: 'bloqueios', label: 'Bloqueios de sala' },
  { key: 'disponibilidade', label: 'Solicitações de disponibilidade' },
  { key: 'geral', label: 'Configurações gerais' },
];

export async function renderSettings(container) {
  if (!state.isGestor) {
    container.innerHTML = '<p class="error">Acesso restrito ao gestor.</p>';
    return;
  }
  container.innerHTML = `
    <div class="module-head"><h1>Ajustes</h1></div>
    <div class="tabs">${TABS.map((t, i) => `<button class="tab ${i === 0 ? 'active' : ''}" data-tab="${t.key}">${t.label}</button>`).join('')}</div>
    <div id="tab-body" class="tab-body"></div>`;

  const body = container.querySelector('#tab-body');
  container.querySelectorAll('.tab').forEach((t) => {
    t.onclick = () => {
      container.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
      loadTab(t.dataset.tab, body);
    };
  });
  loadTab('usuarios', body);
}

function loadTab(key, body) {
  const map = {
    usuarios: renderUsers, salas: renderRooms, equipamentos: renderEquipment,
    acomodacoes: renderAccommodations, status: renderStatuses, permissoes: renderPermissions,
    bloqueios: renderBlocks, disponibilidade: renderAvailabilityRequests, geral: renderGeneral,
  };
  (map[key] || (() => { body.innerHTML = ''; }))(body);
}

const center = () => state.profile.surgical_center_id;

// =====================================================================
//  USUÁRIOS
// =====================================================================
async function renderUsers(body) {
  setLoading(true);
  const { data: users } = await supabase
    .from('profiles').select('*').eq('surgical_center_id', center()).order('full_name');
  const { data: roles } = await supabase
    .from('user_roles').select('user_id, role');
  setLoading(false);

  const rolesByUser = {};
  (roles ?? []).forEach((r) => { (rolesByUser[r.user_id] ??= []).push(r.role); });

  body.innerHTML = `
    <div class="section-head">
      <h2>Usuários</h2>
      <button class="btn primary small" id="new-user">Convidar usuário</button>
    </div>
    <table class="data-table">
      <thead><tr><th>Nome / Razão social</th><th>E-mail</th><th>Funções</th><th>Situação</th><th></th></tr></thead>
      <tbody>
        ${(users ?? []).map((u) => `
          <tr>
            <td>${escapeHtml(u.full_name)}${u.is_company ? ' <em>(empresa)</em>' : ''}</td>
            <td>${escapeHtml(u.email)}</td>
            <td>${(rolesByUser[u.id] ?? []).map(r => ROLE_LABELS[r] ?? r).join(', ') || '—'}</td>
            <td><span class="badge ${u.status === 'ativo' ? 'ok' : 'off'}">${u.status}</span></td>
            <td class="row-actions">
              <button class="btn-link" data-edit="${u.id}">Editar</button>
              <button class="btn-link" data-toggle="${u.id}" data-status="${u.status}">${u.status === 'ativo' ? 'Inativar' : 'Ativar'}</button>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>`;

  body.querySelector('#new-user').onclick = () => openUserForm(null, body);
  body.querySelectorAll('[data-edit]').forEach((b) => {
    b.onclick = () => openUserForm((users ?? []).find(u => u.id === b.dataset.edit), body, rolesByUser[b.dataset.edit] ?? []);
  });
  body.querySelectorAll('[data-toggle]').forEach((b) => {
    b.onclick = async () => {
      const next = b.dataset.status === 'ativo' ? 'inativo' : 'ativo';
      await supabase.from('profiles').update({ status: next }).eq('id', b.dataset.toggle);
      toast('Situação atualizada.', 'success');
      renderUsers(body);
    };
  });
}

function openUserForm(user, body, userRoles = []) {
  const isNew = !user;
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal">
      <header class="modal-header"><h2>${isNew ? 'Convidar usuário' : 'Editar usuário'}</h2>
        <button class="modal-close">&times;</button></header>
      <form class="modal-body" id="user-form">
        <label class="field"><span>Nome completo / Razão social *</span>
          <input name="full_name" required value="${escapeHtml(user?.full_name ?? '')}"></label>
        <div class="grid-2">
          <label class="field"><span>E-mail *</span>
            <input type="email" name="email" required ${isNew ? '' : 'readonly'} value="${escapeHtml(user?.email ?? '')}"></label>
          <label class="field"><span>Celular (WhatsApp)</span>
            <input name="phone_whatsapp" value="${escapeHtml(user?.phone_whatsapp ?? '')}" placeholder="Ex: 71999999999"></label>
        </div>
        <div class="grid-2">
          <label class="field"><span>Tipo de registro</span>
            <input name="registration_type" value="${escapeHtml(user?.registration_type ?? '')}" placeholder="CRM, COREN, CNPJ..."></label>
          <label class="field"><span>Número do registro</span>
            <input name="registration_number" value="${escapeHtml(user?.registration_number ?? '')}"></label>
        </div>
        <label class="chk"><input type="checkbox" name="is_company" ${user?.is_company ? 'checked' : ''}><span>É empresa prestadora de serviço</span></label>
        <div class="company-fields" style="${user?.is_company ? '' : 'display:none'}">
          <div class="grid-2">
            <label class="field"><span>Nome fantasia</span><input name="company_trade_name" value="${escapeHtml(user?.company_trade_name ?? '')}"></label>
            <label class="field"><span>CNPJ (opcional)</span><input name="cnpj" value="${escapeHtml(user?.cnpj ?? '')}"></label>
          </div>
          <label class="field"><span>Responsável</span><input name="company_responsible" value="${escapeHtml(user?.company_responsible ?? '')}"></label>
        </div>
        <fieldset><legend>Funções (pode selecionar mais de uma)</legend>
          <div class="roles-grid">
            ${ALL_ROLES.map(r => `<label class="chk"><input type="checkbox" name="role" value="${r}" ${userRoles.includes(r) ? 'checked' : ''}><span>${ROLE_LABELS[r]}</span></label>`).join('')}
          </div>
        </fieldset>
        <div class="form-error" id="uf-error"></div>
        <footer class="modal-footer">
          <button type="button" class="btn ghost modal-cancel">Cancelar</button>
          <button type="submit" class="btn primary">${isNew ? 'Enviar convite' : 'Salvar'}</button>
        </footer>
      </form>
    </div>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector('.modal-close').onclick = close;
  modal.querySelector('.modal-cancel').onclick = close;
  modal.querySelector('[name="is_company"]').onchange = (e) => {
    modal.querySelector('.company-fields').style.display = e.target.checked ? '' : 'none';
  };

  modal.querySelector('#user-form').onsubmit = async (e) => {
    e.preventDefault();
    const err = modal.querySelector('#uf-error'); err.textContent = '';
    const form = e.target;
    const selectedRoles = Array.from(form.querySelectorAll('[name="role"]:checked')).map(x => x.value);
    if (!selectedRoles.length) { err.textContent = 'Selecione ao menos uma função.'; return; }

    setLoading(true);
    try {
      if (isNew) {
        // Cria/convida via Edge Function (usa service_role no servidor).
        const { data, error } = await supabase.functions.invoke('invite-user', {
          body: {
            email: form.email.value.trim(),
            full_name: form.full_name.value.trim(),
            phone_whatsapp: form.phone_whatsapp.value.trim(),
            registration_type: form.registration_type.value.trim(),
            registration_number: form.registration_number.value.trim(),
            roles: selectedRoles,
            is_company: form.is_company.checked,
            company_trade_name: form.company_trade_name.value.trim(),
            cnpj: form.cnpj.value.trim(),
            company_responsible: form.company_responsible.value.trim(),
            redirect_to: window.location.origin + window.location.pathname,
          },
        });
        if (error) throw new Error(error.message);
        if (data?.error) throw new Error(data.error);
        toast('Convite enviado com sucesso.', 'success');
      } else {
        // Atualiza perfil + funções diretamente (RLS permite ao gestor).
        await supabase.from('profiles').update({
          full_name: form.full_name.value.trim(),
          phone_whatsapp: form.phone_whatsapp.value.trim(),
          registration_type: form.registration_type.value.trim(),
          registration_number: form.registration_number.value.trim(),
          is_company: form.is_company.checked,
          company_trade_name: form.company_trade_name.value.trim(),
          cnpj: form.cnpj.value.trim(),
          company_responsible: form.company_responsible.value.trim(),
        }).eq('id', user.id);
        await supabase.from('user_roles').delete().eq('user_id', user.id);
        await supabase.from('user_roles').insert(selectedRoles.map(role => ({ user_id: user.id, role })));
        toast('Usuário atualizado.', 'success');
      }
      close();
      renderUsers(body);
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      setLoading(false);
    }
  };
}

// =====================================================================
//  CRUD GENÉRICO (salas, equipamentos, acomodações, status)
// =====================================================================
async function simpleCrud(body, { table, title, columns, fields }) {
  setLoading(true);
  const { data } = await supabase.from(table).select('*').eq('surgical_center_id', center())
    .order(columns[0].key);
  setLoading(false);

  body.innerHTML = `
    <div class="section-head"><h2>${title}</h2>
      <button class="btn primary small" id="new-item">Adicionar</button></div>
    <table class="data-table">
      <thead><tr>${columns.map(c => `<th>${c.label}</th>`).join('')}<th></th></tr></thead>
      <tbody>
        ${(data ?? []).map((row) => `<tr>
          ${columns.map(c => `<td>${c.render ? c.render(row) : escapeHtml(row[c.key] ?? '')}</td>`).join('')}
          <td class="row-actions">
            <button class="btn-link" data-edit="${row.id}">Editar</button>
            <button class="btn-link danger" data-del="${row.id}">Excluir</button>
          </td></tr>`).join('')}
      </tbody>
    </table>`;

  const openForm = (row) => {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `<div class="modal small"><header class="modal-header">
      <h2>${row ? 'Editar' : 'Adicionar'} — ${title}</h2><button class="modal-close">&times;</button></header>
      <form class="modal-body" id="crud-form">
        ${fields.map(f => fieldHtml(f, row?.[f.name])).join('')}
        <footer class="modal-footer"><button type="button" class="btn ghost modal-cancel">Cancelar</button>
        <button class="btn primary" type="submit">Salvar</button></footer>
      </form></div>`;
    document.body.appendChild(modal);
    const close = () => modal.remove();
    modal.querySelector('.modal-close').onclick = close;
    modal.querySelector('.modal-cancel').onclick = close;
    modal.querySelector('#crud-form').onsubmit = async (e) => {
      e.preventDefault();
      const payload = { surgical_center_id: center() };
      fields.forEach((f) => {
        const el = e.target[f.name];
        payload[f.name] = f.type === 'checkbox' ? el.checked
          : f.type === 'number' ? Number(el.value)
          : el.value;
      });
      setLoading(true);
      try {
        if (row) await supabase.from(table).update(payload).eq('id', row.id);
        else await supabase.from(table).insert(payload);
        toast('Salvo.', 'success');
        close();
        simpleCrud(body, { table, title, columns, fields });
      } catch (ex) { toast('Erro: ' + ex.message, 'error'); }
      finally { setLoading(false); }
    };
  };

  body.querySelector('#new-item').onclick = () => openForm(null);
  body.querySelectorAll('[data-edit]').forEach((b) => {
    b.onclick = () => openForm((data ?? []).find(r => r.id === b.dataset.edit));
  });
  body.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Excluir este item?')) return;
      const { error } = await supabase.from(table).delete().eq('id', b.dataset.del);
      if (error) toast('Não foi possível excluir (pode estar em uso): ' + error.message, 'error');
      else { toast('Excluído.', 'success'); simpleCrud(body, { table, title, columns, fields }); }
    };
  });
}

function fieldHtml(f, value) {
  if (f.type === 'checkbox') {
    return `<label class="chk"><input type="checkbox" name="${f.name}" ${value ? 'checked' : ''}><span>${f.label}</span></label>`;
  }
  if (f.type === 'color') {
    return `<label class="field"><span>${f.label}</span><input type="color" name="${f.name}" value="${value ?? '#3b82f6'}"></label>`;
  }
  if (f.type === 'number') {
    return `<label class="field"><span>${f.label}</span><input type="number" name="${f.name}" value="${value ?? 0}"></label>`;
  }
  return `<label class="field"><span>${f.label}</span><input name="${f.name}" value="${escapeHtml(value ?? '')}" ${f.required ? 'required' : ''}></label>`;
}

const renderRooms = (body) => simpleCrud(body, {
  table: 'rooms', title: 'Salas cirúrgicas',
  columns: [{ key: 'name', label: 'Nome' }, { key: 'sort_order', label: 'Ordem' },
    { key: 'active', label: 'Ativa', render: r => r.active ? 'Sim' : 'Não' }],
  fields: [{ name: 'name', label: 'Nome', required: true }, { name: 'description', label: 'Descrição' },
    { name: 'sort_order', label: 'Ordem', type: 'number' }, { name: 'active', label: 'Ativa', type: 'checkbox' }],
});

const renderEquipment = (body) => simpleCrud(body, {
  table: 'equipment', title: 'Equipamentos',
  columns: [
    { key: 'name', label: 'Nome' },
    { key: 'block_simultaneous', label: 'Uso exclusivo', render: r => r.block_simultaneous ? '🔒 Sim' : '—' },
    { key: 'active', label: 'Ativo', render: r => r.active ? 'Sim' : 'Não' },
  ],
  fields: [
    { name: 'name', label: 'Nome', required: true },
    { name: 'description', label: 'Descrição' },
    { name: 'block_simultaneous', label: '🔒 Bloquear agendamentos simultâneos (uso exclusivo)', type: 'checkbox' },
    { name: 'active', label: 'Ativo', type: 'checkbox' },
  ],
});

const renderAccommodations = (body) => simpleCrud(body, {
  table: 'accommodation_types', title: 'Tipos de acomodação',
  columns: [{ key: 'name', label: 'Nome' }, { key: 'active', label: 'Ativo', render: r => r.active ? 'Sim' : 'Não' }],
  fields: [{ name: 'name', label: 'Nome', required: true }, { name: 'active', label: 'Ativo', type: 'checkbox' }],
});

const renderStatuses = (body) => simpleCrud(body, {
  table: 'appointment_statuses', title: 'Status dos agendamentos',
  columns: [{ key: 'name', label: 'Nome' },
    { key: 'color', label: 'Cor', render: r => `<span class="swatch" style="background:${escapeHtml(r.color)}"></span> ${escapeHtml(r.color)}` },
    { key: 'sort_order', label: 'Ordem' }, { key: 'is_default', label: 'Padrão', render: r => r.is_default ? 'Sim' : '' }],
  fields: [{ name: 'name', label: 'Nome', required: true }, { name: 'color', label: 'Cor', type: 'color' },
    { name: 'sort_order', label: 'Ordem', type: 'number' }, { name: 'is_default', label: 'Padrão', type: 'checkbox' },
    { name: 'active', label: 'Ativo', type: 'checkbox' }],
});

// =====================================================================
//  MATRIZ DE PERMISSÕES
// =====================================================================
async function renderPermissions(body) {
  setLoading(true);
  const { data } = await supabase.from('permission_matrix').select('*').eq('surgical_center_id', center());
  setLoading(false);
  const byRole = {};
  (data ?? []).forEach((r) => { byRole[r.role] = r; });
  const editableRoles = ALL_ROLES.filter(r => r !== 'gestor');

  const fieldOptions = [
    'procedure_name', 'appointment_date', 'start_time', 'end_time', 'room_id',
    'status_id', 'notes', 'equipment', 'professionals', 'files',
  ];

  body.innerHTML = `
    <div class="section-head"><h2>Matriz de permissões de edição</h2></div>
    <p class="hint">Defina, por função, o que cada usuário associado ao procedimento pode fazer. O gestor sempre tem acesso total.</p>
    <table class="data-table">
      <thead><tr><th>Função</th><th>Pode editar agendamento</th><th>Pode enviar arquivos</th><th>Pode excluir arquivos</th><th></th></tr></thead>
      <tbody>
        ${editableRoles.map((role) => {
          const r = byRole[role] ?? {};
          return `<tr>
            <td>${ROLE_LABELS[role]}</td>
            <td><input type="checkbox" data-role="${role}" data-field="can_edit_appointment" ${r.can_edit_appointment ? 'checked' : ''}></td>
            <td><input type="checkbox" data-role="${role}" data-field="can_upload_files" ${r.can_upload_files ? 'checked' : ''}></td>
            <td><input type="checkbox" data-role="${role}" data-field="can_delete_files" ${r.can_delete_files ? 'checked' : ''}></td>
            <td><button class="btn-link" data-save-role="${role}">Salvar</button></td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;

  body.querySelectorAll('[data-save-role]').forEach((btn) => {
    btn.onclick = async () => {
      const role = btn.dataset.saveRole;
      const payload = { surgical_center_id: center(), role };
      body.querySelectorAll(`[data-role="${role}"]`).forEach((chk) => {
        payload[chk.dataset.field] = chk.checked;
      });
      const { error } = await supabase.from('permission_matrix')
        .upsert(payload, { onConflict: 'surgical_center_id,role' });
      if (error) toast('Erro: ' + error.message, 'error');
      else toast('Permissões salvas.', 'success');
    };
  });
}

// =====================================================================
//  BLOQUEIOS DE SALA
// =====================================================================
async function renderBlocks(body) {
  setLoading(true);
  const [{ data: blocks }, { data: rooms }, { data: people }] = await Promise.all([
    supabase.from('room_blocks').select('*').eq('surgical_center_id', center()).order('block_date', { ascending: false }),
    supabase.from('rooms').select('*').eq('surgical_center_id', center()).order('sort_order'),
    supabase.from('profiles').select('id, full_name').eq('surgical_center_id', center()).eq('status', 'ativo').order('full_name'),
  ]);
  setLoading(false);

  const nameOf = (id) => (people ?? []).find(p => p.id === id)?.full_name ?? '';
  const open = hhmm(state.settings?.opening_time ?? '07:00');
  const close = hhmm(state.settings?.closing_time ?? '19:00');

  body.innerHTML = `
    <div class="section-head"><h2>Bloqueios de sala</h2>
      <button class="btn primary small" id="new-block">Novo bloqueio</button></div>
    <p class="hint">Bloqueie por hora (informe início/fim) ou o dia inteiro. Para reservar o horário a um profissional específico, escolha um usuário: só ele poderá agendar nesse período.</p>
    <form id="block-form" class="inline-form" style="display:none">
      <select name="room_id"><option value="">Todas as salas</option>${(rooms ?? []).map(r => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('')}</select>
      <input type="date" name="block_date" required>
      <label class="chk"><input type="checkbox" name="all_day"><span>Dia inteiro</span></label>
      <input type="time" name="start_time" value="${open}" required>
      <input type="time" name="end_time" value="${close}" required>
      <select name="reserved_user_id">
        <option value="">Bloqueio geral (todos)</option>
        ${(people ?? []).map(p => `<option value="${p.id}">Reservar para: ${escapeHtml(p.full_name)}</option>`).join('')}
      </select>
      <input name="reason" placeholder="Motivo">
      <button class="btn primary small" type="submit">Bloquear</button>
    </form>
    <table class="data-table">
      <thead><tr><th>Data</th><th>Sala</th><th>Horário</th><th>Direcionado a</th><th>Motivo</th><th></th></tr></thead>
      <tbody>
        ${(blocks ?? []).map((b) => `<tr>
          <td>${formatDateBR(b.block_date)}</td>
          <td>${b.room_id ? escapeHtml((rooms ?? []).find(r => r.id === b.room_id)?.name ?? '') : '<em>Todas</em>'}</td>
          <td>${hhmm(b.start_time)}–${hhmm(b.end_time)}</td>
          <td>${b.reserved_user_id ? `<span class="badge ok">${escapeHtml(nameOf(b.reserved_user_id))}</span>` : '<em>Geral</em>'}</td>
          <td>${escapeHtml(b.reason ?? '')}</td>
          <td><button class="btn-link danger" data-del="${b.id}">Remover</button></td>
        </tr>`).join('')}
      </tbody>
    </table>`;

  const form = body.querySelector('#block-form');
  body.querySelector('#new-block').onclick = () => { form.style.display = form.style.display === 'none' ? 'flex' : 'none'; };

  // "Dia inteiro" preenche e desabilita os campos de horário.
  form.all_day.onchange = () => {
    const on = form.all_day.checked;
    form.start_time.disabled = on;
    form.end_time.disabled = on;
    if (on) { form.start_time.value = open; form.end_time.value = close; }
  };

  form.onsubmit = async (e) => {
    e.preventDefault();
    const payload = {
      surgical_center_id: center(),
      room_id: form.room_id.value || null,
      block_date: form.block_date.value,
      start_time: form.all_day.checked ? open : form.start_time.value,
      end_time: form.all_day.checked ? close : form.end_time.value,
      reserved_user_id: form.reserved_user_id.value || null,
      reason: form.reason.value.trim(),
      created_by: state.profile.id,
    };
    const { error } = await supabase.from('room_blocks').insert(payload);
    if (error) toast('Erro: ' + error.message, 'error');
    else { toast(payload.reserved_user_id ? 'Horário reservado ao usuário.' : 'Sala bloqueada.', 'success'); renderBlocks(body); }
  };
  body.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Remover este bloqueio?')) return;
      await supabase.from('room_blocks').delete().eq('id', b.dataset.del);
      renderBlocks(body);
    };
  });
}

// =====================================================================
//  SOLICITAÇÕES DE DISPONIBILIDADE (fluxo confidencial)
// =====================================================================
async function renderAvailabilityRequests(body) {
  setLoading(true);
  const { data: reqs } = await supabase.from('availability_requests')
    .select('*').eq('surgical_center_id', center()).order('created_at', { ascending: false });
  const { data: resps } = await supabase.from('availability_responses').select('*');
  setLoading(false);

  const respByReq = {};
  (resps ?? []).forEach((r) => { (respByReq[r.request_id] ??= []).push(r); });

  body.innerHTML = `
    <div class="section-head"><h2>Solicitações de disponibilidade</h2>
      <button class="btn primary small" id="new-req">Nova solicitação</button></div>
    <form id="req-form" class="inline-form" style="display:none">
      <select name="target_role">
        ${['anestesiologista', 'pediatra', 'cirurgiao_auxiliar', 'auxiliar'].map(r => `<option value="${r}">${ROLE_LABELS[r]}</option>`).join('')}
      </select>
      <input type="date" name="request_date" required>
      <input type="time" name="start_time">
      <input type="time" name="end_time">
      <input name="message" placeholder="Mensagem (opcional, sem dados sensíveis)">
      <button class="btn primary small" type="submit">Enviar</button>
    </form>
    <div class="req-list">
      ${(reqs ?? []).map((rq) => `
        <div class="req-card">
          <div class="req-head">
            <strong>${ROLE_LABELS[rq.target_role] ?? rq.target_role}</strong>
            <span>${formatDateBR(rq.request_date)} ${rq.start_time ? `· ${hhmm(rq.start_time)}–${hhmm(rq.end_time)}` : ''}</span>
          </div>
          <p>${escapeHtml(rq.message ?? '')}</p>
          <div class="req-responses">
            <strong>Respostas:</strong>
            ${(respByReq[rq.id] ?? []).length
              ? (respByReq[rq.id]).map(r => `<span class="badge ${r.answer === 'disponivel' ? 'ok' : r.answer === 'indisponivel' ? 'off' : ''}">${r.answer}</span>`).join(' ')
              : '<em>Aguardando respostas.</em>'}
          </div>
        </div>`).join('') || '<p class="empty">Nenhuma solicitação.</p>'}
    </div>`;

  const form = body.querySelector('#req-form');
  body.querySelector('#new-req').onclick = () => { form.style.display = form.style.display === 'none' ? 'flex' : 'none'; };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const { error } = await supabase.from('availability_requests').insert({
      surgical_center_id: center(),
      target_role: form.target_role.value,
      request_date: form.request_date.value,
      start_time: form.start_time.value || null,
      end_time: form.end_time.value || null,
      message: form.message.value.trim(),
      created_by: state.profile.id,
    });
    if (error) toast('Erro: ' + error.message, 'error');
    else { toast('Solicitação enviada.', 'success'); renderAvailabilityRequests(body); }
  };
}

// =====================================================================
//  CONFIGURAÇÕES GERAIS
// =====================================================================
async function renderGeneral(body) {
  setLoading(true);
  const { data: s } = await supabase.from('center_settings').select('*').eq('surgical_center_id', center()).single();
  setLoading(false);

  body.innerHTML = `
    <div class="section-head"><h2>Configurações gerais</h2></div>
    <form id="gen-form" class="stack">
      <fieldset><legend>Agenda</legend>
        <div class="grid-3">
          <label class="field"><span>Intervalo da grade (min)</span>
            <select name="slot_minutes">
              ${[10, 15, 20, 30, 60].map(v => `<option value="${v}" ${s?.slot_minutes === v ? 'selected' : ''}>${v}</option>`).join('')}
            </select></label>
          <label class="field"><span>Abertura</span><input type="time" name="opening_time" value="${hhmm(s?.opening_time ?? '07:00')}"></label>
          <label class="field"><span>Fechamento</span><input type="time" name="closing_time" value="${hhmm(s?.closing_time ?? '19:00')}"></label>
        </div>
      </fieldset>
      <fieldset><legend>Autorização</legend>
        <label class="chk"><input type="checkbox" name="require_authorization" ${s?.require_authorization ? 'checked' : ''}><span>Senha de autorização obrigatória</span></label>
        <label class="chk"><input type="checkbox" name="allow_auth_not_applicable" ${s?.allow_auth_not_applicable ? 'checked' : ''}><span>Permitir "Não se aplica" (particular)</span></label>
      </fieldset>
      <fieldset><legend>WhatsApp</legend>
        <label class="chk"><input type="checkbox" name="whatsapp_enabled" ${s?.whatsapp_enabled ? 'checked' : ''}><span>Habilitar envio automático (Edge Function)</span></label>
        <label class="field"><span>Modelo de mensagem (neutra)</span>
          <textarea name="whatsapp_template" rows="3">${escapeHtml(s?.whatsapp_template ?? '')}</textarea>
          <small>Variáveis: {nome}, {data}, {hora_inicial}, {hora_final}. Nunca inclua dados sensíveis.</small>
        </label>
      </fieldset>
      <div class="form-error" id="gen-error"></div>
      <div><button class="btn primary" type="submit">Salvar configurações</button></div>
    </form>`;

  body.querySelector('#gen-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const payload = {
      surgical_center_id: center(),
      slot_minutes: Number(f.slot_minutes.value),
      opening_time: f.opening_time.value,
      closing_time: f.closing_time.value,
      require_authorization: f.require_authorization.checked,
      allow_auth_not_applicable: f.allow_auth_not_applicable.checked,
      whatsapp_enabled: f.whatsapp_enabled.checked,
      whatsapp_template: f.whatsapp_template.value.trim(),
    };
    const { error } = await supabase.from('center_settings')
      .upsert(payload, { onConflict: 'surgical_center_id' });
    if (error) { body.querySelector('#gen-error').textContent = error.message; return; }
    state.settings = { ...state.settings, ...payload };
    toast('Configurações salvas.', 'success');
  };
}
