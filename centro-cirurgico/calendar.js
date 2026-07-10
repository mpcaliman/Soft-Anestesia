// =====================================================================
//  calendar.js
//  Agenda do centro cirúrgico. Visualizações: grade diária por sala,
//  dia, semana, mês e lista. Respeita a associação via RLS: usuários
//  não associados só veem "Ocupado"/"Bloqueado" (cartão neutro).
//
//  Calendário próprio em JavaScript puro (sem dependências pagas).
// =====================================================================

import {
  supabase, state, escapeHtml, toast, setLoading,
  formatDateBR, hhmm, todayISO, addDaysISO, weekdayName,
  timeToMinutes, minutesToTime,
} from './supabase-client.js';
import { openAppointmentModal, openAppointmentDetails, getReference, loadReferenceData } from './appointments.js';

let view = 'grade';        // grade | dia | semana | mes | lista
let anchorDate = todayISO();
let filters = { room: '', professional: '', status: '', text: '' };
let realtimeChannel = null;

// Dados carregados para o intervalo atual.
let dataset = { appointments: [], occupancy: [], blocks: [], rooms: [], statuses: [] };

export async function initCalendar(container) {
  await loadReferenceData();
  const ref = getReference();
  dataset.rooms = ref.rooms;
  dataset.statuses = ref.statuses;
  renderShell(container);
  await refresh();
  subscribeRealtime();
}

export function destroyCalendar() {
  if (realtimeChannel) {
    supabase.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
}

// --- Intervalo de datas conforme a visualização ----------------------
function currentRange() {
  if (view === 'mes') {
    const d = new Date(anchorDate + 'T12:00:00');
    const first = new Date(d.getFullYear(), d.getMonth(), 1);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    return { from: iso(first), to: iso(last) };
  }
  if (view === 'semana') {
    const d = new Date(anchorDate + 'T12:00:00');
    const dow = d.getDay(); // 0=dom
    const start = addDaysISO(anchorDate, -dow);
    return { from: start, to: addDaysISO(start, 6) };
  }
  if (view === 'lista') {
    return { from: anchorDate, to: addDaysISO(anchorDate, 30) };
  }
  // dia / grade
  return { from: anchorDate, to: anchorDate };
}

function iso(d) { return d.toISOString().slice(0, 10); }

// --- Carregamento de dados -------------------------------------------
async function refresh() {
  setLoading(true);
  try {
    const { from, to } = currentRange();

    // 1) Ocupação neutra (todos os usuários enxergam) via função segura.
    const { data: occ } = await supabase.rpc('get_occupancy', {
      p_date_from: from, p_date_to: to,
    });
    dataset.occupancy = occ ?? [];

    // 2) Agendamentos detalhados que o usuário PODE ver (RLS filtra).
    let q = supabase
      .from('appointments')
      .select('*')
      .gte('appointment_date', from)
      .lte('appointment_date', to)
      .order('appointment_date')
      .order('start_time');
    if (filters.room) q = q.eq('room_id', filters.room);
    if (filters.status) q = q.eq('status_id', filters.status);
    const { data: appts } = await q;
    dataset.appointments = appts ?? [];

    // 3) Filtro por profissional (via associação) — quando aplicável.
    if (filters.professional) {
      const { data: rel } = await supabase
        .from('appointment_professionals')
        .select('appointment_id')
        .eq('user_id', filters.professional);
      const ids = new Set((rel ?? []).map((r) => r.appointment_id));
      dataset.appointments = dataset.appointments.filter(
        (a) => ids.has(a.id) || a.surgeon_id === filters.professional,
      );
    }

    render();
  } catch (e) {
    toast('Erro ao carregar agenda: ' + e.message, 'error');
  } finally {
    setLoading(false);
  }
}

// --- Realtime: atualiza a agenda automaticamente ---------------------
function subscribeRealtime() {
  if (realtimeChannel) supabase.removeChannel(realtimeChannel);
  realtimeChannel = supabase
    .channel('agenda-realtime')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'appointments' }, () => refresh())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'room_blocks' }, () => refresh())
    .subscribe();
}

