'use strict';

/* Preferências de apresentação por aparelho. Não contêm dados clínicos e
   não participam de autenticação, autorização, persistência ou Realtime. */
/* ============================================================================
   AJUSTES — GRUPOS DO SISTEMA (tela prática)
   Os 12 cards técnicos de Ajustes viram 3 seções recolhíveis. Os cards não
   mudam por dentro — só são MOVIDOS (via DOM) para dentro do grupo certo.
   Fechados por padrão; a escolha de abrir/fechar é lembrada por aparelho.
============================================================================ */
/* ============================================================================
   AÇÕES DA FICHA — topo recolhível + Salvar/Finalizar no pé da página
   O topo somava abas de rascunho, uma barra com dez botões e o bloco
   "Reaproveitar": três faixas antes de chegar no primeiro campo, e num celular
   isso é meia tela. Aqui tudo isso vira UM cabeçalho recolhível.
   E, como a ficha é longa, Salvar/Finalizar passam a existir também no fim —
   onde a pessoa termina de preencher, sem ter que subir de volta.
============================================================================ */
const acoesUI = {
  KEY: 'medsys.v7.acoes.abertas',
  MODS: ['pre', 'consulta', 'anestesia', 'recuperacao', 'termo', 'prescricao', 'risco', 'documentos'],
  ROT: { pre: 'pré-anestésica', consulta: 'consulta', anestesia: 'ficha', recuperacao: 'SRPA',
         termo: 'termo', prescricao: 'receituário', risco: 'risco', documentos: 'documento' },
  _abertas() { try { return JSON.parse(localStorage.getItem(acoesUI.KEY) || '{}'); } catch (e) { return {}; } },
  aberto(mod) { return !!acoesUI._abertas()[mod]; },
  alternar(mod) {
    const a = acoesUI._abertas();
    a[mod] = !a[mod];
    try { localStorage.setItem(acoesUI.KEY, JSON.stringify(a)); } catch (e) {}
    acoesUI._aplicar(mod);
  },
  montar() {
    acoesUI.MODS.forEach(mod => {
      const modulo = document.getElementById('module-' + mod);
      if (!modulo || document.getElementById('acoes-cab-' + mod)) return;
      const barra = modulo.querySelector(':scope > .action-bar');
      if (!barra) return;
      const tabs = modulo.querySelector(':scope > .rascunho-tabs');
      const cab = document.createElement('div');
      cab.className = 'acoes-cab';
      cab.id = 'acoes-cab-' + mod;
      cab.addEventListener('click', () => acoesUI.alternar(mod));
      const caixa = document.createElement('div');
      caixa.className = 'acoes-caixa';
      caixa.id = 'acoes-caixa-' + mod;
      modulo.insertBefore(cab, tabs || barra);
      modulo.insertBefore(caixa, tabs || barra);
      if (tabs) caixa.appendChild(tabs);
      caixa.appendChild(barra);
      acoesUI._aplicar(mod);
      acoesUI._rodape(mod);
    });
  },
  _aplicar(mod) {
    const cab = document.getElementById('acoes-cab-' + mod);
    const caixa = document.getElementById('acoes-caixa-' + mod);
    if (!cab || !caixa) return;
    const aberto = acoesUI.aberto(mod);
    caixa.style.display = aberto ? '' : 'none';
    cab.classList.toggle('aberto', aberto);
    cab.innerHTML = '<span class="ac-seta">' + (aberto ? '▾' : '▸') + '</span>' +
      '<b>⚙️ Ações da ' + (acoesUI.ROT[mod] || 'ficha') + '</b>' +
      '<small>novo, carregar, imprimir, exportar, modelos</small>';
    /* o bloco "Reaproveitar" segue o mesmo estado — é ação, não preenchimento */
    const tb = document.querySelector('#form-' + mod + ' .form-toolbar');
    if (tb) tb.style.display = aberto ? '' : 'none';
  },
  /* Salvar/Finalizar no fim da página — só onde os dois existem de fato */
  _rodape(mod) {
    const form = document.getElementById('form-' + mod);
    const obj = window[mod];
    if (!form || !obj || typeof obj.salvar !== 'function') return;
    if (document.getElementById('acoes-rodape-' + mod)) return;
    const temFinalizar = typeof obj.finalizar === 'function';
    const div = document.createElement('div');
    div.className = 'acoes-rodape';
    div.id = 'acoes-rodape-' + mod;
    div.innerHTML =
      '<button type="button" class="btn btn-success" onclick="window[' + utils.jsArg(mod) + '].salvar()">💾 Salvar</button>' +
      (temFinalizar ? '<button type="button" class="btn btn-finalizar" onclick="window[' + utils.jsArg(mod) + '].finalizar()">✅ Finalizar</button>' : '') +
      '<button type="button" class="btn btn-ghost btn-sm" onclick="window.scrollTo({top:0,behavior:\'smooth\'})" title="Voltar ao topo">↑ Topo</button>';
    form.appendChild(div);
    try { if (typeof preLanc !== 'undefined') preLanc.renderBotao(mod); } catch (e) {}
  }
};

