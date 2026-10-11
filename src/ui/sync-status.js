'use strict';

/* ============================================================================
   STATUS DE SINCRONIZAÇÃO HONESTO (Fase 2)
   O cabeçalho não mente mais: "Salvo" antes significava só localStorage,
   mesmo sem nada ter chegado à nuvem. Agora o selo mostra o estado REAL:
   Protegido offline → Sincronizando → Confirmado na nuvem, ou
   Pendente/Erro quando ainda não há recibo canônico.
============================================================================ */
const syncStatus = {
  _localTxt: 'Pronto',   // último rótulo transitório do formulário
  _cloud: 'idle',        // idle | syncing | synced | queued | offline | error | off
  _cloudAt: null,        // horário da última confirmação da nuvem
  _inflight: 0,          // pushes em andamento

  /* Chamado após uma ação do formulário. Não declara persistência: o recibo
     da nuvem ou o WAL cifrado é que decide o estado mostrado em seguida. */
  setLocal(txt) {
    this._localTxt = txt || 'Salvo';
    this._render();
  },
  _cloudDisponivel() {
    try { return cloud.estaConfigurado() && cloud.estaLogado(); } catch (e) { return false; }
  },
  cloudSyncing() { this._inflight++; this._cloud = 'syncing'; this._render(); },
  cloudDone(ok) {
    this._inflight = Math.max(0, this._inflight - 1);
    if (this._inflight === 0) {
      if (ok) { this._cloud = 'synced'; this._cloudAt = new Date(); }
      else    { this._cloud = (typeof navigator !== 'undefined' && navigator.onLine === false) ? 'offline' : 'queued'; }
    }
    this._render();
  },
  cloudState(s) { this._cloud = s; if (s === 'synced') this._cloudAt = new Date(); this._render(); },
  refresh() { this._render(); },

  _hhmm(d) { try { return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } },

  _render() {
    const el = document.getElementById('saved-text');
    const badge = document.getElementById('saved-badge');
    if (!el) return;
    let txt = this._localTxt, state = 'idle';
    const filaN = (() => {
      try {
        const cifradas = (typeof persistenciaCloudFirst !== 'undefined')
          ? persistenciaCloudFirst.pendentesConhecidos() : 0;
        return cloud._fila().length + cloudRel.filaPendentes() + cloudRel._filaDelLer().length + cifradas;
      } catch (e) { return 0; }
    })();
    const conflitosN = (() => { try { return cloudRel.conflitosPendentes(); } catch (e) { return 0; } })();

    if (!this._cloudDisponivel()) {
      txt = (this._localTxt && this._localTxt !== 'Pronto')
        ? this._localTxt + ' · nuvem indisponível'
        : 'Nuvem indisponível — nenhuma confirmação';
      state = 'local';
    } else if (conflitosN > 0) {
      txt = conflitosN + (conflitosN === 1 ? ' conflito preservado' : ' conflitos preservados'); state = 'error';
    } else if (this._cloud === 'syncing') {
      txt = 'Sincronizando…'; state = 'syncing';
    } else if (this._cloud === 'error') {
      txt = 'Erro ao sincronizar — confira a fila protegida'; state = 'error';
    } else if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      txt = 'Protegido offline · sem internet' + (filaN ? ' (' + filaN + ' na fila cifrada)' : ''); state = 'offline';
    } else if (filaN > 0 || this._cloud === 'queued') {
      txt = 'Fila cifrada · ' + (filaN || 1) + ' aguardando envio'; state = 'queued';
    } else if (this._cloud === 'synced') {
      txt = 'Sincronizado' + (this._cloudAt ? ' às ' + this._hhmm(this._cloudAt) : ''); state = 'synced';
    } else {
      /* nuvem disponível, nada pendente, ainda sem push nesta sessão */
      txt = this._localTxt || 'Pronto'; state = 'idle';
    }
    el.textContent = txt;
    if (badge) badge.setAttribute('data-state', state);
  }
};

function setSavedStatus(txt) {
  /* Mantém a compatibilidade com todos os chamadores, mas agora passa pelo
     controlador honesto: o texto é apenas o estado transitório da ação. */
  syncStatus.setLocal(txt);
}

/* FIM DO STATUS VISUAL DE SINCRONIZAÇÃO */