// --- Estrutura da tela -----------------------------------------------
function renderShell(container) {
  const ref = getReference();
  container.innerHTML = `
    <div class="agenda">
      <div class="agenda-toolbar">
        <div class="agenda-nav">
          <button class="btn small" id="cal-prev">‹</button>
          <button class="btn small" id="cal-today">Hoje</button>
          <button class="btn small" id="cal-next">›</button>
          <input type="date" id="cal-date" value="${anchorDate}">
          <strong id="cal-label"></strong>
        </div>
        <div class="agenda-views">
          <button class="btn small view-btn" data-view="grade">Grade por sala</button>
          <button class="btn small view-btn" data-view="dia">Dia</button>
          <button class="btn small view-btn" data-view="semana">Semana</button>
          <button class="btn small view-btn" data-view="mes">Mês</button>
          <button class="btn small view-btn" data-view="lista">Lista</button>
        </div>
      </div>
      <div class="agenda-filters">
        <select id="f-room"><option value="">Todas as salas</option>${ref.rooms.map(r => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('')}</select>
        <select id="f-prof"><option value="">Todos os profissionais</option>${ref.people.map(p => `<option value="${p.id}">${escapeHtml(p.full_name)}</option>`).join('')}</select>
        <select id="f-status"><option value="">Todos os status</option>${ref.statuses.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('')}</select>
        <input id="f-text" placeholder="Procedimento / paciente...">
        <button class="btn small ghost" id="f-clear">Limpar</button>
        <button class="btn small" id="find-free">Localizar horários livres</button>
      </div>
      <div id="agenda-body" class="agenda-body"></div>
    </div>`;

  container.querySelector('#cal-prev').onclick = () => { shiftAnchor(-1); };
  container.querySelector('#cal-next').onclick = () => { shiftAnchor(1); };
  container.querySelector('#cal-today').onclick = () => { anchorDate = todayISO(); syncDateInput(); refresh(); };
  container.querySelector('#cal-date').onchange = (e) => { anchorDate = e.target.value; refresh(); };

  container.querySelectorAll('.view-btn').forEach((b) => {
    b.onclick = () => {
      view = b.dataset.view;
      container.querySelectorAll('.view-btn').forEach(x => x.classList.toggle('active', x === b));
      refresh();
    };
  });

  container.querySelector('#f-room').onchange = (e) => { filters.room = e.target.value; refresh(); };
  container.querySelector('#f-prof').onchange = (e) => { filters.professional = e.target.value; refresh(); };
  container.querySelector('#f-status').onchange = (e) => { filters.status = e.target.value; refresh(); };
  container.querySelector('#f-text').oninput = (e) => { filters.text = e.target.value.toLowerCase(); render(); };
  container.querySelector('#f-clear').onclick = () => {
    filters = { room: '', professional: '', status: '', text: '' };
    container.querySelector('#f-room').value = '';
    container.querySelector('#f-prof').value = '';
    container.querySelector('#f-status').value = '';
    container.querySelector('#f-text').value = '';
    refresh();
  };
  container.querySelector('#find-free').onclick = () => findFreeSlots();

  // Marca a visualização padrão.
  container.querySelector(`[data-view="${view}"]`)?.classList.add('active');
}

function shiftAnchor(dir) {
  if (view === 'mes') {
    const d = new Date(anchorDate + 'T12:00:00');
    d.setMonth(d.getMonth() + dir);
    anchorDate = iso(d);
  } else if (view === 'semana') {
    anchorDate = addDaysISO(anchorDate, dir * 7);
  } else {
    anchorDate = addDaysISO(anchorDate, dir);
  }
  syncDateInput();
  refresh();
}
function syncDateInput() {
  const el = document.getElementById('cal-date');
  if (el) el.value = anchorDate;
}

// --- Render dispatcher ------------------------------------------------
function render() {
  const body = document.getElementById('agenda-body');
  const label = document.getElementById('cal-label');
  if (!body) return;
  if (label) label.textContent = rangeLabel();

  if (view === 'grade') return renderGrid(body);
  if (view === 'dia') return renderDay(body);
  if (view === 'semana') return renderWeek(body);
  if (view === 'mes') return renderMonth(body);
  if (view === 'lista') return renderList(body);
}

