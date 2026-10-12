-- Docker-local permission checks. No Auth/clinical records or remote target.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
do $local_permission_guard$ begin
 if current_database()<>'postgres' or current_user<>'supabase_admin'
  or current_setting('server_version_num')::integer/10000<>17 then
  raise exception 'Permission fixture requires isolated PostgreSQL 17 admin'; end if;
end $local_permission_guard$;

do $existing_permissions$ declare r record; client text; privilege text; begin
 for r in select c.oid from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname in ('public','app') and c.relkind in ('r','p') loop
  foreach client in array array['anon','authenticated','service_role'] loop
   if has_table_privilege(client,r.oid,'TRUNCATE') then
    raise exception 'Application TRUNCATE permission remains effective'; end if;
  end loop;
 end loop;
 if to_regclass('public.documentos_id_seq') is not null then
  foreach client in array array['anon','authenticated'] loop
   foreach privilege in array array['SELECT','UPDATE','USAGE'] loop
    if has_sequence_privilege(client,'public.documentos_id_seq',privilege) then
     raise exception 'Legacy sequence permission remains effective'; end if;
   end loop;
  end loop;
 end if;
 if to_regprocedure('public.criar_minha_organizacao(text)') is not null then
  foreach client in array array['anon','authenticated','service_role'] loop
   if has_function_privilege(client,'public.criar_minha_organizacao(text)','EXECUTE') then
    raise exception 'Self-provisioning RPC permission remains effective'; end if;
  end loop;
 end if;
end $existing_permissions$;

-- Real creations prove the combined global+schema defaults. Checking only
-- pg_default_acl rows can miss implicit global PUBLIC EXECUTE for functions.
set local role postgres;
create table public.soft_as_permissions_probe_postgres(id integer);
create sequence public.soft_as_permissions_probe_postgres_seq;
create function public.soft_as_permissions_probe_postgres_fn() returns integer language sql as 'select 1';
create table app.soft_as_permissions_probe_postgres(id integer);
create sequence app.soft_as_permissions_probe_postgres_seq;
create function app.soft_as_permissions_probe_postgres_fn() returns integer language sql as 'select 1';
reset role;
create table public.soft_as_permissions_probe_admin(id integer);
create sequence public.soft_as_permissions_probe_admin_seq;
create function public.soft_as_permissions_probe_admin_fn() returns integer language sql as 'select 1';
create table app.soft_as_permissions_probe_admin(id integer);
create sequence app.soft_as_permissions_probe_admin_seq;
create function app.soft_as_permissions_probe_admin_fn() returns integer language sql as 'select 1';

do $future_permissions$ declare ns text; creator text; client text; privilege text; target text; begin
 foreach ns in array array['public','app'] loop
  foreach creator in array array['postgres'] loop
   target:=format('%I.soft_as_permissions_probe_%s',ns,creator);
   foreach client in array array['anon','authenticated','service_role'] loop
    foreach privilege in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'] loop
     if has_table_privilege(client,target,privilege) then
      raise exception 'Future application table client privilege remains effective'; end if;
    end loop;
    foreach privilege in array array['SELECT','UPDATE','USAGE'] loop
     if has_sequence_privilege(client,target||'_seq',privilege) then
      raise exception 'Future application sequence client privilege remains effective'; end if;
    end loop;
    if has_function_privilege(client,target||'_fn()','EXECUTE') then
     raise exception 'Future application function client privilege remains effective'; end if;
   end loop;
  end loop;
 end loop;
end $future_permissions$;

create temporary table soft_as_admin_default_authority(tested boolean,denied boolean) on commit drop;
do $supplier_authority$
declare denied boolean:=false; authorized boolean:=pg_has_role('postgres','supabase_admin','USAGE');
begin
 if not authorized then
  set local role postgres;
  begin
   alter default privileges for role supabase_admin revoke execute on functions from public;
  exception when insufficient_privilege then denied:=true;
  end;
  reset role;
  if not denied then raise exception 'Expected managed-role default denial was not enforced'; end if;
 end if;
 insert into soft_as_admin_default_authority values(not authorized,denied);
end $supplier_authority$;

-- The provider-owned defaults are not changed by the application executor.
-- Observe their residual privileges explicitly; this is not a closure claim.
select jsonb_build_object('verified',true,'applicationExecutorDefaultPrivilegesClosed',true,
 'supplierDefaultPrivilegesClosed',not exists(
  select 1 from (values('public'),('app')) schemas(ns)
   cross join (values('anon'),('authenticated'),('service_role')) clients(role)
  where has_table_privilege(clients.role,schemas.ns||'.soft_as_permissions_probe_admin','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
   or has_sequence_privilege(clients.role,schemas.ns||'.soft_as_permissions_probe_admin_seq','SELECT,UPDATE,USAGE')
   or has_function_privilege(clients.role,schemas.ns||'.soft_as_permissions_probe_admin_fn()','EXECUTE')),
 'supplierDefaultPrivilegesPending',true,
 'managedRoleDeniedAttemptTested',(select tested from soft_as_admin_default_authority),
 'managedRoleDefaultDenied42501',(select denied from soft_as_admin_default_authority),
 'adminDefaultAuthorityMatchesHosted',(select tested and denied from soft_as_admin_default_authority),
 'supplierPrivilegesAdded',false,'supplierOwnersChanged',false);
rollback;
