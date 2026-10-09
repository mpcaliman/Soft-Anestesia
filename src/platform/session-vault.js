'use strict';

/* ============================================================================
   MODO DEMONSTRAÇÃO — isolamento de armazenamento
   Quando ligado (flag 'medsys.v7.demo'), TODAS as chaves de dados são
   redirecionadas para um espaço separado com prefixo 'demo:'. Assim o banco
   real do usuário fica intocado e o teste começa vazio. A sincronização com a
   nuvem também é bloqueada (ver cloud.pushDoc/sincronizar). */
/* ============================================================================
   COFRE — uma gaveta de armazenamento por AMBIENTE (clínica)

   No servidor a separação já existia: ambiente = organização, RLS por
   organização, e leitura entre ambientes só quando o programador libera (e por
   módulo). O aparelho é que tinha UMA gaveta só. Enquanto foi um médico com
   uma clínica, ninguém percebeu.

   A primeira tentativa foi LIMPAR ao trocar de clínica. Não bastou, e a razão
   é estrutural: limpeza é um EVENTO, e evento falha. Se o login for offline,
   se o perfil com a organização chegar atrasado, se a página for recarregada,
   se houver uma segunda aba — os dados da outra clínica continuam ali,
   endereçáveis pela mesma chave de sempre. Foi exatamente o que aconteceu: o
   selo já dizia "Clínica Carlos Pedreira" e a tela mostrava Minha Clínica.

   Agora a separação é ESTRUTURAL. Cada ambiente escreve e lê num conjunto de
   chaves próprio (`medsys.v3.anestesia@a1b2c3d4`), e o dado do outro ambiente
   não é apagado nem escondido: ele simplesmente NÃO É ENDEREÇÁVEL a partir
   daqui. Não existe evento para falhar.

   Como o app inteiro fala `localStorage.getItem('medsys...')` em centenas de
   lugares, o desvio é feito num ponto só — este — trocando o `localStorage`
   por uma fachada que sabe em que gaveta está. Assim não há como alguém
   escrever uma chave nova amanhã e furar o isolamento sem perceber.

   A regra é AO CONTRÁRIO da lista antiga: tudo o que é `medsys.*` vai para a
   gaveta do ambiente, MENOS uma lista explícita do que é do aparelho (login,
   tema, endereço da nuvem). Chave nova que eu esqueça de classificar fica
   isolada — o erro cai para o lado seguro. Na lista antiga, chave esquecida
   vazava.
============================================================================ */
/* ============================================================================
   CONTEXTO IMUTÁVEL DA ABA

   `localStorage` é compartilhado por todas as abas da origem. Por isso ele
   nunca pode decidir qual usuário ou clínica recebe uma leitura/escrita: uma
   aba poderia mudar o ponteiro enquanto outra ainda salva uma ficha. O
   contexto operacional pertence ao documento autenticado, é confirmado pelo
   perfil Supabase e recebe uma geração nova em cada troca controlada. Uma
   cópia em `sessionStorage` serve ao documento em execução; nunca autoriza um
   documento novo, pois o navegador pode restaurá-la mesmo após uma queda.

   O identificador do aparelho é não clínico e serve somente para devolver a
   fila offline ao mesmo aparelho. O BroadcastChannel transporta apenas
   bloqueio/logout da MESMA conta; clínica jamais é publicada nele.
============================================================================ */
const contextoAba = (() => {
  const CONTEXT_KEY = 'medsys.v7.tab.contexto';
  const DEVICE_KEY = 'medsys.v7.device_id';
  const LEASES_KEY = 'medsys.v7.tab.leases';
  const LEGACY_ORG_KEY = 'medsys.v7.cloud.org_id';
  const LEGACY_NAME_KEY = 'medsys.v7.ambiente.nome';
  const AUTH_KEY = 'medsys.v7.auth.session';
  const AUTH_DAY_KEY = 'medsys.v7.auth.sessao_dia';
  const CLOUD_KEY = 'medsys.v7.cloud.session';
  const listeners = [];
  let canal = null;
  let real = null;

  try { real = window.localStorage; } catch (e) { real = null; }
  /* A fronteira de acesso é o boot, não o evento de fechamento. Chromium pode
     recuperar sessionStorage ao restaurar uma aba após SIGKILL, sem disparar
     pagehide. Não há credencial do documento anterior que autorize este.
     Não tocamos no IndexedDB: pendências cifradas continuam pertencendo ao
     usuário/clínica/aparelho e exigem uma nova autenticação para abrir. */
  const limparCredenciais = loja => {
    if (!loja) return;
    const credenciais = [AUTH_KEY, AUTH_DAY_KEY, CLOUD_KEY, 'medsys.v7.pdfbk.token'];
    const chaves = [];
    try {
      for (let i = 0; i < loja.length; i++) {
        const k = loja.key(i);
        if (k && credenciais.some(base => k === base || k.startsWith(base + '@'))) chaves.push(k);
      }
      credenciais.concat(chaves).forEach(k => { try { loja.removeItem(k); } catch (e) {} });
      loja.removeItem(CONTEXT_KEY);
    } catch (e) {}
  };
  limparCredenciais(real);
  try { limparCredenciais(sessionStorage); } catch (e) {}

  const idNovo = (prefixo) => {
    try { if (crypto && crypto.randomUUID) return prefixo + crypto.randomUUID(); } catch (e) {}
    return prefixo + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  };
  const lerJSON = (loja, chave) => {
    try { return JSON.parse((loja && loja.getItem(chave)) || 'null'); } catch (e) { return null; }
  };
  const uidCloud = (s) => String((s && s.user && s.user.id) || '');
  const uidAuth = (s) => String((s && (s.uid || s.id)) || '');

  let deviceId = '';
  try {
    deviceId = (real && real.getItem(DEVICE_KEY)) || '';
    if (!deviceId) {
      deviceId = idNovo('dev-');
      if (real) real.setItem(DEVICE_KEY, deviceId);
    }
  } catch (e) { deviceId = idNovo('dev-efemero-'); }

  let estado = {
    version: 1,
    tabId: idNovo('tab-'),
    deviceId,
    userId: '',
    organizationId: '',
    role: '',
    organizationName: '',
    organizationsCount: null,
    semOrganizationConfirmed: false,
    verified: false,
    generation: 0,
    boundAt: ''
  };

  const copia = () => Object.freeze(Object.assign({}, estado));
  const salvar = () => {
    try { sessionStorage.setItem(CONTEXT_KEY, JSON.stringify(estado)); } catch (e) {}
  };
  const notificar = (anterior) => {
    const atual = copia();
    listeners.slice().forEach(fn => { try { fn(atual, anterior); } catch (e) {} });
  };
  const trocar = (patch, opts = {}) => {
    const anterior = copia();
    const proximo = Object.assign({}, estado, patch || {});
    const mudouDestino = anterior.userId !== proximo.userId ||
      anterior.organizationId !== proximo.organizationId ||
      anterior.verified !== proximo.verified;
    if (mudouDestino || opts.novaGeracao) proximo.generation = anterior.generation + 1;
    proximo.tabId = estado.tabId;
    proximo.deviceId = deviceId;
    estado = proximo;
    salvar();
    atualizarLease();
    if (mudouDestino || opts.notificar) notificar(anterior);
    return copia();
  };

  const sessaoAuthDisponivel = () => {
    return lerJSON(typeof sessionStorage !== 'undefined' ? sessionStorage : null, AUTH_KEY);
  };
  const sessaoCloudDisponivel = () =>
    lerJSON(typeof sessionStorage !== 'undefined' ? sessionStorage : null, CLOUD_KEY);

  /* Somente sessões criadas depois deste boot podem ser combinadas. As
     credenciais restauradas pelo navegador já foram removidas acima; um
     ponteiro legado isolado nunca abre uma clínica. */
  const restaurarDeSessoes = () => {
    const a = sessaoAuthDisponivel();
    const c = sessaoCloudDisponivel();
    const ua = uidAuth(a); const uc = uidCloud(c);
    if (!ua || !uc || ua !== uc) {
      if (estado.userId || estado.organizationId || estado.verified) trocar({
        userId: '', organizationId: '', role: '', organizationName: '',
        organizationsCount: null, semOrganizationConfirmed: false,
        verified: false, boundAt: ''
      });
      return false;
    }
    const orgAuth = String((a && a.organization_id) || '');
    let org = String(estado.organizationId || '');
    if (!org && real) {
      try {
        const legado = String(real.getItem(LEGACY_ORG_KEY) || '');
        if (legado && legado === orgAuth) org = legado;
      } catch (e) {}
    }
    if (org !== orgAuth) {
      trocar({ userId: '', organizationId: '', role: '', organizationName: '',
        organizationsCount: null, semOrganizationConfirmed: false,
        verified: false, boundAt: '' });
      return false;
    }
    let nome = estado.organizationName || '';
    if (!nome && org && real) { try { nome = real.getItem(LEGACY_NAME_KEY) || ''; } catch (e) {} }
    trocar({
      userId: uc,
      organizationId: org,
      role: (a && a.role) || estado.role || '',
      organizationName: nome,
      semOrganizationConfirmed: !org && !!estado.semOrganizationConfirmed,
      verified: !!org || !!estado.semOrganizationConfirmed,
      boundAt: estado.boundAt || new Date().toISOString()
    });
    return !!(org || estado.semOrganizationConfirmed);
  };

  const lerLeases = () => {
    const agora = Date.now();
    const lista = lerJSON(real, LEASES_KEY);
    return (Array.isArray(lista) ? lista : []).filter(x => x && x.tabId && Number(x.expiresAt) > agora);
  };
  function atualizarLease() {
    if (!real) return;
    try {
      const lista = lerLeases().filter(x => x.tabId !== estado.tabId);
      if (estado.verified && estado.userId) {
        lista.push({ tabId: estado.tabId, userId: estado.userId,
          organizationId: estado.organizationId || '', expiresAt: Date.now() + 45000 });
      }
      real.setItem(LEASES_KEY, JSON.stringify(lista.slice(-30)));
    } catch (e) {}
  }
  const removerLease = () => {
    if (!real) return;
    try { real.setItem(LEASES_KEY, JSON.stringify(lerLeases().filter(x => x.tabId !== estado.tabId))); } catch (e) {}
  };

  salvar();
  atualizarLease();
  try { setInterval(atualizarLease, 15000); } catch (e) {}
  try { window.addEventListener('pagehide', removerLease); } catch (e) {}
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      canal = new BroadcastChannel('medsys.v7.auth.events');
      canal.onmessage = ev => {
        const m = ev && ev.data;
        if (!m || !/^(lock|logout)$/.test(m.type) || !m.userId || m.userId !== estado.userId) return;
        try { window.dispatchEvent(new CustomEvent('medsys:auth-event', { detail: m })); } catch (e) {}
      };
    }
  } catch (e) { canal = null; }

  return {
    CONTEXT_KEY, DEVICE_KEY,
    atual: copia,
    capturar: copia,
    restaurarDeSessoes,
    aoMudar(fn) { if (typeof fn === 'function') listeners.push(fn); },
    prepararUsuario(userId, opts = {}) {
      userId = String(userId || '');
      if (!userId) return false;
      if (estado.userId === userId && !estado.verified) return true;
      if (estado.userId === userId && estado.verified && !opts.forcar) return true;
      trocar({ userId, organizationId: '', role: '', organizationName: '',
        organizationsCount: null, semOrganizationConfirmed: false,
        verified: false, boundAt: '' }, { novaGeracao: true });
      return true;
    },
    vincular(perfil, nome) {
      perfil = perfil || {};
      const c = sessaoCloudDisponivel();
      const userId = String(perfil.uid || uidCloud(c) || '');
      if (!userId || uidCloud(c) !== userId) return false;
      const org = String(perfil.organization_id || '');
      const sem = !!perfil.semVinculo && !org;
      if (!org && !sem) return false;
      trocar({ userId, organizationId: org, role: perfil.role || '',
        organizationName: nome != null ? String(nome || '') : estado.organizationName,
        organizationsCount: perfil.orgs == null ? estado.organizationsCount : Number(perfil.orgs),
        semOrganizationConfirmed: sem, verified: true,
        boundAt: estado.boundAt || new Date().toISOString() });
      /* O legado deixa de ser autoridade depois da primeira confirmação. */
      try { if (real) { real.removeItem(LEGACY_ORG_KEY); real.removeItem(LEGACY_NAME_KEY); } } catch (e) {}
      return true;
    },
    atualizarMetadados(meta) {
      meta = meta || {};
      const patch = {};
      if (Object.prototype.hasOwnProperty.call(meta, 'organizationName')) patch.organizationName = String(meta.organizationName || '');
      if (Object.prototype.hasOwnProperty.call(meta, 'role')) patch.role = String(meta.role || '');
      if (Object.prototype.hasOwnProperty.call(meta, 'organizationsCount')) patch.organizationsCount = meta.organizationsCount == null ? null : Number(meta.organizationsCount);
      trocar(patch);
    },
    limpar(opts = {}) {
      const userId = estado.userId;
      removerLease();
      trocar({ userId: '', organizationId: '', role: '', organizationName: '',
        organizationsCount: null, semOrganizationConfirmed: false,
        verified: false, boundAt: '' }, { novaGeracao: true });
      try { sessionStorage.removeItem(CONTEXT_KEY); } catch (e) {}
      if (opts.broadcast && canal && userId) { try { canal.postMessage({ type: opts.type || 'logout', userId }); } catch (e) {} }
    },
    organizationId() { return estado.verified ? estado.organizationId : ''; },
    operational() { return !!(estado.verified && estado.userId && estado.organizationId); },
    semOrganizacaoConfirmada() { return !!(estado.verified && estado.userId && estado.semOrganizationConfirmed && !estado.organizationId); },
    corresponde(snapshot) {
      return !!snapshot && snapshot.tabId === estado.tabId &&
        snapshot.generation === estado.generation && snapshot.userId === estado.userId &&
        snapshot.organizationId === estado.organizationId && estado.verified;
    },
    mesmaGeracao(snapshot) {
      return !!snapshot && snapshot.tabId === estado.tabId &&
        snapshot.generation === estado.generation && snapshot.userId === estado.userId;
    },
    compativelComSessoes(cloudSession, authSession) {
      if (!estado.verified || !estado.userId) return false;
      if (uidCloud(cloudSession) !== estado.userId || uidAuth(authSession) !== estado.userId) return false;
      return String((authSession && authSession.organization_id) || '') === estado.organizationId;
    },
    donoFila() {
      if (!this.operational()) return null;
      return { organizationId: estado.organizationId, userId: estado.userId,
        deviceId: estado.deviceId, tabId: estado.tabId };
    },
    outroAtivoNaOrganizacao(org) {
      org = String(org || '');
      return !!org && lerLeases().some(x => x.tabId !== estado.tabId && x.organizationId === org);
    },
    tabAtiva(tabId, userId, org) {
      return !!tabId && lerLeases().some(x => x.tabId === tabId &&
        (!userId || x.userId === userId) && (!org || x.organizationId === org));
    },
    bloquearOutrasAbas() {
      if (canal && estado.userId) { try { canal.postMessage({ type: 'lock', userId: estado.userId }); } catch (e) {} }
    }
  };
})();

