-- =============================================================================
-- Soft Anestesia — Migração 0037: uso de cada usuário, para o programador
-- =============================================================================
-- Na aba Programador, ao lado de cada pessoa: último acesso, dias com uso e
-- quantos registros gravou no período, por módulo, e quando foi o último.
--
--   * Só o programador chama (app.eh_programador()), como as demais prog_*.
--   * Devolve SÓ números e datas: nenhum dado de paciente, nenhum conteúdo de
--     registro, nenhum e-mail (a tela já tem os perfis que pode ver).
--   * O último login mora em auth.users, que o app não lê: a função é
--     security definer com search_path fixo e não expõe nada além disso.
--   * O volume sai da auditoria que já existe (audit_logs), sem tabela nova.
--   * Redefine/cria uma função; não toca em dado, tabela nem permissão de
--     tabela.
-- =============================================================================

create or replace function public.prog_uso_usuarios(p_dias integer default 30)
returns table(
  user_id uuid,
  ultimo_login timestamptz,
  conta_criada timestamptz,
  dias_ativos integer,
  registros integer,
  por_modulo jsonb,
  ultimo_registro timestamptz,
  ultimo_modulo text
)
language plpgsql security definer stable
set search_path = pg_catalog, public, app, auth
as $fn$
#variable_conflict use_column
declare
  v_desde timestamptz := now() - make_interval(days => least(greatest(coalesce(p_dias, 30), 1), 365));
begin
  if auth.uid() is null or not app.eh_programador() then
    raise exception 'Apenas o programador pode ver o uso dos usuários.'
      using errcode = 'insufficient_privilege';
  end if;
  return query
  with membros as (
    select distinct ou.user_id as uid from public.organization_users ou where ou.user_id is not null
  ),
  ev as (
    select a.user_id as uid, coalesce(nullif(a.module, ''), 'outro') as modulo, a.created_at as em
      from public.audit_logs a
     where a.created_at >= v_desde
       and a.action in ('insert', 'update', 'finalize', 'sign', 'addendum', 'delete', 'restore')
       and a.user_id in (select m.uid from membros m)
  ),
  agg as (
    select e.uid, count(*)::integer as n,
           count(distinct (e.em at time zone 'America/Bahia')::date)::integer as dias
      from ev e group by e.uid
  ),
  pm as (
    select x.uid, jsonb_object_agg(x.modulo, x.n) as mods
      from (select e.uid, e.modulo, count(*)::integer as n from ev e group by e.uid, e.modulo) x
     group by x.uid
  ),
  ult as (
    select distinct on (a.user_id) a.user_id as uid, a.created_at as em, a.module as modulo
      from public.audit_logs a
     where a.user_id in (select m.uid from membros m)
       and a.created_at >= now() - interval '365 days'
       and a.action in ('insert', 'update', 'finalize', 'sign', 'addendum', 'delete', 'restore')
     order by a.user_id, a.created_at desc
  )
  select m.uid, u.last_sign_in_at, u.created_at,
         coalesce(agg.dias, 0), coalesce(agg.n, 0), coalesce(pm.mods, '{}'::jsonb),
         ult.em, ult.modulo
    from membros m
    join auth.users u on u.id = m.uid
    left join agg on agg.uid = m.uid
    left join pm on pm.uid = m.uid
    left join ult on ult.uid = m.uid;
end
$fn$;

revoke all on function public.prog_uso_usuarios(integer) from public, anon, authenticated;
grant execute on function public.prog_uso_usuarios(integer) to authenticated;
