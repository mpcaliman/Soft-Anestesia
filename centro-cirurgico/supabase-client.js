// =====================================================================
//  supabase-client.js
//  Inicializa o cliente Supabase (apenas com a chave anônima pública)
//  e expõe utilitários compartilhados por toda a aplicação.
// =====================================================================

import { CONFIG } from './config.js';

// A biblioteca supabase-js é carregada por uma tag <script> (UMD) no
// index.html, que expõe window.supabase. Esse método é muito mais robusto
// do que importar de um CDN em ESM (que às vezes travava e deixava a
// página em branco). Aqui apenas lemos o global já disponível.
const _lib = (typeof window !== 'undefined' && window.supabase) ? window.supabase : null;
const createClient = _lib ? _lib.createClient : null;

// Indica se a biblioteca foi carregada (para a aplicação avisar em caso de falha).
export const libLoaded = !!createClient;
export const libLoadError = _lib
  ? null
  : new Error('Não foi possível carregar a biblioteca do sistema (supabase-js).');

// A configuração do Supabase pode vir de duas fontes, nesta ordem:
//   1) valores digitados pelo usuário na própria tela (salvos no aparelho);
//   2) config.js (gerado no build a partir de Variables), como padrão.
// Assim o app funciona em qualquer hospedagem, sem depender de rebuild.
const LS_URL = 'cc.supabase_url';
const LS_KEY = 'cc.supabase_key';

export function getConfig() {
  let url = '';
  let key = '';
  try {
    url = localStorage.getItem(LS_URL) || '';
    key = localStorage.getItem(LS_KEY) || '';
  } catch (e) { /* localStorage indisponível */ }
  if (!url) url = CONFIG.SUPABASE_URL || '';
  if (!key) key = CONFIG.SUPABASE_ANON_KEY || '';
  return { url: url.trim(), key: key.trim() };
}

// Salva a configuração no aparelho (chave anônima é pública, seguro).
export function saveConfig(url, key) {
  try {
    localStorage.setItem(LS_URL, (url || '').trim());
    localStorage.setItem(LS_KEY, (key || '').trim());
  } catch (e) { /* ignora */ }
}

export function clearConfig() {
  try { localStorage.removeItem(LS_URL); localStorage.removeItem(LS_KEY); } catch (e) {}
}

// Verifica se a configuração do Supabase é válida (evita quebrar ao carregar).
export function configIsValid() {
  const { url, key } = getConfig();
  return (
    url.startsWith('http') &&
    !url.includes('SEU-PROJETO') &&
    key.length > 20 &&
    !key.includes('SUA_CHAVE')
  );
}

// Cliente único e compartilhado (null se a configuração/biblioteca faltarem).
const _cfg = getConfig();
export const supabase = (configIsValid() && createClient)
  ? createClient(_cfg.url, _cfg.key, {
      auth: {
        persistSession: true,       // mantém a sessão conectada de forma segura
        autoRefreshToken: true,
        detectSessionInUrl: true,   // necessário para recuperação de senha
      },
    })
  : null;

// --- Estado global leve da aplicação ---------------------------------
export const state = {
  session: null,
  profile: null,       // linha de public.profiles do usuário atual
  roles: [],           // lista de funções (user_role) do usuário
  center: null,        // centro cirúrgico do usuário
  settings: null,      // center_settings
  isGestor: false,
};

// --- Utilitários de data/hora (fuso America/Bahia) -------------------

// Formata uma data ISO (yyyy-mm-dd) para dd/mm/aaaa.
export function formatDateBR(isoDate) {
  if (!isoDate) return '';
  const [y, m, d] = String(isoDate).slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

// Converte dd/mm/aaaa para yyyy-mm-dd.
export function parseDateBR(br) {
  if (!br) return '';
  const [d, m, y] = br.split('/');
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Retorna HH:MM a partir de "HH:MM:SS" ou "HH:MM".
export function hhmm(t) {
  if (!t) return '';
  return String(t).slice(0, 5);
}

// Data de hoje em yyyy-mm-dd considerando o fuso configurado.
export function todayISO() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: CONFIG.TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(new Date()); // en-CA -> yyyy-mm-dd
}

// Adiciona dias a uma data ISO e devolve ISO.
export function addDaysISO(isoDate, days) {
  const d = new Date(isoDate + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// Nome do dia da semana em pt-BR (0=domingo).
export function weekdayName(isoDate, short = false) {
  const d = new Date(isoDate + 'T12:00:00');
  return d.toLocaleDateString('pt-BR', { weekday: short ? 'short' : 'long' });
}

// Converte "HH:MM" para minutos desde 00:00.
export function timeToMinutes(t) {
  const [h, m] = hhmm(t).split(':').map(Number);
  return h * 60 + m;
}

// Converte minutos desde 00:00 para "HH:MM".
export function minutesToTime(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// --- Utilitários de UI -----------------------------------------------

// Escapa texto para inserção segura no HTML (evita XSS ao renderizar
// dados vindos do banco).
export function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// Exibe uma notificação "toast" temporária.
export function toast(message, type = 'info', ms = 4000) {
  let host = document.getElementById('toast-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toast-host';
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => el.classList.add('toast--show'), 10);
  setTimeout(() => {
    el.classList.remove('toast--show');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

// Abre/fecha o overlay de carregamento.
export function setLoading(on) {
  const el = document.getElementById('loading-overlay');
  if (el) el.style.display = on ? 'flex' : 'none';
}
