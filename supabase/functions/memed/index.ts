import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createMemedHandler } from "./handler.mjs";

// O par de chaves da Memed fica só aqui (Secrets do Supabase). O app recebe
// apenas o token do médico logado. Ver handler.mjs.
//
// Deploy:
//   supabase functions deploy memed
//   supabase secrets set MEMED_API_KEY=... MEMED_SECRET_KEY=...
//   (produção: também MEMED_API_URL=https://api.memed.com.br/v1
//    e MEMED_SCRIPT_URL=https://partners.memed.com.br/integration.js)
const env = (k: string) => Deno.env.get(k) ?? "";
const admin = () => createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { autoRefreshToken: false, persistSession: false },
});

Deno.serve(createMemedHandler({
  env,
  fetchImpl: fetch,
  getUser: async (jwt: string) => {
    const { data, error } = await admin().auth.getUser(jwt);
    return error || !data?.user ? null : { id: data.user.id };
  },
}));
