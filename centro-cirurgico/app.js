// =====================================================================
//  app.js
//  Ponto de entrada da aplicação. Controla a inicialização, o roteamento
//  entre módulos e a montagem do menu conforme o perfil do usuário.
// =====================================================================

import { supabase, libLoaded, libLoadError, configIsValid, saveConfig, getConfig, state, escapeHtml, toast, setLoading, formatDateBR, hhmm } from './supabase-client.js';
import { CONFIG } from './config.js';
import { bindLoginScreen, bindRecoveryFlow, loadProfileAndPermissions, signOut } from './auth.js';
import { initCalendar, destroyCalendar } from './calendar.js';
import { openAppointmentModal, openAppointmentDetails, PROFESSIONAL_ROLES } from './appointments.js';
import { initNotifications, destroyNotifications, renderNotifications } from './notifications.js';
import { renderSettings } from './settings.js';

const els = {};
let currentModule = null;

// Como supabase-client.js usa top-level await (carregamento do CDN), a
// execução deste módulo pode terminar DEPOIS do DOMContentLoaded. Por isso,
// chamamos init() direto se o documento já estiver pronto.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

async function init() {
  els.login = document.getElementById('login-screen');
  els.app = document.getElementById('app-screen');
  els.content = document.getElementById('module-content');
  els.menu = document.getElementById('main-menu');
  els.userName = document.getElementById('current-user-name');
  els.centerName = document.getElementById('center-name');
  els.notifBadge = document.getElementById('notif-badge');

  // Biblioteca do Supabase não carregou (CDN fora do ar / sem internet).
  if (!libLoaded) {
    showLibError();
    return;
  }

  // Sem configuração do Supabase: mostra a tela para informar URL e chave.
  if (!configIsValid() || !supabase) {
    showConfigMissing();
    return;
  }

  bindRecoveryFlow();
  bindLoginScreen(showApp);

  // Tenta restaurar sessão existente.
  setLoading(true);
  try {
    const ok = await loadProfileAndPermissions();
    if (ok) showApp();
    else showLogin();
  } catch (e) {
    showLogin();
  } finally {
    setLoading(false);
  }

  // Reage a logout/expiração de sessão em outras abas.
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') showLogin();
  });
}

// Tela de erro quando a biblioteca do Supabase não pôde ser carregada.
function showLibError() {
  setLoading(false);
  if (els.login) els.login.style.display = 'none';
  if (els.app) els.app.style.display = 'none';
  const box = document.createElement('div');
  box.className = 'config-missing';
  box.innerHTML = `
    <div class="config-card">
      <div class="config-logo">⚠️</div>
      <h1>Falha ao carregar</h1>
      <p>Não foi possível carregar a biblioteca do sistema (Supabase) a partir
      da internet.</p>
      <p>Verifique sua conexão e recarregue a página. Se estiver em uma rede
      com restrições (hospital/empresa), tente outra rede ou dados móveis.</p>
      <p class="config-hint">Detalhe técnico: ${escapeHtml(String(libLoadError && libLoadError.message || 'CDN indisponível'))}</p>
      <button type="button" class="btn primary block" onclick="location.reload()">Recarregar</button>
    </div>`;
  document.body.appendChild(box);
}

