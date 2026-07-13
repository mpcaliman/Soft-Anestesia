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
const PROVIDER = env("SIGN_PROVIDER") || "safeid";
const CSC_BASE = env("CSC_BASE_URL");           // ex.: https://api.safeid.com.br/csc/v1  (>>> AJUSTAR <<<)
const CSC_ID = env("CSC_CLIENT_ID");
const CSC_SECRET = env("CSC_CLIENT_SECRET");
const CSC_SCOPE = env("CSC_SCOPE") || "service";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });
}
function sb() {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));
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
function configurado() { return !!(CSC_BASE && CSC_ID && CSC_SECRET); }

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
      const codigo = url.searchParams.get("codigo");
      const hash = url.searchParams.get("hash");
      const client = sb();
      let q = client.from("assinaturas_publicas").select("*").limit(1);
      if (codigo) q = q.eq("codigo", codigo.toUpperCase());
      else if (hash) q = q.eq("hash_doc", hash.toLowerCase());
      else return json({ erro: "informe codigo ou hash" }, 400);
      const { data, error } = await q;
      if (error) return json({ erro: error.message }, 500);
      if (!data || !data.length) return json({ encontrado: false });
      return json({ encontrado: true, registro: data[0] });
    }

    // ---- daqui pra baixo exige provedor configurado ----
    if (!configurado()) {
      return json({ erro: "Provedor de assinatura em nuvem ainda não configurado (defina os secrets CSC_*).", code: "NAO_CONFIGURADO" }, 501);
    }
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};

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
      const token = body.access_token || (await providerToken());
      const pdf = b64ToBytes(body.pdf_base64);
      const signed = await providerSignPdf(token, body.credentialID, body.sad, pdf);
      const hashDoc = await sha256Hex(signed);
      const meta = body.meta || {};

      // grava o registro imutável (a view pública expõe só o mínimo)
      const client = sb();
      const { data: prev } = await client.from("assinaturas").select("self_hash").order("criado_em", { ascending: false }).limit(1);
      const prevHash = prev && prev.length ? prev[0].self_hash : null;
      const reg: Record<string, unknown> = {
        codigo: codigoValidacao(),
        modulo: meta.modulo || "",
        doc_id: meta.docId || null,
        titulo: meta.titulo || "Documento",
        paciente_ini: meta.pacienteIni || null,
        profissional: meta.profissional || null,
        crm: meta.crm || null,
        hash_doc: hashDoc,
        algoritmo: "SHA-256",
        provedor: PROVIDER,
        cert_emissor: meta.certEmissor || null,
        cert_serial: meta.certSerial || null,
        cert_titular: meta.certTitular || null,
        cadeia_icp: true,
        versao: meta.versao || 1,
        prev_hash: prevHash,
      };
      reg.self_hash = await sha256Hex(new TextEncoder().encode(JSON.stringify(reg, Object.keys(reg).sort())));
      const { data: ins, error } = await client.from("assinaturas").insert(reg).select("codigo").single();
      if (error) return json({ erro: error.message }, 500);

      return json({ ok: true, codigo: ins.codigo, hash: hashDoc, pdf_assinado_base64: base64(signed) });
    }

    return json({ erro: "op desconhecida" }, 400);
  } catch (e) {
    return json({ erro: String((e as Error).message || e) }, 500);
  }
});
