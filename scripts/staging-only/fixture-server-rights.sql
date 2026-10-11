-- EXCLUSIVO de staging yqqrfgbvoexricjdxpis, ANTES das fixtures.
-- BYPASSRLS não concede privilégio de tabela. Estes grants são para o backend
-- efêmero de teste, não uma migração de produção nem uma policy de cliente.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
do $target$
begin
  if not exists (select 1 from supabase_migrations.schema_migrations
                 where name = 'staging_rebuild_0032_finalized_delete_guard')
     or to_regclass('public.staging_audit_run_claims') is null
     or to_regprocedure('public.staging_audit_block_fixture(uuid)') is null then
    raise exception 'Exige homologação reconstruída com claims e recovery instalados';
  end if;
  if exists(select 1 from auth.users) or exists(select 1 from public.organizations) then
    raise exception 'Instalar direitos de backend antes de criar fixtures, somente em staging vazio';
  end if;
  if not has_schema_privilege('service_role','public','USAGE') then
    raise exception 'USAGE public do backend ausente; reconciliar schema antes dos grants';
  end if;
end $target$;

-- Preservar permissões efetivas de clientes e todo o contrato de segurança.
create temporary table fixture_server_security_before on commit drop as
select c.oid, c.relrowsecurity, c.relforcerowsecurity,
  jsonb_build_object(
    'anon', jsonb_build_array(
      has_table_privilege('anon',c.oid,'SELECT'), has_table_privilege('anon',c.oid,'INSERT'),
      has_table_privilege('anon',c.oid,'UPDATE'), has_table_privilege('anon',c.oid,'DELETE')),
    'authenticated', jsonb_build_array(
      has_table_privilege('authenticated',c.oid,'SELECT'), has_table_privilege('authenticated',c.oid,'INSERT'),
      has_table_privilege('authenticated',c.oid,'UPDATE'), has_table_privilege('authenticated',c.oid,'DELETE')),
    'policies', (select jsonb_agg(to_jsonb(p) order by p.oid) from pg_policy p where p.polrelid=c.oid),
    'triggers', (select jsonb_agg(to_jsonb(t) order by t.oid) from pg_trigger t where t.tgrelid=c.oid)
  ) as security
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relkind in ('r','p');

-- SELECT clínico só para preflight/inventário/retensão. Toda criação/edição
-- clínica continua usando os JWTs REAIS dos profissionais da fixture.
grant select on table public.patients, public.encounters,
  public.preanesthetic_assessments, public.addenda, public.audit_logs,
  public.documentos, public.org_shares to service_role;

-- Organização DELETE é necessário somente para provar que o guard impede a
-- cascata de um original finalizado. Não conceder TRUNCATE/TRIGGER/REFERENCES.
grant select, insert, update, delete on table public.organizations to service_role;
grant select, insert, update on table public.profiles, public.organization_users to service_role;
grant select, insert, delete on table public.app_programmers to service_role;

do $verify$
declare r record; after_security jsonb;
begin
  for r in select * from fixture_server_security_before loop
    select jsonb_build_object(
      'anon', jsonb_build_array(
        has_table_privilege('anon',r.oid,'SELECT'), has_table_privilege('anon',r.oid,'INSERT'),
        has_table_privilege('anon',r.oid,'UPDATE'), has_table_privilege('anon',r.oid,'DELETE')),
      'authenticated', jsonb_build_array(
        has_table_privilege('authenticated',r.oid,'SELECT'), has_table_privilege('authenticated',r.oid,'INSERT'),
        has_table_privilege('authenticated',r.oid,'UPDATE'), has_table_privilege('authenticated',r.oid,'DELETE')),
      'policies', (select jsonb_agg(to_jsonb(p) order by p.oid) from pg_policy p where p.polrelid=r.oid),
      'triggers', (select jsonb_agg(to_jsonb(t) order by t.oid) from pg_trigger t where t.tgrelid=r.oid)
    ) into after_security;
    if after_security is distinct from r.security
       or not exists(select 1 from pg_class c where c.oid=r.oid
         and c.relrowsecurity=r.relrowsecurity and c.relforcerowsecurity=r.relforcerowsecurity) then
      raise exception 'Grant de fixture alterou contrato de segurança de cliente';
    end if;
  end loop;
  if has_table_privilege('service_role','public.staging_audit_run_claims','UPDATE')
     or has_table_privilege('service_role','public.staging_audit_run_claims','DELETE')
     or has_table_privilege('service_role','public.staging_audit_recoveries','SELECT,INSERT,UPDATE,DELETE') then
    raise exception 'Claims/recovery devem permanecer protegidos contra CRUD direto';
  end if;
end $verify$;
notify pgrst, 'reload schema';
commit;
