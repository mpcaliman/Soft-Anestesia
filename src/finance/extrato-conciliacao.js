'use strict';

/* ============================================================================
   CONCILIAÇÃO PELO EXTRATO (PDF) + VALORES PAGOS APRENDIDOS
   Lê o PDF que a cooperativa / operadora manda (Coopanest "Movimento
   Detalhado por Cooperado", Unimed "Espelho de Pagamento Prestador") NO
   PRÓPRIO NAVEGADOR — o arquivo não sai do aparelho —, casa cada linha com os
   lançamentos do Financeiro (paciente + data + código TUSS) e mostra o que
   confere, o que veio com diferença, o que foi pago e não está lançado e o
   que está lançado e não veio. Nada é gravado sem "Aplicar".

   O que foi pago também ENSINA: cada linha vira uma observação de valor por
   convênio + código, normalizada para o valor cheio (via única / 100%). A
   tabela de valores aprendidos mostra a correlação código × porte cirúrgico ×
   porte anestésico × valor pago e, com um toque, passa o valor para o "valor
   do convênio para o código" — que é o que o Gerar financeiro usa primeiro.
============================================================================ */
const extratoConc = {
  /* Coopanest: via única 100%, via diferente 70%, mesma via 50% */
  FATOR_VIA: { U: 1, D: 0.7, M: 0.5 },

  /* ---------------------------------------------------------------- texto */
  _norm(s) {
    return String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  },
  _num(s) {
    const t = String(s == null ? '' : s).trim();
    if (!t) return null;
    /* 1.650,99 | 721,88 | 378 | 264,6 | 122.00 (Unimed usa ponto na coluna unitária) */
    const v = /,/.test(t) ? Number(t.replace(/\./g, '').replace(',', '.')) : Number(t);
    return Number.isFinite(v) ? v : null;
  },
  _dataISO(s) {
    const m = String(s || '').match(/^(\d{2})\/(\d{2})\/(\d{4}|\d{2})(?!\d)/);
    if (!m) return '';
    const ano = m[3].length === 2 ? '20' + m[3] : m[3];
    return ano + '-' + m[2] + '-' + m[1];
  },
  _ehValor(s) { return /^\d{1,3}(\.\d{3})*(,\d{1,2})?$|^\d+(,\d{1,2})?$/.test(String(s || '').trim()); },
  _texto(row) { return row.its.map(i => i.s).join(' '); },

  /* ------------------------------------------------------- leitura do PDF */
  async _pdfjs() {
    if (extratoConc._lib) return extratoConc._lib;
    const base = new URL('vendor/pdfjs/', location.href).href;
    const lib = await import(base + 'pdf.min.mjs');
    lib.GlobalWorkerOptions.workerSrc = base + 'pdf.worker.min.mjs';
    extratoConc._lib = lib;
    return lib;
  },
  /* páginas → linhas (itens com a mesma altura), cada item com o x */
  async paginasDoArquivo(arquivo) {
    const lib = await extratoConc._pdfjs();
    const dados = new Uint8Array(await arquivo.arrayBuffer());
    const doc = await lib.getDocument({ data: dados, isEvalSupported: false, disableFontFace: true }).promise;
    const paginas = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const rows = [];
      tc.items.forEach(it => {
        const s = String(it.str || '').trim();
        if (!s) return;
        const y = Math.round(it.transform[5]), x = Math.round(it.transform[4]);
        let r = rows.find(q => Math.abs(q.y - y) <= 2);
        if (!r) { r = { y, its: [] }; rows.push(r); }
        r.its.push({ x, s });
      });
      rows.sort((a, b) => b.y - a.y);
      rows.forEach(r => r.its.sort((a, b) => a.x - b.x));
      paginas.push(rows);
    }
    try { await doc.destroy(); } catch (e) {}
    return paginas;
  },
  detectar(paginas) {
    const tudo = (paginas[0] || []).map(extratoConc._texto).join(' \n ');
    if (/Movimento Detalhado Por Cooperado/i.test(tudo) || /COOPERATIVA MEDICOS ANESTESIOLOGISTAS/i.test(tudo)) return 'coopanest';
    if (/Espelho de Pagamento Prestador/i.test(tudo)) return 'unimed';
    return '';
  },

  /* ------------------------------------------------------------ Coopanest */
  parseCoopanest(paginas) {
    const regs = [];
    let convenio = '', tipo = '', competencia = '', atual = null;
    paginas.forEach(rows => {
      const head = rows.find(r => r.its.some(i => i.s === 'BOLETINS'));
      if (!head) return;
      const hx = n => { const it = head.its.find(i => i.s === n); return it ? it.x : null; };
      const valores = head.its.filter(i => i.s === 'VALOR').map(i => i.x);
      const col = {
        pac: hx('PACIENTE'), hosp: hx('HOSPITAL'), data: hx('DATA'), cod: hx('CÓDIGO') || hx('CODIGO'),
        proc: hx('PROCEDIMENTO'), porte: hx('PORTE'), via: hx('VIA'),
        vst: valores[0], valor: valores[1], glosa: hx('GLOSA'), pago: hx('PAGO')
      };
      if ([col.pac, col.hosp, col.cod, col.proc, col.porte, col.pago].some(v => v == null)) return;
      const colValor = x => {
        const alvos = [['vst', col.vst], ['valor', col.valor], ['glosa', col.glosa], ['pago', col.pago]].filter(a => a[1] != null);
        let melhor = null, d = 1e9;
        alvos.forEach(([k, cx]) => { const dd = Math.abs(cx - x); if (dd < d) { d = dd; melhor = k; } });
        return melhor;
      };
      rows.forEach((r, idx) => {
        const txt = extratoConc._texto(r);
        const m = txt.match(/^(\d{2})-(\d{4})$/);
        if (m && !competencia) competencia = m[2] + '-' + m[1];
        /* cabeçalho de seção: CONVÊNIO (linha sozinha à esquerda, seguida de PROCEDIMENTO/CONSULTA) */
        if (r.its.length === 1 && r.its[0].x < col.pac - 20) {
          const s = r.its[0].s;
          if (/^(PROCEDIMENTO|CONSULTA|HONOR[AÁ]RIO.*|TAXA.*)$/i.test(s)) { tipo = s.toUpperCase(); return; }
          const prox = rows[idx + 1];
          if (prox && prox.its.length === 1 && /^(PROCEDIMENTO|CONSULTA)$/i.test(prox.its[0].s)) { convenio = s; return; }
        }
        const primeiro = r.its[0];
        const novo = primeiro && /^\d{7,11}$/.test(primeiro.s) && primeiro.x < col.pac - 5;
        if (!novo && !atual) return;
        /* os títulos das colunas são CENTRALIZADOS e o conteúdo, alinhado à
           esquerda: a fronteira entre duas colunas é o meio entre os títulos */
        const meio = (a, b) => (a + b) / 2;
        const xBol = (head.its.find(i => i.s === 'BOLETINS') || { x: 38 }).x;
        const fPac = xBol + 25, fHosp = meio(col.pac, col.hosp), fData = col.data != null ? col.data - 12 : fHosp + 60;
        const nome = r.its.filter(i => i.x >= fPac && i.x < fHosp && !/^\d{7,11}$/.test(i.s)).map(i => i.s).join(' ');
        const hosp = r.its.filter(i => i.x >= fHosp && i.x < fData).map(i => i.s).join(' ');
        const cod = r.its.find(i => /^\d{8}$/.test(i.s) && i.x >= col.cod - 20 && i.x < col.cod + 30);
        const fDesc = cod ? cod.x + 20 : col.cod + 30;
        const desc = r.its.filter(i => i.x >= fDesc && i.x < col.porte - 8).map(i => i.s).join(' ');
        const porte = r.its.find(i => /^\d{1,2}$/.test(i.s) && Math.abs(i.x - col.porte) < 25);
        const via = r.its.find(i => /^[UDM]$/.test(i.s) && col.via != null && Math.abs(i.x - col.via) < 12);
        const nums = r.its.filter(i => i.x >= (col.vst || col.valor) - 20 && extratoConc._ehValor(i.s));
        if (novo) {
          const data = r.its.find(i => /^\d{2}\/\d{2}\/\d{2,4}$/.test(i.s));
          atual = { fonte: 'Coopanest', convenio, tipo, boletim: primeiro.s, paciente: nome, hospital: hosp,
            data: data ? extratoConc._dataISO(data.s) : '', itens: [], valor: null, glosa: 0, pago: null };
          regs.push(atual);
          nums.forEach(n => {
            const k = colValor(n.x), v = extratoConc._num(n.s);
            if (k === 'valor') atual.valor = v; else if (k === 'glosa') atual.glosa = v || 0; else if (k === 'pago') atual.pago = v;
            else if (k === 'vst') atual._vst = v;
          });
        } else {
          if (nome) atual.paciente += ' ' + nome;
          if (hosp) atual.hospital += ' ' + hosp;
        }
        if (cod) {
          const vstIt = nums.find(n => colValor(n.x) === 'vst');
          atual.itens.push({ codigo: cod.s, descricao: desc, porteAn: porte ? porte.s.padStart(2, '0') : '',
            via: via ? via.s : '', valorSemTaxa: vstIt ? extratoConc._num(vstIt.s) : null });
        } else if (desc && atual.itens.length && !novo) {
          atual.itens[atual.itens.length - 1].descricao += ' ' + desc;
        }
      });
    });
    regs.forEach(r => { r.paciente = r.paciente.replace(/\s+/g, ' ').trim(); r.hospital = r.hospital.replace(/\s+/g, ' ').trim(); });
    /* um boletim pode ter vários códigos e um só "pago": divide pelo valor de cada código */
    const linhas = [];
    regs.forEach(r => {
      const soma = r.itens.reduce((s, i) => s + (i.valorSemTaxa || 0), 0);
      const pago = r.pago != null ? r.pago : (r.valor != null ? r.valor - (r.glosa || 0) : soma);
      r.itens.forEach(i => {
        const frac = soma > 0 ? (i.valorSemTaxa || 0) / soma : 1 / r.itens.length;
        const fator = extratoConc.FATOR_VIA[i.via] || 1;
        linhas.push({
          fonte: 'Coopanest', convenio: r.convenio, tipo: r.tipo, ref: 'Boletim ' + r.boletim, paciente: r.paciente,
          hospital: r.hospital, data: r.data, codigo: i.codigo, descricao: i.descricao.replace(/\s+/g, ' ').trim(),
          porteAn: i.porteAn, via: i.via, cobrado: i.valorSemTaxa, glosa: (r.glosa || 0) * frac,
          pago: Math.round(pago * frac * 100) / 100,
          valorCheio: i.valorSemTaxa != null ? Math.round(i.valorSemTaxa / fator * 100) / 100 : null,
          base: i.via ? 'via ' + i.via + ' (' + Math.round(fator * 100) + '%)' : ''
        });
      });
    });
    return { fonte: 'Coopanest', competencia, dataPagamento: '', linhas, glosas: [] };
  },

  /* --------------------------------------------------------------- Unimed */
  parseUnimed(paginas) {
    let competencia = '', dataPagamento = '', grupo = '', benef = null, secao = '';
    const itens = [], glosas = [];
    paginas.forEach(rows => {
      rows.forEach(r => {
        const txt = extratoConc._texto(r);
        let m = txt.match(/Comp\.Pagamento:\s*(\d{2})-(\d{4})/);
        if (m && !competencia) competencia = m[2] + '-' + m[1];
        m = txt.match(/pagamento ser[aá] realizado no dia\s+(\d{2}\/\d{2}\/\d{4})/i);
        if (m) dataPagamento = extratoConc._dataISO(m[1]);
        if (/^Eventos Pagos$/.test(txt)) { secao = 'pagos'; return; }
        if (/^Eventos Regulados$|^Resumo de Pagamento$|^Impostos$|^Débitos em Aberto$/.test(txt)) { secao = ''; return; }
        if (/^Glosas$/.test(txt)) { secao = 'glosas'; return; }
        m = txt.match(/^Grupo Apropria[cç][aã]o:\s*(.+?)\s+Classe Doc/);
        if (m) { grupo = m[1]; return; }
        const t = r.its;
        if (secao === 'glosas') {
          if (t.length >= 6 && /^\d{9,12}$/.test(t[0].s) && /^\d{2}\/\d{2}\/\d{4}$/.test(t[1].s)) {
            glosas.push({ evento: t[0].s, data: extratoConc._dataISO(t[1].s), paciente: t[3] ? t[3].s : '',
              motivo: (t.find(i => i.x >= 520 && i.x < 740) || {}).s || '', situacao: (t.find(i => i.x >= 740 && i.x < 790) || {}).s || '' });
          }
          return;
        }
        if (secao !== 'pagos') return;
        /* cabeçalho do beneficiário: carteirinha, nome, lote, evento, local, competência, saldo */
        if (t.length >= 4 && /^\d{12,17}$/.test(t[0].s) && t[0].x < 40 && t.some(i => /^\d{2}-\d{4}$/.test(i.s))) {
          const lote = t.find(i => i.x > 200 && /^\d{2,5}$/.test(i.s));
          benef = { carteira: t[0].s, paciente: t.filter(i => i.x > t[0].x + 30 && i.x < (lote ? lote.x - 5 : 240)).map(i => i.s).join(' '), grupo };
          return;
        }
        /* item pago: seq, solicitação, tipo de serviço, código, descrição, data/hora, %pago, unit, qtde, valor, C/D */
        if (benef && t.length >= 8 && /^\d{1,3}$/.test(t[0].s) && t[0].x < 50 && /^\d{6,10}$/.test(t[1].s)) {
          const cod = t.find(i => /^\d{8}$/.test(i.s) && i.x > 280 && i.x < 360);
          const dt = t.find(i => /^\d{2}\/\d{2}\/\d{4}/.test(i.s));
          const pct = t.find(i => /^\d{1,3}%$/.test(i.s));
          if (!cod || !dt || !pct) return;
          const depois = t.filter(i => i.x > pct.x);
          /* "Vl. Unit. U": nas guias é a fração do porte (1.00, 0.02 + 0.98);
             nas consultas é o preço unitário (122.00) — só fração conta */
          const unit = depois.find(i => /^\d+\.\d+$/.test(i.s) && Number(i.s) < 10);
          const valor = depois.filter(i => /,\d{2}$/.test(i.s)).pop();
          /* "D" no fim = débito (estorno): entra negativo */
          const sinal = valor && depois.some(i => i.x > valor.x && i.s === 'D') ? -1 : 1;
          const tipoSrv = t.find(i => i.x > 250 && i.x < cod.x);
          const desc = t.filter(i => i.x > cod.x && i.x < dt.x).map(i => i.s).join(' ');
          const part = t.find(i => i.x > dt.x + 40 && i.x < pct.x && !/%$/.test(i.s));
          itens.push({ paciente: benef.paciente, carteira: benef.carteira, grupo: benef.grupo, solicitacao: t[1].s,
            tipoServico: tipoSrv ? tipoSrv.s : '', codigo: cod.s, descricao: desc, data: extratoConc._dataISO(dt.s),
            participacao: part ? part.s : '', pct: Number(pct.s.replace('%', '')), unit: unit ? Number(unit.s) : 1,
            valor: valor ? sinal * extratoConc._num(valor.s) : 0 });
        }
      });
    });
    /* o mesmo procedimento pode vir partido (0,02 + 0,98): soma por paciente + código + data */
    const grupos = new Map();
    itens.forEach(i => {
      const k = [i.carteira, i.codigo, i.data, i.pct].join('|');
      if (!grupos.has(k)) grupos.set(k, Object.assign({}, i, { valor: 0, unit: 0, solicitacoes: new Set() }));
      const g = grupos.get(k);
      g.valor = Math.round((g.valor + i.valor) * 100) / 100; g.unit += i.unit; g.solicitacoes.add(i.solicitacao);
    });
    const linhas = Array.from(grupos.values()).filter(g => Math.abs(g.valor) >= 0.005).map(g => {
      const unidades = g.unit >= 1.5 ? Math.round(g.unit) : 1;
      return {
        fonte: 'Unimed', convenio: 'Unimed', tipo: g.grupo, ref: 'Solicitação ' + Array.from(g.solicitacoes).join(', '),
        paciente: g.paciente, hospital: '', data: g.data, codigo: g.codigo, descricao: g.descricao,
        porteAn: '', via: '', pct: g.pct, unidades, cobrado: null, glosa: 0, pago: g.valor,
        valorCheio: g.pct > 0 ? Math.round(g.valor / (g.pct / 100) / unidades * 100) / 100 : null,
        base: g.pct + '%' + (unidades > 1 ? ' · ' + unidades + ' unid.' : '') + (g.participacao ? ' · ' + g.participacao : '')
      };
    });
    return { fonte: 'Unimed', competencia, dataPagamento, linhas, glosas };
  },

  /* ----------------------------------------------------------- casamento */
  _tokens(s) { return extratoConc._norm(s).split(' ').filter(w => w.length >= 3 && ['dos', 'das', 'de', 'da', 'do'].indexOf(w) < 0); },
  /* nomes truncados pela operadora ("OLIVEIRA SANTO"): prefixo vale */
  _semelhanca(a, b) {
    const ta = extratoConc._tokens(a), tb = extratoConc._tokens(b);
    if (!ta.length || !tb.length) return 0;
    const casa = (x, y) => x === y || (x.length >= 4 && y.length >= 4 && (x.indexOf(y) === 0 || y.indexOf(x) === 0));
    const ab = ta.filter(x => tb.some(y => casa(x, y))).length / ta.length;
    const ba = tb.filter(y => ta.some(x => casa(x, y))).length / tb.length;
    const primeiro = casa(ta[0], tb[0]) ? 0.15 : 0;
    return Math.min(1, (ab + ba) / 2 + primeiro);
  },
  _codigosDe(f) {
    const set = new Set();
    const add = c => { const d = String(c || '').replace(/\D/g, ''); if (d) set.add(d); };
    add(f.cbhpm_codigo);
    (Array.isArray(f.codigos) ? f.codigos : []).forEach(c => add(c && (c.codigo || c.cbhpm_codigo)));
    return set;
  },
  _diaDif(a, b) {
    const da = Date.parse(a + 'T00:00:00'), db = Date.parse(b + 'T00:00:00');
    return Number.isFinite(da) && Number.isFinite(db) ? Math.abs(da - db) / 864e5 : 99;
  },
  _chaveConc(ext) { return ext.fonte + '|' + (ext.competencia || ''); },
  conciliar(ext) {
    const fins = (store.list('financeiro') || []).filter(f => f && f._id && f.status !== 'cancelado');
    const resultado = { confere: [], diferenca: [], jaAplicado: [], semLancamento: [], naoVeio: [] };
    const usados = new Map();   /* id do lançamento → linhas */
    const chave = extratoConc._chaveConc(ext);
    ext.linhas.forEach(l => {
      let melhor = null, nota = 0;
      fins.forEach(f => {
        const dd = extratoConc._diaDif(String(f.data_proc || '').slice(0, 10), l.data);
        if (dd > 1) return;
        const sim = extratoConc._semelhanca(l.paciente, f.paciente);
        if (sim < 0.6) return;
        const cods = extratoConc._codigosDe(f);
        let n = sim + (dd === 0 ? 0.3 : 0) + (cods.has(l.codigo) ? 0.6 : (cods.size ? -0.2 : 0));
        if (n > nota) { nota = n; melhor = f; }
      });
      if (!melhor || nota < 0.95) { resultado.semLancamento.push({ linha: l }); return; }
      if (!usados.has(melhor._id)) usados.set(melhor._id, []);
      usados.get(melhor._id).push(l);
    });
    usados.forEach((linhas, id) => {
      const f = fins.find(x => x._id === id);
      const pago = Math.round(linhas.reduce((s, l) => s + (l.pago || 0), 0) * 100) / 100;
      const glosa = Math.round(linhas.reduce((s, l) => s + (l.glosa || 0), 0) * 100) / 100;
      const previsto = Number(f.valor_previsto) || 0;
      const item = { fin: f, linhas, pago, glosa, previsto, dif: Math.round((pago - previsto) * 100) / 100 };
      if ((f._conciliacoes || []).some(c => c.chave === chave)) resultado.jaAplicado.push(item);
      else if (!previsto || Math.abs(item.dif) <= 0.05) resultado.confere.push(item);
      else resultado.diferenca.push(item);
    });
    /* lançado e não pago neste extrato: mesmo convênio, dentro do período do extrato */
    const datas = ext.linhas.map(l => l.data).filter(Boolean).sort();
    const convs = new Set(ext.linhas.map(l => extratoConc._norm(l.convenio).split(' ')[0]).filter(Boolean));
    if (datas.length) {
      const de = datas[0], ate = datas[datas.length - 1];
      fins.forEach(f => {
        if (usados.has(f._id)) return;
        const d = String(f.data_proc || '').slice(0, 10);
        if (!d || d < de || d > ate) return;
        if (financeiro.ehQuitado && financeiro.ehQuitado(f.status)) return;
        const c = extratoConc._norm(f.convenio || f.tipo_pagamento).split(' ')[0];
        if (!convs.has(c)) return;
        resultado.naoVeio.push({ fin: f });
      });
    }
    return resultado;
  },

  /* -------------------------------------------------- valores aprendidos */
  _cfg() { try { return orcamento.cfg().valoresPagos || {}; } catch (e) { return {}; } },
  _salvarCfg(v) { try { orcamento.salvarCfg({ valoresPagos: v }); } catch (e) {} },
  _convChave(c) { return extratoConc._norm(c).split(' ')[0] || ''; },
  aprender(ext) {
    const todos = JSON.parse(JSON.stringify(extratoConc._cfg()));
    let n = 0;
    ext.linhas.forEach(l => {
      if (!l.codigo || !(l.valorCheio > 0) || (l.glosa || 0) > 0.005) return;
      const cv = extratoConc._convChave(l.convenio);
      if (!cv) return;
      const porConv = todos[cv] = todos[cv] || { nome: l.convenio, codigos: {} };
      const reg = porConv.codigos[l.codigo] = porConv.codigos[l.codigo] || { descricao: l.descricao, obs: [] };
      const ref = ext.fonte + '|' + ext.competencia + '|' + l.ref + '|' + l.paciente;
      if (reg.obs.some(o => o.ref === ref)) return;
      reg.obs.push({ v: l.valorCheio, pago: l.pago, base: l.base, porteAn: l.porteAn || '', comp: ext.competencia, data: l.data, ref });
      reg.obs = reg.obs.slice(-40);
      if (l.porteAn) reg.porteAn = l.porteAn;
      n++;
    });
    extratoConc._salvarCfg(todos);
    return n;
  },
  _mediana(vs) {
    const a = vs.slice().sort((x, y) => x - y);
    if (!a.length) return null;
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2 * 100) / 100;
  },
  tabela() {
    const out = [];
    const todos = extratoConc._cfg();
    Object.keys(todos).forEach(cv => {
      const c = todos[cv];
      Object.keys(c.codigos || {}).forEach(cod => {
        const r = c.codigos[cod];
        const vs = (r.obs || []).map(o => o.v).filter(v => v > 0);
        let info = null, an = null;
        try { info = cbhpm.info(cod); } catch (e) {}
        try { an = cbhpm.anestesiaDe(cod); } catch (e) {}
        let noSoft = null;
        try { noSoft = precos.base(cod, 'anestesia', c.nome); } catch (e) {}
        out.push({
          conv: cv, convNome: c.nome, codigo: cod, descricao: (info && info.descricao) || r.descricao || '',
          porteCir: (info && info.porte) || '', porteAn: r.porteAn || (an && an.porte_anest != null ? String(an.porte_anest) : ''),
          valor: extratoConc._mediana(vs), n: vs.length, min: vs.length ? Math.min.apply(null, vs) : null,
          max: vs.length ? Math.max.apply(null, vs) : null,
          ultima: (r.obs || []).map(o => o.comp).filter(Boolean).sort().pop() || '',
          noSoft: noSoft && noSoft.valor != null ? noSoft.valor : null, origemSoft: noSoft ? noSoft.origem : ''
        });
      });
    });
    return out.sort((a, b) => a.conv.localeCompare(b.conv) || a.codigo.localeCompare(b.codigo));
  },
  /* passa o valor aprendido para o "valor do convênio para o código" */
  usarValor(conv, codigo, opts = {}) {
    const linha = extratoConc.tabela().find(x => x.conv === conv && x.codigo === codigo);
    if (!linha || !(linha.valor > 0)) return false;
    precos.definirPorCodigoDoConvenio(conv, codigo, linha.valor);
    if (!opts.silent) { toast('✅ ' + codigo + ' no ' + linha.convNome + ': R$ ' + extratoConc._fmt(linha.valor) + ' passa a valer no Gerar financeiro'); extratoConc.abrirValores(); }
    return true;
  },
  /* só preenche o que o convênio ainda não tem — valor digitado por ele fica */
  usarNosVazios() {
    let n = 0;
    extratoConc.tabela().forEach(l => {
      if (!(l.valor > 0)) return;
      const ja = precos.porCodigoDoConvenio(l.conv)[l.codigo];
      if (ja != null && ja !== '') return;
      if (extratoConc.usarValor(l.conv, l.codigo, { silent: true })) n++;
    });
    return n;
  },
  _fmt(v) { return Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); },

  /* ------------------------------------------------------------------ tela */
  abrir() {
    const e = utils.escapeHTML;
    modal.open('📑 Conciliar extrato (PDF)',
      '<p style="font-size:.86rem;line-height:1.6;margin:0 0 10px">Escolha o PDF de pagamento da <b>Coopanest</b> (Movimento Detalhado por Cooperado) ou da <b>Unimed</b> (Espelho de Pagamento Prestador). ' +
      'O arquivo é lido <b>neste aparelho</b> — não é enviado para lugar nenhum. Nada é gravado antes de você conferir e tocar em <b>Aplicar</b>.</p>' +
      '<input type="file" id="extrato-pdf" accept="application/pdf,.pdf">' +
      '<div id="extrato-status" style="font-size:.84rem;margin-top:10px;color:var(--text-mute)"></div>',
      '<button class="btn" onclick="modal.close()">Fechar</button>');
    const inp = document.getElementById('extrato-pdf');
    if (inp) inp.addEventListener('change', () => { if (inp.files && inp.files[0]) extratoConc._ler(inp.files[0]); });
    void e;
  },
  async _ler(arquivo) {
    const st = document.getElementById('extrato-status');
    const diz = t => { if (st) st.textContent = t; };
    try {
      diz('⏳ Lendo o PDF…');
      const paginas = await extratoConc.paginasDoArquivo(arquivo);
      const tipo = extratoConc.detectar(paginas);
      if (!tipo) { diz('Não reconheci este PDF. Por enquanto: Coopanest (Movimento Detalhado) e Unimed (Espelho de Pagamento).'); return; }
      const ext = tipo === 'coopanest' ? extratoConc.parseCoopanest(paginas) : extratoConc.parseUnimed(paginas);
      ext.arquivo = arquivo.name || '';
      if (!ext.linhas.length) { diz('Li o PDF, mas não encontrei linhas pagas.'); return; }
      extratoConc.revisar(ext);
    } catch (err) {
      console.error(err);
      diz('Não consegui ler o PDF: ' + (err && err.message ? err.message : err));
    }
  },
  _ext: null, _res: null,
  revisar(ext) {
    extratoConc._ext = ext;
    const res = extratoConc._res = extratoConc.conciliar(ext);
    const E = utils.escapeHTML, F = extratoConc._fmt;
    const total = ext.linhas.reduce((s, l) => s + (l.pago || 0), 0);
    const cab = (t, n, cor) => '<h3 style="font-size:.95rem;margin:14px 0 6px;color:' + cor + '">' + t + ' <small style="font-weight:400;color:var(--text-mute)">(' + n + ')</small></h3>';
    const linhasTxt = ls => ls.map(l => E(l.codigo) + ' ' + E((l.descricao || '').slice(0, 40)) + ' · ' + E(l.base || '') + ' · R$ ' + F(l.pago)).join('<br>');
    const tab = (lista, comCheck, chkPadrao) => '<table class="fase4-tab" style="width:100%;font-size:.8rem"><thead><tr>' + (comCheck ? '<th></th>' : '') +
      '<th>Paciente</th><th>Data</th><th>Extrato</th><th>Previsto</th><th>Pago</th><th>Dif.</th></tr></thead><tbody>' +
      lista.map((it, i) => '<tr>' + (comCheck ? '<td><input type="checkbox" class="extrato-aplicar" data-i="' + i + '" data-g="' + comCheck + '"' + (chkPadrao ? ' checked' : '') + '></td>' : '') +
        '<td>' + E(it.fin.paciente || '') + '</td><td>' + E(utils.formatarData(String(it.fin.data_proc || '').slice(0, 10))) + '</td>' +
        '<td>' + linhasTxt(it.linhas) + '</td><td>R$ ' + F(it.previsto) + '</td><td><b>R$ ' + F(it.pago) + '</b></td>' +
        '<td style="color:' + (Math.abs(it.dif) > 0.05 ? '#a33' : 'inherit') + '">' + (it.dif ? (it.dif > 0 ? '+' : '') + F(it.dif) : '—') + '</td></tr>').join('') + '</tbody></table>';
    const glosaDe = l => (ext.glosas || []).filter(g => extratoConc._semelhanca(g.paciente, l.paciente) >= 0.6);
    let corpo = '<div style="font-size:.84rem;line-height:1.6"><b>' + E(ext.fonte) + '</b> · competência ' + E(ext.competencia || '—') +
      ' · ' + ext.linhas.length + ' linha(s) paga(s) · total R$ ' + F(total) + (ext.arquivo ? ' · ' + E(ext.arquivo) : '') + '</div>';
    corpo += '<div class="field" style="margin-top:10px;max-width:260px"><label>Data do recebimento</label><input type="date" id="extrato-data" value="' +
      E(ext.dataPagamento || utils.hojeISO()) + '"></div>';
    corpo += cab('✅ Pago e confere', res.confere.length, '#1e7a3c') + (res.confere.length ? tab(res.confere, 'confere', true) : '<p style="font-size:.8rem;color:var(--text-mute)">—</p>');
    corpo += cab('⚠️ Pago com diferença', res.diferenca.length, '#a35b00') + (res.diferenca.length ? tab(res.diferenca, 'diferenca', true) : '<p style="font-size:.8rem;color:var(--text-mute)">—</p>');
    corpo += cab('❓ No extrato, mas não lançado no Soft', res.semLancamento.length, '#1c64a9') + (res.semLancamento.length
      ? '<table class="fase4-tab" style="width:100%;font-size:.8rem"><thead><tr><th>Lançar</th><th>Paciente</th><th>Data</th><th>Código</th><th>Pago</th></tr></thead><tbody>' +
        res.semLancamento.map((s, i) => '<tr><td><input type="checkbox" class="extrato-lancar" data-i="' + i + '"></td><td>' + E(s.linha.paciente) +
          (glosaDe(s.linha).length ? '<br><small style="color:#a33">glosa: ' + E(glosaDe(s.linha).map(g => g.motivo).join('; ')) + '</small>' : '') + '</td><td>' + E(utils.formatarData(s.linha.data)) +
          '</td><td>' + E(s.linha.codigo) + ' ' + E((s.linha.descricao || '').slice(0, 40)) + '</td><td>R$ ' + F(s.linha.pago) + '</td></tr>').join('') + '</tbody></table>'
      : '<p style="font-size:.8rem;color:var(--text-mute)">—</p>');
    corpo += cab('⏳ Lançado no Soft, mas não pago neste extrato', res.naoVeio.length, '#6b6b6b') + (res.naoVeio.length
      ? '<ul style="font-size:.8rem;margin:0;padding-left:18px">' + res.naoVeio.map(n => '<li>' + E(n.fin.paciente || '') + ' · ' + E(utils.formatarData(String(n.fin.data_proc || '').slice(0, 10))) +
          ' · ' + E(n.fin.cbhpm_codigo || '') + ' · previsto R$ ' + F(n.fin.valor_previsto) + '</li>').join('') + '</ul>'
      : '<p style="font-size:.8rem;color:var(--text-mute)">—</p>');
    if (res.jaAplicado.length) corpo += '<p style="font-size:.8rem;color:var(--text-mute);margin-top:10px">' + res.jaAplicado.length + ' lançamento(s) já tinham sido conciliados com este extrato — ficam como estão.</p>';
    if (ext.glosas && ext.glosas.length) corpo += cab('🚫 Glosas informadas no extrato', ext.glosas.length, '#a33') +
      '<ul style="font-size:.8rem;margin:0;padding-left:18px">' + ext.glosas.map(g => '<li>' + E(g.paciente) + ' · ' + E(utils.formatarData(g.data)) + ' · ' + E(g.motivo) + (g.situacao ? ' (' + E(g.situacao) + ')' : '') + '</li>').join('') + '</ul>';
    corpo += '<label style="display:flex;gap:8px;align-items:flex-start;margin-top:14px;font-size:.84rem"><input type="checkbox" id="extrato-aprender" checked> ' +
      '<span><b>Aprender os valores pagos</b> (por convênio e código, no valor cheio) e usá-los no Gerar financeiro onde o convênio ainda não tem valor próprio para o código.</span></label>';
    modal.open('📑 Conciliação — ' + ext.fonte, corpo,
      '<button class="btn" onclick="modal.close()">Cancelar</button>' +
      '<button class="btn" onclick="extratoConc.abrirValores()">📈 Valores pagos</button>' +
      '<button class="btn btn-primary" onclick="extratoConc.aplicar()">✅ Aplicar</button>');
  },
  aplicar() {
    const ext = extratoConc._ext, res = extratoConc._res;
    if (!ext || !res) { modal.close(); return; }
    const data = (document.getElementById('extrato-data') || {}).value || utils.hojeISO();
    const chave = extratoConc._chaveConc(ext);
    const marcados = g => Array.from(document.querySelectorAll('.extrato-aplicar[data-g="' + g + '"]:checked')).map(x => res[g][Number(x.dataset.i)]).filter(Boolean);
    const aprender = !!(document.getElementById('extrato-aprender') || {}).checked;
    const lancar = Array.from(document.querySelectorAll('.extrato-lancar:checked')).map(x => res.semLancamento[Number(x.dataset.i)]).filter(Boolean);
    let atualizados = 0, criados = 0;
    marcados('confere').concat(marcados('diferenca')).forEach(it => {
      const f = store.getById('financeiro', it.fin._id);
      if (!f || (f._conciliacoes || []).some(c => c.chave === chave)) return;
      const recebido = Math.round(((Number(f.valor_recebido) || 0) + it.pago) * 100) / 100;
      f.valor_recebido = recebido; f.valor_pago = recebido;
      f.data_pagamento = data; f.data_recebimento = data;
      if (it.glosa > 0) f.glosa = Math.round(((Number(f.glosa) || 0) + it.glosa) * 100) / 100;
      const prev = Number(f.valor_previsto) || 0;
      f.status = (!prev || recebido >= prev - 0.05) ? 'recebido' : 'parcial';
      try { f.pago = financeiro.ehQuitado(f.status); } catch (e) { f.pago = f.status === 'recebido'; }
      f._conciliacoes = (f._conciliacoes || []).concat([{ chave, fonte: ext.fonte, competencia: ext.competencia, refs: it.linhas.map(l => l.ref),
        valor: it.pago, glosa: it.glosa, data, em: new Date().toISOString(), arquivo: ext.arquivo || '' }]);
      f.observacoes = [f.observacoes, 'Conciliado pelo extrato ' + ext.fonte + ' ' + (ext.competencia || '') + ': R$ ' + extratoConc._fmt(it.pago) +
        (Math.abs(it.dif) > 0.05 ? ' (previsto R$ ' + extratoConc._fmt(prev) + ')' : '')].filter(Boolean).join(' · ');
      const salvo = store.save('financeiro', f);
      try { store.notificarNuvem(salvo, 'Conciliação ' + ext.fonte, { silencioso: true }); } catch (e) {}
      atualizados++;
    });
    lancar.forEach(s => {
      const l = s.linha;
      const novo = {
        paciente: l.paciente.toLowerCase().replace(/(^|\s)\S/g, c => c.toUpperCase()), data_proc: l.data, convenio: l.convenio,
        tipo_pagamento: 'Convênio', tipo_atendimento: /consulta/i.test(l.tipo || '') || l.codigo === '10101012' ? 'consulta_geral' : 'procedimento',
        procedimento: l.descricao, cbhpm_codigo: l.codigo, cbhpm_descricao: l.descricao, hospital: l.hospital || '',
        codigos: [{ codigo: l.codigo, descricao: l.descricao, qtd: 1, unit: l.valorCheio, previsto: l.pago }],
        valor_previsto: l.pago, valor_recebido: l.pago, valor_pago: l.pago, data_pagamento: data, data_recebimento: data,
        status: 'recebido', pago: true, _origemTipo: 'extrato',
        _conciliacoes: [{ chave, fonte: ext.fonte, competencia: ext.competencia, refs: [l.ref], valor: l.pago, glosa: 0, data, em: new Date().toISOString(), arquivo: ext.arquivo || '' }],
        observacoes: 'Lançado pela conciliação do extrato ' + ext.fonte + ' ' + (ext.competencia || '') + ' — ' + l.ref
      };
      const salvo = store.save('financeiro', novo);
      try { store.notificarNuvem(salvo, 'Lançamento do extrato ' + ext.fonte, { silencioso: true }); } catch (e) {}
      criados++;
    });
    let aprendidos = 0, usados = 0;
    if (aprender) { aprendidos = extratoConc.aprender(ext); usados = extratoConc.usarNosVazios(); }
    modal.close();
    try { if (state.currentModule === 'financeiro') financeiro.render(); } catch (e) {}
    toast('✅ Conciliação ' + ext.fonte + ': ' + atualizados + ' recebido(s), ' + criados + ' lançado(s)' +
      (aprender ? ' · ' + aprendidos + ' valor(es) aprendido(s), ' + usados + ' novo(s) no Gerar financeiro' : ''), 'success');
    extratoConc._ext = null; extratoConc._res = null;
    return { atualizados, criados, aprendidos, usados };
  },

  /* tabela: código × porte cirúrgico × porte anestésico × valor pago */
  abrirValores() {
    const E = utils.escapeHTML, F = extratoConc._fmt;
    const t = extratoConc.tabela();
    if (!t.length) {
      modal.open('📈 Valores pagos aprendidos', '<p style="font-size:.86rem">Ainda não há valores aprendidos. Concilie um extrato (📑 Conciliar extrato) para o Soft aprender quanto cada convênio paga por código.</p>',
        '<button class="btn" onclick="modal.close()">Fechar</button>');
      return;
    }
    /* correlação porte anestésico → valor, por convênio */
    const porPorte = {};
    t.forEach(l => { if (!l.porteAn || !(l.valor > 0)) return; const k = l.convNome + '|' + l.porteAn; (porPorte[k] = porPorte[k] || []).push(l.valor); });
    const resumo = Object.keys(porPorte).sort().map(k => { const [c, p] = k.split('|'); return '<li>' + E(c) + ' · porte anestésico ' + E(p) + ': R$ ' + F(extratoConc._mediana(porPorte[k])) + ' <small>(' + porPorte[k].length + ' código(s))</small></li>'; }).join('');
    const corpo = '<p style="font-size:.82rem;line-height:1.6;margin:0 0 8px">Valor <b>cheio</b> (via única / 100%) que cada convênio pagou por código, aprendido dos extratos conciliados. ' +
      '"Usar" passa o valor para o <b>valor do convênio para o código</b>, que o Gerar financeiro usa primeiro.</p>' +
      (resumo ? '<details style="margin-bottom:8px"><summary style="font-size:.84rem;cursor:pointer">Porte anestésico × valor pago</summary><ul style="font-size:.8rem">' + resumo + '</ul></details>' : '') +
      '<div style="overflow-x:auto"><table class="fase4-tab" style="width:100%;font-size:.78rem"><thead><tr><th>Convênio</th><th>Código</th><th>Procedimento</th><th>Porte cir.</th><th>Porte anest.</th>' +
      '<th>Pago (cheio)</th><th>Obs.</th><th>No Soft hoje</th><th></th></tr></thead><tbody>' +
      t.map(l => '<tr><td>' + E(l.convNome) + '</td><td>' + E(l.codigo) + '</td><td>' + E(String(l.descricao).slice(0, 48)) + '</td><td>' + E(l.porteCir || '—') + '</td><td>' + E(l.porteAn || '—') +
        '</td><td><b>R$ ' + F(l.valor) + '</b>' + (l.n > 1 && l.max - l.min > 0.05 ? '<br><small>R$ ' + F(l.min) + ' – ' + F(l.max) + '</small>' : '') + '</td><td>' + l.n + (l.ultima ? '<br><small>' + E(l.ultima) + '</small>' : '') +
        '</td><td>' + (l.noSoft != null ? 'R$ ' + F(l.noSoft) + '<br><small>' + E(l.origemSoft) + '</small>' : '—') + '</td><td>' +
        (l.noSoft != null && Math.abs(l.noSoft - l.valor) <= 0.05 ? '✓' : '<button class="btn btn-xs" onclick="extratoConc.usarValor(' + utils.jsArg(l.conv) + ',' + utils.jsArg(l.codigo) + ')">Usar</button>') +
        '</td></tr>').join('') + '</tbody></table></div>';
    modal.open('📈 Valores pagos aprendidos', corpo, '<button class="btn" onclick="modal.close()">Fechar</button>');
  }
};
window.extratoConc = extratoConc;