const ajustesGrupos = {
  KEY: 'medsys.v7.ajustes.sysgrupos',
  GRUPOS: [
    { id: 'nuvem', titulo: '☁️ Nuvem, backup e espaço',
      desc: 'A sincronização acontece sozinha. Aqui: sessão da nuvem, exportação legada, PDFs e fila offline cifrada',
      cards: ['cloud-card', 'backup-completo-card', 'pdf-backup-card', 'armazenamento-card'] },
    { id: 'equipe', titulo: '🔐 Usuários, equipe e permissões',
      desc: 'Quem entra no sistema, o que cada um pode ver e o registro de quem fez o quê',
      cards: ['usuarios-card', 'equipe-nuvem-card', 'auditoria-card'] },
    { id: 'modelos', titulo: '📄 Identidade da clínica, modelos e procedimentos',
      desc: 'Logomarca, nome e contato da clínica no cabeçalho das impressões; termo de consentimento padrão, textos padrão por campo e a sua tabela CBHPM',
      cards: ['clinica-identidade-card', 'termo-padrao-card', 'textos-padrao-card', 'cbhpm-card'] },
    /* CONSERTOS DO PASSADO moram aqui. Eles nasceram para resolver um
       problema específico que já foi corrigido no caminho normal — e passar o
       dia esbarrando numa ferramenta de mutirão é o que faz Ajustes parecer
       maior e mais assustador do que é. Continuam a um clique para quem
       precisar; só deixam de disputar atenção com o uso diário. */
    { id: 'avancado', titulo: '🛠️ Avançado e consertos pontuais', avancado: true,
      desc: 'Diagnóstico da nuvem e mutirões de correção do que ficou para trás. No uso normal você não precisa abrir isto',
      cards: ['clouddiag-card', 'duplicados-card', 'mutirao-card'] }
  ],
  _salvos() { try { return JSON.parse(localStorage.getItem(ajustesGrupos.KEY) || '{}'); } catch (e) { return {}; } },
  _aberto(id) { return !!ajustesGrupos._salvos()[id]; },   /* fechado por padrão */
  alternar(id) {
    const s = ajustesGrupos._salvos();
    s[id] = !ajustesGrupos._aberto(id);
    try { localStorage.setItem(ajustesGrupos.KEY, JSON.stringify(s)); } catch (e) {}
    ajustesGrupos._aplicar();
  },
  montar() {
    const primeiro = document.getElementById('cloud-card');
    if (!primeiro || document.getElementById('ajg-nuvem')) return;
    const container = primeiro.parentElement;
    /* marcador na posição original do 1º card — os grupos entram exatamente ali */
    const marcador = document.createElement('div');
    container.insertBefore(marcador, primeiro);
    const frag = document.createDocumentFragment();
    ajustesGrupos.GRUPOS.forEach(g => {
      const cab = document.createElement('div');
      cab.className = 'ajg-header';
      cab.id = 'ajg-cab-' + g.id;
      cab.addEventListener('click', () => ajustesGrupos.alternar(g.id));
      const wrap = document.createElement('div');
      wrap.id = 'ajg-' + g.id;
      frag.appendChild(cab); frag.appendChild(wrap);
      g.cards.forEach(cid => { const c = document.getElementById(cid); if (c) wrap.appendChild(c); });
    });
    container.insertBefore(frag, marcador);
    marcador.remove();
    ajustesGrupos._aplicar();
  },
  _aplicar() {
    ajustesGrupos.GRUPOS.forEach(g => {
      const cab = document.getElementById('ajg-cab-' + g.id);
      const wrap = document.getElementById('ajg-' + g.id);
      if (!cab || !wrap) return;
      const aberto = ajustesGrupos._aberto(g.id);
      cab.classList.toggle('aberto', aberto);
      cab.classList.toggle('ajg-avancado', !!g.avancado);
      cab.innerHTML = '<span class="cg-seta">' + (aberto ? '▾' : '▸') + '</span>' +
        '<span style="flex:1;min-width:0"><b>' + g.titulo + '</b>' +
        '<small style="display:block;font-weight:400;color:var(--text-mute);white-space:normal;line-height:1.4">' + g.desc + '</small></span>' +
        '<span class="cg-total">' + g.cards.length + '</span>';
      wrap.style.display = aberto ? '' : 'none';
    });
  },
  /* Abre o grupo que contém o card e leva até ele (usado por atalhos do app) */
  abrirPara(cardId) {
    try { ajustesGrupos.montar(); } catch (e) {}
  window.acoesUI = acoesUI;
  try { acoesUI.montar(); } catch (e) {}
    const g = ajustesGrupos.GRUPOS.find(x => x.cards.includes(cardId));
    if (g && !ajustesGrupos._aberto(g.id)) {
      const s = ajustesGrupos._salvos(); s[g.id] = true;
      try { localStorage.setItem(ajustesGrupos.KEY, JSON.stringify(s)); } catch (e) {}
      ajustesGrupos._aplicar();
    }
    const c = document.getElementById(cardId);
    if (c) {
      if (c.classList.contains('collapsed')) { const h = c.querySelector('.card-header'); if (h) try { ui.toggleCard(h); } catch (e) {} }
      try { c.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) {}
    }
    return c;
  }
};

/* FIM DOS CONTROLES VISUAIS DE LAYOUT */