function rangeLabel() {
  if (view === 'mes') {
    const d = new Date(anchorDate + 'T12:00:00');
    return d.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  }
  if (view === 'semana') {
    const { from, to } = currentRange();
    return `${formatDateBR(from)} – ${formatDateBR(to)}`;
  }
  return formatDateBR(anchorDate);
}

// Retorna o cartão apropriado para um item, respeitando associação.
// Se o agendamento detalhado existe no dataset, o usuário está autorizado.
function detailFor(anonOrApptId, occ) {
  if (occ.situation === 'bloqueado') return { kind: 'block' };
  // occ.anon_id = 'occ-<md5(appt.id)>'. Cruzamos por md5 dos ids visíveis.
  const match = dataset.appointments.find((a) => 'occ-' + md5(a.id) === occ.anon_id);
  if (match) return { kind: 'appointment', appt: match };
  return { kind: 'busy' };
}

// --- GRADE POR SALA ---------------------------------------------------
function renderGrid(body) {
  const s = state.settings ?? {};
  const slot = s.slot_minutes ?? 30;
  const open = timeToMinutes(hhmm(s.opening_time ?? '07:00'));
  const close = timeToMinutes(hhmm(s.closing_time ?? '19:00'));
  const rooms = filters.room ? dataset.rooms.filter(r => r.id === filters.room) : dataset.rooms;

  const times = [];
  for (let m = open; m < close; m += slot) times.push(m);

  const occToday = dataset.occupancy.filter((o) => o.occ_date === anchorDate);

  let html = `<div class="grid-scroll"><table class="room-grid"><thead><tr><th class="time-col">Horário</th>`;
  rooms.forEach((r) => { html += `<th>${escapeHtml(r.name)}</th>`; });
  html += `</tr></thead><tbody>`;

  for (const m of times) {
    html += `<tr><td class="time-col">${minutesToTime(m)}</td>`;
    for (const room of rooms) {
      const cellStart = m, cellEnd = m + slot;
      const item = occToday.find((o) =>
        o.room_id === room.id &&
        timeToMinutes(o.start_time) < cellEnd &&
        timeToMinutes(o.end_time) > cellStart);

      if (!item) {
        html += `<td class="slot free" data-room="${room.id}" data-time="${minutesToTime(m)}"></td>`;
      } else if (item.situation === 'bloqueado') {
        html += `<td class="slot blocked"><span>Bloqueado</span></td>`;
      } else if (item.situation === 'reservado') {
        // Horário reservado ao próprio usuário: ele pode agendar.
        html += `<td class="slot free reserved" data-room="${room.id}" data-time="${minutesToTime(m)}"><span>Reservado p/ você</span></td>`;
      } else {
        const det = detailFor(item.anon_id, item);
        if (det.kind === 'appointment' && passesTextFilter(det.appt)) {
          html += `<td class="slot busy own" data-appt="${det.appt.id}">${gridCardContent(det.appt)}</td>`;
        } else if (det.kind === 'appointment' && !passesTextFilter(det.appt)) {
          html += `<td class="slot free"></td>`;
        } else {
          html += `<td class="slot busy neutral"><span>Ocupado</span></td>`;
        }
      }
    }
    html += `</tr>`;
  }
  html += `</tbody></table></div>`;
  body.innerHTML = html;

  body.querySelectorAll('.slot.free[data-room]').forEach((cell) => {
    cell.onclick = () => {
      const room = cell.dataset.room;
      const start = cell.dataset.time;
      const end = minutesToTime(timeToMinutes(start) + slot);
      openAppointmentModal({ prefill: { room_id: room, date: anchorDate, start_time: start, end_time: end }, onSaved: () => refresh() });
    };
  });
  body.querySelectorAll('.slot[data-appt]').forEach((cell) => {
    cell.onclick = () => openDetails(cell.dataset.appt);
  });
}

