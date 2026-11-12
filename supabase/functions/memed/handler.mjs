// ============================================================================
// Soft Anestesia — Edge Function da MEMED (prescrição digital)
// ----------------------------------------------------------------------------
// POR QUE ISTO EXISTE
// A Memed entrega ao parceiro um par de chaves (api-key + secret-key) e exige
// que ele fique SÓ no servidor: com ele se cadastra e se consulta qualquer
// prescritor do parceiro. O app do Soft é estático — o que estiver nele, quem
// abrir o código lê. Por isso o par mora aqui, e o app só recebe o token do
// PRÓPRIO médico logado, que serve para abrir a janela de prescrição dele.
//
// O prescritor na Memed é identificado por `soft-<id da conta>`: quem pede o
// token é sempre a conta do token de sessão, nunca um id vindo do corpo — um
// médico não consegue abrir a prescrição em nome de outro.
//
// Rotas (via ?op=):
//   GET  ?op=health              → configurada? homologação ou produção?
//   POST ?op=token { prescritor? } → token do médico logado (cadastra na
//                                    primeira vez com os dados enviados)
//
// Segredos (painel do Supabase → Edge Functions → Secrets):
//   MEMED_API_KEY, MEMED_SECRET_KEY
//   MEMED_API_URL     (padrão: homologação https://integrations.api.memed.com.br/v1)
//   MEMED_SCRIPT_URL  (padrão: script de homologação)
// Sem dependências: o comportamento publicado é testável em Node.
// ============================================================================

const HOMOLOG_API = 'https://integrations.api.memed.com.br/v1';
const HOMOLOG_SCRIPT = 'https://integrations.memed.com.br/modulos/plataforma.sinapse-prescricao/build/sinapse-prescricao.min.js';
/* Anestesiologia na tabela de especialidades da Memed (GET /especialidades) */
const ESPECIALIDADE_ANESTESIOLOGIA = 3;
const UFS = new Set(['AC','AL','AM','AP','BA','CE','DF','ES','GO','MA','MG','MS','MT','PA','PB','PE','PI','PR','RJ','RN','RO','RR','RS','SC','SE','SP','TO']);
const CONSELHOS = new Set(['CRM']);

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });
const digitos = (v) => String(v == null ? '' : v).replace(/\D+/g, '');
const texto = (v, max = 255) => String(v == null ? '' : v).trim().slice(0, max);

/* Dados mínimos que a Memed exige para cadastrar o prescritor. Valida aqui
   para devolver uma frase útil, em vez do erro cru da API. */
export function validarPrescritor(p) {
  p = p || {};
  const nome = texto(p.nome), sobrenome = texto(p.sobrenome);
  const cpf = digitos(p.cpf), numero = digitos(p.crm);
  const uf = texto(p.uf, 2).toUpperCase();
  const conselho = texto(p.conselho || 'CRM', 5).toUpperCase();
  const nasc = texto(p.data_nascimento, 10);
  const faltam = [];
  if (!nome) faltam.push('nome');
  if (!sobrenome) faltam.push('sobrenome');
  if (cpf.length !== 11) faltam.push('CPF');
  if (!numero) faltam.push('número do CRM');
  if (!UFS.has(uf)) faltam.push('UF do CRM');
  if (!CONSELHOS.has(conselho)) faltam.push('conselho (CRM)');
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(nasc)) faltam.push('data de nascimento (dd/mm/aaaa)');
  if (faltam.length) return { erro: 'Para cadastrar você na Memed faltam: ' + faltam.join(', ') + '.' };
  const atributos = { nome, sobrenome, cpf, board: { board_code: conselho, board_number: numero, board_state: uf }, data_nascimento: nasc };
  const email = texto(p.email); if (email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) atributos.email = email;
  const tel = digitos(p.telefone); if (tel.length >= 10 && tel.length <= 13) atributos.telefone = tel;
  const sexo = texto(p.sexo, 1).toUpperCase(); if (sexo === 'M' || sexo === 'F') atributos.sexo = sexo;
  return { atributos };
}

