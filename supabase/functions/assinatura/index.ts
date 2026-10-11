// ============================================================================
// Soft Anestesia — Edge Function de assinatura digital ICP-Brasil (Opção B)
// ----------------------------------------------------------------------------
// Objetivo: guardar o SEGREDO do provedor (client_secret OAuth) fora do app
// estático e orquestrar a assinatura em nuvem (SafeID/Certillion) e a validação
// pública. O app NUNCA vê PIN/senha/segredo.
//
// Padrão adotado: Cloud Signature Consortium (CSC) API v1 — é o que o gov.br
// (ITI), a Certillion (usada pelo Portal CFM) e provedores BR expõem. Os pontos
// marcados com  >>> AJUSTAR CONFORME O PROVEDOR <<<  dependem da documentação de
// API do SafeID/Certillion (endpoints e formato exatos), que deve ser fornecida.
//
// Rotas (via ?op=):
//   GET  ?op=health                         → sanity check + provedor configurado?
//   POST ?op=cert-list   { access_token }   → lista certificados do usuário (CSC credentials/list)
//   POST ?op=cert-info   { access_token, credentialID }
//   POST ?op=sign        { access_token, credentialID, sad, pdf_base64, meta }
//                                           → assina (PAdES) e grava o registro imutável
//   GET  ?op=validar&codigo=... | &hash=... → validação pública (view assinaturas_publicas)
//
// Deploy:
//   supabase functions deploy assinatura --no-verify-jwt
//   supabase secrets set CSC_BASE_URL=... CSC_CLIENT_ID=... CSC_CLIENT_SECRET=... \
//                        CSC_SCOPE=... SIGN_PROVIDER=safeid
// (SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY já existem no ambiente da função.)
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const env = (k: string) => Deno.env.get(k) ?? "";
const PROVIDER = env("SIGN_PROVIDER") || "safeid_safeweb";
const CSC_BASE = env("CSC_BASE_URL");           // API de assinatura remota da Safeweb/SafeID (>>> host real conforme doc <<<)
const CSC_ID = env("CSC_CLIENT_ID");
const CSC_SECRET = env("CSC_CLIENT_SECRET");
const CSC_SCOPE = env("CSC_SCOPE") || "service";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });
}
function sb() {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/^data:.*;base64,/, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function isPdf(bytes: Uint8Array): boolean {
  if (bytes.length < 5) return false;
  const head = new TextDecoder("ascii").decode(bytes.subarray(0, Math.min(1024, bytes.length)));
  return head.includes("%PDF-");
}
function configurado() { return !!(CSC_BASE && CSC_ID && CSC_SECRET); }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODIGO_RE = /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const MODULOS = new Set([
  "pre", "consulta", "anestesia", "recuperacao", "risco", "termo",
  "prescricao", "documentos", "financeiro", "orcamento",
]);

/* `--no-verify-jwt` é necessário porque `validar` é público. Todas as rotas
   que falam com o provedor ou escrevem usam esta verificação explícita e
   consultam o vínculo ativo no banco; nenhum papel vem de user_metadata. */
async function exigirClinico(req: Request, requestedOrg = "") {
  const authHeader = req.headers.get("Authorization") || "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return { erro: "Entre na nuvem antes de assinar.", status: 401 };

  const client = sb();
  const { data, error } = await client.auth.getUser(jwt);
  if (error || !data?.user) return { erro: "Sessão inválida ou vencida.", status: 401 };

  let q = client
    .from("organization_users")
    .select("organization_id,role")
    .eq("user_id", data.user.id)
    .eq("ativo", true)
    .in("role", ["gestor", "anestesiologista"]);
  if (requestedOrg) q = q.eq("organization_id", requestedOrg);
  const { data: memberships, error: membershipError } = await q.limit(1);
  if (membershipError) return { erro: "Não foi possível confirmar a autorização.", status: 500 };
  if (!memberships?.length) {
    return { erro: "A assinatura em nuvem exige vínculo clínico ativo.", status: 403 };
  }
  return {
    client,
    user: data.user,
    organizationId: memberships[0].organization_id as string,
  };
}

// --- token de serviço do provedor (client_credentials). Se o provedor usar
//     authorization_code + PKCE (usuário autoriza no app do certificado), este
//     access_token virá do app cliente e é repassado. >>> AJUSTAR <<< ---------
async function providerToken(): Promise<string> {
  const r = await fetch(`${CSC_BASE}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CSC_ID,
      client_secret: CSC_SECRET,
      scope: CSC_SCOPE,
    }),
  });
  if (!r.ok) throw new Error(`oauth2/token ${r.status}: ${await r.text()}`);
  return (await r.json()).access_token;
}

// --- CSC credentials/list ---------------------------------------------------
async function cscCredentialsList(accessToken: string) {
  const r = await fetch(`${CSC_BASE}/credentials/list`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ maxResults: 20 }),
  });
  if (!r.ok) throw new Error(`credentials/list ${r.status}: ${await r.text()}`);
  return await r.json(); // { credentialIDs: [...] }
}
async function cscCredentialInfo(accessToken: string, credentialID: string) {
  const r = await fetch(`${CSC_BASE}/credentials/info`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ credentialID, certificates: "chain", certInfo: true }),
  });
  if (!r.ok) throw new Error(`credentials/info ${r.status}: ${await r.text()}`);
  return await r.json(); // { cert: { subjectDN, issuerDN, serialNumber, validFrom, validTo }, ... }
}

// --- Assinatura PAdES -------------------------------------------------------
// Duas estratégias, conforme a API do provedor:
//  (A) DOCUMENTO: envia o PDF e recebe o PDF assinado (Certillion normalmente
//      oferece isso). Mais simples — sem embutir PAdES aqui.
//  (B) HASH (CSC signHash): calcula o digest PAdES, envia o hash, recebe a
//      assinatura e embute no PDF (exige lib PAdES em Deno).
// >>> AJUSTAR conforme a doc do SafeID/Certillion. Abaixo, a variante (A). <<<
async function providerSignPdf(accessToken: string, credentialID: string, sad: string, pdfBytes: Uint8Array): Promise<Uint8Array> {
  const r = await fetch(`${CSC_BASE}/signatures/signDoc`, { // >>> endpoint conforme provedor <<<
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      credentialID,
      SAD: sad,                         // signature activation data (OTP/push aprovado pelo usuário)
      signAlgo: "2.16.840.1.101.3.4.2.1", // SHA-256
      signature_format: "P",           // PAdES
      conformance_level: "AdES-B-LT",
      documents: [{ document: base64(pdfBytes), signature_format: "P" }],
    }),
  });
  if (!r.ok) throw new Error(`signatures/signDoc ${r.status}: ${await r.text()}`);
  const out = await r.json();          // { DocumentWithSignature: [ "<base64 pdf>" ] }
  const signedB64 = out.DocumentWithSignature?.[0] ?? out.signedDocument ?? "";
  if (!signedB64) throw new Error("Resposta do provedor sem PDF assinado (ajustar mapeamento).");
  return b64ToBytes(signedB64);
}
function base64(bytes: Uint8Array): string {
  let s = ""; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

// código de validação legível
function codigoValidacao(): string {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const buf = crypto.getRandomValues(new Uint8Array(12));
  let s = ""; for (let i = 0; i < 12; i++) { s += abc[buf[i] % abc.length]; if (i % 4 === 3 && i < 11) s += "-"; }
  return s;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const op = url.searchParams.get("op") || "health";

  try {
    if (op === "health") {
      return json({ ok: true, provider: PROVIDER, configurado: configurado() });
    }

    // ---- validação pública (não exige nada do provedor) ----
    if (op === "validar") {
      const codigo = (url.searchParams.get("codigo") || "").trim().toUpperCase();
      const hash = (url.searchParams.get("hash") || "").trim().toLowerCase();
      if (codigo && !CODIGO_RE.test(codigo)) return json({ erro: "codigo invalido" }, 400);
      if (hash && !HASH_RE.test(hash)) return json({ erro: "hash invalido" }, 400);
      const client = sb();
      let q = client.from("assinaturas_publicas").select("*").limit(1);
      if (codigo) q = q.eq("codigo", codigo);
      else if (hash) q = q.eq("hash_doc", hash);
      else return json({ erro: "informe codigo ou hash" }, 400);
      const { data, error } = await q;
      if (error) return json({ erro: "Não foi possível consultar a validação agora." }, 500);
      if (!data || !data.length) return json({ encontrado: false });
      return json({ encontrado: true, registro: data[0] });
    }

    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const requestedOrg = String(body.organization_id || body.meta?.organizationId || "").trim();
    if (requestedOrg && !UUID_RE.test(requestedOrg)) {
      return json({ erro: "Ambiente inválido." }, 400);
    }
    if (op === "sign" && !requestedOrg) {
      return json({ erro: "Informe o ambiente do documento." }, 400);
    }

    const guarda = await exigirClinico(req, requestedOrg);
    if ("erro" in guarda) return json({ erro: guarda.erro }, guarda.status);

    // ---- daqui pra baixo exige usuário autorizado e provedor configurado ----
    if (!configurado()) {
      return json({ erro: "Provedor de assinatura em nuvem ainda não configurado.", code: "NAO_CONFIGURADO" }, 501);
    }

    if (op === "cert-list") {
      const token = body.access_token || (await providerToken());
      const list = await cscCredentialsList(token);
      return json(list);
    }
    if (op === "cert-info") {
      const token = body.access_token || (await providerToken());
      const info = await cscCredentialInfo(token, body.credentialID);
      return json(info);
    }
    if (op === "sign") {
      const credentialID = String(body.credentialID || "").trim();
      const sad = String(body.sad || "").trim();
      if (!credentialID || !sad || !body.pdf_base64) {
        return json({ erro: "Credencial, autorização e PDF são obrigatórios." }, 400);
      }
      if (credentialID.length > 500 || sad.length > 4_096) {
        return json({ erro: "Credencial ou autorização fora do limite permitido." }, 400);
      }
      if (String(body.pdf_base64).length > 28_000_000) {
        return json({ erro: "PDF excede o limite de 20 MiB." }, 413);
      }
      const suppliedToken = String(body.access_token || "").trim();
      if (suppliedToken.length > 16_384) return json({ erro: "Token do provedor inválido." }, 400);
      const token = suppliedToken || (await providerToken());
      const pdf = b64ToBytes(body.pdf_base64);
      if (pdf.length > 20 * 1024 * 1024) return json({ erro: "PDF excede o limite de 20 MiB." }, 413);
      if (!isPdf(pdf)) return json({ erro: "O arquivo enviado não é um PDF válido." }, 400);
      const signed = await providerSignPdf(token, credentialID, sad, pdf);
      if (signed.length > 25 * 1024 * 1024) throw new Error("O PDF assinado excedeu o limite de resposta.");
      if (!isPdf(signed)) throw new Error("O provedor não devolveu um PDF assinado válido.");
      const hashDoc = await sha256Hex(signed);
      const meta = body.meta || {};

      const modulo = String(meta.modulo || "").trim();
      if (!MODULOS.has(modulo)) return json({ erro: "Módulo não autorizado para assinatura." }, 400);
      const docId = String(meta.docId || "").trim().slice(0, 200) || null;

      const { data: profile } = await guarda.client
        .from("profiles")
        .select("nome,crm,crm_uf")
        .eq("id", guarda.user.id)
        .maybeSingle();

      // Grava o registro imutável (a view pública expõe só o mínimo). Dados do
      // certificado não são aceitos do navegador: serão preenchidos somente
      // pelo driver do provedor quando a API SafeID real for homologada.
      const client = guarda.client;
      let ins: { codigo: string } | null = null;
      for (let attempt = 0; attempt < 3 && !ins; attempt++) {
        const { data: prev, error: prevError } = await client
          .from("assinaturas")
          .select("self_hash")
          .eq("organization_id", guarda.organizationId)
          .order("criado_em", { ascending: false })
          .limit(1);
        if (prevError) return json({ erro: "Não foi possível preparar o registro da assinatura." }, 500);

        const reg: Record<string, unknown> = {
          codigo: codigoValidacao(),
          organization_id: guarda.organizationId,
          signed_by: guarda.user.id,
          modulo,
          doc_id: docId,
          titulo: String(meta.titulo || "Documento").slice(0, 160),
          paciente_ini: String(meta.pacienteIni || "").slice(0, 16) || null,
          profissional: String(profile?.nome || guarda.user.email || "Profissional autenticado").slice(0, 160),
          crm: profile?.crm ? `${profile.crm}${profile.crm_uf ? "/" + profile.crm_uf : ""}`.slice(0, 40) : null,
          hash_doc: hashDoc,
          algoritmo: "SHA-256",
          provedor: PROVIDER,
          cert_emissor: null,
          cert_serial: null,
          cert_titular: null,
          cadeia_icp: null,
          versao: Math.max(1, Math.min(Number(meta.versao) || 1, 1_000_000)),
          prev_hash: prev && prev.length ? prev[0].self_hash : null,
        };
        reg.self_hash = await sha256Hex(new TextEncoder().encode(JSON.stringify(reg, Object.keys(reg).sort())));
        const result = await client.from("assinaturas").insert(reg).select("codigo").single();
        if (!result.error) {
          ins = result.data;
        } else if (result.error.code !== "23505") {
          return json({ erro: "Não foi possível registrar a assinatura." }, 500);
        }
      }
      if (!ins) {
        return json({ erro: "Outra assinatura foi registrada ao mesmo tempo; tente novamente." }, 409);
      }

      return json({ ok: true, codigo: ins.codigo, hash: hashDoc, pdf_assinado_base64: base64(signed) });
    }

    return json({ erro: "op desconhecida" }, 400);
  } catch (_) {
    return json({ erro: "Falha interna na operação de assinatura." }, 500);
  }
});