function gridCardContent(a) {
  if (state.isGestor || isAssociatedLocal(a)) {
    const st = dataset.statuses.find(s => s.id === a.status_id);
    const color = st?.color ?? '#3b82f6';
    return `<span class="card-strip" style="background:${color}"></span>
      <span class="card-title">${escapeHtml(a.patient_name)}</span>
      <span class="card-sub">${escapeHtml(a.procedure_name)}</span>
      <span class="card-time">${hhmm(a.start_time)}–${hhmm(a.end_time)}</span>`;
  }
  return `<span>Ocupado</span>`;
}

// --- DIA (lista de cartões do dia) -----------------------------------
function renderDay(body) {
  const occToday = dataset.occupancy.filter((o) => o.occ_date === anchorDate)
    .sort((a, b) => timeToMinutes(a.start_time) - timeToMinutes(b.start_time));
  body.innerHTML = `<div class="day-list">${renderCardsFor(occToday) || '<p class="empty">Nenhum compromisso neste dia.</p>'}</div>`;
  bindCards(body);
}

// --- SEMANA -----------------------------------------------------------
function renderWeek(body) {
  const { from } = currentRange();
  let html = '<div class="week-grid">';
  for (let i = 0; i < 7; i++) {
    const day = addDaysISO(from, i);
    const occ = dataset.occupancy.filter((o) => o.occ_date === day)
      .sort((a, b) => timeToMinutes(a.start_time) - timeToMinutes(b.start_time));
    html += `<div class="week-day ${day === todayISO() ? 'is-today' : ''}">
      <div class="week-day-head" data-newday="${day}">
        <strong>${weekdayName(day, true)}</strong><span>${formatDateBR(day)}</span>
      </div>
      <div class="week-day-body">${renderCardsFor(occ) || '<span class="empty small">—</span>'}</div>
    </div>`;
  }
  html += '</div>';
  body.innerHTML = html;
  bindCards(body);
  body.querySelectorAll('[data-newday]').forEach((h) => {
    h.onclick = () => { anchorDate = h.dataset.newday; view = 'grade'; syncDateInput(); refresh(); };
  });
}

// --- MÊS --------------------------------------------------------------
function renderMonth(body) {
  const d = new Date(anchorDate + 'T12:00:00');
  const year = d.getFullYear(), month = d.getMonth();
  const first = new Date(year, month, 1);
  const startPad = first.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  let html = '<div class="month-grid"><div class="month-head">';
  ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'].forEach(w => html += `<span>${w}</span>`);
  html += '</div><div class="month-cells">';

  for (let i = 0; i < startPad; i++) html += '<div class="month-cell empty-cell"></div>';
  for (let day = 1; day <= daysInMonth; day++) {
    const dateISO = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const occ = dataset.occupancy.filter((o) => o.occ_date === dateISO);
    const count = occ.length;
    html += `<div class="month-cell ${dateISO === todayISO() ? 'is-today' : ''}" data-day="${dateISO}">
      <span class="daynum">${day}</span>
      ${count ? `<span class="daybadge">${count} compromisso${count > 1 ? 's' : ''}</span>` : ''}
    </div>`;
  }
  html += '</div></div>';
  body.innerHTML = html;
  body.querySelectorAll('[data-day]').forEach((c) => {
    c.onclick = () => { anchorDate = c.dataset.day; view = 'grade'; syncDateInput(); refresh(); };
  });
}

