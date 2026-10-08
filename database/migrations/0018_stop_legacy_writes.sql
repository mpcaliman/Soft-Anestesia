-- =============================================================================
-- Soft Anestesia — Migração 0018: encerra o canal pessoal legado
-- =============================================================================
-- Regras de Ouro atendidas:
--   * nenhum dado novo é gravado apenas por user_id, fora de uma organização;
--   * rascunhos e preferências continuam na nuvem, agora vinculados à clínica;
--   * o acervo legado permanece intacto e só pode ser lido pelo programador;
--   * toda leitura excepcional gera log sem conteúdo clínico.
--
-- Rode DEPOIS da 0017. A migração não move nem apaga nenhuma linha antiga.
-- =============================================================================

begin;
set local check_function_bodies = off;

-- 1) Rascunhos organizacionais ------------------------------------------------
create table if not exists public.drafts (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  user_id          uuid not null references auth.users(id) on delete cascade,
  module           text not null,
  doc_id           text not null,
  data             jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, user_id, module, doc_id),
  check (module in ('pre','consulta','anestesia','recuperacao'))
);

create index if not exists drafts_org_updated_idx
  on public.drafts(organization_id, updated_at desc);
create index if not exists drafts_user_module_idx
  on public.drafts(user_id, module, updated_at desc);

alter table public.drafts enable row level security;
alter table public.drafts force row level security;

drop trigger if exists trg_updated_at on public.drafts;
create trigger trg_updated_at before update on public.drafts
  for each row execute function app.set_updated_at();

drop policy if exists drafts_sel on public.drafts;
create policy drafts_sel on public.drafts for select
  using (
    organization_id in (select app.org_ids())
    and user_id = auth.uid()
    and app.pode_modulo(organization_id, module)
  );

drop policy if exists drafts_ins on public.drafts;
create policy drafts_ins on public.drafts for insert
  with check (
    organization_id in (select app.org_ids())
    and user_id = auth.uid()
    and app.pode_editar_modulo(organization_id, module)
  );

drop policy if exists drafts_upd on public.drafts;
create policy drafts_upd on public.drafts for update
  using (
    organization_id in (select app.org_ids())
    and user_id = auth.uid()
    and app.pode_editar_modulo(organization_id, module)
  )
  with check (
    organization_id in (select app.org_ids())
    and user_id = auth.uid()
    and app.pode_editar_modulo(organization_id, module)
  );

drop policy if exists drafts_del on public.drafts;
create policy drafts_del on public.drafts for delete
  using (
    organization_id in (select app.org_ids())
    and user_id = auth.uid()
    and app.pode_editar_modulo(organization_id, module)
  );

revoke all on table public.drafts from public, anon;
grant select, insert, update, delete on table public.drafts to authenticated;

-- 2) Preferências pessoais, mas sempre dentro de uma clínica ------------------
create table if not exists public.user_preferences (
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  user_id          uuid not null references auth.users(id) on delete cascade,
  data             jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (organization_id, user_id)
);

alter table public.user_preferences enable row level security;
alter table public.user_preferences force row level security;

drop trigger if exists trg_updated_at on public.user_preferences;
create trigger trg_updated_at before update on public.user_preferences
  for each row execute function app.set_updated_at();

drop policy if exists user_preferences_sel on public.user_preferences;
create policy user_preferences_sel on public.user_preferences for select
  using (organization_id in (select app.org_ids()) and user_id = auth.uid());

drop policy if exists user_preferences_ins on public.user_preferences;
create policy user_preferences_ins on public.user_preferences for insert
  with check (organization_id in (select app.org_ids()) and user_id = auth.uid());

drop policy if exists user_preferences_upd on public.user_preferences;
create policy user_preferences_upd on public.user_preferences for update
  using (organization_id in (select app.org_ids()) and user_id = auth.uid())
  with check (organization_id in (select app.org_ids()) and user_id = auth.uid());

revoke all on table public.user_preferences from public, anon;
grant select, insert, update on table public.user_preferences to authenticated;

-- 3) Log da recuperação excepcional do legado -------------------------------
create table if not exists public.legacy_access_logs (
  id              uuid primary key default gen_random_uuid(),
  programmer_id   uuid not null references auth.users(id),
  target_user_id  uuid not null references auth.users(id),
  action          text not null,
  row_count       integer not null default 0,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  check (action in ('read','inventory','assign','migrate'))
);

create index if not exists legacy_access_logs_created_idx
  on public.legacy_access_logs(created_at desc);

alter table public.legacy_access_logs enable row level security;
alter table public.legacy_access_logs force row level security;

drop policy if exists legacy_access_logs_prog_sel on public.legacy_access_logs;
create policy legacy_access_logs_prog_sel on public.legacy_access_logs for select
  using (app.eh_programador());

-- A política de INSERT existe para que o SECURITY DEFINER continue compatível
-- com FORCE RLS. O aplicativo não recebe o privilégio de inserir diretamente.
drop policy if exists legacy_access_logs_prog_ins on public.legacy_access_logs;
create policy legacy_access_logs_prog_ins on public.legacy_access_logs for insert
  with check (
    app.eh_programador()
    and programmer_id = auth.uid()
  );

revoke all on table public.legacy_access_logs from public, anon, authenticated;
grant select on table public.legacy_access_logs to authenticated;

-- A função usa SQL dinâmico para a migração continuar idempotente mesmo em um
-- projeto novo, onde a tabela `documentos` nunca chegou a existir.
create or replace function public.prog_read_legacy_documents(
  p_target_user uuid,
  p_limit integer default 200,
  p_offset integer default 0
)
returns table (
  modulo text,
  doc_id text,
  dados jsonb,
  atualizado_em timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public, app, auth
as $fn$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 200), 1), 500);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_count integer := 0;
begin
  if not app.eh_programador() then
    raise exception 'Apenas o programador pode recuperar o canal legado.'
      using errcode = 'insufficient_privilege';
  end if;
  if p_target_user is null then
    raise exception 'Informe o usuário de origem do legado.'
      using errcode = 'invalid_parameter_value';
  end if;

  if to_regclass('public.documentos') is not null then
    return query execute
      'select modulo::text, doc_id::text, dados::jsonb, atualizado_em::timestamptz
         from public.documentos
        where user_id::text = $1::text
        order by atualizado_em asc, doc_id asc
        limit $2 offset $3'
      using p_target_user, v_limit, v_offset;
    get diagnostics v_count = row_count;
  end if;

  insert into public.legacy_access_logs(
    programmer_id, target_user_id, action, row_count, metadata
  ) values (
    auth.uid(), p_target_user, 'read', v_count,
    jsonb_build_object('limit', v_limit, 'offset', v_offset)
  );
end;
$fn$;

revoke all on function public.prog_read_legacy_documents(uuid, integer, integer)
  from public, anon;
grant execute on function public.prog_read_legacy_documents(uuid, integer, integer)
  to authenticated;

-- 4) Congela o canal pessoal --------------------------------------------------
-- O service_role continua disponível para uma migração administrativa futura.
-- O app (anon/authenticated) não lê nem altera o legado diretamente; a única
-- leitura exposta é a função acima, com checagem de programador e auditoria.
do $block$
begin
  if to_regclass('public.documentos') is not null then
    execute 'revoke all on table public.documentos from public, anon, authenticated';
  end if;
end
$block$;

-- 5) Realtime dos substitutos organizacionais --------------------------------
do $block$
declare t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  foreach t in array array['drafts','user_preferences'] loop
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
    execute format('alter table public.%I replica identity full', t);
  end loop;
end
$block$;

commit;
