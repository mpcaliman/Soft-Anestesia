'use strict';

/* ============================================================================
   ESTADO DA NUVEM — a resposta a "está tudo salvo?" numa linha só, no topo
   dos Ajustes, mais um botão que força a atualização completa.
============================================================================ */
/* ============================================================================
   SINCRONIA AUTOMÁTICA — o sistema se acerta sozinho.

   Enquanto sincronizar dependeu de alguém tocar em "Atualizar tudo", o fluxo
   dependia da disciplina de quem está atendendo paciente. Não é trabalho de
   operador ficar apertando botão para o app funcionar: se o registro existe na
   clínica, ele tem que aparecer aqui sem pedido.

   O ciclo roda enquanto o app está em uso, e também quando a tela volta a ser
   olhada, quando a internet volta e logo depois de cada gravação. A leitura é
   INCREMENTAL (só o que mudou desde a última passada), então custa quase nada
   repetir de minuto em minuto. Falhou? A próxima tentativa espera um pouco
   mais, até dez minutos, e volta ao normal assim que der certo.
============================================================================ */
/* ============================================================================
   ETAPA 5 — REALTIME: a clínica avisa, em vez de o aparelho perguntar

   Até aqui a atualização era por relógio: de dez em dez minutos, ou ao voltar
   para a aba. Funciona, mas o que a secretária lança pode levar minutos para
   aparecer no computador do médico — e no dia da cirurgia esses minutos são a
   diferença entre conferir antes e conferir depois.

   O Postgres já publica as mudanças (migração 0002). Falta o aparelho ouvir.
   Isto é um cliente Phoenix Channels enxuto — o protocolo do Realtime do
   Supabase — sem biblioteca: o app inteiro é um arquivo e não vale trazer o
   supabase-js para escutar sete tabelas.

   O QUE ISTO NÃO É: substituto da sincronização por ciclo. WebSocket cai, o
   navegador dorme a aba, a rede do hospital corta. O ciclo continua rodando
   como rede de segurança — só que mais espaçado quando o Realtime está de pé,
   porque aí ele é redundância, não a via principal.
============================================================================ */
const realtime = {
  /* Uma tabela por módulo. As que a migração 0002 ainda não publica entram na
     0015; enquanto isso, o canal conecta e simplesmente não recebe nada —
     nunca quebra, no máximo não acelera. */
  TABELAS: {
    /* A agenda entra aqui: um compromisso marcado na secretaria tem de
       aparecer na tela do médico na hora, não no próximo ciclo. A tabela já
       está publicada no Realtime desde a 0002 — faltava escutá-la. */
    appointments: 'agenda',
    patients: 'pacientes',
    preanesthetic_assessments: 'pre',
    anesthesia_records: 'anestesia',
    recovery_records: 'recuperacao',
    consultations: 'consulta',
    finance_entries: 'financeiro',
    cash_closings: 'fin_fechamentos',
    risk_assessments: 'risco',
    consents: 'termo',
    prescriptions: 'prescricao',
    documents: 'documentos',
    quotes: 'orcamento',
    addenda: '__addenda__',
    drafts: '__drafts__',
    sync_conflicts: '__conflicts__'
  },
  HEARTBEAT: 25000,
  ESPERAS: [2000, 5000, 15000, 30000, 60000],

  _ws: null, _ref: 0, _hb: null, _timer: null, _tentativa: 0, _ligado: false,
  _org: null, _contexto: null, _recebidos: 0, _ultimoEvento: 0,

  ativo() { return !!(realtime._ws && realtime._ws.readyState === 1 && realtime._ligado); },
  _proxRef() { return String(++realtime._ref); },
  _setStatus(txt, cor) {
    try {
      const el = document.getElementById('realtime-primary-status');
      if (el) { el.textContent = txt; el.style.color = cor || 'var(--text-mute)'; }
    } catch (e) {}
  },

  async conectar() {
    if (realtime._ws) {
      if (contextoAba.corresponde(realtime._contexto)) return;
      realtime._encerrar(true);
    }
    try {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        realtime._setStatus('offline — reconecta automaticamente', '#7a4b12');
        return;
      }
      if (typeof cloudRel === 'undefined' || !cloudRel.disponivel()) {
        realtime._setStatus('aguardando conta e clínica', 'var(--text-mute)');
        return;
      }
      const contexto = contextoAba.capturar();
      if (!contextoAba.operational()) return;
      if (!(await cloud._garantirToken())) return;
      if (!contextoAba.corresponde(contexto) || !cloudRel.disponivel()) return;
      const org = contexto.organizationId; if (!org) return;
      realtime._org = org;
      realtime._contexto = contexto;
      const c = cloud.config(); const s = cloud.session();
      if (!c || !s || !s.access_token || !s.user || s.user.id !== contexto.userId) return;
      const url = c.url.replace(/^http/, 'ws') + '/realtime/v1/websocket?apikey=' +
                  encodeURIComponent(c.anonKey) + '&vsn=1.0.0';
      realtime._setStatus('conectando…', 'var(--text-mute)');
      const ws = new WebSocket(url);
      realtime._ws = ws;
      ws.onopen = () => {
        if (!contextoAba.corresponde(contexto)) { realtime._encerrar(true); return; }
        realtime._tentativa = 0; realtime._entrarNosCanais(s.access_token, contexto); realtime._baterCoracao();
        realtime._setStatus('ativo', 'var(--success,#16a34a)');
      };
      ws.onmessage = (ev) => { try { realtime._receber(JSON.parse(ev.data), contexto); } catch (e) {} };
      ws.onclose = () => {
        realtime._encerrar(false);
        realtime._setStatus('reconectando…', '#7a4b12');
        realtime._reagendar();
      };
      ws.onerror = () => {
        realtime._setStatus('falha de conexão — tentando novamente', '#b3261e');
        try { ws.close(); } catch (e) {}
      };
    } catch (e) {
      realtime._setStatus('falha de conexão — tentando novamente', '#b3261e');
      realtime._reagendar();
    }
  },

  _entrarNosCanais(token, contexto) {
    if (!contextoAba.corresponde(contexto)) return;
    Object.keys(realtime.TABELAS).forEach(tabela => {
      realtime._enviar({
        topic: 'realtime:public:' + tabela,
        event: 'phx_join',
        /* filtro por organização no servidor: o aparelho não recebe (nem gasta
           banda com) mudança de clínica que não é a dele */
        payload: {
          config: {
            postgres_changes: [{ event: '*', schema: 'public', table: tabela,
                                 filter: 'organization_id=eq.' + contexto.organizationId }]
          },
          access_token: token
        },
        ref: realtime._proxRef()
      });
    });
    realtime._ligado = true;
  },

  _enviar(msg) {
    try { if (realtime._ws && realtime._ws.readyState === 1) realtime._ws.send(JSON.stringify(msg)); }
    catch (e) {}
  },

  _baterCoracao() {
    clearInterval(realtime._hb);
    realtime._hb = setInterval(() => {
      if (!realtime._ws || realtime._ws.readyState !== 1) return;
      if (!contextoAba.corresponde(realtime._contexto)) { realtime._encerrar(true); return; }
      realtime._enviar({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: realtime._proxRef() });
      /* o token expira antes do socket: renova em voo, senão o servidor passa
         a recusar as mudanças por RLS e o silêncio parece "nada mudou" */
      try {
        const s = cloud.session();
        if (s && s.access_token && s.user && realtime._contexto && s.user.id === realtime._contexto.userId) {
          realtime._enviar({ topic: 'realtime:public:' + Object.keys(realtime.TABELAS)[0],
            event: 'access_token', payload: { access_token: s.access_token }, ref: realtime._proxRef() });
        }
      } catch (e) {}
    }, realtime.HEARTBEAT);
  },

  _receber(msg, contexto) {
    if (!contextoAba.corresponde(contexto) || !contextoAba.corresponde(realtime._contexto)) return;
    if (!msg || msg.event !== 'postgres_changes') return;
    const d = msg.payload && msg.payload.data;
    if (!d) return;
    const mod = realtime.TABELAS[d.table];
    if (!mod) return;
    const linha = d.record || d.old_record;
    if (!linha || !linha.id) return;
    if (String(linha.organization_id || '') !== String(contexto.organizationId || '')) return;
    if (mod === '__addenda__') {
      if (d.type !== 'DELETE') { try { adendos.receberLinha(linha); } catch (e) {} }
      realtime._marcarMudanca(); return;
    }
    if (mod === '__drafts__') {
      if (d.type !== 'DELETE' && linha.module) {
        try { rascunhosSync.puxar(linha.module); } catch (e) {}
      }
      realtime._marcarMudanca(); return;
    }
    if (mod === '__conflicts__') {
      try { cloudRel.receberConflitoLinha(linha); } catch (e) {}
      try { nuvemEstado.renderMenu(); } catch (e) {}
      realtime._marcarMudanca(); return;
    }
    /* Apagado na clínica não some daqui por conta própria: quem decide
       remoção é a reconciliação, com a lista completa na mão. Aqui só
       registramos que algo mudou. */
    if (d.type === 'DELETE') { realtime._marcarMudanca(); return; }
    if (linha.deleted_at) { realtime._marcarMudanca(); return; }
    try {
      const reg = mod === 'pacientes'
        ? cloudRel._rowParaItem(linha, contexto.organizationId)
        : mod === 'agenda'
          ? cloudRel._rowParaAgenda(linha, contexto.organizationId)
          : cloudRel._rowParaRegistro(linha, contexto.organizationId);
      if (!reg || !reg._id) return;
      /* mesclarLocal já decide por carimbo: o que chega mais velho que o
         daqui é descartado, e o que está aberto na tela não é sobrescrito */
      const r = cloudRel.mesclarLocal(mod, [reg]);
      realtime._recebidos += (r.novos + r.atualizados);
      if (r.novos || r.atualizados) realtime._repintar(mod);
    } catch (e) {}
    realtime._marcarMudanca();
  },

  _marcarMudanca() { realtime._ultimoEvento = Date.now(); },

  _repintar(mod) {
    try { if (typeof preLanc !== 'undefined') preLanc.renderFila(); } catch (e) {}
    try { if (typeof ui !== 'undefined') ui.repintarNuvemAtual(); } catch (e) {}
    try {
      if (state.currentModule === 'financeiro' && (mod === 'financeiro' || mod === 'fin_fechamentos')) {
        financeiro.render();
      }
    } catch (e) {}
    try { if (mod === 'agenda') { agenda._puxouNestaSessao = false; agenda.sincronizarNuvem({ silent: true }); } } catch (e) {}
    try { if (state.currentModule === 'dashboard') dashboard.atualizar(); } catch (e) {}
    try { if (typeof pendencias !== 'undefined') pendencias.renderDashboard(); } catch (e) {}
    try { if (typeof pendProntuario !== 'undefined') pendProntuario.renderDashboard(); } catch (e) {}
  },

  _encerrar(fechar) {
    realtime._ligado = false;
    clearInterval(realtime._hb); realtime._hb = null;
    if (fechar) {
      try {
        if (realtime._ws) { realtime._ws.onclose = null; realtime._ws.onmessage = null; realtime._ws.close(); }
      } catch (e) {}
    }
    realtime._ws = null;
    realtime._org = null;
    realtime._contexto = null;
  },

  _reagendar() {
    if (!contextoAba.operational()) {
      realtime._setStatus('aguardando conta e clínica', 'var(--text-mute)');
      return;
    }
    const espera = realtime.ESPERAS[Math.min(realtime._tentativa, realtime.ESPERAS.length - 1)];
    realtime._tentativa++;
    clearTimeout(realtime._timer);
    realtime._timer = setTimeout(() => {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        realtime._setStatus('offline — reconecta automaticamente', '#7a4b12');
        realtime._reagendar(); return;
      }
      realtime.conectar();
    }, espera);
  },

  trocarContexto() {
    clearTimeout(realtime._timer); realtime._timer = null;
    realtime._tentativa = 0;
    realtime._encerrar(true);
    realtime._setStatus(contextoAba.operational() ? 'trocando contexto…' : 'aguardando conta e clínica', 'var(--text-mute)');
    if (contextoAba.operational()) setTimeout(() => realtime.conectar(), 50);
  },

  vigiar() {
    if (realtime._vigiando) return;
    realtime._vigiando = true;
    realtime.conectar();
    try {
      window.addEventListener('online', () => { realtime._tentativa = 0; realtime.conectar(); });
      document.addEventListener('visibilitychange', () => {
        /* aba dormindo mata o socket em muitos navegadores; ao voltar,
           reconecta na hora em vez de esperar o próximo recuo */
        if (document.visibilityState === 'visible' && !realtime.ativo()) {
          realtime._tentativa = 0; realtime.conectar();
        }
      });
    } catch (e) {}
  }
};