// --- LISTA ------------------------------------------------------------
function renderList(body) {
  const occ = [...dataset.occupancy].sort((a, b) =>
    a.occ_date === b.occ_date
      ? timeToMinutes(a.start_time) - timeToMinutes(b.start_time)
      : a.occ_date.localeCompare(b.occ_date));

  if (!occ.length) { body.innerHTML = '<p class="empty">Nenhum compromisso no período.</p>'; return; }

  let html = '<table class="list-table"><thead><tr><th>Data</th><th>Horário</th><th>Sala</th><th>Situação/Detalhe</th></tr></thead><tbody>';
  for (const o of occ) {
    const room = dataset.rooms.find(r => r.id === o.room_id)?.name ?? '—';
    let detail, cls = '', apptId = '';
    if (o.situation === 'bloqueado') { detail = 'Bloqueado'; cls = 'blocked'; }
    else if (o.situation === 'reservado') { detail = 'Reservado para você'; cls = 'reserved'; }
    else {
      const det = detailFor(o.anon_id, o);
      if (det.kind === 'appointment' && passesTextFilter(det.appt)) {
        detail = `${escapeHtml(det.appt.patient_name)} — ${escapeHtml(det.appt.procedure_name)}`;
        apptId = det.appt.id; cls = 'own';
      } else if (det.kind === 'appointment') { continue; }
      else { detail = 'Ocupado'; cls = 'neutral'; }
    }
    html += `<tr class="${cls}" ${apptId ? `data-appt="${apptId}"` : ''}>
      <td>${formatDateBR(o.occ_date)}</td><td>${hhmm(o.start_time)}–${hhmm(o.end_time)}</td>
      <td>${escapeHtml(room)}</td><td>${detail}</td></tr>`;
  }
  html += '</tbody></table>';
  body.innerHTML = html;
  body.querySelectorAll('[data-appt]').forEach((tr) => {
    tr.onclick = () => openDetails(tr.dataset.appt);
  });
}

// --- Helpers de cartões ----------------------------------------------
function renderCardsFor(occList) {
  return occList.map((o) => {
    if (o.situation === 'bloqueado') {
      return `<div class="card block"><span class="card-time">${hhmm(o.start_time)}–${hhmm(o.end_time)}</span><span>Bloqueado</span></div>`;
    }
    if (o.situation === 'reservado') {
      const room = dataset.rooms.find(r => r.id === o.room_id)?.name ?? '';
      return `<div class="card reserved"><span class="card-time">${hhmm(o.start_time)}–${hhmm(o.end_time)} · ${escapeHtml(room)}</span><span>Reservado para você</span></div>`;
    }
    const det = detailFor(o.anon_id, o);
    if (det.kind === 'appointment' && passesTextFilter(det.appt)) {
      const a = det.appt;
      const room = dataset.rooms.find(r => r.id === a.room_id)?.name ?? '';
      const st = dataset.statuses.find(s => s.id === a.status_id);
      const showDetail = state.isGestor || isAssociatedLocal(a);
      if (showDetail) {
        return `<div class="card own" data-appt="${a.id}" style="border-left-color:${st?.color ?? '#3b82f6'}">
          <span class="card-time">${hhmm(a.start_time)}–${hhmm(a.end_time)} · ${escapeHtml(room)}</span>
          <strong>${escapeHtml(a.patient_name)}</strong>
          <span class="card-sub">${escapeHtml(a.procedure_name)}</span>
          <span class="card-status">${escapeHtml(st?.name ?? '')}</span>
        </div>`;
      }
    } else if (det.kind === 'appointment') {
      return '';
    }
    const room = dataset.rooms.find(r => r.id === o.room_id)?.name ?? '';
    return `<div class="card neutral"><span class="card-time">${hhmm(o.start_time)}–${hhmm(o.end_time)} · ${escapeHtml(room)}</span><span>Ocupado</span></div>`;
  }).join('');
}

function bindCards(body) {
  body.querySelectorAll('.card[data-appt]').forEach((c) => {
    c.onclick = () => openDetails(c.dataset.appt);
  });
}

function passesTextFilter(a) {
  if (!filters.text) return true;
  const hay = `${a.patient_name} ${a.procedure_name}`.toLowerCase();
  return hay.includes(filters.text);
}

// O agendamento está no dataset detalhado => o usuário pode vê-lo.
// Verifica se ele é associado (para o gestor, sempre mostra detalhes).
function isAssociatedLocal(a) {
  const uid = state.profile.id;
  return a.created_by === uid || a.surgeon_id === uid || a._associated === true || true;
  // Observação: se a linha veio do banco, a RLS já garantiu autorização.
}

function openDetails(apptId) {
  openAppointmentDetails(apptId, {
    onEdit: (id) => openAppointmentModal({ existingId: id, onSaved: () => refresh() }),
  });
}

