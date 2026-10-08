'use strict';

/* ============================================================================
   CLIENTE REALTIME LEGADO — compatibilidade temporária, best-effort.
   O cliente obrigatório é `realtime`, em sync-runtime.js. Este segundo canal
   só permanece para instalações antigas que já tinham a preferência ligada;
   não define a política de sincronização nem aparece como opção na interface.
============================================================================ */
const cloudRealtime = {
  PREF_KEY: 'medsys.v7.realtime.on',
  _ws: null, _hb: null, _ref: 0, _tentativas: 0, _debounce: null, _contexto: null,
  ativo() { try { return localStorage.getItem(cloudRealtime.PREF_KEY) === '1'; } catch (e) { return false; } },
  _setStatus(txt, cor) { const el = document.getElementById('realtime-status'); if (el) { el.textContent = txt; el.style.color = cor || 'var(--text-mute)'; } },
  toggle(on) {
    try { localStorage.setItem(cloudRealtime.PREF_KEY, on ? '1' : '0'); } catch (e) {}
    if (on) cloudRealtime.conectar(); else { cloudRealtime.desconectar(); cloudRealtime._setStatus('— desligado', ''); }
  },
  _cfg() {
    const c = cloud.config(); if (!c) return null;
    const s = cloud.session();
    const m = (c.url || '').match(/^https:\/\/([^.]+)\.supabase\.co/);
    if (!m) return null;
    return { ref: m[1], anon: c.anonKey, token: s && s.access_token };
  },
  conectar() {
    try {
      if (!cloudRel.disponivel()) { cloudRealtime._setStatus('— contexto da clínica indisponível', ''); return; }
      if (typeof WebSocket === 'undefined') { cloudRealtime._setStatus('— indisponível', ''); return; }
      cloudRealtime.desconectar();
      const contexto = contextoAba.capturar();
      const cfg = cloudRealtime._cfg(); if (!cfg) { cloudRealtime._setStatus('— configuração inválida', ''); return; }
      const sessao = cloud.session();
      if (!contextoAba.corresponde(contexto) || !sessao || !sessao.user || sessao.user.id !== contexto.userId) return;
      const url = 'wss://' + cfg.ref + '.supabase.co/realtime/v1/websocket?apikey=' + encodeURIComponent(cfg.anon) + '&vsn=1.0.0';
      cloudRealtime._setStatus('⏳ conectando…', '');
      const ws = new WebSocket(url); cloudRealtime._ws = ws; cloudRealtime._contexto = contexto;
      ws.onopen = () => {
        if (!contextoAba.corresponde(contexto)) { cloudRealtime.desconectar(); return; }
        cloudRealtime._tentativas = 0;
        cloudRealtime._enviar({ topic: 'realtime:public', event: 'phx_join', ref: String(++cloudRealtime._ref),
          payload: { config: { postgres_changes: [{ event: '*', schema: 'public',
            filter: 'organization_id=eq.' + contexto.organizationId }] }, access_token: cfg.token } });
        clearInterval(cloudRealtime._hb);
        cloudRealtime._hb = setInterval(() => {
          if (!contextoAba.corresponde(contexto)) { cloudRealtime.desconectar(); return; }
          cloudRealtime._enviar({ topic: 'phoenix', event: 'heartbeat', ref: String(++cloudRealtime._ref), payload: {} });
        }, 25000);
        cloudRealtime._setStatus('🟢 tempo real ativo', 'var(--success,#16a34a)');
      };
      ws.onmessage = (ev) => { try { const msg = JSON.parse(ev.data); if (msg && msg.event === 'postgres_changes') cloudRealtime._onChange(msg, contexto); } catch (e) {} };
      ws.onerror = () => cloudRealtime._setStatus('🔴 erro de conexão', 'var(--danger,#b3392a)');
      ws.onclose = () => {
        clearInterval(cloudRealtime._hb);
        if (cloudRealtime.ativo() && contextoAba.corresponde(contexto)) {
          if (cloudRealtime._tentativas < 5) {
            cloudRealtime._tentativas++;
            cloudRealtime._setStatus('🔴 reconectando…', 'var(--danger,#b3392a)');
            setTimeout(() => { if (cloudRealtime.ativo()) cloudRealtime.conectar(); }, Math.min(30000, 2000 * Math.pow(2, cloudRealtime._tentativas)));
          } else cloudRealtime._setStatus('🔴 sem conexão (tempo real pausado)', 'var(--danger,#b3392a)');
        } else cloudRealtime._setStatus('— desligado', '');
      };
    } catch (e) { cloudRealtime._setStatus('🔴 falhou', 'var(--danger,#b3392a)'); }
  },
  _enviar(obj) { try { if (cloudRealtime._ws && cloudRealtime._ws.readyState === 1) cloudRealtime._ws.send(JSON.stringify(obj)); } catch (e) {} },
  desconectar() { try { clearInterval(cloudRealtime._hb); if (cloudRealtime._ws) { cloudRealtime._ws.onclose = null; cloudRealtime._ws.onmessage = null; cloudRealtime._ws.close(); } } catch (e) {} cloudRealtime._ws = null; cloudRealtime._contexto = null; },
  _onChange(msg, contexto) {
    if (!contextoAba.corresponde(contexto) || !contextoAba.corresponde(cloudRealtime._contexto)) return;
    const d = msg && msg.payload && msg.payload.data;
    const linha = d && (d.record || d.old_record);
    if (linha && String(linha.organization_id || '') !== String(contexto.organizationId || '')) return;
    /* ignora o eco das nossas próprias gravações recentes */
    try { if (cloudRel._ultimoEnvioTs && (Date.now() - cloudRel._ultimoEnvioTs) < 4000) return; } catch (e) {}
    clearTimeout(cloudRealtime._debounce);
    cloudRealtime._debounce = setTimeout(() => {
      try {
        const mod = (typeof state !== 'undefined') ? state.currentModule : null;
        if (mod && cloudRel.MODOS[mod]) { cloudRel._puxados[mod] = false; cloudRel.autoPullModulo(mod); }
        else if (mod === 'pacientes') { pacientes._puxouNestaSessao = false; pacientes.sincronizarNuvem({ silent: true }); }
        else if (mod === 'agenda') { agenda._puxouNestaSessao = false; agenda.sincronizarNuvem({ silent: true }); }
        toast('🔄 Dados atualizados na nuvem');
      } catch (e) {}
    }, 1500);
  },
  trocarContexto() {
    clearTimeout(cloudRealtime._debounce);
    cloudRealtime.desconectar();
    if (cloudRealtime.ativo() && contextoAba.operational()) setTimeout(() => cloudRealtime.conectar(), 80);
  },
  init() {
    if (!cloudRealtime.ativo()) return;
    const chk = document.getElementById('realtime-chk'); if (chk) chk.checked = true;
    setTimeout(() => { if (cloudRealtime.ativo()) cloudRealtime.conectar(); }, 2500);
  }
};

/* Uma troca controlada invalida sockets, caches de pull e operações em voo.
   Cada cliente reconecta usando uma nova captura; nunca reaproveita o destino
   anterior. */
contextoAba.aoMudar(() => {
  try { realtime.trocarContexto(); } catch (e) {}
  try { cloudRealtime.trocarContexto(); } catch (e) {}
  try { if (typeof pdfBackup !== 'undefined') pdfBackup.invalidarContexto(); } catch (e) {}
  try { if (typeof driveImport !== 'undefined') driveImport.invalidarContexto(); } catch (e) {}
  try {
    cloudRel._puxados = {}; cloudRel._cachePac = {}; cloudRel._cacheEnc = {}; cloudRel._conflito = null;
    if (typeof pacientes !== 'undefined') pacientes._conflito = null;
    if (typeof agenda !== 'undefined') agenda._conflito = null;
    if (typeof arquivo !== 'undefined') {
      arquivo._achados = null; arquivo._achadosContexto = null;
      arquivo._ownerKey = '';
      arquivo._garantirContexto();
    }
  } catch (e) {}
});

/* FIM DO REALTIME DE COMPATIBILIDADE */
