-- =============================================================================
-- Soft Anestesia — 0022: chave de envelope para a fila offline cifrada
-- =============================================================================
-- Local/G1 somente. Não aplicar em Supabase remoto sem autorização G3.
--
-- O conteúdo clínico offline permanece no aparelho, cifrado com uma DEK
-- (data-encryption key) diferente por organização + usuário + dispositivo.
-- A DEK fica no IndexedDB somente embrulhada por uma KEK aleatória. Esta
-- migração guarda a KEK no servidor, por usuário + dispositivo, e só a entrega
-- novamente depois de autenticação Supabase válida do MESMO usuário.
--
-- A tabela fica no schema interno `app`, sem grants para o Data API. O único
-- acesso do navegador é a função estreita abaixo; ela não aceita user_id como
-- parâmetro e deriva o dono exclusivamente de auth.uid().
-- =============================================================================

begin;

create table if not exists app.offline_keyrings (
  user_id          uuid not null references auth.users(id) on delete cascade,
  device_id        text not null,
  wrap_key         text not null,
  key_version      integer not null default 1,
  created_at       timestamptz not null default now(),
  last_accessed_at timestamptz not null default now(),
  primary key (user_id, device_id),
  constraint offline_keyrings_device_valid
    check (device_id ~ '^[A-Za-z0-9._:-]{8,160}$'),
  constraint offline_keyrings_wrap_key_valid
    check (length(wrap_key) between 40 and 64),
  constraint offline_keyrings_version_positive
    check (key_version > 0)
);

comment on table app.offline_keyrings is
  'KEK por usuário/dispositivo. Libera a DEK local embrulhada somente após autenticação do mesmo auth.uid().';
comment on column app.offline_keyrings.wrap_key is
  'Material aleatório de 256 bits em base64; nunca deve ser persistido pelo navegador.';

-- Defesa em profundidade: o schema app não integra a API pública e a tabela
-- também não concede acesso direto. RLS sem policies mantém qualquer papel
-- não proprietário fora, mesmo se um grant futuro for acrescentado por erro.
alter table app.offline_keyrings enable row level security;
revoke all on table app.offline_keyrings from public;
revoke all on table app.offline_keyrings from anon;
revoke all on table app.offline_keyrings from authenticated;

create or replace function public.ensure_offline_keyring(p_device_id text)
returns table(wrap_key text, key_version integer)
language plpgsql
security definer
set search_path = pg_catalog, app, auth
as $fn$
declare
  v_uid uuid := auth.uid();
  v_device text := btrim(coalesce(p_device_id, ''));
begin
  if v_uid is null then
    raise exception 'offline keyring requires authentication'
      using errcode = 'insufficient_privilege';
  end if;
  if v_device !~ '^[A-Za-z0-9._:-]{8,160}$' then
    raise exception 'invalid offline device identifier'
      using errcode = 'invalid_parameter_value';
  end if;

  -- ON CONFLICT torna duas abas no primeiro login convergentes: ambas recebem
  -- exatamente a chave vencedora, nunca duas KEKs para o mesmo dispositivo.
  insert into app.offline_keyrings(user_id, device_id, wrap_key)
  values (v_uid, v_device, encode(gen_random_bytes(32), 'base64'))
  on conflict (user_id, device_id) do nothing;

  update app.offline_keyrings k
     set last_accessed_at = now()
   where k.user_id = v_uid
     and k.device_id = v_device;

  return query
  select k.wrap_key, k.key_version
    from app.offline_keyrings k
   where k.user_id = v_uid
     and k.device_id = v_device;
end
$fn$;

comment on function public.ensure_offline_keyring(text) is
  'Cria/retorna a KEK estável do próprio auth.uid() e dispositivo para abrir envelopes offline locais.';

revoke all on function public.ensure_offline_keyring(text) from public;
revoke all on function public.ensure_offline_keyring(text) from anon;
grant execute on function public.ensure_offline_keyring(text) to authenticated;

commit;