const sincronia = {
  INTERVALO: 60000,
  MAX_ESPERA: 600000,
  MARCAS_KEY: 'medsys.v7.sync.marcas',
  MODS: ['pre', 'anestesia', 'recuperacao', 'consulta', 'financeiro', 'risco', 'termo', 'prescricao'],
  _timer: null, _rodando: false, _espera: 60000, _ultimo: 0, _ligado: false,

  _marcas() { try { return JSON.parse(localStorage.getItem(sincronia.MARCAS_KEY) || '{}'); } catch (e) { return {}; } },
  _salvarMarcas(m) { try { localStorage.setItem(sincronia.MARCAS_KEY, JSON.stringify(m)); } catch (e) {} },

  podeRodar() {
    try {
      if (typeof demo !== 'undefined' && demo.ativo()) return false;
      if (!cloud.estaConfigurado() || !cloud.estaLogado()) return false;
      if (cloud.sessaoExpirada()) return false;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
      return typeof cloudRel !== 'undefined' && cloudRel.disponivel();
    } catch (e) { return false; }
  },

  iniciar() {
    if (sincronia._ligado) return;
    sincronia._ligado = true;
    try {
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) sincronia.agora({ motivo: 'voltou à tela' });
      });
      window.addEventListener('online', () => sincronia.agora({ motivo: 'internet voltou' }));
      window.addEventListener('focus', () => sincronia.agora({ motivo: 'foco' }));
    } catch (e) {}
    sincronia._agendar(4000);
  },
  _agendar(ms) {
    try { clearTimeout(sincronia._timer); } catch (e) {}
    sincronia._timer = setTimeout(() => { sincronia.ciclo(); }, ms);
  },
  /* Chamado por quem tem pressa (gravou algo, voltou para a tela). Respeita um
     mínimo de 10s para não virar uma consulta por tecla digitada. */
  agora(opts = {}) {
    if (Date.now() - sincronia._ultimo < 10000) return;
    sincronia._agendar(opts.emMs || 800);
  },

  async ciclo() {
    if (sincronia._rodando) return;
    if (!sincronia.podeRodar()) { sincronia._agendar(sincronia.INTERVALO); return; }
    const contexto = cloudRel._capturarContexto();
    if (!contexto) { sincronia._agendar(sincronia.INTERVALO); return; }
    const contextoValido = () => cloudRel._contextoValido(contexto, contexto.organizationId);
    sincronia._rodando = true;
    sincronia._ultimo = Date.now();
    let deuCerto = false;
    try {
      /* 1) o que foi ENVIADO aqui e ainda não chegou na clínica tem prioridade:
            é trabalho que alguém já deu por concluído e que o médico não vê.
            Vai antes da fila geral, que é limitada por lote. */
      try {
        if (typeof preLanc !== 'undefined' && preLanc.naoSubiram().length) {
          await preLanc.subirPendentes({ silent: true });
        }
      } catch (e) {}
      if (!contextoValido()) return;
      /* 1c) diário cifrado: é a única cópia segura das novas gravações que
             ficaram sem recibo e, por isso, vem antes de qualquer legado. */
      try { await persistenciaCloudFirst.drenar(); } catch (e) {}
      if (!contextoValido()) return;
      /* 1d) a FILA antiga do canal relacional: o que uma versão anterior
             tentou subir e não
             conseguiu. Vem antes da varredura porque é precisa — sabe
             exatamente o que falhou, em vez de procurar. */
      try { await cloudRel.drenarFila(); } catch (e) {}
      if (!contextoValido()) return;
      try { await cloudRel.drenarFilaDel(); } catch (e) {}
      if (!contextoValido()) return;
      try { await cloudRel.drenarConflitos(); } catch (e) {}
      if (!contextoValido()) return;
      try { await adendos.enviarPendentes(); } catch (e) {}
      if (!contextoValido()) return;
      /* 1d) e os PDFs que não subiram — mesma ideia, outro tipo de carga */
      try { await pdfBackup.drenarFila(); } catch (e) {}
      if (!contextoValido()) return;
      /* 2) o resto do que foi feito aqui e ainda não subiu */
      try { await cloudRel.empurrarPendentes({ silent: true, limite: 15 }); } catch (e) {}
      if (!contextoValido()) return;
      /* 3) o que os outros aparelhos fizeram desde a última passada */
      const marcas = sincronia._marcas();
      let mudou = 0;
      for (const mod of sincronia.MODS) {
        if (!contextoValido()) break;
        if (!cloudRel.MODOS[mod]) continue;
        const desde = marcas[mod] || '';
        const remotos = await cloudRel.puxarModulo(mod, desde ? { desde } : {});
        if (!contextoValido()) break;
        if (!Array.isArray(remotos)) continue;
        deuCerto = true;
        if (remotos.length) {
          const m = cloudRel.mesclarLocal(mod, remotos);
          mudou += m.novos + m.atualizados;
        }
        /* a marca avança pelo mais novo que a clínica devolveu */
        remotos.forEach(r => {
          const t = r && r._relUpdatedAt;
          if (t && String(t) > String(marcas[mod] || '')) marcas[mod] = String(t);
        });
      }
      if (contextoValido()) {
        sincronia._salvarMarcas(marcas);
        if (mudou) sincronia._repintar();
      }
    } catch (e) {
    } finally {
      sincronia._rodando = false;
      /* deu certo volta ao ritmo normal; falhou espera mais na próxima */
      sincronia._espera = deuCerto ? sincronia.INTERVALO
        : Math.min(sincronia.MAX_ESPERA, Math.max(sincronia.INTERVALO, sincronia._espera * 2));
      sincronia._agendar(sincronia._espera);
    }
  },
  _repintar() {
    try { if (typeof preLanc !== 'undefined') preLanc.renderFila(); } catch (e) {}
    try { if (state.currentModule === 'dashboard') dashboard.atualizar(); } catch (e) {}
    try { if (state.currentModule === 'financeiro' && financeiro.render) financeiro.render(); } catch (e) {}
    try { nuvemEstado.renderMenu(); } catch (e) {}
  }
};
try { window.sincronia = sincronia; } catch (e) {}

