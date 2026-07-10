// =====================================================================
//  Edge Function: invite-user
//  Criação e convite de novos usuários do centro cirúrgico.
//
//  Somente o GESTOR pode chamar esta função. Ela usa a chave
//  service_role (segredo do servidor) para criar o usuário no Auth,
//  enviar o e-mail de convite e criar o registro em public.profiles
//  com as funções (roles) informadas.
//
//  Segredos necessários (Settings → Edge Functions → Secrets):
//    SUPABASE_URL
//    SUPABASE_SERVICE_ROLE_KEY
//    SUPABASE_ANON_KEY
//
//  Deploy:
//    supabase functions deploy invite-user
// =====================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

interface InvitePayload {
  email: string;
  full_name: string;
  phone_whatsapp?: string;
  registration_type?: string;
  registration_number?: string;
  roles: string[];              // ex.: ['cirurgiao','anestesiologista']
  is_company?: boolean;
  company_trade_name?: string;
  cnpj?: string;
  company_responsible?: string;
  redirect_to?: string;         // URL para onde o convite direciona
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

    // 1) Identifica o solicitante a partir do token do usuário (JWT).
    const authHeader = req.headers.get('Authorization') ?? '';
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) {
      return json({ error: 'Não autenticado.' }, 401);
    }
    const caller = userData.user;

    // 2) Cliente administrativo (service_role) — NUNCA exposto ao navegador.
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // 3) Verifica se o solicitante é gestor e obtém o centro dele.
    const { data: callerProfile } = await admin
      .from('profiles')
      .select('surgical_center_id, status')
      .eq('id', caller.id)
      .single();

    if (!callerProfile || callerProfile.status !== 'ativo') {
      return json({ error: 'Usuário sem perfil ativo.' }, 403);
    }

    const { data: callerRoles } = await admin
      .from('user_roles')
      .select('role')
      .eq('user_id', caller.id);

    const isGestor = (callerRoles ?? []).some((r) => r.role === 'gestor');
    if (!isGestor) {
      return json({ error: 'Apenas o gestor pode convidar usuários.' }, 403);
    }

    const body = (await req.json()) as InvitePayload;
    if (!body.email || !body.full_name || !Array.isArray(body.roles) || body.roles.length === 0) {
      return json({ error: 'Dados obrigatórios ausentes (email, nome, funções).' }, 400);
    }

    const centerId = callerProfile.surgical_center_id;

    // 4) Cria/convida o usuário no Auth por e-mail.
    const { data: invited, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(
      body.email,
      { redirectTo: body.redirect_to },
    );

    let userId: string;
    if (inviteErr) {
      // Se o usuário já existe, tenta localizá-lo para vincular o perfil.
      const { data: list } = await admin.auth.admin.listUsers();
      const existing = list?.users?.find((u) => u.email?.toLowerCase() === body.email.toLowerCase());
      if (!existing) {
        return json({ error: `Falha ao convidar: ${inviteErr.message}` }, 400);
      }
      userId = existing.id;
    } else {
      userId = invited.user!.id;
    }

    // 5) Cria/atualiza o perfil.
    const { error: profileErr } = await admin.from('profiles').upsert({
      id: userId,
      surgical_center_id: centerId,
      full_name: body.full_name,
      email: body.email,
      phone_whatsapp: body.phone_whatsapp ?? null,
      registration_type: body.registration_type ?? null,
      registration_number: body.registration_number ?? null,
      status: 'ativo',
      is_company: body.is_company ?? false,
      company_trade_name: body.company_trade_name ?? null,
      cnpj: body.cnpj ?? null,
      company_responsible: body.company_responsible ?? null,
    });
    if (profileErr) {
      return json({ error: `Falha ao criar perfil: ${profileErr.message}` }, 400);
    }

    // 6) Substitui as funções do usuário.
    await admin.from('user_roles').delete().eq('user_id', userId);
    const roleRows = body.roles.map((role) => ({ user_id: userId, role }));
    const { error: rolesErr } = await admin.from('user_roles').insert(roleRows);
    if (rolesErr) {
      return json({ error: `Falha ao definir funções: ${rolesErr.message}` }, 400);
    }

    return json({ ok: true, user_id: userId });
  } catch (e) {
    return json({ error: String(e?.message ?? e) }, 500);
  }
});

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