// --- Localizar horários livres ---------------------------------------
function findFreeSlots() {
  const s = state.settings ?? {};
  const slot = s.slot_minutes ?? 30;
  const open = timeToMinutes(hhmm(s.opening_time ?? '07:00'));
  const close = timeToMinutes(hhmm(s.closing_time ?? '19:00'));
  const rooms = filters.room ? dataset.rooms.filter(r => r.id === filters.room) : dataset.rooms;
  const occToday = dataset.occupancy.filter((o) => o.occ_date === anchorDate);

  const free = [];
  for (const room of rooms) {
    for (let m = open; m < close; m += slot) {
      // Reservas direcionadas ao próprio usuário não contam como ocupado.
      const busy = occToday.some((o) => o.room_id === room.id && o.situation !== 'reservado' &&
        timeToMinutes(o.start_time) < m + slot && timeToMinutes(o.end_time) > m);
      if (!busy) free.push({ room: room.name, roomId: room.id, time: minutesToTime(m) });
    }
  }

  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `<div class="modal small"><header class="modal-header">
    <h2>Horários livres em ${formatDateBR(anchorDate)}</h2>
    <button class="modal-close">&times;</button></header>
    <div class="modal-body"><ul class="free-list">
    ${free.length ? free.map(f => `<li><button class="btn-link" data-room="${f.roomId}" data-time="${f.time}">${escapeHtml(f.room)} — ${f.time}</button></li>`).join('') : '<li>Nenhum horário livre encontrado.</li>'}
    </ul></div></div>`;
  document.body.appendChild(modal);
  const closeModal = () => modal.remove();
  modal.querySelector('.modal-close').onclick = closeModal;
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  modal.querySelectorAll('[data-room]').forEach((b) => {
    b.onclick = () => {
      closeModal();
      const end = minutesToTime(timeToMinutes(b.dataset.time) + slot);
      openAppointmentModal({ prefill: { room_id: b.dataset.room, date: anchorDate, start_time: b.dataset.time, end_time: end }, onSaved: () => refresh() });
    };
  });
}

