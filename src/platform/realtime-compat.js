'use strict';

/* ============================================================================
   CLIENTE REALTIME LEGADO — compatibilidade temporária, best-effort.
   O cliente obrigatório é `realtime`, em sync-runtime.js. Este segundo canal
   só permanece para instalações antigas que já tinham a preferência ligada;
   não define a política de sincronização nem aparece como opção na interface.
============================================================================ */
const cloudRealtime = {
  PREF_KEY: 'medsys.v7.realtime.on',
  /* Chamadores antigos conservam a API, mas já não abrem outro transporte
     nem podem desligar a sincronização obrigatória. Um único cliente mantém
     filtros, revisão e JWT por canal, inclusive após expiração da sessão. */
  ativo() { return realtime.ativo(); },
  conectar() { return realtime.conectar(); },
  desconectar() { realtime._encerrar(true); },
  toggle() {
    try { localStorage.removeItem(cloudRealtime.PREF_KEY); } catch (e) {}
    return realtime.conectar();
  },
  trocarContexto() { /* O cliente obrigatório já recebe contextoAba.aoMudar. */ },
  init() {
    try { localStorage.removeItem(cloudRealtime.PREF_KEY); } catch (e) {}
    realtime.vigiar();
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
    cloudRel._limparConflitosMemoria();
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