// Tela de configuração: o usuário informa a URL e a chave anônima do
// Supabase diretamente no app (salvas no aparelho). Não precisa de rebuild.
function showConfigMissing() {
  setLoading(false);
  els.login.style.display = 'none';
  els.app.style.display = 'none';
  const cfg = getConfig();
  const box = document.createElement('div');
  box.className = 'config-missing';
  box.innerHTML = `
    <div class="config-card">
      <div class="config-logo">🏥</div>
      <h1>Conectar ao Supabase</h1>
      <p>Informe os dados do seu projeto Supabase para ativar o sistema.
      Você encontra em <strong>Supabase → Settings → API</strong>. Pode ser o
      mesmo projeto usado no app de anestesia.</p>
      <form id="config-form">
        <label class="field"><span>URL do projeto</span>
          <input name="url" placeholder="https://xxxxx.supabase.co" value="${escapeHtml(cfg.url)}" required></label>
        <label class="field"><span>Chave pública (anon / publishable)</span>
          <input name="key" placeholder="eyJhbGciOi... (ou sb_publishable_...)" value="${escapeHtml(cfg.key)}" required></label>
        <div class="form-error" id="config-error"></div>
        <button type="submit" class="btn primary block">Conectar</button>
      </form>
      <p class="config-hint">A chave anônima é pública por natureza e fica salva
      apenas neste aparelho. Nenhum segredo é exposto.</p>
    </div>`;
  document.body.appendChild(box);

  box.querySelector('#config-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const url = e.target.url.value.trim();
    const key = e.target.key.value.trim();
    const err = box.querySelector('#config-error');
    if (!url.startsWith('http')) { err.textContent = 'A URL deve começar com https://'; return; }
    if (key.length < 20) { err.textContent = 'A chave parece incompleta.'; return; }
    saveConfig(url, key);
    // Recarrega para reinicializar o cliente com a nova configuração.
    window.location.reload();
  });
}

function showLogin() {
  destroyCalendar();
  destroyNotifications();
  els.app.style.display = 'none';
  els.login.style.display = 'flex';
}

async function showApp() {
  els.login.style.display = 'none';
  els.app.style.display = 'flex';
  const centerName = state.center?.name ?? CONFIG.APP_NAME;
  els.userName.textContent = state.profile.full_name;
  els.centerName.textContent = centerName;
  // Reflete nome/usuário na barra lateral (sem MutationObserver).
  const sideName = document.getElementById('center-name-side');
  const sideUser = document.getElementById('sidebar-user');
  if (sideName) sideName.textContent = centerName;
  if (sideUser) sideUser.textContent = state.profile.full_name;

  buildMenu();
  await initNotifications(els.notifBadge);
  navigate('agenda');
}

// --- Menu principal ---------------------------------------------------
function buildMenu() {
  const items = [
    { key: 'agenda', label: 'Agenda', icon: '📅' },
    { key: 'novo', label: 'Novo agendamento', icon: '➕' },
    { key: 'meus', label: 'Meus procedimentos', icon: '📋' },
    { key: 'notificacoes', label: 'Notificações', icon: '🔔', badge: true },
    { key: 'disponibilidade', label: 'Minha disponibilidade', icon: '🗓️' },
  ];
  if (state.isGestor) items.push({ key: 'ajustes', label: 'Ajustes', icon: '⚙️' });
  items.push({ key: 'sair', label: 'Sair', icon: '🚪' });

  els.menu.innerHTML = items.map((i) => `
    <button class="menu-item" data-module="${i.key}">
      <span class="menu-icon">${i.icon}</span>
      <span class="menu-label">${i.label}</span>
      ${i.badge ? '<span id="notif-badge" class="badge-count" style="display:none"></span>' : ''}
    </button>`).join('');

  els.notifBadge = document.getElementById('notif-badge');

  els.menu.querySelectorAll('.menu-item').forEach((b) => {
    b.onclick = () => {
      if (b.dataset.module === 'sair') return doLogout();
      navigate(b.dataset.module);
    };
  });
}

async function doLogout() {
  await signOut();
  showLogin();
}

