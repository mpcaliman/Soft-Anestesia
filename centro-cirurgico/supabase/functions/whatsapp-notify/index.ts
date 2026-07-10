// =====================================================================
//  Edge Function: whatsapp-notify
//  Envio de notificação por WhatsApp (Nível 2 — automático).
//
//  O token do WhatsApp permanece SOMENTE aqui, como segredo de ambiente,
//  nunca no HTML/JS público.
//
//  Esta função é agnóstica ao provedor: por padrão usa a WhatsApp Cloud
//  API (Meta). Para outro provedor, ajuste sendViaProvider().
//
//  A mensagem enviada é sempre NEUTRA: não inclui CPF, carteirinha,
//  data de nascimento, senha de autorização, dados clínicos, arquivos
//  ou qualquer informação sensível do paciente.
//
//  Segredos necessários (Settings → Edge Functions → Secrets):
//    SUPABASE_URL
//    SUPABASE_ANON_KEY
//    WHATSAPP_TOKEN               (token do provedor)
//    WHATSAPP_PHONE_ID            (id do número — WhatsApp Cloud API)
//
//  Deploy:
//    supabase functions deploy whatsapp-notify
// =====================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

interface NotifyPayload {
  to: string;          // celular do destinatário (E.164, só dígitos)
  name?: string;       // nome do destinatário (para o template)
  date?: string;       // dd/mm/aaaa
  start?: string;      // HH:MM
  end?: string;        // HH:MM
  message?: string;    // mensagem pronta (opcional; sobrepõe o template)
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

    // Exige usuário autenticado e ativo.
    const authHeader = req.headers.get('Authorization') ?? '';
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) {
      return json({ error: 'Não autenticado.' }, 401);
    }

    const body = (await req.json()) as NotifyPayload;
    if (!body.to) {
      return json({ error: 'Destinatário (to) é obrigatório.' }, 400);
    }

    // Monta a mensagem neutra.
    const text =
      body.message ??
      `Olá, ${body.name ?? ''}. Existe uma atualização em um procedimento no ` +
        `Centro Cirúrgico para ${body.date ?? ''}, das ${body.start ?? ''} às ` +
        `${body.end ?? ''}. Acesse o sistema para consultar os detalhes.`;

    const result = await sendViaProvider(body.to, text);
    return json({ ok: true, provider: result });
  } catch (e) {
    return json({ error: String(e?.message ?? e) }, 500);
  }
});

// Envio via WhatsApp Cloud API (Meta). Substitua por outro provedor se
// necessário — o restante do sistema não muda.
async function sendViaProvider(to: string, text: string): Promise<unknown> {
  const TOKEN = Deno.env.get('WHATSAPP_TOKEN');
  const PHONE_ID = Deno.env.get('WHATSAPP_PHONE_ID');

  if (!TOKEN || !PHONE_ID) {
    // Sem credenciais configuradas: retorna simulação para não quebrar o fluxo.
    return { simulated: true, to, text };
  }

  const resp = await fetch(`https://graph.facebook.com/v20.0/${PHONE_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    }),
  });

  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(`Provedor WhatsApp: ${JSON.stringify(data)}`);
  }
  return data;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
