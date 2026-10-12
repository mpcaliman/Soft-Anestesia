-- Soft Anestesia — permissões reconciliadas após 0032.
-- Somente revogações: não muda owners, dados, RLS, policies ou guards.
-- Criador da aplicação: postgres. Objetos futuros desse executor exigem
-- grants explícitos; direitos CRUD existentes do servidor são preservados.
-- Os defaults do papel interno supabase_admin permanecem pendentes do
-- fornecedor: postgres não tem autoridade para alterá-los. Não elevar o
-- executor, não mudar owners e não declarar fechamento universal.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $preflight$
begin
  if current_user <> 'postgres'
     or current_database() <> 'postgres'
     or current_setting('server_version_num')::integer / 10000 <> 17 then
    raise exception '0033 exige o executor postgres no PostgreSQL 17';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_admin')
     or not exists (select 1 from pg_roles where rolname = 'anon')
     or not exists (select 1 from pg_roles where rolname = 'authenticated')
     or not exists (select 1 from pg_roles where rolname = 'service_role')
     or to_regnamespace('app') is null
     or to_regclass('public.documentos') is null
     or to_regclass('public.pacientes') is null then
    raise exception '0033 exige a baseline e os papéis declarados';
  end if;
  -- Um criador desconhecido exige análise, nunca uma revogação presumida.
  if exists (
    select 1 from pg_default_acl d
      left join pg_namespace n on n.oid = d.defaclnamespace
      join pg_roles r on r.oid = d.defaclrole
     where (d.defaclnamespace = 0 or n.nspname in ('public','app'))
       and r.rolname not in ('postgres','supabase_admin')
  ) then
    raise exception '0033 encontrou criador de defaults não revisado';
  end if;
  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
      join pg_roles r on r.oid=c.relowner
     where n.nspname in ('public','app') and c.relkind in ('r','p','v','m','S')
       and r.rolname <> 'postgres'
  ) or exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      join pg_roles r on r.oid=p.proowner
     where n.nspname in ('public','app') and r.rolname <> 'postgres'
  ) then
    raise exception '0033 exige objetos da aplicação pertencentes a postgres';
  end if;
  if exists (
    select 1 from pg_roles r where r.rolname in ('anon','authenticated','service_role')
       and (r.rolsuper or pg_has_role(r.oid,'supabase_admin','USAGE')
            or pg_has_role(r.oid,'supabase_admin','SET'))
  ) then
    raise exception '0033 exige isolamento do papel interno do fornecedor';
  end if;
end
$preflight$;

-- Evidência transacional: os defaults internos do fornecedor devem permanecer
-- idênticos, inclusive globais. Esta migração não tem autoridade sobre eles.
create temporary table soft_0033_supplier_defaults on commit drop as
select d.oid, d.defaclnamespace, d.defaclobjtype, d.defaclacl
  from pg_default_acl d join pg_roles r on r.oid=d.defaclrole
  left join pg_namespace n on n.oid=d.defaclnamespace
 where r.rolname='supabase_admin'
   and (d.defaclnamespace=0 or n.nspname in ('public','app'));