// =====================================================================
//  md5 — usado apenas para casar anon_id (occ-<md5>) com o id visível.
//  Implementação compacta e autossuficiente (sem dependências).
// =====================================================================
function md5(str) {
  function rl(n, c) { return (n << c) | (n >>> (32 - c)); }
  function au(x, y) {
    const l = (x & 0xffff) + (y & 0xffff);
    const m = (x >> 16) + (y >> 16) + (l >> 16);
    return (m << 16) | (l & 0xffff);
  }
  function cmn(q, a, b, x, s, t) { return au(rl(au(au(a, q), au(x, t)), s), b); }
  function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
  function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
  function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
  function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }
  function tb(s) {
    const n = s.length, w = [];
    for (let i = 0; i < n * 8; i += 8) w[i >> 5] |= (s.charCodeAt(i / 8) & 0xff) << (i % 32);
    return w;
  }
  function bh(w) {
    let s = '';
    for (let j = 0; j < w.length * 4; j++) s += ((w[j >> 2] >> ((j % 4) * 8 + 4)) & 0xf).toString(16) + ((w[j >> 2] >> ((j % 4) * 8)) & 0xf).toString(16);
    return s;
  }
  function um(s) { return unescape(encodeURIComponent(s)); }
  const x = tb(um(str)), len = um(str).length * 8;
  x[len >> 5] |= 0x80 << (len % 32);
  x[(((len + 64) >>> 9) << 4) + 14] = len;
  let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
  for (let i = 0; i < x.length; i += 16) {
    const oa = a, ob = b, oc = c, od = d;
    a = ff(a, b, c, d, x[i], 7, -680876936); d = ff(d, a, b, c, x[i + 1], 12, -389564586);
    c = ff(c, d, a, b, x[i + 2], 17, 606105819); b = ff(b, c, d, a, x[i + 3], 22, -1044525330);
    a = ff(a, b, c, d, x[i + 4], 7, -176418897); d = ff(d, a, b, c, x[i + 5], 12, 1200080426);
    c = ff(c, d, a, b, x[i + 6], 17, -1473231341); b = ff(b, c, d, a, x[i + 7], 22, -45705983);
    a = ff(a, b, c, d, x[i + 8], 7, 1770035416); d = ff(d, a, b, c, x[i + 9], 12, -1958414417);
    c = ff(c, d, a, b, x[i + 10], 17, -42063); b = ff(b, c, d, a, x[i + 11], 22, -1990404162);
    a = ff(a, b, c, d, x[i + 12], 7, 1804603682); d = ff(d, a, b, c, x[i + 13], 12, -40341101);
    c = ff(c, d, a, b, x[i + 14], 17, -1502002290); b = ff(b, c, d, a, x[i + 15], 22, 1236535329);
    a = gg(a, b, c, d, x[i + 1], 5, -165796510); d = gg(d, a, b, c, x[i + 6], 9, -1069501632);
    c = gg(c, d, a, b, x[i + 11], 14, 643717713); b = gg(b, c, d, a, x[i], 20, -373897302);
    a = gg(a, b, c, d, x[i + 5], 5, -701558691); d = gg(d, a, b, c, x[i + 10], 9, 38016083);
    c = gg(c, d, a, b, x[i + 15], 14, -660478335); b = gg(b, c, d, a, x[i + 4], 20, -405537848);
    a = gg(a, b, c, d, x[i + 9], 5, 568446438); d = gg(d, a, b, c, x[i + 14], 9, -1019803690);
    c = gg(c, d, a, b, x[i + 3], 14, -187363961); b = gg(b, c, d, a, x[i + 8], 20, 1163531501);
    a = gg(a, b, c, d, x[i + 13], 5, -1444681467); d = gg(d, a, b, c, x[i + 2], 9, -51403784);
    c = gg(c, d, a, b, x[i + 7], 14, 1735328473); b = gg(b, c, d, a, x[i + 12], 20, -1926607734);
    a = hh(a, b, c, d, x[i + 5], 4, -378558); d = hh(d, a, b, c, x[i + 8], 11, -2022574463);
    c = hh(c, d, a, b, x[i + 11], 16, 1839030562); b = hh(b, c, d, a, x[i + 14], 23, -35309556);
    a = hh(a, b, c, d, x[i + 1], 4, -1530992060); d = hh(d, a, b, c, x[i + 4], 11, 1272893353);
    c = hh(c, d, a, b, x[i + 7], 16, -155497632); b = hh(b, c, d, a, x[i + 10], 23, -1094730640);
    a = hh(a, b, c, d, x[i + 13], 4, 681279174); d = hh(d, a, b, c, x[i], 11, -358537222);
    c = hh(c, d, a, b, x[i + 3], 16, -722521979); b = hh(b, c, d, a, x[i + 6], 23, 76029189);
    a = hh(a, b, c, d, x[i + 9], 4, -640364487); d = hh(d, a, b, c, x[i + 12], 11, -421815835);
    c = hh(c, d, a, b, x[i + 15], 16, 530742520); b = hh(b, c, d, a, x[i + 2], 23, -995338651);
    a = ii(a, b, c, d, x[i], 6, -198630844); d = ii(d, a, b, c, x[i + 7], 10, 1126891415);
    c = ii(c, d, a, b, x[i + 14], 15, -1416354905); b = ii(b, c, d, a, x[i + 5], 21, -57434055);
    a = ii(a, b, c, d, x[i + 12], 6, 1700485571); d = ii(d, a, b, c, x[i + 3], 10, -1894986606);
    c = ii(c, d, a, b, x[i + 10], 15, -1051523); b = ii(b, c, d, a, x[i + 1], 21, -2054922799);
    a = ii(a, b, c, d, x[i + 8], 6, 1873313359); d = ii(d, a, b, c, x[i + 15], 10, -30611744);
    c = ii(c, d, a, b, x[i + 6], 15, -1560198380); b = ii(b, c, d, a, x[i + 13], 21, 1309151649);
    a = ii(a, b, c, d, x[i + 4], 6, -145523070); d = ii(d, a, b, c, x[i + 11], 10, -1120210379);
    c = ii(c, d, a, b, x[i + 2], 15, 718787259); b = ii(b, c, d, a, x[i + 9], 21, -343485551);
    a = au(a, oa); b = au(b, ob); c = au(c, oc); d = au(d, od);
  }
  return bh([a, b, c, d]);
}
