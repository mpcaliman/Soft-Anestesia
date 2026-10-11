window.assinaturaDigital = (function () {
  const BASE_VALIDACAO = (location.origin && location.origin !== 'null'
    ? location.origin + location.pathname : '') ;

  /* ---- utilidades cripto ---- */
  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = crypto.getRandomValues(new Uint8Array(1))[0] % 16;
      const v = c === 'x' ? r : (r & 0x3 | 0x8); return v.toString(16);
    });
  }
  function codigoValidacao() {
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   /* sem 0/O/1/I */
    const buf = crypto.getRandomValues(new Uint8Array(12));
    let s = ''; for (let i = 0; i < 12; i++) { s += abc[buf[i] % abc.length]; if (i % 4 === 3 && i < 11) s += '-'; }
    return s;
  }
  const hex = buf => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  async function sha256Buf(buf) { return hex(await crypto.subtle.digest('SHA-256', buf)); }
  async function sha256Txt(txt) { return sha256Buf(new TextEncoder().encode(txt)); }
  function canon(obj) { /* JSON canônico (chaves ordenadas) p/ hash estável */
    return JSON.stringify(obj, Object.keys(obj).sort());
  }

  /* =========================================================================
     ISignatureProvider — contrato que TODO fornecedor deve implementar.
     { id, label, tipo:'externo'|'nuvem', disponivel(), instrucoesHTML(),
       listarCertificados()→Promise, infoCertificado()→Promise,
       assinar(ctx)→Promise, validarAssinatura(reg)→Promise, status() }
     Trocar/adicionar fornecedor = registrar outro objeto aqui, sem tocar no resto.
  ========================================================================= */
  const PROVIDERS = {
    /* O PDF pode ser assinado fora do app. A anexação e o hash aqui não
       validam o certificado ou a assinatura criptográfica desse arquivo. */
    govbr: {
      id: 'govbr', label: 'gov.br / SafeID / Assinador externo', tipo: 'externo',
      disponivel() { return true; },
      instrucoesHTML() {
        return '<ol style="margin:0;padding-left:18px;line-height:1.6;font-size:.9rem">'
          + '<li><b>Gere o PDF definitivo</b> do documento (botão abaixo).</li>'
          + '<li><b>Assine com seu certificado ICP-Brasil</b> no <a href="https://assinador.iti.br" target="_blank" rel="noopener">Assinador gov.br</a>, no app <b>SafeID</b> ou no software do seu provedor (A1/A3/token/nuvem).</li>'
          + '<li><b>Valide a assinatura</b> em <a href="https://validar.iti.gov.br" target="_blank" rel="noopener">validar.iti.gov.br</a> e reanexe o PDF. Aqui, a anexação registra o hash e os metadados; não verifica a assinatura nem confirma envio à nuvem.</li>'
          + '</ol>';
      },
      listarCertificados() { return Promise.resolve([]); },  /* seleção ocorre fora */
      infoCertificado() { return Promise.resolve(null); },
      async assinar() { return { modo: 'externo' }; },        /* fluxo guiado pela UI */
      status() { return 'externo'; }
    },
    /* Driver de assinatura em nuvem: indisponível até homologação real da
       API do provedor. A configuração de segredos, sozinha, não o habilita. */
    safeid_cloud: {
      id: 'safeid_cloud', label: 'SafeID / Safeweb — em nuvem (1 clique)', tipo: 'nuvem',
      _health: null,   /* null=desconhecido, true=configurado, false=indisponível */
      _base() {
        try {
          const cfg = JSON.parse(localStorage.getItem('medsys.v7.cloud.cfg') || 'null');
          const url = (cfg && cfg.url) || cloud.DEFAULT_URL || '';
          return url ? url.replace(/\/$/, '') + '/functions/v1/assinatura' : '';
        } catch (e) { return ''; }
      },
      _anonKey() {
        try {
          const key = (JSON.parse(localStorage.getItem('medsys.v7.cloud.cfg') || 'null') || {}).anonKey || cloud.DEFAULT_KEY || '';
          if (key.indexOf('sb_publishable_') === 0) return key;
          const claims = JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
          return claims.role === 'anon' ? key : '';
        } catch (e) { return ''; }
      },
      async verificar() {
        const base = this._base();
        if (!base) { this._health = false; return false; }
        try {
          const r = await fetch(base + '?op=health', { headers: this._anonKey() ? { apikey: this._anonKey() } : {} });
          const j = await r.json();
          this._health = !!(j && j.configurado);
          return this._health;
        } catch (e) { this._health = false; return false; }
      },
      disponivel() { return this._health === true; },
      _orgAtual() {
        try {
          const ctx = contextoAba.atual();
          return (ctx && ctx.organizationId) || '';
        } catch (e) { return ''; }
      },
      async _headersProtegidos() {
        if (!(await cloud._garantirToken())) throw new Error(cloud.motivoSemToken());
        const s = cloud.session();
        if (!s || !s.access_token) throw new Error('Entre na nuvem antes de usar a assinatura.');
        return {
          'content-type': 'application/json',
          apikey: this._anonKey(),
          authorization: 'Bearer ' + s.access_token
        };
      },
      instrucoesHTML() {
        const est = this._health === true ? '<b style="color:#14755a">✔ driver homologado</b>'
          : this._health === false ? '<b style="color:#b3392a">backend não configurado</b> (ver supabase/README.md)'
          : 'verificando backend…';
        return '<p style="font-size:.88rem;color:var(--text-soft)">Assinatura em nuvem de 1 clique (padrão Portal CFM/Certillion), via <b>Edge Function</b> do Supabase que guarda o segredo do provedor. Status: ' + est
          + '.</p><p style="font-size:.8rem;color:var(--text-mute)">Enquanto o provedor não estiver plugado, use o fluxo <b>gov.br / SafeID-app</b>.</p>';
      },
      _naoConfig() { const e = new Error('Assinatura em nuvem não configurada. Publique a Edge Function e defina os secrets (supabase/README.md).'); e.code = 'NAO_CONFIGURADO'; return e; },
      async listarCertificados() {
        if (!this.disponivel()) throw this._naoConfig();
        const headers = await this._headersProtegidos();
        const r = await fetch(this._base() + '?op=cert-list', {
          method: 'POST', headers,
          body: JSON.stringify({ organization_id: this._orgAtual() })
        });
        if (!r.ok) {
          const erro = await r.json().catch(() => ({}));
          throw new Error(erro.erro || ('HTTP ' + r.status));
        }
        return await r.json();
      },
      async assinar() {
        if (!this.disponivel()) throw this._naoConfig();
        /* Este driver ainda depende da homologação da API do provedor.
           A configuração de segredos não é prova de funcionamento. */
        const e = new Error('Backend pronto. Falta plugar a documentação da API do provedor para liberar o 1-clique (ver supabase/README.md).');
        e.code = 'AGUARDANDO_API'; throw e;
      },
      status() { return this.disponivel() ? 'nuvem' : 'nao_configurado'; }
    }
  };

  /* Mapeia módulo → formulário e campos (paciente/profissional/CRM) */
  const MODULOS = {
    pre:         { form: 'form-pre',         titulo: 'Avaliação Pré-anestésica',   pac: ['nome'],            prof: ['anestesiologista', 'profissional'], crm: ['crm'] },
    consulta:    { form: 'form-consulta',    titulo: 'Consulta / Avaliação de Dor', pac: ['nome'],           prof: ['profissional', 'anestesiologista'], crm: ['crm'] },
    anestesia:   { form: 'form-anestesia',   titulo: 'Ficha de Anestesia',         pac: ['paciente_nome'],  prof: ['anestesiologista'],                 crm: ['crm'] },
    recuperacao: { form: 'form-recuperacao', titulo: 'Recuperação Pós-anestésica', pac: ['nome', 'paciente'], prof: ['responsavel', 'anestesiologista'], crm: ['registro', 'crm'] },
    termo:       { form: 'form-termo',       titulo: 'Termo de Consentimento',     pac: ['paciente', 'nome'], prof: ['profissional'],                    crm: ['crm'] },
    prescricao:  { form: 'form-prescricao',  titulo: 'Receituário',                  pac: ['paciente', 'nome'], prof: ['profissional'],                    crm: ['crm'] },
    risco:       { form: 'form-risco',       titulo: 'Avaliação de Risco',         pac: ['nome'],           prof: ['profissional'],                     crm: ['crm'] },
    financeiro:  { form: 'form-financeiro',  titulo: 'Documento Financeiro',       pac: ['paciente'],       prof: ['profissional'],                     crm: ['crm'] },
    /* Atestado, declaração e laudo estavam de fora, e são justamente o tipo de
       documento que se assina — um laudo para o INSS mais que os outros. O
       botão existia na barra e só sabia dizer "abra um documento assinável". */
    documentos:  { form: 'form-documentos',  titulo: 'Documento Médico',           pac: ['nome', 'paciente'], prof: ['profissional'],                   crm: ['crm'] }
  };

  function ctxAtual() {
    const mod = (typeof state !== 'undefined' && state.currentModule) || '';
    const cfg = MODULOS[mod];
    if (!cfg) return null;
    const f = document.getElementById(cfg.form);
    if (!f) return null;
    const pick = names => { for (const n of names) { const el = f.querySelector('[name="' + n + '"]'); if (el && el.value) return el.value; } return ''; };
    return {
      modulo: mod, form: cfg.form, titulo: cfg.titulo,
      docId: (f.querySelector('[name="_id"]') || {}).value || '',
      paciente: pick(cfg.pac), profissional: pick(cfg.prof), crm: pick(cfg.crm)
    };
  }

  const PARENT_FIELDS = ['_id', '_patientKey', '_patientRef', '_caseId', '_caseKey',
    'nome', 'paciente', 'paciente_nome', 'profissional', 'anestesiologista', 'responsavel', 'crm'];
  function parentIdentity(form) {
    return JSON.stringify(PARENT_FIELDS.map(name => {
      const field = form.querySelector('[name="' + name + '"]');
      return [name, field ? String(field.value || '') : null];
    }));
  }
  function captureTarget(ctx) {
    const formNode = document.getElementById(ctx.form);
    if (!formNode) throw new Error('Contexto do documento perdido — reabra e tente de novo.');
    return Object.assign({}, ctx, { owner: contextoAba.capturar(), formNode, parentIdentity: parentIdentity(formNode) });
  }
  function requireTarget(target) {
    if (!contextoAba.corresponde(target.owner)) throw new Error('O usuário ou a clínica mudou. Reabra o documento antes de anexar.');
    const current = ctxAtual();
    if (!current || current.modulo !== target.modulo || current.form !== target.form
        || current.docId !== target.docId || document.getElementById(target.form) !== target.formNode
        || parentIdentity(target.formNode) !== target.parentIdentity) {
      throw new Error('O documento mudou. Reabra o documento antes de anexar.');
    }
    return target.formNode;
  }

  /* ---- armazenamento imutável (append-only, encadeado por hash) ---- */
  function listaAssin() { try { return store.list('assinaturas') || []; } catch (e) { return []; } }
  function salvarLista(arr) { return store.setList('assinaturas', arr); }

  let _metadataAppend = Promise.resolve();
  function registrarImutavel(reg, target) {
    // Serialize the real cloned-list read/hash/write cycle. Two simultaneous
    // attachments must retain both entries and a single valid hash chain.
    const operation = _metadataAppend.then(async () => {
      requireTarget(target);
      const arr = listaAssin();
      const anterior = arr.length ? arr[arr.length - 1] : null;
      reg.prevHash = anterior ? anterior.selfHash : null;
      // Session metadata is neither a server receipt nor a verified signature.
      reg.centralReceiptConfirmed = false;
      reg.signatureVerified = false;
      reg.registroEscopo = 'memoria_da_sessao';
      reg.versao = arr.filter(r => r.docId && r.docId === reg.docId && r.modulo === reg.modulo).length + 1;
      reg.selfHash = await sha256Txt(canon(Object.assign({}, reg, { selfHash: undefined })));
      requireTarget(target);
      arr.push(reg);
      if (salvarLista(arr) !== true) throw new Error('Não foi possível registrar os metadados nesta sessão.');
      return reg;
    });
    _metadataAppend = operation.catch(() => {});
    return operation;
  }

  /* ---- fluxo de assinatura (guiado / externo) ---- */
  let _ctxPendente = null;

  function iniciar() {
    const ctx = ctxAtual();
    if (!ctx) { toast('Abra um documento assinável (Pré, Ficha, Consulta, Termo, Prescrição...)', 'warn'); return; }
    if (!ctx.paciente) { toast('Preencha ao menos o nome do paciente antes de assinar', 'warn'); return; }
    const target = captureTarget(ctx);
    const prov = PROVIDERS.govbr;
    const body = ''
      + '<div style="font-size:.9rem;color:var(--text-soft);margin-bottom:10px">Documento: <b>' + AD.esc(ctx.titulo) + '</b> — ' + AD.esc(ctx.paciente) + '</div>'
      + '<label style="font-size:.82rem;font-weight:600">Provedor / método de assinatura</label>'
      + '<select id="ad-prov" onchange="assinaturaDigital._trocarProvedor(this.value)" style="width:100%;margin:4px 0 12px;padding:8px;border:1px solid var(--border);border-radius:8px">'
      + Object.values(PROVIDERS).map(p => '<option value="' + p.id + '"' + (p.id === 'govbr' ? ' selected' : '') + '>' + AD.esc(p.label) + '</option>').join('')
      + '</select>'
      + '<div id="ad-instr">' + prov.instrucoesHTML() + '</div>'
      + '<div id="ad-passos" style="margin-top:14px;display:flex;flex-wrap:wrap;gap:8px">'
      + '<button type="button" class="btn btn-sm btn-primary" onclick="assinaturaDigital.gerarPDF()">📄 Gerar PDF definitivo</button>'
      + '<label class="btn btn-sm" style="cursor:pointer;background:#1f9171;color:#fff;border-color:#14755a">📎 Anexar PDF assinado'
      + '<input id="ad-pdf-input" type="file" accept="application/pdf" style="display:none" onchange="assinaturaDigital.registrar(this)"></label>'
      + '</div>'
      + '<p style="font-size:.72rem;color:var(--text-mute);margin-top:12px">O PDF é assinado e validado no provedor externo. Esta anexação registra somente hash e metadados nesta sessão; salve o registro e confirme o arquivo em Anexos para guardá-lo na nuvem.</p>';
    const footer = '<button class="btn" onclick="assinaturaDigital.abrirValidacao()">🔎 Validar um documento</button>'
      + '<button class="btn btn-primary" onclick="modal.close()">Fechar</button>';
    modal.open('🔏 Assinar fora do app e anexar o PDF', body, footer);
    _ctxPendente = target;
    const fileInput = document.getElementById('ad-pdf-input');
    if (fileInput) fileInput._softSignatureTarget = target;
  }

  function _trocarProvedor(id) {
    const p = PROVIDERS[id]; if (!p) return;
    const instr = document.getElementById('ad-instr'); if (instr) instr.innerHTML = p.instrucoesHTML();
    const passos = document.getElementById('ad-passos');
    if (passos) passos.style.display = (p.tipo === 'externo') ? 'flex' : 'none';
    if (p.tipo === 'nuvem' && p.verificar) {
      p.verificar().then(() => {
        const i2 = document.getElementById('ad-instr'); if (i2 && (document.getElementById('ad-prov') || {}).value === id) i2.innerHTML = p.instrucoesHTML();
        const ps = document.getElementById('ad-passos'); if (ps && (document.getElementById('ad-prov') || {}).value === id) ps.style.display = p.disponivel() ? 'flex' : 'none';
      });
    }
  }

  function gerarPDF() {
    try { printPreview.abrir(); toast('Use 🖨️ Imprimir / PDF e "Salvar em PDF". Depois assine e reanexe.', 'success'); }
    catch (e) { toast('Abra o documento e use Imprimir / PDF', 'warn'); }
  }

  async function registrar(input) {
    const file = input && input.files && input.files[0];
    if (input) input.value = '';
    if (!file) return;
    if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) { toast('Anexe o PDF assinado (.pdf)', 'warn'); return; }
    const ctx = input && input._softSignatureTarget || _ctxPendente;
    if (!ctx) { toast('Contexto do documento perdido — reabra e tente de novo', 'error'); return; }
    try {
      if (_ctxPendente !== ctx) throw new Error('Contexto do documento perdido — reabra e tente de novo.');
      if (input.isConnected === false) throw new Error('Contexto do documento perdido — reabra e tente de novo.');
      requireTarget(ctx);
      const buf = await file.arrayBuffer();
      requireTarget(ctx);
      const hashDoc = await sha256Buf(buf);
      requireTarget(ctx);
      const id = uuid(), codigo = codigoValidacao(), ts = new Date().toISOString();
      const provId = (document.getElementById('ad-prov') || {}).value || 'govbr';
      const reg = {
        _id: id, codigo: codigo, modulo: ctx.modulo, docId: ctx.docId || '',
        titulo: ctx.titulo, paciente: ctx.paciente, profissional: ctx.profissional, crm: ctx.crm,
        hashDoc: hashDoc, algoritmo: 'SHA-256', provider: provId,
        provedorLabel: (PROVIDERS[provId] || PROVIDERS.govbr).label,
        arquivo: file.name, status: 'pdf_anexado_nao_verificado', ts: ts
      };
      await registrarImutavel(reg, ctx);
      const f = requireTarget(ctx);

      /* Reusa o selo/campos existentes: grava meta no formulário do documento */
      const meta = { tipo: 'pdf_anexado', hash: hashDoc, ts: ts, arquivo: file.name, assinante: ctx.profissional,
        uuid: id, codigo: codigo, algoritmo: 'SHA-256', provider: provId,
        signatureVerified: false, centralReceiptConfirmed: false };
      const setV = (n, v) => { const el = f && f.querySelector('[name="' + n + '"]'); if (el) el.value = v; };
      setV('assinatura_tipo', 'pdf_anexado'); setV('assinatura_meta', JSON.stringify(meta));
      // An attached PDF is not a verified signature or a finalization receipt.
      // Existing finalized records remain protected by their clinical guards.
      try { if (typeof markDirty === 'function') markDirty(); } catch (e) {}

      modal.close();
      AD.mostrarComprovante(reg);
    } catch (e) {
      if (_ctxPendente === ctx) _ctxPendente = null;
      toast('Erro ao registrar assinatura: ' + e.message, 'error');
    }
  }

  function urlValidacao(codigo) {
    return (BASE_VALIDACAO || '') + '#validar=' + encodeURIComponent(codigo);
  }

  function mostrarComprovante(reg) {
    const body = ''
      + '<div style="text-align:center;margin-bottom:10px"><div style="font-size:2rem">📎</div>'
      + '<div style="font-weight:700;color:#8a5a15">PDF anexado — assinatura não verificada</div></div>'
      + AD.seloHTML(reg, true)
      + '<p style="font-size:.78rem;color:var(--text-soft);margin-top:10px">A nuvem ainda não confirmou este comprovante. Mantenha o PDF original e confira sua assinatura criptográfica no validador oficial '
      + '<a href="https://validar.iti.gov.br" target="_blank" rel="noopener">validar.iti.gov.br</a>.</p>'
      + '<p style="font-size:.72rem;color:var(--text-mute);margin-top:6px"><b>Salve o registro</b> e aguarde a confirmação da nuvem. Confirme o envio em Anexos para guardar também o arquivo PDF.</p>';
    modal.open('📎 Metadados do PDF anexado', body, '<button class="btn btn-primary" onclick="modal.close()">Concluir</button>');
  }

  /* Informative attachment label; no client metadata proves ICP validity. */
  function seloHTML(reg, tela) {
    const url = urlValidacao(reg.codigo);
    const dt = String(reg.ts || '').replace('T', ' ').slice(0, 16);
    const box = tela
      ? 'border:1px solid #b9e0c6;background:#eef8f1;border-radius:8px;padding:10px 12px'
      : 'border:1px solid #b9e0c6;background:#f2faf5;border-radius:6px;padding:8px 10px';
    let qr = '';
    try { qr = reg.centralReceiptConfirmed === true && window.SoftQR ? window.SoftQR.svg(url, { px: tela ? 104 : 92, ecl: 'M' }) : ''; } catch (e) { qr = ''; }
    const qrCol = qr
      ? '<div style="flex:0 0 auto;text-align:center">'
        + '<div style="background:#fff;border:1px solid #cfe8d8;border-radius:6px;padding:4px;display:inline-block">' + qr + '</div>'
        + '<div style="font-size:.62rem;color:#3b7a5a;margin-top:2px">Aponte a câmera</div></div>'
      : '';
    const info = '<div style="flex:1 1 auto;min-width:0">'
      + '<div style="font-weight:700">PDF anexado — assinatura não verificada</div>'
      + (reg.profissional ? '<div>' + AD.esc(reg.profissional) + (reg.crm ? ' · CRM ' + AD.esc(reg.crm) : '') + '</div>' : '')
      + '<div>Data/hora: ' + AD.esc(dt) + ' · Método: ' + AD.esc(reg.provedorLabel || '') + '</div>'
      + '<div>Algoritmo: ' + AD.esc(reg.algoritmo || 'SHA-256') + ' · Versão: ' + AD.esc(String(reg.versao || 1)) + '</div>'
      + '<div style="font-family:monospace;font-size:.7rem;word-break:break-all">SHA-256: ' + AD.esc((reg.hashDoc || '').slice(0, 48)) + '…</div>'
      + '<div style="margin-top:4px"><b>' + (reg.centralReceiptConfirmed === true ? 'Código do comprovante' : 'Referência desta sessão') + ':</b> <span style="font-family:monospace;font-weight:700">' + AD.esc(reg.codigo) + '</span></div>'
      + (reg.centralReceiptConfirmed === true ? '<div style="word-break:break-all">Consultar registro: <a href="' + AD.esc(url) + '" target="_blank" rel="noopener">' + AD.esc(url) + '</a></div>' : '<div>Comprovante central ainda não confirmado.</div>')
      + '</div>';
    return '<div style="' + box + ';font-size:.78rem;line-height:1.5;color:#14532d;text-align:left;display:flex;gap:12px;align-items:flex-start">'
      + qrCol + info + '</div>';
  }

  /* ---- validação pública (integridade + metadados; cadeia ICP no validador oficial) ---- */
  let _validacaoPedido = 0;
  function validar(query) {
    const q = String(query || '').trim().toUpperCase().replace(/\s/g, '');
    if (!q) return null;
    const arr = listaAssin();
    const reg = arr.find(r =>
      (r.codigo || '').toUpperCase().replace(/\s/g, '') === q ||
      (r._id || '').toUpperCase() === q ||
      (r.hashDoc || '').toUpperCase() === q);
    return reg || null;
  }

  async function _integridadeCorrente(reg) {
    /* Recalcula o selfHash e verifica se o registro não foi adulterado */
    try {
      const rec = Object.assign({}, reg); const guardado = rec.selfHash; rec.selfHash = undefined;
      const recalc = await sha256Txt(canon(rec));
      return recalc === guardado;
    } catch (e) { return false; }
  }

  async function abrirValidacao(codigoInicial) {
    let host = document.getElementById('ad-validar-overlay');
    if (!host) {
      host = document.createElement('div');
      host.id = 'ad-validar-overlay';
      host.className = 'ad-validar-overlay';
      document.body.appendChild(host);
    }
    host.innerHTML = ''
      + '<div class="ad-validar-card">'
      + '<button type="button" class="ad-validar-x" onclick="assinaturaDigital.fecharValidacao()">✕</button>'
      + '<h2 style="margin:0 0 4px">🔎 Validação de documento — Soft Anestesia</h2>'
      + '<p style="font-size:.82rem;color:var(--text-soft);margin:0 0 12px">Informe o <b>código de validação</b> ou o hash SHA-256 do documento. O UUID consulta somente o registro desta sessão.</p>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap">'
      + '<input id="ad-validar-inp" placeholder="Ex.: ABCD-2345-EFGH" style="flex:1;min-width:200px;padding:9px;border:1px solid var(--border);border-radius:8px;font-family:monospace">'
      + '<button class="btn btn-primary" onclick="assinaturaDigital._fazerValidacao()">Validar</button>'
      + '</div>'
      + '<div id="ad-validar-res" style="margin-top:14px"></div>'
      + '<p style="font-size:.72rem;color:var(--text-mute);margin-top:14px">A validade da cadeia ICP-Brasil (certificado, revogação, carimbo de tempo) é confirmada no validador oficial do governo: <a href="https://validar.iti.gov.br" target="_blank" rel="noopener">validar.iti.gov.br</a>.</p>'
      + '</div>';
    host.classList.add('show');
    if (codigoInicial) { const i = document.getElementById('ad-validar-inp'); if (i) { i.value = codigoInicial; _fazerValidacao(); } }
  }
  function fecharValidacao() { _validacaoPedido++; const h = document.getElementById('ad-validar-overlay'); if (h) h.classList.remove('show'); if (location.hash.indexOf('validar') >= 0) { try { history.replaceState(null, '', location.pathname); } catch (e) {} } }

  /* Consulta pública mínima, separada do driver de assinatura. O comprovante
     vai no corpo; nenhuma sessão de usuário ou chave pública vira Bearer. */
  async function _validarCentral(q) {
    const base = PROVIDERS.safeid_cloud._base();
    const key = PROVIDERS.safeid_cloud._anonKey();
    if (!base || !key || key.indexOf('sb_secret_') === 0) throw new Error('A consulta central está indisponível.');
    const proof = /^[0-9a-f]{64}$/i.test(q) ? { hash: q.toLowerCase() } : { codigo: q.toUpperCase() };
    const r = await fetch(base.replace(/\/assinatura$/, '/assinatura-validacao'), {
      method: 'POST', headers: { apikey: key, 'content-type': 'application/json' },
      body: JSON.stringify(proof), cache: 'no-store', credentials: 'omit',
      redirect: 'error', signal: AbortSignal.timeout(8000)
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j && j.erro || 'Não foi possível consultar o comprovante agora.');
    if (j && j.encontrado && j.registro && j.escopo === 'registro_e_hash') {
      const g = j.registro;
      if (j.validacao_criptografica !== 'nao_verificada_por_esta_consulta'
          || !/^[0-9a-f]{64}$/.test(g.hash_doc) || g.algoritmo !== 'SHA-256'
          || !Number.isInteger(g.versao) || g.versao < 1
          || typeof g.assinado_em !== 'string' || !Number.isFinite(Date.parse(g.assinado_em))
          || (proof.codigo ? g.codigo !== proof.codigo : g.hash_doc !== proof.hash)) {
        throw new Error('A consulta central não confirmou este comprovante.');
      }
      return { central: true, titulo: 'Documento registrado', ts: g.assinado_em,
        algoritmo: g.algoritmo, versao: g.versao, codigo: g.codigo || 'Consulta pelo hash',
        _id: '(consulta central)', hashDoc: g.hash_doc };
    }
    if (!j || j.encontrado !== false) throw new Error('A consulta central não confirmou o resultado.');
    return null;
  }

  async function _fazerValidacao() {
    const pedido = ++_validacaoPedido;
    const inp = document.getElementById('ad-validar-inp');
    const res = document.getElementById('ad-validar-res');
    if (!res) return;
    const q = (inp ? inp.value : '').trim();
    res.innerHTML = '<div class="ad-res">⏳ Verificando…</div>';
    let reg = validar(q);
    let central = false;
    if (!reg) {
      try {
        const c = await _validarCentral(q);
        if (pedido !== _validacaoPedido) return;
        if (c) { reg = c; central = true; }
      }
      catch (e) {
        if (pedido !== _validacaoPedido) return;
        res.innerHTML = '<div class="ad-res ad-res-erro">⚠️ <b>Consulta não concluída.</b> '
          + AD.esc(e.message || 'Tente novamente quando houver conexão.') + '</div>';
        return;
      }
    }
    if (!reg) {
      res.innerHTML = '<div class="ad-res ad-res-erro">❌ <b>Não encontrado.</b> Nenhum comprovante central corresponde a esse código/hash. Confira o código no comprovante do documento.</div>';
      return;
    }
    const ok = central ? true : await _integridadeCorrente(reg);
    if (pedido !== _validacaoPedido) return;
    const fonte = central ? '' : ' <span style="font-weight:400;font-size:.78rem">(registro desta sessão)</span>';
    const dt = String(reg.ts || '').replace('T', ' ').slice(0, 16);
    res.innerHTML = '<div class="ad-res ' + (ok ? 'ad-res-ok' : 'ad-res-alerta') + '">'
      + (central ? '✅ <b>Registro correspondente encontrado na nuvem.</b>' : ok ? '📎 <b>Metadados íntegros nesta sessão — assinatura não verificada.</b>' + fonte : '⚠️ <b>Registro possivelmente adulterado</b> (o hash do registro não confere).')
      + '<table style="width:100%;border-collapse:collapse;margin-top:8px;font-size:.82rem">'
      + AD._linha('Documento', reg.titulo)
      + (central ? '' : AD._linha('Profissional informado', (reg.profissional || '—') + (reg.crm ? ' · CRM ' + reg.crm : '')))
      + AD._linha(central ? 'Registrado em' : 'Assinado em', dt)
      + (central ? '' : AD._linha('Método informado', reg.provedorLabel || reg.provider))
      + AD._linha('Algoritmo', reg.algoritmo || 'SHA-256')
      + AD._linha('Versão do documento', String(reg.versao || 1))
      + AD._linha('Código de validação', reg.codigo)
      + (central ? '' : AD._linha('UUID', reg._id))
      + AD._linha('SHA-256 do PDF', '<span style="font-family:monospace;font-size:.72rem;word-break:break-all">' + AD.esc(reg.hashDoc || '') + '</span>', true)
      + '</table>'
      + '<p style="font-size:.74rem;margin-top:8px;color:#555">A cadeia ICP-Brasil do certificado é confirmada em <a href="https://validar.iti.gov.br" target="_blank" rel="noopener">validar.iti.gov.br</a> com o PDF assinado.</p>'
      + '</div>';
  }
  function _linha(k, v, htmlSeguro) { return '<tr><td style="padding:3px 6px;color:#667;white-space:nowrap;vertical-align:top">' + AD.esc(k) + '</td><td style="padding:3px 6px;font-weight:600">' + (v == null ? '—' : (htmlSeguro ? v : AD.esc(v))) + '</td></tr>'; }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  /* ---- injeta o botão "Assinar digitalmente" nas barras de ação ---- */
  function injetarBotoes() {
    document.querySelectorAll('.action-bar').forEach(bar => {
      if (bar._adBtn) return;
      const temImprimir = Array.from(bar.querySelectorAll('button')).some(b => /printPreview\.abrir/.test(b.getAttribute('data-soft-name-click') || b.getAttribute('onclick') || ''));
      if (!temImprimir) return;
      /* "Tem Imprimir" não é o mesmo que "é assinável". Dashboard e Agenda
         imprimem e não são documentos: ali o botão só conseguia dar o aviso
         "Abra um documento assinável" — um botão que só sabe falhar.
         Quem decide é a tabela de módulos assináveis, a mesma que ctxAtual()
         consulta; assim os dois não podem divergir. */
      const dono = bar.closest('[data-module]');
      const mod = dono && dono.getAttribute('data-module');
      if (!mod || !MODULOS[mod]) return;
      const b = document.createElement('button');
      b.className = 'btn'; b.type = 'button';
      b.style.cssText = 'background:#14532d;color:#fff;border-color:#0f3d21';
      b.innerHTML = '<span class="icon">🔏</span> Assinar digitalmente';
      b.onclick = () => assinaturaDigital.iniciar();
      const imp = Array.from(bar.querySelectorAll('button')).find(x => /printPreview\.abrir/.test(x.getAttribute('data-soft-name-click') || x.getAttribute('onclick') || ''));
      if (imp && imp.parentNode) imp.parentNode.insertBefore(b, imp.nextSibling); else bar.appendChild(b);
      bar._adBtn = true;
    });
  }

  /* rota #validar=CODIGO abre a tela pública de validação */
  function _checarHash() {
    const m = String(location.hash || '').match(/validar=?([^&]*)/i);
    if (m) abrirValidacao(decodeURIComponent(m[1] || ''));
  }

  const AD = {
    PROVIDERS, MODULOS, iniciar, gerarPDF, registrar, _trocarProvedor,
    abrirValidacao, fecharValidacao, _fazerValidacao, validar, seloHTML,
    urlValidacao, mostrarComprovante, esc, _linha, injetarBotoes, ctxAtual,
    uuid, codigoValidacao
  };
  window.addEventListener('DOMContentLoaded', () => { try { injetarBotoes(); _checarHash(); } catch (e) {} });
  window.addEventListener('hashchange', _checarHash);
  window.addEventListener('soft:modal-open', () => { _ctxPendente = null; });
  window.addEventListener('soft:modal-close', () => { _ctxPendente = null; });
  try { contextoAba.aoMudar(() => { _ctxPendente = null; }); } catch (e) {}
  /* reinjeta ao trocar de módulo (barras podem ser recriadas) */
  setInterval(() => {
    if (_ctxPendente) { try { requireTarget(_ctxPendente); } catch (e) { _ctxPendente = null; } }
    try { injetarBotoes(); } catch (e) {}
  }, 1500);
  return AD;
})();
