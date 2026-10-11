// ============================================================================
// Soft Anestesia — Edge Function de CONTAS
// ----------------------------------------------------------------------------
// POR QUE ISTO EXISTE
// Quem decide quem entra na clínica é o responsável por ela, não quem chega.
// Até aqui era o contrário: a tela de entrada tinha "Criar conta", e qualquer
// pessoa com o endereço do app abria uma conta sozinha. O gestor só descobria
// depois, se descobrisse.
//
// Criar a conta de OUTRA pessoa exige a chave de administrador do Supabase
// (service_role), e essa chave dentro de um app estático entrega o banco
// inteiro a quem abrir o código-fonte. Por isso a criação mora aqui: a chave
// fica no servidor, o app só pede — e esta função confere, a cada chamada, que
// quem pediu é um programador cadastrado em `app_programmers`.
//
// A conta nasce com senha PROVISÓRIA e com `deve_trocar_senha: true` nos
// metadados. O app obriga a troca no primeiro acesso: senha que passou pelas
// mãos de outra pessoa não pode continuar valendo.
//
// Rotas (via ?op=):
//   GET  ?op=health                                   → a função está no ar?
//   POST ?op=criar  { email, nome?, senha? }          → cria a conta (só programador)
//   POST ?op=acesso { user_id, ativo, org? }          → bloqueia/libera o acesso
//
// BLOQUEAR NÃO É APAGAR, e num prontuário a diferença é grande. A autoria de
// um registro clínico não pode ser apagada: as colunas `created_by` apontam
// para `auth.users` SEM `on delete cascade`, então o banco RECUSA apagar quem
// já gravou alguma coisa — de propósito. Para essas contas (que são quase
// todas, depois do primeiro dia de uso) o que existe é bloquear: a pessoa
// deixa de entrar e deixa de ver os dados, e o que ela assinou continua
// assinado por ela.
//
// Deploy:
//   supabase functions deploy contas
// (SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY já existem no ambiente da função.)
//
// Depois do deploy, DESLIGUE o cadastro público no painel:
//   Authentication → Sign In / Providers → Email → "Allow new users to sign up" OFF
// Sem isso, o endereço /auth/v1/signup continua aberto com a chave pública, e
// tirar o botão do app é só tirar a maçaneta da porta.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const env = (k: string) => Deno.env.get(k) ?? "";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });
}

