// Public proof lookup only. It never signs a PDF or validates an ICP chain.
// Keep this handler dependency-free so the deployed behavior is testable.
const CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}(?:-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}){2}$/;
const HASH = /^[0-9a-f]{64}$/;
const FIELDS = ['codigo', 'hash_doc', 'algoritmo', 'versao', 'assinado_em'];
const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: HEADERS });
}

async function boundedText(body, maximum) {
  if (!body) return '';
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new Error('body_limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(result);
}

function serverConfiguration(env) {
  const url = new URL(env('SUPABASE_URL') || '');
  if (url.protocol !== 'https:' || !/^[a-z0-9]{20}\.supabase\.co$/.test(url.hostname)
      || url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('server_configuration');
  }
  let key = '';
  const dictionary = env('SUPABASE_SECRET_KEYS');
  if (dictionary) {
    const keys = JSON.parse(dictionary);
    if (!keys || typeof keys !== 'object' || Array.isArray(keys)) throw new Error('server_configuration');
    if (keys.default !== undefined) {
      if (typeof keys.default !== 'string' || !keys.default.startsWith('sb_secret_')) throw new Error('server_configuration');
      key = keys.default;
    }
  }
  if (!key) key = env('SUPABASE_SERVICE_ROLE_KEY') || '';
  const headers = { apikey: key, Accept: 'application/json' };
  if (!key.startsWith('sb_secret_')) {
    // Legacy server JWTs remain supported. Modern secret keys are NOT JWTs
    // and must never be placed in the Authorization header.
    const claims = JSON.parse(atob(key.split('.')[1].replaceAll('-', '+').replaceAll('_', '/')));
    if (claims.role !== 'service_role') throw new Error('server_configuration');
    headers.Authorization = 'Bearer ' + key;
  }
  return { url, headers };
}

export function createVerificationHandler({ env, fetcher = fetch }) {
  return async function verify(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: HEADERS });
    if (request.method !== 'POST') return json({ erro: 'Use POST para consultar o comprovante.' }, 405);
    // Proof belongs in the body; URLs and referrers must not carry it.
    if (new URL(request.url).search) return json({ erro: 'Informe o comprovante somente no corpo da consulta.' }, 400);
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return json({ erro: 'Envie uma consulta JSON.' }, 415);
    }
    let proof, field;
    try {
      const body = JSON.parse(await boundedText(request.body, 512));
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1) throw new Error();
      if (typeof body.codigo === 'string') {
        field = 'codigo'; proof = body.codigo.trim().toUpperCase();
        if (!CODE.test(proof)) throw new Error();
      } else if (typeof body.hash === 'string') {
        field = 'hash_doc'; proof = body.hash.trim().toLowerCase();
        if (!HASH.test(proof)) throw new Error();
      } else throw new Error();
    } catch {
      return json({ erro: 'Informe um código de validação ou hash SHA-256 válido.' }, 400);
    }
    let configuration;
    try { configuration = serverConfiguration(env); }
    catch { return json({ erro: 'A consulta central está indisponível.' }, 503); }
    try {
      const url = new URL('/rest/v1/assinaturas_publicas', configuration.url);
      url.searchParams.set('select', FIELDS.join(','));
      url.searchParams.set(field, 'eq.' + proof);
      url.searchParams.set('limit', '2');
      const response = await fetcher(url, {
        method: 'GET', headers: configuration.headers,
        redirect: 'error', signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error('lookup_failed');
      const rows = JSON.parse(await boundedText(response.body, 16384));
      if (!Array.isArray(rows)) throw new Error('lookup_failed');
      if (rows.length === 0) return json({ encontrado: false });
      // A digest may appear in more than one record. Do not pick a clinic or
      // disclose a validation code merely from a known/copied PDF digest.
      if (rows.length !== 1) return json({ erro: 'Use o código de validação deste comprovante.' }, 409);
      const row = rows[0];
      if (!row || !CODE.test(row.codigo) || !HASH.test(row.hash_doc)
          || row[field] !== proof || row.algoritmo !== 'SHA-256'
          || !Number.isInteger(row.versao) || row.versao < 1
          || typeof row.assinado_em !== 'string' || !Number.isFinite(Date.parse(row.assinado_em))) {
        throw new Error('lookup_failed');
      }
      return json({
        encontrado: true,
        registro: {
          // Hash-only requests never reveal the separate opaque code.
          codigo: field === 'codigo' ? row.codigo : null,
          hash_doc: row.hash_doc, algoritmo: row.algoritmo,
          versao: row.versao, assinado_em: row.assinado_em,
        },
        escopo: 'registro_e_hash',
        validacao_criptografica: 'nao_verificada_por_esta_consulta',
      });
    } catch {
      // Never return or log database bodies, proof, bearer or secret values.
      return json({ erro: 'Não foi possível consultar o comprovante agora.' }, 503);
    }
  };
}
