'use strict';

/* ============================================================================
   MEMED — prescrição digital (receita, exames, atestado, declaração, laudo)
   ----------------------------------------------------------------------------
   A ÚNICA EXCEÇÃO ÀS REGRAS DE OURO, autorizada pelo Marcelo: ao emitir pela
   Memed, os dados do paciente que a receita precisa (nome, CPF, nascimento,
   telefone, peso) saem do Soft para a Memed. Nada sai sem o clique em
   "Emitir pela Memed", e nada sai em segundo plano.

   O par de chaves da Memed NÃO está aqui: mora na função `memed` do servidor
   (Supabase). O app pede o token do PRÓPRIO médico logado, carrega o script
   da Memed uma vez só, manda o paciente e abre a janela deles. O documento
   emitido volta pelo evento `prescricaoImpressa` e vira um registro em
   Documentos emitidos — o PDF assinado fica na Memed.
============================================================================ */
const memedRx = {
  _token: null,
  _scriptUrl: '',
  _ambiente: '',
  _carregando: null,
  _pronto: false,
  _ctx: null,

  _url(op) {
    const c = (typeof cloud !== 'undefined' && cloud.config) ? cloud.config() : {};
    return String((c && c.url) || '').replace(/\/$/, '') + '/functions/v1/memed?op=' + op;
  },
  _so(v) { return String(v == null ? '' : v).replace(/\D+/g, ''); },
  _uid() {
    try { return ((cloud.session() || {}).user || {}).id || ''; } catch (e) { return ''; }
  },

  /* ---- 1. TOKEN DO MÉDICO (pela função do servidor) ---- */
  async _pedirToken(prescritor) {
    if (!(await cloud._garantirToken())) throw new Error(cloud.motivoSemToken());
    const s = cloud.session();
    let r, d;
    try {
      r = await fetch(memedRx._url('token'), {
        method: 'POST',
        headers: Object.assign({}, cloud._headers(false), { Authorization: 'Bearer ' + s.access_token, 'Content-Type': 'application/json' }),
        body: JSON.stringify(prescritor ? { prescritor } : {})
      });
      d = await r.json().catch(() => ({}));
    } catch (e) {
      throw new Error('Não consegui falar com a função da Memed: ' + e.message);
    }
    if (r.status === 404) throw new Error('A função "memed" ainda não foi publicada no Supabase. Veja o passo a passo da integração.');
    return { status: r.status, d: d || {} };
  },

  /* Os dados do médico só são pedidos UMA vez, quando a Memed ainda não o
     conhece. Ficam guardados neste aparelho, por conta, para não perguntar
     de novo — são do médico, não de paciente. */
  _chavePrescritor() { return 'soft_memed_prescritor_v1:' + memedRx._uid(); },
  _prescritorSalvo() {
    try { return JSON.parse(localStorage.getItem(memedRx._chavePrescritor()) || 'null'); } catch (e) { return null; }
  },
  _pedirPrescritor(erro) {
    return new Promise(resolve => {
      const p = memedRx._prescritorSalvo() || {};
      const e = utils.escapeHTML, a = utils.escapeAttr;
      const campo = (n, rot, v, extra) => '<div class="field col-6"><label>' + e(rot) + '</label><input type="text" id="memed-p-' + n + '" value="' + a(v || '') + '"' + (extra || '') + '></div>';
      modal.open('💊 Seus dados para a Memed',
        '<p style="font-size:.86rem;margin:0 0 10px">A Memed pede estes dados uma única vez, para cadastrar você como prescritor. Depois disso, o botão abre direto.</p>' +
        (erro ? '<p style="font-size:.84rem;color:var(--danger);margin:0 0 10px">' + e(erro) + '</p>' : '') +
        '<div class="grid">' +
        campo('nome', 'Nome', p.nome) + campo('sobrenome', 'Sobrenome', p.sobrenome) +
        campo('cpf', 'CPF', p.cpf, ' inputmode="numeric"') + campo('nasc', 'Data de nascimento (dd/mm/aaaa)', p.data_nascimento, ' placeholder="dd/mm/aaaa"') +
        campo('crm', 'Número do CRM', p.crm, ' inputmode="numeric"') + campo('uf', 'UF do CRM', p.uf, ' maxlength="2"') +
        '</div>',
        '<button class="btn" id="memed-p-cancelar">Cancelar</button><button class="btn btn-primary" id="memed-p-ok">Cadastrar e abrir</button>');
      const v = id => ((document.getElementById('memed-p-' + id) || {}).value || '').trim();
      document.getElementById('memed-p-cancelar').addEventListener('click', () => { modal.close(); resolve(null); });
      document.getElementById('memed-p-ok').addEventListener('click', () => {
        const dados = { nome: v('nome'), sobrenome: v('sobrenome'), cpf: memedRx._so(v('cpf')), data_nascimento: v('nasc'), crm: memedRx._so(v('crm')), uf: v('uf').toUpperCase(), conselho: 'CRM' };
        try { localStorage.setItem(memedRx._chavePrescritor(), JSON.stringify(dados)); } catch (x) {}
        modal.close();
        resolve(dados);
      });
    });
  },
  async _garantirToken() {
    if (memedRx._token) return true;
    let res = await memedRx._pedirToken(null);
    let tentativas = 0;
    while (!res.d.ok && res.d.precisaCadastro && tentativas < 3) {
      tentativas++;
      const dados = await memedRx._pedirPrescritor(tentativas > 1 || res.status !== 400 || !/faltam/.test(res.d.erro || '') ? res.d.erro : '');
      if (!dados) return false;
      res = await memedRx._pedirToken(dados);
    }
    if (!res.d.ok || !res.d.token) throw new Error(res.d.erro || ('A Memed não liberou o acesso (HTTP ' + res.status + ').'));
    memedRx._token = res.d.token;
    memedRx._scriptUrl = res.d.script_url;
    memedRx._ambiente = res.d.ambiente || '';
    return true;
  },

  /* ---- 2. SCRIPT DA MEMED: uma vez só ---- */
  _carregarScript() {
    if (memedRx._pronto) return Promise.resolve(true);
    if (memedRx._carregando) return memedRx._carregando;
    memedRx._carregando = new Promise((resolve, reject) => {
      if (!/^https:\/\/[a-z0-9.-]+\.memed\.com\.br\//.test(memedRx._scriptUrl)) { reject(new Error('Endereço do script da Memed inesperado.')); return; }
      const s = document.createElement('script');
      s.src = memedRx._scriptUrl;
      s.dataset.token = memedRx._token;
      s.id = 'memed-sinapse';
      const limite = setTimeout(() => reject(new Error('A janela da Memed demorou demais para carregar. Confira a internet e tente de novo.')), 45000);
      s.addEventListener('error', () => { clearTimeout(limite); reject(new Error('Não consegui carregar a Memed.')); });
      s.addEventListener('load', () => {
        try {
          window.MdSinapsePrescricao.event.add('core:moduleInit', m => {
            if (!m || m.name !== 'plataforma.prescricao') return;
            clearTimeout(limite);
            try { window.MdHub.event.add('prescricaoImpressa', d => memedRx._aoEmitir(d)); } catch (e) {}
            memedRx._pronto = true;
            resolve(true);
          });
        } catch (e) { clearTimeout(limite); reject(e); }
      });
      document.body.appendChild(s);
    }).catch(e => { memedRx._carregando = null; throw e; });
    return memedRx._carregando;
  },

  /* ---- 3. PACIENTE: o que a receita precisa, e só isso ---- */
  pacienteDe(formId) {
    const f = document.getElementById(formId);
    const g = n => ((f && f.querySelector('[name="' + n + '"]')) || {}).value || '';
    const nome = String(g('nome') || g('paciente_nome')).trim();
    let cad = null;
    try { cad = (store.list('pacientes') || []).find(p => utils.semAcento(p.nome || '') === utils.semAcento(nome)) || null; } catch (e) { cad = null; }
    const cpf = memedRx._so((cad && cad.cpf) || g('cpf') || g('documento'));
    const nasc = (cad && (cad.nascimento || cad.nasc)) || g('nascimento') || '';
    const nascBR = /^\d{4}-\d{2}-\d{2}$/.test(nasc) ? nasc.split('-').reverse().join('/') : (/^\d{2}\/\d{2}\/\d{4}$/.test(nasc) ? nasc : '');
    const sexoTxt = String((cad && cad.sexo) || g('sexo') || '').trim().toUpperCase();
    const p = { idExterno: (cad && cad._id) || ('soft-' + utils.semAcento(nome).replace(/[^a-z0-9]+/g, '-')), nome };
    p.sexo = sexoTxt.startsWith('F') ? 'Feminino' : sexoTxt.startsWith('M') ? 'Masculino' : undefined;
    if (cpf.length === 11) p.cpf = cpf;
    if (nascBR) p.data_nascimento = nascBR;
    const tel = memedRx._so((cad && (cad.telefone || cad.celular)) || g('telefone'));
    if (tel.length >= 10) p.telefone = tel;
    const peso = parseFloat(String((cad && cad.peso) || g('peso') || '').replace(',', '.'));
    if (peso > 0) p.peso = Math.round(peso);
    Object.keys(p).forEach(k => { if (p[k] === undefined || p[k] === '') delete p[k]; });
    return p;
  },

  /* ---- 4. ABRIR ---- */
  async abrir(origem) {
    const formId = origem === 'documentos' ? 'form-documentos' : 'form-prescricao';
    const paciente = memedRx.pacienteDe(formId);
    if (!paciente.nome) { toast('Informe o nome do paciente antes de abrir a Memed.', 'warn'); return false; }
    try {
      toast('💊 Abrindo a Memed…');
      if (!(await memedRx._garantirToken())) return false;
      await memedRx._carregarScript();
      memedRx._ctx = { origem, paciente, formId };
      await window.MdHub.command.send('plataforma.prescricao', 'setPaciente', paciente);
      window.MdHub.module.show('plataforma.prescricao');
      return true;
    } catch (e) {
      toast('💊 ' + (e && e.message ? e.message : 'Não consegui abrir a Memed.'), 'warn');
      return false;
    }
  },

  /* ---- 5. VOLTA: o documento emitido vira registro em Documentos emitidos ---- */
  _resumoItens(d) {
    const pres = (d && (d.prescricao || d['prescrição'] || d.data || d)) || {};
    const itens = Array.isArray(pres.medicamentos) ? pres.medicamentos : [];
    return itens.map(it => ({
      nome: String(it.nome || it.descricao || '').slice(0, 200),
      tipo: String(it.tipo || ''),
      receituario: String(it.receituario || ''),
      categoria: String(it.custom_categoria || ''),
      tuss: String(it.exames_tuss_codigo || '')
    })).filter(x => x.nome);
  },
  _aoEmitir(d) {
    try {
      const ctx = memedRx._ctx || {};
      const pres = (d && (d.prescricao || d['prescrição'] || d.data || d)) || {};
      const itens = memedRx._resumoItens(d);
      const rec = {
        modelo: 'memed',
        nome: (ctx.paciente && ctx.paciente.nome) || ((pres.paciente || {}).nome) || '',
        data: utils.hojeISO(),
        memed_id: String(pres.id || (d && d.id) || ''),
        memed_ambiente: memedRx._ambiente,
        memed_itens: itens,
        origem_modulo: ctx.origem || ''
      };
      const salvo = store.save('documentos', rec);
      try { store.notificarNuvem(salvo, 'Documento da Memed'); } catch (e) {}
      toast('💊 Emitido pela Memed: ' + (itens.length ? itens.length + ' item(ns)' : 'documento') + ' — está em Documentos emitidos.');
      return salvo;
    } catch (e) { return null; }
  },

  /* Reabrir um emitido: o PDF assinado está na Memed */
  async ver(rec) {
    if (!rec || !rec.memed_id) { toast('Este documento não tem o identificador da Memed.', 'warn'); return; }
    try {
      if (!(await memedRx._garantirToken())) return;
      await memedRx._carregarScript();
      await window.MdHub.command.send('plataforma.prescricao', 'viewPrescription', rec.memed_id);
    } catch (e) { toast('💊 ' + (e && e.message ? e.message : 'Não consegui abrir na Memed.'), 'warn'); }
  },
  resumoHTML(rec) {
    const e = utils.escapeHTML;
    const itens = Array.isArray(rec && rec.memed_itens) ? rec.memed_itens : [];
    return '<p style="font-size:.88rem;margin:0 0 8px"><b>' + e(rec.nome || '') + '</b> — emitido pela Memed em ' + e(utils.formatarData(rec.data) || '') + '</p>' +
      (itens.length ? '<ul style="margin:0 0 8px;padding-left:18px;font-size:.86rem">' + itens.map(it =>
        '<li>' + e(it.nome) + (it.tuss ? ' <small>(TUSS ' + e(it.tuss) + ')</small>' : '') + (it.receituario ? ' <small>— ' + e(it.receituario) + '</small>' : '') + '</li>').join('') + '</ul>' : '') +
      '<p style="font-size:.8rem;color:var(--text-mute);margin:0">O documento assinado fica na Memed. Para reimprimir ou reenviar ao paciente, abra na Memed.</p>';
  }
};
/* O botão só aparece com a função publicada e configurada no servidor:
   botão que só responde "ainda não configurado" é ruído na tela de todo dia. */
memedRx.checar = async function () {
  let ok = false;
  try {
    const c = (typeof cloud !== 'undefined' && cloud.config) ? cloud.config() : {};
    if (c && c.url) {
      const r = await fetch(memedRx._url('health'), { headers: cloud._headers(false) });
      const d = r.ok ? await r.json().catch(() => ({})) : {};
      ok = !!(d && d.configurada);
    }
  } catch (e) { ok = false; }
  memedRx.disponivel = ok;
  document.querySelectorAll('.memed-btn').forEach(b => { b.style.display = ok ? '' : 'none'; });
  return ok;
};
window.memedRx = memedRx;
window.addEventListener('load', () => { setTimeout(() => { memedRx.checar(); }, 4000); });
