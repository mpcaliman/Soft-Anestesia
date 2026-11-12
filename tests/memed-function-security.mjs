// A função `memed` guarda o par de chaves da Memed no servidor. Estes testes
// fixam o contrato: o app nunca recebe as chaves, o prescritor é sempre a
// conta da sessão e a ausência de configuração é dita, não escondida.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMemedHandler, validarPrescritor } from '../supabase/functions/memed/handler.mjs';

const KEY = 'chave-api-de-teste-0000', SECRET = 'segredo-de-teste-1111';
function montar({ env = {}, usuario = { id: 'u-1' }, respostas = [] } = {}) {
  const chamadas = [];
  const fila = respostas.slice();
  const fetchImpl = async (url, init) => {
    chamadas.push({ url, init });
    const r = fila.shift() || { status: 500, body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status });
  };
  const h = createMemedHandler({
    env: k => ({ MEMED_API_KEY: KEY, MEMED_SECRET_KEY: SECRET, ...env })[k] || '',
    fetchImpl,
    getUser: async jwt => (jwt === 'jwt-ok' ? usuario : null),
  });
  return { h, chamadas };
}
const req = (op, { metodo = 'POST', jwt = 'jwt-ok', corpo = {} } = {}) => new Request('https://p.supabase.co/functions/v1/memed?op=' + op, {
  method: metodo, headers: jwt ? { Authorization: 'Bearer ' + jwt } : {}, body: metodo === 'POST' ? JSON.stringify(corpo) : undefined,
});
const prescritor = { nome: 'Ana', sobrenome: 'Teste', cpf: '529.982.247-25', crm: '12345', uf: 'ba', data_nascimento: '01/01/1980' };

let n = 0; const ok = (m) => { n++; console.log('  ✓ ' + m); };

{ const { h } = montar({ env: { MEMED_API_KEY: '', MEMED_SECRET_KEY: '' } });
  const r = await h(req('health', { metodo: 'GET', jwt: '' })); const d = await r.json();
  assert.equal(d.configurada, false); assert.equal(d.ambiente, 'homologacao');
  const t = await h(req('token')); assert.equal(t.status, 503);
  ok('sem chaves: diz que não está configurada e não chama a Memed'); }

{ const { h, chamadas } = montar();
  const r = await h(req('token', { jwt: 'jwt-ruim' })); assert.equal(r.status, 401); assert.equal(chamadas.length, 0);
  const r2 = await h(req('token', { jwt: '' })); assert.equal(r2.status, 401);
  ok('sem sessão válida não há token'); }

{ const { h, chamadas } = montar({ respostas: [{ status: 200, body: { data: { attributes: { token: 'tok-1' } } } }] });
  const r = await h(req('token', { corpo: { external_id: 'outra-pessoa' } })); const d = await r.json();
  assert.equal(d.ok, true); assert.equal(d.token, 'tok-1');
  assert.match(chamadas[0].url, /\/sinapse-prescricao\/usuarios\/soft-u-1\?/);
  assert.doesNotMatch(chamadas[0].url, /outra-pessoa/);
  const texto = JSON.stringify(d); assert.ok(!texto.includes(KEY) && !texto.includes(SECRET));
  ok('o prescritor é a conta da sessão; as chaves nunca voltam ao app'); }

{ const { h, chamadas } = montar({ respostas: [{ status: 404, body: { errors: [{ detail: 'nao achei' }] } }] });
  const r = await h(req('token')); const d = await r.json();
  assert.equal(r.status, 400); assert.equal(d.precisaCadastro, true); assert.match(d.erro, /CPF/); assert.equal(chamadas.length, 1);
  ok('primeira vez sem dados: pede o cadastro, sem tentar cadastrar vazio'); }

{ const { h, chamadas } = montar({ respostas: [{ status: 404, body: {} }, { status: 200, body: { data: { attributes: { token: 'tok-novo' } } } }] });
  const r = await h(req('token', { corpo: { prescritor } })); const d = await r.json();
  assert.equal(d.ok, true); assert.equal(d.cadastrado, true);
  const enviado = JSON.parse(chamadas[1].init.body).data;
  assert.equal(enviado.attributes.external_id, 'soft-u-1');
  assert.equal(enviado.attributes.cpf, '52998224725');
  assert.deepEqual(enviado.attributes.board, { board_code: 'CRM', board_number: '12345', board_state: 'BA' });
  assert.equal(enviado.relationships.especialidade.data.id, 3);
  ok('cadastra o prescritor com CPF/CRM normalizados e especialidade Anestesiologia'); }

{ const { h } = montar({ respostas: [{ status: 404, body: {} }, { status: 400, body: { errors: [{ detail: 'CRM inválido' }] } }] });
  const r = await h(req('token', { corpo: { prescritor } })); const d = await r.json();
  assert.equal(d.ok, false); assert.match(d.erro, /CRM inválido/);
  ok('recusa da Memed chega com o motivo dela'); }

{ assert.ok(validarPrescritor({ ...prescritor, uf: 'XX' }).erro);
  assert.ok(validarPrescritor({ ...prescritor, data_nascimento: '1980-01-01' }).erro);
  assert.ok(!validarPrescritor(prescritor).erro);
  ok('validação do prescritor: UF e data no formato da Memed'); }

{ const { h } = montar({ env: { MEMED_API_URL: 'https://api.memed.com.br/v1' } });
  const d = await (await h(req('health', { metodo: 'GET', jwt: '' }))).json(); assert.equal(d.ambiente, 'producao');
  ok('produção só com a URL de produção configurada'); }

{ const app = await readFile(new URL('../src/integrations/memed.js', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /secret-key|api-key|MEMED_SECRET|MEMED_API_KEY/i);
  assert.match(app, /memed\\\.com\\\.br/);
  ok('o código do app não contém nem pede o par de chaves'); }

console.log(`\n${n}/${n} testes da função Memed passaram.`);