// --- Roteamento -------------------------------------------------------
async function navigate(moduleKey) {
  // Marca item ativo.
  els.menu.querySelectorAll('.menu-item').forEach((b) =>
    b.classList.toggle('active', b.dataset.module === moduleKey));

  // Fecha o menu no mobile.
  document.getElementById('app-screen')?.classList.remove('menu-open');

  // Limpa realtime da agenda ao sair dela.
  if (currentModule === 'agenda' && moduleKey !== 'agenda') destroyCalendar();
  currentModule = moduleKey;

  const c = els.content;
  c.innerHTML = '';

  if (moduleKey === 'agenda') {
    await initCalendar(c);
  } else if (moduleKey === 'novo') {
    openAppointmentModal({ onSaved: () => navigate('agenda') });
    // Mantém a agenda visível ao fundo.
    await initCalendar(c);
  } else if (moduleKey === 'meus') {
    await renderMyProcedures(c);
  } else if (moduleKey === 'notificacoes') {
    await renderNotifications(c);
  } else if (moduleKey === 'disponibilidade') {
    await renderMyAvailability(c);
  } else if (moduleKey === 'ajustes') {
    await renderSettings(c);
  }
}

// =====================================================================
//  MEUS PROCEDIMENTOS
//  A RLS já limita as linhas retornadas aos procedimentos associados
//  (para não-gestores). Para o gestor, mostra todos.
// =====================================================================
async function renderMyProcedures(container) {
  setLoading(true);

  // Agendamentos onde o usuário é criador ou cirurgião, ou está associado.
  const uid = state.profile.id;
  const { data: assoc } = await supabase
    .from('appointment_professionals').select('appointment_id').eq('user_id', uid);
  const assocIds = new Set((assoc ?? []).map(r => r.appointment_id));

  const { data: appts } = await supabase
    .from('appointments')
    .select('*')
    .order('appointment_date', { ascending: false })
    .order('start_time');

  setLoading(false);

  // Para não-gestor, a RLS já filtrou; ainda assim marcamos os "meus".
  const rows = (appts ?? []).filter(a =>
    state.isGestor ? true : (a.created_by === uid || a.surgeon_id === uid || assocIds.has(a.id)));

  container.innerHTML = `
    <div class="module-head"><h1>Meus procedimentos</h1>
      <button class="btn primary small" id="add-proc">Novo agendamento</button></div>
    ${rows.length ? `
    <table class="data-table">
      <thead><tr><th>Data</th><th>Horário</th><th>Paciente</th><th>Procedimento</th><th></th></tr></thead>
      <tbody>
        ${rows.map(a => `<tr data-appt="${a.id}">
          <td>${formatDateBR(a.appointment_date)}</td>
          <td>${hhmm(a.start_time)}–${hhmm(a.end_time)}</td>
          <td>${escapeHtml(a.patient_name)}</td>
          <td>${escapeHtml(a.procedure_name)}</td>
          <td><button class="btn-link" data-view="${a.id}">Detalhes</button></td>
        </tr>`).join('')}
      </tbody>
    </table>` : '<p class="empty">Nenhum procedimento associado ao seu usuário.</p>'}`;

  container.querySelector('#add-proc').onclick = () => openAppointmentModal({ onSaved: () => renderMyProcedures(container) });
  container.querySelectorAll('[data-view]').forEach((b) => {
    b.onclick = () => openAppointmentDetails(b.dataset.view, {
      onEdit: (id) => openAppointmentModal({ existingId: id, onSaved: () => renderMyProcedures(container) }),
    });
  });
}

