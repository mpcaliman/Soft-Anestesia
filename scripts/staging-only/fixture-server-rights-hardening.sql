-- STAGING ONLY yqqrfgbvoexricjdxpis, antes de qualquer fixture.
-- Complemento de privilégio do backend: nunca publicar como migração clínica.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
do $target$
begin
  if (select count(*) from supabase_migrations.schema_migrations) <> 38
     or not exists(select 1 from supabase_migrations.schema_migrations
                    where name = 'staging_rebuild_0032_finalized_delete_guard')
     or to_regclass('public.staging_audit_run_claims') is null
     or to_regclass('public.staging_audit_recoveries') is null then
    raise exception 'Exige staging auditado em 38 migrações, claims e recuperação';
  end if;
  if exists(select 1 from auth.users) or exists(select 1 from public.organizations) then
    raise exception 'Normalizar backend somente antes de criar fixtures em staging vazio';
  end if;
end $target$;

create temporary table fixture_hardening_security_before on commit drop as
select c.oid, c.relrowsecurity, c.relforcerowsecurity,
  jsonb_build_object(
    'anon', jsonb_build_array(
      has_table_privilege('anon',c.oid,'SELECT'), has_table_privilege('anon',c.oid,'INSERT'),
      has_table_privilege('anon',c.oid,'UPDATE'), has_table_privilege('anon',c.oid,'DELETE'),
      has_table_privilege('anon',c.oid,'TRUNCATE'), has_table_privilege('anon',c.oid,'REFERENCES'),
      has_table_privilege('anon',c.oid,'TRIGGER'), has_table_privilege('anon',c.oid,'MAINTAIN')),
    'authenticated', jsonb_build_array(
      has_table_privilege('authenticated',c.oid,'SELECT'), has_table_privilege('authenticated',c.oid,'INSERT'),
      has_table_privilege('authenticated',c.oid,'UPDATE'), has_table_privilege('authenticated',c.oid,'DELETE'),
      has_table_privilege('authenticated',c.oid,'TRUNCATE'), has_table_privilege('authenticated',c.oid,'REFERENCES'),
      has_table_privilege('authenticated',c.oid,'TRIGGER'), has_table_privilege('authenticated',c.oid,'MAINTAIN')),
    'policies', (select jsonb_agg(to_jsonb(p) order by p.oid) from pg_policy p where p.polrelid=c.oid),
    'triggers', (select jsonb_agg(to_jsonb(t) order by t.oid) from pg_trigger t where t.tgrelid=c.oid)
  ) as security
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relkind in ('r','p');

-- TRUNCATE não passa pelos guards UPDATE/DELETE. Retirar de TODAS as tabelas
-- públicas regulares/particionadas, inclusive evidência fora do runner.
do $truncate$
declare r record;
begin
  for r in select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
            where n.nspname='public' and c.relkind in ('r','p') loop
    execute format('revoke truncate on table public.%I from service_role', r.relname);
  end loop;
end $truncate$;

-- Primeiro eliminar direitos antigos/defaults dos alvos; depois conceder
-- matriz exata. Não copiar REFERENCES/TRIGGER/MAINTAIN/TRUNCATE de produção.
revoke all on table public.patients, public.encounters,
  public.preanesthetic_assessments, public.addenda, public.audit_logs,
  public.documentos, public.org_shares, public.organizations, public.profiles,
  public.organization_users, public.app_programmers from service_role;
grant select on table public.patients, public.encounters,
  public.preanesthetic_assessments, public.addenda, public.audit_logs,
  public.documentos, public.org_shares to service_role;
grant select, insert, update, delete on table public.organizations to service_role;
grant select, insert, update on table public.profiles, public.organization_users to service_role;
grant select, insert, delete on table public.app_programmers to service_role;

revoke all on table public.staging_audit_run_claims, public.staging_audit_recoveries from service_role;
grant select, insert on table public.staging_audit_run_claims to service_role;

do $verify$
declare r record; after_security jsonb; privilege text; expected boolean;
begin
  if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
            where n.nspname='public' and c.relkind in ('r','p')
              and has_table_privilege('service_role',c.oid,'TRUNCATE')) then
    raise exception 'TRUNCATE efetivo permanece herdado; abortar sem ampliar alteração de clientes';
  end if;
  for r in select * from (values
    ('patients',array['SELECT']), ('encounters',array['SELECT']),
    ('preanesthetic_assessments',array['SELECT']), ('addenda',array['SELECT']),
    ('audit_logs',array['SELECT']), ('documentos',array['SELECT']),
    ('org_shares',array['SELECT']),
    ('organizations',array['SELECT','INSERT','UPDATE','DELETE']),
    ('profiles',array['SELECT','INSERT','UPDATE']),
    ('organization_users',array['SELECT','INSERT','UPDATE']),
    ('app_programmers',array['SELECT','INSERT','DELETE']),
    ('staging_audit_run_claims',array['SELECT','INSERT']),
    ('staging_audit_recoveries',array[]::text[])
  ) as matrix(table_name,allowed) loop
    foreach privilege in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'] loop
      expected := privilege = any(r.allowed);
      if has_table_privilege('service_role',format('public.%I',r.table_name),privilege) is distinct from expected then
        raise exception 'Matriz de backend divergente em %.%', r.table_name, privilege;
      end if;
    end loop;
  end loop;
  for r in select * from fixture_hardening_security_before loop
    select jsonb_build_object(
      'anon', jsonb_build_array(
        has_table_privilege('anon',r.oid,'SELECT'), has_table_privilege('anon',r.oid,'INSERT'),
        has_table_privilege('anon',r.oid,'UPDATE'), has_table_privilege('anon',r.oid,'DELETE'),
        has_table_privilege('anon',r.oid,'TRUNCATE'), has_table_privilege('anon',r.oid,'REFERENCES'),
        has_table_privilege('anon',r.oid,'TRIGGER'), has_table_privilege('anon',r.oid,'MAINTAIN')),
      'authenticated', jsonb_build_array(
        has_table_privilege('authenticated',r.oid,'SELECT'), has_table_privilege('authenticated',r.oid,'INSERT'),
        has_table_privilege('authenticated',r.oid,'UPDATE'), has_table_privilege('authenticated',r.oid,'DELETE'),
        has_table_privilege('authenticated',r.oid,'TRUNCATE'), has_table_privilege('authenticated',r.oid,'REFERENCES'),
        has_table_privilege('authenticated',r.oid,'TRIGGER'), has_table_privilege('authenticated',r.oid,'MAINTAIN')),
      'policies', (select jsonb_agg(to_jsonb(p) order by p.oid) from pg_policy p where p.polrelid=r.oid),
      'triggers', (select jsonb_agg(to_jsonb(t) order by t.oid) from pg_trigger t where t.tgrelid=r.oid)
    ) into after_security;
    if after_security is distinct from r.security
       or not exists(select 1 from pg_class c where c.oid=r.oid
         and c.relrowsecurity=r.relrowsecurity and c.relforcerowsecurity=r.relforcerowsecurity) then
      raise exception 'Hardening de backend alterou segurança/permissão de cliente';
    end if;
  end loop;
end $verify$;
notify pgrst, 'reload schema';
commit;