create temporary table soft_0033_service_crud on commit drop as
select c.oid as relation_oid, p.privilege,
       has_table_privilege('service_role', c.oid, p.privilege) as allowed
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 cross join (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE')) p(privilege)
 where n.nspname in ('public','app') and c.relkind in ('r','p','v','m');

create temporary table soft_0033_structure on commit drop as
select c.oid, c.relowner, c.relrowsecurity, c.relforcerowsecurity
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname in ('public','app') and c.relkind in ('r','p','v','m','S');

create temporary table soft_0033_legacy_sequences on commit drop as
select distinct s.oid as sequence_oid
  from pg_class s join pg_namespace n on n.oid=s.relnamespace
 where s.relkind='S' and n.nspname='public'
   and (s.relname='documentos_id_seq' or exists (
     select 1 from pg_depend d
       join pg_class t on t.oid=d.refobjid
       join pg_namespace tn on tn.oid=t.relnamespace
      where d.classid='pg_class'::regclass and d.objid=s.oid
        and d.refclassid='pg_class'::regclass and d.deptype in ('a','i')
        and tn.nspname='public' and t.relname in ('documentos','pacientes')
   ));

-- O default GLOBAL de funções contém PUBLIC EXECUTE por omissão. Revogar
-- apenas IN SCHEMA não subtrai essa concessão global.
alter default privileges for role postgres
  revoke all on tables from public, anon, authenticated, service_role;
alter default privileges for role postgres
  revoke all on sequences from public, anon, authenticated, service_role;
alter default privileges for role postgres
  revoke execute on functions from public, anon, authenticated, service_role;
do $defaults$
declare creator text; target_schema text;
begin
  foreach creator in array array['postgres'] loop
    foreach target_schema in array array['public','app'] loop
      execute format('alter default privileges for role %I in schema %I '
        'revoke all on tables from public, anon, authenticated, service_role',
        creator, target_schema);
      execute format('alter default privileges for role %I in schema %I '
        'revoke all on sequences from public, anon, authenticated, service_role',
        creator, target_schema);
      execute format('alter default privileges for role %I in schema %I '
        'revoke execute on functions from public, anon, authenticated, service_role',
        creator, target_schema);
    end loop;
  end loop;
end
$defaults$;

do $existing$
declare item record;
begin
  if exists (
    select 1 from soft_0033_supplier_defaults b
      full join (
        select d.oid,d.defaclnamespace,d.defaclobjtype,d.defaclacl
          from pg_default_acl d join pg_roles r on r.oid=d.defaclrole
          left join pg_namespace n on n.oid=d.defaclnamespace
         where r.rolname='supabase_admin'
           and (d.defaclnamespace=0 or n.nspname in ('public','app'))
      ) a on a.oid=b.oid
     where b.oid is null or a.oid is null
        or (a.defaclnamespace,a.defaclobjtype,a.defaclacl)
           is distinct from (b.defaclnamespace,b.defaclobjtype,b.defaclacl)
  ) then
    raise exception '0033 alterou defaults do fornecedor sem autoridade';
  end if;
  -- TRUNCATE não dispara os guards BEFORE UPDATE/DELETE. Não conceder
  -- qualquer DELETE novo nem alterar os privilégios CRUD existentes.
  for item in
    select n.nspname, c.relname from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname in ('public','app') and c.relkind in ('r','p')
  loop
    execute format('revoke truncate on table %I.%I '
      'from public, anon, authenticated, service_role', item.nspname, item.relname);
  end loop;

  -- Inclui a sequência conhecida e sequências OWNED BY de ambas as tabelas
  -- legadas. Não usa nextval/setval nem altera o valor das sequências.
  for item in
    select n.nspname, s.relname from soft_0033_legacy_sequences b
      join pg_class s on s.oid=b.sequence_oid
      join pg_namespace n on n.oid=s.relnamespace
  loop
    execute format('revoke all on sequence %I.%I from public, anon, authenticated',
      item.nspname, item.relname);
  end loop;

  -- Contém todos os overloads já presentes; nunca cria ou reintroduz a RPC.
  -- A provisão continua pela RPC do programador, com autorização no servidor.
  for item in
    select p.oid::regprocedure as signature from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'criar_minha_organizacao'
       and p.prokind = 'f'
  loop
    execute format('revoke all on function %s '
      'from public, anon, authenticated, service_role', item.signature);
  end loop;
end
$existing$;

do $verify$
declare item record; target_role text; sequence_privilege text;
begin
  if exists (
    select 1 from soft_0033_service_crud b
     where has_table_privilege('service_role', b.relation_oid, b.privilege)
           is distinct from b.allowed
  ) then
    raise exception '0033 alterou o contrato CRUD existente do servidor';
  end if;
  if exists (
    select 1 from soft_0033_structure b join pg_class c on c.oid = b.oid
     where (c.relowner,c.relrowsecurity,c.relforcerowsecurity)
           is distinct from (b.relowner,b.relrowsecurity,b.relforcerowsecurity)
  ) then
    raise exception '0033 alterou owners ou configuração RLS';
  end if;
  -- has_* inclui herança: se outro papel ainda conceder o direito, falhar
  -- e reverter a transação, sem modificar membership ou managed schemas.
  for item in
    select c.oid from pg_class c join pg_namespace n on n.oid=c.relnamespace
     where n.nspname in ('public','app') and c.relkind in ('r','p')
  loop
    foreach target_role in array array['anon','authenticated','service_role'] loop
      if has_table_privilege(target_role, item.oid, 'TRUNCATE') then
        raise exception '0033 deixou TRUNCATE efetivo herdado';
      end if;
    end loop;
    if exists (select 1 from pg_class c,
      lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
      where c.oid=item.oid and a.grantee=0 and a.privilege_type='TRUNCATE') then
      raise exception '0033 deixou TRUNCATE para PUBLIC';
    end if;
  end loop;
  if exists (
    select 1 from pg_default_acl d
      left join pg_namespace n on n.oid=d.defaclnamespace
      join pg_roles r on r.oid=d.defaclrole
      cross join lateral aclexplode(d.defaclacl) a
      left join pg_roles gr on gr.oid=a.grantee
     where r.rolname='postgres'
       and (d.defaclnamespace=0 or n.nspname in ('public','app'))
       and d.defaclobjtype in ('r','S','f')
       and (a.grantee=0 or gr.rolname in ('anon','authenticated','service_role'))
  ) then
    raise exception '0033 deixou concessão automática não revisada';
  end if;
  for item in select sequence_oid from soft_0033_legacy_sequences loop
    foreach target_role in array array['anon','authenticated'] loop
      foreach sequence_privilege in array array['SELECT','UPDATE','USAGE'] loop
        if has_sequence_privilege(target_role,item.sequence_oid,sequence_privilege) then
          raise exception '0033 deixou privilégio de sequência legado herdado';
        end if;
      end loop;
    end loop;
    if exists (select 1 from pg_class c,
      lateral aclexplode(coalesce(c.relacl,acldefault('S',c.relowner))) a
      where c.oid=item.sequence_oid and a.grantee=0) then
      raise exception '0033 deixou sequência legada acessível a PUBLIC';
    end if;
  end loop;
  for item in
    select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname='criar_minha_organizacao' and p.prokind='f'
  loop
    foreach target_role in array array['anon','authenticated','service_role'] loop
      if has_function_privilege(target_role,item.oid,'EXECUTE') then
        raise exception '0033 deixou autoprovisionamento executável';
      end if;
    end loop;
  end loop;
end
$verify$;

notify pgrst, 'reload schema';
commit;