// =====================================================================
//  MINHA DISPONIBILIDADE
//  Períodos de indisponibilidade + respostas a solicitações da função.
// =====================================================================
async function renderMyAvailability(container) {
  setLoading(true);
  const uid = state.profile.id;

  const { data: periods } = await supabase
    .from('unavailability').select('*').eq('user_id', uid)
    .order('start_datetime', { ascending: false });

  // Solicitações destinadas às funções do usuário.
  const { data: reqs } = await supabase
    .from('availability_requests').select('*')
    .in('target_role', state.roles.length ? state.roles : ['__none__'])
    .order('request_date', { ascending: false });

  const { data: myResps } = await supabase
    .from('availability_responses').select('*').eq('responder_id', uid);
  setLoading(false);

  const respByReq = {};
  (myResps ?? []).forEach((r) => { respByReq[r.request_id] = r; });

  container.innerHTML = `
    <div class="module-head"><h1>Minha disponibilidade</h1></div>

    <section class="panel">
      <h2>Informar indisponibilidade</h2>
      <form id="unavail-form" class="inline-form">
        <input type="datetime-local" name="start_datetime" required>
        <input type="datetime-local" name="end_datetime" required>
        <input name="reason" placeholder="Motivo (opcional)">
        <button class="btn primary small" type="submit">Adicionar</button>
      </form>
      <ul class="plain">
        ${(periods ?? []).map(p => `<li data-period="${p.id}">
          ${formatDateTime(p.start_datetime)} — ${formatDateTime(p.end_datetime)}
          ${p.reason ? `· ${escapeHtml(p.reason)}` : ''}
          <button class="btn-link danger" data-del-period="${p.id}">Remover</button>
        </li>`).join('') || '<li class="empty">Nenhum período informado.</li>'}
      </ul>
    </section>

    <section class="panel">
      <h2>Solicitações para responder</h2>
      <div class="req-list">
        ${(reqs ?? []).map(rq => {
          const mine = respByReq[rq.id];
          return `<div class="req-card">
            <div class="req-head"><strong>${formatDateBR(rq.request_date)}</strong>
              <span>${rq.start_time ? `${hhmm(rq.start_time)}–${hhmm(rq.end_time)}` : ''}</span></div>
            <p>${escapeHtml(rq.message ?? '')}</p>
            <div class="resp-actions" data-req="${rq.id}">
              <button class="btn small ${mine?.answer === 'disponivel' ? 'primary' : 'ghost'}" data-answer="disponivel">Disponível</button>
              <button class="btn small ${mine?.answer === 'indisponivel' ? 'primary' : 'ghost'}" data-answer="indisponivel">Indisponível</button>
              ${mine ? `<span class="badge ${mine.answer === 'disponivel' ? 'ok' : 'off'}">Respondido: ${mine.answer}</span>` : ''}
            </div>
          </div>`;
        }).join('') || '<p class="empty">Nenhuma solicitação para a sua função.</p>'}
      </div>
    </section>`;

  container.querySelector('#unavail-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const { error } = await supabase.from('unavailability').insert({
      surgical_center_id: state.profile.surgical_center_id,
      user_id: uid,
      start_datetime: new Date(f.start_datetime.value).toISOString(),
      end_datetime: new Date(f.end_datetime.value).toISOString(),
      reason: f.reason.value.trim() || null,
    });
    if (error) toast('Erro: ' + error.message, 'error');
    else { toast('Indisponibilidade registrada.', 'success'); renderMyAvailability(container); }
  };

  container.querySelectorAll('[data-del-period]').forEach((b) => {
    b.onclick = async () => {
      await supabase.from('unavailability').delete().eq('id', b.dataset.delPeriod);
      renderMyAvailability(container);
    };
  });

  container.querySelectorAll('.resp-actions').forEach((group) => {
    group.querySelectorAll('[data-answer]').forEach((btn) => {
      btn.onclick = async () => {
        const reqId = group.dataset.req;
        const { error } = await supabase.from('availability_responses').upsert({
          request_id: reqId,
          responder_id: uid,
          answer: btn.dataset.answer,
        }, { onConflict: 'request_id,responder_id' });
        if (error) toast('Erro: ' + error.message, 'error');
        else { toast('Resposta registrada.', 'success'); renderMyAvailability(container); }
      };
    });
  });
}

function formatDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const date = d.toLocaleDateString('pt-BR', { timeZone: CONFIG.TIME_ZONE });
  const time = d.toLocaleTimeString('pt-BR', { timeZone: CONFIG.TIME_ZONE, hour: '2-digit', minute: '2-digit' });
  return `${date} ${time}`;
}

// --- Menu móvel (hambúrguer) -----------------------------------------
document.addEventListener('click', (e) => {
  if (e.target.closest('#menu-toggle')) {
    document.getElementById('app-screen')?.classList.toggle('menu-open');
  }
});
