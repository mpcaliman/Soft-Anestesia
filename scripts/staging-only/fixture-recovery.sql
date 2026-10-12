-- Infraestrutura EXCLUSIVA da homologação yqqrfgbvoexricjdxpis.
-- Operador: verificar project_id antes de aplicar. Nunca incluir em produção.
-- Não altera Auth, prontuários, guards ou auditoria. Só contém acesso da fixture.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
do $guard$
begin
  if to_regclass('public.staging_audit_run_claims') is null
     or not exists (select 1 from supabase_migrations.schema_migrations
                    where name = 'staging_rebuild_0032_finalized_delete_guard') then
    raise exception 'Instalar somente na homologação reconstruída, após claims e 0032';
  end if;
end $guard$;

create table if not exists public.staging_audit_recoveries (
  run_id uuid primary key references public.staging_audit_run_claims(run_id) on delete restrict,
  blocked_at timestamptz not null default clock_timestamp(),
  contained_at timestamptz,
  completed_at timestamptz
);
alter table public.staging_audit_recoveries enable row level security;
alter table public.staging_audit_recoveries force row level security;
revoke all on public.staging_audit_recoveries from public, anon, authenticated, service_role;

create or replace function public.staging_audit_recovery_inventory(p_run_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, auth
as $fn$
declare
  claim public.staging_audit_run_claims%rowtype;
  user_ids uuid[];
  org_ids uuid[];
  active_memberships bigint;
  active_profiles bigint;
  active_organizations bigint;
  programmers bigint;
  banned bigint;
  active_shares bigint;
  latest_share_expiry timestamptz;
begin
  select * into claim from public.staging_audit_run_claims where run_id = p_run_id;
  if not found then raise exception 'Execução sintética não reivindicada' using errcode = '22023'; end if;
  -- Metadata exata recupera inclusive POST Auth confirmado com resposta perdida.
  select coalesce(array_agg(id order by id), '{}') into user_ids from auth.users
   where raw_app_meta_data->>'synthetic_audit' = p_run_id::text;
  select coalesce(array_agg(id order by id), '{}') into org_ids from public.organizations
   where nome = any(array['synthetic-' || p_run_id::text || '-0',
                          'synthetic-' || p_run_id::text || '-1']);
  if cardinality(user_ids) > 4 or cardinality(org_ids) > 2 then
    raise exception 'Fixture excede o escopo aprovado' using errcode = '22023';
  end if;
  select count(*) into active_memberships from public.organization_users
   where ativo and (user_id = any(user_ids) or organization_id = any(org_ids));
  select count(*) into active_profiles from public.profiles where id = any(user_ids) and ativo;
  select count(*) into active_organizations from public.organizations where id = any(org_ids) and ativo;
  select count(*) into programmers from public.app_programmers where user_id = any(user_ids);
  select count(*) into banned from auth.users where id = any(user_ids) and banned_until > statement_timestamp();
  select count(*), max(expira_em) into active_shares, latest_share_expiry from public.org_shares
   where ativo and (org_origem = any(org_ids) or org_destino = any(org_ids));
  return jsonb_build_object(
    'runId', p_run_id, 'claimedAt', claim.claimed_at, 'authUserIds', to_jsonb(user_ids),
    'organizationIds', to_jsonb(org_ids), 'activeMemberships', active_memberships,
    'activeProfiles', active_profiles, 'activeOrganizations', active_organizations,
    'programmerPrivileges', programmers, 'bannedAuthUsers', banned,
    'activeSharesPendingClosure', active_shares, 'latestActiveShareExpiry', latest_share_expiry
  );
end $fn$;

create or replace function public.staging_audit_block_fixture(p_run_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, auth
as $fn$
declare inventory jsonb; user_ids uuid[]; org_ids uuid[];
begin
  -- Serializa recuperações da mesma execução; não usa UUID fornecido como ID
  -- de usuário/organização e nunca lê fixtures de outra execução.
  perform 1 from public.staging_audit_run_claims where run_id = p_run_id for update;
  if not found then raise exception 'Execução sintética não reivindicada' using errcode = '22023'; end if;
  inventory := public.staging_audit_recovery_inventory(p_run_id);
  select coalesce(array_agg(value::uuid), '{}') into user_ids
    from jsonb_array_elements_text(inventory->'authUserIds');
  select coalesce(array_agg(value::uuid), '{}') into org_ids
    from jsonb_array_elements_text(inventory->'organizationIds');
  update public.organization_users set ativo = false
   where ativo and (user_id = any(user_ids) or organization_id = any(org_ids));
  update public.profiles set ativo = false where id = any(user_ids) and ativo;
  update public.organizations set ativo = false where id = any(org_ids) and ativo;
  delete from public.app_programmers where user_id = any(user_ids);
  -- Caminho de expiração já previsto no guard original; nenhuma identidade
  -- é forjada e nenhum trigger é removido. Nunca amplia ou encurta prazo.
  update public.org_shares set ativo = false, expirado_em = statement_timestamp()
   where ativo and expira_em <= statement_timestamp()
     and (org_origem = any(org_ids) or org_destino = any(org_ids));
  insert into public.staging_audit_recoveries(run_id) values(p_run_id)
    on conflict (run_id) do nothing;
  return public.staging_audit_recovery_inventory(p_run_id);
end $fn$;

create or replace function public.staging_audit_verify_recovery(p_run_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, auth
as $fn$
declare inventory jsonb;
begin
  perform 1 from public.staging_audit_recoveries where run_id = p_run_id for update;
  if not found then raise exception 'Conter acesso antes de verificar recuperação' using errcode = '22023'; end if;
  inventory := public.staging_audit_recovery_inventory(p_run_id);
  if (inventory->>'activeMemberships')::bigint <> 0
     or (inventory->>'activeProfiles')::bigint <> 0
     or (inventory->>'activeOrganizations')::bigint <> 0
     or (inventory->>'programmerPrivileges')::bigint <> 0
     or (inventory->>'bannedAuthUsers')::bigint <> jsonb_array_length(inventory->'authUserIds') then
    raise exception 'Bloqueio independente incompleto' using errcode = '23514';
  end if;
  update public.staging_audit_recoveries set
    contained_at = coalesce(contained_at, statement_timestamp()),
    completed_at = case when (inventory->>'activeSharesPendingClosure')::bigint = 0
      then coalesce(completed_at, statement_timestamp()) else null end
   where run_id = p_run_id;
  return inventory;
end $fn$;

revoke all on function public.staging_audit_recovery_inventory(uuid) from public, anon, authenticated;
revoke all on function public.staging_audit_block_fixture(uuid) from public, anon, authenticated;
revoke all on function public.staging_audit_verify_recovery(uuid) from public, anon, authenticated;
grant execute on function public.staging_audit_recovery_inventory(uuid) to service_role;
grant execute on function public.staging_audit_block_fixture(uuid) to service_role;
grant execute on function public.staging_audit_verify_recovery(uuid) to service_role;
comment on table public.staging_audit_recoveries is
  'Stage-only independent synthetic fixture containment; preserve identities, clinical rows and audit; completed_at excludes active-share pending closure';
notify pgrst, 'reload schema';
commit;
