'use strict';

/* ============================================================================
   CLOUD — Supabase como fonte oficial, com continuidade offline
   - Online, toda gravação pertence a uma organização e é confirmada no banco.
   - Sem sinal, o aparelho mantém a operação pendente e envia automaticamente
     quando a conexão volta.
   - Usa a REST API do Supabase via fetch (sem SDK/CDN externos).
============================================================================ */
const cloud = {
  DEFAULT_URL: 'https://zbpbrnalamjrcfbscjkt.supabase.co',
  DEFAULT_KEY: 'sb_publishable_DwMNHxCzA0tmwQdg7wWHUQ_TfLS69-r',
  CFG_KEY: 'medsys.v7.cloud.cfg',          // {url, anonKey}
  SESSION_KEY: 'medsys.v7.cloud.session',  // {access_token, refresh_token, user, expires_at}
  QUEUE_KEY: 'medsys.v7.cloud.queue',      // fila de operações pendentes (offline)
  /* Somente módulos cujo dado operacional pertence a uma organização. Os
     cadastros compartilhados usam org_configs (clinicaSync), também com org. */
  MODS: ['pre','consulta','anestesia','recuperacao','termo','prescricao','documentos','risco',
    'financeiro','fin_fechamentos','orcamento','agenda','pacientes'],
  _syncing: false,
  _loginTentativa: 0,

  /* ---- Configuração (URL + anon key) ---- */
  config() {
    try { return JSON.parse(localStorage.getItem(cloud.CFG_KEY) || 'null'); }
    catch { return null; }
  },
  estaConfigurado() {
    const c = cloud.config();
    return !!(c && c.url && c.anonKey);
  },
  salvarConfig(url, anonKey) {
    url = (url || '').trim().replace(/\/+$/, '');
    anonKey = (anonKey || '').trim();
    if (!/^https:\/\/.+\.supabase\.co$/.test(url)) {
      toast('URL inválida. Deve ser algo como https://xxxxx.supabase.co', 'error');
      return false;
    }
    /* Proteção: rejeita chaves de servidor (perigosas em arquivo público) */
    if (anonKey.indexOf('sb_secret_') === 0) {
      toast('⚠️ Essa é a chave "secret" — NÃO use no app! Use a "publishable" (sb_publishable_...).', 'error');
      return false;
    }
    const ehPublishable = anonKey.indexOf('sb_publishable_') === 0;
    const ehJwt = /^eyJ/.test(anonKey) && anonKey.indexOf('.') > 0;
    if (!ehPublishable && !ehJwt) {
      toast('Chave inválida. Use a "anon public" (eyJ...) ou a "publishable" (sb_publishable_...).', 'error');
      return false;
    }
    /* Chave legada (JWT): rejeita service_role */
    if (ehJwt) {
      try {
        const payload = JSON.parse(atob(anonKey.split('.')[1] || ''));
        if (payload && payload.role === 'service_role') {
          toast('⚠️ Essa é a chave service_role — NÃO use no app! Use a "anon public".', 'error');
          return false;
        }
      } catch (e) { /* se não decodificar, segue (validação leve) */ }
    }
    localStorage.setItem(cloud.CFG_KEY, JSON.stringify({ url, anonKey }));
    toast('☁️ Configuração da nuvem salva');
    return true;
  },
  limparConfig() {
    try { cloud.esquecerMarcaBaixa(); } catch (e) {}
    localStorage.removeItem(cloud.CFG_KEY);
    localStorage.removeItem(cloud.SESSION_KEY);
    try { if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(cloud.SESSION_KEY); } catch (e) {}
    toast('Configuração da nuvem removida');
  },

  /* ---- Sessão / autenticação ---- */
  /* A SESSÃO NÃO PODE SER VÍTIMA DE APARELHO CHEIO.

     Ela é gravada no login e REGRAVADA a cada renovação de token (o servidor
     rotaciona o refresh_token: o antigo deixa de valer). Num aparelho sem
     espaço, essa gravação falha calada — e o aparelho fica com um token que
     o servidor já invalidou. Na vez seguinte a renovação é recusada, e a
     pessoa recebe "entre na nuvem" como se nunca tivesse entrado.

     Aqui a gravação insiste: se não couber, libera espaço e tenta de novo.
     Se ainda assim não couber, avisa — porque continuar em silêncio é
     prometer uma sessão que não existe. */
  /* A sessão EM USO sempre pertence à aba. Tokens nunca são persistidos em
     localStorage: um computador pode trocar de usuário, mesmo quando alguém o
     classificou antes como pessoal. Assim uma aba fechada sempre volta pela
     autenticação e nunca herda o Bearer/refresh token de outra pessoa. */
  _lojaSessao() {
    try { return (typeof sessionStorage !== 'undefined' && sessionStorage) ? sessionStorage : null; }
    catch (e) { return null; }
  },
  _gravarSessao(sess) {
    const txt = JSON.stringify(sess);
    const loja = cloud._lojaSessao();
    if (!loja) return false;
    try { loja.setItem(cloud.SESSION_KEY, txt); } catch (e) { return false; }
    try { localStorage.removeItem(cloud.SESSION_KEY); } catch (e) {}
    return true;
  },

  session() {
    try {
      const loja = cloud._lojaSessao();
      if (!loja) return null;
      try { localStorage.removeItem(cloud.SESSION_KEY); } catch (e) {}
      return JSON.parse(loja.getItem(cloud.SESSION_KEY) || 'null');
    }
    catch { return null; }
  },
  estaLogado() {
    const s = cloud.session();
    return !!(s && s.access_token);
  },
  emailLogado() {
    const s = cloud.session();
    return s && s.user && s.user.email || '';
  },
  _ehPublishable(k) { return typeof k === 'string' && k.indexOf('sb_') === 0; },
  _headers(comAuth) {
    const c = cloud.config();
    const key = c.anonKey;
    const h = { 'apikey': key, 'Content-Type': 'application/json' };
    const s = cloud.session();
    const token = (comAuth && s && s.access_token) ? s.access_token : null;
    if (token) {
      /* Usuário logado: Bearer é sempre o token do usuário */
      h['Authorization'] = 'Bearer ' + token;
    } else if (!cloud._ehPublishable(key)) {
      /* Chave legada (JWT) sem sessão: pode ir como Bearer */
      h['Authorization'] = 'Bearer ' + key;
    }
    /* Chave publishable sem sessão: SÓ apikey, nunca Authorization */
    return h;
  },
  async signup(email, senha) {
    if (!cloud.estaConfigurado()) return { ok: false, erro: 'Nuvem não configurada' };
    const c = cloud.config();
    try {
      const r = await fetch(c.url + '/auth/v1/signup', {
        method: 'POST', headers: cloud._headers(false),
        body: JSON.stringify({ email: email.trim(), password: senha })
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = d.msg || d.message || d.error_description || ('HTTP ' + r.status);
        if (/already/i.test(msg)) return { ok: false, erro: 'Este e-mail já tem conta — use "Entrar".' };
        return { ok: false, erro: msg };
      }
      /* Se o projeto exige confirmação de e-mail, não vem access_token */
      if (d.access_token) {
        try { contextoAba.prepararUsuario(d.user && d.user.id, { forcar: true }); } catch (e) {}
        cloud._gravarSessao(d);
        try { cloud._atualizarUI(); } catch (e) {}
        return { ok: true, precisaConfirmar: false };
      }
      return { ok: true, precisaConfirmar: true };
    } catch (e) {
      return { ok: false, erro: 'Falha de rede: ' + e.message };
    }
  },

  /* ==========================================================================
     RECUPERAR A SENHA DA NUVEM

     Não existia. A janela "Entrar na nuvem" exigia a senha e a única saída era
     "Agora não" — que deixa o aparelho fora da sincronização, exatamente o
     estado em que o registro fica preso e ninguém descobre por quê.

     Para o gestor faltava um caminho cômodo (dava para ir ao painel do
     Supabase). Para a secretária não havia caminho nenhum: ela não tem acesso
     ao painel. Ficar sem sincronizar por ter esquecido uma senha é o pior
     motivo possível para um prontuário não chegar ao médico.
  ========================================================================== */
  /* ---- A OUTRA METADE: o link do e-mail chegando de volta ----------------
     Pedir a recuperação era metade do caminho. O Supabase devolve a pessoa ao
     app com o token na âncora:

         .../Soft-Anestesia/#access_token=...&type=recovery&...

     Sem tratar isso, o app lê a âncora como NOME DE MÓDULO — e o link vira um
     beco: a pessoa clica no e-mail, cai no sistema e não acontece nada.
     Aqui a âncora é lida, o token guardado em memória (nunca no localStorage:
     é credencial de uso único) e a URL limpa na hora, para o token não ficar
     no histórico do navegador nem em captura de tela. */
  _lerAncoraAuth() {
    try {
      const h = String(location.hash || '').replace(/^#/, '');
      if (!h || h.indexOf('access_token=') < 0) return null;
      const p = new URLSearchParams(h);
      const token = p.get('access_token');
      if (!token) return null;
      return { token: token, tipo: p.get('type') || '', erro: p.get('error_description') || '' };
    } catch (e) { return null; }
  },
  _limparAncora() {
    try {
      history.replaceState(null, '', location.pathname + location.search + '#dashboard');
    } catch (e) { try { location.hash = '#dashboard'; } catch (e2) {} }
  },

  checarLinkRecuperacao() {
    const a = cloud._lerAncoraAuth();
    if (!a) return false;
    cloud._limparAncora();
    if (a.tipo !== 'recovery') return false;
    cloud._tokenRecuperacao = a.token;
    /* o e-mail vem dentro do próprio token (JWT), sem precisar perguntar */
    try {
      const corpo = JSON.parse(atob(a.token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      cloud._emailRecuperado = corpo.email || '';
    } catch (e) { cloud._emailRecuperado = ''; }
    setTimeout(() => { try { cloud.abrirNovaSenha(); } catch (e) {} }, 300);
    return true;
  },

  /* Duas telas para o mesmo ato, e a escolha não é estética: com a tela de
     acesso aberta, um modal fica ATRÁS dela (1290 contra 100000) e some. */
  abrirNovaSenha() {
    const ov = document.getElementById('auth-overlay');
    const trancado = ov && ov.style.display !== 'none';
    if (trancado && typeof auth !== 'undefined' && auth._telaNovaSenha) auth._telaNovaSenha();
    else cloud.uiNovaSenha();
  },

  /* A troca em si, usada pelas duas telas. */
  /* SENHA PROVISÓRIA TEM DE MORRER NO PRIMEIRO USO. Ela foi criada por outra
     pessoa, ditada por telefone ou mandada por mensagem — continuar valendo é
     deixar o acesso ao prontuário na mão de quem já a viu. A marca vem nos
     metadados da própria conta, então vale em QUALQUER aparelho: trocar de
     computador não contorna a exigência. */
  deveTrocarSenha() {
    try {
      const s = cloud.session();
      const m = s && s.user && (s.user.user_metadata || s.user.raw_user_meta_data);
      return !!(m && m.deve_trocar_senha);
    } catch (e) { return false; }
  },
  validarSenha(senha) {
    const s = String(senha || '');
    if (s.length < 12) return { ok: false, erro: 'A senha precisa de ao menos 12 caracteres.' };
    if (!/[a-z]/.test(s) || !/[A-Z]/.test(s) || !/[0-9]/.test(s) || !/[^A-Za-z0-9]/.test(s)) {
      return { ok: false, erro: 'Use letra minúscula, maiúscula, número e símbolo.' };
    }
    return { ok: true, erro: '' };
  },
  async trocarSenhaLogado(nova) {
    if (!(await cloud._garantirToken())) return { ok: false, erro: cloud.motivoSemToken() };
    const c = cloud.config(); const s = cloud.session();
    try {
      const r = await fetch(c.url + '/auth/v1/user', {
        method: 'PUT',
        headers: Object.assign({}, cloud._headers(false), { 'Authorization': 'Bearer ' + s.access_token }),
        body: JSON.stringify({ password: nova, data: { deve_trocar_senha: false } })
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return { ok: false, erro: d.msg || d.message || d.error_description || ('HTTP ' + r.status) };
      /* a sessão guardada tem de refletir a troca, senão a exigência volta a
         cada tela que pergunta */
      try {
        const nova2 = Object.assign({}, s, { user: d && d.id ? d : s.user });
        if (nova2.user && nova2.user.user_metadata) nova2.user.user_metadata.deve_trocar_senha = false;
        cloud._gravarSessao(nova2);
      } catch (e) {}
      return { ok: true };
    } catch (e) { return { ok: false, erro: 'Falha de rede: ' + e.message }; }
  },

  async trocarSenhaComToken(nova) {
    if (!cloud._tokenRecuperacao) return false;
    const c = cloud.config();
    try {
      const r = await fetch(c.url + '/auth/v1/user', {
        method: 'PUT',
        headers: Object.assign({}, cloud._headers(false),
          { 'Authorization': 'Bearer ' + cloud._tokenRecuperacao }),
        body: JSON.stringify({ password: nova })
      });
      if (!r.ok) return false;
      cloud._tokenRecuperacao = null;   /* uso único */
      return true;
    } catch (e) { return false; }
  },

  uiNovaSenha() {
    if (!cloud._tokenRecuperacao) { toast('O link de recuperação venceu — peça outro', 'warn'); return; }
    modal.open('🔑 Definir nova senha da nuvem',
      '<p style="font-size:.86rem;margin:0 0 10px">Você chegou pelo link do e-mail. Escolha a nova senha da <b>conta da nuvem</b> — ' +
      'é a que este e os outros aparelhos vão usar para sincronizar.</p>' +
      '<div class="grid">' +
      '<div class="field col-12"><label>Nova senha</label><input type="password" id="ns-1" autocomplete="new-password" placeholder="12+ caracteres, maiúscula, número e símbolo"></div>' +
      '<div class="field col-12"><label>Repita a nova senha</label><input type="password" id="ns-2" autocomplete="new-password"></div>' +
      '</div><div id="ns-erro" style="color:#b3261e;font-size:.82rem;min-height:16px"></div>',
      '<button class="btn btn-primary" onclick="cloud._salvarNovaSenha()">Salvar senha</button>' +
      '<button class="btn" onclick="modal.close()">Cancelar</button>');
    setTimeout(() => { const el = document.getElementById('ns-1'); if (el) el.focus(); }, 80);
  },

  async _salvarNovaSenha() {
    const err = document.getElementById('ns-erro');
    const a = (document.getElementById('ns-1') || {}).value || '';
    const b2 = (document.getElementById('ns-2') || {}).value || '';
    const diz = (t) => { if (err) err.textContent = t; };
    const regra = cloud.validarSenha(a); if (!regra.ok) { diz(regra.erro); return; }
    if (a !== b2) { diz('As duas senhas não são iguais.'); return; }
    if (!cloud._tokenRecuperacao) { diz('O link venceu — peça outro e-mail.'); return; }
    diz('Salvando…');
    const ok = await cloud.trocarSenhaComToken(a);
    if (!ok) { diz('Não consegui salvar. O link pode ter vencido — peça outro.'); return; }
    modal.close();
    toast('✅ Senha alterada. Entre com ela para reconectar este aparelho.', 'success');
    setTimeout(() => { try { cloud.reentrar(); } catch (e) {} }, 600);
  },

  async recuperarSenha(email) {
    const alvo = String(email || '').trim();
    if (!alvo || alvo.indexOf('@') < 0) { toast('Informe o e-mail da conta da nuvem', 'warn'); return false; }
    if (!cloud.estaConfigurado()) { toast('Este aparelho ainda não tem a nuvem configurada', 'warn'); return false; }
    const c = cloud.config();
    try {
      /* redirect_to precisa estar na lista de URLs permitidas do projeto
         (Authentication → URL Configuration). Mandamos o endereço do próprio
         app para o link do e-mail trazer a pessoa de volta para cá. */
      const volta = (typeof location !== 'undefined')
        ? location.origin + location.pathname : '';
      const r = await fetch(c.url + '/auth/v1/recover', {
        method: 'POST', headers: cloud._headers(false),
        body: JSON.stringify(volta ? { email: alvo, redirect_to: volta } : { email: alvo })
      });
      /* O Supabase responde 200 mesmo para e-mail inexistente, de propósito:
         dizer "esta conta não existe" entregaria quais e-mails estão
         cadastrados. Então a mensagem aqui é a mesma nos dois casos. */
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        toast('Não consegui pedir a recuperação: ' + (d.msg || d.error_description || d.error || r.status), 'error');
        return false;
      }
      toast('📧 Se houver conta para ' + alvo + ', o link de nova senha chega em instantes. Confira também o spam.', 'success');
      return true;
    } catch (e) {
      toast('Sem conexão para pedir a recuperação agora', 'error');
      return false;
    }
  },

  /* SERVIDOR FORA DO AR ≠ SENHA ERRADA ≠ SESSÃO VENCIDA.
     Os três davam na mesma frase, e a frase acusava a pessoa: "verifique
     email/senha". Quando o servidor da clínica está fora, a equipe inteira
     recebe isso ao mesmo tempo, troca de senha às cegas, sai da nuvem — e sair
     é a única ação que piora de verdade, porque apaga a sessão que ainda era
     boa e não há como obter outra enquanto o servidor não voltar.

     Classificar não é conforto de mensagem: é o que impede a equipe de
     destruir o próprio acesso durante uma queda. */
  _servidorFora: false,
  servidorFora() { return !!cloud._servidorFora; },
  /* O app descobre que o servidor caiu por QUALQUER conversa com ele, não só
     pelo login: o medidor de tráfego já envolve todo fetch do Supabase, então
     é dali que vem o aviso. Sem isto, só quem tentasse entrar ou renovar a
     sessão veria a verdade — quem já estava dentro via "erro" genérico em cada
     módulo e concluía que o sistema quebrou. */
  _observarResposta(resp) {
    if (!resp) return;
    const fora = resp.status >= 500 || resp.status === 540;
    if (fora === !!cloud._servidorFora) return;
    /* 4xx não diz nada sobre o servidor estar de pé — só 5xx e sucesso. */
    if (!fora && !resp.ok) return;
    cloud._servidorFora = fora;
    try { cloud._atualizarUI(); } catch (e) {}
    try { nuvemEstado.render(); } catch (e) {}
  },
  _observarFalhaRede() {
    /* Aparelho sem internet não é servidor fora: a frase e a saída são outras. */
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    if (cloud._servidorFora) return;
    cloud._servidorFora = true;
    try { cloud._atualizarUI(); } catch (e) {}
    try { nuvemEstado.render(); } catch (e) {}
  },
  /* Uma frase só, usada em todo lugar que descobre que não tem token: ela tem
     de dizer QUAL dos dois problemas é, porque a saída é oposta. */
  motivoSemToken() {
    if (cloud.servidorFora()) {
      return '🔌 O servidor da clínica não está respondendo — não é a sua sessão. Continue trabalhando: cada alteração entra na fila cifrada e sobe sozinha. Não saia da nuvem.';
    }
    return 'Sessão da nuvem expirada — entre de novo.';
  },
  _classificarFalhaAuth(r, data) {
    const status = (r && r.status) || 0;
    const texto = String((data && (data.error_description || data.msg || data.message || data.error)) || '');
    if (/paus|suspend|exceed|quota|over.?limit/i.test(texto)) return { tipo: 'fora', detalhe: texto };
    /* E-MAIL NUNCA CONFIRMADO é o caso que mais parece senha errada e menos é:
       a senha pode estar certa, e trocá-la não resolve nada. */
    if (/not.?confirmed|confirma/i.test(texto)) return { tipo: 'nao_confirmado', detalhe: texto };
    if (status === 429) return { tipo: 'excesso', detalhe: texto };
    if (!data || status === 0 || status >= 500 || status === 408) return { tipo: 'fora', detalhe: texto || ('HTTP ' + status) };
    return { tipo: 'credencial', detalhe: texto };
  },
  /* A última falha fica guardada para a TELA de entrada poder dizer o mesmo
     que o aviso — antes ela escrevia "E-mail ou senha inválidos." por cima. */
  _ultimaFalha: null,
  motivoUltimaFalha() {
    return cloud._ultimaFalha ? cloud._frasePelaFalha(cloud._ultimaFalha) : '';
  },
  _frasePelaFalha(f) {
    if (f.tipo === 'nao_confirmado') {
      return '📧 A conta existe e a senha pode estar certa: o que falta é CONFIRMAR o e-mail. ' +
        'Abra o link que o servidor enviou para esse endereço (confira o spam). Trocar a senha não resolve este caso.';
    }
    if (f.tipo === 'fora') {
      return '🔌 O servidor da clínica não está respondendo' + (f.detalhe ? ' (' + f.detalhe + ')' : '') +
        '. NÃO é a sua senha. Continue trabalhando: cada alteração entra na fila cifrada deste aparelho e sobe sozinha quando ele voltar. ' +
        'Não saia da nuvem — isso apagaria a sua sessão.';
    }
    if (f.tipo === 'excesso') {
      return '⏳ Muitas tentativas seguidas. O servidor pediu uma pausa — espere um minuto e tente de novo. A senha pode estar certa.';
    }
    return 'Falha no login: ' + (f.detalhe || 'verifique e-mail e senha');
  },

  async login(email, senha, opts) {
    const tentativa = ++cloud._loginTentativa;
    const calado = !!(opts && opts.silent);
    const diga = (t, k) => { if (!calado) toast(t, k); };
    if (!cloud.estaConfigurado()) { diga('Configure a nuvem primeiro (URL + chave)', 'warn'); return false; }
    const c = cloud.config();
    try {
      const r = await fetch(c.url + '/auth/v1/token?grant_type=password', {
        method: 'POST', headers: cloud._headers(false),
        body: JSON.stringify({ email: email.trim(), password: senha })
      });
      let data = null;
      try { data = await r.json(); } catch (e) { data = null; }
      if (tentativa !== cloud._loginTentativa) return false;
      if (!r.ok || !data || !data.access_token) {
        const f = cloud._classificarFalhaAuth(r, data);
        cloud._ultimaFalha = f;
        cloud._servidorFora = f.tipo === 'fora';
        diga(cloud._frasePelaFalha(f), 'error');
        return false;
      }
      cloud._ultimaFalha = null;
      cloud._servidorFora = false;
      const sess = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        user: data.user,
        expires_at: Date.now() + (data.expires_in || 3600) * 1000
      };
      /* Fecha a gaveta anterior antes de publicar o token novo. O perfil
         ainda vai confirmar a clínica; até lá esta aba não acessa dado
         clínico nem inicia sincronização. */
      try { contextoAba.prepararUsuario(data.user && data.user.id, { forcar: true }); } catch (e) {}
      cloud._gravarSessao(sess);
      diga('✅ Conectado como ' + (data.user && data.user.email || email));
      cloud._atualizarUI();
      /* Sincronizar aqui seria cedo demais: o perfil ainda não confirmou a
         clínica desta conta. O fluxo de autenticação inicia a nuvem somente
         depois de vincular o contexto imutável da aba. */
      return true;
    } catch (e) {
      /* Não houve resposta nenhuma: ou o aparelho está sem rede, ou o servidor
         não está no ar. Em nenhum dos dois casos a senha é o problema. */
      cloud._servidorFora = true;
      cloud._ultimaFalha = { tipo: 'fora', detalhe: e.message };
      diga('🔌 Não consegui falar com o servidor da clínica' +
        (navigator && navigator.onLine === false ? ' — este aparelho está sem internet' : '') +
        '. NÃO é a sua senha. Continue trabalhando: cada alteração entra na fila cifrada e sobe sozinha. (' + e.message + ')', 'error');
      return false;
    }
  },
  /* Busca o perfil + vínculo de organização do usuário logado (Fase 3).
     Retorna { uid, email, nome, role, organization_id, ativo } ou null.
     A RLS deixa o usuário ler o PRÓPRIO profile e os PRÓPRIOS vínculos. */
  async buscarPerfil() {
    if (!cloud.estaConfigurado() || !cloud.estaLogado()) return null;
    if (!(await cloud._garantirToken())) return null;
    const c = cloud.config(); const s = cloud.session();
    if (!s || !s.user) return null;
    const uid = s.user.id;
    try {
      const [rp, ro] = await Promise.all([
        fetch(c.url + '/rest/v1/profiles?id=eq.' + uid + '&select=id,nome,email,funcao,ativo', { headers: cloud._headers(true) }),
        fetch(c.url + '/rest/v1/organization_users?user_id=eq.' + uid + '&ativo=eq.true&select=organization_id,role,ativo,permissoes&order=created_at.asc', { headers: cloud._headers(true) })
      ]);
      /* CONSULTA QUE FALHOU ≠ CONTA SEM CLÍNICA. Antes, um 401/timeout no 4G
         devolvia "semVinculo" — e o aparelho concluía que a conta não pertence
         a clínica nenhuma: parava de sincronizar e ainda rebaixava o usuário.
         Falha de rede agora devolve null (situação desconhecida, nada muda). */
      if (!rp.ok || !ro.ok) return null;
      const perfilRows = await rp.json().catch(() => null);
      const orgRows = await ro.json().catch(() => null);
      if (!Array.isArray(perfilRows) || !Array.isArray(orgRows)) return null;
      const perfil = perfilRows[0] || null;
      const vinc = orgRows[0] || null;
      /* Consultas OK, mas a conta não pertence a nenhuma clínica: isso é um
         RESULTADO (não um erro de rede) — quem chama precisa distinguir para
         aplicar acesso restrito em vez de manter permissões antigas. */
      if (!perfil && !vinc) return { semVinculo: true, uid, email: (s.user && s.user.email) || '', role: null, organization_id: null, ativo: true };
      return {
        uid,
        email: (perfil && perfil.email) || (s.user && s.user.email) || '',
        nome: (perfil && perfil.nome) || '',
        role: (vinc && vinc.role) || (perfil && perfil.funcao) || null,
        organization_id: (vinc && vinc.organization_id) || null,
        semVinculo: !vinc,
        /* QUANTAS clínicas esta conta tem. É o que decide se o backup pessoal
           (que é por usuário, não por organização) é ambíguo ou não: com UMA
           clínica, tudo o que está lá é dela — sem dúvida possível. */
        orgs: orgRows.length,
        /* personalização feita pelo gestor (0011) — vence o padrão do papel */
        permissoes: (vinc && vinc.permissoes) || null,
        ativo: perfil ? perfil.ativo !== false : true
      };
    } catch (e) { return null; }
  },

  /* Converte uma sessão recém-autenticada em contexto operacional. Nenhum
     chamador de `login()` pode sincronizar antes desta confirmação. */
  async confirmarContexto() {
    const contextoInicial = contextoAba.capturar();
    const sessaoInicial = cloud.session();
    const uidInicial = sessaoInicial && sessaoInicial.user && sessaoInicial.user.id;
    if (!uidInicial) return null;
    const perfil = await cloud.buscarPerfil();
    const s = cloud.session();
    const uid = s && s.user && s.user.id;
    if (!perfil || !uid || uid !== uidInicial || perfil.uid !== uid || perfil.ativo === false ||
        !contextoAba.mesmaGeracao(contextoInicial)) return null;
    if (perfil.organization_id) {
      const r = await ambiente.aoEntrar(perfil.organization_id, '', perfil);
      if (r && r.erro) return null;
    } else if (perfil.semVinculo) {
      const r = await ambiente.aoEntrarSemClinica(perfil);
      if (r && r.erro) return null;
    } else return null;
    /* `aoEntrar()` também consulta o nome da clínica. Se outra autenticação
       vencer enquanto essa resposta está em voo, não devolvemos o perfil
       antigo como se ele tivesse confirmado o contexto novo. */
    const contextoFinal = contextoAba.capturar();
    const sessaoFinal = cloud.session();
    const uidFinal = sessaoFinal && sessaoFinal.user && sessaoFinal.user.id;
    const orgEsperada = String(perfil.organization_id || '');
    if (!uidFinal || uidFinal !== uidInicial || !contextoFinal.verified ||
        contextoFinal.userId !== uidInicial ||
        String(contextoFinal.organizationId || '') !== orgEsperada ||
        (!orgEsperada && !contextoFinal.semOrganizationConfirmed)) return null;
    /* Abre o envelope enquanto há rede e sessão válida. Se a conexão cair
       depois, a aba continua capaz de cifrar novas operações; após logout ou
       troca de usuário a chave some da memória e só o mesmo auth.uid() a
       recebe novamente do servidor. */
    if (orgEsperada) {
      try { await persistenciaCloudFirst.aquecer(); }
      catch (e) { try { syncStatus.cloudState('error'); } catch (er) {} }
    }
    return perfil;
  },

  _refreshPromise: null,
  async _renovarToken() {
    /* Refresh tokens rotacionam. Todas as chamadas da aba compartilham a
       mesma promessa para impedir que duas renovações simultâneas invalidem
       uma à outra. */
    if (cloud._refreshPromise) return cloud._refreshPromise;
    cloud._refreshPromise = (async () => {
      const c = cloud.config(); const s = cloud.session();
      if (!s || !s.refresh_token) return false;
      const uidInicial = s.user && s.user.id;
      const contextoInicial = (() => { try { return contextoAba.capturar(); } catch (e) { return null; } })();
      try {
        const r = await fetch(c.url + '/auth/v1/token?grant_type=refresh_token', {
          method: 'POST', headers: cloud._headers(false),
          body: JSON.stringify({ refresh_token: s.refresh_token })
        });
        let data = null;
        try { data = await r.json(); } catch (e) { data = null; }
        if (!r.ok || !data || !data.access_token) {
          const f = cloud._classificarFalhaAuth(r, data);
          cloud._servidorFora = f.tipo !== 'credencial';
          return false;
        }
        cloud._servidorFora = false;
        const sess = {
          access_token: data.access_token,
          refresh_token: data.refresh_token || s.refresh_token,
          user: data.user || s.user,
          expires_at: Date.now() + (data.expires_in || 3600) * 1000
        };
        const atual = cloud.session();
        if (!uidInicial || !atual || !atual.user || atual.user.id !== uidInicial) return false;
        if (contextoInicial && !contextoAba.mesmaGeracao(contextoInicial)) return false;
        /* Outra aba (ou um novo login nesta aba) já pode ter rotacionado o
           refresh token enquanto esta resposta viajava. Nunca ressuscita o
           token antigo por cima de uma sessão mais nova da mesma pessoa. */
        if (atual.refresh_token && atual.refresh_token !== s.refresh_token) return true;
        return cloud._gravarSessao(sess);
      } catch (e) { cloud._servidorFora = true; return false; }
    })();
    try { return await cloud._refreshPromise; }
    finally { cloud._refreshPromise = null; }
  },
  /* Quando a renovação do token falha (sessão velha demais), TODA consulta à
     nuvem passa a voltar 401 e o app parecia "sem clínica". Guardamos esse
     estado para dizer a verdade na tela: é sessão expirada, resolve entrando
     de novo — não é perda de vínculo nem de dados. */
  _tokenFalhou: false,
  sessaoExpirada() { return !!(cloud.session() && cloud._tokenFalhou); },
  async _garantirToken() {
    const s = cloud.session();
    if (!s) return false;
    if (s.expires_at && Date.now() > s.expires_at - 60000) {
      const ok = await cloud._renovarToken();
      /* Só é "sessão vencida" quando o servidor RESPONDEU recusando a sessão.
         Servidor fora do ar não vence sessão de ninguém. */
      cloud._tokenFalhou = !ok && !cloud._servidorFora;
      if (!ok) { try { cloud._atualizarUI(); } catch (e) {} }
      return ok;
    }
    cloud._tokenFalhou = false;
    return true;
  },
  logout(opts) {
    cloud._loginTentativa++;
    const sessaoSaindo = cloud.session();
    const uidSaindo = sessaoSaindo && sessaoSaindo.user && sessaoSaindo.user.id;
    /* A marca de baixa incremental é por usuário, mas limpá-la aqui garante
       que quem entrar depois receba a base inteira em vez de uma faixa. */
    try { cloud.esquecerMarcaBaixa(); } catch (e) {}
    /* SAIR REMOVE O CACHE CONFIRMADO. Com a nuvem como fonte, não há razão
       para esse cache continuar num aparelho compartilhado depois que a
       pessoa saiu: ele volta sozinho quando ela entrar. O que ainda NÃO subiu
       fica na gaveta isolada — ali o aparelho é a única cópia que existe, e
       apagar seria perder. */
    try { modoNuvem.aoSair(); } catch (e) {}
    try { cloud._lojaSessao().removeItem(cloud.SESSION_KEY); } catch (e) {}
    try {
      if (typeof pdfBackup !== 'undefined') {
        pdfBackup._accessToken = null; pdfBackup._tokenExpira = 0;
        sessionStorage.removeItem(pdfBackup.TOKEN_KEY);
        localStorage.removeItem(pdfBackup.TOKEN_KEY);
      }
    } catch (e) {}
    /* Computador compartilhado: o cache já confirmado pode sair; qualquer
       trabalho sem recibo continua na gaveta isolada do dono original. Não se
       baixa backup automático para a pasta pública de uma máquina alheia. */
    let saida = null;
    try { saida = ambiente.aoSair(); } catch (e) {}
    /* Uma aba A não apaga a persistência que outra aba B acabou de gravar. */
    try {
      const p = JSON.parse(localStorage.getItem(cloud.SESSION_KEY) || 'null');
      if (!p || !p.user || !uidSaindo || p.user.id === uidSaindo) localStorage.removeItem(cloud.SESSION_KEY);
    } catch (e) {}
    try { if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(cloud.SESSION_KEY); } catch (e) {}
    try { contextoAba.limpar({ broadcast: !(opts && opts.silent), type: 'logout' }); } catch (e) {}
    if (!(opts && opts.silent)) {
      toast(saida && saida.preservou
        ? '🚪 Desconectado — o trabalho ainda não confirmado ficou protegido neste aparelho e voltará somente para esta conta'
        : saida && saida.limpou
        ? '🚪 Desconectado — este computador é compartilhado, então o cache confirmado da clínica foi removido'
        : 'Desconectado da nuvem');
    }
    cloud._atualizarUI();
  },

  /* Saída iniciada pela interface encerra as DUAS sessões. Desconectar apenas
     o Supabase e deixar o formulário local aberto recriaria um modo clínico
     sem organização, incompatível com a política cloud-only. */
  encerrarAcesso() {
    /* O contexto ainda precisa existir neste instante: é dele que sai o UID
       usado para bloquear as outras abas da mesma conta. */
    try { contextoAba.bloquearOutrasAbas(); } catch (e) {}
    try { cloud.logout({ silent: true }); } catch (e) {}
    try { if (typeof auth !== 'undefined') auth.logout(); } catch (e) {}
    try { toast('🚪 Sessão encerrada neste aparelho. Entre novamente para acessar uma clínica.', 'success'); } catch (e) {}
    return true;
  },

  /* ---- Fila offline (operações que falharam por falta de internet) ---- */
  _donoFila() { try { return contextoAba.donoFila(); } catch (e) { return null; } },
  _mesmoDonoFila(op, dono) {
    return !!op && !!dono && op.organizationId === dono.organizationId &&
      op.userId === dono.userId && op.deviceId === dono.deviceId;
  },
  _filaTodas() {
    try { const q = JSON.parse(localStorage.getItem(cloud.QUEUE_KEY) || '[]'); return Array.isArray(q) ? q : []; }
    catch (e) { return []; }
  },
  _fila() {
    const dono = cloud._donoFila();
    if (!dono) return [];
    return cloud._filaTodas().filter(x => cloud._mesmoDonoFila(x, dono));
  },
  _enfileirar(op) {
    const dono = cloud._donoFila(); if (!dono) return false;
    const q = cloud._fila();
    /* dedup: mantém só a última operação por modulo+doc_id */
    const filtrada = q.filter(x => !(x.modulo === op.modulo && x.doc_id === op.doc_id));
    filtrada.push(Object.assign({}, op, { organizationId: dono.organizationId,
      userId: dono.userId, deviceId: dono.deviceId, tabId: dono.tabId }));
    const outras = cloud._filaTodas().filter(x => !cloud._mesmoDonoFila(x, dono));
    try { localStorage.setItem(cloud.QUEUE_KEY, JSON.stringify(outras.concat(filtrada.slice(-500)))); return true; } catch (e) { return false; }
  },
  _limparFila() {
    const dono = cloud._donoFila(); if (!dono) return false;
    try {
      localStorage.setItem(cloud.QUEUE_KEY, JSON.stringify(
        cloud._filaTodas().filter(x => !cloud._mesmoDonoFila(x, dono))));
      return true;
    } catch (e) { return false; }
  },

  /* ============================================================
     🚑 RESTAURAÇÃO COMPLETA DA CLÍNICA
     Traz somente as tabelas relacionais da organização autenticada. O acervo
     pessoal antigo está congelado e só pode ser lido pela ferramenta auditada
     do programador; nunca é despejado no ambiente que estiver aberto.
  ============================================================ */
  async restaurarTudoDaNuvem(opts = {}) {
    const rel = { relacional: {}, novos: 0, jaTinha: 0, atualizados: 0, erro: null };
    if (!cloud.estaConfigurado()) { rel.erro = 'A nuvem não está configurada neste aparelho.'; return rel; }
    if (!cloud.estaLogado()) { rel.erro = 'Entre na nuvem para restaurar (Ajustes → Backup e sincronização).'; return rel; }
    const contexto = cloudRel._capturarContexto();
    if (!contexto) { rel.erro = 'Não foi possível confirmar a clínica desta aba.'; return rel; }
    if (!(await cloud._garantirToken())) { rel.erro = cloud.motivoSemToken(); return rel; }
    if (!cloudRel._contextoValido(contexto, contexto.organizationId)) return rel;
    const prog = (t) => { const el = document.getElementById('restaura-nuvem-prog'); if (el) el.textContent = t; };

    /* CANAL RELACIONAL — sempre filtrado pela organização autenticada. */
    try {
      if (cloudRel.disponivel()) {
        const org = contexto.organizationId;
        if (org) {
          for (const mod of Object.keys(cloudRel.MODOS)) {
            if (!cloudRel._contextoValido(contexto, org)) return rel;
            prog('⏳ Lendo a clínica… ' + mod);
            let remotos = null;
            try { remotos = await cloudRel.puxarModulo(mod); } catch (e) {}
            if (!cloudRel._contextoValido(contexto, org)) return rel;
            if (!Array.isArray(remotos)) continue;
            rel.relacional[mod] = remotos.length;
            const m = cloudRel.mesclarLocal(mod, remotos);
            rel.novos += m.novos; rel.atualizados += m.atualizados; rel.jaTinha += m.iguais;
          }
          try { await pacientes.sincronizarNuvem({ silent: true }); } catch (e) {}
          if (!cloudRel._contextoValido(contexto, org)) return rel;
          try { await agenda.sincronizarNuvem({ silent: true }); } catch (e) {}
        }
      }
    } catch (e) {}
    prog('');
    if (!opts.silent) cloud._mostrarRelatorioRestauracao(rel);
    try { armazenamento.render(); } catch (e) {}
    try { if (state.currentModule === 'dashboard') dashboard.atualizar(); } catch (e) {}
    return rel;
  },
  _mostrarRelatorioRestauracao(rel) {
    const linhas = [];
    const rot = { pre: 'Pré-anestésicas', consulta: 'Consultas', anestesia: 'Fichas de anestesia',
      recuperacao: 'SRPA', termo: 'Termos', prescricao: 'Receitas', documentos: 'Documentos',
      risco: 'Riscos', financeiro: 'Financeiro', orcamento: 'Orçamentos', agenda: 'Agenda', pacientes: 'Pacientes' };
    const mods = Object.keys(rel.relacional).sort();
    mods.forEach(m => {
      const b = rel.relacional[m] || 0;
      if (!b) return;
      linhas.push('<tr><td>' + (rot[m] || m) + '</td><td style="text-align:right">' + b + '</td></tr>');
    });
    const corpo =
      (rel.erro ? '<p style="color:#b3261e;font-size:.86rem"><b>' + utils.escapeHTML(rel.erro) + '</b></p>' : '') +
      '<p style="font-size:.88rem;margin:0 0 10px">Carreguei <b>' + rel.novos + '</b> registro(s) na memória desta sessão' +
      (rel.atualizados ? ' · <b>' + rel.atualizados + '</b> atualizado(s) com a versão mais recente' : '') +
      (rel.jaTinha ? ' · ' + rel.jaTinha + ' já estavam carregados' : '') + '.</p>' +
      (linhas.length
        ? '<table class="dash-detail-table" style="margin:0"><thead><tr><th>Módulo</th><th style="text-align:right">Clínica</th></tr></thead><tbody>' + linhas.join('') + '</tbody></table>'
        : '<p style="font-size:.86rem;color:var(--text-mute)">Não encontrei registros visíveis nesta clínica.</p>') +
      (!rel.novos && !linhas.length
        ? '<div style="margin-top:12px;font-size:.82rem;background:var(--surface-alt);padding:10px;border-radius:7px">' +
          'Confira se esta é a <b>clínica correta</b> e se a sua conta possui acesso aos módulos esperados. ' +
          'Dados antigos sem organização não são importados automaticamente; somente o programador pode classificá-los e migrá-los com auditoria.' +
          '</div>'
        : '');
    modal.open('🚑 Restauração da nuvem', corpo, '<button class="btn" onclick="modal.close()">Fechar</button>');
  },

  /* ---- Monta uma operação idempotente para a fila/envio ---- */
  _novaOp(modulo, item, operacao) {
    return {
      operation_id: (typeof utils !== 'undefined' && utils.uid) ? utils.uid()
                    : (String(Date.now()) + Math.random().toString(16).slice(2)),
      modulo, doc_id: item._id, operacao,
      dados: item,
      base_version: item._updatedAt || null,  // versão em que a operação nasceu
      retry_count: 0,
      ts: Date.now()
    };
  },

  /* Canal pessoal encerrado. Estes dois métodos permanecem como sentinelas
     temporárias para versões antigas/testes: nunca fazem I/O e nunca criam
     operação nova fora de uma organização. */
  async pushDoc(modulo, item, operacao) {
    return { ok: false, motivo: 'canal_pessoal_encerrado' };
  },
  async _enviarOp(op) {
    return false;
  },

  /* Converte UMA VEZ a fila criada por versões anteriores. Upserts passam a
     apontar para a fila relacional; deletes preservam a chave numa fila de
     soft-delete. Cadastros e preferências são enviados pelo estado completo
     atual, portanto não dependem da sequência antiga. */
  async _migrarFilaLegada() {
    if (typeof persistenciaCloudFirst === 'undefined') return 0;
    try {
      const r = await persistenciaCloudFirst.migrarLegado();
      return (r && r.migradas) || 0;
    } catch (e) { return 0; }
  },

  /* ---- Sincronização completa (envia pendências + baixa da nuvem) ---- */
  async sincronizar(opts = {}) {
    if (typeof demo !== 'undefined' && demo.ativo()) { if (!opts.silent) toast('🧪 Modo demonstração não sincroniza com a nuvem', 'warn'); return; }
    if (!cloud.estaConfigurado()) { if (!opts.silent) toast('Configure a nuvem primeiro', 'warn'); return; }
    if (!cloud.estaLogado()) { if (!opts.silent) toast('Faça login na nuvem primeiro', 'warn'); return; }
    /* contas diferentes (app × nuvem): sincronizar aqui gravaria/leria na conta
       errada — para tudo e chama a correção */
    const div = cloud.divergencia();
    if (div) {
      try { cloud._renderAvisoDivergencia(); } catch (e) {}
      if (!opts.silent) cloud.resolverDivergencia();
      return;
    }
    const contexto = (typeof cloudRel !== 'undefined') ? cloudRel._capturarContexto() : null;
    if (!contexto) {
      if (!opts.silent) toast('A clínica desta aba ainda não foi confirmada. A sincronização foi bloqueada.', 'warn');
      return;
    }
    const contextoValido = () => cloudRel._contextoValido(contexto, contexto.organizationId);
    if (cloud._syncing) return;
    cloud._syncing = true;
    cloud._atualizarUI('sincronizando');
    try {
      /* 1) Filas antigas são convertidas; nenhuma delas volta ao canal pessoal. */
      await cloud._migrarFilaLegada();
      if (!contextoValido()) return;
      /* 2) O diário cifrado cloud-first tem prioridade. As chamadas legadas
            seguintes existem só como compatibilidade durante a conversão. */
      try { await persistenciaCloudFirst.drenar(); } catch (e) {}
      if (!contextoValido()) return;
      /* 3) Drena somente operações vinculadas à organização autenticada. */
      try { await cloudRel.drenarFila(); } catch (e) {}
      if (!contextoValido()) return;
      try { await cloudRel.drenarFilaDel(); } catch (e) {}
      if (!contextoValido()) return;
      try { await cloudRel.drenarConflitos(); } catch (e) {}
      if (!contextoValido()) return;
      try { await cloudRel.empurrarPendentes({ silent: true }); } catch (e) {}
      if (!contextoValido()) return;
      try { await adendos.enviarPendentes(); } catch (e) {}
      if (!contextoValido()) return;
      /* 4) Envio integral solicitado pelo usuário continua organizacional. */
      if (opts.enviarTudo) {
        try { await cloudRel.enviarTudoParaClinica({ silent: true }); } catch (e) {}
        if (!contextoValido()) return;
        try {
          for (const item of store.list('agenda')) {
            if (!contextoValido()) return;
            if (item && item._id) await cloudRel.enviarAgenda(item);
          }
        } catch (e) {}
        if (!contextoValido()) return;
      }
      /* 5) Traz pacientes, agenda e módulos relacionais da clínica. */
      try { await pacientes.sincronizarNuvem({ silent: true }); } catch (e) {}
      if (!contextoValido()) return;
      try { await agenda.sincronizarNuvem({ silent: true }); } catch (e) {}
      if (!contextoValido()) return;
      for (const mod of Object.keys(cloudRel.MODOS || {})) {
        if (!contextoValido()) return;
        try { cloudRel._puxados[mod] = false; await cloudRel.autoPullModulo(mod); } catch (e) {}
      }
      try { await adendos.puxarTodos(); } catch (e) {}
      if (!contextoValido()) return;
      localStorage.setItem('medsys.v7.cloud.ultimo_sync', new Date().toISOString());
      /* 6) Atualiza as configurações da organização (ex.: visibilidade dos
         registros) — best-effort, não bloqueia o sync */
      try { if (typeof orgSettings !== 'undefined') orgSettings.puxar(); } catch (e) {}
      /* 7) Configurações do app (termo/textos/logo/tema…) — sobe mudanças e
         baixa o que estiver mais novo na nuvem, por chave */
      try { if (typeof configSync !== 'undefined') { configSync.checarMudancas(); configSync.puxarAplicar(); } } catch (e) {}
      if (!opts.silent) toast('☁️ Clínica sincronizada');
      cloud._atualizarUI('ok');
    } catch (e) {
      if (!opts.silent) toast('Erro ao sincronizar: ' + e.message, 'error');
      cloud._atualizarUI('erro');
    } finally {
      cloud._syncing = false;
    }
  },
  /* Remove apenas os cursores deixados pelo canal pessoal em versões antigas.
     Eles não participam mais de nenhuma leitura ou decisão de sincronização. */
  _MARCA_BAIXA: 'medsys.v7.cloud.marca_baixa',
  esquecerMarcaBaixa() {
    try {
      cofre.chaves().forEach(k => {
        if (k.indexOf(cloud._MARCA_BAIXA) === 0) localStorage.removeItem(k);
      });
    } catch (e) {}
  },

  /* ---- Conta quantos registros locais existem (para mostrar na UI) ---- */
  _totalLocal() {
    return cloud.MODS.reduce((s, m) => s + store.list(m).length, 0);
  },

  /* ---- Atualiza a interface (status na tela de Ajustes) ---- */
  _atualizarUI(estado) {
    /* aba do programador aparece/some conforme a conta logada na nuvem */
    try { if (typeof programador !== 'undefined') programador.atualizarVisibilidade(); } catch (e) {}
    /* aviso de contas diferentes (app × nuvem) */
    try { cloud._renderAvisoDivergencia(); } catch (e) {}
    /* Reflete o estado no selo honesto do cabeçalho também */
    try {
      if (estado === 'sincronizando') { syncStatus._cloud = 'syncing'; syncStatus._render(); }
      else if (estado === 'ok') syncStatus.cloudState('synced');
      else if (estado === 'erro') syncStatus.cloudState('error');
      else syncStatus.refresh();
    } catch (e) {}
    const badge = document.getElementById('cloud-status-badge');
    const info = document.getElementById('cloud-status-info');
    if (badge) {
      if (!cloud.estaConfigurado()) { badge.textContent = '○ Nuvem não configurada'; badge.className = 'cloud-badge off'; }
      else if (!cloud.estaLogado()) { badge.textContent = '○ Configurada — não conectada'; badge.className = 'cloud-badge off'; }
      else if (estado === 'sincronizando') { badge.textContent = '⟳ Sincronizando…'; badge.className = 'cloud-badge sync'; }
      else if (estado === 'erro') { badge.textContent = '⚠ Erro de sincronização'; badge.className = 'cloud-badge erro'; }
      else { badge.textContent = '● Conectado — ' + cloud.emailLogado(); badge.className = 'cloud-badge on'; }
    }
    if (info) {
      const ultimo = localStorage.getItem('medsys.v7.cloud.ultimo_sync');
      const filaLegada = cloud._fila().length;
      const filaRel = (() => { try { return cloudRel.filaPendentes(); } catch (e) { return 0; } })();
      const filaDel = (() => { try { return cloudRel._filaDelLer().length; } catch (e) { return 0; } })();
      const conflitos = (() => { try { return cloudRel.conflitosPendentes(); } catch (e) { return 0; } })();
      const fila = filaLegada + filaRel + filaDel;
      let txt = cloud._totalLocal() + ' registro(s) carregado(s) nesta sessão.';
      if (ultimo) txt += ' Última sincronização: ' + new Date(ultimo).toLocaleString('pt-BR') + '.';
      if (fila) txt += ' ' + fila + ' aguardando envio.';
      if (conflitos) txt += ' ' + conflitos + ' conflito(s) preservado(s), aguardando decisão.';
      info.textContent = txt;
    }
    /* Mostra/esconde campos conforme estado */
    const loginBox = document.getElementById('cloud-login-box');
    const logoutBox = document.getElementById('cloud-logout-box');
    if (loginBox && logoutBox) {
      const logado = cloud.estaLogado();
      loginBox.style.display = (cloud.estaConfigurado() && !logado) ? '' : 'none';
      logoutBox.style.display = logado ? '' : 'none';
    }
    const cfgBox = document.getElementById('cloud-config-box');
    if (cfgBox) {
      const c = cloud.config();
      const urlEl = cfgBox.querySelector('[name="cloud_url"]');
      const keyEl = cfgBox.querySelector('[name="cloud_key"]');
      if (urlEl && c && !urlEl.value) urlEl.value = c.url || '';
      if (keyEl && c && !keyEl.value) keyEl.value = c.anonKey || '';
    }
  },

  /* ---- Handlers chamados pela tela de Ajustes ---- */
  uiSalvarConfig() {
    const url = document.querySelector('#cloud-config-box [name="cloud_url"]').value;
    const key = document.querySelector('#cloud-config-box [name="cloud_key"]').value;
    if (cloud.salvarConfig(url, key)) cloud._atualizarUI();
  },
  async uiLogin() {
    const email = document.querySelector('#cloud-login-box [name="cloud_email"]').value;
    const senha = document.querySelector('#cloud-login-box [name="cloud_senha"]').value;
    if (!email || !senha) { toast('Informe email e senha', 'warn'); return; }
    const ok = await cloud.login(email, senha);
    if (!ok) return;
    const perfil = await cloud.confirmarContexto();
    if (!perfil) { toast('A conta entrou, mas a clínica não pôde ser confirmada. A sincronização continua bloqueada.', 'error'); return; }
    try { await auth.atualizarPapelDaNuvem(); } catch (e) {}
    try { cloud.autoSyncAoEntrar(); } catch (e) {}
  },
  uiLogout() {
    const msg = 'Sair deste aparelho?\n\nA tela será bloqueada e a sessão da nuvem será encerrada. Trabalho offline ainda não confirmado permanece cifrado e isolado para esta conta até o próximo acesso online.';
    if (confirm(msg)) cloud.encerrarAcesso();
  },
  uiSincronizar() { cloud.sincronizar({ enviarTudo: true }); },

  /* ENTRAR DE NOVO NA NUVEM (sessão expirada) — pede só a senha, já com o
     e-mail que está em uso, e volta a sincronizar. Nada é apagado. */
  reentrar() {
    const s = cloud.session();
    const email = (s && s.user && s.user.email) ||
                  (() => { try { const u = auth.usuarioAtual(); return (u && u.usuario) || ''; } catch (e) { return ''; } })();
    /* Mesmo modal serve para dois casos: sessão vencida e aparelho que nunca
       entrou. Dizer "venceu" para quem nunca entrou só confunde. */
    const nunca = !(s && s.user);
    modal.open(nunca ? '☁️ Entrar na nuvem' : '🔑 Entrar de novo na nuvem',
      '<p style="font-size:.86rem;margin:0 0 10px">' +
      (nunca
        ? 'Este aparelho ainda não está conectado à nuvem da clínica. Entre com o seu <b>e-mail e senha</b> para ver e enviar tudo.'
        : 'A sessão deste aparelho venceu. Entrar de novo <b>não apaga nada</b> — só reabre a conversa com a clínica.') +
      '</p>' +
      '<div class="grid">' +
      '<div class="field col-12"><label>E-mail</label><input type="email" id="reent-email" value="' + utils.escapeAttr(email) + '" autocomplete="username"></div>' +
      '<div class="field col-12"><label>Senha da nuvem</label><input type="password" id="reent-senha" placeholder="••••••" autocomplete="current-password"></div>' +
      '</div><div id="reent-erro" style="color:#b3261e;font-size:.82rem;min-height:16px"></div>' +
      /* Sem esta saída, quem esqueceu a senha só tinha "Agora não" — e "agora
         não" deixa o aparelho fora da sincronização por tempo indeterminado. */
      '<div style="margin-top:2px"><a href="javascript:void(0)" onclick="cloud._reentrarRecuperar()" ' +
      'style="color:var(--primary);font-size:.84rem">Esqueci a senha — receber link por e-mail</a></div>',
      '<button class="btn btn-primary" onclick="cloud._reentrarConfirmar()">Entrar</button>' +
      '<button class="btn" onclick="modal.close()">Agora não</button>');
    setTimeout(() => { const el = document.getElementById('reent-senha'); if (el) el.focus(); }, 80);
  },
  /* Usa o e-mail que já está no campo — quem esqueceu a senha não deve ter de
     lembrar em qual e-mail se cadastrou também. */
  async _reentrarRecuperar() {
    const email = ((document.getElementById('reent-email') || {}).value || '').trim();
    const err = document.getElementById('reent-erro');
    if (!email) { if (err) err.textContent = 'Informe o e-mail para receber o link.'; return; }
    if (err) { err.style.color = 'var(--text-soft)'; err.textContent = 'Pedindo o link…'; }
    const ok = await cloud.recuperarSenha(email);
    if (err) {
      err.style.color = ok ? '#1f7a4d' : '#b3261e';
      err.textContent = ok
        ? 'Link enviado para ' + email + '. Confira a caixa de entrada e o spam.'
        : 'Não consegui pedir o link agora.';
    }
  },

  async _reentrarConfirmar() {
    const email = (document.getElementById('reent-email') || {}).value || '';
    const senha = (document.getElementById('reent-senha') || {}).value || '';
    const err = document.getElementById('reent-erro');
    if (!email || !senha) { if (err) err.textContent = 'Informe e-mail e senha.'; return; }
    if (err) err.textContent = 'Entrando…';
    let ok = false;
    try { cloud.logout({ silent: true }); } catch (e) {}
    try { ok = await cloud.login(email, senha); } catch (e) { ok = false; }
    if (!ok) { if (err) err.textContent = 'E-mail ou senha não conferem.'; return; }
    let perfil = null;
    try { perfil = await cloud.confirmarContexto(); } catch (e) {}
    if (!perfil) { if (err) err.textContent = 'Não consegui confirmar sua clínica. A sincronização não foi iniciada.'; return; }
    try { await auth.atualizarPapelDaNuvem(); } catch (e) {}
    cloud._tokenFalhou = false;
    modal.close();
    toast('✅ Nuvem reconectada — atualizando…');
    try { cloud.autoSyncAoVoltar({ forcar: true }); } catch (e) {}
    setTimeout(() => { try { cloudDiag.rodar(); } catch (e) {} }, 3000);
  },

  /* ============================================================
     ⚠️ CONTA DIVERGENTE (app × nuvem)
     O app tem DUAS identidades: o login da tela (auth) e a sessão da
     nuvem (Supabase). Se ficarem em contas diferentes — ex.: entrar
     como mpcaliman enquanto a nuvem segue conectada como a conta da
     secretária — as gravações sobem para a conta ERRADA e "puxar da
     nuvem" não acha nada. Aqui isso é detectado, a sincronização é
     BLOQUEADA e o app oferece a correção em um toque.
  ============================================================ */
  divergencia() {
    try {
      const s = cloud.session();
      const u = (typeof auth !== 'undefined' && auth.usuarioAtual) ? auth.usuarioAtual() : null;
      const emailNuvem = String((s && s.user && s.user.email) || '').toLowerCase();
      const emailApp = String((u && u.usuario) || '').toLowerCase();
      if (!emailNuvem || !emailApp || emailApp.indexOf('@') < 0) return null;
      if (emailNuvem === emailApp) return null;
      return { app: emailApp, nuvem: emailNuvem };
    } catch (e) { return null; }
  },
  /* Modal de correção — reconectar como a conta do app, ou desconectar */
  resolverDivergencia() {
    const d = cloud.divergencia();
    if (!d) { toast('As contas estão iguais — nada a corrigir.'); return; }
    modal.open('⚠️ Contas diferentes',
      '<p style="font-size:.88rem;margin:0 0 10px">Você entrou no app como <b>' + utils.escapeHTML(d.app) + '</b>, mas a <b>nuvem</b> está conectada como <b>' + utils.escapeHTML(d.nuvem) + '</b>.</p>' +
      '<p style="font-size:.84rem;color:var(--text-soft);margin:0 0 12px">Enquanto estiver assim, a <b>sincronização fica parada</b> — para não gravar os seus dados na conta errada nem misturar bancos.</p>' +
      '<div class="grid">' +
        '<div class="field col-12"><label>Senha da nuvem de <b>' + utils.escapeHTML(d.app) + '</b></label>' +
        '<input type="password" id="div-senha" placeholder="••••••" autocomplete="current-password"></div>' +
      '</div>' +
      '<div id="div-erro" style="color:#b3261e;font-size:.82rem;min-height:16px"></div>',
      '<button class="btn btn-primary" onclick="cloud._reconectarComoApp()">🔓 Conectar como ' + utils.escapeHTML(d.app) + '</button>' +
      '<button class="btn" onclick="modal.close(); cloud.encerrarAcesso()">🚪 Encerrar esta sessão</button>');
  },
  async _reconectarComoApp() {
    const d = cloud.divergencia();
    if (!d) { modal.close(); return; }
    const senha = (document.getElementById('div-senha') || {}).value || '';
    const err = document.getElementById('div-erro');
    if (!senha) { if (err) err.textContent = 'Informe a senha da nuvem.'; return; }
    if (err) err.textContent = 'Conectando…';
    try { cloud.logout({ silent: true }); } catch (e) {}
    let ok = false;
    try { ok = await cloud.login(d.app, senha); } catch (e) { ok = false; }
    if (!ok) { if (err) err.textContent = 'Não consegui entrar com essa senha.'; return; }
    let perfil = null;
    try { perfil = await cloud.confirmarContexto(); } catch (e) {}
    if (!perfil) { if (err) err.textContent = 'A conta entrou, mas a clínica não pôde ser confirmada.'; return; }
    try { await auth.atualizarPapelDaNuvem(); } catch (e) {}
    modal.close();
    toast('✅ Nuvem reconectada como ' + d.app + ' — sincronizando…');
    try { cloud.autoSyncAoEntrar(); } catch (e) {}
    try { cloud._atualizarUI(); } catch (e) {}
  },
  /* Aviso fixo no card da nuvem enquanto as contas estiverem diferentes */
  _renderAvisoDivergencia() {
    const host = document.getElementById('cloud-status-info');
    const d = cloud.divergencia();
    let box = document.getElementById('cloud-divergencia');
    if (!d) { if (box) box.remove(); return; }
    if (!box) {
      box = document.createElement('div');
      box.id = 'cloud-divergencia';
      box.style.cssText = 'background:#fff4e5;border:1px solid #f0c890;color:#7a4b12;border-radius:8px;padding:10px 12px;margin:10px 0;font-size:.83rem';
      const card = document.getElementById('cloud-card');
      const body = card && card.querySelector('.card-body');
      if (body) body.insertBefore(box, body.firstChild); else if (host) host.parentNode.insertBefore(box, host);
    }
    box.innerHTML = '⚠️ <b>Contas diferentes:</b> o app está com <b>' + utils.escapeHTML(d.app) +
      '</b> e a nuvem com <b>' + utils.escapeHTML(d.nuvem) + '</b>. A sincronização está <b>parada</b>. ' +
      '<button class="btn btn-xs btn-primary" style="margin-left:6px" onclick="cloud.resolverDivergencia()">Corrigir agora</button>';
  },

  /* Sincronização completa e silenciosa ao entrar: drena filas vinculadas ao
     ambiente e força um pull relacional novo. */
  /* Redesenha a tela aberta depois de um pull (Dashboard, Pacientes, Agenda) */
  _repintarTelaAtual() {
    const mod = (typeof state !== 'undefined' && state.currentModule) || '';
    if (mod === 'dashboard') {
      try { dashboard.atualizar(); } catch (e) {}
      try { meuDia.render(); } catch (e) {}
      try { pendencias.renderDashboard(); } catch (e) {}
      try { pendProntuario.renderDashboard(); } catch (e) {}
    } else if (mod === 'pacientes') { try { pacientes.render(); } catch (e) {} }
    else if (mod === 'agenda') { try { agenda.render(); } catch (e) {} }
  },
  autoSyncAoEntrar() {
    try {
      if (!cloud.estaConfigurado() || !cloud.estaLogado()) return;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      if (typeof cloudRel === 'undefined' || !cloudRel.disponivel()) return;
      const contexto = cloudRel._capturarContexto();
      if (!contexto) return;
      const contextoValido = () => cloudRel._contextoValido(contexto, contexto.organizationId);
      const agendar = (fn, ms) => setTimeout(() => {
        if (!contextoValido()) return;
        try { fn(); } catch (e) {}
      }, ms);
      cloud._ultimoPull = Date.now();
      agendar(() => cloud.sincronizar({ silent: true }), 900);
      /* configurações (termo/textos/logomarca/tema/preferências) descem também */
      agendar(() => { if (typeof configSync !== 'undefined') configSync.puxarAplicar(); }, 1200);
      /* PAPEL do servidor reaplicado a cada entrada: se o gestor mudou o papel
         de alguém, o aparelho dessa pessoa obedece sem depender de botão */
      agendar(() => auth.atualizarPapelDaNuvem(), 1400);
      /* Pendências: aqui só o CARTÃO do Dashboard se atualiza. A janela é
         assunto de login — esta rotina roda também a cada 10 minutos e ao
         voltar para a aba, e abrir a janela nessas horas era interromper o
         atendimento de meia em meia hora. */
      agendar(() => { try { if (typeof pendencias !== 'undefined') pendencias.renderDashboard(); } catch (e) {}
                      try { if (typeof pendProntuario !== 'undefined') pendProntuario.renderDashboard(); } catch (e) {} }, 3200);
      agendar(() => {
        try {
          if (typeof cloudRel !== 'undefined' && cloudRel.autoPullModulo) {
            cloudRel._puxados = {};   /* qualquer módulo visitado puxa de novo nesta sessão */
            /* Quando os registros CHEGAM, reconfere as pendências. Esperar só
               o relógio funcionaria, mas isto avisa no instante certo — e é o
               que faz a janela aparecer para quem não tem nada no aparelho e
               depende inteiramente do que vem da nuvem. */
            /* A lista vem do painel: faltava `consulta` aqui, e o cartão
               "Consultas / Dor" só contava o que estava no aparelho. */
            const mods = (typeof dashboard !== 'undefined' && dashboard.MODULOS_DADOS)
              ? dashboard.MODULOS_DADOS : ['pre', 'anestesia', 'recuperacao', 'financeiro'];
            Promise.all(mods.map(m => {
              try { return Promise.resolve(cloudRel.autoPullModulo(m)).catch(() => {}); }
              catch (e) { return Promise.resolve(); }
            })).then(() => {
              if (!contextoValido()) return;
              try { if (typeof pendencias !== 'undefined') pendencias.checarAoEntrar(); } catch (e) {}
              /* Lançamento errado pode chegar de um aparelho que ainda não
                 atualizou — conserta na chegada, não só na abertura. */
              try { if (typeof fin !== 'undefined') fin.repararEAvisar(); } catch (e) {}
              /* E redesenha AGORA, que é quando os dados chegaram. O repintar
                 por relógio (4,2 s) continua abaixo como rede de segurança,
                 mas ele sozinho perdia a corrida em qualquer conexão lenta:
                 disparava antes do pull terminar e o painel ficava com os
                 números velhos até trocar de módulo. */
              try { cloud._repintarTelaAtual(); } catch (e) {}
            });
          }
          if (typeof pacientes !== 'undefined' && pacientes.sincronizarNuvem) {
            try { pacientes._puxouNestaSessao = false; pacientes.sincronizarNuvem({ silent: true }); } catch (e) {}
          }
        } catch (e) {}
      }, 1600);
      /* O que foi salvo enquanto a clínica não era conhecida sobe agora — sem
         isso, o registro de um usuário nunca chegava aos outros do consultório */
      agendar(() => cloudRel.empurrarPendentes({ silent: true }), 2600);
      /* O APARELHO SE ESVAZIA SOZINHO. A nuvem é a dona: depois que o que
         estava pendente subiu, o que já tem espelho confirmado e saiu da
         janela de trabalho não precisa mais ocupar lugar aqui. Sem este passo
         automático, "modo nuvem" dependia de alguém lembrar de um botão — e
         ninguém lembra de um botão de limpeza antes do aparelho encher. */
      agendar(() => {
        try {
          const n = modoNuvem.manutencao({ silent: true });
          if (n) { try { armazenamento.render(); } catch (e) {} }
        } catch (e) {}
      }, 4000);
      /* A partir daqui o aparelho se acerta sozinho, de minuto em minuto, sem
         ninguém tocar em nada (ver sincronia). */
      try { sincronia.iniciar(); } catch (e) {}
      try { conexao.iniciar(); } catch (e) {}
      try { conexao.blindarCompartilhado(); } catch (e) {}
      /* rascunhos: ficha começada no celular aparece no computador */
      agendar(() => {
        try { rascunhosSync.enviarTodos(); } catch (e) {}
        try { rascunhosSync.puxarTodos({ silent: true }); } catch (e) {}
      }, 3000);
      /* cadastros e modelos DA CLÍNICA: equipe, convênios, hospitais,
         logomarca, termo… — o que um cadastrou vale para todos */
      agendar(() => clinicaSync.sincronizarAgora({ silent: true }), 3600);
      /* O que acabou de descer precisa aparecer na tela aberta — senão o
         Dashboard segue com os números velhos até trocar de módulo. */
      agendar(() => cloud._repintarTelaAtual(), 4200);
    } catch (e) {}
  },
  /* ------------------------------------------------------------------
     ATUALIZAR AO VOLTAR PARA O APP
     Antes, o pull completo (pacientes + módulos + configurações) só
     acontecia no LOGIN. No celular a sessão fica aberta o dia inteiro: o
     aparelho drenava a fila de envio, mas nunca BAIXAVA o que tinha sido
     feito no PC — daí a lista de pacientes curta e o Dashboard velho.
     Agora ele também atualiza ao trazer o app de volta à frente e ao
     reconectar, com um intervalo mínimo para não pesar no 4G.
  ------------------------------------------------------------------ */
  _ultimoPull: 0,
  INTERVALO_PULL: 3 * 60 * 1000,
  autoSyncAoVoltar(opts = {}) {
    try {
      if (!cloud.estaConfigurado() || !cloud.estaLogado()) return false;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
      if (cloud.divergencia()) return false;
      if (typeof cloudRel === 'undefined' || !cloudRel.disponivel()) return false;
      const agora = Date.now();
      if (!opts.forcar && (agora - cloud._ultimoPull) < cloud.INTERVALO_PULL) return false;
      cloud._ultimoPull = agora;
      cloud.autoSyncAoEntrar();
      return true;
    } catch (e) { return false; }
  },
  /* Liga os gatilhos (chamado uma vez na inicialização) */
  vigiarRetorno() {
    if (typeof document === 'undefined' || cloud._vigiandoRetorno) return;
    cloud._vigiandoRetorno = true;
    /* Atualização periódica COMPLETA: mesmo com o app aberto o dia todo, a
       cada 10 minutos o aparelho busca o que os outros fizeram. */
    /* Com o Realtime de pé, o ciclo vira rede de segurança e não via
       principal: espaça para 30 min. Sem ele, mantém os 10. A checagem é a
       cada volta do relógio, não uma vez só — o socket cai e volta. */
    try {
      setInterval(() => {
        try {
          const vivo = (typeof realtime !== 'undefined') && realtime.ativo();
          if (vivo && (Date.now() - (cloud._ultimoPull || 0)) < 30 * 60 * 1000) return;
          cloud.autoSyncAoVoltar({ forcar: true });
        } catch (e) {}
      }, 10 * 60 * 1000);
    } catch (e) {}
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') cloud.autoSyncAoVoltar();
    });
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', () => cloud.autoSyncAoVoltar());
      /* A internet voltou: a fila drena NA HORA, não no próximo ciclo. É o
         caso que você mais tem — sinal caindo no centro cirúrgico. */
      window.addEventListener('online', () => {
        cloud.autoSyncAoVoltar({ forcar: true });
        try { cloudRel.drenarFila(); } catch (e) {}
        try { cloudRel.drenarFilaDel(); } catch (e) {}
        try { pdfBackup.drenarFila(); } catch (e) {}
      });
    }
  },
  uiEnviarTudo() {
    if (confirm('Reenviar todos os registros carregados nesta sessão para a nuvem?\n\nAs versões remotas mais novas continuam protegidas pelo controle de concorrência.')) {
      cloud.sincronizar({ enviarTudo: true });
    }
  },
  /* ---- Teste de conexão passo a passo (diagnóstico) ---- */
  async testarConexao() {
    const box = document.getElementById('cloud-teste-resultado');
    const btn = document.getElementById('cloud-teste-btn');
    const linhas = [];
    const render = () => { if (box) box.innerHTML = linhas.map(l => '<div class="diag-linha diag-' + l.s + '">' + l.icone + ' ' + l.txt + '</div>').join(''); };
    const add = (s, txt) => { const icone = s === 'ok' ? '✅' : s === 'erro' ? '❌' : s === 'aviso' ? '⚠️' : '⏳'; linhas.push({ s, txt, icone }); render(); };

    if (box) box.style.display = 'block';
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Testando…'; }
    linhas.length = 0; render();

    try {
      /* 1) Está configurado? */
      if (!cloud.estaConfigurado()) {
        add('erro', 'Nuvem não configurada (falta URL e chave). Abra "Configuração do servidor".');
        return;
      }
      const c = cloud.config();
      add('ok', 'Configuração encontrada: ' + c.url);

      /* 2) Está online? */
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        add('erro', 'O aparelho está OFFLINE. Conecte-se à internet e teste de novo.');
        return;
      }

      /* 3) O servidor Supabase responde e a chave é aceita?
         Obs.: NÃO usar a raiz /rest/v1/ — no modelo novo de chaves ela exige
         chave secreta ("Secret API key required") e daria falso negativo. */
      add('pend', 'Falando com o servidor Supabase…');
      let chaveOk = false;
      try {
        const r = await fetch(c.url + '/rest/v1/organizations?select=id&limit=1', { headers: cloud._headers(false) });
        linhas.pop(); render();
        if (r.status === 401) {
          let msg = '';
          try { const d = await r.json(); msg = d.message || d.hint || ''; } catch (e) {}
          add('erro', 'Servidor respondeu, mas a CHAVE foi RECUSADA (401). ' + (msg ? '(' + msg + ')' : 'Confira a chave publishable/anon.'));
        } else if (r.ok || r.status === 404 || r.status === 400 || r.status === 403 || r.status === 406) {
          chaveOk = true;
          add('ok', 'Servidor respondeu e a chave pública foi aceita.');
        } else if (r.status >= 500 || r.status === 540 || r.status === 429) {
          /* 503/540 é o que o Supabase devolve quando o projeto está PAUSADO ou
             com o uso acima do limite do plano. Antes isto caía em "inesperado,
             mas está no ar" e o diagnóstico seguia como se a nuvem estivesse
             boa — a tela dizia "tudo certo" durante uma queda. */
          let corpo = '';
          try { corpo = (await r.text() || '').slice(0, 200); } catch (e) {}
          add('erro', 'O servidor respondeu <b>HTTP ' + r.status + '</b> — ou seja, ele existe mas NÃO está atendendo. ' +
            'No Supabase isso é projeto <b>pausado</b> ou <b>uso acima do limite do plano</b> (egress/armazenamento). ' +
            'Abra o painel do Supabase: se houver aviso de limite excedido ou projeto pausado, é essa a causa — e ela se resolve lá, não aqui.' +
            (corpo ? '<br><span style="opacity:.8">Resposta: ' + utils.escapeHTML(corpo) + '</span>' : ''));
          add('ok', 'Enquanto isso, NADA se perde: cada alteração entra na fila cifrada do aparelho e sobe sozinha quando o servidor voltar. ' +
            '<b>Ninguém deve sair da nuvem</b> — sair apaga a sessão do aparelho, e não há como entrar de novo até o servidor voltar.');
          return;
        } else {
          add('aviso', 'Servidor respondeu com status ' + r.status + ' (inesperado, mas está no ar).');
          chaveOk = true;
        }
      } catch (e) {
        linhas.pop(); render();
        add('erro', 'NÃO consegui falar com o servidor. URL errada, projeto pausado ou sem internet. (' + e.message + ')');
        return;
      }
      if (!chaveOk) return;

      /* 4) Está logado? */
      if (!cloud.estaLogado()) {
        add('aviso', 'Você ainda NÃO fez login. A conexão com o servidor funciona, mas os dados só sobem depois que você entrar com email e senha (abaixo).');
        return;
      }
      add('ok', 'Sessão ativa: ' + (cloud.emailLogado() || 'usuário logado'));

      /* 5) O token é válido / renova? */
      add('pend', 'Verificando validade da sessão…');
      const tokOk = await cloud._garantirToken();
      linhas.pop(); render();
      if (!tokOk) {
        add('erro', cloud.servidorFora()
          ? 'O servidor da clínica NÃO está respondendo. A sua sessão continua válida — NÃO desconecte (isso apagaria a sessão, e não haveria como entrar de novo até o servidor voltar). Continue atendendo: cada alteração entra na fila cifrada e sobe sozinha.'
          : 'Sua sessão EXPIROU e não foi possível renovar. Faça login novamente (Desconectar → Conectar).');
        return;
      }
      add('ok', 'Sessão válida.');

      /* 6) O banco organizacional responde para esta sessão? */
      add('pend', 'Testando acesso ao ambiente da clínica…');
      try {
        const r2 = await fetch(c.url + '/rest/v1/organizations?select=id,nome&limit=1', { headers: cloud._headers(true) });
        linhas.pop(); render();
        if (r2.ok) {
          const cabecalho = r2.headers.get('content-range') || '';
          add('ok', 'Banco organizacional acessível para esta sessão. ' + (cabecalho ? '(ambientes visíveis: ' + cabecalho + ')' : ''));
          add('ok', 'TUDO CERTO ✔ A sincronização com o Supabase está funcionando.');
        } else if (r2.status === 404) {
          add('erro', 'A estrutura organizacional não existe no Supabase. Aplique as migrações do banco na ordem indicada.');
        } else if (r2.status === 401 || r2.status === 403) {
          add('erro', 'A sessão não tem acesso a um ambiente de clínica (RLS/vínculo). Verifique a equipe da nuvem.');
        } else {
          add('aviso', 'A tabela respondeu com status ' + r2.status + '. Pode ser configuração de permissão.');
        }
      } catch (e) {
        linhas.pop(); render();
        add('erro', 'Erro ao acessar a tabela: ' + e.message);
      }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '🔌 Testar conexão com a nuvem'; }
    }
  },

  /* ---- Diagnóstico de publicação/hospedagem (o "lado GitHub/Netlify") ---- */
  testarPublicacao() {
    const box = document.getElementById('pub-teste-resultado');
    if (!box) return;
    const linhas = [];
    const add = (s, txt) => { const icone = s === 'ok' ? '✅' : s === 'erro' ? '❌' : s === 'aviso' ? '⚠️' : 'ℹ️'; linhas.push('<div class="diag-linha diag-' + s + '">' + icone + ' ' + txt + '</div>'); };

    const proto = (typeof location !== 'undefined' && location.protocol) || '';
    const host = (typeof location !== 'undefined' && location.hostname) || '';
    const online = !(typeof navigator !== 'undefined' && navigator.onLine === false);

    /* Está online? */
    if (online) add('ok', 'Aparelho ONLINE.');
    else add('aviso', 'Aparelho OFFLINE agora (normal se estiver sem internet — o sistema funciona assim mesmo).');

    /* De onde o app está rodando? */
    if (proto === 'file:') {
      add('aviso', 'Você abriu o ARQUIVO baixado no aparelho (file://), não a versão publicada na web. Funciona normalmente offline, mas não recebe atualizações automáticas do site.');
    } else if (host.indexOf('netlify') >= 0) {
      add('ok', 'Rodando da versão PUBLICADA na Netlify: ' + host);
      add('ok', 'O caminho GitHub → Netlify → seu navegador está funcionando (o site carregou).');
    } else if (host === 'localhost' || host === '127.0.0.1') {
      add('info', 'Rodando localmente (localhost) — ambiente de teste.');
    } else if (host) {
      add('ok', 'Rodando de um servidor web publicado: ' + host);
      add('info', 'Se este endereço vem do seu deploy (Netlify a partir do GitHub), a publicação está no ar.');
    } else {
      add('info', 'Não foi possível identificar a origem.');
    }

    add('info', 'Obs.: o app não conversa diretamente com o GitHub. O GitHub apenas guarda o arquivo que a Netlify publica. Se o site abre, esse caminho está OK.');

    box.style.display = 'block';
    box.innerHTML = linhas.join('');
  },

  init() {
    /* Aplica config padrão (URL + chave embutidas) se ainda não houver */
    if (!cloud.estaConfigurado() && cloud.DEFAULT_URL && cloud.DEFAULT_KEY) {
      try { localStorage.setItem(cloud.CFG_KEY, JSON.stringify({ url: cloud.DEFAULT_URL, anonKey: cloud.DEFAULT_KEY })); } catch (e) {}
    }
    /* Migração automática: se o aparelho ainda tem uma chave legada (eyJ...)
       salvada e o padrão agora é publishable (sb_...), atualiza sozinho e
       limpa a sessão antiga (o token velho também seria recusado). */
    try {
      const c = cloud.config();
      if (c && c.anonKey && /^eyJ/.test(c.anonKey) && cloud._ehPublishable(cloud.DEFAULT_KEY)) {
        localStorage.setItem(cloud.CFG_KEY, JSON.stringify({ url: c.url || cloud.DEFAULT_URL, anonKey: cloud.DEFAULT_KEY }));
        localStorage.removeItem(cloud.SESSION_KEY);
        try { const loja = cloud._lojaSessao(); if (loja) loja.removeItem(cloud.SESSION_KEY); } catch (e) {}
        try { contextoAba.limpar(); } catch (e) {}
      }
    } catch (e) {}
    cloud._atualizarUI();
    /* Ao abrir com sessão já ativa, ATUALIZA de verdade: além de drenar a
       fila de envio, baixa pacientes, módulos e configurações. Antes só
       enviava — quem abria o app no celular ficava com a lista velha. */
    if (cloud.estaConfigurado() && cloud.estaLogado()) {
      setTimeout(() => { try { cloud.autoSyncAoVoltar({ forcar: true }); } catch (e) { cloud.sincronizar({ silent: true }); } }, 1500);
    }
    try { cloud.vigiarRetorno(); } catch (e) {}
    /* Reenvia fila quando a conexão voltar; atualiza o selo ao cair/voltar */
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        try { syncStatus.refresh(); } catch (e) {}
        if (cloud.estaLogado()) cloud.sincronizar({ silent: true });
      });
      window.addEventListener('offline', () => { try { syncStatus.refresh(); } catch (e) {} });
    }
    /* Dreno periódico: se houver fila e estivermos online/logados, tenta enviar */
    try {
      setInterval(() => {
        if (cloud._syncing) return;
        if (!cloud.estaConfigurado() || !cloud.estaLogado()) return;
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
        if (cloud._fila().length) cloud.sincronizar({ silent: true });
      }, 20000);
    } catch (e) {}
    try { syncStatus.refresh(); } catch (e) {}
  }
};

/* FIM DO ADAPTADOR SUPABASE */
