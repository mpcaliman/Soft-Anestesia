'use strict';

/* ============================================================================
   AUTH — identidade, perfis e permissões
   A conta Supabase é a única identidade capaz de abrir dados clínicos. O app
   guarda apenas metadados não secretos para compor a interface; senha, hash,
   derivação ou qualquer verificador offline são proibidos no navegador.
============================================================================ */
const auth = {
  USERS_KEY: 'medsys.v7.auth.users',
  SESSION_KEY: 'medsys.v7.auth.session',
  TIMEOUT_MS: 5 * 60 * 1000,   // 5 minutos de inatividade
  _timer: null,

  /* Todos os módulos que podem ser liberados por permissão */
  MODULOS: [
    { key: 'dashboard',   label: 'Dashboard' },
    { key: 'pacientes',   label: 'Pacientes' },
    { key: 'agenda',      label: 'Agenda' },
    { key: 'consulta',    label: 'Consulta / Dor' },
    { key: 'pre',         label: 'Pré-anestésica' },
    { key: 'termo',       label: 'Termo (TCLE)' },
    { key: 'prescricao',  label: 'Receituário' },
    { key: 'documentos',  label: 'Documentos (atestados/laudos)' },
    { key: 'risco',       label: 'Risco perioperatório' },
    { key: 'anestesia',   label: 'Ficha de anestesia' },
    { key: 'recuperacao', label: 'Recuperação pós' },
    { key: 'financeiro',  label: 'Financeiro' },
    { key: 'orcamento',   label: 'Orçamentos' },
    { key: 'doses',       label: 'Doses & Infusões' },
    { key: 'ajustes',     label: 'Ajustes' }
  ],

  /* Perfis pré-definidos com permissões sugeridas.
     modulos = módulos acessíveis; soImpressao = subconjunto liberado só p/ imprimir. */
  PERFIS: {
    admin: {
      label: 'Administrador',
      modulos: ['dashboard','pacientes','agenda','consulta','pre','termo','prescricao','documentos','risco','anestesia','recuperacao','financeiro','orcamento','doses','ajustes'],
      soImpressao: []
    },
    medico: {
      label: 'Médico',
      modulos: ['dashboard','pacientes','agenda','consulta','pre','termo','prescricao','documentos','risco','anestesia','recuperacao','financeiro','orcamento','doses'],
      soImpressao: []
    },
    secretaria: {
      label: 'Secretária / Auxiliar',
      modulos: ['dashboard','pacientes','agenda','pre','termo','prescricao','documentos','financeiro','orcamento'],
      soImpressao: ['prescricao'],
      /* Na pré, edita só comorbidades, medicações em uso e exames (regiões
         marcadas com data-sec-edit). O restante fica travado (só leitura). */
      edicaoParcial: { pre: '[data-sec-edit]' }
    },
    sem_clinica: {
      /* A conta foi autenticada, mas ainda não possui um destino autorizado
         para prontuário. Ela pode somente criar/confirmar o ambiente em
         Ajustes; nenhum módulo clínico é aberto antes do vínculo servidor. */
      label: 'Sem clínica vinculada',
      modulos: ['ajustes'],
      soImpressao: []
    }
  },

  /* Mapa: papel no banco (organization_users.role) → permissões no app.
     A RLS do banco é a barreira de segurança de verdade; isto só alinha a
     UI (o que cada um vê/edita/imprime) ao papel definido no servidor. */
  ROLE_PERMS: {
    gestor: { perfil: 'admin',
      modulos: ['dashboard','pacientes','agenda','consulta','pre','termo','prescricao','documentos','risco','anestesia','recuperacao','financeiro','orcamento','doses','ajustes'],
      soImpressao: [] },
    anestesiologista: { perfil: 'medico',
      modulos: ['dashboard','pacientes','agenda','consulta','pre','termo','prescricao','documentos','risco','anestesia','recuperacao','financeiro','orcamento','doses'],
      soImpressao: [] },
    cirurgiao: { perfil: 'medico',
      modulos: ['dashboard','pacientes','agenda','consulta','pre','termo','documentos','risco'],
      soImpressao: ['consulta','pre','risco','documentos'] },
    auxiliar: { perfil: 'secretaria',
      modulos: ['dashboard','pacientes','agenda','pre','termo','prescricao','documentos','financeiro','orcamento'],
      soImpressao: ['prescricao'],
      edicaoParcial: { pre: '[data-sec-edit]' } },
    financeiro: { perfil: 'secretaria',
      modulos: ['dashboard','pacientes','agenda','financeiro','orcamento'],
      soImpressao: ['pacientes','agenda'] },
    empresa: { perfil: 'secretaria',
      modulos: ['dashboard','financeiro','orcamento'],
      soImpressao: ['financeiro','orcamento'] }
  },
  _permsDoPapel(role) {
    return (role && auth.ROLE_PERMS[role]) ? auth.ROLE_PERMS[role] : null;
  },
  /* Personalização de acesso feita pelo gestor e guardada NA NUVEM
     (organization_users.permissoes — migração 0011). Vale mais que o padrão do
     papel: é o que o gestor definiu para aquela pessoa, e vale em qualquer
     aparelho. Sem isso, a mudança ficava só no aparelho de quem editou. */
  _permsPersonalizadas(perfilNuvem) {
    const p = perfilNuvem && perfilNuvem.permissoes;
    if (!p || typeof p !== 'object' || !Array.isArray(p.modulos)) return null;
    return {
      perfil: p.perfil || 'secretaria',
      modulos: p.modulos.slice(),
      soImpressao: Array.isArray(p.soImpressao) ? p.soImpressao.slice() : []
    };
  },
  /* Grava na nuvem o acesso personalizado de um membro da clínica.
     Só o gestor consegue (policy ou_all). Retorna true/false. */
  async salvarPermissoesNaNuvem(uid, orgId, perms, contextoEsperado) {
    try {
      if (!uid || !orgId) return false;
      const contexto = contextoEsperado || cloudRel._capturarContexto();
      if (!contexto || contexto.organizationId !== orgId) return false;
      if (!(await cloud._garantirToken())) return false;
      if (!cloudRel._contextoValido(contexto, orgId)) return false;
      const c = cloud.config();
      const corpo = {
        permissoes: {
          perfil: perms.perfil,
          modulos: (perms.modulos || []).slice(),
          soImpressao: (perms.soImpressao || []).slice(),
          atualizadoEm: new Date().toISOString()
        }
      };
      const r = await fetch(c.url + '/rest/v1/organization_users?user_id=eq.' + encodeURIComponent(uid) +
        '&organization_id=eq.' + encodeURIComponent(orgId),
        { method: 'PATCH', headers: Object.assign({}, cloud._headers(true), { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }),
          body: JSON.stringify(corpo) });
      return r.ok && cloudRel._contextoValido(contexto, orgId);
    } catch (e) { return false; }
  },
  _rotuloPapel(role) {
    const m = { gestor: 'Gestor', anestesiologista: 'Anestesiologista', cirurgiao: 'Cirurgião',
                auxiliar: 'Auxiliar / Secretária', financeiro: 'Financeiro', empresa: 'Empresa' };
    return (role && m[role]) || '';
  },

  /* ---------- Metadados locais não secretos ---------- */
  _semSegredos(usuario) {
    if (!usuario || typeof usuario !== 'object') return usuario;
    const limpo = Object.assign({}, usuario);
    delete limpo.senha;
    delete limpo.password;
    delete limpo.senhaHash;
    delete limpo.senhaKdf;
    delete limpo.passwordHash;
    return limpo;
  },
  _lerUsuarios() {
    try {
      const bruto = JSON.parse(localStorage.getItem(auth.USERS_KEY) || '[]');
      const lista = Array.isArray(bruto) ? bruto.map(auth._semSegredos).filter(Boolean) : [];
      /* Remove verificadores deixados por versões anteriores assim que o app
         os encontra. Eles não são usados nem para desbloqueio offline. */
      if (JSON.stringify(lista) !== JSON.stringify(bruto)) auth._salvarUsuarios(lista);
      return lista;
    }
    catch { return []; }
  },
  _salvarUsuarios(lista) {
    const seguros = (Array.isArray(lista) ? lista : []).map(auth._semSegredos).filter(Boolean);
    localStorage.setItem(auth.USERS_KEY, JSON.stringify(seguros));
  },
  temUsuarios() { return auth._lerUsuarios().length > 0; },

  async criarUsuario() {
    return { ok: false, erro: 'Contas são criadas e autenticadas somente pela nuvem.' };
  },

  async atualizarSenha() {
    return false;
  },

  atualizarPermissoes(id, { perfil, modulos, soImpressao, nome }) {
    const lista = auth._lerUsuarios();
    const u = lista.find(x => x.id === id);
    if (!u) return false;
    if (perfil) u.perfil = perfil;
    if (Array.isArray(modulos)) u.modulos = modulos;
    if (Array.isArray(soImpressao)) u.soImpressao = soImpressao;
    if (nome != null) u.nome = nome;
    auth._salvarUsuarios(lista);
    return true;
  },

  excluirUsuario(id) {
    let lista = auth._lerUsuarios();
    const alvo = lista.find(u => u.id === id);
    if (!alvo) return false;
    /* impede excluir o último administrador */
    const admins = lista.filter(u => u.perfil === 'admin');
    if (alvo.perfil === 'admin' && admins.length <= 1) {
      toast('Não é possível excluir o único administrador.', 'warn');
      return false;
    }
    lista = lista.filter(u => u.id !== id);
    auth._salvarUsuarios(lista);
    return true;
  },

  /* ---------- Sessão ---------- */
  usuarioAtual() {
    try { return JSON.parse(sessionStorage.getItem(auth.SESSION_KEY) || 'null'); }
    catch { return null; }
  },
  _definirSessao(u) {
    const sess = { id: u.id, usuario: u.usuario, nome: u.nome, perfil: u.perfil, modulos: u.modulos, soImpressao: u.soImpressao || [], entrouEm: Date.now(),
      role: u.role || null, organization_id: u.organization_id || null, uid: u.uid || null };
    sessionStorage.setItem(auth.SESSION_KEY, JSON.stringify(sess));
    try { contextoAba.restaurarDeSessoes(); } catch (e) {}
    /* Credencial e autorização pertencem sempre à aba. Marcadores legados de
       sessão diária são removidos para não reabrir a interface sem a sessão
       Supabase e sem a chave do cofre cifrado. */
    try { localStorage.removeItem(auth.DIA_KEY); } catch (e) {}
  },
  estaLogado() { return !!auth.usuarioAtual(); },

  /* Reconfere o acesso na nuvem SEM pedir login de novo.
     Até aqui o acesso só era lido no login. O gestor marcava "Financeiro:
     Editar" para a secretária e, no computador dela, nada mudava — ela já
     estava dentro, e o espelho antigo continuava valendo até ela sair e
     entrar. Como o Ajustes é o único juiz do que se pode, ele precisa
     alcançar quem já está com o sistema aberto. */
  _revalidando: false,
  REVALIDA_MS: 5 * 60 * 1000,
  async revalidarAcesso(opts) {
    opts = opts || {};
    if (auth._revalidando) return false;
    const sess = auth.usuarioAtual();
    if (!sess || !sess.uid) return false;
    let podeIr = false;
    try { podeIr = navigator.onLine && cloud.estaConfigurado() && cloud.estaLogado(); } catch (e) { podeIr = false; }
    if (!podeIr) return false;
    const contexto = (() => { try { return contextoAba.capturar(); } catch (e) { return null; } })();
    auth._revalidando = true;
    try {
      let perfil = null;
      try { perfil = await cloud.buscarPerfil(); } catch (e) { perfil = null; }
      /* null = não deu para saber (rede, token). Nada muda: rebaixar alguém
         por causa de um 4G ruim seria pior que a informação velha. */
      if (!perfil) return false;
      if (perfil.uid && sess.uid && perfil.uid !== sess.uid) return false;
      /* A resposta pertence à sessão capturada. Um logout ou outra entrada
         durante o fetch não pode ressuscitar a conta anterior. */
      const sessaoAtual = auth.usuarioAtual();
      if (!sessaoAtual || sessaoAtual.uid !== sess.uid ||
          sessaoAtual.organization_id !== sess.organization_id ||
          (contexto && !contextoAba.corresponde(contexto))) return false;
      const novo = auth._permsPersonalizadas(perfil) || auth._permsDoPapel(perfil.role);
      if (!novo) return false;
      const mods = (novo.modulos || []).slice().sort();
      const so = (novo.soImpressao || []).slice().sort();
      const igual = JSON.stringify(mods) === JSON.stringify((sess.modulos || []).slice().sort())
                 && JSON.stringify(so) === JSON.stringify((sess.soImpressao || []).slice().sort())
                 && novo.perfil === sess.perfil;
      if (igual) return false;
      /* grava no espelho do aparelho e na sessão em curso */
      try {
        const lista = auth._lerUsuarios();
        const alvo = lista.find(x => x.uid === sess.uid || x.usuario === sess.usuario);
        if (alvo) {
          alvo.perfil = novo.perfil; alvo.modulos = mods.slice(); alvo.soImpressao = so.slice();
          if (perfil.role) alvo.role = perfil.role;
          auth._salvarUsuarios(lista);
        }
      } catch (e) {}
      const atual = sessaoAtual;
      auth._definirSessao(Object.assign({}, atual, {
        perfil: novo.perfil, modulos: mods.slice(), soImpressao: so.slice(),
        role: perfil.role || atual.role
      }));
      try { auth._aplicarPermissoesUI(); } catch (e) {}
      try { auth._aplicarLeitura(state.currentModule); } catch (e) {}
      if (!opts.silencioso) toast('🔐 Seu acesso foi atualizado pelo gestor.', 'info');
      return true;
    } finally { auth._revalidando = false; }
  },
  _agendarRevalidacao() {
    try {
      if (auth._timerRevalida) return;
      auth._timerRevalida = setInterval(() => {
        auth.revalidarAcesso({ silencioso: false });
      }, auth.REVALIDA_MS);
      if (auth._ouvindoRevalidacao) return;
      auth._ouvindoRevalidacao = true;
      window.addEventListener('online', () => auth.revalidarAcesso({ silencioso: false }));
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) auth.revalidarAcesso({ silencioso: false });
      });
    } catch (e) {}
  },

  podeAcessar(modKey) {
    /* aba do PROGRAMADOR: só a conta do programador (nem outros admins) */
    if (modKey === 'programador') {
      try { return typeof programador !== 'undefined' && programador.souProgramador(); }
      catch (e) { return false; }
    }
    const u = auth.usuarioAtual();
    if (!u) return false;
    /* O Ajustes é o único juiz. Havia um atalho aqui — "perfil admin pode
       tudo" — que passava por cima da grade: marcar "Sem acesso" para um
       administrador não tirava nada, e a tela prometia uma coisa e o sistema
       fazia outra. Agora, havendo lista de módulos, é ela que decide, para
       todo mundo. O atalho sobrou só para espelhos antigos que nunca
       receberam lista, para ninguém ficar trancado do lado de fora. */
    if (Array.isArray(u.modulos) && u.modulos.length) return u.modulos.includes(modKey);
    return u.perfil === 'admin';
  },

  /* Pode editar (não só imprimir) o módulo? Precisa ter acesso e o módulo
     NÃO estar na lista "só impressão" — inclusive para administrador. */
  podeEditar(modKey) {
    const u = auth.usuarioAtual();
    if (!u) return true;                 /* sem login = app aberto (edita) */
    if (!auth.podeAcessar(modKey)) return false;
    return !(Array.isArray(u.soImpressao) && u.soImpressao.includes(modKey));
  },

  /* ---------- Fluxo de login ---------- */
  async tentarLogin() {
    const errEl = document.getElementById('auth-error');
    if (errEl) errEl.textContent = 'O acesso local foi desativado. Entre com a conta da nuvem.';
    auth._render();
  },

  logout(opts = {}) {
    if (auth._encerrando) return;
    auth._encerrando = true;
    try {
      /* Capture e preserve o trabalho enquanto as duas identidades e a chave
         do cofre ainda pertencem à pessoa que está saindo. O adaptador da nuvem
         remove somente cache confirmado; WAL e snapshots cifrados ficam. */
      if (opts.broadcast !== false) { try { contextoAba.bloquearOutrasAbas(); } catch (e) {} }
      try { cloud.logout({ silent: true }); } catch (e) {}
      try { sessionStorage.removeItem(auth.SESSION_KEY); } catch (e) {}
      try { sessionStorage.removeItem(cloud.SESSION_KEY); } catch (e) {}
      /* Mesmo se algum módulo opcional falhar no logout, nenhuma autorização
         ou chave aberta pode continuar utilizável nesta aba. */
      try {
        if (typeof pdfBackup !== 'undefined') {
          pdfBackup._accessToken = null; pdfBackup._tokenExpira = 0;
          sessionStorage.removeItem(pdfBackup.TOKEN_KEY);
        }
      } catch (e) {}
      try {
        const c = contextoAba.atual();
        if (c.userId || c.organizationId || c.verified) contextoAba.limpar();
      } catch (e) {}
      try { filaCifrada.bloquearTudo(); } catch (e) {}
      /* Sair/Bloquear sempre descarta qualquer marcador diário legado — a
         próxima entrada exige autenticação na nuvem. */
      try { localStorage.removeItem(auth.DIA_KEY); } catch (e) {}
      /* quem entrar depois merece ver o aviso de pendências uma vez */
      try { pendencias.esquecerMostrada(); } catch (e) {}
      auth._pararTimer();
      clearInterval(auth._timerRevalida); auth._timerRevalida = null;
      auth._limparDadosDaTela();
      auth._bloquear();
    } finally { auth._encerrando = false; }
  },

  _limparDadosDaTela() {
    /* Desfocar não remove prontuários do DOM. Limpa apenas a apresentação e
       os buffers de edição, sem chamar Novo/Descartar, que alterariam o WAL
       ou a recuperação cifrada do dono anterior. */
    try {
      document.querySelectorAll('.module input, .module select, .module textarea').forEach(el => {
        if (el.type === 'checkbox' || el.type === 'radio') {
          el.checked = false; el.defaultChecked = false;
        } else {
          el.value = '';
          if (el.tagName !== 'SELECT') el.defaultValue = '';
          else Array.from(el.options || []).forEach(op => { op.selected = false; op.defaultSelected = false; });
        }
        Object.keys(el.dataset || {}).forEach(k => {
          if (/patient|paciente|case|encounter|record|document|signature|rascunho|finalizado/i.test(k) && !/watch|wire|bound|ligad/i.test(k)) delete el.dataset[k];
        });
      });
      document.querySelectorAll('.module form').forEach(f => {
        Object.keys(f.dataset || {}).forEach(k => {
          if (/patient|paciente|case|encounter|record|document|signature|rascunho|finalizado/i.test(k) && !/watch|wire|bound|ligad/i.test(k)) delete f.dataset[k];
        });
      });
      document.querySelectorAll('.module tbody, .module .dropdown-menu, .module .print-meta, .module .ficha-resumo, .module .banner, .module [id$="-docs-lista"], .module [id$="-adendos-lista"], .module [id$="-lab-extras"]').forEach(el => { el.textContent = ''; });
      ['meu-dia-lista','pl-fila-lista','orcamento-lista','ag-cal-dia','ag-cal-grid',
        'pre-med-lista','pre-procs-lista','pre-premed-lista','consulta-procs-resumo',
        'fin-anexos-lista','equipe-aux-lista','disp-detalhes-body','ficha-topbar',
        'auditoria-lista','equipe-nuvem-lista','global-search-results',
        'modal-title','modal-body','modal-footer','ppp'].forEach(id => {
        const el = document.getElementById(id); if (el) el.textContent = '';
      });
      document.querySelectorAll('.module canvas, #print-preview-overlay canvas, #sig-overlay canvas').forEach(canvas => {
        const ctx = canvas.getContext('2d'); if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
      });
      document.querySelectorAll('.signature-preview, .sig-preview').forEach(el => { el.textContent = ''; });
      const preview = document.getElementById('print-preview-overlay'); if (preview) preview.classList.remove('show');
      const badge = document.getElementById('dirty-badge'); if (badge) badge.classList.remove('show');
      try { modal.close(); } catch (e) {}
      try { ui.fecharDropdowns(); } catch (e) {}
      try { sigUI.fechar(false); sigUI._temConteudo = false; } catch (e) {}
    } catch (e) {}
    try {
      state.dirty = false; state.importTarget = null; state.sigDrawing = false;
    } catch (e) {}
    try { prontuario._docs = {}; } catch (e) {}
    try { linker._preBuscadaNaNuvem = {}; } catch (e) {}
    try {
      Object.keys(escritaContinua._timers || {}).forEach(k => clearTimeout(escritaContinua._timers[k]));
      escritaContinua._timers = {};
    } catch (e) {}
    /* Estes campos são buffers clínicos; catálogos, constantes e listeners
       permanecem disponíveis para o próximo login. */
    const limparBuffers = (obj, nivel = 0) => {
      if (!obj || typeof obj !== 'object' || nivel > 3) return;
      ['_lista','_dados','_sel','_linkPendente','_selecao','_ctx'].forEach(k => {
        if (!Object.prototype.hasOwnProperty.call(obj, k) || typeof obj[k] === 'function') return;
        obj[k] = k === '_lista' ? [] : (k === '_dados' || k === '_sel' ? {} : null);
      });
      Object.keys(obj).forEach(k => {
        if (obj[k] && typeof obj[k] === 'object' && !Array.isArray(obj[k]) && !/^[A-Z_]+$/.test(k)) limparBuffers(obj[k], nivel + 1);
      });
    };
    ['pre','consulta','anestesia','recuperacao','termo','prescricao','documentos','risco','financeiro','orcamento','captura'].forEach(k => { try { limparBuffers(window[k]); } catch (e) {} });
    try { pacientes._onSaveCallback = null; } catch (e) {}
    try { fin.finalizacao._ctx = null; } catch (e) {}
    try { printPreview._verCtx = null; printPreview._nomeArquivoOverride = null; } catch (e) {}
    try { equipeNuvem._ultimaLista = null; } catch (e) {}
    try {
      programador._orgs = []; programador._membros = []; programador._perfis = [];
      programador._shares = []; programador._legacySummary = []; programador._legacyItems = [];
    } catch (e) {}
  },

  /* ---------- Bloqueio/desbloqueio da UI ---------- */
  _bloquear() {
    const ov = document.getElementById('auth-overlay');
    const app = document.querySelector('.app');
    if (ov) ov.style.display = 'flex';
    if (app) app.style.filter = 'blur(4px)';
    if (app) app.style.pointerEvents = 'none';
    /* primeira execução: modo cadastro do admin */
    auth._render();
    setTimeout(() => { const el = document.getElementById(auth.temUsuarios() ? 'auth-user' : 'auth-user'); if (el) el.focus(); }, 100);
  },
  _desbloquear() {
    const ov = document.getElementById('auth-overlay');
    const app = document.querySelector('.app');
    if (ov) ov.style.display = 'none';
    if (app) { app.style.filter = ''; app.style.pointerEvents = ''; }
    auth._aplicarPermissoesUI();
    auth._iniciarTimer();
    /* Agora as duas identidades (app + Supabase) já correspondem ao contexto;
       só neste ponto o tempo real pode abrir o socket. */
    setTimeout(() => {
      try { realtime.conectar(); } catch (e) {}
      try { if (cloudRealtime.ativo()) cloudRealtime.conectar(); } catch (e) {}
    }, 80);
    /* O Ajustes manda também em quem já está dentro: confere agora e
       de tempos em tempos, sem pedir login de novo. */
    auth._agendarRevalidacao();
    setTimeout(() => { try { auth.revalidarAcesso({ silencioso: true }); } catch (e) {} }, 4000);
    /* Entrar sempre começa no Dashboard — é o painel do dia, e é onde estão a
       fila de conferência e as pendências. Cair no último módulo aberto fazia
       cada pessoa começar num lugar diferente, às vezes numa ficha alheia.
       Quem não tem acesso ao Dashboard vai para o primeiro módulo permitido. */
    const destino = auth.podeAcessar('dashboard')
      ? 'dashboard'
      : ((auth.MODULOS.find(m => auth.podeAcessar(m.key)) || {}).key || '');
    if (destino) {
      if ((location.hash || '').replace('#', '') === destino) {
        try { ui.navegar(destino); } catch (e) {}      /* já estava lá: só repinta */
      } else {
        location.hash = destino;
      }
    }
    try { const u = auth.usuarioAtual(); if (u) { const rl = auth._rotuloPapel(u.role); toast('Bem-vindo, ' + (u.nome || u.usuario) + (rl ? ' · ' + rl : '')); } } catch (e) {}
  },

  /* Renderiza a tela de login (ou o cadastro inicial do admin) */
  /* ---------- CHEGOU PELO LINK DE RECUPERAÇÃO ----------
     Quem clica no link é, por definição, quem NÃO consegue entrar. Exigir o
     login antes de deixar redefinir a senha da nuvem é um círculo fechado — e
     era o que acontecia: a janela abria com z-index 1290 atrás da tela de
     acesso, que tem 100000. Invisível.
     A definição da nova senha passa a acontecer AQUI, na própria tela de
     acesso, que é quem manda antes do login. */
  _telaNovaSenha() {
    const sub = document.getElementById('auth-sub');
    const foot = document.getElementById('auth-foot');
    const form = document.getElementById('auth-form');
    if (!form) return;
    sub.textContent = 'Definir nova senha da nuvem';
    form.innerHTML = `
      <p style="font-size:.85rem;color:var(--text-soft, #55606d);margin:0 0 12px;text-align:left">
        Você chegou pelo link do e-mail. Escolha a nova senha da <b>conta da nuvem</b> —
        é a que este e os outros aparelhos vão usar para entrar e sincronizar.</p>
      <div class="auth-field"><label>Nova senha</label><input type="password" id="auth-ns1" autocomplete="new-password" placeholder="12+ caracteres, maiúscula, número e símbolo"></div>
      <div class="auth-field"><label>Repita a nova senha</label><input type="password" id="auth-ns2" autocomplete="new-password" placeholder="Repita"></div>
      <div class="auth-error" id="auth-error"></div>
      <button type="submit" class="auth-btn">Salvar nova senha</button>`;
    form.onsubmit = (e) => { e.preventDefault(); auth._salvarNovaSenhaNuvem(); };
    foot.innerHTML = '<a href="javascript:void(0)" onclick="auth._render()" style="color:var(--text-mute);font-size:.82rem">← Voltar ao login</a>';
    setTimeout(() => { const el = document.getElementById('auth-ns1'); if (el) el.focus(); }, 80);
  },

  async _salvarNovaSenhaNuvem() {
    const err = document.getElementById('auth-error');
    const a = (document.getElementById('auth-ns1') || {}).value || '';
    const b = (document.getElementById('auth-ns2') || {}).value || '';
    const diz = t => { if (err) err.textContent = t; };
    const regra = cloud.validarSenha(a); if (!regra.ok) { diz(regra.erro); return; }
    if (a !== b) { diz('As duas senhas não são iguais.'); return; }
    diz('Salvando…');
    const ok = await cloud.trocarSenhaComToken(a);
    if (!ok) { diz('Não consegui salvar. O link pode ter vencido — peça outro.'); return; }
    diz('');
    auth._render();
    /* já deixa o e-mail preenchido: ela acabou de definir a senha, e o passo
       seguinte é entrar com ela — o e-mail veio dentro do próprio token */
    const el = document.getElementById('auth-email');
    if (el && cloud._emailRecuperado) el.value = cloud._emailRecuperado;
    const pw = document.getElementById('auth-pass'); if (pw) pw.focus();
    toast('✅ Senha alterada. Entre com ela agora.', 'success');
  },

  _render() {
    const sub = document.getElementById('auth-sub');
    const foot = document.getElementById('auth-foot');
    const form = document.getElementById('auth-form');
    sub.textContent = 'Entre com sua conta (funciona em qualquer aparelho)';
    form.innerHTML = `
      <div class="auth-field"><label>E-mail</label><input type="email" id="auth-email" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="seu@email.com"></div>
      <div class="auth-field"><label>Senha</label><input type="password" id="auth-pass" autocomplete="current-password" placeholder="Sua senha"></div>
      <div class="auth-error" id="auth-error"></div>
      <button type="submit" class="auth-btn">Entrar</button>`;
    form.onsubmit = (e) => { e.preventDefault(); auth.tentarLoginNuvem(); };
    foot.innerHTML =
      /* "Criar conta" SAIU daqui. Quem decide quem entra na clínica é quem
         responde por ela — e a porta aberta fazia o contrário: qualquer pessoa
         com o endereço do app abria uma conta, e o gestor só descobria depois,
         se descobrisse. Agora a conta é criada no módulo Programador.
         (Tirar o link é tirar a maçaneta: a tranca é desligar o cadastro
         público no painel do Supabase — está dito no README da função.) */
      '<a href="javascript:void(0)" onclick="auth._socorro()" style="color:var(--text-mute);font-size:.8rem">Problemas para entrar?</a>' +
      '<div style="margin-top:6px;font-size:.78rem;color:var(--text-mute)">Não tem acesso? Peça ao responsável pela clínica — as contas são criadas por ele.</div>' +
      '<div style="margin-top:12px;font-size:.72rem;color:var(--text-mute);line-height:1.55;text-align:center">' +
        '🔒 Acesso restrito a profissionais autorizados. Os dados são separados por clínica e protegidos por controles de acesso. A adequação jurídica e de segurança depende também das políticas e da operação de cada organização.' +
      '</div>';
      /* “Usuário local (equipe)” e “Modo demonstração” foram tirados da tela de
         login (por enquanto): a conta da nuvem é a identidade única — tudo
         sincronizado e igual em qualquer aparelho. O código segue no app. */
  },

  /* ---------- LOGIN UNIFICADO PELA NUVEM ----------
     A conta Supabase é a única identidade. Se a página permanece aberta e a
     conexão cai, a sessão atual continua; depois de fechar/sair, não existe
     desbloqueio offline por senha copiada no aparelho. */
  async tentarLoginNuvem() {
    const id = (document.getElementById('auth-email').value || '').trim().toLowerCase();
    const senha = document.getElementById('auth-pass').value || '';
    const errEl = document.getElementById('auth-error');
    errEl.textContent = '';
    if (!id || !senha) { errEl.textContent = 'Preencha e-mail e senha.'; return; }
    if (!id.includes('@')) { errEl.textContent = 'Use o e-mail da sua conta da nuvem.'; return; }
    const espera = auth._throttleRestante();
    if (espera > 0) { errEl.textContent = 'Muitas tentativas. Aguarde ' + espera + 's e tente de novo.'; return; }

    const nuvemDisponivel = navigator.onLine && (() => { try { return cloud.estaConfigurado(); } catch (e) { return false; } })();
    if (nuvemDisponivel) {
        errEl.textContent = 'Verificando…';
        let ok = false;
        try { ok = await cloud.login(id, senha); } catch (e) { ok = false; }
        if (ok) {
          await auth._protegerTrocaDeConta();
          const contextoLogin = contextoAba.capturar();
          /* Fase 3: puxa papel/organização do servidor e deriva as permissões */
          let perfilNuvem = null;
          try { perfilNuvem = await cloud.buscarPerfil(); } catch (e) {}
          /* Login válido não prova a clínica. Se o perfil não respondeu, a
             tela continua bloqueada e nenhum cache/Realtime é aberto com
             metadado antigo. */
          if (!perfilNuvem) {
            errEl.textContent = 'A conta foi autenticada, mas não consegui confirmar sua clínica agora. Verifique a conexão e tente novamente.';
            return;
          }
          if (perfilNuvem && perfilNuvem.ativo === false) {
            try { cloud.logout({ silent: true }); } catch (e) {}
            errEl.textContent = 'Sua conta está inativa. Fale com o gestor da clínica.';
            return;
          }
          const sessaoNuvem = cloud.session();
          const uidNuvem = sessaoNuvem && sessaoNuvem.user && sessaoNuvem.user.id;
          if (!uidNuvem || perfilNuvem.uid !== uidNuvem) {
            try { contextoAba.limpar(); } catch (e) {}
            errEl.textContent = 'A identidade retornada pelo servidor não corresponde a esta sessão. Entre novamente.';
            return;
          }
          if (!contextoAba.mesmaGeracao(contextoLogin)) return;
          /* A organização confirmada vira contexto da aba ANTES de qualquer
             leitura local ou sincronização. */
          let entrada = null;
          if (perfilNuvem.organization_id) {
            entrada = await ambiente.aoEntrar(perfilNuvem.organization_id, '', perfilNuvem);
          } else if (perfilNuvem.semVinculo) {
            entrada = await ambiente.aoEntrarSemClinica(perfilNuvem);
          } else {
            errEl.textContent = 'O servidor não confirmou um ambiente de trabalho para esta conta.';
            return;
          }
          if (entrada && entrada.erro) return;
          const contextoConfirmado = contextoAba.capturar();
          if (contextoConfirmado.userId !== uidNuvem || !contextoConfirmado.verified ||
              String(contextoConfirmado.organizationId || '') !== String(perfilNuvem.organization_id || '')) return;
          const u = await auth._espelharUsuarioNuvem(id, perfilNuvem);
          if (!contextoAba.corresponde(contextoConfirmado)) return;
          auth._definirSessao(u);
          document.getElementById('auth-pass').value = '';
          auth._desbloquear();
          try { auth.exigirTrocaDeSenha(); } catch (e) {}
          auth._limparFalhas();
          try { cloud.autoSyncAoEntrar(); } catch (e) {}
          return;
        }
        auth._registrarFalha();
        /* A MENSAGEM VERDADEIRA NÃO PODE SER SOBRESCRITA AQUI. O login já
           descobriu o que o servidor respondeu — servidor fora, e-mail não
           confirmado, rajada de tentativas — e esta linha jogava tudo fora e
           escrevia "E-mail ou senha inválidos.", que é a única das hipóteses
           que acusa a pessoa. Foi o que a equipe inteira leu durante a queda,
           cada uma trocando a senha de uma conta que estava certa. */
        errEl.textContent = (() => {
          try { return cloud.motivoUltimaFalha() || 'E-mail ou senha inválidos.'; }
          catch (e) { return 'E-mail ou senha inválidos.'; }
        })();
      return;
    }
    errEl.textContent = 'Sem internet não é possível iniciar uma nova sessão. Se você já estava trabalhando nesta aba, não saia: a fila offline continua disponível.';
  },

  /* ENTRAR NO APP E NÃO ENTRAR NA NUVEM é o pior estado possível, porque
     ninguém o percebe: a tela abre igualzinha e simplesmente nada sobe nem
     desce. Acontece quando o aparelho guarda um ESPELHO com a senha ANTIGA —
     o app aceita essa senha (o espelho existe para funcionar offline), e a
     nuvem recusa, porque lá a senha é outra.

     O app tentava realinhar a nuvem só quando ela estava logada em OUTRA
     conta. Com a nuvem simplesmente DESLOGADA, não tentava nada e não dizia
     nada. Agora tenta com a mesma senha digitada e, se não der, diz qual é o
     motivo — inclusive o caso em que a culpa é do espelho velho daqui. */
  async _garantirNuvemDaConta(id, senha) {
    if (!id || id.indexOf('@') < 0) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    let configurado = false;
    try { configurado = cloud.estaConfigurado(); } catch (e) { return; }
    if (!configurado) return;
    try {
      if (cloud.estaLogado() && String(cloud.emailLogado() || '').toLowerCase() === id) return;
    } catch (e) {}
    let ok = false;
    try { ok = await cloud.login(id, senha, { silent: true }); } catch (e) { ok = false; }
    if (ok) {
      try { ok = !!(await cloud.confirmarContexto()); } catch (e) { ok = false; }
      if (ok) { try { cloud._atualizarUI(); } catch (e) {} return; }
    }
    let f = null;
    try { f = cloud._ultimaFalha; } catch (e) {}
    const tipo = (f && f.tipo) || '';
    let frase;
    if (tipo === 'credencial') {
      frase = 'Este aparelho aceitou uma senha ANTIGA guardada aqui — na nuvem a senha é outra. ' +
        'Use "Esqueci minha senha" na tela de entrada e entre com a nova.';
    } else {
      try { frase = cloud.motivoUltimaFalha(); } catch (e) { frase = ''; }
      frase = frase || 'Veja Ajustes → Nuvem e backups.';
    }
    toast('⚠️ Você entrou no app, mas NÃO na nuvem: nada vai subir nem descer. ' + frase, 'error');
  },

  /* Depois de um login pelo ESPELHO local, a sessão da nuvem pode ter ficado
     na conta de outra pessoa (ex.: a secretária entrou antes neste aparelho).
     Nesse estado tudo o que se grava sobe para a conta errada e "puxar da
     nuvem" não acha nada. Aqui a nuvem é realinhada com a conta do app:
     entra com a mesma senha que acabou de ser digitada e, se não conseguir,
     desconecta a nuvem em vez de deixar os dados irem para o lugar errado. */
  async _alinharNuvem(id, senha) {
    if (!id || id.indexOf('@') < 0) return;
    let configurado = false;
    try { configurado = cloud.estaConfigurado(); } catch (e) { return; }
    if (!configurado) return;
    const div = cloud.divergencia();
    if (!div) return;
    let ok = false;
    if (navigator.onLine) {
      try { cloud.logout({ silent: true }); } catch (e) {}
      try { ok = await cloud.login(id, senha); } catch (e) { ok = false; }
      if (ok) { try { ok = !!(await cloud.confirmarContexto()); } catch (e) { ok = false; } }
    }
    if (ok) return;
    try { cloud.logout({ silent: true }); } catch (e) {}
    toast('A nuvem estava conectada como ' + div.nuvem + '. Desconectei para não gravar nada na conta errada — entre na nuvem como ' + div.app + ' em Ajustes.', 'warn');
  },

  /* Mantém somente metadados não secretos para desenhar a interface. Não há
     credencial de desbloqueio offline: a autenticação pertence ao Supabase. */
  async _espelharUsuarioNuvem(email, perfilNuvem) {
    const usuarios = auth._lerUsuarios();
    const u = usuarios.find(x => x.usuario === email);
    /* Decide as permissões:
       1) papel do servidor conhecido → usa o mapa ROLE_PERMS;
       2) sem papel, mas já havia espelho → preserva o que estava valendo;
       3) 1º acesso sem vínculo no banco → dono/legado (admin). */
    let perms;
    if (perfilNuvem && auth._permsPersonalizadas(perfilNuvem)) {
      /* 0) o gestor personalizou o acesso desta pessoa (guardado na nuvem) —
         isso vence até o padrão do papel, em qualquer aparelho */
      perms = auth._permsPersonalizadas(perfilNuvem);
    } else if (perfilNuvem && auth._permsDoPapel(perfilNuvem.role)) {
      /* 1) papel definido no servidor MANDA — sempre (mesmo que o aparelho
         tenha um espelho antigo mais permissivo) */
      perms = auth._permsDoPapel(perfilNuvem.role);
    } else if (perfilNuvem && perfilNuvem.semVinculo && !auth._ehProgramador(email)) {
      /* Sem organization_id não existe destino clínico autorizado. Mantém
         apenas Ajustes para criar a própria clínica ou atualizar o vínculo. */
      const base = auth.PERFIS.sem_clinica;
      perms = { perfil: 'sem_clinica', modulos: base.modulos.slice(), soImpressao: [] };
    } else if (u && Array.isArray(u.modulos) && u.modulos.length) {
      /* 2) sem papel no servidor: preserva o que o gestor definiu aqui */
      perms = { perfil: u.perfil, modulos: u.modulos, soImpressao: u.soImpressao || [] };
    } else if (!usuarios.length) {
      /* 3) PRIMEIRA conta deste aparelho e sem vínculo na nuvem → é o dono */
      perms = { perfil: 'admin', modulos: auth.PERFIS.admin.modulos.slice(), soImpressao: [] };
    } else {
      /* 4) conta NOVA num aparelho que já tem gente e sem papel definido na
         nuvem → entra RESTRITA (secretária). Antes virava administradora
         automaticamente — a secretária ficava com acesso total. O gestor
         define o papel real em Ajustes → Equipe da nuvem. */
      const base = auth.PERFIS.secretaria;
      perms = { perfil: 'secretaria', modulos: base.modulos.slice(), soImpressao: (base.soImpressao || []).slice() };
      try { toast('Sua conta ainda não tem papel definido nesta clínica — acesso restrito até o gestor liberar.', 'warn'); } catch (e) {}
    }
    const dados = {
      usuario: email,
      nome: (perfilNuvem && perfilNuvem.nome) || (u && u.nome) || email.split('@')[0],
      perfil: perms.perfil,
      modulos: (perms.modulos || []).slice(),
      soImpressao: (perms.soImpressao || []).slice(),
      nuvem: true,
      role: (perfilNuvem && perfilNuvem.role) || (u && u.role) || null,
      organization_id: (perfilNuvem && perfilNuvem.organization_id) || (u && u.organization_id) || null,
      uid: (perfilNuvem && perfilNuvem.uid) || (u && u.uid) || null
    };
    let alvo = u;
    if (!alvo) { alvo = {}; usuarios.push(alvo); }
    Object.assign(alvo, dados);
    delete alvo.senhaHash;
    delete alvo.senhaKdf;
    /* Todo usuário PRECISA de id: é por ele que a lista de Ajustes identifica
       "(você)" e que os botões ✏️/🗑️ acham a pessoa. Espelhos antigos foram
       criados sem id — sem isto, os botões não tinham ação. */
    if (!alvo.id) alvo.id = 'u_' + (typeof utils !== 'undefined' && utils.uid ? utils.uid() : String(Date.now()) + Math.random().toString(16).slice(2));
    auth._salvarUsuarios(usuarios);
    return alvo;
  },

  /* O e-mail é o do programador? (nunca é rebaixado por falta de vínculo) */
  _ehProgramador(email) {
    try { return String(email || '').toLowerCase() === (typeof programador !== 'undefined' ? programador.EMAIL : 'mpcaliman@hotmail.com'); }
    catch (e) { return false; }
  },

  /* Repara espelhos antigos sem id (uma vez, na inicialização) */
  _repararIds() {
    try {
      const lista = auth._lerUsuarios();
      let mudou = false;
      lista.forEach(u => {
        if (u && !u.id) {
          u.id = 'u_' + (utils.uid ? utils.uid() : String(Date.now()) + Math.random().toString(16).slice(2));
          mudou = true;
        }
      });
      if (mudou) {
        auth._salvarUsuarios(lista);
        /* a sessão em curso também precisa do id certo */
        const s = auth.usuarioAtual();
        if (s && !s.id && s.usuario) {
          const eu = lista.find(x => x.usuario === s.usuario);
          if (eu) auth._definirSessao(eu);
        }
      }
      return mudou;
    } catch (e) { return false; }
  },

  /* Rebusca o papel na nuvem e re-espelha (sem pedir senha de novo).
     Usado quando o gestor acabou de mudar o papel de alguém — ou quando o
     próprio usuário virou gestor da clínica. */
  async atualizarPapelDaNuvem() {
    try {
      if (!cloud.estaConfigurado() || !cloud.estaLogado()) return null;
      const contextoInicial = contextoAba.capturar();
      const sessaoInicial = cloud.session();
      const uidInicial = sessaoInicial && sessaoInicial.user && sessaoInicial.user.id;
      if (!uidInicial) return null;
      const perfil = await cloud.buscarPerfil();
      if (!perfil) return null;
      const sessaoNuvem = cloud.session();
      const uidNuvem = sessaoNuvem && sessaoNuvem.user && sessaoNuvem.user.id;
      if (!uidNuvem || uidNuvem !== uidInicial || perfil.uid !== uidNuvem ||
          !contextoAba.mesmaGeracao(contextoInicial)) return null;
      const atual = auth.usuarioAtual();
      const email = (perfil.email || (atual && atual.usuario) || '').toLowerCase();
      if (!email) return null;
      const lista = auth._lerUsuarios();
      const u = lista.find(x => x.usuario === email);
      if (!u) return null;
      const perms = auth._permsPersonalizadas(perfil) || auth._permsDoPapel(perfil.role);
      if (perms) {
        u.perfil = perms.perfil;
        u.modulos = (perms.modulos || []).slice();
        u.soImpressao = (perms.soImpressao || []).slice();
      } else if (perfil.semVinculo && !auth._ehProgramador(email)) {
        /* Sem clínica, nenhum formulário clínico pode criar um acervo local
           órfão. Ajustes permanece disponível para concluir o vínculo. */
        const base = auth.PERFIS.sem_clinica;
        u.perfil = 'sem_clinica';
        u.modulos = base.modulos.slice();
        u.soImpressao = [];
        u.role = null;
      }
      u.role = perfil.role || u.role || null;
      /* Resposta CLARA de que a conta não tem clínica: o aparelho esquece a
         que guardou. (Falha de rede devolve null e nem chega aqui.) */
      if (perfil.semVinculo) {
        u.organization_id = null;
      } else {
        u.organization_id = perfil.organization_id || null;
      }
      u.uid = perfil.uid || u.uid || null;
      /* AQUI é o único lugar em que a organização vem do SERVIDOR, conferida.
         É por isso que a troca de ambiente acontece neste ponto e não no
         login: trocar a gaveta por palpite é tirar de alguém o acesso ao
         próprio trabalho. A limpeza vem ANTES de qualquer sincronização —
         quem acabou de entrar não pode ver a clínica anterior nem por um
         instante. */
      let entrada = null;
      try { if (u.organization_id) entrada = await ambiente.aoEntrar(u.organization_id, '', perfil); } catch (e) { return null; }
      /* CONTA SEM CLÍNICA NÃO HERDA A DE QUEM ENTROU ANTES.
         Este `if` tinha só o ramo verdadeiro: quem não tem clínica não mexia
         no ponteiro do ambiente — e o ponteiro continuava apontando para a
         clínica da pessoa anterior naquele computador. Resultado real: uma
         conta recém-criada, sem vínculo nenhum, entrou e caiu dentro de
         "Minha Clínica de Anestesia", com os pacientes de outro médico à
         vista. O servidor dizia "esta conta não pertence a clínica nenhuma" e
         o aparelho respondia abrindo a gaveta da última que passou por ali.

         Ausência de clínica é uma RESPOSTA, não um silêncio: ela tem de
         apagar o ponteiro, não deixá-lo como estava. */
      try {
        if (!u.organization_id && perfil.semVinculo) entrada = await ambiente.aoEntrarSemClinica(perfil);
      } catch (e) { return null; }
      if (entrada && entrada.erro) return null;
      const contextoFinal = contextoAba.capturar();
      if (!contextoFinal.verified || contextoFinal.userId !== uidNuvem ||
          String(contextoFinal.organizationId || '') !== String(u.organization_id || '')) return null;
      auth._salvarUsuarios(lista);
      if (atual && atual.usuario === email) {
        auth._definirSessao(u);
        try { auth._aplicarPermissoesUI(); } catch (e) {}
      }
      return u;
    } catch (e) { return null; }
  },

  /* Fecha o contexto anterior assim que outra identidade autentica. A antiga
     pergunta de limpeza usava um UID global do navegador e podia apagar a
     gaveta que outra aba ainda utilizava. O cofre por organização e o
     contexto por aba tornam essa decisão destrutiva desnecessária. */
  async _protegerTrocaDeConta() {
    try {
      const s = cloud.session();
      const uid = s && s.user && s.user.id;
      if (uid) contextoAba.prepararUsuario(uid);
    } catch (e) {}
  },

  /* ---------- Login local legado: encerrado ---------- */
  _mostrarLoginLocal() {
    const sub = document.getElementById('auth-sub');
    const form = document.getElementById('auth-form');
    const foot = document.getElementById('auth-foot');
    sub.textContent = 'Acesso local desativado';
    form.innerHTML = '<p style="font-size:.86rem;line-height:1.55">Para proteger o prontuário, contas locais e cópias de senha não abrem mais dados clínicos. Entre com a conta da nuvem.</p>' +
      '<button type="button" class="auth-btn" onclick="auth._render()">Entrar com e-mail</button>';
    form.onsubmit = (e) => e.preventDefault();
    foot.innerHTML = '';
  },

  /* A exigência aparece DEPOIS de entrar, não antes: a pessoa já está dentro,
     com a conta dela, e o que falta é só trocar a senha que outra pessoa
     escolheu. Barrar a entrada aqui seria transformar uma troca de senha num
     segundo login — e quem não conseguisse concluir ficaria sem acesso. */
  exigirTrocaDeSenha() {
    if (!cloud.deveTrocarSenha()) return false;
    auth._abrirTrocaObrigatoria();
    return true;
  },
  _abrirTrocaObrigatoria() {
    modal.open('🔑 Defina a sua senha',
      '<p style="font-size:.88rem;margin:0 0 10px">Você entrou com uma <b>senha provisória</b>, criada por quem liberou o seu acesso. ' +
      'Escolha agora a sua senha — a provisória deixa de valer.</p>' +
      '<div class="grid">' +
      '<div class="field col-12"><label>Nova senha</label><input type="password" id="tso-1" autocomplete="new-password" placeholder="12+ caracteres, maiúscula, número e símbolo"></div>' +
      '<div class="field col-12"><label>Repita a nova senha</label><input type="password" id="tso-2" autocomplete="new-password"></div>' +
      '</div><div id="tso-erro" style="color:#b3261e;font-size:.82rem;min-height:16px"></div>',
      '<button class="btn btn-primary" onclick="auth._salvarTrocaObrigatoria()">Salvar e continuar</button>');
    setTimeout(() => { const el = document.getElementById('tso-1'); if (el) el.focus(); }, 120);
  },
  async _salvarTrocaObrigatoria() {
    const a = (document.getElementById('tso-1') || {}).value || '';
    const b = (document.getElementById('tso-2') || {}).value || '';
    const err = document.getElementById('tso-erro');
    const dizer = (t) => { if (err) err.textContent = t; };
    const regra = cloud.validarSenha(a); if (!regra.ok) { dizer(regra.erro); return; }
    if (a !== b) { dizer('As senhas não conferem.'); return; }
    dizer('Salvando…');
    const r = await cloud.trocarSenhaLogado(a);
    if (!r.ok) { dizer(r.erro || 'Não consegui trocar a senha agora.'); return; }
    modal.close();
    toast('🔑 Senha definida. É com ela que você entra a partir de agora.');
  },

  /* ---------- Cadastro público: REMOVIDO ----------
     Havia aqui uma tela "Criar conta (novo administrador)" aberta a qualquer
     pessoa que soubesse o endereço do app. Num sistema de prontuário isso é o
     avesso do que deve ser: quem decide quem entra na clínica é quem responde
     por ela. As contas passam a nascer no módulo Programador, por quem
     autoriza, com senha provisória e troca obrigatória no primeiro acesso.

     `cloud.signup()` continua existindo (é a chamada crua ao servidor) mas
     não tem mais nenhum caminho de tela — e o cadastro público é desligado
     no painel do Supabase, que é a tranca de verdade:
       Authentication → Sign In / Providers → Email → "Allow new users to sign up" OFF
     Sem desligar lá, o endereço /auth/v1/signup segue aceitando a chave
     pública, e tirar o botão daqui é tirar só a maçaneta. */

  /* ---------- Recuperação controlada pelo Supabase ---------- */
  _socorro() {
    const form = document.getElementById('auth-form');
    const foot = document.getElementById('auth-foot');
    const sub = document.getElementById('auth-sub');
    sub.textContent = 'Recuperar senha da nuvem';
    form.innerHTML = `
      <p style="font-size:.84rem;line-height:1.5">Informe seu e-mail. O servidor enviará um link de uso único; o aplicativo não conhece nem guarda sua senha.</p>
      <div class="auth-field"><label>E-mail da conta</label><input type="email" id="auth-rec-email" autocapitalize="none" autocomplete="username" placeholder="seu@email.com"></div>
      <div class="auth-error" id="auth-error"></div>
      <button type="submit" class="auth-btn">Enviar link de recuperação</button>`;
    form.onsubmit = (e) => { e.preventDefault(); auth._executarSocorro(); };
    foot.innerHTML = '<a href="javascript:void(0)" onclick="auth._render()" style="color:var(--primary);font-size:.85rem">← Voltar ao login</a>';
  },

  async _executarSocorro() {
    const errEl = document.getElementById('auth-error');
    errEl.textContent = '';
    const email = (document.getElementById('auth-rec-email').value || '').trim();
    if (!email || email.indexOf('@') < 0) { errEl.textContent = 'Informe um e-mail válido.'; return; }
    errEl.textContent = 'Enviando…';
    const ok = await cloud.recuperarSenha(email);
    if (!ok) { errEl.textContent = 'Não foi possível pedir a recuperação agora.'; return; }
    errEl.textContent = 'Confira o e-mail e também a caixa de spam.';
  },

  async _criarAdminInicial() {
    auth._render();
  },

  /* Esconde da sidebar os módulos sem permissão */
  _aplicarPermissoesUI() {
    document.querySelectorAll('#sidebar-nav .nav-item').forEach(item => {
      const mod = item.dataset.module;
      item.style.display = auth.podeAcessar(mod) ? '' : 'none';
    });
    /* nome do usuário no rodapé da sidebar */
    const u = auth.usuarioAtual();
    const foot = document.querySelector('.sidebar-footer');
    if (foot && u) {
      let badge = document.getElementById('sidebar-user');
      if (!badge) {
        badge = document.createElement('div');
        badge.id = 'sidebar-user';
        badge.style.cssText = 'margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,.12);font-size:.72rem';
        foot.appendChild(badge);
      }
      /* Prefere o papel real do servidor (Fase 3); cai no perfil local se não houver */
      const perfilLabel = auth._rotuloPapel(u.role) || (auth.PERFIS[u.perfil] || {}).label || u.perfil;
      badge.innerHTML = `👤 <strong>${utils.escapeHTML(u.nome || u.usuario)}</strong><br><span style="opacity:.6">${utils.escapeHTML(perfilLabel)}</span> · <a href="#" onclick="event.preventDefault(); auth.logout()" style="color:#7fd3e8">Sair</a>`;
    }
  },

  /* Aplica o modo "somente impressão" a um módulo: bloqueia edição do formulário
     e esconde os botões que gravam/alteram; mantém visualizar/imprimir/exportar. */
  /* Retorna o seletor das regiões editáveis (edição parcial) para o usuário
     atual neste módulo, ou null se não houver restrição parcial. */
  /* A edição parcial trancava, campo a campo, o que a auxiliar podia preencher.
     Ela existia porque o registro dela ia direto para o prontuário. Com o
     PRÉ-LANÇAMENTO isso mudou: ela prepara a ficha inteira e o médico confere e
     finaliza depois — a validação virou uma etapa explícita, não uma trava de
     campo. Travar agora só cria atrito sem proteger nada.
     O que continua sendo só do médico é o FINALIZAR (ver _aplicarLeitura). */
  edicaoParcialDe(mod) { return null; },

  _aplicarLeitura(mod) {
    const el = document.getElementById('module-' + mod);
    if (!el) return;
    const logado = auth.estaLogado();
    const leitura = logado && !auth.podeEditar(mod);
    /* Edição parcial só quando o módulo NÃO está em só-impressão */
    const parcialSel = (logado && !leitura) ? auth.edicaoParcialDe(mod) : null;

    el.classList.toggle('somente-impressao', leitura);
    el.classList.toggle('edicao-parcial', !!parcialSel);

    /* Marca as regiões liberadas (limpa marcações antigas primeiro) */
    el.querySelectorAll('.campo-liberado').forEach(x => x.classList.remove('campo-liberado'));
    if (parcialSel) { try { el.querySelectorAll(parcialSel).forEach(x => x.classList.add('campo-liberado')); } catch (e) {} }

    el.querySelectorAll('.action-bar .btn').forEach(b => {
      const oc = (b.getAttribute('onclick') || '').toLowerCase();
      const muta = /\.salvar|\.finalizar|\.novo\(|\.nova\(|\.excluir|\.limpar\(|\.duplicar|\.salvarcomonovo|importarjson|actions\.importar|abrirnovo|assinar/.test(oc);
      if (!muta) return;
      if (leitura) { b.style.display = 'none'; return; }
      if (parcialSel) {
        /* No modo parcial mantém Salvar/Novo; esconde finalizar/assinar/excluir */
        const proibido = /\.finalizar|\.excluir|assinar/.test(oc);
        b.style.display = proibido ? 'none' : '';
      } else b.style.display = '';
    });

    /* Finalizar e assinar são atos do MÉDICO. Fica por último de propósito: o
       laço acima reexibe os botões quando não há bloqueio, e isto desfaria. */
    const soPreLanca = (() => {
      try { return typeof preLanc !== 'undefined' && preLanc.ehAuxiliar(); } catch (e) { return false; }
    })();
    el.querySelectorAll('.btn, button').forEach(b => {
      const oc = ((b.getAttribute('onclick') || '') + ' ' + (b.textContent || '')).toLowerCase();
      const ehFinalizar = /\.finalizar|assinar/.test(oc) && !/lançamento|lancamento/.test(oc);
      if (!ehFinalizar) return;
      b.style.display = soPreLanca ? 'none' : '';
    });

    /* Banners: só-impressão (laranja) e edição parcial (verde) */
    const setBanner = (id, cls, html, mostrar) => {
      let ban = document.getElementById(id);
      if (mostrar) {
        if (!ban) {
          ban = document.createElement('div');
          ban.id = id; ban.className = cls; ban.innerHTML = html;
          const form = el.querySelector('form');
          if (form && form.parentNode) form.parentNode.insertBefore(ban, form); else el.prepend(ban);
        }
        ban.style.display = '';
      } else if (ban) { ban.style.display = 'none'; }
    };
    setBanner('ro-banner-' + mod, 'ro-banner',
      '🔒 Modo <strong>somente impressão</strong> — você pode visualizar e imprimir, mas não editar ou salvar neste módulo.', leitura);
    setBanner('pp-banner-' + mod, 'parcial-banner',
      '✏️ <strong>Edição parcial</strong> — você preenche as seções destacadas: <b>identificação</b>, <b>anamnese</b>, <b>sinais vitais e exames</b> e <b>pareceres de outras clínicas</b>. Exame físico, classificação de risco e conclusão são do anestesiologista.', !!parcialSel);
  },

  /* ---------- Timeout de inatividade (5 min) ---------- */
  /* O bloqueio é sempre obrigatório. Valores antigos 0/-1 eram opções de
     aparelho individual; não são seguros num produto desenhado para troca de
     usuários no mesmo computador e passam a ser normalizados para 5 minutos. */
  TIMEOUT_KEY: 'medsys.v7.auth.timeout_min',
  DIA_KEY: 'medsys.v7.auth.sessao_dia',
  _timeoutMin() {
    const v = parseInt(localStorage.getItem(auth.TIMEOUT_KEY), 10);
    return [2, 5, 10, 15, 30].indexOf(v) >= 0 ? v : 5;
  },
  _timeoutMs() { return auth._timeoutMin() * 60 * 1000; },
  _modoDiario() {
    try { localStorage.removeItem(auth.DIA_KEY); } catch (e) {}
    return false;
  },
  _salvarSessaoDiaria(sess) {
    try { localStorage.removeItem(auth.DIA_KEY); } catch (e) {}
    return false;
  },
  /* Compatibilidade de limpeza: versões antigas podem ter deixado o marcador.
     Ele nunca autentica nem restaura uma sessão. */
  _restaurarSessaoDiaria() {
    try { localStorage.removeItem(auth.DIA_KEY); } catch (e) {}
    return false;
  },
  definirTimeout(min) {
    const seguro = [2, 5, 10, 15, 30].indexOf(Number(min)) >= 0 ? Number(min) : 5;
    localStorage.setItem(auth.TIMEOUT_KEY, String(seguro));
    try { localStorage.removeItem(auth.DIA_KEY); } catch (e) {}
    const seletor = document.getElementById('seg-timeout'); if (seletor) seletor.value = String(seguro);
    toast('🔒 Bloqueio automático: ' + seguro + ' min');
    if (auth.estaLogado()) auth._resetTimer();
  },
  bloquearAgora() { if (auth.estaLogado()) auth.logout(); },

  _iniciarTimer() {
    auth._pararTimer();
    const reset = () => auth._resetTimer();
    ['click','keydown','mousemove','touchstart','scroll'].forEach(ev =>
      document.addEventListener(ev, reset, { passive: true }));
    auth._resetTimer();
  },
  _resetTimer() {
    if (!auth.estaLogado()) return;
    clearTimeout(auth._timer);
    const ms = auth._timeoutMs();
    if (!ms) return;   /* 0 = nunca bloqueia por inatividade */
    auth._timer = setTimeout(() => {
      toast('Sessão bloqueada por inatividade');
      auth.logout();
    }, ms);
  },
  _pararTimer() { clearTimeout(auth._timer); auth._timer = null; },

  /* Anti-força-bruta: após 5 senhas erradas, bloqueia por 30 s. */
  _falhas: 0, _bloqueioAte: 0,
  _throttleRestante() { const r = Math.ceil((auth._bloqueioAte - Date.now()) / 1000); return r > 0 ? r : 0; },
  _registrarFalha() {
    auth._falhas++;
    if (auth._falhas >= 5) { auth._bloqueioAte = Date.now() + 30000; auth._falhas = 0; }
  },
  _limparFalhas() { auth._falhas = 0; auth._bloqueioAte = 0; },

  /* Migração: usuários antigos com acesso ao Receituário ganham também o novo
     módulo Documentos (mesmo nível), para não perder o fluxo de atestados. */
  _migrarDocumentos() {
    try {
      const lista = auth._lerUsuarios();
      let mudou = false;
      lista.forEach(u => {
        if (u.perfil === 'admin') return;
        if (Array.isArray(u.modulos) && u.modulos.includes('prescricao') && !u.modulos.includes('documentos')) {
          u.modulos.push('documentos');
          if (Array.isArray(u.soImpressao) && u.soImpressao.includes('prescricao') && !u.soImpressao.includes('documentos')) {
            u.soImpressao.push('documentos');
          }
          mudou = true;
        }
      });
      if (mudou) auth._salvarUsuarios(lista);
    } catch (e) {}
  },

  /* Migração: secretárias já cadastradas ganham o novo fluxo — acesso à pré
     (edição parcial), termo e orçamento; e "documentos" deixa de ser só
     impressão (agora ela emite atestado/declaração). */
  _migrarSecretaria() {
    try {
      const lista = auth._lerUsuarios();
      let mudou = false;
      lista.forEach(u => {
        if (u.perfil !== 'secretaria') return;
        if (Array.isArray(u.modulos)) {
          ['pre','termo','orcamento'].forEach(m => { if (!u.modulos.includes(m)) { u.modulos.push(m); mudou = true; } });
        }
        if (Array.isArray(u.soImpressao) && u.soImpressao.includes('documentos')) {
          u.soImpressao = u.soImpressao.filter(x => x !== 'documentos'); mudou = true;
        }
      });
      if (mudou) auth._salvarUsuarios(lista);
    } catch (e) {}
  },

  /* ---------- Init: chamado no carregamento ---------- */
  init() {
    if (!auth._ouvindoContexto) {
      auth._ouvindoContexto = true;
      try {
        window.addEventListener('medsys:auth-event', ev => {
          const tipo = ev && ev.detail && ev.detail.type;
          if (!/^(lock|logout)$/.test(tipo || '')) return;
          auth.logout({ broadcast: false });
        });
        /* pagehide também cobre BFCache: voltar à página exige autenticação,
           enquanto a fila cifrada já persistida continua na gaveta do dono.
           Fechar uma aba não encerra o trabalho das outras abas da conta. */
        window.addEventListener('pagehide', () => auth.logout({ broadcast: false }));
        contextoAba.aoMudar((atual, anterior) => {
          if (anterior && anterior.userId &&
              (atual.userId !== anterior.userId || atual.organizationId !== anterior.organizationId)) auth._limparDadosDaTela();
        });
      } catch (e) {}
    }
    auth._migrarDocumentos();
    auth._migrarSecretaria();
    /* logo na tela de login */
    try {
      const img = document.querySelector('#sidebar-logo img');
      const authImg = document.getElementById('auth-logo-img');
      if (img && authImg && img.src) authImg.src = img.src;
    } catch (e) {}
    /* Modo demonstração: entra direto num ambiente de teste, sem login */
    if (typeof demo !== 'undefined' && demo.ativo()) {
      demo._garantirSessao();
      auth._desbloquear();
      demo._mostrarBanner();
      return;
    }
    /* Nunca reabre a aplicação por um espelho local. Uma nova aba precisa da
       identidade Supabase; se a aba já estava aberta, sua sessão continua em
       sessionStorage e o trabalho offline permanece disponível normalmente. */
    try { auth._restaurarSessaoDiaria(); } catch (e) {}
    if (auth.estaLogado()) {
      auth._desbloquear();
    } else {
      auth._bloquear();
    }
  }
};

/* FIM DA PLATAFORMA DE AUTENTICAÇÃO */