const cofre = {
  /* Compatibilidade com o inventário local anterior à separação por clínica.
     O canal remoto pessoal foi congelado; estas funções não autorizam leitura
     ou gravação nele. Servem apenas para reconhecer dados locais sem ambiente
     e mantê-los inacessíveis até classificação explícita. */
  temClinica() {
    try { return !!contextoAba.organizationId(); }
    catch (e) { return false; }
  },
  /* Quantas clínicas esta conta tem, conforme o servidor respondeu no último
     login. null = ainda não se sabe. */
  quantasClinicas() {
    try { return contextoAba.atual().organizationsCount; } catch (e) { return null; }
  },
  /* Qualquer linha sem organization_id é ambígua: nem uma conta vinculada a
     uma única clínica prova a origem histórica de cada prontuário. */
  canalPessoalAmbiguo() {
    return true;
  },

  ORG_KEY: 'medsys.v7.cloud.org_id',
  MIGRADO_KEY: 'medsys.v7.cofre.migrado',

  /* O que NÃO se separa por clínica: é do aparelho ou da pessoa, e tem de
     continuar valendo quando ela troca de ambiente. Esta lista é a exceção;
     todo o resto é da clínica. */
  DO_APARELHO: [
    'medsys.v7.cloud.cfg', 'medsys.v7.cloud.org_id',
    'medsys.v7.cloud.sem_clinica', 'medsys.v7.cloud.last_uid', 'medsys.v7.cloud.orgs_count',
    /* A lista de usuários contém nomes, e-mails, papéis e permissões da
       clínica. Ela não é "do aparelho": numa máquina compartilhada, deixá-la
       crua permitia que a pessoa seguinte herdasse metadados da equipe
       anterior. Fora desta exceção ela passa pela mesma gaveta da clínica. */
    'medsys.v7.auth.timeout_min',
    'medsys.v7.theme', 'medsys.v7.grafico_modo', 'medsys.v7.realtime.on',
    /* O token e a pasta do Google Drive NÃO estão aqui, de propósito: são o
       DESTINO dos PDFs dos pacientes. Fora da separação, numa máquina
       compartilhada, os documentos de uma clínica subiriam para o Drive
       configurado pela outra pessoa. Cada clínica tem o seu destino. */
    'medsys.v7.configsync.meta',
    'medsys.v7.dash.escopo', 'medsys.v7.dash.periodo', 'medsys.v7.meudia.so_finalizados',
    'medsys.v7.ajustes.grupos_abertos', 'medsys.v7.ajustes.sysgrupos',
    'medsys.v7.tutorial_grafico', 'medsys.v7.nuvem.trafego',
    'medsys.v7.modo_nuvem', 'medsys.v7.modo_nuvem.dias', 'medsys.v7.arquivo.auto',
    'medsys.v7.demo', 'medsys.v7.cofre.migrado',
    'medsys.v7.ambiente.nome', 'medsys.v7.ambiente.vistos', 'medsys.v7.ambiente.compartilhado',
    'medsys.v7.ambiente.compart_perguntado',
    /* Carimbos de conversão única, valor '1'. Não guardam dado nenhum: são
       "esta máquina já passou por tal ajuste". Numa gaveta nova a conversão
       seria no-op de qualquer forma, e mantê-los fora da gaveta evita que
       apareçam como resto de clínica numa conferência de vazamento. */
    'medsys.v7.versions.compactado_v1', 'medsys.v7.blobs.dedup_v1',
    'medsys.v7.cad.profissionais.migrado'
  ],

  _real: null,     /* o localStorage de verdade */

  /* A gaveta ativa vem da identidade imutável desta aba, nunca de um ponteiro
     compartilhado entre abas. */
  org() {
    try { return contextoAba.organizationId() || ''; }
    catch (e) { return ''; }
  },
  sufixo(org) {
    const o = (org === undefined) ? cofre.org() : org;
    if (o) return '@' + String(o).slice(0, 8);
    /* Sem organização confirmada não significa "use as chaves antigas sem
       dono". A aba recebe uma quarentena própria e efêmera; assim tela de
       login, conta sem clínica e falha de perfil jamais enxergam o legado ou
       a quarentena de outra aba. */
    if (org === undefined) {
      try {
        const c = contextoAba.atual();
        return '@unbound-' + String(c.userId || 'anon').slice(0, 8) + '-' + String(c.tabId || '').slice(-8);
      } catch (e) { return '@unbound'; }
    }
    return '';
  },
  separa(k) {
    return !!k && String(k).indexOf('medsys.') === 0 && cofre.DO_APARELHO.indexOf(k) < 0;
  },
  /* chave do app -> chave real no navegador */
  real(k, org) {
    return cofre.separa(k) ? (k + cofre.sufixo(org)) : k;
  },
  /* chave real -> chave do app (para quem percorre o armazenamento) */
  app(kReal) {
    const suf = cofre.sufixo();
    if (suf && kReal.length > suf.length && kReal.slice(-suf.length) === suf) return kReal.slice(0, -suf.length);
    return kReal;
  },
  /* As chaves VISÍVEIS desta gaveta: as do aparelho mais as desta clínica.
     Quem percorre o armazenamento não pode topar com a clínica vizinha. */
  chaves() {
    const out = [];
    const suf = cofre.sufixo();
    try {
      for (let i = 0; i < cofre._real.length; i++) {
        const kr = cofre._real.key(i);
        if (kr == null) continue;
        if (String(kr).indexOf('medsys.') !== 0) { out.push(kr); continue; }
        const temSuf = suf && kr.slice(-suf.length) === suf;
        const base = temSuf ? kr.slice(0, -suf.length) : kr;
        if (temSuf) { if (cofre.separa(base)) out.push(base); continue; }
        /* sem sufixo: só aparece se for do aparelho — ou se não há gaveta
           nenhuma (conta sem clínica, que usa as chaves cruas) */
        if (!cofre.separa(kr) || !suf) out.push(kr);
      }
    } catch (e) {}
    return out;
  },

  /* A fachada. Mesma API do localStorage; o app não sabe que trocou. */
  _fachada() {
    return {
      getItem(k) { try { return cofre._real.getItem(cofre.real(k)); } catch (e) { return null; } },
      setItem(k, v) { return cofre._real.setItem(cofre.real(k), v); },
      removeItem(k) { try { return cofre._real.removeItem(cofre.real(k)); } catch (e) {} },
      key(i) { const ks = cofre.chaves(); return i >= 0 && i < ks.length ? ks[i] : null; },
      get length() { return cofre.chaves().length; },
      /* `clear()` do navegador apagaria as outras clínicas junto. Aqui ele
         limpa SÓ esta gaveta — quem quer apagar tudo tem caminho próprio. */
      clear() { cofre.chaves().forEach(k => { try { cofre._real.removeItem(cofre.real(k)); } catch (e) {} }); }
    };
  },

  /* Leva o que já está gravado SEM gaveta para a gaveta da clínica atual.
     Só roda quando a organização é conhecida, e só uma vez por gaveta: mover
     dado por palpite é tirar de alguém o acesso ao próprio trabalho. */
  /* O ACERVO ANTIGO NÃO SE ATRIBUI POR CONTA PRÓPRIA.

     O que está gravado sem gaveta veio de antes desta separação, e o registro
     não diz de qual clínica é — só o servidor sabe. A primeira versão disto
     movia tudo para o ambiente ativo, e a segunda tentou adivinhar pelo número
     de ambientes já vistos neste navegador. As duas erram pelo mesmo motivo:
     `vistos` só passou a ser gravado ontem, então um aparelho que atendeu uma
     clínica por meses e outra uma vez parece ter visto uma só. Adivinhar aqui
     é carimbar o prontuário de uma clínica como sendo de outra.

     Agora o padrão é NÃO MOVER. A gaveta começa vazia e a nuvem a preenche com
     o que é daquela clínica — que é sempre correto, e custa uma sincronização.
     O que estava solto fica intocado e invisível, e quem sabe de quem é pode
     reivindicá-lo num clique (Ajustes → Backup e sincronização). */
  legado() {
    const out = [];
    try {
      for (let i = 0; i < cofre._real.length; i++) {
        const kr = cofre._real.key(i);
        if (!kr || String(kr).indexOf('medsys.') !== 0) continue;
        if (kr.indexOf('@') >= 0) continue;          /* já é de alguma gaveta */
        if (!cofre.separa(kr)) continue;             /* é do aparelho */
        out.push(kr);
      }
    } catch (e) {}
    return out;
  },
  /* Quanto ele OCUPA. O acervo antigo não é só invisível: ele continua
     gastando o armazenamento do aparelho, que é de ~5 MB. Enquanto ninguém
     decide de quem ele é, a gaveta nova tenta encher-se da nuvem e não cabe —
     e aí não é só "o Dashboard está vazio", é "não consigo salvar". */
  legadoBytes() {
    let n = 0;
    try { cofre.legado().forEach(k => { const v = cofre._real.getItem(k); if (v) n += v.length * 2; }); } catch (e) {}
    return n;
  },
  /* Quantos REGISTROS (não chaves) estão soltos — é o número que diz algo a
     quem vai decidir. */
  legadoRegistros() {
    let n = 0;
    try {
      Object.keys(STORAGE || {}).forEach(mod => {
        const kr = STORAGE[mod];
        if (!kr || cofre._real.getItem(kr) == null) return;
        try { const v = JSON.parse(cofre._real.getItem(kr)); if (Array.isArray(v)) n += v.length; } catch (e) {}
      });
    } catch (e) {}
    return n;
  },
  _decisoes() {
    try { return JSON.parse(cofre._real.getItem(cofre.MIGRADO_KEY) || '{}') || {}; } catch (e) { return {}; }
  },
  _decidir(valor) {
    const org = cofre.org(); if (!org) return;
    const d = cofre._decisoes();
    d[String(org).slice(0, 8)] = valor;
    try { cofre._real.setItem(cofre.MIGRADO_KEY, JSON.stringify(d)); } catch (e) {}
  },
  /* Marcadores de versões anteriores não são autorização B2. Enquanto ainda
     houver chave sem organização, a quarentena permanece visível. */
  decidido() {
    try { return cofre.legado().length === 0; } catch (e) { return false; }
  },
  /* Existe acervo antigo guardado neste aparelho, decidido ou não. Quem
     respondeu "não são desta clínica" continua com o espaço ocupado — e
     precisa de um caminho de volta até a pergunta, não de um botão que
     desaparece. */
  temGuardado() {
    /* Sem clínica aberta não existe "acervo de antes": o que está solto é o
       dado corrente deste aparelho. */
    try { return !!cofre.org() && cofre.legado().length > 0; } catch (e) { return false; }
  },
  /* Compatibilidade nominal: versões antigas ofereciam ao usuário comum a
     adoção deste acervo pela clínica aberta. Isso não é prova de origem e pode
     misturar prontuários. B2 mantém o método como sentinela, mas nenhuma chave
     é movida; a associação passa exclusivamente pelo fluxo auditado do
     programador no servidor. */
  _juntar(brutoDestino, brutoLegado) {
    if (brutoDestino == null) return brutoLegado;
    if (brutoLegado == null) return brutoDestino;
    let d, l;
    try { d = JSON.parse(brutoDestino); } catch (e) { return brutoDestino; }
    try { l = JSON.parse(brutoLegado); } catch (e) { return brutoDestino; }
    if (Array.isArray(d) && Array.isArray(l)) {
      const vistos = new Set();
      d.forEach(x => { if (x && x._id) vistos.add(x._id); });
      const juntos = d.slice();
      l.forEach(x => { if (!x || !x._id || vistos.has(x._id)) return; juntos.push(x); vistos.add(x._id); });
      try { return JSON.stringify(juntos); } catch (e) { return brutoDestino; }
    }
    /* não é lista: vale o que já está na gaveta, se houver algo de fato */
    const vazio = d == null || d === '' || (Array.isArray(d) && !d.length) ||
                  (typeof d === 'object' && !Array.isArray(d) && !Object.keys(d).length);
    return vazio ? brutoLegado : brutoDestino;
  },
  _falhasUltimaReivindicacao: 0,
  reivindicar() {
    cofre._falhasUltimaReivindicacao = 0;
    try { toast('🔒 Acervo mantido em quarentena — somente o programador pode associá-lo a uma clínica com auditoria.', 'warn'); } catch (e) {}
    return 0;
  },
  /* Compatibilidade nominal: o usuário comum também não pode esconder a
     quarentena permanentemente. */
  dispensarLegado() { return false; },

  /* Apaga a gaveta INTEIRA de um ambiente (computador compartilhado). */
  esvaziar(org) {
    const suf = cofre.sufixo(org === undefined ? cofre.org() : org);
    if (!suf) return 0;
    const fora = [];
    try {
      for (let i = 0; i < cofre._real.length; i++) {
        const kr = cofre._real.key(i);
        if (kr && kr.length > suf.length && kr.slice(-suf.length) === suf) fora.push(kr);
      }
    } catch (e) {}
    fora.forEach(k => { try { cofre._real.removeItem(k); } catch (e) {} });
    return fora.length;
  },

  instalar() {
    if (cofre._real) return true;
    try {
      const nativo = window.localStorage;
      if (!nativo) return false;
      cofre._real = nativo;
      Object.defineProperty(window, 'localStorage', {
        value: cofre._fachada(), configurable: true, writable: false
      });
      return true;
    } catch (e) {
      /* Navegador que não deixa trocar o acessor: o app segue funcionando sem
         gaveta — e é melhor dizer isso alto do que fingir isolamento. */
      cofre._real = cofre._real || window.localStorage;
      cofre._semCofre = true;
      return false;
    }
  }
};
cofre.instalar();