const nuvemEstado = {
  /* Diagnóstico único, usado tanto pelo cartão de Ajustes quanto pelo botão do
     menu. Devolve { estado, msg }: estado = ok | pendente | semNuvem |
     expirada | contas. */
  situacao() {
    try {
      if (!cloud.estaConfigurado() || !cloud.estaLogado()) return { estado: 'semNuvem', msg: 'sem nuvem neste aparelho' };
      if (cloud.sessaoExpirada()) return { estado: 'expirada', msg: 'sessão vencida — toque para entrar' };
      const d = cloud.divergencia();
      if (d) return { estado: 'contas', msg: 'contas diferentes — toque para corrigir', div: d };
      if (!contextoAba.atual().verified) {
        return { estado: 'contexto', msg: 'clínica ainda não confirmada — sincronização bloqueada' };
      }
      /* CONTA SEM CLÍNICA — a falha que dizia "em dia" enquanto nada andava.
         Sem organização, `_orgAsync()` devolve null e TUDO para em silêncio:
         `enviarRegistro` recusa com motivo 'org' e `puxarModulo` volta vazio.
         Para quem usa o aparelho, o painel simplesmente não tem nada, o
         financeiro tem só o que foi digitado ali, e o pré-lançamento enviado
         nunca chega ao médico — sem uma linha explicando por quê.
         Este indicador é o único caminho de quem não tem acesso a Ajustes;
         se ele não contar isso, ninguém conta. */
      try {
        if (typeof cloudRel !== 'undefined' && !cloudRel._org() && cloudRel._semClinicaConfirmado()) {
          return { estado: 'semClinica',
            msg: 'conta sem clínica — módulos clínicos bloqueados (toque)' };
        }
      } catch (e) {}
      /* Conta as DUAS filas. A do canal relacional é a que importa para a
         equipe — é por ela que um registro chega ao outro aparelho — e era
         justamente a que não existia, logo não era contada por ninguém. */
      const filaBackup = (() => { try { return cloud._fila().length; } catch (e) { return 0; } })();
      const filaRel = (() => { try { return cloudRel.filaPendentes(); } catch (e) { return 0; } })();
      const filaDel = (() => { try { return cloudRel._filaDelLer().length; } catch (e) { return 0; } })();
      const filaCifradaN = (() => { try { return persistenciaCloudFirst.pendentesConhecidos(); } catch (e) { return 0; } })();
      const conflitos = (() => { try { return cloudRel.conflitosPendentes(); } catch (e) { return 0; } })();
      if (conflitos) return { estado: 'conflito', conflitos,
        msg: conflitos + (conflitos === 1 ? ' conflito preservado — toque para decidir' : ' conflitos preservados — toque para decidir') };
      const fila = filaBackup + filaRel + filaDel + filaCifradaN;
      if (fila) return { estado: 'pendente', fila: fila, filaRel: filaRel,
        msg: fila + (fila === 1 ? ' registro aguardando envio' : ' registros aguardando envio') +
             (cloudRel._ultimoMotivo ? ' · ' + cloudRel._ultimoMotivo : '') };
      const ultimo = localStorage.getItem('medsys.v7.cloud.ultimo_sync');
      return { estado: 'ok', msg: ultimo ? 'em dia · ' + new Date(ultimo).toLocaleString('pt-BR') : 'em dia' };
    } catch (e) { return { estado: 'semNuvem', msg: 'sem nuvem neste aparelho' }; }
  },
  /* Botão no pé do MENU — o único caminho de quem não tem acesso a Ajustes */
  renderMenu(msgForcada) {
    const btn = document.getElementById('sidebar-nuvem-btn');
    const ico = document.getElementById('sidebar-nuvem-ico');
    const msg = document.getElementById('sidebar-nuvem-msg');
    if (!btn || !msg) return;
    if (msgForcada) { msg.textContent = msgForcada; return; }
    const s = nuvemEstado.situacao();
    const icones = { ok: '☁️', pendente: '⏳', conflito: '⚠️', semNuvem: '⚠️', expirada: '🔑', contas: '⚠️', semClinica: '🏥', contexto: '🔒' };
    if (ico) ico.textContent = icones[s.estado] || '☁️';
    msg.textContent = s.msg;
    btn.classList.toggle('sn-alerta', s.estado !== 'ok');
  },
  vigiar() {
    try {
      nuvemEstado.renderMenu();
      setInterval(() => { try { if (!nuvemEstado._ocupado) nuvemEstado.renderMenu(); } catch (e) {} }, 30000);
    } catch (e) {}
  },
  render() {
    try { nuvemEstado.renderMenu(); } catch (e) {}
    try { persistenciaCloudFirst.renderPainel(); } catch (e) {}
    const el = document.getElementById('nuvem-estado-linha');
    if (!el) return;
    const partes = [];
    let ok = true;
    const conectado = (() => { try { return cloud.estaConfigurado() && cloud.estaLogado(); } catch (e) { return false; } })();
    if (!conectado) {
      el.innerHTML = '<span style="color:#b3392a">⚠️ <b>Sem sessão da nuvem.</b> O acesso clínico permanece bloqueado. ' +
        'Entre novamente para abrir uma clínica.</span>';
      return;
    }
    /* A ORDEM IMPORTA: servidor fora vem ANTES de sessão vencida, porque o
       botão "Entrar de novo" é exatamente a ação errada numa queda — ela apaga
       a sessão boa e não há como obter outra até o servidor voltar. */
    if (cloud.servidorFora()) {
      el.innerHTML = '<span style="color:#b3392a">🔌 <b>O servidor da clínica não está respondendo.</b> ' +
        'Nada foi perdido: a sessão já aberta continua e cada alteração fica na fila cifrada até subir automaticamente. ' +
        '<b>Não saia da nuvem</b> — a sua sessão continua boa.</span> ' +
        '<button class="btn btn-xs" onclick="nuvemEstado.atualizarTudo()">Tentar agora</button>';
      return;
    }
    if (cloud.sessaoExpirada()) {
      el.innerHTML = '<span style="color:#b3392a">🔑 <b>Sessão da nuvem vencida.</b> Nada foi perdido — entre de novo para voltar a sincronizar.</span> ' +
        '<button class="btn btn-xs btn-primary" onclick="cloud.reentrar()">Entrar de novo</button>';
      return;
    }
    const d = cloud.divergencia();
    if (d) {
      el.innerHTML = '<span style="color:#b3392a">⚠️ <b>Contas diferentes</b> (app: ' + utils.escapeHTML(d.app) + ' · nuvem: ' + utils.escapeHTML(d.nuvem) + ').</span> ' +
        '<button class="btn btn-xs btn-primary" onclick="cloud.resolverDivergencia()">Corrigir</button>';
      return;
    }
    const fila = (() => {
      try { return cloud._fila().length + cloudRel.filaPendentes() + cloudRel._filaDelLer().length +
        persistenciaCloudFirst.pendentesConhecidos(); }
      catch (e) { return 0; }
    })();
    const conflitos = (() => { try { return cloudRel.conflitosPendentes(); } catch (e) { return 0; } })();
    const ultimo = localStorage.getItem('medsys.v7.cloud.ultimo_sync');
    partes.push('☁️ <b>Tudo na nuvem</b> — registros, cadastros da clínica, modelos e rascunhos');
    if (fila) { ok = false; partes.push('⏳ <b>' + fila + '</b> aguardando envio (sobem sozinhos)'); }
    if (conflitos) { ok = false; partes.push('⚠️ <b>' + conflitos + '</b> conflito(s) preservado(s) aguardando decisão'); }
    if (ultimo) partes.push('🕐 última atualização ' + new Date(ultimo).toLocaleString('pt-BR'));
    el.innerHTML = '<span style="color:' + (ok ? '#1f7a4d' : '#7a4b12') + '">' + partes.join(' · ') + '</span>';
  },
  _ocupado: false,
  async atualizarTudo() {
    const prog = document.getElementById('nuvem-estado-prog');
    const btn = document.getElementById('sidebar-nuvem-btn');
    const dizer = (t) => { if (prog) prog.textContent = t; nuvemEstado.renderMenu(t.replace(/^⏳\s*/, '') || null); };
    /* Sem nuvem, ou com a sessão vencida, o toque tem que LEVAR à solução — não
       morrer num aviso. Quem está no menu pode nem ter acesso a Ajustes. */
    if (!cloud.estaConfigurado() || !cloud.estaLogado()) {
      toast('Este aparelho não está conectado à nuvem. Entre com o seu e-mail e senha para sincronizar.', 'warn');
      try { cloud.reentrar(); } catch (e) {}
      return;
    }
    if (cloud.servidorFora()) {
      toast('🔌 O servidor da clínica não está respondendo. Não é a sua senha nem a sua sessão — continue atendendo; as alterações ficam na fila cifrada e sobem sozinhas quando ele voltar.', 'warn');
      return;
    }
    if (cloud.sessaoExpirada()) { try { cloud.reentrar(); } catch (e) {} return; }
    const sessaoInicial = cloud.session();
    const uidInicial = sessaoInicial && sessaoInicial.user && sessaoInicial.user.id;
    /* Conta sem clínica: sincronizar não adianta, porque não há para onde.
       Confirma no servidor antes de acusar — o cache pode só não ter sido
       preenchido ainda — e, confirmado, diz o que é e QUEM resolve. Ela não
       resolve sozinha, e ficar tocando num botão que não responde é o que
       faz alguém concluir que "o sistema não funciona". */
    try {
      if (typeof cloudRel !== 'undefined' && !cloudRel._org()) {
        const org = await cloudRel._orgAsync();
        const sessaoDepois = cloud.session();
        if (!uidInicial || !sessaoDepois || !sessaoDepois.user || sessaoDepois.user.id !== uidInicial) return;
        if (!org) {
          const eu = (() => { try { return (auth.usuarioAtual() || {}).usuario || ''; } catch (e) { return ''; } })();
          modal.open('🏥 Esta conta não está ligada a nenhuma clínica',
            '<p style="font-size:.9rem;margin:0 0 10px">Enquanto estiver assim, os <b>módulos clínicos permanecem bloqueados</b>: ' +
            'não existe organização autorizada para receber ou mostrar prontuários.</p>' +
            '<p style="font-size:.86rem;color:var(--text-soft);margin:0 0 10px">Não é senha nem internet — a conta existe, só não pertence a nenhuma clínica na nuvem.</p>' +
            (eu ? '<p style="font-size:.86rem;margin:0 0 10px">Conta: <b>' + utils.escapeHTML(eu) + '</b></p>' : '') +
            '<p style="font-size:.86rem;margin:0"><b>Quem resolve é o gestor</b>, em <b>Ajustes → Equipe da nuvem</b>, adicionando esta conta à clínica. ' +
            'Depois disso, toque aqui de novo e tudo sobe e desce de uma vez.</p>',
            '<button class="btn btn-primary" onclick="modal.close()">Entendi</button>');
          return;
        }
      }
    } catch (e) {}
    const contexto = cloudRel._capturarContexto();
    if (!contexto) return;
    if (nuvemEstado._ocupado) return;
    nuvemEstado._ocupado = true;
    if (btn) btn.disabled = true;
    try {
      if (cloudRel.conflitosPendentes()) {
        try { await cloudRel.drenarConflitos(); } catch (e) {}
        if (!cloudRel._contextoValido(contexto, contexto.organizationId)) return;
        cloudRel.abrirConflitosPendentes();
        return;
      }
      await nuvemEstado._rodar(dizer, contexto);
    } finally {
      nuvemEstado._ocupado = false;
      if (btn) btn.disabled = false;
      nuvemEstado.renderMenu();
    }
  },
  async _rodar(dizer, contexto) {
    const valido = () => cloudRel._contextoValido(contexto, contexto && contexto.organizationId);
    if (!valido()) return;
    dizer('⏳ enviando o que falta…');
    try { await cloud.sincronizar({ silent: true }); } catch (e) {}
    if (!valido()) return;
    try { await cloudRel.empurrarPendentes({ silent: true }); } catch (e) {}
    if (!valido()) return;
    try { await cloudRel.drenarConflitos(); } catch (e) {}
    if (!valido()) return;
    try { await adendos.enviarPendentes(); } catch (e) {}
    if (!valido()) return;
    dizer('⏳ atualizando cadastros da clínica…');
    try { await clinicaSync.sincronizarAgora({ silent: true }); } catch (e) {}
    if (!valido()) return;
    try { await configSync.enviar(); } catch (e) {}
    if (!valido()) return;
    try { await configSync.puxarAplicar(); } catch (e) {}
    if (!valido()) return;
    dizer('⏳ trazendo registros e rascunhos…');
    try { await cloudDiag.puxarTudo({ silent: true }); } catch (e) {}
    if (!valido()) return;
    try { await rascunhosSync.enviarTodos(); } catch (e) {}
    if (!valido()) return;
    try { await rascunhosSync.puxarTodos({ silent: true }); } catch (e) {}
    if (!valido()) return;
    try { await adendos.puxarTodos(); } catch (e) {}
    if (!valido()) return;
    dizer('');
    /* Depois de tudo confirmado na nuvem é o melhor momento para o aparelho
       devolver espaço — só agora dá para saber o que pode sair. */
    try { modoNuvem.manutencao({ silent: true }); } catch (e) {}
    nuvemEstado.render();
    try { cloud._repintarTelaAtual(); } catch (e) {}
    toast('✅ Tudo atualizado — este aparelho está igual aos outros');
  }
};

/* FIM DO RUNTIME DE SINCRONIZAÇÃO */
