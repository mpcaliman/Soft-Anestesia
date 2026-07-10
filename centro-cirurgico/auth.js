// =====================================================================
//  auth.js
//  Login, recuperação de senha, controle de sessão e carregamento do
//  perfil/permissões. Inclui proteção simples contra tentativas
//  excessivas de login no lado do cliente.
// =====================================================================

import { supabase, state, toast, setLoading } from './supabase-client.js';
import { CONFIG } from './config.js';

const LOCK_KEY = 'cc_login_lock';

// --- Rate limiting simples (client-side) -----------------------------
function getLockInfo() {
  try {
    return JSON.parse(localStorage.getItem(LOCK_KEY) || '{"attempts":0,"until":0}');
  } catch {
    return { attempts: 0, until: 0 };
  }
}
function setLockInfo(info) {
  localStorage.setItem(LOCK_KEY, JSON.stringify(info));
}
function registerFailedAttempt() {
  const info = getLockInfo();
  info.attempts = (info.attempts || 0) + 1;
  if (info.attempts >= CONFIG.LOGIN_MAX_ATTEMPTS) {
    info.until = Date.now() + CONFIG.LOGIN_LOCK_SECONDS * 1000;
    info.attempts = 0;
  }
  setLockInfo(info);
}
function clearAttempts() {
  setLockInfo({ attempts: 0, until: 0 });
}
function secondsLocked() {
  const info = getLockInfo();
  if (info.until && info.until > Date.now()) {
    return Math.ceil((info.until - Date.now()) / 1000);
  }
  return 0;
}

// --- Carregamento do perfil e permissões -----------------------------
export async function loadProfileAndPermissions() {
  const { data: sessionData } = await supabase.auth.getSession();
  state.session = sessionData?.session ?? null;
  if (!state.session) return false;

  const uid = state.session.user.id;

  const { data: profile, error: pErr } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', uid)
    .single();

  if (pErr || !profile) {
    // Sem perfil: usuário não provisionado corretamente.
    await supabase.auth.signOut();
    return false;
  }

  if (profile.status !== 'ativo') {
    await supabase.auth.signOut();
    toast('Usuário inativo. Contate o gestor do centro cirúrgico.', 'error', 8000);
    return false;
  }

  const { data: roles } = await supabase
    .from('user_roles')
    .select('role')
    .eq('user_id', uid);

  const { data: center } = await supabase
    .from('surgical_centers')
    .select('*')
    .eq('id', profile.surgical_center_id)
    .single();

  const { data: settings } = await supabase
    .from('center_settings')
    .select('*')
    .eq('surgical_center_id', profile.surgical_center_id)
    .single();

  state.profile = profile;
  state.roles = (roles ?? []).map((r) => r.role);
  state.center = center ?? null;
  state.settings = settings ?? null;
  state.isGestor = state.roles.includes('gestor');

  return true;
}

// --- Login -----------------------------------------------------------
export async function signIn(email, password) {
  const locked = secondsLocked();
  if (locked > 0) {
    throw new Error(`Muitas tentativas. Aguarde ${locked}s antes de tentar novamente.`);
  }

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    registerFailedAttempt();
    if (error.message?.toLowerCase().includes('invalid')) {
      throw new Error('E-mail ou senha inválidos.');
    }
    throw new Error(error.message);
  }

  clearAttempts();

  const ok = await loadProfileAndPermissions();
  if (!ok) {
    throw new Error('Não foi possível carregar seu perfil ou o acesso está bloqueado.');
  }
  return true;
}

// --- Recuperação de senha --------------------------------------------
export async function resetPassword(email) {
  const redirectTo = window.location.origin + window.location.pathname + '#recovery';
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
  if (error) throw new Error(error.message);
  return true;
}

// --- Definição de nova senha (após clicar no link do e-mail) ---------
export async function updatePassword(newPassword) {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw new Error(error.message);
  return true;
}

// --- Logout ----------------------------------------------------------
export async function signOut() {
  await supabase.auth.signOut();
  state.session = null;
  state.profile = null;
  state.roles = [];
  state.center = null;
  state.settings = null;
  state.isGestor = false;
}

// --- Renderização e ligação da tela de login -------------------------
export function bindLoginScreen(onLoginSuccess) {
  const form = document.getElementById('login-form');
  const emailEl = document.getElementById('login-email');
  const passEl = document.getElementById('login-password');
  const errEl = document.getElementById('login-error');
  const forgotBtn = document.getElementById('forgot-password');
  const appNameEl = document.getElementById('app-name');

  if (appNameEl) appNameEl.textContent = CONFIG.APP_NAME;

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.textContent = '';
    const email = emailEl.value.trim();
    const password = passEl.value;
    if (!email || !password) {
      errEl.textContent = 'Informe e-mail e senha.';
      return;
    }
    setLoading(true);
    try {
      await signIn(email, password);
      onLoginSuccess();
    } catch (err) {
      errEl.textContent = err.message;
    } finally {
      setLoading(false);
    }
  });

  forgotBtn?.addEventListener('click', async (e) => {
    e.preventDefault();
    errEl.textContent = '';
    const email = emailEl.value.trim();
    if (!email) {
      errEl.textContent = 'Digite seu e-mail para receber o link de recuperação.';
      return;
    }
    setLoading(true);
    try {
      await resetPassword(email);
      toast('Enviamos um link de recuperação para o seu e-mail.', 'success', 6000);
    } catch (err) {
      errEl.textContent = err.message;
    } finally {
      setLoading(false);
    }
  });
}

// --- Fluxo de redefinição de senha via link (#recovery) --------------
export function bindRecoveryFlow() {
  supabase.auth.onAuthStateChange(async (event) => {
    if (event === 'PASSWORD_RECOVERY') {
      const nova = prompt('Digite sua nova senha (mínimo 8 caracteres):');
      if (nova && nova.length >= 8) {
        try {
          await updatePassword(nova);
          toast('Senha atualizada com sucesso. Faça login novamente.', 'success', 6000);
        } catch (err) {
          toast('Erro ao atualizar senha: ' + err.message, 'error', 6000);
        }
      }
    }
  });
}
