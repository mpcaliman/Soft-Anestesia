/* ============================================================================
   Soft Anestesia — normalização da base Anvisa/CMED
   ----------------------------------------------------------------------------
   Um só lugar decide como um registro bruto da CMED vira um registro do
   sistema. O importador (que carrega o Supabase) e o gerador do índice local
   (que o navegador usa offline) importam DAQUI — senão as duas cópias da base
   divergem e a busca passa a achar coisas diferentes conforme haja internet.
============================================================================ */

/* Texto para busca: minúsculo, sem acento, sem espaço dobrado.
   O mesmo resultado precisa sair da função med_normalizar() no Postgres. */
export function norm(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* A CMED escreve "-" onde não há dado. Vira vazio. */
export function limpo(s) {
  const v = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return (v === '-' || v === '—') ? '' : v;
}

/* ---------------------------------------------------------------------------
   TIPO DO PRODUTO
   A CMED chama de "Novo" o que o médico chama de REFERÊNCIA — é a marca
   original, a que os genéricos copiam. Traduzir isto é obrigatório: um filtro
   de prescrição chamado "Novo" não quer dizer nada para quem prescreve.
--------------------------------------------------------------------------- */
export const TIPO_MAP = {
  'novo': 'referencia',
  'genérico': 'generico',
  'generico': 'generico',
  'similar': 'similar',
  'biológico': 'biologico',
  'biologico': 'biologico',
  'específico': 'especifico',
  'especifico': 'especifico',
  'fitoterápico': 'fitoterapico',
  'fitoterapico': 'fitoterapico',
  'produto de terapia avançada': 'terapia_avancada',
  'radiofármaco': 'radiofarmaco'
};
export const TIPO_LABEL = {
  referencia: 'Referência', generico: 'Genérico', similar: 'Similar',
  biologico: 'Biológico', especifico: 'Específico', fitoterapico: 'Fitoterápico',
  terapia_avancada: 'Terapia avançada', radiofarmaco: 'Radiofármaco'
};
export function tipoDoProduto(bruto) {
  return TIPO_MAP[norm(bruto)] || '';
}

/* ---------------------------------------------------------------------------
   VIA DE ADMINISTRAÇÃO
   Duas coisas que não podem ser confundidas:
     - via CONHECIDA  → preenche sozinha, o médico não redigita;
     - via NÃO DETERMINADA na CMED ("Injetável — via não especificada") →
       fica em branco e a tela diz "Via a definir". Inventar IV/IM/SC aqui
       seria inventar prescrição.
--------------------------------------------------------------------------- */
export const VIAS = [
  { chave: 'oral',           label: 'Oral',           sigla: 'VO' },
  { chave: 'intravenosa',    label: 'Intravenosa',    sigla: 'IV' },
  { chave: 'intramuscular',  label: 'Intramuscular',  sigla: 'IM' },
  { chave: 'subcutanea',     label: 'Subcutânea',     sigla: 'SC' },
  { chave: 'sublingual',     label: 'Sublingual',     sigla: 'SL' },
  { chave: 'inalatoria',     label: 'Inalatória',     sigla: 'INAL' },
  { chave: 'nasal',          label: 'Nasal',          sigla: 'NAS' },
  { chave: 'retal',          label: 'Retal',          sigla: 'VR' },
  { chave: 'vaginal',        label: 'Vaginal',        sigla: 'VV' },
  { chave: 'topica',         label: 'Tópica/Cutânea', sigla: 'TOP' },
  { chave: 'transdermica',   label: 'Transdérmica',   sigla: 'TD' },
  { chave: 'oftalmica',      label: 'Oftálmica',      sigla: 'OFT' },
  { chave: 'otologica',      label: 'Otológica',      sigla: 'OTO' },
  { chave: 'oromucosal',     label: 'Oromucosal/Bucal', sigla: 'BUC' },
  { chave: 'intradermica',   label: 'Intradérmica',   sigla: 'ID' },
  { chave: 'intratecal',     label: 'Intratecal',     sigla: 'IT' },
  { chave: 'epidural',       label: 'Epidural',       sigla: 'PERI' },
  { chave: 'perineural',     label: 'Perineural',     sigla: 'PN' },
  { chave: 'outras',         label: 'Outras',         sigla: '' }
];
const VIA_POR_TEXTO = {
  'oral': 'oral',
  'intravenosa': 'intravenosa',
  'intramuscular': 'intramuscular',
  'subcutanea': 'subcutanea',
  'sublingual': 'sublingual',
  'inalatoria': 'inalatoria',
  'nasal': 'nasal',
  'retal': 'retal',
  'vaginal': 'vaginal',
  'topica/cutanea': 'topica',
  'transdermica': 'transdermica',
  'oftalmica': 'oftalmica',
  'otologica': 'otologica',
  'oromucosal/bucal': 'oromucosal'
};

/* Retorna { vias: [chave...], definida: bool, rotulo: 'Oral' | 'IV / IM' | '' }
   A CMED às vezes traz mais de uma via na mesma apresentação ("Intravenosa /
   Intramuscular"): todas são guardadas, e a tela deixa o médico escolher. */
export function viaDaApresentacao(bruto) {
  const n = norm(bruto);
  if (!n || n === 'nao identificada') return { vias: [], definida: false, rotulo: '' };
  if (n.startsWith('injetavel')) {
    /* "Injetável – via não especificada na apresentação CMED": sabe-se que é
       injetável e MAIS NADA. Não vira IV. */
    return { vias: [], definida: false, rotulo: '', injetavel: true };
  }
  const partes = String(bruto).split('/').map(p => norm(p)).filter(Boolean);
  const chaves = [];
  /* "Tópica/Cutânea" é uma via só cujo nome tem barra — tratada antes de partir */
  if (VIA_POR_TEXTO[n]) chaves.push(VIA_POR_TEXTO[n]);
  else {
    for (const p of partes) {
      const k = VIA_POR_TEXTO[p] || VIA_POR_TEXTO[p.replace(/\s/g, '')];
      if (k && chaves.indexOf(k) < 0) chaves.push(k);
    }
  }
  if (!chaves.length) return { vias: [], definida: false, rotulo: '' };
  const rot = chaves.map(k => (VIAS.find(v => v.chave === k) || {}).label).filter(Boolean).join(' / ');
  return { vias: chaves, definida: true, rotulo: rot };
}

export function siglaDaVia(chave) {
  const v = VIAS.find(x => x.chave === chave);
  return v ? v.sigla : '';
}
export function labelDaVia(chave) {
  const v = VIAS.find(x => x.chave === chave);
  return v ? v.label : '';
}

/* ---------------------------------------------------------------------------
   PRINCÍPIO ATIVO — forma canônica
   "PANTOZOL" tem princípio "PANTOPRAZOL SÓDICO SESQUIHIDRATADO"; o genérico
   tem "PANTOPRAZOL SÓDICO"; e existe ainda "PANTOPRAZOL" puro. São o mesmo
   fármaco. Sem reduzir sal e hidrato a uma raiz comum, pedir "as apresentações
   deste princípio ativo" devolveria três listas separadas — e uma regra
   clínica de pantoprazol precisaria ser cadastrada três vezes.
--------------------------------------------------------------------------- */
const SAIS_PREFIXO = [
  'cloridrato', 'dicloridrato', 'sulfato', 'besilato', 'maleato', 'fumarato',
  'hemifumarato', 'tartarato', 'mesilato', 'acetato', 'succinato', 'citrato',
  'bromidrato', 'nitrato', 'fosfato', 'lactato', 'pamoato', 'valerato',
  'propionato', 'dipropionato', 'furoato', 'benzoato', 'oxalato', 'gluconato',
  'carbonato', 'cipionato', 'enantato', 'decanoato', 'pivalato', 'tosilato',
  'xinafoato', 'embonato', 'estearato', 'palmitato', 'salicilato', 'malato',
  'aspartato', 'glutamato', 'hidrogenotartarato', 'bitartarato'
];
const SAIS_SUFIXO = [
  'sodico', 'sodica', 'potassico', 'potassica', 'calcico', 'calcica',
  'magnesico', 'magnesica', 'sesquihidratado', 'sesqui-hidratado',
  'monoidratado', 'monohidratado', 'diidratado', 'dihidratado',
  'triidratado', 'trihidratado', 'anidro', 'anidra', 'hidratado', 'hidratada'
];

/* Reduz UM princípio a sua raiz. Não é química: é o suficiente para agrupar
   marca, genérico e similar do mesmo fármaco na mesma lista. */
export function raizDoPrincipio(p) {
  let n = norm(p);
  if (!n) return '';
  const pre = new RegExp('^(?:' + SAIS_PREFIXO.join('|') + ')\\s+de\\s+');
  let antes;
  do { antes = n; n = n.replace(pre, ''); } while (n !== antes);
  const suf = new RegExp('\\s+(?:' + SAIS_SUFIXO.join('|') + ')$');
  do { antes = n; n = n.replace(suf, ''); } while (n !== antes);
  return n.trim();
}

/* Uma apresentação pode ter vários princípios (associações, separados por ";").
   A raiz do conjunto preserva a ordem e junta com "+". */
export function raizDoConjunto(principios) {
  return String(principios || '').split(';')
    .map(p => raizDoPrincipio(p)).filter(Boolean).join(' + ');
}

/* Rótulo legível do princípio ativo (mantém acento, tira o excesso de caixa
   alta da CMED só onde ela atrapalha a leitura na lista). */
export function principioLegivel(p) {
  return String(p || '').split(';').map(x => limpo(x)).filter(Boolean).join(' + ');
}

/* ---------------------------------------------------------------------------
   COLUNAS ESPERADAS NO ARQUIVO DA CMED
   Se a Anvisa mudar o cabeçalho, o importador PARA e diz qual coluna sumiu —
   em vez de importar 26 mil registros com o campo errado.
--------------------------------------------------------------------------- */
export const COLUNAS = {
  id: 'ID apresentação',
  tipoEntrada: 'Tipo de entrada',
  nomeComercial: 'Nome do produto / nome comercial',
  principio: 'Princípio ativo / substância',
  concentracao: 'Concentração',
  forma: 'Forma farmacêutica',
  via: 'Via de administração',
  origemVia: 'Origem da via',
  apresentacaoCmed: 'Apresentação CMED completa',
  laboratorio: 'Laboratório',
  tipoProduto: 'Tipo de produto',
  registro: 'Registro Anvisa',
  ggrem: 'Código GGREM',
  ean1: 'EAN 1', ean2: 'EAN 2', ean3: 'EAN 3',
  classe: 'Classe terapêutica',
  regime: 'Regime de preço',
  comercializacao: 'Comercialização 2025',
  fonte: 'Fonte oficial'
};

/* Converte uma linha bruta da CMED no registro do sistema. */
export function registroDeLinha(linha) {
  const C = COLUNAS;
  const nomeComercial = limpo(linha[C.nomeComercial]);
  const principio = principioLegivel(linha[C.principio]);
  const tipoEntrada = norm(linha[C.tipoEntrada]);
  const via = viaDaApresentacao(linha[C.via]);
  const tipo = tipoDoProduto(linha[C.tipoProduto]);
  /* No genérico a CMED repete o princípio ativo no lugar do nome comercial —
     é isso que ele é. Guardar como nome_generico deixa a busca por nome
     genérico funcionar sem inventar dado. */
  const ehGenerico = (tipoEntrada === 'generico' || tipo === 'generico');
  return {
    id_apresentacao: limpo(linha[C.id]),
    nome_comercial: nomeComercial,
    nome_generico: ehGenerico ? nomeComercial : '',
    principio_ativo: principio,
    principio_base: raizDoConjunto(linha[C.principio]),
    concentracao: limpo(linha[C.concentracao]),
    forma_farmaceutica: limpo(linha[C.forma]),
    via_administracao: via.rotulo,
    vias: via.vias,
    via_definida: via.definida,
    injetavel_sem_via: !!via.injetavel,
    origem_via: limpo(linha[C.origemVia]),
    apresentacao_original_anvisa: limpo(linha[C.apresentacaoCmed]),
    laboratorio: limpo(linha[C.laboratorio]),
    tipo_medicamento: tipo,
    tipo_entrada: limpo(linha[C.tipoEntrada]),
    registro_anvisa: limpo(linha[C.registro]),
    ggrem: limpo(linha[C.ggrem]),
    ean: limpo(linha[C.ean1]),
    ean2: limpo(linha[C.ean2]),
    ean3: limpo(linha[C.ean3]),
    classe_terapeutica: limpo(linha[C.classe]),
    regime_preco: limpo(linha[C.regime]),
    comercializado: norm(linha[C.comercializacao]) === 'sim',
    fonte: limpo(linha[C.fonte])
  };
}

/* Chave do AGRUPAMENTO CLÍNICO (§24): o que o médico vê como "um item".
   Embalagem, quantidade de comprimidos e EAN não entram — são a mesma coisa
   para quem prescreve, e repeti-las enche a lista de linhas idênticas. */
export function chaveClinica(r) {
  return [norm(r.nome_comercial), norm(r.principio_ativo), norm(r.concentracao),
          norm(r.forma_farmaceutica), norm(r.via_administracao), r.tipo_medicamento].join('|');
}

/* Rótulo da sugestão: Nome — Princípio — Concentração — Forma — Via */
export function rotuloSugestao(r) {
  return [r.nome_comercial, r.principio_ativo, r.concentracao, r.forma_farmaceutica,
          r.via_administracao || 'Via a definir'].filter(Boolean).join(' — ');
}