const DEMO_FLAG = 'medsys.v7.demo';
const DEMO_PREFIX = 'demo:';
(function aplicarNamespaceDemo() {
  try {
    if (localStorage.getItem(DEMO_FLAG) === '1') {
      Object.keys(STORAGE).forEach(k => { STORAGE[k] = DEMO_PREFIX + STORAGE[k]; });
    }
  } catch (e) { /* localStorage indisponível — segue sem demo */ }
})();

/* ============================================================================
   DISCO GRANDE — o que é pesado sai do localStorage e vai para o IndexedDB.

   O localStorage tem ~5 MB por site. Não é pouco por descuido: é o teto do
   navegador, e nenhuma faxina resolve isso de forma duradoura. Em poucos dias
   de uso real o aparelho enchia, e um sistema que enche não serve.

   O IndexedDB do mesmo aparelho trabalha na casa de centenas de MB a GB. Aqui
   ele guarda o que é grande — imagens/carimbos, histórico de versões e a
   lixeira —, deixando o localStorage só com o que é pequeno: os registros em
   texto e as preferências.

   A leitura continua SÍNCRONA (o app inteiro depende disso): tudo é espelhado
   em memória no boot, e a gravação no disco acontece logo depois, sem esperar.
   Se o navegador não tiver IndexedDB (aba privada de alguns), cai de volta no
   localStorage exatamente como antes.
============================================================================ */
const disco = {
  DB: 'medsys-v7-grande',
  LOJA: 'kv',
  /* o que é pesado por natureza; o resto continua no localStorage */
  CHAVES: ['medsys.v7.blobs', 'medsys.v7.versions', 'medsys.v7.lixeira',
           'medsys.v7.rel.conflitos'],
  _mem: {},
  _db: null,
  _pronto: false,
  _fila: {},
  _timer: null,
  _bytes: 0,

  suportado() { try { return typeof indexedDB !== 'undefined' && !!indexedDB; } catch (e) { return false; } },
  ehGrande(k) { return disco.CHAVES.indexOf(k) >= 0; },

  _abrir() {
    return new Promise((ok, falha) => {
      let req;
      try { req = indexedDB.open(disco.DB, 1); } catch (e) { falha(e); return; }
      req.onupgradeneeded = () => {
        try { req.result.createObjectStore(disco.LOJA); } catch (e) {}
      };
      req.onsuccess = () => ok(req.result);
      req.onerror = () => falha(req.error);
      req.onblocked = () => falha(new Error('IndexedDB bloqueado'));
    });
  },
  _tx(modo) {
    const t = disco._db.transaction(disco.LOJA, modo);
    return t.objectStore(disco.LOJA);
  },
  _ler(chave) {
    return new Promise((ok) => {
      try {
        const r = disco._tx('readonly').get(chave);
        r.onsuccess = () => ok(r.result == null ? null : r.result);
        r.onerror = () => ok(null);
      } catch (e) { ok(null); }
    });
  },
  _gravarNoDisco(chave, valor) {
    return new Promise((ok) => {
      try {
        const r = disco._tx('readwrite').put(valor, chave);
        r.onsuccess = () => ok(true);
        r.onerror = () => ok(false);
      } catch (e) { ok(false); }
    });
  },

  /* Carrega somente as chaves da clínica pedida. O IndexedDB não passa pela
     fachada do localStorage; portanto a chave física precisa receber aqui o
     mesmo sufixo que recebe ao gravar. Ler a chave crua fazia blobs, versões,
     lixeira e conflitos sumirem da memória depois de um reload. */
  async hidratarAmbiente(org) {
    if (!disco._db) return false;
    let migrou = 0;
    for (const k of disco.CHAVES) {
      const chaveDisco = disco._k(k, org);
      let v = null;
      try { v = await disco._ler(chaveDisco); } catch (e) {}
      let antigo = null;
      /* Lê a chave EXATA da gaveta, sem depender de qual ambiente possa ter
         virado o ponteiro enquanto a operação assíncrona estava em curso. */
      try { antigo = cofre._real.getItem(cofre.real(k, org)); } catch (e) {}
      /* o que está no localStorage é o mais recente até a mudança acontecer */
      if (antigo != null) {
        v = antigo;
        await disco._gravarNoDisco(chaveDisco, antigo);
        try { cofre._real.removeItem(cofre.real(k, org)); migrou += antigo.length * 2; } catch (e) {}
      }
      if (v != null) disco._mem[chaveDisco] = v;
      else delete disco._mem[chaveDisco];
    }
    disco._recontar();
    /* imagens que não hidrataram antes do banco abrir aparecem agora */
    try { if (migrou || Object.keys(disco._mem).length) cloud._repintarTelaAtual(); } catch (e) {}
    return true;
  },

  /* Boot: abre o banco, traz o que é grande para a memória e MUDA de casa o
     que ainda estiver no localStorage — é aí que o espaço é devolvido. */
  async iniciar() {
    if (!disco.suportado()) return false;
    try { disco._db = await disco._abrir(); } catch (e) { return false; }
    /* Sem clínica confirmada, não toca a chave crua legada. Ela permanece
       inacessível até classificação manual; a clínica verificada hidrata sua
       própria chave em `ambiente.aoEntrar`. */
    try { if (cofre.org()) await disco.hidratarAmbiente(cofre.org()); } catch (e) { return false; }
    disco._pronto = true;
    return true;
  },
  _recontar() {
    let n = 0;
    try { Object.keys(disco._mem).forEach(k => { n += (disco._mem[k] || '').length * 2; }); } catch (e) {}
    disco._bytes = n;
  },

  /* O IndexedDB guarda imagens, versões e lixeira — tudo dado de paciente.
     Ele não passa pela fachada do localStorage, então a gaveta do ambiente é
     aplicada aqui, na chave. Sem isto, a assinatura e as fotos de uma clínica
     apareceriam na outra. */
  _k(chave, org) { try { return cofre.real(chave, org); } catch (e) { return chave; } },
  get(chave) {
    if (disco._pronto && disco.ehGrande(chave)) {
      const v = disco._mem[disco._k(chave)];
      return v == null ? null : v;
    }
    try { return localStorage.getItem(chave); } catch (e) { return null; }
  },
  /* Devolve true quando gravou. Para chave grande a gravação em disco é
     assíncrona: a memória já vale na hora, e é ela que o app lê. */
  set(chave, valor) {
    if (disco._pronto && disco.ehGrande(chave)) {
      disco._mem[disco._k(chave)] = String(valor);
      disco._recontar();
      disco._agendar(disco._k(chave));
      return true;
    }
    try { localStorage.setItem(chave, valor); return true; }
    catch (e) { throw e; }         /* quem chama trata a falta de espaço */
  },
  remove(chave, org) {
    if (disco._pronto && disco.ehGrande(chave)) {
      const chaveDisco = disco._k(chave, org);
      delete disco._mem[chaveDisco];
      disco._recontar();
      try { disco._tx('readwrite').delete(chaveDisco); } catch (e) {}
      return;
    }
    try { localStorage.removeItem(chave); } catch (e) {}
  },
  _agendar(chave) {
    disco._fila[chave] = true;
    if (disco._timer) return;
    disco._timer = setTimeout(async () => {
      disco._timer = null;
      const chaves = Object.keys(disco._fila);
      disco._fila = {};
      for (const k of chaves) {
        try { await disco._gravarNoDisco(k, disco._mem[k] == null ? '' : disco._mem[k]); } catch (e) {}
      }
    }, 400);
  },
  resumo() {
    return { ativo: disco._pronto, bytes: disco._bytes, chaves: Object.keys(disco._mem).length };
  }
};
try { window.disco = disco; } catch (e) {}