export function createMemedHandler({ env, fetchImpl, getUser }) {
  const cfg = () => {
    const apiUrl = (env('MEMED_API_URL') || HOMOLOG_API).replace(/\/$/, '');
    return {
      apiKey: env('MEMED_API_KEY') || '',
      secretKey: env('MEMED_SECRET_KEY') || '',
      apiUrl,
      scriptUrl: env('MEMED_SCRIPT_URL') || HOMOLOG_SCRIPT,
      ambiente: /\/\/integrations\./.test(apiUrl) ? 'homologacao' : 'producao',
    };
  };
  const chaves = (c) => 'api-key=' + encodeURIComponent(c.apiKey) + '&secret-key=' + encodeURIComponent(c.secretKey);
  const memed = async (c, method, path, body) => {
    const r = await fetchImpl(c.apiUrl + path + (path.includes('?') ? '&' : '?') + chaves(c), {
      method,
      headers: { Accept: 'application/vnd.api+json', 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    let dados = null;
    try { dados = await r.json(); } catch (_) { dados = null; }
    return { status: r.status, dados };
  };
  const detalhe = (dados) => {
    const e = dados && Array.isArray(dados.errors) && dados.errors[0];
    return e ? texto(e.detail || e.title, 400) : '';
  };
  const tokenDe = (dados) => dados && dados.data && dados.data.attributes && dados.data.attributes.token;

  return async function handler(req) {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: HEADERS });
    const url = new URL(req.url);
    const op = url.searchParams.get('op') || 'health';
    const c = cfg();

    if (op === 'health') {
      return json({ ok: true, funcao: 'memed', configurada: !!(c.apiKey && c.secretKey), ambiente: c.ambiente });
    }

    if (op === 'token') {
      if (req.method !== 'POST') return json({ ok: false, erro: 'Use POST.' }, 405);
      if (!c.apiKey || !c.secretKey) return json({ ok: false, erro: 'A integração com a Memed ainda não foi configurada no servidor.' }, 503);
      const jwt = String(req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
      if (!jwt) return json({ ok: false, erro: 'Entre na nuvem antes de prescrever pela Memed.' }, 401);
      let usuario = null;
      try { usuario = await getUser(jwt); } catch (_) { usuario = null; }
      if (!usuario || !usuario.id) return json({ ok: false, erro: 'Sessão inválida ou vencida.' }, 401);
      const externo = 'soft-' + String(usuario.id);

      let corpo = {};
      try { corpo = await req.json(); } catch (_) { corpo = {}; }

      try {
        /* já cadastrado? o token muda com o tempo: sempre o mais recente */
        const atual = await memed(c, 'GET', '/sinapse-prescricao/usuarios/' + encodeURIComponent(externo));
        if (atual.status === 200 && tokenDe(atual.dados)) {
          return json({ ok: true, token: tokenDe(atual.dados), script_url: c.scriptUrl, ambiente: c.ambiente });
        }
        if (atual.status !== 404) {
          return json({ ok: false, erro: 'A Memed não respondeu como esperado: ' + (detalhe(atual.dados) || 'HTTP ' + atual.status) }, 502);
        }
        /* primeira vez: cadastra com os dados do próprio médico */
        const v = validarPrescritor(corpo && corpo.prescritor);
        if (v.erro) return json({ ok: false, precisaCadastro: true, erro: v.erro }, 400);
        const novo = await memed(c, 'POST', '/sinapse-prescricao/usuarios', {
          data: {
            type: 'usuarios',
            attributes: Object.assign({ external_id: externo }, v.atributos),
            relationships: { especialidade: { data: { type: 'especialidades', id: ESPECIALIDADE_ANESTESIOLOGIA } } },
          },
        });
        if ((novo.status === 200 || novo.status === 201) && tokenDe(novo.dados)) {
          return json({ ok: true, token: tokenDe(novo.dados), script_url: c.scriptUrl, ambiente: c.ambiente, cadastrado: true });
        }
        return json({ ok: false, precisaCadastro: true, erro: 'A Memed recusou o cadastro: ' + (detalhe(novo.dados) || 'HTTP ' + novo.status) }, 400);
      } catch (_) {
        return json({ ok: false, erro: 'Não consegui falar com a Memed agora. Tente de novo em instantes.' }, 502);
      }
    }

    return json({ ok: false, erro: 'Operação desconhecida.' }, 400);
  };
}