function admin() {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/* Senha provisória legível em voz alta e por telefone: sem caracteres que se
   confundem (0/O, 1/l/I) — ela vai ser ditada para alguém, e uma senha que a
   pessoa digita errado três vezes vira um chamado de suporte. */
function senhaProvisoria(): string {
  const letras = "abcdefghijkmnpqrstuvwxyz";
  const maius = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const nums = "23456789";
  const simbolos = "!@#$%*-_";
  const pick = (s: string, n: number) => {
    const b = new Uint32Array(n);
    crypto.getRandomValues(b);
    return [...b].map((x) => s[x % s.length]).join("");
  };
  return pick(maius, 2) + pick(letras, 8) + pick(nums, 3) + pick(simbolos, 3);
}

function erroSenha(senha: string): string {
  if (senha.length < 12) return "A senha precisa de ao menos 12 caracteres.";
  if (!/[a-z]/.test(senha) || !/[A-Z]/.test(senha) || !/[0-9]/.test(senha) || !/[^A-Za-z0-9]/.test(senha)) {
    return "Use letra minúscula, maiúscula, número e símbolo.";
  }
  return "";
}

/* Quem está pedindo? Só passa programador cadastrado no banco. O papel NÃO é
   lido do token (que o cliente monta): é consultado em `app_programmers`. */
async function exigirProgramador(req: Request) {
  const auth = req.headers.get("Authorization") || "";
  const jwt = auth.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return { erro: "Entre na nuvem antes.", status: 401 };
  const sb = admin();
  const { data, error } = await sb.auth.getUser(jwt);
  if (error || !data?.user) return { erro: "Sessão inválida ou vencida.", status: 401 };
  const { data: prog, error: e2 } = await sb
    .from("app_programmers").select("user_id").eq("user_id", data.user.id).maybeSingle();
  if (e2) return { erro: "Não consegui conferir a credencial: " + e2.message, status: 500 };
  if (!prog) return { erro: "Apenas o programador pode criar contas.", status: 403 };
  return { user: data.user, sb };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const op = url.searchParams.get("op") || "health";

  if (op === "health") {
    return json({ ok: true, funcao: "contas", configurado: !!env("SUPABASE_SERVICE_ROLE_KEY") });
  }

  if (op === "criar") {
    const guarda = await exigirProgramador(req);
    if ("erro" in guarda) return json({ ok: false, erro: guarda.erro }, guarda.status);
    const sb = guarda.sb;

    let corpo: any = {};
    try { corpo = await req.json(); } catch { corpo = {}; }
    const email = String(corpo.email || "").trim().toLowerCase();
    const nome = String(corpo.nome || "").trim();
    if (!email || email.indexOf("@") < 0) return json({ ok: false, erro: "Informe um e-mail válido." }, 400);

    const informada = String(corpo.senha || "");
    const senhaInvalida = informada ? erroSenha(informada) : "";
    if (senhaInvalida) {
      return json({ ok: false, erro: senhaInvalida }, 400);
    }
    const senha = informada || senhaProvisoria();

    const { data, error } = await sb.auth.admin.createUser({
      email,
      password: senha,
      /* confirmado na origem: a conta foi criada por quem responde pela
         clínica, e depender do e-mail chegar seria travar o acesso numa
         caixa de spam */
      email_confirm: true,
      user_metadata: { nome: nome || email.split("@")[0], deve_trocar_senha: true },
    });
    if (error) {
      const msg = String(error.message || "");
      if (/already|registered|exists/i.test(msg)) {
        return json({ ok: false, erro: "Já existe conta com este e-mail. Use 'Adicionar usuário a um ambiente'." }, 409);
      }
      return json({ ok: false, erro: msg || "Não consegui criar a conta." }, 400);
    }

    /* O perfil é criado junto: sem ele a pessoa existe no login e não existe
       na clínica. `prog_add_member` também o cria, mas o vínculo é um passo
       separado e pode não acontecer agora. */
    try {
      await sb.from("profiles").upsert(
        { id: data.user!.id, email, nome: nome || email.split("@")[0], ativo: true },
        { onConflict: "id" },
      );
    } catch (_) { /* o vínculo recria depois; não é motivo para falhar a criação */ }

    return json({
      ok: true,
      user_id: data.user!.id,
      email,
      senha,
      provisoria: !informada,
    });
  }

  if (op === "acesso") {
    const guarda = await exigirProgramador(req);
    if ("erro" in guarda) return json({ ok: false, erro: guarda.erro }, guarda.status);
    const sb = guarda.sb;

    let corpo: any = {};
    try { corpo = await req.json(); } catch { corpo = {}; }
    const userId = String(corpo.user_id || "").trim();
    const ativo = corpo.ativo === true;
    const org = String(corpo.org || "").trim();
    if (!userId) return json({ ok: false, erro: "Informe de quem é o acesso." }, 400);
    if (userId === guarda.user.id && !ativo) {
      return json({ ok: false, erro: "Você não pode bloquear o seu próprio acesso." }, 400);
    }

    /* DOIS LUGARES, e os dois importam:
       - `organization_users.ativo` é o que a RLS consulta: é a tranca de
         verdade, no banco, que impede até uma chamada direta à API;
       - `profiles.ativo` é o que o app lê ao entrar, para dizer à pessoa o que
         está acontecendo em vez de mostrar uma tela vazia.
       Mexer só no primeiro bloqueia sem explicar; só no segundo explica sem
       bloquear. */
    let q = sb.from("organization_users").update({ ativo }).eq("user_id", userId);
    if (org) q = q.eq("organization_id", org);
    const { error: e1 } = await q;
    if (e1) return json({ ok: false, erro: "Não consegui mudar o vínculo: " + e1.message }, 400);

    const { error: e2 } = await sb.from("profiles").update({ ativo }).eq("id", userId);
    if (e2) return json({ ok: false, erro: "Vínculo alterado, mas o perfil não: " + e2.message }, 400);

    return json({ ok: true, user_id: userId, ativo });
  }

  return json({ ok: false, erro: "Operação desconhecida: " + op }, 400);
});