/* ============================================================================
   FILA OFFLINE CIFRADA — persistência clínica durável somente na indisponibilidade

   Esta é a base do motor cloud-first. A operação clínica nunca entra crua no
   IndexedDB: cada organização + usuário + dispositivo possui uma DEK AES-GCM,
   e a DEK fica localmente apenas embrulhada por uma KEK AES-KW. A KEK está no
   servidor e só volta depois que o MESMO auth.uid() autentica; logout/troca de
   contexto apaga todas as chaves abertas da memória.

   O cartão D3b liga os saves clínicos a esta fila. Mantê-la desacoplada aqui
   permite testar cifragem, crash, quota e isolamento antes de trocar o caminho
   de persistência que já está em produção.
============================================================================ */
const filaCifrada = {
  DB: 'medsys-v7-offline-cifrado',
  DB_VERSION: 3,
  STORE_ENVELOPES: 'envelopes',
  STORE_OPERACOES: 'operations',
  STORE_META: 'metadata',
  STORE_SNAPSHOTS: 'snapshots',
  SCHEMA: 1,
  _driver: null,
  _driverNativo: null,
  _chaves: new Map(),
  _aberturas: new Map(),
  _metaMem: new Map(),
  _snapshotTicks: new Map(),
  _epoca: 0,

  _erro(codigo, mensagem, causa) {
    const e = new Error(mensagem || codigo || 'fila cifrada');
    e.name = 'OfflineVaultError';
    e.code = codigo || 'offline_vault';
    if (causa) e.cause = causa;
    return e;
  },
  _cripto() {
    const c = typeof crypto !== 'undefined' ? crypto : null;
    if (!c || !c.subtle || typeof c.getRandomValues !== 'function') {
      throw filaCifrada._erro('cripto_indisponivel', 'Este navegador não oferece cifragem segura para trabalho offline.');
    }
    return c;
  },
  _encoder() {
    if (typeof TextEncoder === 'undefined') throw filaCifrada._erro('cripto_indisponivel', 'TextEncoder indisponível.');
    return new TextEncoder();
  },
  _decoder() {
    if (typeof TextDecoder === 'undefined') throw filaCifrada._erro('cripto_indisponivel', 'TextDecoder indisponível.');
    return new TextDecoder();
  },
  _b64(valor) {
    const b = valor instanceof Uint8Array ? valor : new Uint8Array(valor);
    let s = '';
    for (let i = 0; i < b.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, b.subarray(i, Math.min(i + 0x8000, b.length)));
    }
    return btoa(s);
  },
  _bytes64(valor) {
    try {
      const s = atob(String(valor || '').replace(/\s+/g, ''));
      const out = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
      return out;
    } catch (e) { throw filaCifrada._erro('chave_invalida', 'Material criptográfico inválido.', e); }
  },
  _estavel(valor) {
    if (valor === null || typeof valor !== 'object') return JSON.stringify(valor);
    if (Array.isArray(valor)) return '[' + valor.map(v => filaCifrada._estavel(v)).join(',') + ']';
    return '{' + Object.keys(valor).sort().filter(k => valor[k] !== undefined)
      .map(k => JSON.stringify(k) + ':' + filaCifrada._estavel(valor[k])).join(',') + '}';
  },
  _jsonSeguro(valor) {
    let txt;
    try { txt = JSON.stringify(valor); } catch (e) { throw filaCifrada._erro('payload_invalido', 'A operação offline não pode ser serializada.', e); }
    if (txt === undefined) throw filaCifrada._erro('payload_invalido', 'A operação offline está vazia.');
    return JSON.parse(txt);
  },
  async _sha256(txt) {
    const hash = await filaCifrada._cripto().subtle.digest('SHA-256', filaCifrada._encoder().encode(String(txt)));
    return Array.from(new Uint8Array(hash)).map(x => x.toString(16).padStart(2, '0')).join('');
  },
  _id() {
    try { if (filaCifrada._cripto().randomUUID) return filaCifrada._cripto().randomUUID(); } catch (e) {}
    const b = new Uint8Array(16); filaCifrada._cripto().getRandomValues(b);
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    const h = Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  },
  _dono() {
    const d = (() => { try { return contextoAba.donoFila(); } catch (e) { return null; } })();
    if (!d || !d.organizationId || !d.userId || !d.deviceId) {
      throw filaCifrada._erro('contexto_nao_confirmado', 'A clínica e o usuário precisam estar confirmados antes do trabalho offline.');
    }
    return { organizationId: String(d.organizationId), userId: String(d.userId),
      deviceId: String(d.deviceId), tabId: String(d.tabId || '') };
  },
  _donoKey(dono) {
    return JSON.stringify([String(dono.organizationId), String(dono.userId), String(dono.deviceId)]);
  },
  _cabecalho(reg) {
    return filaCifrada._estavel({
      schema: reg.schema, operationId: reg.operationId, ownerKey: reg.ownerKey,
      organizationId: reg.organizationId, userId: reg.userId, deviceId: reg.deviceId,
      module: reg.module, entityId: reg.entityId, action: reg.action,
      baseVersion: reg.baseVersion == null ? null : reg.baseVersion,
      createdAt: reg.createdAt, checksum: reg.checksum
    });
  },
  _snapshotId(ownerKey, namespace, key) {
    return [String(ownerKey), String(namespace), String(key)].join('\u001f');
  },
  _cabecalhoSnapshot(reg) {
    return filaCifrada._estavel({
      schema: reg.schema, snapshotId: reg.snapshotId, ownerKey: reg.ownerKey,
      organizationId: reg.organizationId, userId: reg.userId, deviceId: reg.deviceId,
      namespace: reg.namespace, key: reg.key, updatedAt: reg.updatedAt,
      checksum: reg.checksum
    });
  },
  _snapshotClock(ownerKey, sugerido) {
    const candidato = Date.parse(sugerido || '');
    const agora = Number.isFinite(candidato) ? candidato : Date.now();
    const anterior = Number(filaCifrada._snapshotTicks.get(ownerKey)) || 0;
    const proximo = Math.max(agora, anterior + 1);
    filaCifrada._snapshotTicks.set(ownerKey, proximo);
    return new Date(proximo).toISOString();
  },

  /* Driver isolado para que a semântica de durabilidade seja testável sem
     fingir que localStorage é transacional. Cada promessa resolve somente no
     `transaction.oncomplete`; erro/quota nunca vira falso "salvo". */
  _driverPadrao() {
    if (filaCifrada._driverNativo) return filaCifrada._driverNativo;
    if (typeof indexedDB === 'undefined') {
      throw filaCifrada._erro('indexeddb_indisponivel', 'IndexedDB indisponível para a fila offline.');
    }
    let abertura = null;
    const abrir = () => {
      if (abertura) return abertura;
      abertura = new Promise((ok, falha) => {
        let req;
        try { req = indexedDB.open(filaCifrada.DB, filaCifrada.DB_VERSION); }
        catch (e) { falha(filaCifrada._erro('indexeddb_indisponivel', e.message, e)); return; }
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(filaCifrada.STORE_ENVELOPES)) {
            db.createObjectStore(filaCifrada.STORE_ENVELOPES, { keyPath: 'ownerKey' });
          }
          if (!db.objectStoreNames.contains(filaCifrada.STORE_OPERACOES)) {
            const ops = db.createObjectStore(filaCifrada.STORE_OPERACOES, { keyPath: 'operationId' });
            ops.createIndex('ownerKey', 'ownerKey', { unique: false });
          }
          if (!db.objectStoreNames.contains(filaCifrada.STORE_META)) {
            db.createObjectStore(filaCifrada.STORE_META, { keyPath: 'ownerKey' });
          }
          if (!db.objectStoreNames.contains(filaCifrada.STORE_SNAPSHOTS)) {
            const snapshots = db.createObjectStore(filaCifrada.STORE_SNAPSHOTS, { keyPath: 'snapshotId' });
            snapshots.createIndex('ownerKey', 'ownerKey', { unique: false });
          }
        };
        req.onsuccess = () => {
          const db = req.result;
          db.onversionchange = () => { try { db.close(); } catch (e) {} abertura = null; };
          ok(db);
        };
        req.onerror = () => falha(req.error || filaCifrada._erro('indexeddb_erro', 'Falha ao abrir IndexedDB.'));
        req.onblocked = () => falha(filaCifrada._erro('indexeddb_bloqueado', 'Outra aba bloqueou a atualização da fila offline.'));
      });
      return abertura;
    };
    const operar = async (loja, modo, fn) => {
      const db = await abrir();
      return new Promise((ok, falha) => {
        let resultado;
        let terminou = false;
        const rejeitar = erro => {
          if (terminou) return; terminou = true;
          falha(filaCifrada._erro(erro && erro.name === 'QuotaExceededError' ? 'quota' : 'indexeddb_erro',
            (erro && erro.message) || 'Falha ao persistir a fila offline.', erro));
        };
        let tx;
        try { tx = db.transaction(loja, modo); }
        catch (e) { rejeitar(e); return; }
        tx.oncomplete = () => { if (!terminou) { terminou = true; ok(resultado); } };
        tx.onerror = () => rejeitar(tx.error);
        tx.onabort = () => rejeitar(tx.error || filaCifrada._erro('indexeddb_abortado', 'Transação offline abortada.'));
        try { fn(tx.objectStore(loja), valor => { resultado = valor; }, tx); }
        catch (e) { try { tx.abort(); } catch (e2) {} rejeitar(e); }
      });
    };
    const ler = (loja, chave) => operar(loja, 'readonly', (s, definir) => {
      const r = s.get(chave); r.onsuccess = () => definir(r.result || null);
    });
    const adicionar = async (loja, valor) => {
      try {
        await operar(loja, 'readwrite', s => { s.add(valor); });
        return true;
      } catch (e) {
        const causa = e && (e.cause || e);
        if ((causa && causa.name === 'ConstraintError') || /ConstraintError/i.test(String((causa && causa.message) || ''))) return false;
        throw e;
      }
    };
    filaCifrada._driverNativo = {
      getEnvelope: chave => ler(filaCifrada.STORE_ENVELOPES, chave),
      addEnvelope: valor => adicionar(filaCifrada.STORE_ENVELOPES, valor),
      getOperation: id => ler(filaCifrada.STORE_OPERACOES, id),
      addOperation: valor => adicionar(filaCifrada.STORE_OPERACOES, valor),
      listOperations: ownerKey => operar(filaCifrada.STORE_OPERACOES, 'readonly', (s, definir) => {
        const r = s.index('ownerKey').getAll(ownerKey); r.onsuccess = () => definir(r.result || []);
      }),
      deleteOperation: id => operar(filaCifrada.STORE_OPERACOES, 'readwrite', s => { s.delete(id); }),
      updateOperation: (id, patch) => operar(filaCifrada.STORE_OPERACOES, 'readwrite', (s, definir) => {
        const r = s.get(id);
        r.onsuccess = () => {
          if (!r.result) { definir(null); return; }
          const novo = Object.assign({}, r.result, patch || {});
          s.put(novo); definir(novo);
        };
      }),
      getMeta: ownerKey => ler(filaCifrada.STORE_META, ownerKey),
      putMeta: valor => operar(filaCifrada.STORE_META, 'readwrite', s => { s.put(valor); }),
      putSnapshot: valor => operar(filaCifrada.STORE_SNAPSHOTS, 'readwrite', (s, definir) => {
        const r = s.get(valor.snapshotId);
        r.onsuccess = () => {
          const atual = r.result;
          if (atual && String(atual.updatedAt || '') > String(valor.updatedAt || '')) {
            definir(false);
            return;
          }
          s.put(valor);
          definir(true);
        };
      }),
      listSnapshots: ownerKey => operar(filaCifrada.STORE_SNAPSHOTS, 'readonly', (s, definir) => {
        const r = s.index('ownerKey').getAll(ownerKey); r.onsuccess = () => definir(r.result || []);
      })
    };
    return filaCifrada._driverNativo;
  },
  _driverAtual() { return filaCifrada._driver || filaCifrada._driverPadrao(); },
  _definirDriverParaTeste(driver) {
    filaCifrada.bloquearTudo();
    filaCifrada._driver = driver || null;
  },

  async _buscarKekServidor(dono, contexto) {
    if (typeof cloud === 'undefined' || !cloud.estaConfigurado() || !cloud.estaLogado()) {
      throw filaCifrada._erro('chave_servidor_indisponivel', 'Entre na nuvem para liberar o cofre offline deste usuário.');
    }
    if (!(await cloud._garantirToken())) {
      throw filaCifrada._erro('chave_servidor_indisponivel', 'A sessão não pôde liberar o cofre offline.');
    }
    if (!contextoAba.corresponde(contexto)) throw filaCifrada._erro('contexto_trocado', 'O usuário mudou durante a abertura do cofre.');
    const c = cloud.config();
    let r;
    try {
      r = await fetch(c.url + '/rest/v1/rpc/ensure_offline_keyring', {
        method: 'POST', headers: cloud._headers(true),
        body: JSON.stringify({ p_device_id: dono.deviceId })
      });
    } catch (e) { throw filaCifrada._erro('chave_servidor_indisponivel', 'Sem conexão para liberar o cofre offline.', e); }
    if (!contextoAba.corresponde(contexto)) throw filaCifrada._erro('contexto_trocado', 'O usuário mudou durante a abertura do cofre.');
    if (!r.ok) throw filaCifrada._erro('chave_servidor_indisponivel', 'O servidor ainda não liberou a chave offline (HTTP ' + r.status + ').');
    const dados = await r.json().catch(() => null);
    const linha = Array.isArray(dados) ? dados[0] : dados;
    if (!linha || !linha.wrap_key || !Number(linha.key_version)) {
      throw filaCifrada._erro('chave_servidor_invalida', 'O servidor devolveu uma chave offline inválida.');
    }
    return { material: filaCifrada._bytes64(linha.wrap_key), keyVersion: Number(linha.key_version) };
  },
  async _abrirDono(dono, contexto, epoca) {
    const ownerKey = filaCifrada._donoKey(dono);
    const servidor = await filaCifrada._buscarKekServidor(dono, contexto);
    if (epoca !== filaCifrada._epoca || !contextoAba.corresponde(contexto)) {
      if (servidor.material && servidor.material.fill) servidor.material.fill(0);
      throw filaCifrada._erro('contexto_trocado', 'O cofre não foi aberto porque o usuário mudou.');
    }
    let kek;
    try {
      kek = await filaCifrada._cripto().subtle.importKey('raw', servidor.material,
        { name: 'AES-KW' }, false, ['wrapKey', 'unwrapKey']);
    } finally {
      if (servidor.material && servidor.material.fill) servidor.material.fill(0);
    }
    const driver = filaCifrada._driverAtual();
    let envelope = await driver.getEnvelope(ownerKey);
    if (!envelope) {
      const candidata = await filaCifrada._cripto().subtle.generateKey(
        { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
      const embrulhada = await filaCifrada._cripto().subtle.wrapKey('raw', candidata, kek, { name: 'AES-KW' });
      const nova = {
        schema: filaCifrada.SCHEMA, ownerKey,
        organizationId: dono.organizationId, userId: dono.userId, deviceId: dono.deviceId,
        keyVersion: servidor.keyVersion, algorithm: 'A256GCM+A256KW',
        wrappedKey: filaCifrada._b64(embrulhada), createdAt: new Date().toISOString()
      };
      const ganhou = await driver.addEnvelope(nova);
      envelope = ganhou ? nova : await driver.getEnvelope(ownerKey);
    }
    if (!envelope || envelope.ownerKey !== ownerKey || envelope.organizationId !== dono.organizationId ||
        envelope.userId !== dono.userId || envelope.deviceId !== dono.deviceId) {
      throw filaCifrada._erro('envelope_invalido', 'O envelope offline não pertence a este contexto.');
    }
    if (Number(envelope.keyVersion) !== Number(servidor.keyVersion)) {
      throw filaCifrada._erro('rotacao_pendente', 'A chave offline precisa ser reembrulhada antes de abrir a fila.');
    }
    let dek;
    try {
      dek = await filaCifrada._cripto().subtle.unwrapKey('raw', filaCifrada._bytes64(envelope.wrappedKey), kek,
        { name: 'AES-KW' }, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    } catch (e) { throw filaCifrada._erro('envelope_inacessivel', 'Não foi possível abrir a fila offline deste usuário.', e); }
    if (epoca !== filaCifrada._epoca || !contextoAba.corresponde(contexto)) {
      throw filaCifrada._erro('contexto_trocado', 'A chave aberta foi descartada porque o usuário mudou.');
    }
    const entrada = { key: dek, ownerKey, dono: Object.freeze(Object.assign({}, dono)), keyVersion: servidor.keyVersion };
    filaCifrada._chaves.set(ownerKey, entrada);
    return entrada;
  },
  async preparar() {
    const dono = filaCifrada._dono();
    const ownerKey = filaCifrada._donoKey(dono);
    if (filaCifrada._chaves.has(ownerKey)) return filaCifrada._chaves.get(ownerKey);
    if (filaCifrada._aberturas.has(ownerKey)) return filaCifrada._aberturas.get(ownerKey);
    const contexto = contextoAba.capturar();
    const epoca = filaCifrada._epoca;
    const p = filaCifrada._abrirDono(dono, contexto, epoca);
    filaCifrada._aberturas.set(ownerKey, p);
    try { return await p; }
    finally { if (filaCifrada._aberturas.get(ownerKey) === p) filaCifrada._aberturas.delete(ownerKey); }
  },
  bloquearTudo() {
    filaCifrada._epoca++;
    filaCifrada._chaves.clear();
    filaCifrada._aberturas.clear();
  },

  /* Recuperação de formulário/rascunho também é dado clínico. O payload fica
     cifrado no mesmo cofre, mas separado do WAL: há somente o snapshot mais
     novo por namespace/chave. O dono e a chave aberta são capturados antes
     do primeiro `await`; assim uma escrita já iniciada termina na gaveta
     antiga mesmo se outra pessoa entrar no computador durante a transação. */
  salvarSnapshot(namespace, key, payload, opts = {}) {
    const dono = filaCifrada._dono();
    const ownerKey = filaCifrada._donoKey(dono);
    const ns = String(namespace || '');
    const chave = String(key || '');
    if (!ns || !chave || ns.length > 100 || chave.length > 200) {
      return Promise.reject(filaCifrada._erro('snapshot_invalido', 'Identificador de recuperação inválido.'));
    }
    const copia = filaCifrada._jsonSeguro(payload);
    const updatedAt = filaCifrada._snapshotClock(ownerKey, opts.updatedAt);
    const snapshotId = filaCifrada._snapshotId(ownerKey, ns, chave);
    const abertura = filaCifrada.preparar();
    return (async () => {
      const aberta = await abertura;
      if (!aberta || aberta.ownerKey !== ownerKey) {
        throw filaCifrada._erro('contexto_trocado', 'O snapshot não pertence à chave aberta.');
      }
      const core = {
        schema: filaCifrada.SCHEMA, snapshotId, ownerKey,
        organizationId: dono.organizationId, userId: dono.userId, deviceId: dono.deviceId,
        namespace: ns, key: chave, updatedAt, payload: copia
      };
      const checksum = await filaCifrada._sha256(filaCifrada._estavel(core));
      const reg = {
        schema: filaCifrada.SCHEMA, snapshotId, ownerKey,
        organizationId: dono.organizationId, userId: dono.userId, deviceId: dono.deviceId,
        namespace: ns, key: chave, updatedAt, checksum
      };
      const aad = filaCifrada._cabecalhoSnapshot(reg);
      const iv = new Uint8Array(12); filaCifrada._cripto().getRandomValues(iv);
      const claro = filaCifrada._encoder().encode(JSON.stringify(Object.assign({}, core, { checksum })));
      const cifrado = await filaCifrada._cripto().subtle.encrypt({
        name: 'AES-GCM', iv, additionalData: filaCifrada._encoder().encode(aad), tagLength: 128
      }, aberta.key, claro);
      reg.iv = filaCifrada._b64(iv);
      reg.aad = aad;
      reg.ciphertext = filaCifrada._b64(cifrado);
      const driver = filaCifrada._driverAtual();
      if (typeof driver.putSnapshot !== 'function') {
        throw filaCifrada._erro('snapshot_indisponivel', 'O armazenamento cifrado de recuperação não está disponível.');
      }
      const gravou = await driver.putSnapshot(reg);
      return { ok: true, durable: true, superseded: gravou === false,
        namespace: ns, key: chave, updatedAt, checksum };
    })();
  },
  /* A remoção conserva só uma barreira de revisão sem conteúdo clínico.
     Uma cifragem iniciada antes do recibo nunca pode ressuscitar o payload. */
  removerSnapshot(namespace, key) {
    const dono = filaCifrada._dono();
    const ownerKey = filaCifrada._donoKey(dono);
    const ns = String(namespace || ''), chave = String(key || '');
    if (!ns || !chave || ns.length > 100 || chave.length > 200) {
      return Promise.reject(filaCifrada._erro('snapshot_invalido', 'Identificador de recuperação inválido.'));
    }
    const reg = { snapshotId: filaCifrada._snapshotId(ownerKey, ns, chave), ownerKey,
      namespace: ns, key: chave, updatedAt: filaCifrada._snapshotClock(ownerKey), deleted: true };
    const driver = filaCifrada._driverAtual();
    if (typeof driver.putSnapshot !== 'function') return Promise.reject(
      filaCifrada._erro('snapshot_indisponivel', 'O armazenamento cifrado de recuperação não está disponível.'));
    return Promise.resolve(driver.putSnapshot(reg)).then(gravou => ({ ok: true, durable: true,
      removed: true, superseded: gravou === false, namespace: ns, key: chave }));
  },
  async _decifrarSnapshot(reg, chave) {
    if (!reg || !reg.snapshotId || !reg.ciphertext || !reg.iv || !reg.aad) {
      throw filaCifrada._erro('snapshot_corrompido', 'Snapshot cifrado incompleto.');
    }
    const esperado = filaCifrada._cabecalhoSnapshot(reg);
    if (esperado !== reg.aad) throw filaCifrada._erro('snapshot_adulterado', 'O cabeçalho do snapshot foi alterado.');
    let claro;
    try {
      claro = await filaCifrada._cripto().subtle.decrypt({
        name: 'AES-GCM', iv: filaCifrada._bytes64(reg.iv),
        additionalData: filaCifrada._encoder().encode(reg.aad), tagLength: 128
      }, chave, filaCifrada._bytes64(reg.ciphertext));
    } catch (e) { throw filaCifrada._erro('snapshot_inacessivel', 'O snapshot não pode ser aberto por este usuário.', e); }
    let snap;
    try { snap = JSON.parse(filaCifrada._decoder().decode(claro)); }
    catch (e) { throw filaCifrada._erro('snapshot_corrompido', 'Conteúdo de recuperação inválido.', e); }
    const checksum = snap && snap.checksum;
    const core = Object.assign({}, snap); delete core.checksum;
    if (!checksum || checksum !== reg.checksum ||
        checksum !== await filaCifrada._sha256(filaCifrada._estavel(core)) ||
        snap.snapshotId !== reg.snapshotId || snap.ownerKey !== reg.ownerKey ||
        snap.organizationId !== reg.organizationId || snap.userId !== reg.userId ||
        snap.deviceId !== reg.deviceId) {
      throw filaCifrada._erro('snapshot_adulterado', 'A integridade do snapshot não confere.');
    }
    return { namespace: snap.namespace, key: snap.key, payload: snap.payload,
      updatedAt: snap.updatedAt, checksum };
  },
  async listarSnapshots(namespace) {
    const contexto = contextoAba.capturar();
    const dono = filaCifrada._dono();
    const ownerKey = filaCifrada._donoKey(dono);
    const aberta = await filaCifrada.preparar();
    if (!contextoAba.corresponde(contexto) || aberta.ownerKey !== ownerKey) {
      throw filaCifrada._erro('contexto_trocado', 'O usuário mudou durante a leitura dos snapshots.');
    }
    const driver = filaCifrada._driverAtual();
    if (typeof driver.listSnapshots !== 'function') return [];
    const regs = await driver.listSnapshots(ownerKey);
    if (!contextoAba.corresponde(contexto)) {
      throw filaCifrada._erro('contexto_trocado', 'O usuário mudou durante a leitura dos snapshots.');
    }
    const filtrados = (regs || []).filter(reg => !reg.deleted && (!namespace || reg.namespace === String(namespace)));
    filtrados.sort((a, b) => String(a.updatedAt || '').localeCompare(String(b.updatedAt || '')) ||
      String(a.snapshotId || '').localeCompare(String(b.snapshotId || '')));
    const out = [];
    for (const reg of filtrados) out.push(await filaCifrada._decifrarSnapshot(reg, aberta.key));
    if (!contextoAba.corresponde(contexto)) {
      throw filaCifrada._erro('contexto_trocado', 'O usuário mudou durante a leitura dos snapshots.');
    }
    return out;
  },

  async enfileirar(entrada) {
    const dono = filaCifrada._dono();
    if (entrada && entrada.organizationId && String(entrada.organizationId) !== dono.organizationId) {
      throw filaCifrada._erro('outra_clinica', 'A operação offline pertence a outra clínica.');
    }
    if (entrada && entrada.userId && String(entrada.userId) !== dono.userId) {
      throw filaCifrada._erro('outro_usuario', 'A operação offline pertence a outro usuário.');
    }
    const aberta = await filaCifrada.preparar();
    const ownerKey = aberta.ownerKey;
    const operationId = String((entrada && entrada.operationId) || filaCifrada._id());
    if (!operationId || operationId.length > 200) throw filaCifrada._erro('operacao_invalida', 'Identificador offline inválido.');
    const core = {
      schema: filaCifrada.SCHEMA,
      operationId,
      organizationId: dono.organizationId,
      userId: dono.userId,
      deviceId: dono.deviceId,
      createdTabId: dono.tabId,
      module: String((entrada && entrada.module) || ''),
      entityId: String((entrada && entrada.entityId) || ''),
      action: String((entrada && entrada.action) || 'upsert'),
      baseVersion: entrada && entrada.baseVersion != null ? entrada.baseVersion : null,
      dependsOn: Array.from(new Set(((entrada && entrada.dependsOn) || []).map(String))),
      createdAt: String((entrada && entrada.createdAt) || new Date().toISOString()),
      payload: filaCifrada._jsonSeguro(entrada && Object.prototype.hasOwnProperty.call(entrada, 'payload') ? entrada.payload : {})
    };
    if (!core.module || !core.entityId) throw filaCifrada._erro('operacao_invalida', 'Módulo e registro são obrigatórios na fila offline.');
    const checksum = await filaCifrada._sha256(filaCifrada._estavel(core));
    const driver = filaCifrada._driverAtual();
    const existente = await driver.getOperation(operationId);
    if (existente) {
      if (existente.ownerKey === ownerKey && existente.checksum === checksum) {
        return { ok: true, durable: true, duplicate: true, operationId, checksum };
      }
      throw filaCifrada._erro('colisao_operacao', 'O identificador offline já existe com outro conteúdo.');
    }
    const reg = {
      schema: filaCifrada.SCHEMA, operationId, ownerKey,
      organizationId: dono.organizationId, userId: dono.userId, deviceId: dono.deviceId,
      module: core.module, entityId: core.entityId, action: core.action,
      baseVersion: core.baseVersion, dependsOn: core.dependsOn,
      createdAt: core.createdAt, checksum,
      state: 'staged', attempts: 0, lastError: null, lastAttemptAt: null
    };
    const aad = filaCifrada._cabecalho(reg);
    const iv = new Uint8Array(12); filaCifrada._cripto().getRandomValues(iv);
    const claro = filaCifrada._encoder().encode(JSON.stringify(Object.assign({}, core, { checksum })));
    const cifrado = await filaCifrada._cripto().subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: filaCifrada._encoder().encode(aad), tagLength: 128 },
      aberta.key, claro);
    reg.iv = filaCifrada._b64(iv);
    reg.aad = aad;
    reg.ciphertext = filaCifrada._b64(cifrado);
    const gravou = await driver.addOperation(reg);
    if (!gravou) {
      const vencedor = await driver.getOperation(operationId);
      if (vencedor && vencedor.ownerKey === ownerKey && vencedor.checksum === checksum) {
        return { ok: true, durable: true, duplicate: true, operationId, checksum };
      }
      throw filaCifrada._erro('colisao_operacao', 'Outra aba gravou conteúdo diferente com o mesmo identificador.');
    }
    return { ok: true, durable: true, duplicate: false, operationId, checksum };
  },
  async _decifrar(reg, chave) {
    if (!reg || !reg.ciphertext || !reg.iv || !reg.aad) throw filaCifrada._erro('operacao_corrompida', 'Operação offline incompleta.');
    const esperado = filaCifrada._cabecalho(reg);
    if (esperado !== reg.aad) throw filaCifrada._erro('operacao_adulterada', 'O cabeçalho da operação offline foi alterado.');
    let claro;
    try {
      claro = await filaCifrada._cripto().subtle.decrypt({
        name: 'AES-GCM', iv: filaCifrada._bytes64(reg.iv),
        additionalData: filaCifrada._encoder().encode(reg.aad), tagLength: 128
      }, chave, filaCifrada._bytes64(reg.ciphertext));
    } catch (e) { throw filaCifrada._erro('operacao_inacessivel', 'A operação offline não pode ser aberta por este usuário.', e); }
    let op;
    try { op = JSON.parse(filaCifrada._decoder().decode(claro)); }
    catch (e) { throw filaCifrada._erro('operacao_corrompida', 'Conteúdo offline inválido.', e); }
    const checksum = op && op.checksum;
    const core = Object.assign({}, op); delete core.checksum;
    if (!checksum || checksum !== reg.checksum ||
        checksum !== await filaCifrada._sha256(filaCifrada._estavel(core)) ||
        op.operationId !== reg.operationId || op.organizationId !== reg.organizationId ||
        op.userId !== reg.userId || op.deviceId !== reg.deviceId) {
      throw filaCifrada._erro('operacao_adulterada', 'A integridade da operação offline não confere.');
    }
    return op;
  },
  async listar() {
    const aberta = await filaCifrada.preparar();
    const regs = await filaCifrada._driverAtual().listOperations(aberta.ownerKey);
    regs.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) ||
      String(a.operationId || '').localeCompare(String(b.operationId || '')));
    const out = [];
    for (const reg of regs) {
      const op = await filaCifrada._decifrar(reg, aberta.key);
      op.queue = {
        state: reg.state || 'staged', attempts: Number(reg.attempts) || 0,
        lastError: reg.lastError || null, lastAttemptAt: reg.lastAttemptAt || null
      };
      out.push(op);
    }
    return out;
  },
  async marcarEstado(operationId, state, detalhe) {
    const permitidos = ['staged','sending','offline','blocked','conflict'];
    if (permitidos.indexOf(state) < 0) throw filaCifrada._erro('estado_invalido', 'Estado inválido da fila offline.');
    const aberta = await filaCifrada.preparar();
    const driver = filaCifrada._driverAtual();
    const reg = await driver.getOperation(String(operationId || ''));
    if (!reg || reg.ownerKey !== aberta.ownerKey) return false;
    const patch = { state };
    if (state === 'sending') {
      patch.attempts = Math.max(0, Number(reg.attempts) || 0) + 1;
      patch.lastAttemptAt = new Date().toISOString();
    }
    if (detalhe) patch.lastError = String(detalhe).slice(0, 240);
    await driver.updateOperation(reg.operationId, patch);
    return true;
  },
  async registrarFalha(operationId, erro) {
    const aberta = await filaCifrada.preparar();
    const driver = filaCifrada._driverAtual();
    const reg = await driver.getOperation(String(operationId || ''));
    if (!reg || reg.ownerKey !== aberta.ownerKey) return false;
    await driver.updateOperation(reg.operationId, {
      lastError: String((erro && (erro.code || erro.message)) || erro || 'falha').slice(0, 240)
    });
    return true;
  },
  async confirmar(operationId, recibo) {
    const aberta = await filaCifrada.preparar();
    const driver = filaCifrada._driverAtual();
    const reg = await driver.getOperation(String(operationId || ''));
    if (!reg || reg.ownerKey !== aberta.ownerKey) return false;
    if (!recibo || recibo.remoteConfirmed !== true || recibo.checksum !== reg.checksum) {
      throw filaCifrada._erro('recibo_invalido', 'A fila só pode apagar depois da confirmação verificável do servidor.');
    }
    await driver.deleteOperation(reg.operationId);
    const meta = {
      ownerKey: aberta.ownerKey, lastConfirmedAt: new Date().toISOString(),
      lastConfirmedOperationId: reg.operationId
    };
    try {
      if (typeof driver.putMeta === 'function') await driver.putMeta(meta);
      else filaCifrada._metaMem.set(aberta.ownerKey, meta);
    } catch (e) { filaCifrada._metaMem.set(aberta.ownerKey, meta); }
    return true;
  },
  async resumo() {
    const dono = filaCifrada._dono();
    const ownerKey = filaCifrada._donoKey(dono);
    const driver = filaCifrada._driverAtual();
    const regs = await driver.listOperations(ownerKey);
    const ordenadas = regs.slice().sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    let meta = filaCifrada._metaMem.get(ownerKey) || null;
    try { if (typeof driver.getMeta === 'function') meta = await driver.getMeta(ownerKey) || meta; } catch (e) {}
    const porTentativa = regs.slice().sort((a, b) => String(b.lastAttemptAt || '').localeCompare(String(a.lastAttemptAt || '')));
    return {
      total: regs.length,
      maisAntiga: ordenadas[0] && ordenadas[0].createdAt || null,
      tentativas: regs.reduce((n, x) => n + (Number(x.attempts) || 0), 0),
      comErro: regs.filter(x => !!x.lastError).length,
      ultimaTentativa: regs.reduce((m, x) => String(x.lastAttemptAt || '') > m ? String(x.lastAttemptAt) : m, '') || null,
      ultimoErro: (porTentativa.find(x => x.lastError) || {}).lastError || null,
      estados: regs.reduce((m, x) => { const s = x.state || 'staged'; m[s] = (m[s] || 0) + 1; return m; }, {}),
      ultimaConfirmacao: meta && meta.lastConfirmedAt || null
    };
  }
};
try {
  contextoAba.aoMudar(() => filaCifrada.bloquearTudo());
  window.filaCifrada = filaCifrada;
} catch (e) {}

/* FIM DA PLATAFORMA DE CONTEXTO E FILA OFFLINE */
