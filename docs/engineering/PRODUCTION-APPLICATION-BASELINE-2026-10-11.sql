-- Application-only production DDL captured without any records or secrets.
-- REFERENCE REPLAY ONLY: disposable Docker-local Supabase/PostgreSQL 17.
-- Never apply this restore artifact to production or an existing remote staging database.
-- Auth/Storage managed tables/functions are prerequisites, not copied DDL.
-- No migration-history rows are inserted, repaired or rewritten.
begin;
set local search_path=pg_catalog;
set local check_function_bodies=off;
set local lock_timeout='5s';
set local statement_timeout='120s';
do $reference_guard$ begin
 if current_database()<>'postgres' or current_user<>'supabase_admin' or current_setting('server_version_num')::integer/10000<>17
    or current_setting('application_name')<>'soft_as_production_baseline_replay' then
   raise exception 'Production baseline replay requires the isolated local reference executor'; end if;
 if exists(select 1 from auth.users) or exists(select 1 from storage.objects) or exists(
   select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where n.nspname in ('public','app') and c.relkind in ('r','p','v','m','f','S')
   and not exists(select 1 from pg_depend d where d.classid='pg_class'::regclass and d.objid=c.oid and d.deptype='e')) then
   raise exception 'Reference replay requires an empty application and zero Auth/Storage objects'; end if;
 if to_regprocedure('auth.uid()') is null or to_regclass('auth.users') is null
    or to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null then
   raise exception 'Managed Supabase Auth/Storage dependencies missing'; end if;
end $reference_guard$;
create schema if not exists extensions;
create schema app authorization postgres;
alter schema "app" owner to "postgres";
alter schema "extensions" owner to "postgres";
alter schema "public" owner to "pg_database_owner";
create extension if not exists "pg_trgm" with schema "public" version '1.6';
alter extension "pg_trgm" set schema "public";
do $extension_guard$ begin if not exists(select 1 from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='pg_trgm' and e.extversion='1.6' and n.nspname='public') then raise exception 'Application extension version/schema mismatch'; end if; end $extension_guard$;
create extension if not exists "pgcrypto" with schema "extensions" version '1.3';
alter extension "pgcrypto" set schema "extensions";
do $extension_guard$ begin if not exists(select 1 from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='pgcrypto' and e.extversion='1.3' and n.nspname='extensions') then raise exception 'Application extension version/schema mismatch'; end if; end $extension_guard$;
create extension if not exists "unaccent" with schema "public" version '1.1';
alter extension "unaccent" set schema "public";
do $extension_guard$ begin if not exists(select 1 from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='unaccent' and e.extversion='1.1' and n.nspname='public') then raise exception 'Application extension version/schema mismatch'; end if; end $extension_guard$;
create extension if not exists "uuid-ossp" with schema "extensions" version '1.1';
alter extension "uuid-ossp" set schema "extensions";
do $extension_guard$ begin if not exists(select 1 from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='uuid-ossp' and e.extversion='1.1' and n.nspname='extensions') then raise exception 'Application extension version/schema mismatch'; end if; end $extension_guard$;
set local role postgres;
CREATE OR REPLACE FUNCTION app.audit_row()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app', 'auth'
AS $function$
declare
  jn jsonb;      -- new (ou old, em delete)
  jo jsonb;      -- old (em update/delete)
  v_action text;
begin
  jn := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  jo := case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) else '{}'::jsonb end;

  if tg_op = 'INSERT' then
    v_action := 'insert';
  elsif tg_op = 'UPDATE' then
    if  (jn->>'deleted_at')   is not null and (jo->>'deleted_at')   is null then v_action := 'delete';
    elsif (jo->>'deleted_at') is not null and (jn->>'deleted_at')   is null then v_action := 'restore';
    elsif (jn->>'finalized_at') is not null and (jo->>'finalized_at') is null then v_action := 'finalize';
    else v_action := 'update';
    end if;
  else
    v_action := 'delete';
  end if;

  insert into public.audit_logs(organization_id, user_id, patient_id, encounter_id,
                                module, record_id, action, new_value, created_at)
  values (nullif(jn->>'organization_id','')::uuid, auth.uid(),
          nullif(jn->>'patient_id','')::uuid, nullif(jn->>'encounter_id','')::uuid,
          tg_table_name, nullif(jn->>'id','')::uuid, v_action, jn, now());
  return null; -- AFTER trigger
end $function$;
CREATE OR REPLACE FUNCTION app.bump_version()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.version := coalesce(old.version, 1) + 1;
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end $function$;
CREATE OR REPLACE FUNCTION app.can_read_clinical(p_org uuid, p_surgeon uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'app', 'auth'
AS $function$
  select exists(
    select 1 from public.organization_users ou
     where ou.user_id = auth.uid()
       and ou.organization_id = p_org
       and ou.ativo = true
       and (
            ou.role in ('gestor','anestesiologista')
         or (ou.role = 'cirurgiao' and p_surgeon = auth.uid())
       )
  )
$function$;
CREATE OR REPLACE FUNCTION app.can_write_clinical(p_org uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'app', 'auth'
AS $function$
  select app.has_role(p_org, array['gestor','anestesiologista'])
$function$;
CREATE OR REPLACE FUNCTION app.compartilhada_para_mim(p_org uuid, p_modulo text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'app', 'auth'
AS $function$
  select exists (
    select 1 from public.org_shares s
     where s.org_origem = p_org
       and s.org_destino in (select app.org_ids())
       and (cardinality(s.modulos) = 0 or p_modulo = any(s.modulos))
  )
$function$;
CREATE OR REPLACE FUNCTION app.eh_programador()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'app', 'auth'
AS $function$
  select exists (select 1 from public.app_programmers where user_id = auth.uid())
$function$;
CREATE OR REPLACE FUNCTION app.guard_finalized()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if old.finalized_at is not null
     and new.data is distinct from old.data then
    raise exception 'Registro finalizado/assinado é imutável. Use um adendo para correções (record %, tabela %).', old.id, tg_table_name
      using errcode = 'check_violation';
  end if;
  return new;
end $function$;
CREATE OR REPLACE FUNCTION app.has_role(p_org uuid, p_roles text[])
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'app', 'auth'
AS $function$
  select exists(
    select 1 from public.organization_users
     where user_id = auth.uid()
       and organization_id = p_org
       and ativo = true
       and role = any(p_roles)
  )
$function$;
CREATE OR REPLACE FUNCTION app.modulos_do_papel(p_org uuid)
 RETURNS text[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'app', 'auth'
AS $function$
  select case (select ou.role from public.organization_users ou
                where ou.user_id = auth.uid() and ou.organization_id = p_org and ou.ativo)
    when 'gestor'           then array['dashboard','pacientes','agenda','consulta','pre','termo','prescricao','documentos','risco','anestesia','recuperacao','financeiro','orcamento','doses','ajustes']
    when 'anestesiologista' then array['dashboard','pacientes','agenda','consulta','pre','termo','prescricao','documentos','risco','anestesia','recuperacao','financeiro','orcamento','doses']
    when 'auxiliar'         then array['dashboard','pacientes','agenda','pre','termo','prescricao','documentos','financeiro','orcamento']
    when 'financeiro'       then array['dashboard','pacientes','agenda','financeiro','orcamento']
    when 'empresa'          then array['dashboard','financeiro','orcamento']
    when 'cirurgiao'        then array['dashboard','pacientes','agenda','consulta','pre','termo','documentos','risco']
    else array[]::text[]
  end
$function$;
CREATE OR REPLACE FUNCTION app.org_ids()
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'app', 'auth'
AS $function$
  select organization_id
    from public.organization_users
   where user_id = auth.uid() and ativo = true
$function$;
CREATE OR REPLACE FUNCTION app.pode_editar_modulo(p_org uuid, p_modulo text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'app', 'auth'
AS $function$
  select app.pode_modulo(p_org, p_modulo)
     and not coalesce((
       select ou.permissoes -> 'soImpressao' @> to_jsonb(p_modulo)
         from public.organization_users ou
        where ou.user_id = auth.uid() and ou.organization_id = p_org and ou.ativo = true
          and ou.permissoes is not null), false)
$function$;
CREATE OR REPLACE FUNCTION app.pode_modulo(p_org uuid, p_modulo text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'app', 'auth'
AS $function$
  select case
    when app.tem_config(p_org) then exists (
      select 1 from public.organization_users ou
       where ou.user_id = auth.uid() and ou.organization_id = p_org and ou.ativo = true
         and ou.permissoes -> 'modulos' @> to_jsonb(p_modulo))
    else p_modulo = any (app.modulos_do_papel(p_org))
  end
$function$;
CREATE OR REPLACE FUNCTION app.pode_ver_registro(p_org uuid, p_creator uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'app', 'auth'
AS $function$
  select app.visibilidade_registros(p_org) = 'equipe'
      or p_creator is null
      or p_creator = auth.uid()
      or not exists (
           select 1 from public.organization_users ou
            where ou.organization_id = p_org
              and ou.user_id = p_creator
              and ou.ativo = true
              and ou.role in ('anestesiologista','gestor')
         )
$function$;
CREATE OR REPLACE FUNCTION app.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.updated_at := now();
  return new;
end $function$;
CREATE OR REPLACE FUNCTION app.stamp_created()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if new.created_by is null then new.created_by := auth.uid(); end if;
  new.updated_by := auth.uid();
  return new;
end $function$;
CREATE OR REPLACE FUNCTION app.tem_config(p_org uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'app', 'auth'
AS $function$
  select exists (
    select 1 from public.organization_users ou
     where ou.user_id = auth.uid()
       and ou.organization_id = p_org
       and ou.ativo = true
       and ou.permissoes is not null
       and jsonb_typeof(ou.permissoes -> 'modulos') = 'array'
  )
$function$;
CREATE OR REPLACE FUNCTION app.visibilidade_registros(p_org uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'app', 'auth'
AS $function$
  select coalesce(
    (select settings->>'visibilidade_registros' from public.organizations where id = p_org),
    'equipe')
$function$;
CREATE OR REPLACE FUNCTION public.add_member(p_org uuid, p_email text, p_role text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app', 'auth'
AS $function$
declare
  v_uid uuid;
begin
  -- 1) Só o gestor da organização pode adicionar membros
  if not app.has_role(p_org, array['gestor']) then
    raise exception 'Apenas o gestor da organização pode adicionar membros.';
  end if;

  -- 2) Papel válido
  if p_role not in ('gestor','anestesiologista','cirurgiao','auxiliar','financeiro','empresa') then
    raise exception 'Papel inválido: %', p_role;
  end if;

  -- 3) Encontra o usuário pelo e-mail (precisa já ter conta na nuvem)
  select id into v_uid from auth.users where lower(email) = lower(trim(p_email)) limit 1;
  if v_uid is null then
    raise exception 'Nenhuma conta na nuvem com o e-mail %. Peça para a pessoa criar a conta primeiro (Entrar -> Criar conta).', p_email;
  end if;

  -- 4) Vincula com o papel (ativo) e torna esse o papel efetivo (único ativo)
  insert into public.organization_users(organization_id, user_id, role, ativo)
    values (p_org, v_uid, p_role, true)
    on conflict (organization_id, user_id, role) do update set ativo = true;
  update public.organization_users
    set ativo = false
    where organization_id = p_org and user_id = v_uid and role <> p_role;

  -- 5) Garante o profile
  insert into public.profiles(id, nome, email, funcao, ativo)
    values (v_uid,
            coalesce((select raw_user_meta_data->>'name' from auth.users where id = v_uid), split_part(p_email,'@',1)),
            p_email, p_role, true)
    on conflict (id) do update set ativo = true, funcao = p_role, email = excluded.email;

  return v_uid;
end;
$function$;
CREATE OR REPLACE FUNCTION public.apresentacoes_do_principio(p_principio_base text, p_tipo text DEFAULT NULL::text, p_limite integer DEFAULT 100)
 RETURNS TABLE(ggrem text, id_apresentacao text, nome_comercial text, principio_ativo text, concentracao text, forma_farmaceutica text, via_administracao text, via_definida boolean, injetavel_sem_via boolean, tipo_medicamento text, laboratorio text, registro_anvisa text, comercializado boolean)
 LANGUAGE sql
 STABLE PARALLEL SAFE
 SET search_path TO 'public'
AS $function$
  select c.ggrem, c.id_apresentacao, c.nome_comercial, c.principio_ativo,
         c.concentracao, c.forma_farmaceutica, c.via_administracao,
         c.via_definida, c.injetavel_sem_via, c.tipo_medicamento,
         c.laboratorio, c.registro_anvisa, c.comercializado
    from public.medicamentos_clinicos c
    -- Aceita a raiz ('pantoprazol') ou o princípio como escrito na CMED
    -- ('PANTOPRAZOL SÓDICO SESQUI-HIDRATADO'): quem chama não deveria ter de
    -- saber qual das duas formas tem em mãos.
   where (c.principio_base    = public.med_normalizar(p_principio_base)
          or c.principio_norm = public.med_normalizar(p_principio_base))
     and (p_tipo is null or p_tipo = '' or c.tipo_medicamento = p_tipo)
   order by c.comercializado desc,
            -- referência primeiro, depois genérico, depois similar
            case c.tipo_medicamento when 'referencia' then 1 when 'generico' then 2
                                    when 'similar' then 3 else 4 end,
            c.forma_farmaceutica, c.concentracao, c.nome_comercial
   limit greatest(1, least(coalesce(p_limite, 100), 500));
$function$;
CREATE OR REPLACE FUNCTION public.assinaturas_no_mutate()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  raise exception 'Registro de assinatura é imutável (append-only).';
end;
$function$;
CREATE OR REPLACE FUNCTION public.buscar_medicamentos(p_termo text, p_tipo text DEFAULT NULL::text, p_limite integer DEFAULT 20, p_so_comercializados boolean DEFAULT false)
 RETURNS TABLE(ggrem text, id_apresentacao text, nome_comercial text, nome_generico text, principio_ativo text, principio_base text, concentracao text, forma_farmaceutica text, via_administracao text, via_definida boolean, injetavel_sem_via boolean, tipo_medicamento text, laboratorio text, registro_anvisa text, classe_terapeutica text, comercializado boolean, quantas_apresentacoes bigint, relevancia integer)
 LANGUAGE plpgsql
 STABLE PARALLEL SAFE
 SET search_path TO 'public'
AS $function$
declare
  t   text    := public.med_normalizar(p_termo);
  lim integer := greatest(1, least(coalesce(p_limite, 20), 100));
begin
  if length(t) < 2 then return; end if;

  -- DOIS CAMINHOS, e não um `case` dentro do where: com o `case`, o planejador
  -- não consegue empurrar a condição para dentro do índice e toda tecla passava
  -- a varrer a matview inteira (130 ms medidos). Separados, cada um usa o
  -- índice que lhe cabe e a busca volta para a casa dos milissegundos.
  if length(t) < 3 then
    -- Duas letras: só começo de palavra. Trigrama precisa de três caracteres,
    -- e "di" no meio de um nome é ruído — ninguém digita duas letras
    -- procurando o miolo de uma palavra.
    return query
      select c.ggrem, c.id_apresentacao, c.nome_comercial, c.nome_generico,
             c.principio_ativo, c.principio_base, c.concentracao,
             c.forma_farmaceutica, c.via_administracao, c.via_definida,
             c.injetavel_sem_via, c.tipo_medicamento, c.laboratorio,
             c.registro_anvisa, c.classe_terapeutica, c.comercializado,
             c.quantas_apresentacoes,
             (case when c.nome_comercial_norm like t || '%' then 1
                   when c.principio_norm      like t || '%' then 2
                   else 3 end)::integer
        from public.medicamentos_clinicos c
       where (c.nome_comercial_norm   like t || '%'
              or c.principio_norm     like t || '%'
              or c.nome_generico_norm like t || '%')
         and (p_tipo is null or p_tipo = '' or c.tipo_medicamento = p_tipo)
         and (not p_so_comercializados or c.comercializado)
       order by 18,
                c.comercializado desc,
                case c.tipo_medicamento when 'referencia' then 1 when 'generico' then 2
                                        when 'similar' then 3 else 4 end,
                length(c.nome_comercial), c.nome_comercial, c.concentracao
       limit lim;
  else
    return query
      select c.ggrem, c.id_apresentacao, c.nome_comercial, c.nome_generico,
             c.principio_ativo, c.principio_base, c.concentracao,
             c.forma_farmaceutica, c.via_administracao, c.via_definida,
             c.injetavel_sem_via, c.tipo_medicamento, c.laboratorio,
             c.registro_anvisa, c.classe_terapeutica, c.comercializado,
             c.quantas_apresentacoes,
             (case
                when c.nome_comercial_norm like t || '%' then 1
                when c.principio_norm      like t || '%' then 2
                when c.nome_generico_norm  like t || '%' then 3
                when c.busca_norm          like '%' || t || '%' then 4
                else 5
              end)::integer
        from public.medicamentos_clinicos c
        -- Contido resolve o caso normal; o trigrama é só a tolerância a erro de
        -- digitação ("xareuto" -> Xarelto), comparada com o NOME e com o
        -- PRINCÍPIO e nunca com a frase inteira: diluído em "xarelto
        -- rivaroxabana", erro nenhum passa do limiar de semelhança e a
        -- tolerância não existiria na prática.
       where (c.busca_norm like '%' || t || '%'
              or c.nome_comercial_norm % t
              or c.principio_norm % t)
         and (p_tipo is null or p_tipo = '' or c.tipo_medicamento = p_tipo)
         and (not p_so_comercializados or c.comercializado)
       order by 18,
                -- comercializado antes de descontinuado: é o que o paciente
                -- acha na farmácia
                c.comercializado desc,
                -- Referência antes de genérico e de similar. Sem isto, pedir
                -- "panto" devolvia dez linhas de pantoprazol genérico e
                -- empurrava PANTOZOL, que é a marca que o paciente diz que
                -- toma, para fora da lista.
                case c.tipo_medicamento when 'referencia' then 1 when 'generico' then 2
                                        when 'similar' then 3 else 4 end,
                greatest(similarity(c.nome_comercial_norm, t),
                         similarity(c.principio_norm, t)) desc,
                length(c.nome_comercial), c.nome_comercial, c.concentracao
       limit lim;
  end if;
end;
$function$;
CREATE OR REPLACE FUNCTION public.med_normalizar(txt text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
AS $function$ select btrim(regexp_replace(lower(public.med_unaccent(coalesce(txt, ''))), '\s+', ' ', 'g')) $function$;
CREATE OR REPLACE FUNCTION public.med_unaccent(text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE STRICT
AS $function$ select public.unaccent('public.unaccent', $1) $function$;
CREATE OR REPLACE FUNCTION public.prog_add_member(p_org uuid, p_email text, p_role text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app', 'auth'
AS $function$
declare
  v_uid uuid;
begin
  if not app.eh_programador() then
    raise exception 'Apenas o programador pode usar esta função.';
  end if;
  if p_role not in ('gestor','anestesiologista','cirurgiao','auxiliar','financeiro','empresa') then
    raise exception 'Papel inválido: %', p_role;
  end if;
  select id into v_uid from auth.users where lower(email) = lower(trim(p_email)) limit 1;
  if v_uid is null then
    raise exception 'Nenhuma conta na nuvem com o e-mail %.', p_email;
  end if;
  insert into public.organization_users(organization_id, user_id, role, ativo)
    values (p_org, v_uid, p_role, true)
    on conflict (organization_id, user_id, role) do update set ativo = true;
  update public.organization_users
    set ativo = false
    where organization_id = p_org and user_id = v_uid and role <> p_role;
  insert into public.profiles(id, nome, email, funcao, ativo)
    values (v_uid, split_part(p_email, '@', 1), p_email, p_role, true)
    on conflict (id) do update set ativo = true, funcao = p_role;
  return v_uid;
end;
$function$;
CREATE OR REPLACE FUNCTION public.prog_contar_ambiente(p_org uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app', 'auth'
AS $function$
declare v jsonb;
begin
  if not app.eh_programador() then
    raise exception 'Apenas o programador pode usar esta função.';
  end if;
  select jsonb_build_object(
    'fichas',     (select count(*) from public.anesthesia_records        where organization_id = p_org and deleted_at is null),
    'pre',        (select count(*) from public.preanesthetic_assessments where organization_id = p_org and deleted_at is null),
    'consultas',  (select count(*) from public.consultations            where organization_id = p_org and deleted_at is null),
    'srpa',       (select count(*) from public.recovery_records         where organization_id = p_org and deleted_at is null),
    'financeiro', (select count(*) from public.finance_entries          where organization_id = p_org and deleted_at is null),
    'pacientes',  (select count(*) from public.patients                 where organization_id = p_org and deleted_at is null),
    'documentos', (select count(*) from public.documents                where organization_id = p_org and deleted_at is null),
    'orcamentos', (select count(*) from public.quotes                   where organization_id = p_org and deleted_at is null),
    'agenda',     (select count(*) from public.appointments             where organization_id = p_org and deleted_at is null),
    'membros',    (select count(*) from public.organization_users       where organization_id = p_org and ativo)
  ) into v;
  return v;
end;
$function$;
CREATE OR REPLACE FUNCTION public.prog_criar_ambiente(p_nome text, p_email_gestor text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app', 'auth'
AS $function$
declare
  v_uid uuid; v_org uuid;
begin
  if not app.eh_programador() then
    raise exception 'Apenas o programador pode criar ambientes.';
  end if;
  if coalesce(trim(p_nome), '') = '' then
    raise exception 'Informe o nome do ambiente.';
  end if;
  select id into v_uid from auth.users where lower(email) = lower(trim(p_email_gestor)) limit 1;
  if v_uid is null then
    raise exception 'Nenhuma conta na nuvem com o e-mail %. Peça para o médico criar a conta primeiro (Entrar -> Criar conta).', p_email_gestor;
  end if;
  insert into public.organizations(nome) values (trim(p_nome)) returning id into v_org;
  insert into public.organization_users(organization_id, user_id, role, ativo)
    values (v_org, v_uid, 'gestor', true)
    on conflict (organization_id, user_id, role) do update set ativo = true;
  insert into public.profiles(id, nome, email, funcao, ativo)
    values (v_uid, split_part(p_email_gestor, '@', 1), p_email_gestor, 'gestor', true)
    on conflict (id) do update set ativo = true;
  return v_org;
end;
$function$;
CREATE OR REPLACE FUNCTION public.prog_excluir_ambiente(p_org uuid, p_confirmo_registros boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app', 'auth'
AS $function$
declare v_cont jsonb; v_nome text; v_total bigint;
begin
  if not app.eh_programador() then
    raise exception 'Apenas o programador pode excluir ambientes.';
  end if;
  select nome into v_nome from public.organizations where id = p_org;
  if v_nome is null then
    raise exception 'Ambiente não encontrado.';
  end if;
  v_cont := public.prog_contar_ambiente(p_org);
  select coalesce(sum(value::bigint), 0) into v_total
    from jsonb_each_text(v_cont - 'membros');
  if v_total > 0 and not coalesce(p_confirmo_registros, false) then
    raise exception 'O ambiente "%" tem % registro(s). Confirme explicitamente para excluir.', v_nome, v_total;
  end if;
  delete from public.organizations where id = p_org;
  return jsonb_build_object('nome', v_nome, 'apagados', v_cont);
end;
$function$;
CREATE OR REPLACE FUNCTION public.prog_excluir_conta(p_user uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app', 'auth'
AS $function$
declare v_email text; v_vinc int;
begin
  if not app.eh_programador() then
    raise exception 'Apenas o programador pode excluir contas.';
  end if;
  if p_user = auth.uid() then
    raise exception 'Você não pode excluir a sua própria conta por aqui.';
  end if;
  if exists (select 1 from public.app_programmers where user_id = p_user) then
    raise exception 'Esta conta é de um programador e não pode ser excluída por aqui.';
  end if;
  select count(*) into v_vinc from public.organization_users where user_id = p_user;
  if v_vinc > 0 then
    raise exception 'Esta conta ainda pertence a % ambiente(s). Remova-a de lá antes de excluir.', v_vinc;
  end if;
  select email into v_email from auth.users where id = p_user;
  delete from public.profiles where id = p_user;
  delete from auth.users where id = p_user;
  return jsonb_build_object('email', coalesce(v_email, ''), 'ok', true);
end;
$function$;
CREATE OR REPLACE FUNCTION public.prog_remover_membro(p_org uuid, p_user uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app', 'auth'
AS $function$
begin
  if not app.eh_programador() then
    raise exception 'Apenas o programador pode usar esta função.';
  end if;
  delete from public.organization_users where organization_id = p_org and user_id = p_user;
end;
$function$;
CREATE OR REPLACE FUNCTION public.refresh_medicamentos_clinicos()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ begin refresh materialized view public.medicamentos_clinicos; end $function$;
CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$;
create table "public"."addenda" (
 "id" uuid default gen_random_uuid() not null,
 "organization_id" uuid not null,
 "parent_table" text not null,
 "parent_id" uuid not null,
 "encounter_id" uuid,
 "patient_id" uuid,
 "texto" text not null,
 "data" jsonb default '{}'::jsonb not null,
 "created_by" uuid,
 "created_at" timestamp with time zone default now() not null,
 "legacy_id" text
);
create table "public"."anesthesia_records" (
 "id" uuid default gen_random_uuid() not null,
 "organization_id" uuid not null,
 "patient_id" uuid,
 "encounter_id" uuid,
 "preanesthetic_assessment_id" uuid,
 "preanesthetic_version" integer,
 "imported_at" timestamp with time zone,
 "imported_by" uuid,
 "imported_snapshot" jsonb,
 "status" text default 'draft'::text not null,
 "version" integer default 1 not null,
 "data" jsonb default '{}'::jsonb not null,
 "content_hash" text,
 "finalized_at" timestamp with time zone,
 "finalized_by" uuid,
 "created_by" uuid,
 "updated_by" uuid,
 "created_at" timestamp with time zone default now() not null,
 "updated_at" timestamp with time zone default now() not null,
 "deleted_at" timestamp with time zone,
 "device_id" text,
 "legacy_id" text
);
create table "public"."anesthesia_timeline_events" (
 "id" uuid default gen_random_uuid() not null,
 "organization_id" uuid not null,
 "encounter_id" uuid,
 "anesthesia_record_id" uuid not null,
 "ts" timestamp with time zone not null,
 "type" text not null,
 "subtype" text,
 "payload" jsonb default '{}'::jsonb not null,
 "created_by" uuid,
 "created_at" timestamp with time zone default now() not null,
 "updated_at" timestamp with time zone default now() not null,
 "deleted_at" timestamp with time zone
);
create table "public"."app_programmers" (
 "user_id" uuid not null,
 "criado_em" timestamp with time zone default now() not null
);
create table "public"."appointments" (
 "id" uuid default gen_random_uuid() not null,
 "organization_id" uuid not null,
 "patient_id" uuid,
 "encounter_id" uuid,
 "scheduled_at" timestamp with time zone,
 "status" text default 'agendado'::text not null,
 "data" jsonb default '{}'::jsonb not null,
 "created_by" uuid,
 "updated_by" uuid,
 "created_at" timestamp with time zone default now() not null,
 "updated_at" timestamp with time zone default now() not null,
 "deleted_at" timestamp with time zone,
 "legacy_id" text
);
create table "public"."assinaturas" (
 "id" uuid default gen_random_uuid() not null,
 "codigo" text not null,
 "modulo" text not null,
 "doc_id" text,
 "titulo" text not null,
 "paciente_ini" text,
 "profissional" text,
 "crm" text,
 "hash_doc" text not null,
 "algoritmo" text default 'SHA-256'::text not null,
 "provedor" text not null,
 "cert_emissor" text,
 "cert_serial" text,
 "cert_titular" text,
 "cadeia_icp" boolean,
 "versao" integer default 1 not null,
 "prev_hash" text,
 "self_hash" text not null,
 "assinado_em" timestamp with time zone default now() not null,
 "criado_em" timestamp with time zone default now() not null
);
create table "public"."attachments" (
 "id" uuid default gen_random_uuid() not null,
 "organization_id" uuid not null,
 "patient_id" uuid,
 "encounter_id" uuid,
 "module" text,
 "storage_path" text not null,
 "filename" text,
 "mime_type" text,
 "size" bigint,
 "hash" text,
 "uploaded_by" uuid,
 "uploaded_at" timestamp with time zone default now() not null,
 "deleted_at" timestamp with time zone
);
create table "public"."audit_logs" (
 "id" uuid default gen_random_uuid() not null,
 "organization_id" uuid,
 "user_id" uuid,
 "patient_id" uuid,
 "encounter_id" uuid,
 "module" text,
 "record_id" uuid,
 "action" text not null,
 "field_name" text,
 "previous_value" jsonb,
 "new_value" jsonb,
 "device_id" text,
 "ip" text,
 "user_agent" text,
 "created_at" timestamp with time zone default now() not null
);
create table "public"."consents" (
 "id" uuid default gen_random_uuid() not null,
 "organization_id" uuid not null,
 "patient_id" uuid,
 "encounter_id" uuid,
 "status" text default 'draft'::text not null,
 "version" integer default 1 not null,
 "data" jsonb default '{}'::jsonb not null,
 "content_hash" text,
 "finalized_at" timestamp with time zone,
 "finalized_by" uuid,
 "created_by" uuid,
 "updated_by" uuid,
 "created_at" timestamp with time zone default now() not null,
 "updated_at" timestamp with time zone default now() not null,
 "deleted_at" timestamp with time zone,
 "legacy_id" text
);
create table "public"."consultations" (
 "id" uuid default gen_random_uuid() not null,
 "organization_id" uuid not null,
 "patient_id" uuid,
 "encounter_id" uuid,
 "status" text default 'draft'::text not null,
 "version" integer default 1 not null,
 "data" jsonb default '{}'::jsonb not null,
 "content_hash" text,
 "finalized_at" timestamp with time zone,
 "finalized_by" uuid,
 "created_by" uuid,
 "updated_by" uuid,
 "created_at" timestamp with time zone default now() not null,
 "updated_at" timestamp with time zone default now() not null,
 "deleted_at" timestamp with time zone,
 "device_id" text,
 "legacy_id" text
);
create table "public"."documentos" (
 "id" bigint generated by default as identity (sequence name "public"."documentos_id_seq" start with 1 increment by 1 minvalue 1 maxvalue 9223372036854775807 cache 1 no cycle) not null,
 "user_id" uuid not null,
 "modulo" text not null,
 "doc_id" text not null,
 "dados" jsonb default '{}'::jsonb not null,
 "atualizado_em" timestamp with time zone default now() not null
);
create table "public"."documents" (
 "id" uuid default gen_random_uuid() not null,
 "organization_id" uuid not null,
 "patient_id" uuid,
 "encounter_id" uuid,
 "modelo" text,
 "status" text default 'draft'::text not null,
 "version" integer default 1 not null,
 "data" jsonb default '{}'::jsonb not null,
 "content_hash" text,
 "finalized_at" timestamp with time zone,
 "finalized_by" uuid,
 "created_by" uuid,
 "updated_by" uuid,
 "created_at" timestamp with time zone default now() not null,
 "updated_at" timestamp with time zone default now() not null,
 "deleted_at" timestamp with time zone,
 "legacy_id" text
);
create table "public"."encounters" (
 "id" uuid default gen_random_uuid() not null,
 "organization_id" uuid not null,
 "patient_id" uuid not null,
 "hospital_id" uuid,
 "room_id" uuid,
 "surgeon_id" uuid,
 "anesthesiologist_id" uuid,
 "procedimento" text,
 "tuss" text,
 "diagnostico" text,
 "lateralidade" text,
 "carater" text,
 "data_prevista" date,
 "hora_prevista" time without time zone,
 "status" text default 'agendado'::text not null,
 "senha" text,
 "convenio" text,
 "guia" text,
 "acomodacao" text,
 "data" jsonb default '{}'::jsonb not null,
 "created_by" uuid,
 "updated_by" uuid,
 "created_at" timestamp with time zone default now() not null,
 "updated_at" timestamp with time zone default now() not null,
 "deleted_at" timestamp with time zone,
 "legacy_id" text
);
create table "public"."equipment" (
 "id" uuid default gen_random_uuid() not null,
 "organization_id" uuid not null,
 "hospital_id" uuid,
 "nome" text not null,
 "tipo" text,
 "ativo" boolean default true not null,
 "data" jsonb default '{}'::jsonb not null,
 "created_at" timestamp with time zone default now() not null,
 "updated_at" timestamp with time zone default now() not null
);
create table "public"."finance_entries" (
 "id" uuid default gen_random_uuid() not null,
 "organization_id" uuid not null,
 "patient_id" uuid,
 "encounter_id" uuid,
 "status" text default 'rascunho'::text not null,
 "version" integer default 1 not null,
 "data" jsonb default '{}'::jsonb not null,
 "created_by" uuid,
 "updated_by" uuid,
 "created_at" timestamp with time zone default now() not null,
 "updated_at" timestamp with time zone default now() not null,
 "deleted_at" timestamp with time zone,
 "legacy_id" text
);
create table "public"."hospitals" (
 "id" uuid default gen_random_uuid() not null,
 "organization_id" uuid not null,
 "nome" text not null,
 "cnpj" text,
 "endereco" text,
 "ativo" boolean default true not null,
 "created_at" timestamp with time zone default now() not null,
 "updated_at" timestamp with time zone default now() not null
);
create table "public"."medicamentos" (
 "ggrem" text not null,
 "id_apresentacao" text default ''::text not null,
 "nome_comercial" text default ''::text not null,
 "nome_generico" text default ''::text not null,
 "principio_ativo" text default ''::text not null,
 "principio_base" text default ''::text not null,
 "concentracao" text default ''::text not null,
 "forma_farmaceutica" text default ''::text not null,
 "via_administracao" text default ''::text not null,
 "vias" text[] default '{}'::text[] not null,
 "via_definida" boolean default false not null,
 "injetavel_sem_via" boolean default false not null,
 "origem_via" text default ''::text not null,
 "apresentacao_original_anvisa" text default ''::text not null,
 "laboratorio" text default ''::text not null,
 "tipo_medicamento" text default ''::text not null,
 "tipo_entrada" text default ''::text not null,
 "registro_anvisa" text default ''::text not null,
 "ean" text default ''::text not null,
 "ean2" text default ''::text not null,
 "ean3" text default ''::text not null,
 "classe_terapeutica" text default ''::text not null,
 "regime_preco" text default ''::text not null,
 "comercializado" boolean default true not null,
 "fonte" text default ''::text not null,
 "ativo" boolean default true not null,
 "criado_em" timestamp with time zone default now() not null,
 "atualizado_em" timestamp with time zone default now() not null,
 "nome_comercial_norm" text generated always as (public.med_normalizar(nome_comercial)) stored,
 "nome_generico_norm" text generated always as (public.med_normalizar(nome_generico)) stored,
 "principio_norm" text generated always as (public.med_normalizar(principio_ativo)) stored,
 "busca_norm" text generated always as (((((public.med_normalizar(nome_comercial) || ' '::text) || public.med_normalizar(principio_ativo)) || ' '::text) || public.med_normalizar(nome_generico))) stored
);
create table "public"."medicamentos_base_versao" (
 "id" uuid default gen_random_uuid() not null,
 "fonte" text not null,
 "versao" text not null,
 "data_base" date,
 "quantidade_registros" integer default 0 not null,
 "arquivo_origem" text default ''::text not null,
 "novos" integer,
 "atualizados" integer,
 "ignorados" integer,
 "erros" integer,
 "importado_em" timestamp with time zone default now() not null,
 "importado_por" text default ''::text not null,
 "observacoes" text default ''::text not null
);
create table "public"."medicamentos_regras_anestesicas" (
 "id" uuid default gen_random_uuid() not null,
 "principio_base" text not null,
 "categoria" text default ''::text not null,
 "impacto_anestesico" text default ''::text not null,
 "orientacao_suspensao" text default ''::text not null,
 "dias_suspensao" text default ''::text not null,
 "orientacao_reinicio" text default ''::text not null,
 "alerta" text default ''::text not null,
 "gravidade" text default 'informativo'::text not null,
 "fonte" text default ''::text not null,
 "ultima_revisao" date,
 "revisado_por" text default ''::text not null,
 "ativo" boolean default true not null,
 "organization_id" uuid,
 "criado_em" timestamp with time zone default now() not null,
 "atualizado_em" timestamp with time zone default now() not null
);
create table "public"."org_configs" (
 "organization_id" uuid not null,
 "chave" text not null,
 "dados" jsonb default '{}'::jsonb not null,
 "updated_at" timestamp with time zone default now() not null,
 "updated_by" uuid
);
create table "public"."org_shares" (
 "id" uuid default gen_random_uuid() not null,
 "org_origem" uuid not null,
 "org_destino" uuid not null,
 "modulos" text[] default '{}'::text[] not null,
 "criado_por" uuid,
 "criado_em" timestamp with time zone default now() not null
);
create table "public"."organization_users" (
 "organization_id" uuid not null,
 "user_id" uuid not null,
 "role" text not null,
 "ativo" boolean default true not null,
 "created_at" timestamp with time zone default now() not null,
 "updated_at" timestamp with time zone default now() not null,
 "permissoes" jsonb
);
create table "public"."organizations" (
 "id" uuid default gen_random_uuid() not null,
 "nome" text not null,
 "cnpj" text,
 "endereco" text,
 "ativo" boolean default true not null,
 "created_at" timestamp with time zone default now() not null,
 "updated_at" timestamp with time zone default now() not null,
 "settings" jsonb default '{}'::jsonb not null
);
create table "public"."pacientes" (
 "id" uuid default gen_random_uuid() not null,
 "user_id" uuid default auth.uid() not null,
 "nome" text not null,
 "cpf" text,
 "data_nascimento" date,
 "telefone" text,
 "email" text,
 "convenio" text,
 "numero_carteirinha" text,
 "alergias" text,
 "comorbidades" text,
 "medicamentos_uso" text,
 "observacoes" text,
 "created_at" timestamp with time zone default now() not null,
 "updated_at" timestamp with time zone default now() not null
);
create table "public"."patients" (
 "id" uuid default gen_random_uuid() not null,
 "organization_id" uuid not null,
 "nome" text not null,
 "nome_social" text,
 "nascimento" date,
 "sexo" text,
 "cpf" text,
 "prontuario" text,
 "telefone" text,
 "email" text,
 "endereco" text,
 "responsavel" text,
 "responsavel_tel" text,
 "convenio" text,
 "carteirinha" text,
 "observacoes" text,
 "data" jsonb default '{}'::jsonb not null,
 "created_by" uuid,
 "updated_by" uuid,
 "created_at" timestamp with time zone default now() not null,
 "updated_at" timestamp with time zone default now() not null,
 "deleted_at" timestamp with time zone,
 "legacy_id" text
);
create table "public"."preanesthetic_assessments" (
 "id" uuid default gen_random_uuid() not null,
 "organization_id" uuid not null,
 "patient_id" uuid,
 "encounter_id" uuid,
 "status" text default 'draft'::text not null,
 "version" integer default 1 not null,
 "data" jsonb default '{}'::jsonb not null,
 "content_hash" text,
 "finalized_at" timestamp with time zone,
 "finalized_by" uuid,
 "created_by" uuid,
 "updated_by" uuid,
 "created_at" timestamp with time zone default now() not null,
 "updated_at" timestamp with time zone default now() not null,
 "deleted_at" timestamp with time zone,
 "device_id" text,
 "legacy_id" text
);
create table "public"."prescriptions" (
 "id" uuid default gen_random_uuid() not null,
 "organization_id" uuid not null,
 "patient_id" uuid,
 "encounter_id" uuid,
 "modelo" text,
 "status" text default 'draft'::text not null,
 "version" integer default 1 not null,
 "data" jsonb default '{}'::jsonb not null,
 "content_hash" text,
 "finalized_at" timestamp with time zone,
 "finalized_by" uuid,
 "created_by" uuid,
 "updated_by" uuid,
 "created_at" timestamp with time zone default now() not null,
 "updated_at" timestamp with time zone default now() not null,
 "deleted_at" timestamp with time zone,
 "legacy_id" text
);
create table "public"."profiles" (
 "id" uuid not null,
 "nome" text,
 "email" text,
 "celular" text,
 "crm" text,
 "crm_uf" text,
 "funcao" text,
 "organizacao" text,
 "hospital_id" uuid,
 "ativo" boolean default true not null,
 "created_at" timestamp with time zone default now() not null,
 "updated_at" timestamp with time zone default now() not null
);
create table "public"."quotes" (
 "id" uuid default gen_random_uuid() not null,
 "organization_id" uuid not null,
 "patient_id" uuid,
 "encounter_id" uuid,
 "status" text default 'draft'::text not null,
 "version" integer default 1 not null,
 "data" jsonb default '{}'::jsonb not null,
 "created_by" uuid,
 "updated_by" uuid,
 "created_at" timestamp with time zone default now() not null,
 "updated_at" timestamp with time zone default now() not null,
 "deleted_at" timestamp with time zone,
 "legacy_id" text
);
create table "public"."recovery_records" (
 "id" uuid default gen_random_uuid() not null,
 "organization_id" uuid not null,
 "patient_id" uuid,
 "encounter_id" uuid,
 "anesthesia_record_id" uuid,
 "status" text default 'draft'::text not null,
 "version" integer default 1 not null,
 "data" jsonb default '{}'::jsonb not null,
 "content_hash" text,
 "finalized_at" timestamp with time zone,
 "finalized_by" uuid,
 "created_by" uuid,
 "updated_by" uuid,
 "created_at" timestamp with time zone default now() not null,
 "updated_at" timestamp with time zone default now() not null,
 "deleted_at" timestamp with time zone,
 "device_id" text,
 "legacy_id" text
);
create table "public"."risk_assessments" (
 "id" uuid default gen_random_uuid() not null,
 "organization_id" uuid not null,
 "patient_id" uuid,
 "encounter_id" uuid,
 "status" text default 'draft'::text not null,
 "version" integer default 1 not null,
 "data" jsonb default '{}'::jsonb not null,
 "content_hash" text,
 "finalized_at" timestamp with time zone,
 "finalized_by" uuid,
 "created_by" uuid,
 "updated_by" uuid,
 "created_at" timestamp with time zone default now() not null,
 "updated_at" timestamp with time zone default now() not null,
 "deleted_at" timestamp with time zone,
 "legacy_id" text
);
create table "public"."rooms" (
 "id" uuid default gen_random_uuid() not null,
 "organization_id" uuid not null,
 "hospital_id" uuid,
 "nome" text not null,
 "ativo" boolean default true not null,
 "created_at" timestamp with time zone default now() not null,
 "updated_at" timestamp with time zone default now() not null
);
create table "public"."standard_texts" (
 "id" uuid default gen_random_uuid() not null,
 "organization_id" uuid not null,
 "owner_id" uuid,
 "chave" text not null,
 "texto" text,
 "data" jsonb default '{}'::jsonb not null,
 "created_at" timestamp with time zone default now() not null,
 "updated_at" timestamp with time zone default now() not null
);
create table "public"."templates" (
 "id" uuid default gen_random_uuid() not null,
 "organization_id" uuid not null,
 "owner_id" uuid,
 "categoria" text not null,
 "nome" text not null,
 "favorito" boolean default false not null,
 "padrao" boolean default false not null,
 "compartilhado" boolean default false not null,
 "data" jsonb default '{}'::jsonb not null,
 "created_at" timestamp with time zone default now() not null,
 "updated_at" timestamp with time zone default now() not null,
 "deleted_at" timestamp with time zone
);
alter table "public"."addenda" add constraint "addenda_pkey" PRIMARY KEY (id);
alter table "public"."anesthesia_records" add constraint "anesthesia_records_pkey" PRIMARY KEY (id);
alter table "public"."anesthesia_timeline_events" add constraint "anesthesia_timeline_events_pkey" PRIMARY KEY (id);
alter table "public"."anesthesia_timeline_events" add constraint "anesthesia_timeline_events_type_check" CHECK (type = ANY (ARRAY['vital'::text, 'medication'::text, 'fluid'::text, 'blood_product'::text, 'event'::text, 'procedure'::text, 'airway'::text, 'ventilation'::text, 'note'::text, 'urine_output'::text, 'blood_loss'::text, 'position_change'::text, 'antibiotic'::text, 'neuromuscular_monitoring'::text]));
alter table "public"."app_programmers" add constraint "app_programmers_pkey" PRIMARY KEY (user_id);
alter table "public"."appointments" add constraint "appointments_pkey" PRIMARY KEY (id);
alter table "public"."assinaturas" add constraint "assinaturas_codigo_key" UNIQUE (codigo);
alter table "public"."assinaturas" add constraint "assinaturas_pkey" PRIMARY KEY (id);
alter table "public"."attachments" add constraint "attachments_pkey" PRIMARY KEY (id);
alter table "public"."audit_logs" add constraint "audit_logs_pkey" PRIMARY KEY (id);
alter table "public"."consents" add constraint "consents_pkey" PRIMARY KEY (id);
alter table "public"."consultations" add constraint "consultations_pkey" PRIMARY KEY (id);
alter table "public"."documentos" add constraint "documentos_pkey" PRIMARY KEY (id);
alter table "public"."documentos" add constraint "documentos_user_id_modulo_doc_id_key" UNIQUE (user_id, modulo, doc_id);
alter table "public"."documents" add constraint "documents_pkey" PRIMARY KEY (id);
alter table "public"."encounters" add constraint "encounters_carater_check" CHECK ((carater = ANY (ARRAY['eletivo'::text, 'urgencia'::text, 'emergencia'::text])) OR carater IS NULL);
alter table "public"."encounters" add constraint "encounters_pkey" PRIMARY KEY (id);
alter table "public"."equipment" add constraint "equipment_pkey" PRIMARY KEY (id);
alter table "public"."finance_entries" add constraint "finance_entries_pkey" PRIMARY KEY (id);
alter table "public"."hospitals" add constraint "hospitals_pkey" PRIMARY KEY (id);
alter table "public"."medicamentos" add constraint "medicamentos_pkey" PRIMARY KEY (ggrem);
alter table "public"."medicamentos_base_versao" add constraint "medicamentos_base_versao_fonte_versao_key" UNIQUE (fonte, versao);
alter table "public"."medicamentos_base_versao" add constraint "medicamentos_base_versao_pkey" PRIMARY KEY (id);
alter table "public"."medicamentos_regras_anestesicas" add constraint "medicamentos_regras_anestesic_principio_base_organization_i_key" UNIQUE (principio_base, organization_id, categoria);
alter table "public"."medicamentos_regras_anestesicas" add constraint "medicamentos_regras_anestesicas_pkey" PRIMARY KEY (id);
alter table "public"."org_configs" add constraint "org_configs_pkey" PRIMARY KEY (organization_id, chave);
alter table "public"."org_shares" add constraint "org_shares_org_origem_org_destino_key" UNIQUE (org_origem, org_destino);
alter table "public"."org_shares" add constraint "org_shares_pkey" PRIMARY KEY (id);
alter table "public"."organization_users" add constraint "organization_users_pkey" PRIMARY KEY (organization_id, user_id, role);
alter table "public"."organization_users" add constraint "organization_users_role_check" CHECK (role = ANY (ARRAY['gestor'::text, 'anestesiologista'::text, 'cirurgiao'::text, 'auxiliar'::text, 'financeiro'::text, 'empresa'::text]));
alter table "public"."organizations" add constraint "organizations_pkey" PRIMARY KEY (id);
alter table "public"."pacientes" add constraint "pacientes_pkey" PRIMARY KEY (id);
alter table "public"."patients" add constraint "patients_pkey" PRIMARY KEY (id);
alter table "public"."preanesthetic_assessments" add constraint "preanesthetic_assessments_pkey" PRIMARY KEY (id);
alter table "public"."prescriptions" add constraint "prescriptions_pkey" PRIMARY KEY (id);
alter table "public"."profiles" add constraint "profiles_pkey" PRIMARY KEY (id);
alter table "public"."quotes" add constraint "quotes_pkey" PRIMARY KEY (id);
alter table "public"."recovery_records" add constraint "recovery_records_pkey" PRIMARY KEY (id);
alter table "public"."risk_assessments" add constraint "risk_assessments_pkey" PRIMARY KEY (id);
alter table "public"."rooms" add constraint "rooms_pkey" PRIMARY KEY (id);
alter table "public"."standard_texts" add constraint "standard_texts_pkey" PRIMARY KEY (id);
alter table "public"."templates" add constraint "templates_pkey" PRIMARY KEY (id);
alter table "public"."addenda" add constraint "addenda_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id);
alter table "public"."addenda" add constraint "addenda_encounter_id_fkey" FOREIGN KEY (encounter_id) REFERENCES public.encounters(id) ON DELETE SET NULL;
alter table "public"."addenda" add constraint "addenda_organization_id_fkey" FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
alter table "public"."addenda" add constraint "addenda_patient_id_fkey" FOREIGN KEY (patient_id) REFERENCES public.patients(id) ON DELETE SET NULL;
alter table "public"."anesthesia_records" add constraint "anesthesia_records_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id);
alter table "public"."anesthesia_records" add constraint "anesthesia_records_encounter_id_fkey" FOREIGN KEY (encounter_id) REFERENCES public.encounters(id) ON DELETE SET NULL;
alter table "public"."anesthesia_records" add constraint "anesthesia_records_finalized_by_fkey" FOREIGN KEY (finalized_by) REFERENCES auth.users(id);
alter table "public"."anesthesia_records" add constraint "anesthesia_records_imported_by_fkey" FOREIGN KEY (imported_by) REFERENCES auth.users(id);
alter table "public"."anesthesia_records" add constraint "anesthesia_records_organization_id_fkey" FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
alter table "public"."anesthesia_records" add constraint "anesthesia_records_patient_id_fkey" FOREIGN KEY (patient_id) REFERENCES public.patients(id) ON DELETE SET NULL;
alter table "public"."anesthesia_records" add constraint "anesthesia_records_preanesthetic_assessment_id_fkey" FOREIGN KEY (preanesthetic_assessment_id) REFERENCES public.preanesthetic_assessments(id) ON DELETE SET NULL;
alter table "public"."anesthesia_records" add constraint "anesthesia_records_updated_by_fkey" FOREIGN KEY (updated_by) REFERENCES auth.users(id);
alter table "public"."anesthesia_timeline_events" add constraint "anesthesia_timeline_events_anesthesia_record_id_fkey" FOREIGN KEY (anesthesia_record_id) REFERENCES public.anesthesia_records(id) ON DELETE CASCADE;
alter table "public"."anesthesia_timeline_events" add constraint "anesthesia_timeline_events_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id);
alter table "public"."anesthesia_timeline_events" add constraint "anesthesia_timeline_events_encounter_id_fkey" FOREIGN KEY (encounter_id) REFERENCES public.encounters(id) ON DELETE SET NULL;
alter table "public"."anesthesia_timeline_events" add constraint "anesthesia_timeline_events_organization_id_fkey" FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
alter table "public"."app_programmers" add constraint "app_programmers_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table "public"."appointments" add constraint "appointments_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id);
alter table "public"."appointments" add constraint "appointments_encounter_id_fkey" FOREIGN KEY (encounter_id) REFERENCES public.encounters(id) ON DELETE SET NULL;
alter table "public"."appointments" add constraint "appointments_organization_id_fkey" FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
alter table "public"."appointments" add constraint "appointments_patient_id_fkey" FOREIGN KEY (patient_id) REFERENCES public.patients(id) ON DELETE SET NULL;
alter table "public"."appointments" add constraint "appointments_updated_by_fkey" FOREIGN KEY (updated_by) REFERENCES auth.users(id);
alter table "public"."attachments" add constraint "attachments_encounter_id_fkey" FOREIGN KEY (encounter_id) REFERENCES public.encounters(id) ON DELETE SET NULL;
alter table "public"."attachments" add constraint "attachments_organization_id_fkey" FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
alter table "public"."attachments" add constraint "attachments_patient_id_fkey" FOREIGN KEY (patient_id) REFERENCES public.patients(id) ON DELETE SET NULL;
alter table "public"."attachments" add constraint "attachments_uploaded_by_fkey" FOREIGN KEY (uploaded_by) REFERENCES auth.users(id);
alter table "public"."consents" add constraint "consents_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id);
alter table "public"."consents" add constraint "consents_encounter_id_fkey" FOREIGN KEY (encounter_id) REFERENCES public.encounters(id) ON DELETE SET NULL;
alter table "public"."consents" add constraint "consents_finalized_by_fkey" FOREIGN KEY (finalized_by) REFERENCES auth.users(id);
alter table "public"."consents" add constraint "consents_organization_id_fkey" FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
alter table "public"."consents" add constraint "consents_patient_id_fkey" FOREIGN KEY (patient_id) REFERENCES public.patients(id) ON DELETE SET NULL;
alter table "public"."consents" add constraint "consents_updated_by_fkey" FOREIGN KEY (updated_by) REFERENCES auth.users(id);
alter table "public"."consultations" add constraint "consultations_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id);
alter table "public"."consultations" add constraint "consultations_encounter_id_fkey" FOREIGN KEY (encounter_id) REFERENCES public.encounters(id) ON DELETE SET NULL;
alter table "public"."consultations" add constraint "consultations_finalized_by_fkey" FOREIGN KEY (finalized_by) REFERENCES auth.users(id);
alter table "public"."consultations" add constraint "consultations_organization_id_fkey" FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
alter table "public"."consultations" add constraint "consultations_patient_id_fkey" FOREIGN KEY (patient_id) REFERENCES public.patients(id) ON DELETE SET NULL;
alter table "public"."consultations" add constraint "consultations_updated_by_fkey" FOREIGN KEY (updated_by) REFERENCES auth.users(id);
alter table "public"."documentos" add constraint "documentos_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table "public"."documents" add constraint "documents_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id);
alter table "public"."documents" add constraint "documents_encounter_id_fkey" FOREIGN KEY (encounter_id) REFERENCES public.encounters(id) ON DELETE SET NULL;
alter table "public"."documents" add constraint "documents_finalized_by_fkey" FOREIGN KEY (finalized_by) REFERENCES auth.users(id);
alter table "public"."documents" add constraint "documents_organization_id_fkey" FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
alter table "public"."documents" add constraint "documents_patient_id_fkey" FOREIGN KEY (patient_id) REFERENCES public.patients(id) ON DELETE SET NULL;
alter table "public"."documents" add constraint "documents_updated_by_fkey" FOREIGN KEY (updated_by) REFERENCES auth.users(id);
alter table "public"."encounters" add constraint "encounters_anesthesiologist_id_fkey" FOREIGN KEY (anesthesiologist_id) REFERENCES auth.users(id) ON DELETE SET NULL;
alter table "public"."encounters" add constraint "encounters_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id);
alter table "public"."encounters" add constraint "encounters_hospital_id_fkey" FOREIGN KEY (hospital_id) REFERENCES public.hospitals(id) ON DELETE SET NULL;
alter table "public"."encounters" add constraint "encounters_organization_id_fkey" FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
alter table "public"."encounters" add constraint "encounters_patient_id_fkey" FOREIGN KEY (patient_id) REFERENCES public.patients(id) ON DELETE RESTRICT;
alter table "public"."encounters" add constraint "encounters_room_id_fkey" FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE SET NULL;
alter table "public"."encounters" add constraint "encounters_surgeon_id_fkey" FOREIGN KEY (surgeon_id) REFERENCES auth.users(id) ON DELETE SET NULL;
alter table "public"."encounters" add constraint "encounters_updated_by_fkey" FOREIGN KEY (updated_by) REFERENCES auth.users(id);
alter table "public"."equipment" add constraint "equipment_hospital_id_fkey" FOREIGN KEY (hospital_id) REFERENCES public.hospitals(id) ON DELETE SET NULL;
alter table "public"."equipment" add constraint "equipment_organization_id_fkey" FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
alter table "public"."finance_entries" add constraint "finance_entries_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id);
alter table "public"."finance_entries" add constraint "finance_entries_encounter_id_fkey" FOREIGN KEY (encounter_id) REFERENCES public.encounters(id) ON DELETE SET NULL;
alter table "public"."finance_entries" add constraint "finance_entries_organization_id_fkey" FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
alter table "public"."finance_entries" add constraint "finance_entries_patient_id_fkey" FOREIGN KEY (patient_id) REFERENCES public.patients(id) ON DELETE SET NULL;
alter table "public"."finance_entries" add constraint "finance_entries_updated_by_fkey" FOREIGN KEY (updated_by) REFERENCES auth.users(id);
alter table "public"."hospitals" add constraint "hospitals_organization_id_fkey" FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
alter table "public"."org_configs" add constraint "org_configs_organization_id_fkey" FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
alter table "public"."org_shares" add constraint "org_shares_criado_por_fkey" FOREIGN KEY (criado_por) REFERENCES auth.users(id);
alter table "public"."org_shares" add constraint "org_shares_org_destino_fkey" FOREIGN KEY (org_destino) REFERENCES public.organizations(id) ON DELETE CASCADE;
alter table "public"."org_shares" add constraint "org_shares_org_origem_fkey" FOREIGN KEY (org_origem) REFERENCES public.organizations(id) ON DELETE CASCADE;
alter table "public"."organization_users" add constraint "organization_users_organization_id_fkey" FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
alter table "public"."organization_users" add constraint "organization_users_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table "public"."pacientes" add constraint "pacientes_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table "public"."patients" add constraint "patients_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id);
alter table "public"."patients" add constraint "patients_organization_id_fkey" FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
alter table "public"."patients" add constraint "patients_updated_by_fkey" FOREIGN KEY (updated_by) REFERENCES auth.users(id);
alter table "public"."preanesthetic_assessments" add constraint "preanesthetic_assessments_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id);
alter table "public"."preanesthetic_assessments" add constraint "preanesthetic_assessments_encounter_id_fkey" FOREIGN KEY (encounter_id) REFERENCES public.encounters(id) ON DELETE SET NULL;
alter table "public"."preanesthetic_assessments" add constraint "preanesthetic_assessments_finalized_by_fkey" FOREIGN KEY (finalized_by) REFERENCES auth.users(id);
alter table "public"."preanesthetic_assessments" add constraint "preanesthetic_assessments_organization_id_fkey" FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
alter table "public"."preanesthetic_assessments" add constraint "preanesthetic_assessments_patient_id_fkey" FOREIGN KEY (patient_id) REFERENCES public.patients(id) ON DELETE SET NULL;
alter table "public"."preanesthetic_assessments" add constraint "preanesthetic_assessments_updated_by_fkey" FOREIGN KEY (updated_by) REFERENCES auth.users(id);
alter table "public"."prescriptions" add constraint "prescriptions_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id);
alter table "public"."prescriptions" add constraint "prescriptions_encounter_id_fkey" FOREIGN KEY (encounter_id) REFERENCES public.encounters(id) ON DELETE SET NULL;
alter table "public"."prescriptions" add constraint "prescriptions_finalized_by_fkey" FOREIGN KEY (finalized_by) REFERENCES auth.users(id);
alter table "public"."prescriptions" add constraint "prescriptions_organization_id_fkey" FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
alter table "public"."prescriptions" add constraint "prescriptions_patient_id_fkey" FOREIGN KEY (patient_id) REFERENCES public.patients(id) ON DELETE SET NULL;
alter table "public"."prescriptions" add constraint "prescriptions_updated_by_fkey" FOREIGN KEY (updated_by) REFERENCES auth.users(id);
alter table "public"."profiles" add constraint "profiles_hospital_id_fkey" FOREIGN KEY (hospital_id) REFERENCES public.hospitals(id) ON DELETE SET NULL;
alter table "public"."profiles" add constraint "profiles_id_fkey" FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table "public"."quotes" add constraint "quotes_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id);
alter table "public"."quotes" add constraint "quotes_encounter_id_fkey" FOREIGN KEY (encounter_id) REFERENCES public.encounters(id) ON DELETE SET NULL;
alter table "public"."quotes" add constraint "quotes_organization_id_fkey" FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
alter table "public"."quotes" add constraint "quotes_patient_id_fkey" FOREIGN KEY (patient_id) REFERENCES public.patients(id) ON DELETE SET NULL;
alter table "public"."quotes" add constraint "quotes_updated_by_fkey" FOREIGN KEY (updated_by) REFERENCES auth.users(id);
alter table "public"."recovery_records" add constraint "recovery_records_anesthesia_record_id_fkey" FOREIGN KEY (anesthesia_record_id) REFERENCES public.anesthesia_records(id) ON DELETE SET NULL;
alter table "public"."recovery_records" add constraint "recovery_records_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id);
alter table "public"."recovery_records" add constraint "recovery_records_encounter_id_fkey" FOREIGN KEY (encounter_id) REFERENCES public.encounters(id) ON DELETE SET NULL;
alter table "public"."recovery_records" add constraint "recovery_records_finalized_by_fkey" FOREIGN KEY (finalized_by) REFERENCES auth.users(id);
alter table "public"."recovery_records" add constraint "recovery_records_organization_id_fkey" FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
alter table "public"."recovery_records" add constraint "recovery_records_patient_id_fkey" FOREIGN KEY (patient_id) REFERENCES public.patients(id) ON DELETE SET NULL;
alter table "public"."recovery_records" add constraint "recovery_records_updated_by_fkey" FOREIGN KEY (updated_by) REFERENCES auth.users(id);
alter table "public"."risk_assessments" add constraint "risk_assessments_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id);
alter table "public"."risk_assessments" add constraint "risk_assessments_encounter_id_fkey" FOREIGN KEY (encounter_id) REFERENCES public.encounters(id) ON DELETE SET NULL;
alter table "public"."risk_assessments" add constraint "risk_assessments_finalized_by_fkey" FOREIGN KEY (finalized_by) REFERENCES auth.users(id);
alter table "public"."risk_assessments" add constraint "risk_assessments_organization_id_fkey" FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
alter table "public"."risk_assessments" add constraint "risk_assessments_patient_id_fkey" FOREIGN KEY (patient_id) REFERENCES public.patients(id) ON DELETE SET NULL;
alter table "public"."risk_assessments" add constraint "risk_assessments_updated_by_fkey" FOREIGN KEY (updated_by) REFERENCES auth.users(id);
alter table "public"."rooms" add constraint "rooms_hospital_id_fkey" FOREIGN KEY (hospital_id) REFERENCES public.hospitals(id) ON DELETE SET NULL;
alter table "public"."rooms" add constraint "rooms_organization_id_fkey" FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
alter table "public"."standard_texts" add constraint "standard_texts_organization_id_fkey" FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
alter table "public"."standard_texts" add constraint "standard_texts_owner_id_fkey" FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE SET NULL;
alter table "public"."templates" add constraint "templates_organization_id_fkey" FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;
alter table "public"."templates" add constraint "templates_owner_id_fkey" FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE SET NULL;
create view "public"."assinaturas_publicas" as SELECT codigo,
    titulo,
    paciente_ini,
    profissional,
    crm,
    hash_doc,
    algoritmo,
    provedor,
    cert_emissor,
    cert_serial,
    cert_titular,
    cadeia_icp,
    versao,
    assinado_em
   FROM public.assinaturas;
create materialized view "public"."medicamentos_clinicos" as SELECT min(ggrem) AS ggrem,
    min(id_apresentacao) AS id_apresentacao,
    min(nome_comercial) AS nome_comercial,
    min(nome_generico) AS nome_generico,
    min(principio_ativo) AS principio_ativo,
    min(principio_base) AS principio_base,
    min(concentracao) AS concentracao,
    min(forma_farmaceutica) AS forma_farmaceutica,
    min(via_administracao) AS via_administracao,
    max(via_definida::integer)::boolean AS via_definida,
    max(injetavel_sem_via::integer)::boolean AS injetavel_sem_via,
    tipo_medicamento,
    min(laboratorio) AS laboratorio,
    min(registro_anvisa) AS registro_anvisa,
    min(classe_terapeutica) AS classe_terapeutica,
    max(comercializado::integer)::boolean AS comercializado,
    count(*) AS quantas_apresentacoes,
    nome_comercial_norm,
    principio_norm,
    min(nome_generico_norm) AS nome_generico_norm,
    (((nome_comercial_norm || ' '::text) || principio_norm) || ' '::text) || min(nome_generico_norm) AS busca_norm
   FROM public.medicamentos m
  WHERE ativo
  GROUP BY nome_comercial_norm, principio_norm, (public.med_normalizar(concentracao)), (public.med_normalizar(forma_farmaceutica)), (public.med_normalizar(via_administracao)), tipo_medicamento with no data;
CREATE INDEX addenda_parent_idx ON public.addenda USING btree (parent_table, parent_id);
CREATE UNIQUE INDEX ux_addenda_org_legacy ON public.addenda USING btree (organization_id, legacy_id);
CREATE INDEX anes_enc_idx ON public.anesthesia_records USING btree (encounter_id);
CREATE INDEX anes_org_idx ON public.anesthesia_records USING btree (organization_id);
CREATE INDEX anes_pat_idx ON public.anesthesia_records USING btree (patient_id);
CREATE UNIQUE INDEX ux_anesthesia_records_legacy ON public.anesthesia_records USING btree (organization_id, legacy_id);
CREATE INDEX tl_org_idx ON public.anesthesia_timeline_events USING btree (organization_id);
CREATE INDEX tl_record_ts_idx ON public.anesthesia_timeline_events USING btree (anesthesia_record_id, ts);
CREATE INDEX tl_type_idx ON public.anesthesia_timeline_events USING btree (anesthesia_record_id, type);
CREATE INDEX ix_appointments_patient ON public.appointments USING btree (patient_id);
CREATE INDEX ix_appointments_when ON public.appointments USING btree (scheduled_at);
CREATE UNIQUE INDEX ux_appointments_legacy ON public.appointments USING btree (organization_id, legacy_id);
CREATE INDEX assinaturas_codigo_idx ON public.assinaturas USING btree (codigo);
CREATE INDEX assinaturas_docid_idx ON public.assinaturas USING btree (modulo, doc_id);
CREATE INDEX assinaturas_hash_idx ON public.assinaturas USING btree (hash_doc);
CREATE INDEX att_hash_idx ON public.attachments USING btree (organization_id, hash);
CREATE INDEX att_org_idx ON public.attachments USING btree (organization_id);
CREATE INDEX att_pat_idx ON public.attachments USING btree (patient_id);
CREATE UNIQUE INDEX ux_attachments_org_path ON public.attachments USING btree (organization_id, storage_path);
CREATE INDEX audit_org_idx ON public.audit_logs USING btree (organization_id, created_at DESC);
CREATE INDEX audit_patient_idx ON public.audit_logs USING btree (patient_id);
CREATE INDEX audit_record_idx ON public.audit_logs USING btree (record_id);
CREATE INDEX cons_enc_idx ON public.consents USING btree (encounter_id);
CREATE UNIQUE INDEX ux_consents_legacy ON public.consents USING btree (organization_id, legacy_id);
CREATE INDEX ix_consultations_patient ON public.consultations USING btree (patient_id);
CREATE UNIQUE INDEX ux_consultations_legacy ON public.consultations USING btree (organization_id, legacy_id);
CREATE INDEX documentos_user_idx ON public.documentos USING btree (user_id, modulo);
CREATE INDEX doc_pat_idx ON public.documents USING btree (patient_id);
CREATE UNIQUE INDEX ux_documents_legacy ON public.documents USING btree (organization_id, legacy_id);
CREATE INDEX enc_anesth_idx ON public.encounters USING btree (anesthesiologist_id);
CREATE INDEX enc_data_idx ON public.encounters USING btree (organization_id, data_prevista);
CREATE INDEX enc_org_idx ON public.encounters USING btree (organization_id);
CREATE INDEX enc_patient_idx ON public.encounters USING btree (patient_id);
CREATE INDEX enc_surgeon_idx ON public.encounters USING btree (surgeon_id);
CREATE UNIQUE INDEX ux_encounters_legacy ON public.encounters USING btree (organization_id, legacy_id);
CREATE INDEX fin_enc_idx ON public.finance_entries USING btree (encounter_id);
CREATE INDEX fin_org_idx ON public.finance_entries USING btree (organization_id);
CREATE UNIQUE INDEX ux_finance_entries_legacy ON public.finance_entries USING btree (organization_id, legacy_id);
CREATE INDEX idx_med_base ON public.medicamentos USING btree (principio_base);
CREATE INDEX idx_med_busca_trgm ON public.medicamentos USING gin (busca_norm public.gin_trgm_ops);
CREATE INDEX idx_med_ean ON public.medicamentos USING btree (ean);
CREATE INDEX idx_med_generico_pref ON public.medicamentos USING btree (nome_generico_norm text_pattern_ops);
CREATE INDEX idx_med_idapres ON public.medicamentos USING btree (id_apresentacao);
CREATE INDEX idx_med_nome_pref ON public.medicamentos USING btree (nome_comercial_norm text_pattern_ops);
CREATE INDEX idx_med_principio_pref ON public.medicamentos USING btree (principio_norm text_pattern_ops);
CREATE INDEX idx_med_registro ON public.medicamentos USING btree (registro_anvisa);
CREATE INDEX idx_med_tipo ON public.medicamentos USING btree (tipo_medicamento);
CREATE INDEX idx_medclin_base ON public.medicamentos_clinicos USING btree (principio_base);
CREATE INDEX idx_medclin_busca_trgm ON public.medicamentos_clinicos USING gin (busca_norm public.gin_trgm_ops);
CREATE INDEX idx_medclin_gener_pref ON public.medicamentos_clinicos USING btree (nome_generico_norm text_pattern_ops);
CREATE INDEX idx_medclin_nome_pref ON public.medicamentos_clinicos USING btree (nome_comercial_norm text_pattern_ops);
CREATE INDEX idx_medclin_nome_trgm ON public.medicamentos_clinicos USING gin (nome_comercial_norm public.gin_trgm_ops);
CREATE UNIQUE INDEX idx_medclin_pk ON public.medicamentos_clinicos USING btree (ggrem);
CREATE INDEX idx_medclin_princ_pref ON public.medicamentos_clinicos USING btree (principio_norm text_pattern_ops);
CREATE INDEX idx_medclin_princ_trgm ON public.medicamentos_clinicos USING gin (principio_norm public.gin_trgm_ops);
CREATE INDEX idx_medclin_tipo ON public.medicamentos_clinicos USING btree (tipo_medicamento);
CREATE INDEX idx_medregra_base ON public.medicamentos_regras_anestesicas USING btree (principio_base) WHERE ativo;
CREATE INDEX idx_medregra_org ON public.medicamentos_regras_anestesicas USING btree (organization_id) WHERE ativo;
CREATE INDEX org_configs_org_idx ON public.org_configs USING btree (organization_id);
CREATE INDEX pacientes_nome_idx ON public.pacientes USING btree (nome);
CREATE INDEX pacientes_user_id_idx ON public.pacientes USING btree (user_id);
CREATE INDEX patients_cpf_idx ON public.patients USING btree (organization_id, cpf);
CREATE INDEX patients_nasc_idx ON public.patients USING btree (organization_id, nascimento);
CREATE INDEX patients_nome_idx ON public.patients USING btree (organization_id, lower(nome));
CREATE INDEX patients_org_idx ON public.patients USING btree (organization_id);
CREATE INDEX patients_prontuario_idx ON public.patients USING btree (organization_id, prontuario);
CREATE UNIQUE INDEX ux_patients_legacy ON public.patients USING btree (organization_id, legacy_id);
CREATE INDEX pre_enc_idx ON public.preanesthetic_assessments USING btree (encounter_id);
CREATE INDEX pre_org_idx ON public.preanesthetic_assessments USING btree (organization_id);
CREATE INDEX pre_pat_idx ON public.preanesthetic_assessments USING btree (patient_id);
CREATE UNIQUE INDEX ux_preanesthetic_assessments_legacy ON public.preanesthetic_assessments USING btree (organization_id, legacy_id);
CREATE INDEX presc_pat_idx ON public.prescriptions USING btree (patient_id);
CREATE UNIQUE INDEX ux_prescriptions_legacy ON public.prescriptions USING btree (organization_id, legacy_id);
CREATE INDEX ix_quotes_patient ON public.quotes USING btree (patient_id);
CREATE UNIQUE INDEX ux_quotes_legacy ON public.quotes USING btree (organization_id, legacy_id);
CREATE INDEX rec_enc_idx ON public.recovery_records USING btree (encounter_id);
CREATE UNIQUE INDEX ux_recovery_records_legacy ON public.recovery_records USING btree (organization_id, legacy_id);
CREATE INDEX risk_enc_idx ON public.risk_assessments USING btree (encounter_id);
CREATE UNIQUE INDEX ux_risk_assessments_legacy ON public.risk_assessments USING btree (organization_id, legacy_id);
CREATE INDEX tpl_org_cat_idx ON public.templates USING btree (organization_id, categoria);
CREATE INDEX tpl_owner_idx ON public.templates USING btree (owner_id);
alter table "public"."addenda" alter column "id" set storage plain;
alter table "public"."addenda" alter column "organization_id" set storage plain;
alter table "public"."addenda" alter column "parent_table" set storage extended;
alter table "public"."addenda" alter column "parent_id" set storage plain;
alter table "public"."addenda" alter column "encounter_id" set storage plain;
alter table "public"."addenda" alter column "patient_id" set storage plain;
alter table "public"."addenda" alter column "texto" set storage extended;
alter table "public"."addenda" alter column "data" set storage extended;
alter table "public"."addenda" alter column "created_by" set storage plain;
alter table "public"."addenda" alter column "created_at" set storage plain;
alter table "public"."addenda" alter column "legacy_id" set storage extended;
alter table "public"."anesthesia_records" alter column "id" set storage plain;
alter table "public"."anesthesia_records" alter column "organization_id" set storage plain;
alter table "public"."anesthesia_records" alter column "patient_id" set storage plain;
alter table "public"."anesthesia_records" alter column "encounter_id" set storage plain;
alter table "public"."anesthesia_records" alter column "preanesthetic_assessment_id" set storage plain;
alter table "public"."anesthesia_records" alter column "preanesthetic_version" set storage plain;
alter table "public"."anesthesia_records" alter column "imported_at" set storage plain;
alter table "public"."anesthesia_records" alter column "imported_by" set storage plain;
alter table "public"."anesthesia_records" alter column "imported_snapshot" set storage extended;
alter table "public"."anesthesia_records" alter column "status" set storage extended;
alter table "public"."anesthesia_records" alter column "version" set storage plain;
alter table "public"."anesthesia_records" alter column "data" set storage extended;
alter table "public"."anesthesia_records" alter column "content_hash" set storage extended;
alter table "public"."anesthesia_records" alter column "finalized_at" set storage plain;
alter table "public"."anesthesia_records" alter column "finalized_by" set storage plain;
alter table "public"."anesthesia_records" alter column "created_by" set storage plain;
alter table "public"."anesthesia_records" alter column "updated_by" set storage plain;
alter table "public"."anesthesia_records" alter column "created_at" set storage plain;
alter table "public"."anesthesia_records" alter column "updated_at" set storage plain;
alter table "public"."anesthesia_records" alter column "deleted_at" set storage plain;
alter table "public"."anesthesia_records" alter column "device_id" set storage extended;
alter table "public"."anesthesia_records" alter column "legacy_id" set storage extended;
alter table "public"."anesthesia_timeline_events" alter column "id" set storage plain;
alter table "public"."anesthesia_timeline_events" alter column "organization_id" set storage plain;
alter table "public"."anesthesia_timeline_events" alter column "encounter_id" set storage plain;
alter table "public"."anesthesia_timeline_events" alter column "anesthesia_record_id" set storage plain;
alter table "public"."anesthesia_timeline_events" alter column "ts" set storage plain;
alter table "public"."anesthesia_timeline_events" alter column "type" set storage extended;
alter table "public"."anesthesia_timeline_events" alter column "subtype" set storage extended;
alter table "public"."anesthesia_timeline_events" alter column "payload" set storage extended;
alter table "public"."anesthesia_timeline_events" alter column "created_by" set storage plain;
alter table "public"."anesthesia_timeline_events" alter column "created_at" set storage plain;
alter table "public"."anesthesia_timeline_events" alter column "updated_at" set storage plain;
alter table "public"."anesthesia_timeline_events" alter column "deleted_at" set storage plain;
alter table "public"."app_programmers" alter column "user_id" set storage plain;
alter table "public"."app_programmers" alter column "criado_em" set storage plain;
alter table "public"."appointments" alter column "id" set storage plain;
alter table "public"."appointments" alter column "organization_id" set storage plain;
alter table "public"."appointments" alter column "patient_id" set storage plain;
alter table "public"."appointments" alter column "encounter_id" set storage plain;
alter table "public"."appointments" alter column "scheduled_at" set storage plain;
alter table "public"."appointments" alter column "status" set storage extended;
alter table "public"."appointments" alter column "data" set storage extended;
alter table "public"."appointments" alter column "created_by" set storage plain;
alter table "public"."appointments" alter column "updated_by" set storage plain;
alter table "public"."appointments" alter column "created_at" set storage plain;
alter table "public"."appointments" alter column "updated_at" set storage plain;
alter table "public"."appointments" alter column "deleted_at" set storage plain;
alter table "public"."appointments" alter column "legacy_id" set storage extended;
alter table "public"."assinaturas" alter column "id" set storage plain;
alter table "public"."assinaturas" alter column "codigo" set storage extended;
alter table "public"."assinaturas" alter column "modulo" set storage extended;
alter table "public"."assinaturas" alter column "doc_id" set storage extended;
alter table "public"."assinaturas" alter column "titulo" set storage extended;
alter table "public"."assinaturas" alter column "paciente_ini" set storage extended;
alter table "public"."assinaturas" alter column "profissional" set storage extended;
alter table "public"."assinaturas" alter column "crm" set storage extended;
alter table "public"."assinaturas" alter column "hash_doc" set storage extended;
alter table "public"."assinaturas" alter column "algoritmo" set storage extended;
alter table "public"."assinaturas" alter column "provedor" set storage extended;
alter table "public"."assinaturas" alter column "cert_emissor" set storage extended;
alter table "public"."assinaturas" alter column "cert_serial" set storage extended;
alter table "public"."assinaturas" alter column "cert_titular" set storage extended;
alter table "public"."assinaturas" alter column "cadeia_icp" set storage plain;
alter table "public"."assinaturas" alter column "versao" set storage plain;
alter table "public"."assinaturas" alter column "prev_hash" set storage extended;
alter table "public"."assinaturas" alter column "self_hash" set storage extended;
alter table "public"."assinaturas" alter column "assinado_em" set storage plain;
alter table "public"."assinaturas" alter column "criado_em" set storage plain;
alter table "public"."attachments" alter column "id" set storage plain;
alter table "public"."attachments" alter column "organization_id" set storage plain;
alter table "public"."attachments" alter column "patient_id" set storage plain;
alter table "public"."attachments" alter column "encounter_id" set storage plain;
alter table "public"."attachments" alter column "module" set storage extended;
alter table "public"."attachments" alter column "storage_path" set storage extended;
alter table "public"."attachments" alter column "filename" set storage extended;
alter table "public"."attachments" alter column "mime_type" set storage extended;
alter table "public"."attachments" alter column "size" set storage plain;
alter table "public"."attachments" alter column "hash" set storage extended;
alter table "public"."attachments" alter column "uploaded_by" set storage plain;
alter table "public"."attachments" alter column "uploaded_at" set storage plain;
alter table "public"."attachments" alter column "deleted_at" set storage plain;
alter table "public"."audit_logs" alter column "id" set storage plain;
alter table "public"."audit_logs" alter column "organization_id" set storage plain;
alter table "public"."audit_logs" alter column "user_id" set storage plain;
alter table "public"."audit_logs" alter column "patient_id" set storage plain;
alter table "public"."audit_logs" alter column "encounter_id" set storage plain;
alter table "public"."audit_logs" alter column "module" set storage extended;
alter table "public"."audit_logs" alter column "record_id" set storage plain;
alter table "public"."audit_logs" alter column "action" set storage extended;
alter table "public"."audit_logs" alter column "field_name" set storage extended;
alter table "public"."audit_logs" alter column "previous_value" set storage extended;
alter table "public"."audit_logs" alter column "new_value" set storage extended;
alter table "public"."audit_logs" alter column "device_id" set storage extended;
alter table "public"."audit_logs" alter column "ip" set storage extended;
alter table "public"."audit_logs" alter column "user_agent" set storage extended;
alter table "public"."audit_logs" alter column "created_at" set storage plain;
alter table "public"."consents" alter column "id" set storage plain;
alter table "public"."consents" alter column "organization_id" set storage plain;
alter table "public"."consents" alter column "patient_id" set storage plain;
alter table "public"."consents" alter column "encounter_id" set storage plain;
alter table "public"."consents" alter column "status" set storage extended;
alter table "public"."consents" alter column "version" set storage plain;
alter table "public"."consents" alter column "data" set storage extended;
alter table "public"."consents" alter column "content_hash" set storage extended;
alter table "public"."consents" alter column "finalized_at" set storage plain;
alter table "public"."consents" alter column "finalized_by" set storage plain;
alter table "public"."consents" alter column "created_by" set storage plain;
alter table "public"."consents" alter column "updated_by" set storage plain;
alter table "public"."consents" alter column "created_at" set storage plain;
alter table "public"."consents" alter column "updated_at" set storage plain;
alter table "public"."consents" alter column "deleted_at" set storage plain;
alter table "public"."consents" alter column "legacy_id" set storage extended;
alter table "public"."consultations" alter column "id" set storage plain;
alter table "public"."consultations" alter column "organization_id" set storage plain;
alter table "public"."consultations" alter column "patient_id" set storage plain;
alter table "public"."consultations" alter column "encounter_id" set storage plain;
alter table "public"."consultations" alter column "status" set storage extended;
alter table "public"."consultations" alter column "version" set storage plain;
alter table "public"."consultations" alter column "data" set storage extended;
alter table "public"."consultations" alter column "content_hash" set storage extended;
alter table "public"."consultations" alter column "finalized_at" set storage plain;
alter table "public"."consultations" alter column "finalized_by" set storage plain;
alter table "public"."consultations" alter column "created_by" set storage plain;
alter table "public"."consultations" alter column "updated_by" set storage plain;
alter table "public"."consultations" alter column "created_at" set storage plain;
alter table "public"."consultations" alter column "updated_at" set storage plain;
alter table "public"."consultations" alter column "deleted_at" set storage plain;
alter table "public"."consultations" alter column "device_id" set storage extended;
alter table "public"."consultations" alter column "legacy_id" set storage extended;
alter table "public"."documentos" alter column "id" set storage plain;
alter table "public"."documentos" alter column "user_id" set storage plain;
alter table "public"."documentos" alter column "modulo" set storage extended;
alter table "public"."documentos" alter column "doc_id" set storage extended;
alter table "public"."documentos" alter column "dados" set storage extended;
alter table "public"."documentos" alter column "atualizado_em" set storage plain;
alter table "public"."documents" alter column "id" set storage plain;
alter table "public"."documents" alter column "organization_id" set storage plain;
alter table "public"."documents" alter column "patient_id" set storage plain;
alter table "public"."documents" alter column "encounter_id" set storage plain;
alter table "public"."documents" alter column "modelo" set storage extended;
alter table "public"."documents" alter column "status" set storage extended;
alter table "public"."documents" alter column "version" set storage plain;
alter table "public"."documents" alter column "data" set storage extended;
alter table "public"."documents" alter column "content_hash" set storage extended;
alter table "public"."documents" alter column "finalized_at" set storage plain;
alter table "public"."documents" alter column "finalized_by" set storage plain;
alter table "public"."documents" alter column "created_by" set storage plain;
alter table "public"."documents" alter column "updated_by" set storage plain;
alter table "public"."documents" alter column "created_at" set storage plain;
alter table "public"."documents" alter column "updated_at" set storage plain;
alter table "public"."documents" alter column "deleted_at" set storage plain;
alter table "public"."documents" alter column "legacy_id" set storage extended;
alter table "public"."encounters" alter column "id" set storage plain;
alter table "public"."encounters" alter column "organization_id" set storage plain;
alter table "public"."encounters" alter column "patient_id" set storage plain;
alter table "public"."encounters" alter column "hospital_id" set storage plain;
alter table "public"."encounters" alter column "room_id" set storage plain;
alter table "public"."encounters" alter column "surgeon_id" set storage plain;
alter table "public"."encounters" alter column "anesthesiologist_id" set storage plain;
alter table "public"."encounters" alter column "procedimento" set storage extended;
alter table "public"."encounters" alter column "tuss" set storage extended;
alter table "public"."encounters" alter column "diagnostico" set storage extended;
alter table "public"."encounters" alter column "lateralidade" set storage extended;
alter table "public"."encounters" alter column "carater" set storage extended;
alter table "public"."encounters" alter column "data_prevista" set storage plain;
alter table "public"."encounters" alter column "hora_prevista" set storage plain;
alter table "public"."encounters" alter column "status" set storage extended;
alter table "public"."encounters" alter column "senha" set storage extended;
alter table "public"."encounters" alter column "convenio" set storage extended;
alter table "public"."encounters" alter column "guia" set storage extended;
alter table "public"."encounters" alter column "acomodacao" set storage extended;
alter table "public"."encounters" alter column "data" set storage extended;
alter table "public"."encounters" alter column "created_by" set storage plain;
alter table "public"."encounters" alter column "updated_by" set storage plain;
alter table "public"."encounters" alter column "created_at" set storage plain;
alter table "public"."encounters" alter column "updated_at" set storage plain;
alter table "public"."encounters" alter column "deleted_at" set storage plain;
alter table "public"."encounters" alter column "legacy_id" set storage extended;
alter table "public"."equipment" alter column "id" set storage plain;
alter table "public"."equipment" alter column "organization_id" set storage plain;
alter table "public"."equipment" alter column "hospital_id" set storage plain;
alter table "public"."equipment" alter column "nome" set storage extended;
alter table "public"."equipment" alter column "tipo" set storage extended;
alter table "public"."equipment" alter column "ativo" set storage plain;
alter table "public"."equipment" alter column "data" set storage extended;
alter table "public"."equipment" alter column "created_at" set storage plain;
alter table "public"."equipment" alter column "updated_at" set storage plain;
alter table "public"."finance_entries" alter column "id" set storage plain;
alter table "public"."finance_entries" alter column "organization_id" set storage plain;
alter table "public"."finance_entries" alter column "patient_id" set storage plain;
alter table "public"."finance_entries" alter column "encounter_id" set storage plain;
alter table "public"."finance_entries" alter column "status" set storage extended;
alter table "public"."finance_entries" alter column "version" set storage plain;
alter table "public"."finance_entries" alter column "data" set storage extended;
alter table "public"."finance_entries" alter column "created_by" set storage plain;
alter table "public"."finance_entries" alter column "updated_by" set storage plain;
alter table "public"."finance_entries" alter column "created_at" set storage plain;
alter table "public"."finance_entries" alter column "updated_at" set storage plain;
alter table "public"."finance_entries" alter column "deleted_at" set storage plain;
alter table "public"."finance_entries" alter column "legacy_id" set storage extended;
alter table "public"."hospitals" alter column "id" set storage plain;
alter table "public"."hospitals" alter column "organization_id" set storage plain;
alter table "public"."hospitals" alter column "nome" set storage extended;
alter table "public"."hospitals" alter column "cnpj" set storage extended;
alter table "public"."hospitals" alter column "endereco" set storage extended;
alter table "public"."hospitals" alter column "ativo" set storage plain;
alter table "public"."hospitals" alter column "created_at" set storage plain;
alter table "public"."hospitals" alter column "updated_at" set storage plain;
alter table "public"."medicamentos" alter column "ggrem" set storage extended;
alter table "public"."medicamentos" alter column "id_apresentacao" set storage extended;
alter table "public"."medicamentos" alter column "nome_comercial" set storage extended;
alter table "public"."medicamentos" alter column "nome_generico" set storage extended;
alter table "public"."medicamentos" alter column "principio_ativo" set storage extended;
alter table "public"."medicamentos" alter column "principio_base" set storage extended;
alter table "public"."medicamentos" alter column "concentracao" set storage extended;
alter table "public"."medicamentos" alter column "forma_farmaceutica" set storage extended;
alter table "public"."medicamentos" alter column "via_administracao" set storage extended;
alter table "public"."medicamentos" alter column "vias" set storage extended;
alter table "public"."medicamentos" alter column "via_definida" set storage plain;
alter table "public"."medicamentos" alter column "injetavel_sem_via" set storage plain;
alter table "public"."medicamentos" alter column "origem_via" set storage extended;
alter table "public"."medicamentos" alter column "apresentacao_original_anvisa" set storage extended;
alter table "public"."medicamentos" alter column "laboratorio" set storage extended;
alter table "public"."medicamentos" alter column "tipo_medicamento" set storage extended;
alter table "public"."medicamentos" alter column "tipo_entrada" set storage extended;
alter table "public"."medicamentos" alter column "registro_anvisa" set storage extended;
alter table "public"."medicamentos" alter column "ean" set storage extended;
alter table "public"."medicamentos" alter column "ean2" set storage extended;
alter table "public"."medicamentos" alter column "ean3" set storage extended;
alter table "public"."medicamentos" alter column "classe_terapeutica" set storage extended;
alter table "public"."medicamentos" alter column "regime_preco" set storage extended;
alter table "public"."medicamentos" alter column "comercializado" set storage plain;
alter table "public"."medicamentos" alter column "fonte" set storage extended;
alter table "public"."medicamentos" alter column "ativo" set storage plain;
alter table "public"."medicamentos" alter column "criado_em" set storage plain;
alter table "public"."medicamentos" alter column "atualizado_em" set storage plain;
alter table "public"."medicamentos" alter column "nome_comercial_norm" set storage extended;
alter table "public"."medicamentos" alter column "nome_generico_norm" set storage extended;
alter table "public"."medicamentos" alter column "principio_norm" set storage extended;
alter table "public"."medicamentos" alter column "busca_norm" set storage extended;
alter table "public"."medicamentos_base_versao" alter column "id" set storage plain;
alter table "public"."medicamentos_base_versao" alter column "fonte" set storage extended;
alter table "public"."medicamentos_base_versao" alter column "versao" set storage extended;
alter table "public"."medicamentos_base_versao" alter column "data_base" set storage plain;
alter table "public"."medicamentos_base_versao" alter column "quantidade_registros" set storage plain;
alter table "public"."medicamentos_base_versao" alter column "arquivo_origem" set storage extended;
alter table "public"."medicamentos_base_versao" alter column "novos" set storage plain;
alter table "public"."medicamentos_base_versao" alter column "atualizados" set storage plain;
alter table "public"."medicamentos_base_versao" alter column "ignorados" set storage plain;
alter table "public"."medicamentos_base_versao" alter column "erros" set storage plain;
alter table "public"."medicamentos_base_versao" alter column "importado_em" set storage plain;
alter table "public"."medicamentos_base_versao" alter column "importado_por" set storage extended;
alter table "public"."medicamentos_base_versao" alter column "observacoes" set storage extended;
alter table "public"."medicamentos_regras_anestesicas" alter column "id" set storage plain;
alter table "public"."medicamentos_regras_anestesicas" alter column "principio_base" set storage extended;
alter table "public"."medicamentos_regras_anestesicas" alter column "categoria" set storage extended;
alter table "public"."medicamentos_regras_anestesicas" alter column "impacto_anestesico" set storage extended;
alter table "public"."medicamentos_regras_anestesicas" alter column "orientacao_suspensao" set storage extended;
alter table "public"."medicamentos_regras_anestesicas" alter column "dias_suspensao" set storage extended;
alter table "public"."medicamentos_regras_anestesicas" alter column "orientacao_reinicio" set storage extended;
alter table "public"."medicamentos_regras_anestesicas" alter column "alerta" set storage extended;
alter table "public"."medicamentos_regras_anestesicas" alter column "gravidade" set storage extended;
alter table "public"."medicamentos_regras_anestesicas" alter column "fonte" set storage extended;
alter table "public"."medicamentos_regras_anestesicas" alter column "ultima_revisao" set storage plain;
alter table "public"."medicamentos_regras_anestesicas" alter column "revisado_por" set storage extended;
alter table "public"."medicamentos_regras_anestesicas" alter column "ativo" set storage plain;
alter table "public"."medicamentos_regras_anestesicas" alter column "organization_id" set storage plain;
alter table "public"."medicamentos_regras_anestesicas" alter column "criado_em" set storage plain;
alter table "public"."medicamentos_regras_anestesicas" alter column "atualizado_em" set storage plain;
alter table "public"."org_configs" alter column "organization_id" set storage plain;
alter table "public"."org_configs" alter column "chave" set storage extended;
alter table "public"."org_configs" alter column "dados" set storage extended;
alter table "public"."org_configs" alter column "updated_at" set storage plain;
alter table "public"."org_configs" alter column "updated_by" set storage plain;
alter table "public"."org_shares" alter column "id" set storage plain;
alter table "public"."org_shares" alter column "org_origem" set storage plain;
alter table "public"."org_shares" alter column "org_destino" set storage plain;
alter table "public"."org_shares" alter column "modulos" set storage extended;
alter table "public"."org_shares" alter column "criado_por" set storage plain;
alter table "public"."org_shares" alter column "criado_em" set storage plain;
alter table "public"."organization_users" alter column "organization_id" set storage plain;
alter table "public"."organization_users" alter column "user_id" set storage plain;
alter table "public"."organization_users" alter column "role" set storage extended;
alter table "public"."organization_users" alter column "ativo" set storage plain;
alter table "public"."organization_users" alter column "created_at" set storage plain;
alter table "public"."organization_users" alter column "updated_at" set storage plain;
alter table "public"."organization_users" alter column "permissoes" set storage extended;
alter table "public"."organizations" alter column "id" set storage plain;
alter table "public"."organizations" alter column "nome" set storage extended;
alter table "public"."organizations" alter column "cnpj" set storage extended;
alter table "public"."organizations" alter column "endereco" set storage extended;
alter table "public"."organizations" alter column "ativo" set storage plain;
alter table "public"."organizations" alter column "created_at" set storage plain;
alter table "public"."organizations" alter column "updated_at" set storage plain;
alter table "public"."organizations" alter column "settings" set storage extended;
alter table "public"."pacientes" alter column "id" set storage plain;
alter table "public"."pacientes" alter column "user_id" set storage plain;
alter table "public"."pacientes" alter column "nome" set storage extended;
alter table "public"."pacientes" alter column "cpf" set storage extended;
alter table "public"."pacientes" alter column "data_nascimento" set storage plain;
alter table "public"."pacientes" alter column "telefone" set storage extended;
alter table "public"."pacientes" alter column "email" set storage extended;
alter table "public"."pacientes" alter column "convenio" set storage extended;
alter table "public"."pacientes" alter column "numero_carteirinha" set storage extended;
alter table "public"."pacientes" alter column "alergias" set storage extended;
alter table "public"."pacientes" alter column "comorbidades" set storage extended;
alter table "public"."pacientes" alter column "medicamentos_uso" set storage extended;
alter table "public"."pacientes" alter column "observacoes" set storage extended;
alter table "public"."pacientes" alter column "created_at" set storage plain;
alter table "public"."pacientes" alter column "updated_at" set storage plain;
alter table "public"."patients" alter column "id" set storage plain;
alter table "public"."patients" alter column "organization_id" set storage plain;
alter table "public"."patients" alter column "nome" set storage extended;
alter table "public"."patients" alter column "nome_social" set storage extended;
alter table "public"."patients" alter column "nascimento" set storage plain;
alter table "public"."patients" alter column "sexo" set storage extended;
alter table "public"."patients" alter column "cpf" set storage extended;
alter table "public"."patients" alter column "prontuario" set storage extended;
alter table "public"."patients" alter column "telefone" set storage extended;
alter table "public"."patients" alter column "email" set storage extended;
alter table "public"."patients" alter column "endereco" set storage extended;
alter table "public"."patients" alter column "responsavel" set storage extended;
alter table "public"."patients" alter column "responsavel_tel" set storage extended;
alter table "public"."patients" alter column "convenio" set storage extended;
alter table "public"."patients" alter column "carteirinha" set storage extended;
alter table "public"."patients" alter column "observacoes" set storage extended;
alter table "public"."patients" alter column "data" set storage extended;
alter table "public"."patients" alter column "created_by" set storage plain;
alter table "public"."patients" alter column "updated_by" set storage plain;
alter table "public"."patients" alter column "created_at" set storage plain;
alter table "public"."patients" alter column "updated_at" set storage plain;
alter table "public"."patients" alter column "deleted_at" set storage plain;
alter table "public"."patients" alter column "legacy_id" set storage extended;
alter table "public"."preanesthetic_assessments" alter column "id" set storage plain;
alter table "public"."preanesthetic_assessments" alter column "organization_id" set storage plain;
alter table "public"."preanesthetic_assessments" alter column "patient_id" set storage plain;
alter table "public"."preanesthetic_assessments" alter column "encounter_id" set storage plain;
alter table "public"."preanesthetic_assessments" alter column "status" set storage extended;
alter table "public"."preanesthetic_assessments" alter column "version" set storage plain;
alter table "public"."preanesthetic_assessments" alter column "data" set storage extended;
alter table "public"."preanesthetic_assessments" alter column "content_hash" set storage extended;
alter table "public"."preanesthetic_assessments" alter column "finalized_at" set storage plain;
alter table "public"."preanesthetic_assessments" alter column "finalized_by" set storage plain;
alter table "public"."preanesthetic_assessments" alter column "created_by" set storage plain;
alter table "public"."preanesthetic_assessments" alter column "updated_by" set storage plain;
alter table "public"."preanesthetic_assessments" alter column "created_at" set storage plain;
alter table "public"."preanesthetic_assessments" alter column "updated_at" set storage plain;
alter table "public"."preanesthetic_assessments" alter column "deleted_at" set storage plain;
alter table "public"."preanesthetic_assessments" alter column "device_id" set storage extended;
alter table "public"."preanesthetic_assessments" alter column "legacy_id" set storage extended;
alter table "public"."prescriptions" alter column "id" set storage plain;
alter table "public"."prescriptions" alter column "organization_id" set storage plain;
alter table "public"."prescriptions" alter column "patient_id" set storage plain;
alter table "public"."prescriptions" alter column "encounter_id" set storage plain;
alter table "public"."prescriptions" alter column "modelo" set storage extended;
alter table "public"."prescriptions" alter column "status" set storage extended;
alter table "public"."prescriptions" alter column "version" set storage plain;
alter table "public"."prescriptions" alter column "data" set storage extended;
alter table "public"."prescriptions" alter column "content_hash" set storage extended;
alter table "public"."prescriptions" alter column "finalized_at" set storage plain;
alter table "public"."prescriptions" alter column "finalized_by" set storage plain;
alter table "public"."prescriptions" alter column "created_by" set storage plain;
alter table "public"."prescriptions" alter column "updated_by" set storage plain;
alter table "public"."prescriptions" alter column "created_at" set storage plain;
alter table "public"."prescriptions" alter column "updated_at" set storage plain;
alter table "public"."prescriptions" alter column "deleted_at" set storage plain;
alter table "public"."prescriptions" alter column "legacy_id" set storage extended;
alter table "public"."profiles" alter column "id" set storage plain;
alter table "public"."profiles" alter column "nome" set storage extended;
alter table "public"."profiles" alter column "email" set storage extended;
alter table "public"."profiles" alter column "celular" set storage extended;
alter table "public"."profiles" alter column "crm" set storage extended;
alter table "public"."profiles" alter column "crm_uf" set storage extended;
alter table "public"."profiles" alter column "funcao" set storage extended;
alter table "public"."profiles" alter column "organizacao" set storage extended;
alter table "public"."profiles" alter column "hospital_id" set storage plain;
alter table "public"."profiles" alter column "ativo" set storage plain;
alter table "public"."profiles" alter column "created_at" set storage plain;
alter table "public"."profiles" alter column "updated_at" set storage plain;
alter table "public"."quotes" alter column "id" set storage plain;
alter table "public"."quotes" alter column "organization_id" set storage plain;
alter table "public"."quotes" alter column "patient_id" set storage plain;
alter table "public"."quotes" alter column "encounter_id" set storage plain;
alter table "public"."quotes" alter column "status" set storage extended;
alter table "public"."quotes" alter column "version" set storage plain;
alter table "public"."quotes" alter column "data" set storage extended;
alter table "public"."quotes" alter column "created_by" set storage plain;
alter table "public"."quotes" alter column "updated_by" set storage plain;
alter table "public"."quotes" alter column "created_at" set storage plain;
alter table "public"."quotes" alter column "updated_at" set storage plain;
alter table "public"."quotes" alter column "deleted_at" set storage plain;
alter table "public"."quotes" alter column "legacy_id" set storage extended;
alter table "public"."recovery_records" alter column "id" set storage plain;
alter table "public"."recovery_records" alter column "organization_id" set storage plain;
alter table "public"."recovery_records" alter column "patient_id" set storage plain;
alter table "public"."recovery_records" alter column "encounter_id" set storage plain;
alter table "public"."recovery_records" alter column "anesthesia_record_id" set storage plain;
alter table "public"."recovery_records" alter column "status" set storage extended;
alter table "public"."recovery_records" alter column "version" set storage plain;
alter table "public"."recovery_records" alter column "data" set storage extended;
alter table "public"."recovery_records" alter column "content_hash" set storage extended;
alter table "public"."recovery_records" alter column "finalized_at" set storage plain;
alter table "public"."recovery_records" alter column "finalized_by" set storage plain;
alter table "public"."recovery_records" alter column "created_by" set storage plain;
alter table "public"."recovery_records" alter column "updated_by" set storage plain;
alter table "public"."recovery_records" alter column "created_at" set storage plain;
alter table "public"."recovery_records" alter column "updated_at" set storage plain;
alter table "public"."recovery_records" alter column "deleted_at" set storage plain;
alter table "public"."recovery_records" alter column "device_id" set storage extended;
alter table "public"."recovery_records" alter column "legacy_id" set storage extended;
alter table "public"."risk_assessments" alter column "id" set storage plain;
alter table "public"."risk_assessments" alter column "organization_id" set storage plain;
alter table "public"."risk_assessments" alter column "patient_id" set storage plain;
alter table "public"."risk_assessments" alter column "encounter_id" set storage plain;
alter table "public"."risk_assessments" alter column "status" set storage extended;
alter table "public"."risk_assessments" alter column "version" set storage plain;
alter table "public"."risk_assessments" alter column "data" set storage extended;
alter table "public"."risk_assessments" alter column "content_hash" set storage extended;
alter table "public"."risk_assessments" alter column "finalized_at" set storage plain;
alter table "public"."risk_assessments" alter column "finalized_by" set storage plain;
alter table "public"."risk_assessments" alter column "created_by" set storage plain;
alter table "public"."risk_assessments" alter column "updated_by" set storage plain;
alter table "public"."risk_assessments" alter column "created_at" set storage plain;
alter table "public"."risk_assessments" alter column "updated_at" set storage plain;
alter table "public"."risk_assessments" alter column "deleted_at" set storage plain;
alter table "public"."risk_assessments" alter column "legacy_id" set storage extended;
alter table "public"."rooms" alter column "id" set storage plain;
alter table "public"."rooms" alter column "organization_id" set storage plain;
alter table "public"."rooms" alter column "hospital_id" set storage plain;
alter table "public"."rooms" alter column "nome" set storage extended;
alter table "public"."rooms" alter column "ativo" set storage plain;
alter table "public"."rooms" alter column "created_at" set storage plain;
alter table "public"."rooms" alter column "updated_at" set storage plain;
alter table "public"."standard_texts" alter column "id" set storage plain;
alter table "public"."standard_texts" alter column "organization_id" set storage plain;
alter table "public"."standard_texts" alter column "owner_id" set storage plain;
alter table "public"."standard_texts" alter column "chave" set storage extended;
alter table "public"."standard_texts" alter column "texto" set storage extended;
alter table "public"."standard_texts" alter column "data" set storage extended;
alter table "public"."standard_texts" alter column "created_at" set storage plain;
alter table "public"."standard_texts" alter column "updated_at" set storage plain;
alter table "public"."templates" alter column "id" set storage plain;
alter table "public"."templates" alter column "organization_id" set storage plain;
alter table "public"."templates" alter column "owner_id" set storage plain;
alter table "public"."templates" alter column "categoria" set storage extended;
alter table "public"."templates" alter column "nome" set storage extended;
alter table "public"."templates" alter column "favorito" set storage plain;
alter table "public"."templates" alter column "padrao" set storage plain;
alter table "public"."templates" alter column "compartilhado" set storage plain;
alter table "public"."templates" alter column "data" set storage extended;
alter table "public"."templates" alter column "created_at" set storage plain;
alter table "public"."templates" alter column "updated_at" set storage plain;
alter table "public"."templates" alter column "deleted_at" set storage plain;
alter table "public"."addenda" owner to postgres;
alter table "public"."addenda" enable row level security;
alter table "public"."addenda" no force row level security;
alter table "public"."addenda" replica identity default;
alter table "public"."anesthesia_records" owner to postgres;
alter table "public"."anesthesia_records" enable row level security;
alter table "public"."anesthesia_records" no force row level security;
alter table "public"."anesthesia_records" replica identity full;
alter table "public"."anesthesia_timeline_events" owner to postgres;
alter table "public"."anesthesia_timeline_events" enable row level security;
alter table "public"."anesthesia_timeline_events" no force row level security;
alter table "public"."anesthesia_timeline_events" replica identity full;
alter table "public"."app_programmers" owner to postgres;
alter table "public"."app_programmers" enable row level security;
alter table "public"."app_programmers" no force row level security;
alter table "public"."app_programmers" replica identity default;
alter table "public"."appointments" owner to postgres;
alter table "public"."appointments" enable row level security;
alter table "public"."appointments" no force row level security;
alter table "public"."appointments" replica identity full;
alter table "public"."assinaturas" owner to postgres;
alter table "public"."assinaturas" enable row level security;
alter table "public"."assinaturas" no force row level security;
alter table "public"."assinaturas" replica identity default;
alter view "public"."assinaturas_publicas" owner to postgres;
alter table "public"."attachments" owner to postgres;
alter table "public"."attachments" enable row level security;
alter table "public"."attachments" no force row level security;
alter table "public"."attachments" replica identity default;
alter table "public"."audit_logs" owner to postgres;
alter table "public"."audit_logs" enable row level security;
alter table "public"."audit_logs" no force row level security;
alter table "public"."audit_logs" replica identity default;
alter table "public"."consents" owner to postgres;
alter table "public"."consents" enable row level security;
alter table "public"."consents" no force row level security;
alter table "public"."consents" replica identity full;
alter table "public"."consultations" owner to postgres;
alter table "public"."consultations" enable row level security;
alter table "public"."consultations" no force row level security;
alter table "public"."consultations" replica identity full;
alter table "public"."documentos" owner to postgres;
alter table "public"."documentos" enable row level security;
alter table "public"."documentos" no force row level security;
alter table "public"."documentos" replica identity default;
alter table "public"."documents" owner to postgres;
alter table "public"."documents" enable row level security;
alter table "public"."documents" no force row level security;
alter table "public"."documents" replica identity default;
alter table "public"."encounters" owner to postgres;
alter table "public"."encounters" enable row level security;
alter table "public"."encounters" no force row level security;
alter table "public"."encounters" replica identity full;
alter table "public"."equipment" owner to postgres;
alter table "public"."equipment" enable row level security;
alter table "public"."equipment" no force row level security;
alter table "public"."equipment" replica identity default;
alter table "public"."finance_entries" owner to postgres;
alter table "public"."finance_entries" enable row level security;
alter table "public"."finance_entries" no force row level security;
alter table "public"."finance_entries" replica identity full;
alter table "public"."hospitals" owner to postgres;
alter table "public"."hospitals" enable row level security;
alter table "public"."hospitals" no force row level security;
alter table "public"."hospitals" replica identity default;
alter table "public"."medicamentos" owner to postgres;
alter table "public"."medicamentos" enable row level security;
alter table "public"."medicamentos" no force row level security;
alter table "public"."medicamentos" replica identity default;
alter table "public"."medicamentos_base_versao" owner to postgres;
alter table "public"."medicamentos_base_versao" enable row level security;
alter table "public"."medicamentos_base_versao" no force row level security;
alter table "public"."medicamentos_base_versao" replica identity default;
alter materialized view "public"."medicamentos_clinicos" owner to postgres;
alter table "public"."medicamentos_regras_anestesicas" owner to postgres;
alter table "public"."medicamentos_regras_anestesicas" enable row level security;
alter table "public"."medicamentos_regras_anestesicas" no force row level security;
alter table "public"."medicamentos_regras_anestesicas" replica identity default;
alter table "public"."org_configs" owner to postgres;
alter table "public"."org_configs" enable row level security;
alter table "public"."org_configs" no force row level security;
alter table "public"."org_configs" replica identity default;
alter table "public"."org_shares" owner to postgres;
alter table "public"."org_shares" enable row level security;
alter table "public"."org_shares" no force row level security;
alter table "public"."org_shares" replica identity default;
alter table "public"."organization_users" owner to postgres;
alter table "public"."organization_users" enable row level security;
alter table "public"."organization_users" no force row level security;
alter table "public"."organization_users" replica identity default;
alter table "public"."organizations" owner to postgres;
alter table "public"."organizations" enable row level security;
alter table "public"."organizations" no force row level security;
alter table "public"."organizations" replica identity default;
alter table "public"."pacientes" owner to postgres;
alter table "public"."pacientes" enable row level security;
alter table "public"."pacientes" no force row level security;
alter table "public"."pacientes" replica identity default;
alter table "public"."patients" owner to postgres;
alter table "public"."patients" enable row level security;
alter table "public"."patients" no force row level security;
alter table "public"."patients" replica identity full;
alter table "public"."preanesthetic_assessments" owner to postgres;
alter table "public"."preanesthetic_assessments" enable row level security;
alter table "public"."preanesthetic_assessments" no force row level security;
alter table "public"."preanesthetic_assessments" replica identity full;
alter table "public"."prescriptions" owner to postgres;
alter table "public"."prescriptions" enable row level security;
alter table "public"."prescriptions" no force row level security;
alter table "public"."prescriptions" replica identity default;
alter table "public"."profiles" owner to postgres;
alter table "public"."profiles" enable row level security;
alter table "public"."profiles" no force row level security;
alter table "public"."profiles" replica identity default;
alter table "public"."quotes" owner to postgres;
alter table "public"."quotes" enable row level security;
alter table "public"."quotes" no force row level security;
alter table "public"."quotes" replica identity full;
alter table "public"."recovery_records" owner to postgres;
alter table "public"."recovery_records" enable row level security;
alter table "public"."recovery_records" no force row level security;
alter table "public"."recovery_records" replica identity full;
alter table "public"."risk_assessments" owner to postgres;
alter table "public"."risk_assessments" enable row level security;
alter table "public"."risk_assessments" no force row level security;
alter table "public"."risk_assessments" replica identity full;
alter table "public"."rooms" owner to postgres;
alter table "public"."rooms" enable row level security;
alter table "public"."rooms" no force row level security;
alter table "public"."rooms" replica identity default;
alter table "public"."standard_texts" owner to postgres;
alter table "public"."standard_texts" enable row level security;
alter table "public"."standard_texts" no force row level security;
alter table "public"."standard_texts" replica identity default;
alter table "public"."templates" owner to postgres;
alter table "public"."templates" enable row level security;
alter table "public"."templates" no force row level security;
alter table "public"."templates" replica identity default;
reset role;
drop policy if exists "addenda_sel" on "public"."addenda";
create policy "addenda_sel" on "public"."addenda" as permissive for select to public using ((organization_id IN ( SELECT app.org_ids() AS org_ids)));
drop policy if exists "addenda_wr" on "public"."addenda";
create policy "addenda_wr" on "public"."addenda" as permissive for insert to public with check (app.can_write_clinical(organization_id));
drop policy if exists "anesthesia_records_sel" on "public"."anesthesia_records";
create policy "anesthesia_records_sel" on "public"."anesthesia_records" as permissive for select to public using (((organization_id IN ( SELECT app.org_ids() AS org_ids)) AND app.pode_modulo(organization_id, 'anestesia'::text) AND ((NOT app.has_role(organization_id, ARRAY['anestesiologista'::text])) OR app.pode_ver_registro(organization_id, created_by))));
drop policy if exists "anesthesia_records_share_sel" on "public"."anesthesia_records";
create policy "anesthesia_records_share_sel" on "public"."anesthesia_records" as permissive for select to public using (app.compartilhada_para_mim(organization_id, 'anestesia'::text));
drop policy if exists "anesthesia_records_wr" on "public"."anesthesia_records";
create policy "anesthesia_records_wr" on "public"."anesthesia_records" as permissive for all to public using ((app.pode_editar_modulo(organization_id, 'anestesia'::text) AND ((NOT app.has_role(organization_id, ARRAY['anestesiologista'::text])) OR app.pode_ver_registro(organization_id, created_by)))) with check (app.pode_editar_modulo(organization_id, 'anestesia'::text));
drop policy if exists "tl_sel" on "public"."anesthesia_timeline_events";
create policy "tl_sel" on "public"."anesthesia_timeline_events" as permissive for select to public using (((organization_id IN ( SELECT app.org_ids() AS org_ids)) AND app.has_role(organization_id, ARRAY['gestor'::text, 'anestesiologista'::text])));
drop policy if exists "tl_wr" on "public"."anesthesia_timeline_events";
create policy "tl_wr" on "public"."anesthesia_timeline_events" as permissive for all to public using (app.can_write_clinical(organization_id)) with check (app.can_write_clinical(organization_id));
drop policy if exists "prog_self_sel" on "public"."app_programmers";
create policy "prog_self_sel" on "public"."app_programmers" as permissive for select to public using ((user_id = auth.uid()));
drop policy if exists "appointments_sel" on "public"."appointments";
create policy "appointments_sel" on "public"."appointments" as permissive for select to public using ((organization_id IN ( SELECT app.org_ids() AS org_ids)));
drop policy if exists "appointments_share_sel" on "public"."appointments";
create policy "appointments_share_sel" on "public"."appointments" as permissive for select to public using (app.compartilhada_para_mim(organization_id, 'agenda'::text));
drop policy if exists "appointments_wr" on "public"."appointments";
create policy "appointments_wr" on "public"."appointments" as permissive for all to public using (app.has_role(organization_id, ARRAY['gestor'::text, 'anestesiologista'::text, 'auxiliar'::text])) with check (app.has_role(organization_id, ARRAY['gestor'::text, 'anestesiologista'::text, 'auxiliar'::text]));
drop policy if exists "appt_sel" on "public"."appointments";
create policy "appt_sel" on "public"."appointments" as permissive for select to public using (((organization_id IN ( SELECT app.org_ids() AS org_ids)) AND app.pode_modulo(organization_id, 'agenda'::text)));
drop policy if exists "appt_wr" on "public"."appointments";
create policy "appt_wr" on "public"."appointments" as permissive for all to public using (app.pode_editar_modulo(organization_id, 'agenda'::text)) with check (app.pode_editar_modulo(organization_id, 'agenda'::text));
drop policy if exists "att_sel" on "public"."attachments";
create policy "att_sel" on "public"."attachments" as permissive for select to public using (((organization_id IN ( SELECT app.org_ids() AS org_ids)) AND app.has_role(organization_id, ARRAY['gestor'::text, 'anestesiologista'::text, 'financeiro'::text, 'auxiliar'::text])));
drop policy if exists "att_wr" on "public"."attachments";
create policy "att_wr" on "public"."attachments" as permissive for all to public using (app.has_role(organization_id, ARRAY['gestor'::text, 'anestesiologista'::text, 'auxiliar'::text])) with check (app.has_role(organization_id, ARRAY['gestor'::text, 'anestesiologista'::text, 'auxiliar'::text]));
drop policy if exists "audit_sel" on "public"."audit_logs";
create policy "audit_sel" on "public"."audit_logs" as permissive for select to public using (((user_id = auth.uid()) OR app.has_role(organization_id, ARRAY['gestor'::text])));
drop policy if exists "consents_aux_sel" on "public"."consents";
create policy "consents_aux_sel" on "public"."consents" as permissive for select to public using (app.has_role(organization_id, ARRAY['auxiliar'::text]));
drop policy if exists "consents_aux_wr" on "public"."consents";
create policy "consents_aux_wr" on "public"."consents" as permissive for all to public using (app.has_role(organization_id, ARRAY['auxiliar'::text])) with check (app.has_role(organization_id, ARRAY['auxiliar'::text]));
drop policy if exists "consents_sel" on "public"."consents";
create policy "consents_sel" on "public"."consents" as permissive for select to public using (((organization_id IN ( SELECT app.org_ids() AS org_ids)) AND app.pode_modulo(organization_id, 'termo'::text) AND ((NOT app.has_role(organization_id, ARRAY['anestesiologista'::text])) OR app.pode_ver_registro(organization_id, created_by))));
drop policy if exists "consents_share_sel" on "public"."consents";
create policy "consents_share_sel" on "public"."consents" as permissive for select to public using (app.compartilhada_para_mim(organization_id, 'termo'::text));
drop policy if exists "consents_wr" on "public"."consents";
create policy "consents_wr" on "public"."consents" as permissive for all to public using ((app.pode_editar_modulo(organization_id, 'termo'::text) AND ((NOT app.has_role(organization_id, ARRAY['anestesiologista'::text])) OR app.pode_ver_registro(organization_id, created_by)))) with check (app.pode_editar_modulo(organization_id, 'termo'::text));
drop policy if exists "consultations_sel" on "public"."consultations";
create policy "consultations_sel" on "public"."consultations" as permissive for select to public using (((organization_id IN ( SELECT app.org_ids() AS org_ids)) AND (app.has_role(organization_id, ARRAY['gestor'::text, 'anestesiologista'::text]) OR (EXISTS ( SELECT 1
   FROM public.encounters e
  WHERE ((e.id = consultations.encounter_id) AND (e.surgeon_id = auth.uid())))))));
drop policy if exists "consultations_share_sel" on "public"."consultations";
create policy "consultations_share_sel" on "public"."consultations" as permissive for select to public using (app.compartilhada_para_mim(organization_id, 'consulta'::text));
drop policy if exists "consultations_wr" on "public"."consultations";
create policy "consultations_wr" on "public"."consultations" as permissive for all to public using (app.can_write_clinical(organization_id)) with check (app.can_write_clinical(organization_id));
drop policy if exists "documentos_delete_proprio" on "public"."documentos";
create policy "documentos_delete_proprio" on "public"."documentos" as permissive for delete to "authenticated" using ((auth.uid() = user_id));
drop policy if exists "documentos_insert_proprio" on "public"."documentos";
create policy "documentos_insert_proprio" on "public"."documentos" as permissive for insert to "authenticated" with check ((auth.uid() = user_id));
drop policy if exists "documentos_select_proprio" on "public"."documentos";
create policy "documentos_select_proprio" on "public"."documentos" as permissive for select to "authenticated" using ((auth.uid() = user_id));
drop policy if exists "documentos_update_proprio" on "public"."documentos";
create policy "documentos_update_proprio" on "public"."documentos" as permissive for update to "authenticated" using ((auth.uid() = user_id)) with check ((auth.uid() = user_id));
drop policy if exists "documents_aux_sel" on "public"."documents";
create policy "documents_aux_sel" on "public"."documents" as permissive for select to public using (app.has_role(organization_id, ARRAY['auxiliar'::text]));
drop policy if exists "documents_aux_wr" on "public"."documents";
create policy "documents_aux_wr" on "public"."documents" as permissive for all to public using (app.has_role(organization_id, ARRAY['auxiliar'::text])) with check (app.has_role(organization_id, ARRAY['auxiliar'::text]));
drop policy if exists "documents_sel" on "public"."documents";
create policy "documents_sel" on "public"."documents" as permissive for select to public using (((organization_id IN ( SELECT app.org_ids() AS org_ids)) AND app.pode_modulo(organization_id, 'documentos'::text) AND ((NOT app.has_role(organization_id, ARRAY['anestesiologista'::text])) OR app.pode_ver_registro(organization_id, created_by))));
drop policy if exists "documents_share_sel" on "public"."documents";
create policy "documents_share_sel" on "public"."documents" as permissive for select to public using (app.compartilhada_para_mim(organization_id, 'documentos'::text));
drop policy if exists "documents_wr" on "public"."documents";
create policy "documents_wr" on "public"."documents" as permissive for all to public using ((app.pode_editar_modulo(organization_id, 'documentos'::text) AND ((NOT app.has_role(organization_id, ARRAY['anestesiologista'::text])) OR app.pode_ver_registro(organization_id, created_by)))) with check (app.pode_editar_modulo(organization_id, 'documentos'::text));
drop policy if exists "enc_sel" on "public"."encounters";
create policy "enc_sel" on "public"."encounters" as permissive for select to public using (((organization_id IN ( SELECT app.org_ids() AS org_ids)) AND (app.pode_modulo(organization_id, 'pre'::text) OR app.pode_modulo(organization_id, 'anestesia'::text) OR app.pode_modulo(organization_id, 'recuperacao'::text) OR app.pode_modulo(organization_id, 'financeiro'::text))));
drop policy if exists "enc_wr" on "public"."encounters";
create policy "enc_wr" on "public"."encounters" as permissive for all to public using ((app.pode_editar_modulo(organization_id, 'pre'::text) OR app.pode_editar_modulo(organization_id, 'anestesia'::text) OR app.pode_editar_modulo(organization_id, 'recuperacao'::text))) with check ((app.pode_editar_modulo(organization_id, 'pre'::text) OR app.pode_editar_modulo(organization_id, 'anestesia'::text) OR app.pode_editar_modulo(organization_id, 'recuperacao'::text)));
drop policy if exists "equipment_sel" on "public"."equipment";
create policy "equipment_sel" on "public"."equipment" as permissive for select to public using ((organization_id IN ( SELECT app.org_ids() AS org_ids)));
drop policy if exists "equipment_wr" on "public"."equipment";
create policy "equipment_wr" on "public"."equipment" as permissive for all to public using (app.has_role(organization_id, ARRAY['gestor'::text])) with check (app.has_role(organization_id, ARRAY['gestor'::text]));
drop policy if exists "fin_sel" on "public"."finance_entries";
create policy "fin_sel" on "public"."finance_entries" as permissive for select to public using (((organization_id IN ( SELECT app.org_ids() AS org_ids)) AND app.pode_modulo(organization_id, 'financeiro'::text) AND ((NOT app.has_role(organization_id, ARRAY['anestesiologista'::text])) OR app.pode_ver_registro(organization_id, created_by))));
drop policy if exists "fin_wr" on "public"."finance_entries";
create policy "fin_wr" on "public"."finance_entries" as permissive for all to public using ((app.pode_editar_modulo(organization_id, 'financeiro'::text) AND ((NOT app.has_role(organization_id, ARRAY['anestesiologista'::text])) OR app.pode_ver_registro(organization_id, created_by)))) with check (app.pode_editar_modulo(organization_id, 'financeiro'::text));
drop policy if exists "finance_entries_share_sel" on "public"."finance_entries";
create policy "finance_entries_share_sel" on "public"."finance_entries" as permissive for select to public using (app.compartilhada_para_mim(organization_id, 'financeiro'::text));
drop policy if exists "hospitals_sel" on "public"."hospitals";
create policy "hospitals_sel" on "public"."hospitals" as permissive for select to public using ((organization_id IN ( SELECT app.org_ids() AS org_ids)));
drop policy if exists "hospitals_wr" on "public"."hospitals";
create policy "hospitals_wr" on "public"."hospitals" as permissive for all to public using (app.has_role(organization_id, ARRAY['gestor'::text])) with check (app.has_role(organization_id, ARRAY['gestor'::text]));
drop policy if exists "medicamentos_sel" on "public"."medicamentos";
create policy "medicamentos_sel" on "public"."medicamentos" as permissive for select to "authenticated" using (true);
drop policy if exists "medicamentos_sel_anon" on "public"."medicamentos";
create policy "medicamentos_sel_anon" on "public"."medicamentos" as permissive for select to "anon" using (true);
drop policy if exists "medversao_sel" on "public"."medicamentos_base_versao";
create policy "medversao_sel" on "public"."medicamentos_base_versao" as permissive for select to "authenticated" using (true);
drop policy if exists "medregras_ins" on "public"."medicamentos_regras_anestesicas";
create policy "medregras_ins" on "public"."medicamentos_regras_anestesicas" as permissive for insert to "authenticated" with check (((organization_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM public.organization_users ou
  WHERE ((ou.user_id = auth.uid()) AND (ou.organization_id = medicamentos_regras_anestesicas.organization_id) AND ou.ativo AND (ou.role = ANY (ARRAY['gestor'::text, 'anestesiologista'::text])))))));
drop policy if exists "medregras_sel" on "public"."medicamentos_regras_anestesicas";
create policy "medregras_sel" on "public"."medicamentos_regras_anestesicas" as permissive for select to "authenticated" using ((ativo AND ((organization_id IS NULL) OR (EXISTS ( SELECT 1
   FROM public.organization_users ou
  WHERE ((ou.user_id = auth.uid()) AND (ou.organization_id = medicamentos_regras_anestesicas.organization_id) AND ou.ativo))))));
drop policy if exists "medregras_upd" on "public"."medicamentos_regras_anestesicas";
create policy "medregras_upd" on "public"."medicamentos_regras_anestesicas" as permissive for update to "authenticated" using (((organization_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM public.organization_users ou
  WHERE ((ou.user_id = auth.uid()) AND (ou.organization_id = medicamentos_regras_anestesicas.organization_id) AND ou.ativo AND (ou.role = ANY (ARRAY['gestor'::text, 'anestesiologista'::text])))))));
drop policy if exists "oc_sel" on "public"."org_configs";
create policy "oc_sel" on "public"."org_configs" as permissive for select to public using ((organization_id IN ( SELECT app.org_ids() AS org_ids)));
drop policy if exists "oc_wr" on "public"."org_configs";
create policy "oc_wr" on "public"."org_configs" as permissive for all to public using ((organization_id IN ( SELECT app.org_ids() AS org_ids))) with check ((organization_id IN ( SELECT app.org_ids() AS org_ids)));
drop policy if exists "shares_prog_all" on "public"."org_shares";
create policy "shares_prog_all" on "public"."org_shares" as permissive for all to public using (app.eh_programador()) with check (app.eh_programador());
drop policy if exists "shares_sel" on "public"."org_shares";
create policy "shares_sel" on "public"."org_shares" as permissive for select to public using ((app.eh_programador() OR (org_origem IN ( SELECT app.org_ids() AS org_ids)) OR (org_destino IN ( SELECT app.org_ids() AS org_ids))));
drop policy if exists "ou_all" on "public"."organization_users";
create policy "ou_all" on "public"."organization_users" as permissive for all to public using (app.has_role(organization_id, ARRAY['gestor'::text])) with check (app.has_role(organization_id, ARRAY['gestor'::text]));
drop policy if exists "ou_prog_all" on "public"."organization_users";
create policy "ou_prog_all" on "public"."organization_users" as permissive for all to public using (app.eh_programador()) with check (app.eh_programador());
drop policy if exists "ou_prog_sel" on "public"."organization_users";
create policy "ou_prog_sel" on "public"."organization_users" as permissive for select to public using (app.eh_programador());
drop policy if exists "ou_sel" on "public"."organization_users";
create policy "ou_sel" on "public"."organization_users" as permissive for select to public using (((user_id = auth.uid()) OR app.has_role(organization_id, ARRAY['gestor'::text])));
drop policy if exists "org_prog_del" on "public"."organizations";
create policy "org_prog_del" on "public"."organizations" as permissive for delete to public using (app.eh_programador());
drop policy if exists "org_prog_ins" on "public"."organizations";
create policy "org_prog_ins" on "public"."organizations" as permissive for insert to public with check (app.eh_programador());
drop policy if exists "org_prog_sel" on "public"."organizations";
create policy "org_prog_sel" on "public"."organizations" as permissive for select to public using (app.eh_programador());
drop policy if exists "org_prog_upd" on "public"."organizations";
create policy "org_prog_upd" on "public"."organizations" as permissive for update to public using (app.eh_programador());
drop policy if exists "org_sel" on "public"."organizations";
create policy "org_sel" on "public"."organizations" as permissive for select to public using ((id IN ( SELECT app.org_ids() AS org_ids)));
drop policy if exists "org_upd" on "public"."organizations";
create policy "org_upd" on "public"."organizations" as permissive for update to public using (app.has_role(id, ARRAY['gestor'::text])) with check (app.has_role(id, ARRAY['gestor'::text]));
drop policy if exists "Usuário atualiza apenas seus pacientes" on "public"."pacientes";
create policy "Usuário atualiza apenas seus pacientes" on "public"."pacientes" as permissive for update to public using ((auth.uid() = user_id)) with check ((auth.uid() = user_id));
drop policy if exists "Usuário cria apenas seus pacientes" on "public"."pacientes";
create policy "Usuário cria apenas seus pacientes" on "public"."pacientes" as permissive for insert to public with check ((auth.uid() = user_id));
drop policy if exists "Usuário exclui apenas seus pacientes" on "public"."pacientes";
create policy "Usuário exclui apenas seus pacientes" on "public"."pacientes" as permissive for delete to public using ((auth.uid() = user_id));
drop policy if exists "Usuário vê apenas seus pacientes" on "public"."pacientes";
create policy "Usuário vê apenas seus pacientes" on "public"."pacientes" as permissive for select to public using ((auth.uid() = user_id));
drop policy if exists "patients_sel" on "public"."patients";
create policy "patients_sel" on "public"."patients" as permissive for select to public using (((organization_id IN ( SELECT app.org_ids() AS org_ids)) AND app.pode_modulo(organization_id, 'pacientes'::text)));
drop policy if exists "patients_share_sel" on "public"."patients";
create policy "patients_share_sel" on "public"."patients" as permissive for select to public using (app.compartilhada_para_mim(organization_id, 'pacientes'::text));
drop policy if exists "patients_wr" on "public"."patients";
create policy "patients_wr" on "public"."patients" as permissive for all to public using (app.pode_editar_modulo(organization_id, 'pacientes'::text)) with check (app.pode_editar_modulo(organization_id, 'pacientes'::text));
drop policy if exists "preanesthetic_assessments_aux_sel" on "public"."preanesthetic_assessments";
create policy "preanesthetic_assessments_aux_sel" on "public"."preanesthetic_assessments" as permissive for select to public using (app.has_role(organization_id, ARRAY['auxiliar'::text]));
drop policy if exists "preanesthetic_assessments_aux_wr" on "public"."preanesthetic_assessments";
create policy "preanesthetic_assessments_aux_wr" on "public"."preanesthetic_assessments" as permissive for all to public using (app.has_role(organization_id, ARRAY['auxiliar'::text])) with check (app.has_role(organization_id, ARRAY['auxiliar'::text]));
drop policy if exists "preanesthetic_assessments_sel" on "public"."preanesthetic_assessments";
create policy "preanesthetic_assessments_sel" on "public"."preanesthetic_assessments" as permissive for select to public using (((organization_id IN ( SELECT app.org_ids() AS org_ids)) AND app.pode_modulo(organization_id, 'pre'::text) AND ((NOT app.has_role(organization_id, ARRAY['anestesiologista'::text])) OR app.pode_ver_registro(organization_id, created_by))));
drop policy if exists "preanesthetic_assessments_share_sel" on "public"."preanesthetic_assessments";
create policy "preanesthetic_assessments_share_sel" on "public"."preanesthetic_assessments" as permissive for select to public using (app.compartilhada_para_mim(organization_id, 'pre'::text));
drop policy if exists "preanesthetic_assessments_wr" on "public"."preanesthetic_assessments";
create policy "preanesthetic_assessments_wr" on "public"."preanesthetic_assessments" as permissive for all to public using ((app.pode_editar_modulo(organization_id, 'pre'::text) AND ((NOT app.has_role(organization_id, ARRAY['anestesiologista'::text])) OR app.pode_ver_registro(organization_id, created_by)))) with check (app.pode_editar_modulo(organization_id, 'pre'::text));
drop policy if exists "prescriptions_sel" on "public"."prescriptions";
create policy "prescriptions_sel" on "public"."prescriptions" as permissive for select to public using (((organization_id IN ( SELECT app.org_ids() AS org_ids)) AND app.pode_modulo(organization_id, 'prescricao'::text) AND ((NOT app.has_role(organization_id, ARRAY['anestesiologista'::text])) OR app.pode_ver_registro(organization_id, created_by))));
drop policy if exists "prescriptions_share_sel" on "public"."prescriptions";
create policy "prescriptions_share_sel" on "public"."prescriptions" as permissive for select to public using (app.compartilhada_para_mim(organization_id, 'prescricao'::text));
drop policy if exists "prescriptions_wr" on "public"."prescriptions";
create policy "prescriptions_wr" on "public"."prescriptions" as permissive for all to public using ((app.pode_editar_modulo(organization_id, 'prescricao'::text) AND ((NOT app.has_role(organization_id, ARRAY['anestesiologista'::text])) OR app.pode_ver_registro(organization_id, created_by)))) with check (app.pode_editar_modulo(organization_id, 'prescricao'::text));
drop policy if exists "prof_prog_sel" on "public"."profiles";
create policy "prof_prog_sel" on "public"."profiles" as permissive for select to public using (app.eh_programador());
drop policy if exists "profiles_self_ins" on "public"."profiles";
create policy "profiles_self_ins" on "public"."profiles" as permissive for insert to public with check ((id = auth.uid()));
drop policy if exists "profiles_self_sel" on "public"."profiles";
create policy "profiles_self_sel" on "public"."profiles" as permissive for select to public using (((id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM public.organization_users ou
  WHERE ((ou.user_id = auth.uid()) AND ou.ativo AND (ou.role = 'gestor'::text) AND (ou.organization_id IN ( SELECT organization_users.organization_id
           FROM public.organization_users
          WHERE (organization_users.user_id = profiles.id))))))));
drop policy if exists "profiles_self_upd" on "public"."profiles";
create policy "profiles_self_upd" on "public"."profiles" as permissive for update to public using ((id = auth.uid())) with check ((id = auth.uid()));
drop policy if exists "quotes_sel" on "public"."quotes";
create policy "quotes_sel" on "public"."quotes" as permissive for select to public using (((organization_id IN ( SELECT app.org_ids() AS org_ids)) AND app.pode_modulo(organization_id, 'orcamento'::text)));
drop policy if exists "quotes_share_sel" on "public"."quotes";
create policy "quotes_share_sel" on "public"."quotes" as permissive for select to public using (app.compartilhada_para_mim(organization_id, 'orcamento'::text));
drop policy if exists "quotes_wr" on "public"."quotes";
create policy "quotes_wr" on "public"."quotes" as permissive for all to public using (app.pode_editar_modulo(organization_id, 'orcamento'::text)) with check (app.pode_editar_modulo(organization_id, 'orcamento'::text));
drop policy if exists "recovery_records_sel" on "public"."recovery_records";
create policy "recovery_records_sel" on "public"."recovery_records" as permissive for select to public using (((organization_id IN ( SELECT app.org_ids() AS org_ids)) AND app.pode_modulo(organization_id, 'recuperacao'::text) AND ((NOT app.has_role(organization_id, ARRAY['anestesiologista'::text])) OR app.pode_ver_registro(organization_id, created_by))));
drop policy if exists "recovery_records_share_sel" on "public"."recovery_records";
create policy "recovery_records_share_sel" on "public"."recovery_records" as permissive for select to public using (app.compartilhada_para_mim(organization_id, 'recuperacao'::text));
drop policy if exists "recovery_records_wr" on "public"."recovery_records";
create policy "recovery_records_wr" on "public"."recovery_records" as permissive for all to public using ((app.pode_editar_modulo(organization_id, 'recuperacao'::text) AND ((NOT app.has_role(organization_id, ARRAY['anestesiologista'::text])) OR app.pode_ver_registro(organization_id, created_by)))) with check (app.pode_editar_modulo(organization_id, 'recuperacao'::text));
drop policy if exists "risk_assessments_sel" on "public"."risk_assessments";
create policy "risk_assessments_sel" on "public"."risk_assessments" as permissive for select to public using (((organization_id IN ( SELECT app.org_ids() AS org_ids)) AND app.pode_modulo(organization_id, 'risco'::text) AND ((NOT app.has_role(organization_id, ARRAY['anestesiologista'::text])) OR app.pode_ver_registro(organization_id, created_by))));
drop policy if exists "risk_assessments_share_sel" on "public"."risk_assessments";
create policy "risk_assessments_share_sel" on "public"."risk_assessments" as permissive for select to public using (app.compartilhada_para_mim(organization_id, 'risco'::text));
drop policy if exists "risk_assessments_wr" on "public"."risk_assessments";
create policy "risk_assessments_wr" on "public"."risk_assessments" as permissive for all to public using ((app.pode_editar_modulo(organization_id, 'risco'::text) AND ((NOT app.has_role(organization_id, ARRAY['anestesiologista'::text])) OR app.pode_ver_registro(organization_id, created_by)))) with check (app.pode_editar_modulo(organization_id, 'risco'::text));
drop policy if exists "rooms_sel" on "public"."rooms";
create policy "rooms_sel" on "public"."rooms" as permissive for select to public using ((organization_id IN ( SELECT app.org_ids() AS org_ids)));
drop policy if exists "rooms_wr" on "public"."rooms";
create policy "rooms_wr" on "public"."rooms" as permissive for all to public using (app.has_role(organization_id, ARRAY['gestor'::text])) with check (app.has_role(organization_id, ARRAY['gestor'::text]));
drop policy if exists "standard_texts_sel" on "public"."standard_texts";
create policy "standard_texts_sel" on "public"."standard_texts" as permissive for select to public using (((organization_id IN ( SELECT app.org_ids() AS org_ids)) AND ((owner_id IS NULL) OR (owner_id = auth.uid()) OR COALESCE(((to_jsonb(standard_texts.*) ->> 'compartilhado'::text))::boolean, false))));
drop policy if exists "standard_texts_wr" on "public"."standard_texts";
create policy "standard_texts_wr" on "public"."standard_texts" as permissive for all to public using (((organization_id IN ( SELECT app.org_ids() AS org_ids)) AND ((owner_id = auth.uid()) OR app.has_role(organization_id, ARRAY['gestor'::text])))) with check (((organization_id IN ( SELECT app.org_ids() AS org_ids)) AND ((owner_id = auth.uid()) OR (owner_id IS NULL) OR app.has_role(organization_id, ARRAY['gestor'::text]))));
drop policy if exists "templates_sel" on "public"."templates";
create policy "templates_sel" on "public"."templates" as permissive for select to public using (((organization_id IN ( SELECT app.org_ids() AS org_ids)) AND ((owner_id IS NULL) OR (owner_id = auth.uid()) OR COALESCE(((to_jsonb(templates.*) ->> 'compartilhado'::text))::boolean, false))));
drop policy if exists "templates_wr" on "public"."templates";
create policy "templates_wr" on "public"."templates" as permissive for all to public using (((organization_id IN ( SELECT app.org_ids() AS org_ids)) AND ((owner_id = auth.uid()) OR app.has_role(organization_id, ARRAY['gestor'::text])))) with check (((organization_id IN ( SELECT app.org_ids() AS org_ids)) AND ((owner_id = auth.uid()) OR (owner_id IS NULL) OR app.has_role(organization_id, ARRAY['gestor'::text]))));
drop policy if exists "clin_att_del" on "storage"."objects";
create policy "clin_att_del" on "storage"."objects" as permissive for delete to public using (((bucket_id = 'clinical-attachments'::text) AND app.has_role(((storage.foldername(name))[1])::uuid, ARRAY['gestor'::text])));
drop policy if exists "clin_att_ins" on "storage"."objects";
create policy "clin_att_ins" on "storage"."objects" as permissive for insert to public with check (((bucket_id = 'clinical-attachments'::text) AND (((storage.foldername(name))[1])::uuid IN ( SELECT app.org_ids() AS org_ids)) AND app.has_role(((storage.foldername(name))[1])::uuid, ARRAY['gestor'::text, 'anestesiologista'::text, 'auxiliar'::text])));
drop policy if exists "clin_att_sel" on "storage"."objects";
create policy "clin_att_sel" on "storage"."objects" as permissive for select to public using (((bucket_id = 'clinical-attachments'::text) AND (((storage.foldername(name))[1])::uuid IN ( SELECT app.org_ids() AS org_ids))));
drop policy if exists "clin_att_upd" on "storage"."objects";
create policy "clin_att_upd" on "storage"."objects" as permissive for update to public using (((bucket_id = 'clinical-attachments'::text) AND (((storage.foldername(name))[1])::uuid IN ( SELECT app.org_ids() AS org_ids)) AND app.has_role(((storage.foldername(name))[1])::uuid, ARRAY['gestor'::text, 'anestesiologista'::text, 'auxiliar'::text])));
CREATE TRIGGER trg_audit AFTER INSERT OR DELETE OR UPDATE ON public.anesthesia_records FOR EACH ROW EXECUTE FUNCTION app.audit_row();
alter table "public"."anesthesia_records" enable trigger "trg_audit";
CREATE TRIGGER trg_guard BEFORE UPDATE ON public.anesthesia_records FOR EACH ROW EXECUTE FUNCTION app.guard_finalized();
alter table "public"."anesthesia_records" enable trigger "trg_guard";
CREATE TRIGGER trg_stamp BEFORE INSERT ON public.anesthesia_records FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
alter table "public"."anesthesia_records" enable trigger "trg_stamp";
CREATE TRIGGER trg_updated_at BEFORE UPDATE ON public.anesthesia_records FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
alter table "public"."anesthesia_records" enable trigger "trg_updated_at";
CREATE TRIGGER trg_version BEFORE UPDATE ON public.anesthesia_records FOR EACH ROW EXECUTE FUNCTION app.bump_version();
alter table "public"."anesthesia_records" enable trigger "trg_version";
CREATE TRIGGER trg_updated_at BEFORE UPDATE ON public.anesthesia_timeline_events FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
alter table "public"."anesthesia_timeline_events" enable trigger "trg_updated_at";
CREATE TRIGGER trg_audit AFTER INSERT OR DELETE OR UPDATE ON public.appointments FOR EACH ROW EXECUTE FUNCTION app.audit_row();
alter table "public"."appointments" enable trigger "trg_audit";
CREATE TRIGGER trg_stamp BEFORE INSERT ON public.appointments FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
alter table "public"."appointments" enable trigger "trg_stamp";
CREATE TRIGGER trg_updated_at BEFORE UPDATE ON public.appointments FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
alter table "public"."appointments" enable trigger "trg_updated_at";
CREATE TRIGGER assinaturas_immutable BEFORE DELETE OR UPDATE ON public.assinaturas FOR EACH ROW EXECUTE FUNCTION public.assinaturas_no_mutate();
alter table "public"."assinaturas" enable trigger "assinaturas_immutable";
CREATE TRIGGER trg_audit AFTER INSERT OR DELETE OR UPDATE ON public.consents FOR EACH ROW EXECUTE FUNCTION app.audit_row();
alter table "public"."consents" enable trigger "trg_audit";
CREATE TRIGGER trg_guard BEFORE UPDATE ON public.consents FOR EACH ROW EXECUTE FUNCTION app.guard_finalized();
alter table "public"."consents" enable trigger "trg_guard";
CREATE TRIGGER trg_stamp BEFORE INSERT ON public.consents FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
alter table "public"."consents" enable trigger "trg_stamp";
CREATE TRIGGER trg_updated_at BEFORE UPDATE ON public.consents FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
alter table "public"."consents" enable trigger "trg_updated_at";
CREATE TRIGGER trg_version BEFORE UPDATE ON public.consents FOR EACH ROW EXECUTE FUNCTION app.bump_version();
alter table "public"."consents" enable trigger "trg_version";
CREATE TRIGGER trg_audit AFTER INSERT OR DELETE OR UPDATE ON public.consultations FOR EACH ROW EXECUTE FUNCTION app.audit_row();
alter table "public"."consultations" enable trigger "trg_audit";
CREATE TRIGGER trg_guard BEFORE UPDATE ON public.consultations FOR EACH ROW EXECUTE FUNCTION app.guard_finalized();
alter table "public"."consultations" enable trigger "trg_guard";
CREATE TRIGGER trg_stamp BEFORE INSERT ON public.consultations FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
alter table "public"."consultations" enable trigger "trg_stamp";
CREATE TRIGGER trg_updated_at BEFORE UPDATE ON public.consultations FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
alter table "public"."consultations" enable trigger "trg_updated_at";
CREATE TRIGGER trg_version BEFORE UPDATE ON public.consultations FOR EACH ROW EXECUTE FUNCTION app.bump_version();
alter table "public"."consultations" enable trigger "trg_version";
CREATE TRIGGER trg_audit AFTER INSERT OR DELETE OR UPDATE ON public.documents FOR EACH ROW EXECUTE FUNCTION app.audit_row();
alter table "public"."documents" enable trigger "trg_audit";
CREATE TRIGGER trg_guard BEFORE UPDATE ON public.documents FOR EACH ROW EXECUTE FUNCTION app.guard_finalized();
alter table "public"."documents" enable trigger "trg_guard";
CREATE TRIGGER trg_stamp BEFORE INSERT ON public.documents FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
alter table "public"."documents" enable trigger "trg_stamp";
CREATE TRIGGER trg_updated_at BEFORE UPDATE ON public.documents FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
alter table "public"."documents" enable trigger "trg_updated_at";
CREATE TRIGGER trg_version BEFORE UPDATE ON public.documents FOR EACH ROW EXECUTE FUNCTION app.bump_version();
alter table "public"."documents" enable trigger "trg_version";
CREATE TRIGGER trg_audit AFTER INSERT OR DELETE OR UPDATE ON public.encounters FOR EACH ROW EXECUTE FUNCTION app.audit_row();
alter table "public"."encounters" enable trigger "trg_audit";
CREATE TRIGGER trg_stamp BEFORE INSERT ON public.encounters FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
alter table "public"."encounters" enable trigger "trg_stamp";
CREATE TRIGGER trg_updated_at BEFORE UPDATE ON public.encounters FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
alter table "public"."encounters" enable trigger "trg_updated_at";
CREATE TRIGGER trg_updated_at BEFORE UPDATE ON public.equipment FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
alter table "public"."equipment" enable trigger "trg_updated_at";
CREATE TRIGGER trg_audit AFTER INSERT OR DELETE OR UPDATE ON public.finance_entries FOR EACH ROW EXECUTE FUNCTION app.audit_row();
alter table "public"."finance_entries" enable trigger "trg_audit";
CREATE TRIGGER trg_stamp BEFORE INSERT ON public.finance_entries FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
alter table "public"."finance_entries" enable trigger "trg_stamp";
CREATE TRIGGER trg_updated_at BEFORE UPDATE ON public.finance_entries FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
alter table "public"."finance_entries" enable trigger "trg_updated_at";
CREATE TRIGGER trg_version BEFORE UPDATE ON public.finance_entries FOR EACH ROW EXECUTE FUNCTION app.bump_version();
alter table "public"."finance_entries" enable trigger "trg_version";
CREATE TRIGGER trg_updated_at BEFORE UPDATE ON public.hospitals FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
alter table "public"."hospitals" enable trigger "trg_updated_at";
CREATE TRIGGER trg_updated_at BEFORE UPDATE ON public.organization_users FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
alter table "public"."organization_users" enable trigger "trg_updated_at";
CREATE TRIGGER trg_updated_at BEFORE UPDATE ON public.organizations FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
alter table "public"."organizations" enable trigger "trg_updated_at";
CREATE TRIGGER set_pacientes_updated_at BEFORE UPDATE ON public.pacientes FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
alter table "public"."pacientes" enable trigger "set_pacientes_updated_at";
CREATE TRIGGER trg_audit AFTER INSERT OR DELETE OR UPDATE ON public.patients FOR EACH ROW EXECUTE FUNCTION app.audit_row();
alter table "public"."patients" enable trigger "trg_audit";
CREATE TRIGGER trg_stamp BEFORE INSERT ON public.patients FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
alter table "public"."patients" enable trigger "trg_stamp";
CREATE TRIGGER trg_updated_at BEFORE UPDATE ON public.patients FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
alter table "public"."patients" enable trigger "trg_updated_at";
CREATE TRIGGER trg_audit AFTER INSERT OR DELETE OR UPDATE ON public.preanesthetic_assessments FOR EACH ROW EXECUTE FUNCTION app.audit_row();
alter table "public"."preanesthetic_assessments" enable trigger "trg_audit";
CREATE TRIGGER trg_guard BEFORE UPDATE ON public.preanesthetic_assessments FOR EACH ROW EXECUTE FUNCTION app.guard_finalized();
alter table "public"."preanesthetic_assessments" enable trigger "trg_guard";
CREATE TRIGGER trg_stamp BEFORE INSERT ON public.preanesthetic_assessments FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
alter table "public"."preanesthetic_assessments" enable trigger "trg_stamp";
CREATE TRIGGER trg_updated_at BEFORE UPDATE ON public.preanesthetic_assessments FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
alter table "public"."preanesthetic_assessments" enable trigger "trg_updated_at";
CREATE TRIGGER trg_version BEFORE UPDATE ON public.preanesthetic_assessments FOR EACH ROW EXECUTE FUNCTION app.bump_version();
alter table "public"."preanesthetic_assessments" enable trigger "trg_version";
CREATE TRIGGER trg_audit AFTER INSERT OR DELETE OR UPDATE ON public.prescriptions FOR EACH ROW EXECUTE FUNCTION app.audit_row();
alter table "public"."prescriptions" enable trigger "trg_audit";
CREATE TRIGGER trg_guard BEFORE UPDATE ON public.prescriptions FOR EACH ROW EXECUTE FUNCTION app.guard_finalized();
alter table "public"."prescriptions" enable trigger "trg_guard";
CREATE TRIGGER trg_stamp BEFORE INSERT ON public.prescriptions FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
alter table "public"."prescriptions" enable trigger "trg_stamp";
CREATE TRIGGER trg_updated_at BEFORE UPDATE ON public.prescriptions FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
alter table "public"."prescriptions" enable trigger "trg_updated_at";
CREATE TRIGGER trg_version BEFORE UPDATE ON public.prescriptions FOR EACH ROW EXECUTE FUNCTION app.bump_version();
alter table "public"."prescriptions" enable trigger "trg_version";
CREATE TRIGGER trg_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
alter table "public"."profiles" enable trigger "trg_updated_at";
CREATE TRIGGER trg_audit AFTER INSERT OR DELETE OR UPDATE ON public.quotes FOR EACH ROW EXECUTE FUNCTION app.audit_row();
alter table "public"."quotes" enable trigger "trg_audit";
CREATE TRIGGER trg_stamp BEFORE INSERT ON public.quotes FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
alter table "public"."quotes" enable trigger "trg_stamp";
CREATE TRIGGER trg_updated_at BEFORE UPDATE ON public.quotes FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
alter table "public"."quotes" enable trigger "trg_updated_at";
CREATE TRIGGER trg_version BEFORE UPDATE ON public.quotes FOR EACH ROW EXECUTE FUNCTION app.bump_version();
alter table "public"."quotes" enable trigger "trg_version";
CREATE TRIGGER trg_audit AFTER INSERT OR DELETE OR UPDATE ON public.recovery_records FOR EACH ROW EXECUTE FUNCTION app.audit_row();
alter table "public"."recovery_records" enable trigger "trg_audit";
CREATE TRIGGER trg_guard BEFORE UPDATE ON public.recovery_records FOR EACH ROW EXECUTE FUNCTION app.guard_finalized();
alter table "public"."recovery_records" enable trigger "trg_guard";
CREATE TRIGGER trg_stamp BEFORE INSERT ON public.recovery_records FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
alter table "public"."recovery_records" enable trigger "trg_stamp";
CREATE TRIGGER trg_updated_at BEFORE UPDATE ON public.recovery_records FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
alter table "public"."recovery_records" enable trigger "trg_updated_at";
CREATE TRIGGER trg_version BEFORE UPDATE ON public.recovery_records FOR EACH ROW EXECUTE FUNCTION app.bump_version();
alter table "public"."recovery_records" enable trigger "trg_version";
CREATE TRIGGER trg_audit AFTER INSERT OR DELETE OR UPDATE ON public.risk_assessments FOR EACH ROW EXECUTE FUNCTION app.audit_row();
alter table "public"."risk_assessments" enable trigger "trg_audit";
CREATE TRIGGER trg_guard BEFORE UPDATE ON public.risk_assessments FOR EACH ROW EXECUTE FUNCTION app.guard_finalized();
alter table "public"."risk_assessments" enable trigger "trg_guard";
CREATE TRIGGER trg_stamp BEFORE INSERT ON public.risk_assessments FOR EACH ROW EXECUTE FUNCTION app.stamp_created();
alter table "public"."risk_assessments" enable trigger "trg_stamp";
CREATE TRIGGER trg_updated_at BEFORE UPDATE ON public.risk_assessments FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
alter table "public"."risk_assessments" enable trigger "trg_updated_at";
CREATE TRIGGER trg_version BEFORE UPDATE ON public.risk_assessments FOR EACH ROW EXECUTE FUNCTION app.bump_version();
alter table "public"."risk_assessments" enable trigger "trg_version";
CREATE TRIGGER trg_updated_at BEFORE UPDATE ON public.rooms FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
alter table "public"."rooms" enable trigger "trg_updated_at";
CREATE TRIGGER trg_updated_at BEFORE UPDATE ON public.standard_texts FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
alter table "public"."standard_texts" enable trigger "trg_updated_at";
CREATE TRIGGER trg_updated_at BEFORE UPDATE ON public.templates FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
alter table "public"."templates" enable trigger "trg_updated_at";
revoke all on function "app"."audit_row"() from public,"postgres","anon","authenticated","service_role","supabase_admin";
grant EXECUTE on function "app"."audit_row"() to public;
grant EXECUTE on function "app"."audit_row"() to "postgres";
revoke all on function "app"."bump_version"() from public,"postgres","anon","authenticated","service_role","supabase_admin";
grant EXECUTE on function "app"."bump_version"() to public;
grant EXECUTE on function "app"."bump_version"() to "postgres";
revoke all on function "app"."can_read_clinical"(p_org uuid, p_surgeon uuid) from public,"postgres","anon","authenticated","service_role","supabase_admin";
grant EXECUTE on function "app"."can_read_clinical"(p_org uuid, p_surgeon uuid) to public;
grant EXECUTE on function "app"."can_read_clinical"(p_org uuid, p_surgeon uuid) to "postgres";
revoke all on function "app"."can_write_clinical"(p_org uuid) from public,"postgres","anon","authenticated","service_role","supabase_admin";
grant EXECUTE on function "app"."can_write_clinical"(p_org uuid) to public;
grant EXECUTE on function "app"."can_write_clinical"(p_org uuid) to "postgres";
revoke all on function "app"."compartilhada_para_mim"(p_org uuid, p_modulo text) from public,"postgres","anon","authenticated","service_role","supabase_admin";
grant EXECUTE on function "app"."compartilhada_para_mim"(p_org uuid, p_modulo text) to public;
grant EXECUTE on function "app"."compartilhada_para_mim"(p_org uuid, p_modulo text) to "postgres";
revoke all on function "app"."eh_programador"() from public,"postgres","anon","authenticated","service_role","supabase_admin";
grant EXECUTE on function "app"."eh_programador"() to public;
grant EXECUTE on function "app"."eh_programador"() to "postgres";
revoke all on function "app"."guard_finalized"() from public,"postgres","anon","authenticated","service_role","supabase_admin";
grant EXECUTE on function "app"."guard_finalized"() to public;
grant EXECUTE on function "app"."guard_finalized"() to "postgres";
revoke all on function "app"."has_role"(p_org uuid, p_roles text[]) from public,"postgres","anon","authenticated","service_role","supabase_admin";
grant EXECUTE on function "app"."has_role"(p_org uuid, p_roles text[]) to public;
grant EXECUTE on function "app"."has_role"(p_org uuid, p_roles text[]) to "postgres";
revoke all on function "app"."modulos_do_papel"(p_org uuid) from public,"postgres","anon","authenticated","service_role","supabase_admin";
grant EXECUTE on function "app"."modulos_do_papel"(p_org uuid) to public;
grant EXECUTE on function "app"."modulos_do_papel"(p_org uuid) to "postgres";
revoke all on function "app"."org_ids"() from public,"postgres","anon","authenticated","service_role","supabase_admin";
grant EXECUTE on function "app"."org_ids"() to public;
grant EXECUTE on function "app"."org_ids"() to "postgres";
revoke all on function "app"."pode_editar_modulo"(p_org uuid, p_modulo text) from public,"postgres","anon","authenticated","service_role","supabase_admin";
grant EXECUTE on function "app"."pode_editar_modulo"(p_org uuid, p_modulo text) to public;
grant EXECUTE on function "app"."pode_editar_modulo"(p_org uuid, p_modulo text) to "postgres";
revoke all on function "app"."pode_modulo"(p_org uuid, p_modulo text) from public,"postgres","anon","authenticated","service_role","supabase_admin";
grant EXECUTE on function "app"."pode_modulo"(p_org uuid, p_modulo text) to public;
grant EXECUTE on function "app"."pode_modulo"(p_org uuid, p_modulo text) to "postgres";
revoke all on function "app"."pode_ver_registro"(p_org uuid, p_creator uuid) from public,"postgres","anon","authenticated","service_role","supabase_admin";
grant EXECUTE on function "app"."pode_ver_registro"(p_org uuid, p_creator uuid) to public;
grant EXECUTE on function "app"."pode_ver_registro"(p_org uuid, p_creator uuid) to "postgres";
revoke all on function "app"."set_updated_at"() from public,"postgres","anon","authenticated","service_role","supabase_admin";
grant EXECUTE on function "app"."set_updated_at"() to public;
grant EXECUTE on function "app"."set_updated_at"() to "postgres";
revoke all on function "app"."stamp_created"() from public,"postgres","anon","authenticated","service_role","supabase_admin";
grant EXECUTE on function "app"."stamp_created"() to public;
grant EXECUTE on function "app"."stamp_created"() to "postgres";
revoke all on function "app"."tem_config"(p_org uuid) from public,"postgres","anon","authenticated","service_role","supabase_admin";
grant EXECUTE on function "app"."tem_config"(p_org uuid) to public;
grant EXECUTE on function "app"."tem_config"(p_org uuid) to "postgres";
revoke all on function "app"."visibilidade_registros"(p_org uuid) from public,"postgres","anon","authenticated","service_role","supabase_admin";
grant EXECUTE on function "app"."visibilidade_registros"(p_org uuid) to public;
grant EXECUTE on function "app"."visibilidade_registros"(p_org uuid) to "postgres";
revoke all on function "public"."add_member"(p_org uuid, p_email text, p_role text) from public,"anon","authenticated","postgres","service_role","supabase_admin";
grant EXECUTE on function "public"."add_member"(p_org uuid, p_email text, p_role text) to public;
grant EXECUTE on function "public"."add_member"(p_org uuid, p_email text, p_role text) to "anon";
grant EXECUTE on function "public"."add_member"(p_org uuid, p_email text, p_role text) to "authenticated";
grant EXECUTE on function "public"."add_member"(p_org uuid, p_email text, p_role text) to "postgres";
grant EXECUTE on function "public"."add_member"(p_org uuid, p_email text, p_role text) to "service_role";
revoke all on function "public"."apresentacoes_do_principio"(p_principio_base text, p_tipo text, p_limite integer) from public,"anon","authenticated","postgres","service_role","supabase_admin";
grant EXECUTE on function "public"."apresentacoes_do_principio"(p_principio_base text, p_tipo text, p_limite integer) to public;
grant EXECUTE on function "public"."apresentacoes_do_principio"(p_principio_base text, p_tipo text, p_limite integer) to "anon";
grant EXECUTE on function "public"."apresentacoes_do_principio"(p_principio_base text, p_tipo text, p_limite integer) to "authenticated";
grant EXECUTE on function "public"."apresentacoes_do_principio"(p_principio_base text, p_tipo text, p_limite integer) to "postgres";
grant EXECUTE on function "public"."apresentacoes_do_principio"(p_principio_base text, p_tipo text, p_limite integer) to "service_role";
revoke all on function "public"."assinaturas_no_mutate"() from public,"anon","authenticated","postgres","service_role","supabase_admin";
grant EXECUTE on function "public"."assinaturas_no_mutate"() to public;
grant EXECUTE on function "public"."assinaturas_no_mutate"() to "anon";
grant EXECUTE on function "public"."assinaturas_no_mutate"() to "authenticated";
grant EXECUTE on function "public"."assinaturas_no_mutate"() to "postgres";
grant EXECUTE on function "public"."assinaturas_no_mutate"() to "service_role";
revoke all on function "public"."buscar_medicamentos"(p_termo text, p_tipo text, p_limite integer, p_so_comercializados boolean) from public,"anon","authenticated","postgres","service_role","supabase_admin";
grant EXECUTE on function "public"."buscar_medicamentos"(p_termo text, p_tipo text, p_limite integer, p_so_comercializados boolean) to public;
grant EXECUTE on function "public"."buscar_medicamentos"(p_termo text, p_tipo text, p_limite integer, p_so_comercializados boolean) to "anon";
grant EXECUTE on function "public"."buscar_medicamentos"(p_termo text, p_tipo text, p_limite integer, p_so_comercializados boolean) to "authenticated";
grant EXECUTE on function "public"."buscar_medicamentos"(p_termo text, p_tipo text, p_limite integer, p_so_comercializados boolean) to "postgres";
grant EXECUTE on function "public"."buscar_medicamentos"(p_termo text, p_tipo text, p_limite integer, p_so_comercializados boolean) to "service_role";
revoke all on function "public"."med_normalizar"(txt text) from public,"anon","authenticated","postgres","service_role","supabase_admin";
grant EXECUTE on function "public"."med_normalizar"(txt text) to public;
grant EXECUTE on function "public"."med_normalizar"(txt text) to "anon";
grant EXECUTE on function "public"."med_normalizar"(txt text) to "authenticated";
grant EXECUTE on function "public"."med_normalizar"(txt text) to "postgres";
grant EXECUTE on function "public"."med_normalizar"(txt text) to "service_role";
revoke all on function "public"."med_unaccent"(text) from public,"anon","authenticated","postgres","service_role","supabase_admin";
grant EXECUTE on function "public"."med_unaccent"(text) to public;
grant EXECUTE on function "public"."med_unaccent"(text) to "anon";
grant EXECUTE on function "public"."med_unaccent"(text) to "authenticated";
grant EXECUTE on function "public"."med_unaccent"(text) to "postgres";
grant EXECUTE on function "public"."med_unaccent"(text) to "service_role";
revoke all on function "public"."prog_add_member"(p_org uuid, p_email text, p_role text) from public,"anon","authenticated","postgres","service_role","supabase_admin";
grant EXECUTE on function "public"."prog_add_member"(p_org uuid, p_email text, p_role text) to public;
grant EXECUTE on function "public"."prog_add_member"(p_org uuid, p_email text, p_role text) to "anon";
grant EXECUTE on function "public"."prog_add_member"(p_org uuid, p_email text, p_role text) to "authenticated";
grant EXECUTE on function "public"."prog_add_member"(p_org uuid, p_email text, p_role text) to "postgres";
grant EXECUTE on function "public"."prog_add_member"(p_org uuid, p_email text, p_role text) to "service_role";
revoke all on function "public"."prog_contar_ambiente"(p_org uuid) from public,"anon","authenticated","postgres","service_role","supabase_admin";
grant EXECUTE on function "public"."prog_contar_ambiente"(p_org uuid) to public;
grant EXECUTE on function "public"."prog_contar_ambiente"(p_org uuid) to "anon";
grant EXECUTE on function "public"."prog_contar_ambiente"(p_org uuid) to "authenticated";
grant EXECUTE on function "public"."prog_contar_ambiente"(p_org uuid) to "postgres";
grant EXECUTE on function "public"."prog_contar_ambiente"(p_org uuid) to "service_role";
revoke all on function "public"."prog_criar_ambiente"(p_nome text, p_email_gestor text) from public,"anon","authenticated","postgres","service_role","supabase_admin";
grant EXECUTE on function "public"."prog_criar_ambiente"(p_nome text, p_email_gestor text) to public;
grant EXECUTE on function "public"."prog_criar_ambiente"(p_nome text, p_email_gestor text) to "anon";
grant EXECUTE on function "public"."prog_criar_ambiente"(p_nome text, p_email_gestor text) to "authenticated";
grant EXECUTE on function "public"."prog_criar_ambiente"(p_nome text, p_email_gestor text) to "postgres";
grant EXECUTE on function "public"."prog_criar_ambiente"(p_nome text, p_email_gestor text) to "service_role";
revoke all on function "public"."prog_excluir_ambiente"(p_org uuid, p_confirmo_registros boolean) from public,"anon","authenticated","postgres","service_role","supabase_admin";
grant EXECUTE on function "public"."prog_excluir_ambiente"(p_org uuid, p_confirmo_registros boolean) to public;
grant EXECUTE on function "public"."prog_excluir_ambiente"(p_org uuid, p_confirmo_registros boolean) to "anon";
grant EXECUTE on function "public"."prog_excluir_ambiente"(p_org uuid, p_confirmo_registros boolean) to "authenticated";
grant EXECUTE on function "public"."prog_excluir_ambiente"(p_org uuid, p_confirmo_registros boolean) to "postgres";
grant EXECUTE on function "public"."prog_excluir_ambiente"(p_org uuid, p_confirmo_registros boolean) to "service_role";
revoke all on function "public"."prog_excluir_conta"(p_user uuid) from public,"anon","authenticated","postgres","service_role","supabase_admin";
grant EXECUTE on function "public"."prog_excluir_conta"(p_user uuid) to public;
grant EXECUTE on function "public"."prog_excluir_conta"(p_user uuid) to "anon";
grant EXECUTE on function "public"."prog_excluir_conta"(p_user uuid) to "authenticated";
grant EXECUTE on function "public"."prog_excluir_conta"(p_user uuid) to "postgres";
grant EXECUTE on function "public"."prog_excluir_conta"(p_user uuid) to "service_role";
revoke all on function "public"."prog_remover_membro"(p_org uuid, p_user uuid) from public,"anon","authenticated","postgres","service_role","supabase_admin";
grant EXECUTE on function "public"."prog_remover_membro"(p_org uuid, p_user uuid) to public;
grant EXECUTE on function "public"."prog_remover_membro"(p_org uuid, p_user uuid) to "anon";
grant EXECUTE on function "public"."prog_remover_membro"(p_org uuid, p_user uuid) to "authenticated";
grant EXECUTE on function "public"."prog_remover_membro"(p_org uuid, p_user uuid) to "postgres";
grant EXECUTE on function "public"."prog_remover_membro"(p_org uuid, p_user uuid) to "service_role";
revoke all on function "public"."refresh_medicamentos_clinicos"() from public,"anon","authenticated","postgres","service_role","supabase_admin";
grant EXECUTE on function "public"."refresh_medicamentos_clinicos"() to "anon";
grant EXECUTE on function "public"."refresh_medicamentos_clinicos"() to "authenticated";
grant EXECUTE on function "public"."refresh_medicamentos_clinicos"() to "postgres";
grant EXECUTE on function "public"."refresh_medicamentos_clinicos"() to "service_role";
revoke all on function "public"."set_updated_at"() from public,"anon","authenticated","postgres","service_role","supabase_admin";
grant EXECUTE on function "public"."set_updated_at"() to public;
grant EXECUTE on function "public"."set_updated_at"() to "anon";
grant EXECUTE on function "public"."set_updated_at"() to "authenticated";
grant EXECUTE on function "public"."set_updated_at"() to "postgres";
grant EXECUTE on function "public"."set_updated_at"() to "service_role";
revoke all on table "public"."addenda" from public,"anon","authenticated","postgres","service_role","supabase_admin";
grant DELETE on table "public"."addenda" to "anon";
grant INSERT on table "public"."addenda" to "anon";
grant MAINTAIN on table "public"."addenda" to "anon";
grant REFERENCES on table "public"."addenda" to "anon";
grant SELECT on table "public"."addenda" to "anon";
grant TRIGGER on table "public"."addenda" to "anon";
grant TRUNCATE on table "public"."addenda" to "anon";
grant UPDATE on table "public"."addenda" to "anon";
grant DELETE on table "public"."addenda" to "authenticated";
grant INSERT on table "public"."addenda" to "authenticated";
grant MAINTAIN on table "public"."addenda" to "authenticated";
grant REFERENCES on table "public"."addenda" to "authenticated";
grant SELECT on table "public"."addenda" to "authenticated";
grant TRIGGER on table "public"."addenda" to "authenticated";
grant TRUNCATE on table "public"."addenda" to "authenticated";
grant UPDATE on table "public"."addenda" to "authenticated";
grant DELETE on table "public"."addenda" to "postgres";
grant INSERT on table "public"."addenda" to "postgres";
grant MAINTAIN on table "public"."addenda" to "postgres";
grant REFERENCES on table "public"."addenda" to "postgres";
grant SELECT on table "public"."addenda" to "postgres";
grant TRIGGER on table "public"."addenda" to "postgres";
grant TRUNCATE on table "public"."addenda" to "postgres";
grant UPDATE on table "public"."addenda" to "postgres";
grant DELETE on table "public"."addenda" to "service_role";
grant INSERT on table "public"."addenda" to "service_role";
grant MAINTAIN on table "public"."addenda" to "service_role";
grant REFERENCES on table "public"."addenda" to "service_role";
grant SELECT on table "public"."addenda" to "service_role";
grant TRIGGER on table "public"."addenda" to "service_role";
grant TRUNCATE on table "public"."addenda" to "service_role";
grant UPDATE on table "public"."addenda" to "service_role";
revoke all on table "public"."anesthesia_records" from public,"anon","authenticated","postgres","service_role","supabase_admin";
grant DELETE on table "public"."anesthesia_records" to "anon";
grant INSERT on table "public"."anesthesia_records" to "anon";
grant MAINTAIN on table "public"."anesthesia_records" to "anon";
grant REFERENCES on table "public"."anesthesia_records" to "anon";
grant SELECT on table "public"."anesthesia_records" to "anon";
grant TRIGGER on table "public"."anesthesia_records" to "anon";
grant TRUNCATE on table "public"."anesthesia_records" to "anon";
grant UPDATE on table "public"."anesthesia_records" to "anon";
grant DELETE on table "public"."anesthesia_records" to "authenticated";
grant INSERT on table "public"."anesthesia_records" to "authenticated";
grant MAINTAIN on table "public"."anesthesia_records" to "authenticated";
grant REFERENCES on table "public"."anesthesia_records" to "authenticated";
grant SELECT on table "public"."anesthesia_records" to "authenticated";
grant TRIGGER on table "public"."anesthesia_records" to "authenticated";
grant TRUNCATE on table "public"."anesthesia_records" to "authenticated";
grant UPDATE on table "public"."anesthesia_records" to "authenticated";
grant DELETE on table "public"."anesthesia_records" to "postgres";
grant INSERT on table "public"."anesthesia_records" to "postgres";
grant MAINTAIN on table "public"."anesthesia_records" to "postgres";
grant REFERENCES on table "public"."anesthesia_records" to "postgres";
grant SELECT on table "public"."anesthesia_records" to "postgres";
grant TRIGGER on table "public"."anesthesia_records" to "postgres";
grant TRUNCATE on table "public"."anesthesia_records" to "postgres";
grant UPDATE on table "public"."anesthesia_records" to "postgres";
grant DELETE on table "public"."anesthesia_records" to "service_role";
grant INSERT on table "public"."anesthesia_records" to "service_role";
grant MAINTAIN on table "public"."anesthesia_records" to "service_role";
grant REFERENCES on table "public"."anesthesia_records" to "service_role";
grant SELECT on table "public"."anesthesia_records" to "service_role";
grant TRIGGER on table "public"."anesthesia_records" to "service_role";
grant TRUNCATE on table "public"."anesthesia_records" to "service_role";
grant UPDATE on table "public"."anesthesia_records" to "service_role";
revoke all on table "public"."anesthesia_timeline_events" from public,"anon","authenticated","postgres","service_role","supabase_admin";
grant DELETE on table "public"."anesthesia_timeline_events" to "anon";
grant INSERT on table "public"."anesthesia_timeline_events" to "anon";
grant MAINTAIN on table "public"."anesthesia_timeline_events" to "anon";
grant REFERENCES on table "public"."anesthesia_timeline_events" to "anon";
grant SELECT on table "public"."anesthesia_timeline_events" to "anon";
grant TRIGGER on table "public"."anesthesia_timeline_events" to "anon";
grant TRUNCATE on table "public"."anesthesia_timeline_events" to "anon";
grant UPDATE on table "public"."anesthesia_timeline_events" to "anon";
grant DELETE on table "public"."anesthesia_timeline_events" to "authenticated";
grant INSERT on table "public"."anesthesia_timeline_events" to "authenticated";
grant MAINTAIN on table "public"."anesthesia_timeline_events" to "authenticated";
grant REFERENCES on table "public"."anesthesia_timeline_events" to "authenticated";
grant SELECT on table "public"."anesthesia_timeline_events" to "authenticated";
grant TRIGGER on table "public"."anesthesia_timeline_events" to "authenticated";
grant TRUNCATE on table "public"."anesthesia_timeline_events" to "authenticated";
grant UPDATE on table "public"."anesthesia_timeline_events" to "authenticated";
grant DELETE on table "public"."anesthesia_timeline_events" to "postgres";
grant INSERT on table "public"."anesthesia_timeline_events" to "postgres";
grant MAINTAIN on table "public"."anesthesia_timeline_events" to "postgres";
grant REFERENCES on table "public"."anesthesia_timeline_events" to "postgres";
grant SELECT on table "public"."anesthesia_timeline_events" to "postgres";
grant TRIGGER on table "public"."anesthesia_timeline_events" to "postgres";
grant TRUNCATE on table "public"."anesthesia_timeline_events" to "postgres";
grant UPDATE on table "public"."anesthesia_timeline_events" to "postgres";
grant DELETE on table "public"."anesthesia_timeline_events" to "service_role";
grant INSERT on table "public"."anesthesia_timeline_events" to "service_role";
grant MAINTAIN on table "public"."anesthesia_timeline_events" to "service_role";
grant REFERENCES on table "public"."anesthesia_timeline_events" to "service_role";
grant SELECT on table "public"."anesthesia_timeline_events" to "service_role";
grant TRIGGER on table "public"."anesthesia_timeline_events" to "service_role";
grant TRUNCATE on table "public"."anesthesia_timeline_events" to "service_role";
grant UPDATE on table "public"."anesthesia_timeline_events" to "service_role";
revoke all on table "public"."app_programmers" from public,"anon","authenticated","postgres","service_role","supabase_admin";
grant DELETE on table "public"."app_programmers" to "anon";
grant INSERT on table "public"."app_programmers" to "anon";
grant MAINTAIN on table "public"."app_programmers" to "anon";
grant REFERENCES on table "public"."app_programmers" to "anon";
grant SELECT on table "public"."app_programmers" to "anon";
grant TRIGGER on table "public"."app_programmers" to "anon";
grant TRUNCATE on table "public"."app_programmers" to "anon";
grant UPDATE on table "public"."app_programmers" to "anon";
grant DELETE on table "public"."app_programmers" to "authenticated";
grant INSERT on table "public"."app_programmers" to "authenticated";
grant MAINTAIN on table "public"."app_programmers" to "authenticated";
grant REFERENCES on table "public"."app_programmers" to "authenticated";
grant SELECT on table "public"."app_programmers" to "authenticated";
grant TRIGGER on table "public"."app_programmers" to "authenticated";
grant TRUNCATE on table "public"."app_programmers" to "authenticated";
grant UPDATE on table "public"."app_programmers" to "authenticated";
grant DELETE on table "public"."app_programmers" to "postgres";
grant INSERT on table "public"."app_programmers" to "postgres";
grant MAINTAIN on table "public"."app_programmers" to "postgres";
grant REFERENCES on table "public"."app_programmers" to "postgres";
grant SELECT on table "public"."app_programmers" to "postgres";
grant TRIGGER on table "public"."app_programmers" to "postgres";
grant TRUNCATE on table "public"."app_programmers" to "postgres";
grant UPDATE on table "public"."app_programmers" to "postgres";
grant DELETE on table "public"."app_programmers" to "service_role";
grant INSERT on table "public"."app_programmers" to "service_role";
grant MAINTAIN on table "public"."app_programmers" to "service_role";
grant REFERENCES on table "public"."app_programmers" to "service_role";
grant SELECT on table "public"."app_programmers" to "service_role";
grant TRIGGER on table "public"."app_programmers" to "service_role";
grant TRUNCATE on table "public"."app_programmers" to "service_role";
grant UPDATE on table "public"."app_programmers" to "service_role";
revoke all on table "public"."appointments" from public,"anon","authenticated","postgres","service_role","supabase_admin";
grant DELETE on table "public"."appointments" to "anon";
grant INSERT on table "public"."appointments" to "anon";
grant MAINTAIN on table "public"."appointments" to "anon";
grant REFERENCES on table "public"."appointments" to "anon";
grant SELECT on table "public"."appointments" to "anon";
grant TRIGGER on table "public"."appointments" to "anon";
grant TRUNCATE on table "public"."appointments" to "anon";
grant UPDATE on table "public"."appointments" to "anon";
grant DELETE on table "public"."appointments" to "authenticated";
grant INSERT on table "public"."appointments" to "authenticated";
grant MAINTAIN on table "public"."appointments" to "authenticated";
grant REFERENCES on table "public"."appointments" to "authenticated";
grant SELECT on table "public"."appointments" to "authenticated";
grant TRIGGER on table "public"."appointments" to "authenticated";
grant TRUNCATE on table "public"."appointments" to "authenticated";
grant UPDATE on table "public"."appointments" to "authenticated";
grant DELETE on table "public"."appointments" to "postgres";
grant INSERT on table "public"."appointments" to "postgres";
grant MAINTAIN on table "public"."appointments" to "postgres";
grant REFERENCES on table "public"."appointments" to "postgres";
grant SELECT on table "public"."appointments" to "postgres";
grant TRIGGER on table "public"."appointments" to "postgres";
grant TRUNCATE on table "public"."appointments" to "postgres";
grant UPDATE on table "public"."appointments" to "postgres";
grant DELETE on table "public"."appointments" to "service_role";
grant INSERT on table "public"."appointments" to "service_role";
grant MAINTAIN on table "public"."appointments" to "service_role";
grant REFERENCES on table "public"."appointments" to "service_role";
grant SELECT on table "public"."appointments" to "service_role";
grant TRIGGER on table "public"."appointments" to "service_role";
grant TRUNCATE on table "public"."appointments" to "service_role";
grant UPDATE on table "public"."appointments" to "service_role";
revoke all on table "public"."assinaturas" from public,"anon","authenticated","postgres","service_role","supabase_admin";
grant DELETE on table "public"."assinaturas" to "anon";
grant INSERT on table "public"."assinaturas" to "anon";
grant MAINTAIN on table "public"."assinaturas" to "anon";
grant REFERENCES on table "public"."assinaturas" to "anon";
grant SELECT on table "public"."assinaturas" to "anon";
grant TRIGGER on table "public"."assinaturas" to "anon";
grant TRUNCATE on table "public"."assinaturas" to "anon";
grant UPDATE on table "public"."assinaturas" to "anon";
grant DELETE on table "public"."assinaturas" to "authenticated";
grant INSERT on table "public"."assinaturas" to "authenticated";
grant MAINTAIN on table "public"."assinaturas" to "authenticated";
grant REFERENCES on table "public"."assinaturas" to "authenticated";
grant SELECT on table "public"."assinaturas" to "authenticated";
grant TRIGGER on table "public"."assinaturas" to "authenticated";
grant TRUNCATE on table "public"."assinaturas" to "authenticated";
grant UPDATE on table "public"."assinaturas" to "authenticated";
grant DELETE on table "public"."assinaturas" to "postgres";
grant INSERT on table "public"."assinaturas" to "postgres";
grant MAINTAIN on table "public"."assinaturas" to "postgres";
grant REFERENCES on table "public"."assinaturas" to "postgres";
grant SELECT on table "public"."assinaturas" to "postgres";
grant TRIGGER on table "public"."assinaturas" to "postgres";
grant TRUNCATE on table "public"."assinaturas" to "postgres";
grant UPDATE on table "public"."assinaturas" to "postgres";
grant DELETE on table "public"."assinaturas" to "service_role";
grant INSERT on table "public"."assinaturas" to "service_role";
grant MAINTAIN on table "public"."assinaturas" to "service_role";
grant REFERENCES on table "public"."assinaturas" to "service_role";
grant SELECT on table "public"."assinaturas" to "service_role";
grant TRIGGER on table "public"."assinaturas" to "service_role";
grant TRUNCATE on table "public"."assinaturas" to "service_role";
grant UPDATE on table "public"."assinaturas" to "service_role";
revoke all on table "public"."assinaturas_publicas" from public,"anon","authenticated","postgres","service_role","supabase_admin";
grant DELETE on table "public"."assinaturas_publicas" to "anon";
grant INSERT on table "public"."assinaturas_publicas" to "anon";
grant MAINTAIN on table "public"."assinaturas_publicas" to "anon";
grant REFERENCES on table "public"."assinaturas_publicas" to "anon";
grant SELECT on table "public"."assinaturas_publicas" to "anon";
grant TRIGGER on table "public"."assinaturas_publicas" to "anon";
grant TRUNCATE on table "public"."assinaturas_publicas" to "anon";
grant UPDATE on table "public"."assinaturas_publicas" to "anon";
grant DELETE on table "public"."assinaturas_publicas" to "authenticated";
grant INSERT on table "public"."assinaturas_publicas" to "authenticated";
grant MAINTAIN on table "public"."assinaturas_publicas" to "authenticated";
grant REFERENCES on table "public"."assinaturas_publicas" to "authenticated";
grant SELECT on table "public"."assinaturas_publicas" to "authenticated";
grant TRIGGER on table "public"."assinaturas_publicas" to "authenticated";
grant TRUNCATE on table "public"."assinaturas_publicas" to "authenticated";
grant UPDATE on table "public"."assinaturas_publicas" to "authenticated";
grant DELETE on table "public"."assinaturas_publicas" to "postgres";
grant INSERT on table "public"."assinaturas_publicas" to "postgres";
grant MAINTAIN on table "public"."assinaturas_publicas" to "postgres";
grant REFERENCES on table "public"."assinaturas_publicas" to "postgres";
grant SELECT on table "public"."assinaturas_publicas" to "postgres";
grant TRIGGER on table "public"."assinaturas_publicas" to "postgres";
grant TRUNCATE on table "public"."assinaturas_publicas" to "postgres";
grant UPDATE on table "public"."assinaturas_publicas" to "postgres";
grant DELETE on table "public"."assinaturas_publicas" to "service_role";
grant INSERT on table "public"."assinaturas_publicas" to "service_role";
grant MAINTAIN on table "public"."assinaturas_publicas" to "service_role";
grant REFERENCES on table "public"."assinaturas_publicas" to "service_role";
grant SELECT on table "public"."assinaturas_publicas" to "service_role";
grant TRIGGER on table "public"."assinaturas_publicas" to "service_role";
grant TRUNCATE on table "public"."assinaturas_publicas" to "service_role";
grant UPDATE on table "public"."assinaturas_publicas" to "service_role";
revoke all on table "public"."attachments" from public,"anon","authenticated","postgres","service_role","supabase_admin";
grant DELETE on table "public"."attachments" to "anon";
grant INSERT on table "public"."attachments" to "anon";
grant MAINTAIN on table "public"."attachments" to "anon";
grant REFERENCES on table "public"."attachments" to "anon";
grant SELECT on table "public"."attachments" to "anon";
grant TRIGGER on table "public"."attachments" to "anon";
grant TRUNCATE on table "public"."attachments" to "anon";
grant UPDATE on table "public"."attachments" to "anon";
grant DELETE on table "public"."attachments" to "authenticated";
grant INSERT on table "public"."attachments" to "authenticated";
grant MAINTAIN on table "public"."attachments" to "authenticated";
grant REFERENCES on table "public"."attachments" to "authenticated";
grant SELECT on table "public"."attachments" to "authenticated";
grant TRIGGER on table "public"."attachments" to "authenticated";
grant TRUNCATE on table "public"."attachments" to "authenticated";
grant UPDATE on table "public"."attachments" to "authenticated";
grant DELETE on table "public"."attachments" to "postgres";
grant INSERT on table "public"."attachments" to "postgres";
grant MAINTAIN on table "public"."attachments" to "postgres";
grant REFERENCES on table "public"."attachments" to "postgres";
grant SELECT on table "public"."attachments" to "postgres";
grant TRIGGER on table "public"."attachments" to "postgres";
grant TRUNCATE on table "public"."attachments" to "postgres";
grant UPDATE on table "public"."attachments" to "postgres";
grant DELETE on table "public"."attachments" to "service_role";
grant INSERT on table "public"."attachments" to "service_role";
grant MAINTAIN on table "public"."attachments" to "service_role";
grant REFERENCES on table "public"."attachments" to "service_role";
grant SELECT on table "public"."attachments" to "service_role";
grant TRIGGER on table "public"."attachments" to "service_role";
grant TRUNCATE on table "public"."attachments" to "service_role";
grant UPDATE on table "public"."attachments" to "service_role";
revoke all on table "public"."audit_logs" from public,"anon","authenticated","postgres","service_role","supabase_admin";
grant DELETE on table "public"."audit_logs" to "anon";
grant INSERT on table "public"."audit_logs" to "anon";
grant MAINTAIN on table "public"."audit_logs" to "anon";
grant REFERENCES on table "public"."audit_logs" to "anon";
grant SELECT on table "public"."audit_logs" to "anon";
grant TRIGGER on table "public"."audit_logs" to "anon";
grant TRUNCATE on table "public"."audit_logs" to "anon";
grant UPDATE on table "public"."audit_logs" to "anon";
grant DELETE on table "public"."audit_logs" to "authenticated";
grant INSERT on table "public"."audit_logs" to "authenticated";
grant MAINTAIN on table "public"."audit_logs" to "authenticated";
grant REFERENCES on table "public"."audit_logs" to "authenticated";
grant SELECT on table "public"."audit_logs" to "authenticated";
grant TRIGGER on table "public"."audit_logs" to "authenticated";
grant TRUNCATE on table "public"."audit_logs" to "authenticated";
grant UPDATE on table "public"."audit_logs" to "authenticated";
grant DELETE on table "public"."audit_logs" to "postgres";
grant INSERT on table "public"."audit_logs" to "postgres";
grant MAINTAIN on table "public"."audit_logs" to "postgres";
grant REFERENCES on table "public"."audit_logs" to "postgres";
grant SELECT on table "public"."audit_logs" to "postgres";
grant TRIGGER on table "public"."audit_logs" to "postgres";
grant TRUNCATE on table "public"."audit_logs" to "postgres";
grant UPDATE on table "public"."audit_logs" to "postgres";
grant DELETE on table "public"."audit_logs" to "service_role";
grant INSERT on table "public"."audit_logs" to "service_role";
grant MAINTAIN on table "public"."audit_logs" to "service_role";
grant REFERENCES on table "public"."audit_logs" to "service_role";
grant SELECT on table "public"."audit_logs" to "service_role";
grant TRIGGER on table "public"."audit_logs" to "service_role";
grant TRUNCATE on table "public"."audit_logs" to "service_role";
grant UPDATE on table "public"."audit_logs" to "service_role";
revoke all on table "public"."consents" from public,"anon","authenticated","postgres","service_role","supabase_admin";
grant DELETE on table "public"."consents" to "anon";
grant INSERT on table "public"."consents" to "anon";
grant MAINTAIN on table "public"."consents" to "anon";
grant REFERENCES on table "public"."consents" to "anon";
grant SELECT on table "public"."consents" to "anon";
grant TRIGGER on table "public"."consents" to "anon";
grant TRUNCATE on table "public"."consents" to "anon";
grant UPDATE on table "public"."consents" to "anon";
grant DELETE on table "public"."consents" to "authenticated";
grant INSERT on table "public"."consents" to "authenticated";
grant MAINTAIN on table "public"."consents" to "authenticated";
grant REFERENCES on table "public"."consents" to "authenticated";
grant SELECT on table "public"."consents" to "authenticated";
grant TRIGGER on table "public"."consents" to "authenticated";
grant TRUNCATE on table "public"."consents" to "authenticated";
grant UPDATE on table "public"."consents" to "authenticated";
grant DELETE on table "public"."consents" to "postgres";
grant INSERT on table "public"."consents" to "postgres";
grant MAINTAIN on table "public"."consents" to "postgres";
grant REFERENCES on table "public"."consents" to "postgres";
grant SELECT on table "public"."consents" to "postgres";
grant TRIGGER on table "public"."consents" to "postgres";
grant TRUNCATE on table "public"."consents" to "postgres";
grant UPDATE on table "public"."consents" to "postgres";
grant DELETE on table "public"."consents" to "service_role";
grant INSERT on table "public"."consents" to "service_role";
grant MAINTAIN on table "public"."consents" to "service_role";
grant REFERENCES on table "public"."consents" to "service_role";
grant SELECT on table "public"."consents" to "service_role";
grant TRIGGER on table "public"."consents" to "service_role";
grant TRUNCATE on table "public"."consents" to "service_role";
grant UPDATE on table "public"."consents" to "service_role";
revoke all on table "public"."consultations" from public,"anon","authenticated","postgres","service_role","supabase_admin";
grant DELETE on table "public"."consultations" to "anon";
grant INSERT on table "public"."consultations" to "anon";
grant MAINTAIN on table "public"."consultations" to "anon";
grant REFERENCES on table "public"."consultations" to "anon";
grant SELECT on table "public"."consultations" to "anon";
grant TRIGGER on table "public"."consultations" to "anon";
grant TRUNCATE on table "public"."consultations" to "anon";
grant UPDATE on table "public"."consultations" to "anon";
grant DELETE on table "public"."consultations" to "authenticated";
grant INSERT on table "public"."consultations" to "authenticated";
grant MAINTAIN on table "public"."consultations" to "authenticated";
grant REFERENCES on table "public"."consultations" to "authenticated";
grant SELECT on table "public"."consultations" to "authenticated";
grant TRIGGER on table "public"."consultations" to "authenticated";
grant TRUNCATE on table "public"."consultations" to "authenticated";
grant UPDATE on table "public"."consultations" to "authenticated";
grant DELETE on table "public"."consultations" to "postgres";
grant INSERT on table "public"."consultations" to "postgres";
grant MAINTAIN on table "public"."consultations" to "postgres";
grant REFERENCES on table "public"."consultations" to "postgres";
grant SELECT on table "public"."consultations" to "postgres";
grant TRIGGER on table "public"."consultations" to "postgres";
grant TRUNCATE on table "public"."consultations" to "postgres";
grant UPDATE on table "public"."consultations" to "postgres";
grant DELETE on table "public"."consultations" to "service_role";
grant INSERT on table "public"."consultations" to "service_role";
grant MAINTAIN on table "public"."consultations" to "service_role";
grant REFERENCES on table "public"."consultations" to "service_role";
grant SELECT on table "public"."consultations" to "service_role";
grant TRIGGER on table "public"."consultations" to "service_role";
grant TRUNCATE on table "public"."consultations" to "service_role";
grant UPDATE on table "public"."consultations" to "service_role";
revoke all on table "public"."documentos" from public,"anon","authenticated","postgres","service_role","supabase_admin";
grant DELETE on table "public"."documentos" to "anon";
grant INSERT on table "public"."documentos" to "anon";
grant MAINTAIN on table "public"."documentos" to "anon";
grant REFERENCES on table "public"."documentos" to "anon";
grant SELECT on table "public"."documentos" to "anon";
grant TRIGGER on table "public"."documentos" to "anon";
grant TRUNCATE on table "public"."documentos" to "anon";
grant UPDATE on table "public"."documentos" to "anon";
grant DELETE on table "public"."documentos" to "authenticated";
grant INSERT on table "public"."documentos" to "authenticated";
grant MAINTAIN on table "public"."documentos" to "authenticated";
grant REFERENCES on table "public"."documentos" to "authenticated";
grant SELECT on table "public"."documentos" to "authenticated";
grant TRIGGER on table "public"."documentos" to "authenticated";
grant TRUNCATE on table "public"."documentos" to "authenticated";
grant UPDATE on table "public"."documentos" to "authenticated";
grant DELETE on table "public"."documentos" to "postgres";
grant INSERT on table "public"."documentos" to "postgres";
grant MAINTAIN on table "public"."documentos" to "postgres";
grant REFERENCES on table "public"."documentos" to "postgres";
grant SELECT on table "public"."documentos" to "postgres";
grant TRIGGER on table "public"."documentos" to "postgres";
grant TRUNCATE on table "public"."documentos" to "postgres";
grant UPDATE on table "public"."documentos" to "postgres";
grant DELETE on table "public"."documentos" to "service_role";
grant INSERT on table "public"."documentos" to "service_role";
grant MAINTAIN on table "public"."documentos" to "service_role";
grant REFERENCES on table "public"."documentos" to "service_role";
grant SELECT on table "public"."documentos" to "service_role";
grant TRIGGER on table "public"."documentos" to "service_role";
grant TRUNCATE on table "public"."documentos" to "service_role";
grant UPDATE on table "public"."documentos" to "service_role";
revoke all on table "public"."documents" from public,"anon","authenticated","postgres","service_role","supabase_admin";
grant DELETE on table "public"."documents" to "anon";
grant INSERT on table "public"."documents" to "anon";
grant MAINTAIN on table "public"."documents" to "anon";
grant REFERENCES on table "public"."documents" to "anon";
grant SELECT on table "public"."documents" to "anon";
grant TRIGGER on table "public"."documents" to "anon";
grant TRUNCATE on table "public"."documents" to "anon";
grant UPDATE on table "public"."documents" to "anon";
grant DELETE on table "public"."documents" to "authenticated";
grant INSERT on table "public"."documents" to "authenticated";
grant MAINTAIN on table "public"."documents" to "authenticated";
grant REFERENCES on table "public"."documents" to "authenticated";
grant SELECT on table "public"."documents" to "authenticated";
grant TRIGGER on table "public"."documents" to "authenticated";
grant TRUNCATE on table "public"."documents" to "authenticated";
grant UPDATE on table "public"."documents" to "authenticated";
grant DELETE on table "public"."documents" to "postgres";
grant INSERT on table "public"."documents" to "postgres";
grant MAINTAIN on table "public"."documents" to "postgres";
grant REFERENCES on table "public"."documents" to "postgres";
grant SELECT on table "public"."documents" to "postgres";
grant TRIGGER on table "public"."documents" to "postgres";
grant TRUNCATE on table "public"."documents" to "postgres";
grant UPDATE on table "public"."documents" to "postgres";
grant DELETE on table "public"."documents" to "service_role";
grant INSERT on table "public"."documents" to "service_role";
grant MAINTAIN on table "public"."documents" to "service_role";
grant REFERENCES on table "public"."documents" to "service_role";
grant SELECT on table "public"."documents" to "service_role";
grant TRIGGER on table "public"."documents" to "service_role";
grant TRUNCATE on table "public"."documents" to "service_role";
grant UPDATE on table "public"."documents" to "service_role";
revoke all on table "public"."encounters" from public,"anon","authenticated","postgres","service_role","supabase_admin";
grant DELETE on table "public"."encounters" to "anon";
grant INSERT on table "public"."encounters" to "anon";
grant MAINTAIN on table "public"."encounters" to "anon";
grant REFERENCES on table "public"."encounters" to "anon";
grant SELECT on table "public"."encounters" to "anon";
grant TRIGGER on table "public"."encounters" to "anon";
grant TRUNCATE on table "public"."encounters" to "anon";
grant UPDATE on table "public"."encounters" to "anon";
grant DELETE on table "public"."encounters" to "authenticated";
grant INSERT on table "public"."encounters" to "authenticated";
grant MAINTAIN on table "public"."encounters" to "authenticated";
grant REFERENCES on table "public"."encounters" to "authenticated";
grant SELECT on table "public"."encounters" to "authenticated";
grant TRIGGER on table "public"."encounters" to "authenticated";
grant TRUNCATE on table "public"."encounters" to "authenticated";
grant UPDATE on table "public"."encounters" to "authenticated";
grant DELETE on table "public"."encounters" to "postgres";
grant INSERT on table "public"."encounters" to "postgres";
grant MAINTAIN on table "public"."encounters" to "postgres";
grant REFERENCES on table "public"."encounters" to "postgres";
grant SELECT on table "public"."encounters" to "postgres";
grant TRIGGER on table "public"."encounters" to "postgres";
grant TRUNCATE on table "public"."encounters" to "postgres";
grant UPDATE on table "public"."encounters" to "postgres";
grant DELETE on table "public"."encounters" to "service_role";
grant INSERT on table "public"."encounters" to "service_role";
grant MAINTAIN on table "public"."encounters" to "service_role";
grant REFERENCES on table "public"."encounters" to "service_role";
grant SELECT on table "public"."encounters" to "service_role";
grant TRIGGER on table "public"."encounters" to "service_role";
grant TRUNCATE on table "public"."encounters" to "service_role";
grant UPDATE on table "public"."encounters" to "service_role";
revoke all on table "public"."equipment" from public,"anon","authenticated","postgres","service_role","supabase_admin";
grant DELETE on table "public"."equipment" to "anon";
grant INSERT on table "public"."equipment" to "anon";
grant MAINTAIN on table "public"."equipment" to "anon";
grant REFERENCES on table "public"."equipment" to "anon";
grant SELECT on table "public"."equipment" to "anon";
grant TRIGGER on table "public"."equipment" to "anon";
grant TRUNCATE on table "public"."equipment" to "anon";
grant UPDATE on table "public"."equipment" to "anon";
grant DELETE on table "public"."equipment" to "authenticated";
grant INSERT on table "public"."equipment" to "authenticated";
grant MAINTAIN on table "public"."equipment" to "authenticated";
grant REFERENCES on table "public"."equipment" to "authenticated";
grant SELECT on table "public"."equipment" to "authenticated";
grant TRIGGER on table "public"."equipment" to "authenticated";
grant TRUNCATE on table "public"."equipment" to "authenticated";
grant UPDATE on table "public"."equipment" to "authenticated";
grant DELETE on table "public"."equipment" to "postgres";
grant INSERT on table "public"."equipment" to "postgres";
grant MAINTAIN on table "public"."equipment" to "postgres";
grant REFERENCES on table "public"."equipment" to "postgres";
grant SELECT on table "public"."equipment" to "postgres";
grant TRIGGER on table "public"."equipment" to "postgres";
grant TRUNCATE on table "public"."equipment" to "postgres";
grant UPDATE on table "public"."equipment" to "postgres";
grant DELETE on table "public"."equipment" to "service_role";
grant INSERT on table "public"."equipment" to "service_role";
grant MAINTAIN on table "public"."equipment" to "service_role";
grant REFERENCES on table "public"."equipment" to "service_role";
grant SELECT on table "public"."equipment" to "service_role";
grant TRIGGER on table "public"."equipment" to "service_role";
grant TRUNCATE on table "public"."equipment" to "service_role";
grant UPDATE on table "public"."equipment" to "service_role";
revoke all on table "public"."finance_entries" from public,"anon","authenticated","postgres","service_role","supabase_admin";
grant DELETE on table "public"."finance_entries" to "anon";
grant INSERT on table "public"."finance_entries" to "anon";
grant MAINTAIN on table "public"."finance_entries" to "anon";
grant REFERENCES on table "public"."finance_entries" to "anon";
grant SELECT on table "public"."finance_entries" to "anon";
grant TRIGGER on table "public"."finance_entries" to "anon";
grant TRUNCATE on table "public"."finance_entries" to "anon";
grant UPDATE on table "public"."finance_entries" to "anon";
grant DELETE on table "public"."finance_entries" to "authenticated";
grant INSERT on table "public"."finance_entries" to "authenticated";
grant MAINTAIN on table "public"."finance_entries" to "authenticated";
grant REFERENCES on table "public"."finance_entries" to "authenticated";
grant SELECT on table "public"."finance_entries" to "authenticated";
grant TRIGGER on table "public"."finance_entries" to "authenticated";
grant TRUNCATE on table "public"."finance_entries" to "authenticated";
grant UPDATE on table "public"."finance_entries" to "authenticated";
grant DELETE on table "public"."finance_entries" to "postgres";
grant INSERT on table "public"."finance_entries" to "postgres";
grant MAINTAIN on table "public"."finance_entries" to "postgres";
grant REFERENCES on table "public"."finance_entries" to "postgres";
grant SELECT on table "public"."finance_entries" to "postgres";
grant TRIGGER on table "public"."finance_entries" to "postgres";
grant TRUNCATE on table "public"."finance_entries" to "postgres";
grant UPDATE on table "public"."finance_entries" to "postgres";
grant DELETE on table "public"."finance_entries" to "service_role";
grant INSERT on table "public"."finance_entries" to "service_role";
grant MAINTAIN on table "public"."finance_entries" to "service_role";
grant REFERENCES on table "public"."finance_entries" to "service_role";
grant SELECT on table "public"."finance_entries" to "service_role";
grant TRIGGER on table "public"."finance_entries" to "service_role";
grant TRUNCATE on table "public"."finance_entries" to "service_role";
grant UPDATE on table "public"."finance_entries" to "service_role";
revoke all on table "public"."hospitals" from public,"anon","authenticated","postgres","service_role","supabase_admin";
grant DELETE on table "public"."hospitals" to "anon";
grant INSERT on table "public"."hospitals" to "anon";
grant MAINTAIN on table "public"."hospitals" to "anon";
grant REFERENCES on table "public"."hospitals" to "anon";
grant SELECT on table "public"."hospitals" to "anon";
grant TRIGGER on table "public"."hospitals" to "anon";
grant TRUNCATE on table "public"."hospitals" to "anon";
grant UPDATE on table "public"."hospitals" to "anon";
grant DELETE on table "public"."hospitals" to "authenticated";
grant INSERT on table "public"."hospitals" to "authenticated";
grant MAINTAIN on table "public"."hospitals" to "authenticated";
grant REFERENCES on table "public"."hospitals" to "authenticated";
grant SELECT on table "public"."hospitals" to "authenticated";
grant TRIGGER on table "public"."hospitals" to "authenticated";
grant TRUNCATE on table "public"."hospitals" to "authenticated";
grant UPDATE on table "public"."hospitals" to "authenticated";
grant DELETE on table "public"."hospitals" to "postgres";
grant INSERT on table "public"."hospitals" to "postgres";
grant MAINTAIN on table "public"."hospitals" to "postgres";
grant REFERENCES on table "public"."hospitals" to "postgres";
grant SELECT on table "public"."hospitals" to "postgres";
grant TRIGGER on table "public"."hospitals" to "postgres";
grant TRUNCATE on table "public"."hospitals" to "postgres";
grant UPDATE on table "public"."hospitals" to "postgres";
grant DELETE on table "public"."hospitals" to "service_role";
grant INSERT on table "public"."hospitals" to "service_role";
grant MAINTAIN on table "public"."hospitals" to "service_role";
grant REFERENCES on table "public"."hospitals" to "service_role";
grant SELECT on table "public"."hospitals" to "service_role";
grant TRIGGER on table "public"."hospitals" to "service_role";
grant TRUNCATE on table "public"."hospitals" to "service_role";
grant UPDATE on table "public"."hospitals" to "service_role";
revoke all on table "public"."medicamentos" from public,"anon","authenticated","postgres","service_role","supabase_admin";
grant DELETE on table "public"."medicamentos" to "anon";
grant INSERT on table "public"."medicamentos" to "anon";
grant MAINTAIN on table "public"."medicamentos" to "anon";
grant REFERENCES on table "public"."medicamentos" to "anon";
grant SELECT on table "public"."medicamentos" to "anon";
grant TRIGGER on table "public"."medicamentos" to "anon";
grant TRUNCATE on table "public"."medicamentos" to "anon";
grant UPDATE on table "public"."medicamentos" to "anon";
grant DELETE on table "public"."medicamentos" to "authenticated";
grant INSERT on table "public"."medicamentos" to "authenticated";
grant MAINTAIN on table "public"."medicamentos" to "authenticated";
grant REFERENCES on table "public"."medicamentos" to "authenticated";
grant SELECT on table "public"."medicamentos" to "authenticated";
grant TRIGGER on table "public"."medicamentos" to "authenticated";
grant TRUNCATE on table "public"."medicamentos" to "authenticated";
grant UPDATE on table "public"."medicamentos" to "authenticated";
grant DELETE on table "public"."medicamentos" to "postgres";
grant INSERT on table "public"."medicamentos" to "postgres";
grant MAINTAIN on table "public"."medicamentos" to "postgres";
grant REFERENCES on table "public"."medicamentos" to "postgres";
grant SELECT on table "public"."medicamentos" to "postgres";
grant TRIGGER on table "public"."medicamentos" to "postgres";
grant TRUNCATE on table "public"."medicamentos" to "postgres";
grant UPDATE on table "public"."medicamentos" to "postgres";
grant DELETE on table "public"."medicamentos" to "service_role";
grant INSERT on table "public"."medicamentos" to "service_role";
grant MAINTAIN on table "public"."medicamentos" to "service_role";
grant REFERENCES on table "public"."medicamentos" to "service_role";
grant SELECT on table "public"."medicamentos" to "service_role";
grant TRIGGER on table "public"."medicamentos" to "service_role";
grant TRUNCATE on table "public"."medicamentos" to "service_role";
grant UPDATE on table "public"."medicamentos" to "service_role";
revoke all on table "public"."medicamentos_base_versao" from public,"anon","authenticated","postgres","service_role","supabase_admin";
grant DELETE on table "public"."medicamentos_base_versao" to "anon";
grant INSERT on table "public"."medicamentos_base_versao" to "anon";
grant MAINTAIN on table "public"."medicamentos_base_versao" to "anon";
grant REFERENCES on table "public"."medicamentos_base_versao" to "anon";
grant SELECT on table "public"."medicamentos_base_versao" to "anon";
grant TRIGGER on table "public"."medicamentos_base_versao" to "anon";
grant TRUNCATE on table "public"."medicamentos_base_versao" to "anon";
grant UPDATE on table "public"."medicamentos_base_versao" to "anon";
grant DELETE on table "public"."medicamentos_base_versao" to "authenticated";
grant INSERT on table "public"."medicamentos_base_versao" to "authenticated";
grant MAINTAIN on table "public"."medicamentos_base_versao" to "authenticated";
grant REFERENCES on table "public"."medicamentos_base_versao" to "authenticated";
grant SELECT on table "public"."medicamentos_base_versao" to "authenticated";
grant TRIGGER on table "public"."medicamentos_base_versao" to "authenticated";
grant TRUNCATE on table "public"."medicamentos_base_versao" to "authenticated";
grant UPDATE on table "public"."medicamentos_base_versao" to "authenticated";
grant DELETE on table "public"."medicamentos_base_versao" to "postgres";
grant INSERT on table "public"."medicamentos_base_versao" to "postgres";
grant MAINTAIN on table "public"."medicamentos_base_versao" to "postgres";
grant REFERENCES on table "public"."medicamentos_base_versao" to "postgres";
grant SELECT on table "public"."medicamentos_base_versao" to "postgres";
grant TRIGGER on table "public"."medicamentos_base_versao" to "postgres";
grant TRUNCATE on table "public"."medicamentos_base_versao" to "postgres";
grant UPDATE on table "public"."medicamentos_base_versao" to "postgres";
grant DELETE on table "public"."medicamentos_base_versao" to "service_role";
grant INSERT on table "public"."medicamentos_base_versao" to "service_role";
grant MAINTAIN on table "public"."medicamentos_base_versao" to "service_role";
grant REFERENCES on table "public"."medicamentos_base_versao" to "service_role";
grant SELECT on table "public"."medicamentos_base_versao" to "service_role";
grant TRIGGER on table "public"."medicamentos_base_versao" to "service_role";
grant TRUNCATE on table "public"."medicamentos_base_versao" to "service_role";
grant UPDATE on table "public"."medicamentos_base_versao" to "service_role";
revoke all on table "public"."medicamentos_clinicos" from public,"anon","authenticated","postgres","service_role","supabase_admin";
grant DELETE on table "public"."medicamentos_clinicos" to "anon";
grant INSERT on table "public"."medicamentos_clinicos" to "anon";
grant MAINTAIN on table "public"."medicamentos_clinicos" to "anon";
grant REFERENCES on table "public"."medicamentos_clinicos" to "anon";
grant SELECT on table "public"."medicamentos_clinicos" to "anon";
grant TRIGGER on table "public"."medicamentos_clinicos" to "anon";
grant TRUNCATE on table "public"."medicamentos_clinicos" to "anon";
grant UPDATE on table "public"."medicamentos_clinicos" to "anon";
grant DELETE on table "public"."medicamentos_clinicos" to "authenticated";
grant INSERT on table "public"."medicamentos_clinicos" to "authenticated";
grant MAINTAIN on table "public"."medicamentos_clinicos" to "authenticated";
grant REFERENCES on table "public"."medicamentos_clinicos" to "authenticated";
grant SELECT on table "public"."medicamentos_clinicos" to "authenticated";
grant TRIGGER on table "public"."medicamentos_clinicos" to "authenticated";
grant TRUNCATE on table "public"."medicamentos_clinicos" to "authenticated";
grant UPDATE on table "public"."medicamentos_clinicos" to "authenticated";
grant DELETE on table "public"."medicamentos_clinicos" to "postgres";
grant INSERT on table "public"."medicamentos_clinicos" to "postgres";
grant MAINTAIN on table "public"."medicamentos_clinicos" to "postgres";
grant REFERENCES on table "public"."medicamentos_clinicos" to "postgres";
grant SELECT on table "public"."medicamentos_clinicos" to "postgres";
grant TRIGGER on table "public"."medicamentos_clinicos" to "postgres";
grant TRUNCATE on table "public"."medicamentos_clinicos" to "postgres";
grant UPDATE on table "public"."medicamentos_clinicos" to "postgres";
grant DELETE on table "public"."medicamentos_clinicos" to "service_role";
grant INSERT on table "public"."medicamentos_clinicos" to "service_role";
grant MAINTAIN on table "public"."medicamentos_clinicos" to "service_role";
grant REFERENCES on table "public"."medicamentos_clinicos" to "service_role";
grant SELECT on table "public"."medicamentos_clinicos" to "service_role";
grant TRIGGER on table "public"."medicamentos_clinicos" to "service_role";
grant TRUNCATE on table "public"."medicamentos_clinicos" to "service_role";
grant UPDATE on table "public"."medicamentos_clinicos" to "service_role";
revoke all on table "public"."medicamentos_regras_anestesicas" from public,"anon","authenticated","postgres","service_role","supabase_admin";
grant DELETE on table "public"."medicamentos_regras_anestesicas" to "anon";
grant INSERT on table "public"."medicamentos_regras_anestesicas" to "anon";
grant MAINTAIN on table "public"."medicamentos_regras_anestesicas" to "anon";
grant REFERENCES on table "public"."medicamentos_regras_anestesicas" to "anon";
grant SELECT on table "public"."medicamentos_regras_anestesicas" to "anon";
grant TRIGGER on table "public"."medicamentos_regras_anestesicas" to "anon";
grant TRUNCATE on table "public"."medicamentos_regras_anestesicas" to "anon";
grant UPDATE on table "public"."medicamentos_regras_anestesicas" to "anon";
grant DELETE on table "public"."medicamentos_regras_anestesicas" to "authenticated";
grant INSERT on table "public"."medicamentos_regras_anestesicas" to "authenticated";
grant MAINTAIN on table "public"."medicamentos_regras_anestesicas" to "authenticated";
grant REFERENCES on table "public"."medicamentos_regras_anestesicas" to "authenticated";
grant SELECT on table "public"."medicamentos_regras_anestesicas" to "authenticated";
grant TRIGGER on table "public"."medicamentos_regras_anestesicas" to "authenticated";
grant TRUNCATE on table "public"."medicamentos_regras_anestesicas" to "authenticated";
grant UPDATE on table "public"."medicamentos_regras_anestesicas" to "authenticated";
grant DELETE on table "public"."medicamentos_regras_anestesicas" to "postgres";
grant INSERT on table "public"."medicamentos_regras_anestesicas" to "postgres";
grant MAINTAIN on table "public"."medicamentos_regras_anestesicas" to "postgres";
grant REFERENCES on table "public"."medicamentos_regras_anestesicas" to "postgres";
grant SELECT on table "public"."medicamentos_regras_anestesicas" to "postgres";
grant TRIGGER on table "public"."medicamentos_regras_anestesicas" to "postgres";
grant TRUNCATE on table "public"."medicamentos_regras_anestesicas" to "postgres";
grant UPDATE on table "public"."medicamentos_regras_anestesicas" to "postgres";
grant DELETE on table "public"."medicamentos_regras_anestesicas" to "service_role";
grant INSERT on table "public"."medicamentos_regras_anestesicas" to "service_role";
grant MAINTAIN on table "public"."medicamentos_regras_anestesicas" to "service_role";
grant REFERENCES on table "public"."medicamentos_regras_anestesicas" to "service_role";
grant SELECT on table "public"."medicamentos_regras_anestesicas" to "service_role";
grant TRIGGER on table "public"."medicamentos_regras_anestesicas" to "service_role";
grant TRUNCATE on table "public"."medicamentos_regras_anestesicas" to "service_role";
grant UPDATE on table "public"."medicamentos_regras_anestesicas" to "service_role";
revoke all on table "public"."org_configs" from public,"anon","authenticated","postgres","service_role","supabase_admin";
grant DELETE on table "public"."org_configs" to "anon";
grant INSERT on table "public"."org_configs" to "anon";
grant MAINTAIN on table "public"."org_configs" to "anon";
grant REFERENCES on table "public"."org_configs" to "anon";
grant SELECT on table "public"."org_configs" to "anon";
grant TRIGGER on table "public"."org_configs" to "anon";
grant TRUNCATE on table "public"."org_configs" to "anon";
grant UPDATE on table "public"."org_configs" to "anon";
grant DELETE on table "public"."org_configs" to "authenticated";
grant INSERT on table "public"."org_configs" to "authenticated";
grant MAINTAIN on table "public"."org_configs" to "authenticated";
grant REFERENCES on table "public"."org_configs" to "authenticated";
grant SELECT on table "public"."org_configs" to "authenticated";
grant TRIGGER on table "public"."org_configs" to "authenticated";
grant TRUNCATE on table "public"."org_configs" to "authenticated";
grant UPDATE on table "public"."org_configs" to "authenticated";
grant DELETE on table "public"."org_configs" to "postgres";
grant INSERT on table "public"."org_configs" to "postgres";
grant MAINTAIN on table "public"."org_configs" to "postgres";
grant REFERENCES on table "public"."org_configs" to "postgres";
grant SELECT on table "public"."org_configs" to "postgres";
grant TRIGGER on table "public"."org_configs" to "postgres";
grant TRUNCATE on table "public"."org_configs" to "postgres";
grant UPDATE on table "public"."org_configs" to "postgres";
grant DELETE on table "public"."org_configs" to "service_role";
grant INSERT on table "public"."org_configs" to "service_role";
grant MAINTAIN on table "public"."org_configs" to "service_role";
grant REFERENCES on table "public"."org_configs" to "service_role";
grant SELECT on table "public"."org_configs" to "service_role";
grant TRIGGER on table "public"."org_configs" to "service_role";
grant TRUNCATE on table "public"."org_configs" to "service_role";
grant UPDATE on table "public"."org_configs" to "service_role";
revoke all on table "public"."org_shares" from public,"anon","authenticated","postgres","service_role","supabase_admin";
grant DELETE on table "public"."org_shares" to "anon";
grant INSERT on table "public"."org_shares" to "anon";
grant MAINTAIN on table "public"."org_shares" to "anon";
grant REFERENCES on table "public"."org_shares" to "anon";
grant SELECT on table "public"."org_shares" to "anon";
grant TRIGGER on table "public"."org_shares" to "anon";
grant TRUNCATE on table "public"."org_shares" to "anon";
grant UPDATE on table "public"."org_shares" to "anon";
grant DELETE on table "public"."org_shares" to "authenticated";
grant INSERT on table "public"."org_shares" to "authenticated";
grant MAINTAIN on table "public"."org_shares" to "authenticated";
grant REFERENCES on table "public"."org_shares" to "authenticated";
grant SELECT on table "public"."org_shares" to "authenticated";
grant TRIGGER on table "public"."org_shares" to "authenticated";
grant TRUNCATE on table "public"."org_shares" to "authenticated";
grant UPDATE on table "public"."org_shares" to "authenticated";
grant DELETE on table "public"."org_shares" to "postgres";
grant INSERT on table "public"."org_shares" to "postgres";
grant MAINTAIN on table "public"."org_shares" to "postgres";
grant REFERENCES on table "public"."org_shares" to "postgres";
grant SELECT on table "public"."org_shares" to "postgres";
grant TRIGGER on table "public"."org_shares" to "postgres";
grant TRUNCATE on table "public"."org_shares" to "postgres";
grant UPDATE on table "public"."org_shares" to "postgres";
grant DELETE on table "public"."org_shares" to "service_role";
grant INSERT on table "public"."org_shares" to "service_role";
grant MAINTAIN on table "public"."org_shares" to "service_role";
grant REFERENCES on table "public"."org_shares" to "service_role";
grant SELECT on table "public"."org_shares" to "service_role";
grant TRIGGER on table "public"."org_shares" to "service_role";
grant TRUNCATE on table "public"."org_shares" to "service_role";
grant UPDATE on table "public"."org_shares" to "service_role";
revoke all on table "public"."organization_users" from public,"anon","authenticated","postgres","service_role","supabase_admin";
grant DELETE on table "public"."organization_users" to "anon";
grant INSERT on table "public"."organization_users" to "anon";
grant MAINTAIN on table "public"."organization_users" to "anon";
grant REFERENCES on table "public"."organization_users" to "anon";
grant SELECT on table "public"."organization_users" to "anon";
grant TRIGGER on table "public"."organization_users" to "anon";
grant TRUNCATE on table "public"."organization_users" to "anon";
grant UPDATE on table "public"."organization_users" to "anon";
grant DELETE on table "public"."organization_users" to "authenticated";
grant INSERT on table "public"."organization_users" to "authenticated";
grant MAINTAIN on table "public"."organization_users" to "authenticated";
grant REFERENCES on table "public"."organization_users" to "authenticated";
grant SELECT on table "public"."organization_users" to "authenticated";
grant TRIGGER on table "public"."organization_users" to "authenticated";
grant TRUNCATE on table "public"."organization_users" to "authenticated";
grant UPDATE on table "public"."organization_users" to "authenticated";
grant DELETE on table "public"."organization_users" to "postgres";
grant INSERT on table "public"."organization_users" to "postgres";
grant MAINTAIN on table "public"."organization_users" to "postgres";
grant REFERENCES on table "public"."organization_users" to "postgres";
grant SELECT on table "public"."organization_users" to "postgres";
grant TRIGGER on table "public"."organization_users" to "postgres";
grant TRUNCATE on table "public"."organization_users" to "postgres";
grant UPDATE on table "public"."organization_users" to "postgres";
grant DELETE on table "public"."organization_users" to "service_role";
grant INSERT on table "public"."organization_users" to "service_role";
grant MAINTAIN on table "public"."organization_users" to "service_role";
grant REFERENCES on table "public"."organization_users" to "service_role";
grant SELECT on table "public"."organization_users" to "service_role";
grant TRIGGER on table "public"."organization_users" to "service_role";
grant TRUNCATE on table "public"."organization_users" to "service_role";
grant UPDATE on table "public"."organization_users" to "service_role";
revoke all on table "public"."organizations" from public,"anon","authenticated","postgres","service_role","supabase_admin";
grant DELETE on table "public"."organizations" to "anon";
grant INSERT on table "public"."organizations" to "anon";
grant MAINTAIN on table "public"."organizations" to "anon";
grant REFERENCES on table "public"."organizations" to "anon";
grant SELECT on table "public"."organizations" to "anon";
grant TRIGGER on table "public"."organizations" to "anon";
grant TRUNCATE on table "public"."organizations" to "anon";
grant UPDATE on table "public"."organizations" to "anon";
grant DELETE on table "public"."organizations" to "authenticated";
grant INSERT on table "public"."organizations" to "authenticated";
grant MAINTAIN on table "public"."organizations" to "authenticated";
grant REFERENCES on table "public"."organizations" to "authenticated";
grant SELECT on table "public"."organizations" to "authenticated";
grant TRIGGER on table "public"."organizations" to "authenticated";
grant TRUNCATE on table "public"."organizations" to "authenticated";
grant UPDATE on table "public"."organizations" to "authenticated";
grant DELETE on table "public"."organizations" to "postgres";
grant INSERT on table "public"."organizations" to "postgres";
grant MAINTAIN on table "public"."organizations" to "postgres";
grant REFERENCES on table "public"."organizations" to "postgres";
grant SELECT on table "public"."organizations" to "postgres";
grant TRIGGER on table "public"."organizations" to "postgres";
grant TRUNCATE on table "public"."organizations" to "postgres";
grant UPDATE on table "public"."organizations" to "postgres";
grant DELETE on table "public"."organizations" to "service_role";
grant INSERT on table "public"."organizations" to "service_role";
grant MAINTAIN on table "public"."organizations" to "service_role";
grant REFERENCES on table "public"."organizations" to "service_role";
grant SELECT on table "public"."organizations" to "service_role";
grant TRIGGER on table "public"."organizations" to "service_role";
grant TRUNCATE on table "public"."organizations" to "service_role";
grant UPDATE on table "public"."organizations" to "service_role";
revoke all on table "public"."pacientes" from public,"anon","authenticated","postgres","service_role","supabase_admin";
grant DELETE on table "public"."pacientes" to "anon";
grant INSERT on table "public"."pacientes" to "anon";
grant MAINTAIN on table "public"."pacientes" to "anon";
grant REFERENCES on table "public"."pacientes" to "anon";
grant SELECT on table "public"."pacientes" to "anon";
grant TRIGGER on table "public"."pacientes" to "anon";
grant TRUNCATE on table "public"."pacientes" to "anon";
grant UPDATE on table "public"."pacientes" to "anon";
grant DELETE on table "public"."pacientes" to "authenticated";
grant INSERT on table "public"."pacientes" to "authenticated";
grant MAINTAIN on table "public"."pacientes" to "authenticated";
grant REFERENCES on table "public"."pacientes" to "authenticated";
grant SELECT on table "public"."pacientes" to "authenticated";
grant TRIGGER on table "public"."pacientes" to "authenticated";
grant TRUNCATE on table "public"."pacientes" to "authenticated";
grant UPDATE on table "public"."pacientes" to "authenticated";
grant DELETE on table "public"."pacientes" to "postgres";
grant INSERT on table "public"."pacientes" to "postgres";
grant MAINTAIN on table "public"."pacientes" to "postgres";
grant REFERENCES on table "public"."pacientes" to "postgres";
grant SELECT on table "public"."pacientes" to "postgres";
grant TRIGGER on table "public"."pacientes" to "postgres";
grant TRUNCATE on table "public"."pacientes" to "postgres";
grant UPDATE on table "public"."pacientes" to "postgres";
grant DELETE on table "public"."pacientes" to "service_role";
grant INSERT on table "public"."pacientes" to "service_role";
grant MAINTAIN on table "public"."pacientes" to "service_role";
grant REFERENCES on table "public"."pacientes" to "service_role";
grant SELECT on table "public"."pacientes" to "service_role";
grant TRIGGER on table "public"."pacientes" to "service_role";
grant TRUNCATE on table "public"."pacientes" to "service_role";
grant UPDATE on table "public"."pacientes" to "service_role";
revoke all on table "public"."patients" from public,"anon","authenticated","postgres","service_role","supabase_admin";
grant DELETE on table "public"."patients" to "anon";
grant INSERT on table "public"."patients" to "anon";
grant MAINTAIN on table "public"."patients" to "anon";
grant REFERENCES on table "public"."patients" to "anon";
grant SELECT on table "public"."patients" to "anon";
grant TRIGGER on table "public"."patients" to "anon";
grant TRUNCATE on table "public"."patients" to "anon";
grant UPDATE on table "public"."patients" to "anon";
grant DELETE on table "public"."patients" to "authenticated";
grant INSERT on table "public"."patients" to "authenticated";
grant MAINTAIN on table "public"."patients" to "authenticated";
grant REFERENCES on table "public"."patients" to "authenticated";
grant SELECT on table "public"."patients" to "authenticated";
grant TRIGGER on table "public"."patients" to "authenticated";
grant TRUNCATE on table "public"."patients" to "authenticated";
grant UPDATE on table "public"."patients" to "authenticated";
grant DELETE on table "public"."patients" to "postgres";
grant INSERT on table "public"."patients" to "postgres";
grant MAINTAIN on table "public"."patients" to "postgres";
grant REFERENCES on table "public"."patients" to "postgres";
grant SELECT on table "public"."patients" to "postgres";
grant TRIGGER on table "public"."patients" to "postgres";
grant TRUNCATE on table "public"."patients" to "postgres";
grant UPDATE on table "public"."patients" to "postgres";
grant DELETE on table "public"."patients" to "service_role";
grant INSERT on table "public"."patients" to "service_role";
grant MAINTAIN on table "public"."patients" to "service_role";
grant REFERENCES on table "public"."patients" to "service_role";
grant SELECT on table "public"."patients" to "service_role";
grant TRIGGER on table "public"."patients" to "service_role";
grant TRUNCATE on table "public"."patients" to "service_role";
grant UPDATE on table "public"."patients" to "service_role";
revoke all on table "public"."preanesthetic_assessments" from public,"anon","authenticated","postgres","service_role","supabase_admin";
grant DELETE on table "public"."preanesthetic_assessments" to "anon";
grant INSERT on table "public"."preanesthetic_assessments" to "anon";
grant MAINTAIN on table "public"."preanesthetic_assessments" to "anon";
grant REFERENCES on table "public"."preanesthetic_assessments" to "anon";
grant SELECT on table "public"."preanesthetic_assessments" to "anon";
grant TRIGGER on table "public"."preanesthetic_assessments" to "anon";
grant TRUNCATE on table "public"."preanesthetic_assessments" to "anon";
grant UPDATE on table "public"."preanesthetic_assessments" to "anon";
grant DELETE on table "public"."preanesthetic_assessments" to "authenticated";
grant INSERT on table "public"."preanesthetic_assessments" to "authenticated";
grant MAINTAIN on table "public"."preanesthetic_assessments" to "authenticated";
grant REFERENCES on table "public"."preanesthetic_assessments" to "authenticated";
grant SELECT on table "public"."preanesthetic_assessments" to "authenticated";
grant TRIGGER on table "public"."preanesthetic_assessments" to "authenticated";
grant TRUNCATE on table "public"."preanesthetic_assessments" to "authenticated";
grant UPDATE on table "public"."preanesthetic_assessments" to "authenticated";
grant DELETE on table "public"."preanesthetic_assessments" to "postgres";
grant INSERT on table "public"."preanesthetic_assessments" to "postgres";
grant MAINTAIN on table "public"."preanesthetic_assessments" to "postgres";
grant REFERENCES on table "public"."preanesthetic_assessments" to "postgres";
grant SELECT on table "public"."preanesthetic_assessments" to "postgres";
grant TRIGGER on table "public"."preanesthetic_assessments" to "postgres";
grant TRUNCATE on table "public"."preanesthetic_assessments" to "postgres";
grant UPDATE on table "public"."preanesthetic_assessments" to "postgres";
grant DELETE on table "public"."preanesthetic_assessments" to "service_role";
grant INSERT on table "public"."preanesthetic_assessments" to "service_role";
grant MAINTAIN on table "public"."preanesthetic_assessments" to "service_role";
grant REFERENCES on table "public"."preanesthetic_assessments" to "service_role";
grant SELECT on table "public"."preanesthetic_assessments" to "service_role";
grant TRIGGER on table "public"."preanesthetic_assessments" to "service_role";
grant TRUNCATE on table "public"."preanesthetic_assessments" to "service_role";
grant UPDATE on table "public"."preanesthetic_assessments" to "service_role";
revoke all on table "public"."prescriptions" from public,"anon","authenticated","postgres","service_role","supabase_admin";
grant DELETE on table "public"."prescriptions" to "anon";
grant INSERT on table "public"."prescriptions" to "anon";
grant MAINTAIN on table "public"."prescriptions" to "anon";
grant REFERENCES on table "public"."prescriptions" to "anon";
grant SELECT on table "public"."prescriptions" to "anon";
grant TRIGGER on table "public"."prescriptions" to "anon";
grant TRUNCATE on table "public"."prescriptions" to "anon";
grant UPDATE on table "public"."prescriptions" to "anon";
grant DELETE on table "public"."prescriptions" to "authenticated";
grant INSERT on table "public"."prescriptions" to "authenticated";
grant MAINTAIN on table "public"."prescriptions" to "authenticated";
grant REFERENCES on table "public"."prescriptions" to "authenticated";
grant SELECT on table "public"."prescriptions" to "authenticated";
grant TRIGGER on table "public"."prescriptions" to "authenticated";
grant TRUNCATE on table "public"."prescriptions" to "authenticated";
grant UPDATE on table "public"."prescriptions" to "authenticated";
grant DELETE on table "public"."prescriptions" to "postgres";
grant INSERT on table "public"."prescriptions" to "postgres";
grant MAINTAIN on table "public"."prescriptions" to "postgres";
grant REFERENCES on table "public"."prescriptions" to "postgres";
grant SELECT on table "public"."prescriptions" to "postgres";
grant TRIGGER on table "public"."prescriptions" to "postgres";
grant TRUNCATE on table "public"."prescriptions" to "postgres";
grant UPDATE on table "public"."prescriptions" to "postgres";
grant DELETE on table "public"."prescriptions" to "service_role";
grant INSERT on table "public"."prescriptions" to "service_role";
grant MAINTAIN on table "public"."prescriptions" to "service_role";
grant REFERENCES on table "public"."prescriptions" to "service_role";
grant SELECT on table "public"."prescriptions" to "service_role";
grant TRIGGER on table "public"."prescriptions" to "service_role";
grant TRUNCATE on table "public"."prescriptions" to "service_role";
grant UPDATE on table "public"."prescriptions" to "service_role";
revoke all on table "public"."profiles" from public,"anon","authenticated","postgres","service_role","supabase_admin";
grant DELETE on table "public"."profiles" to "anon";
grant INSERT on table "public"."profiles" to "anon";
grant MAINTAIN on table "public"."profiles" to "anon";
grant REFERENCES on table "public"."profiles" to "anon";
grant SELECT on table "public"."profiles" to "anon";
grant TRIGGER on table "public"."profiles" to "anon";
grant TRUNCATE on table "public"."profiles" to "anon";
grant UPDATE on table "public"."profiles" to "anon";
grant DELETE on table "public"."profiles" to "authenticated";
grant INSERT on table "public"."profiles" to "authenticated";
grant MAINTAIN on table "public"."profiles" to "authenticated";
grant REFERENCES on table "public"."profiles" to "authenticated";
grant SELECT on table "public"."profiles" to "authenticated";
grant TRIGGER on table "public"."profiles" to "authenticated";
grant TRUNCATE on table "public"."profiles" to "authenticated";
grant UPDATE on table "public"."profiles" to "authenticated";
grant DELETE on table "public"."profiles" to "postgres";
grant INSERT on table "public"."profiles" to "postgres";
grant MAINTAIN on table "public"."profiles" to "postgres";
grant REFERENCES on table "public"."profiles" to "postgres";
grant SELECT on table "public"."profiles" to "postgres";
grant TRIGGER on table "public"."profiles" to "postgres";
grant TRUNCATE on table "public"."profiles" to "postgres";
grant UPDATE on table "public"."profiles" to "postgres";
grant DELETE on table "public"."profiles" to "service_role";
grant INSERT on table "public"."profiles" to "service_role";
grant MAINTAIN on table "public"."profiles" to "service_role";
grant REFERENCES on table "public"."profiles" to "service_role";
grant SELECT on table "public"."profiles" to "service_role";
grant TRIGGER on table "public"."profiles" to "service_role";
grant TRUNCATE on table "public"."profiles" to "service_role";
grant UPDATE on table "public"."profiles" to "service_role";
revoke all on table "public"."quotes" from public,"anon","authenticated","postgres","service_role","supabase_admin";
grant DELETE on table "public"."quotes" to "anon";
grant INSERT on table "public"."quotes" to "anon";
grant MAINTAIN on table "public"."quotes" to "anon";
grant REFERENCES on table "public"."quotes" to "anon";
grant SELECT on table "public"."quotes" to "anon";
grant TRIGGER on table "public"."quotes" to "anon";
grant TRUNCATE on table "public"."quotes" to "anon";
grant UPDATE on table "public"."quotes" to "anon";
grant DELETE on table "public"."quotes" to "authenticated";
grant INSERT on table "public"."quotes" to "authenticated";
grant MAINTAIN on table "public"."quotes" to "authenticated";
grant REFERENCES on table "public"."quotes" to "authenticated";
grant SELECT on table "public"."quotes" to "authenticated";
grant TRIGGER on table "public"."quotes" to "authenticated";
grant TRUNCATE on table "public"."quotes" to "authenticated";
grant UPDATE on table "public"."quotes" to "authenticated";
grant DELETE on table "public"."quotes" to "postgres";
grant INSERT on table "public"."quotes" to "postgres";
grant MAINTAIN on table "public"."quotes" to "postgres";
grant REFERENCES on table "public"."quotes" to "postgres";
grant SELECT on table "public"."quotes" to "postgres";
grant TRIGGER on table "public"."quotes" to "postgres";
grant TRUNCATE on table "public"."quotes" to "postgres";
grant UPDATE on table "public"."quotes" to "postgres";
grant DELETE on table "public"."quotes" to "service_role";
grant INSERT on table "public"."quotes" to "service_role";
grant MAINTAIN on table "public"."quotes" to "service_role";
grant REFERENCES on table "public"."quotes" to "service_role";
grant SELECT on table "public"."quotes" to "service_role";
grant TRIGGER on table "public"."quotes" to "service_role";
grant TRUNCATE on table "public"."quotes" to "service_role";
grant UPDATE on table "public"."quotes" to "service_role";
revoke all on table "public"."recovery_records" from public,"anon","authenticated","postgres","service_role","supabase_admin";
grant DELETE on table "public"."recovery_records" to "anon";
grant INSERT on table "public"."recovery_records" to "anon";
grant MAINTAIN on table "public"."recovery_records" to "anon";
grant REFERENCES on table "public"."recovery_records" to "anon";
grant SELECT on table "public"."recovery_records" to "anon";
grant TRIGGER on table "public"."recovery_records" to "anon";
grant TRUNCATE on table "public"."recovery_records" to "anon";
grant UPDATE on table "public"."recovery_records" to "anon";
grant DELETE on table "public"."recovery_records" to "authenticated";
grant INSERT on table "public"."recovery_records" to "authenticated";
grant MAINTAIN on table "public"."recovery_records" to "authenticated";
grant REFERENCES on table "public"."recovery_records" to "authenticated";
grant SELECT on table "public"."recovery_records" to "authenticated";
grant TRIGGER on table "public"."recovery_records" to "authenticated";
grant TRUNCATE on table "public"."recovery_records" to "authenticated";
grant UPDATE on table "public"."recovery_records" to "authenticated";
grant DELETE on table "public"."recovery_records" to "postgres";
grant INSERT on table "public"."recovery_records" to "postgres";
grant MAINTAIN on table "public"."recovery_records" to "postgres";
grant REFERENCES on table "public"."recovery_records" to "postgres";
grant SELECT on table "public"."recovery_records" to "postgres";
grant TRIGGER on table "public"."recovery_records" to "postgres";
grant TRUNCATE on table "public"."recovery_records" to "postgres";
grant UPDATE on table "public"."recovery_records" to "postgres";
grant DELETE on table "public"."recovery_records" to "service_role";
grant INSERT on table "public"."recovery_records" to "service_role";
grant MAINTAIN on table "public"."recovery_records" to "service_role";
grant REFERENCES on table "public"."recovery_records" to "service_role";
grant SELECT on table "public"."recovery_records" to "service_role";
grant TRIGGER on table "public"."recovery_records" to "service_role";
grant TRUNCATE on table "public"."recovery_records" to "service_role";
grant UPDATE on table "public"."recovery_records" to "service_role";
revoke all on table "public"."risk_assessments" from public,"anon","authenticated","postgres","service_role","supabase_admin";
grant DELETE on table "public"."risk_assessments" to "anon";
grant INSERT on table "public"."risk_assessments" to "anon";
grant MAINTAIN on table "public"."risk_assessments" to "anon";
grant REFERENCES on table "public"."risk_assessments" to "anon";
grant SELECT on table "public"."risk_assessments" to "anon";
grant TRIGGER on table "public"."risk_assessments" to "anon";
grant TRUNCATE on table "public"."risk_assessments" to "anon";
grant UPDATE on table "public"."risk_assessments" to "anon";
grant DELETE on table "public"."risk_assessments" to "authenticated";
grant INSERT on table "public"."risk_assessments" to "authenticated";
grant MAINTAIN on table "public"."risk_assessments" to "authenticated";
grant REFERENCES on table "public"."risk_assessments" to "authenticated";
grant SELECT on table "public"."risk_assessments" to "authenticated";
grant TRIGGER on table "public"."risk_assessments" to "authenticated";
grant TRUNCATE on table "public"."risk_assessments" to "authenticated";
grant UPDATE on table "public"."risk_assessments" to "authenticated";
grant DELETE on table "public"."risk_assessments" to "postgres";
grant INSERT on table "public"."risk_assessments" to "postgres";
grant MAINTAIN on table "public"."risk_assessments" to "postgres";
grant REFERENCES on table "public"."risk_assessments" to "postgres";
grant SELECT on table "public"."risk_assessments" to "postgres";
grant TRIGGER on table "public"."risk_assessments" to "postgres";
grant TRUNCATE on table "public"."risk_assessments" to "postgres";
grant UPDATE on table "public"."risk_assessments" to "postgres";
grant DELETE on table "public"."risk_assessments" to "service_role";
grant INSERT on table "public"."risk_assessments" to "service_role";
grant MAINTAIN on table "public"."risk_assessments" to "service_role";
grant REFERENCES on table "public"."risk_assessments" to "service_role";
grant SELECT on table "public"."risk_assessments" to "service_role";
grant TRIGGER on table "public"."risk_assessments" to "service_role";
grant TRUNCATE on table "public"."risk_assessments" to "service_role";
grant UPDATE on table "public"."risk_assessments" to "service_role";
revoke all on table "public"."rooms" from public,"anon","authenticated","postgres","service_role","supabase_admin";
grant DELETE on table "public"."rooms" to "anon";
grant INSERT on table "public"."rooms" to "anon";
grant MAINTAIN on table "public"."rooms" to "anon";
grant REFERENCES on table "public"."rooms" to "anon";
grant SELECT on table "public"."rooms" to "anon";
grant TRIGGER on table "public"."rooms" to "anon";
grant TRUNCATE on table "public"."rooms" to "anon";
grant UPDATE on table "public"."rooms" to "anon";
grant DELETE on table "public"."rooms" to "authenticated";
grant INSERT on table "public"."rooms" to "authenticated";
grant MAINTAIN on table "public"."rooms" to "authenticated";
grant REFERENCES on table "public"."rooms" to "authenticated";
grant SELECT on table "public"."rooms" to "authenticated";
grant TRIGGER on table "public"."rooms" to "authenticated";
grant TRUNCATE on table "public"."rooms" to "authenticated";
grant UPDATE on table "public"."rooms" to "authenticated";
grant DELETE on table "public"."rooms" to "postgres";
grant INSERT on table "public"."rooms" to "postgres";
grant MAINTAIN on table "public"."rooms" to "postgres";
grant REFERENCES on table "public"."rooms" to "postgres";
grant SELECT on table "public"."rooms" to "postgres";
grant TRIGGER on table "public"."rooms" to "postgres";
grant TRUNCATE on table "public"."rooms" to "postgres";
grant UPDATE on table "public"."rooms" to "postgres";
grant DELETE on table "public"."rooms" to "service_role";
grant INSERT on table "public"."rooms" to "service_role";
grant MAINTAIN on table "public"."rooms" to "service_role";
grant REFERENCES on table "public"."rooms" to "service_role";
grant SELECT on table "public"."rooms" to "service_role";
grant TRIGGER on table "public"."rooms" to "service_role";
grant TRUNCATE on table "public"."rooms" to "service_role";
grant UPDATE on table "public"."rooms" to "service_role";
revoke all on table "public"."standard_texts" from public,"anon","authenticated","postgres","service_role","supabase_admin";
grant DELETE on table "public"."standard_texts" to "anon";
grant INSERT on table "public"."standard_texts" to "anon";
grant MAINTAIN on table "public"."standard_texts" to "anon";
grant REFERENCES on table "public"."standard_texts" to "anon";
grant SELECT on table "public"."standard_texts" to "anon";
grant TRIGGER on table "public"."standard_texts" to "anon";
grant TRUNCATE on table "public"."standard_texts" to "anon";
grant UPDATE on table "public"."standard_texts" to "anon";
grant DELETE on table "public"."standard_texts" to "authenticated";
grant INSERT on table "public"."standard_texts" to "authenticated";
grant MAINTAIN on table "public"."standard_texts" to "authenticated";
grant REFERENCES on table "public"."standard_texts" to "authenticated";
grant SELECT on table "public"."standard_texts" to "authenticated";
grant TRIGGER on table "public"."standard_texts" to "authenticated";
grant TRUNCATE on table "public"."standard_texts" to "authenticated";
grant UPDATE on table "public"."standard_texts" to "authenticated";
grant DELETE on table "public"."standard_texts" to "postgres";
grant INSERT on table "public"."standard_texts" to "postgres";
grant MAINTAIN on table "public"."standard_texts" to "postgres";
grant REFERENCES on table "public"."standard_texts" to "postgres";
grant SELECT on table "public"."standard_texts" to "postgres";
grant TRIGGER on table "public"."standard_texts" to "postgres";
grant TRUNCATE on table "public"."standard_texts" to "postgres";
grant UPDATE on table "public"."standard_texts" to "postgres";
grant DELETE on table "public"."standard_texts" to "service_role";
grant INSERT on table "public"."standard_texts" to "service_role";
grant MAINTAIN on table "public"."standard_texts" to "service_role";
grant REFERENCES on table "public"."standard_texts" to "service_role";
grant SELECT on table "public"."standard_texts" to "service_role";
grant TRIGGER on table "public"."standard_texts" to "service_role";
grant TRUNCATE on table "public"."standard_texts" to "service_role";
grant UPDATE on table "public"."standard_texts" to "service_role";
revoke all on table "public"."templates" from public,"anon","authenticated","postgres","service_role","supabase_admin";
grant DELETE on table "public"."templates" to "anon";
grant INSERT on table "public"."templates" to "anon";
grant MAINTAIN on table "public"."templates" to "anon";
grant REFERENCES on table "public"."templates" to "anon";
grant SELECT on table "public"."templates" to "anon";
grant TRIGGER on table "public"."templates" to "anon";
grant TRUNCATE on table "public"."templates" to "anon";
grant UPDATE on table "public"."templates" to "anon";
grant DELETE on table "public"."templates" to "authenticated";
grant INSERT on table "public"."templates" to "authenticated";
grant MAINTAIN on table "public"."templates" to "authenticated";
grant REFERENCES on table "public"."templates" to "authenticated";
grant SELECT on table "public"."templates" to "authenticated";
grant TRIGGER on table "public"."templates" to "authenticated";
grant TRUNCATE on table "public"."templates" to "authenticated";
grant UPDATE on table "public"."templates" to "authenticated";
grant DELETE on table "public"."templates" to "postgres";
grant INSERT on table "public"."templates" to "postgres";
grant MAINTAIN on table "public"."templates" to "postgres";
grant REFERENCES on table "public"."templates" to "postgres";
grant SELECT on table "public"."templates" to "postgres";
grant TRIGGER on table "public"."templates" to "postgres";
grant TRUNCATE on table "public"."templates" to "postgres";
grant UPDATE on table "public"."templates" to "postgres";
grant DELETE on table "public"."templates" to "service_role";
grant INSERT on table "public"."templates" to "service_role";
grant MAINTAIN on table "public"."templates" to "service_role";
grant REFERENCES on table "public"."templates" to "service_role";
grant SELECT on table "public"."templates" to "service_role";
grant TRIGGER on table "public"."templates" to "service_role";
grant TRUNCATE on table "public"."templates" to "service_role";
grant UPDATE on table "public"."templates" to "service_role";
revoke all on schema "app" from public,"postgres","anon","authenticated","service_role","supabase_admin";
grant CREATE on schema "app" to "postgres";
grant USAGE on schema "app" to "postgres";
revoke all on schema "extensions" from public,"anon","authenticated","dashboard_user","postgres","service_role","supabase_admin";
grant USAGE on schema "extensions" to "anon";
grant USAGE on schema "extensions" to "authenticated";
grant CREATE on schema "extensions" to "dashboard_user";
grant USAGE on schema "extensions" to "dashboard_user";
grant CREATE on schema "extensions" to "postgres";
grant USAGE on schema "extensions" to "postgres";
grant USAGE on schema "extensions" to "service_role";
revoke all on schema "public" from public,"anon","authenticated","pg_database_owner","postgres","service_role","supabase_admin";
grant USAGE on schema "public" to public;
grant USAGE on schema "public" to "anon";
grant USAGE on schema "public" to "authenticated";
grant CREATE on schema "public" to "pg_database_owner";
grant USAGE on schema "public" to "pg_database_owner";
grant USAGE on schema "public" to "postgres";
grant USAGE on schema "public" to "service_role";
revoke all on sequence "public"."documentos_id_seq" from public,"anon","authenticated","postgres","service_role","supabase_admin";
grant SELECT on sequence "public"."documentos_id_seq" to "anon";
grant UPDATE on sequence "public"."documentos_id_seq" to "anon";
grant USAGE on sequence "public"."documentos_id_seq" to "anon";
grant SELECT on sequence "public"."documentos_id_seq" to "authenticated";
grant UPDATE on sequence "public"."documentos_id_seq" to "authenticated";
grant USAGE on sequence "public"."documentos_id_seq" to "authenticated";
grant SELECT on sequence "public"."documentos_id_seq" to "postgres";
grant UPDATE on sequence "public"."documentos_id_seq" to "postgres";
grant USAGE on sequence "public"."documentos_id_seq" to "postgres";
grant SELECT on sequence "public"."documentos_id_seq" to "service_role";
grant UPDATE on sequence "public"."documentos_id_seq" to "service_role";
grant USAGE on sequence "public"."documentos_id_seq" to "service_role";
alter default privileges for role "postgres" in schema "public" revoke all on sequences from public,"postgres","anon","authenticated","service_role";
alter default privileges for role "postgres" in schema "public" grant SELECT on sequences to "postgres";
alter default privileges for role "postgres" in schema "public" grant UPDATE on sequences to "postgres";
alter default privileges for role "postgres" in schema "public" grant USAGE on sequences to "postgres";
alter default privileges for role "postgres" in schema "public" grant SELECT on sequences to "anon";
alter default privileges for role "postgres" in schema "public" grant UPDATE on sequences to "anon";
alter default privileges for role "postgres" in schema "public" grant USAGE on sequences to "anon";
alter default privileges for role "postgres" in schema "public" grant SELECT on sequences to "authenticated";
alter default privileges for role "postgres" in schema "public" grant UPDATE on sequences to "authenticated";
alter default privileges for role "postgres" in schema "public" grant USAGE on sequences to "authenticated";
alter default privileges for role "postgres" in schema "public" grant SELECT on sequences to "service_role";
alter default privileges for role "postgres" in schema "public" grant UPDATE on sequences to "service_role";
alter default privileges for role "postgres" in schema "public" grant USAGE on sequences to "service_role";
alter default privileges for role "postgres" in schema "public" revoke all on functions from public,"postgres","anon","authenticated","service_role";
alter default privileges for role "postgres" in schema "public" grant EXECUTE on functions to "postgres";
alter default privileges for role "postgres" in schema "public" grant EXECUTE on functions to "anon";
alter default privileges for role "postgres" in schema "public" grant EXECUTE on functions to "authenticated";
alter default privileges for role "postgres" in schema "public" grant EXECUTE on functions to "service_role";
alter default privileges for role "postgres" in schema "public" revoke all on tables from public,"postgres","anon","authenticated","service_role";
alter default privileges for role "postgres" in schema "public" grant INSERT on tables to "postgres";
alter default privileges for role "postgres" in schema "public" grant SELECT on tables to "postgres";
alter default privileges for role "postgres" in schema "public" grant UPDATE on tables to "postgres";
alter default privileges for role "postgres" in schema "public" grant DELETE on tables to "postgres";
alter default privileges for role "postgres" in schema "public" grant TRUNCATE on tables to "postgres";
alter default privileges for role "postgres" in schema "public" grant REFERENCES on tables to "postgres";
alter default privileges for role "postgres" in schema "public" grant TRIGGER on tables to "postgres";
alter default privileges for role "postgres" in schema "public" grant MAINTAIN on tables to "postgres";
alter default privileges for role "postgres" in schema "public" grant INSERT on tables to "anon";
alter default privileges for role "postgres" in schema "public" grant SELECT on tables to "anon";
alter default privileges for role "postgres" in schema "public" grant UPDATE on tables to "anon";
alter default privileges for role "postgres" in schema "public" grant DELETE on tables to "anon";
alter default privileges for role "postgres" in schema "public" grant TRUNCATE on tables to "anon";
alter default privileges for role "postgres" in schema "public" grant REFERENCES on tables to "anon";
alter default privileges for role "postgres" in schema "public" grant TRIGGER on tables to "anon";
alter default privileges for role "postgres" in schema "public" grant MAINTAIN on tables to "anon";
alter default privileges for role "postgres" in schema "public" grant INSERT on tables to "authenticated";
alter default privileges for role "postgres" in schema "public" grant SELECT on tables to "authenticated";
alter default privileges for role "postgres" in schema "public" grant UPDATE on tables to "authenticated";
alter default privileges for role "postgres" in schema "public" grant DELETE on tables to "authenticated";
alter default privileges for role "postgres" in schema "public" grant TRUNCATE on tables to "authenticated";
alter default privileges for role "postgres" in schema "public" grant REFERENCES on tables to "authenticated";
alter default privileges for role "postgres" in schema "public" grant TRIGGER on tables to "authenticated";
alter default privileges for role "postgres" in schema "public" grant MAINTAIN on tables to "authenticated";
alter default privileges for role "postgres" in schema "public" grant INSERT on tables to "service_role";
alter default privileges for role "postgres" in schema "public" grant SELECT on tables to "service_role";
alter default privileges for role "postgres" in schema "public" grant UPDATE on tables to "service_role";
alter default privileges for role "postgres" in schema "public" grant DELETE on tables to "service_role";
alter default privileges for role "postgres" in schema "public" grant TRUNCATE on tables to "service_role";
alter default privileges for role "postgres" in schema "public" grant REFERENCES on tables to "service_role";
alter default privileges for role "postgres" in schema "public" grant TRIGGER on tables to "service_role";
alter default privileges for role "postgres" in schema "public" grant MAINTAIN on tables to "service_role";
alter default privileges for role "supabase_admin" in schema "public" revoke all on sequences from public,"postgres","anon","authenticated","service_role";
alter default privileges for role "supabase_admin" in schema "public" grant SELECT on sequences to "postgres";
alter default privileges for role "supabase_admin" in schema "public" grant UPDATE on sequences to "postgres";
alter default privileges for role "supabase_admin" in schema "public" grant USAGE on sequences to "postgres";
alter default privileges for role "supabase_admin" in schema "public" grant SELECT on sequences to "anon";
alter default privileges for role "supabase_admin" in schema "public" grant UPDATE on sequences to "anon";
alter default privileges for role "supabase_admin" in schema "public" grant USAGE on sequences to "anon";
alter default privileges for role "supabase_admin" in schema "public" grant SELECT on sequences to "authenticated";
alter default privileges for role "supabase_admin" in schema "public" grant UPDATE on sequences to "authenticated";
alter default privileges for role "supabase_admin" in schema "public" grant USAGE on sequences to "authenticated";
alter default privileges for role "supabase_admin" in schema "public" grant SELECT on sequences to "service_role";
alter default privileges for role "supabase_admin" in schema "public" grant UPDATE on sequences to "service_role";
alter default privileges for role "supabase_admin" in schema "public" grant USAGE on sequences to "service_role";
alter default privileges for role "supabase_admin" in schema "public" revoke all on functions from public,"postgres","anon","authenticated","service_role";
alter default privileges for role "supabase_admin" in schema "public" grant EXECUTE on functions to "postgres";
alter default privileges for role "supabase_admin" in schema "public" grant EXECUTE on functions to "anon";
alter default privileges for role "supabase_admin" in schema "public" grant EXECUTE on functions to "authenticated";
alter default privileges for role "supabase_admin" in schema "public" grant EXECUTE on functions to "service_role";
alter default privileges for role "supabase_admin" in schema "public" revoke all on tables from public,"postgres","anon","authenticated","service_role";
alter default privileges for role "supabase_admin" in schema "public" grant INSERT on tables to "postgres";
alter default privileges for role "supabase_admin" in schema "public" grant SELECT on tables to "postgres";
alter default privileges for role "supabase_admin" in schema "public" grant UPDATE on tables to "postgres";
alter default privileges for role "supabase_admin" in schema "public" grant DELETE on tables to "postgres";
alter default privileges for role "supabase_admin" in schema "public" grant TRUNCATE on tables to "postgres";
alter default privileges for role "supabase_admin" in schema "public" grant REFERENCES on tables to "postgres";
alter default privileges for role "supabase_admin" in schema "public" grant TRIGGER on tables to "postgres";
alter default privileges for role "supabase_admin" in schema "public" grant MAINTAIN on tables to "postgres";
alter default privileges for role "supabase_admin" in schema "public" grant INSERT on tables to "anon";
alter default privileges for role "supabase_admin" in schema "public" grant SELECT on tables to "anon";
alter default privileges for role "supabase_admin" in schema "public" grant UPDATE on tables to "anon";
alter default privileges for role "supabase_admin" in schema "public" grant DELETE on tables to "anon";
alter default privileges for role "supabase_admin" in schema "public" grant TRUNCATE on tables to "anon";
alter default privileges for role "supabase_admin" in schema "public" grant REFERENCES on tables to "anon";
alter default privileges for role "supabase_admin" in schema "public" grant TRIGGER on tables to "anon";
alter default privileges for role "supabase_admin" in schema "public" grant MAINTAIN on tables to "anon";
alter default privileges for role "supabase_admin" in schema "public" grant INSERT on tables to "authenticated";
alter default privileges for role "supabase_admin" in schema "public" grant SELECT on tables to "authenticated";
alter default privileges for role "supabase_admin" in schema "public" grant UPDATE on tables to "authenticated";
alter default privileges for role "supabase_admin" in schema "public" grant DELETE on tables to "authenticated";
alter default privileges for role "supabase_admin" in schema "public" grant TRUNCATE on tables to "authenticated";
alter default privileges for role "supabase_admin" in schema "public" grant REFERENCES on tables to "authenticated";
alter default privileges for role "supabase_admin" in schema "public" grant TRIGGER on tables to "authenticated";
alter default privileges for role "supabase_admin" in schema "public" grant MAINTAIN on tables to "authenticated";
alter default privileges for role "supabase_admin" in schema "public" grant INSERT on tables to "service_role";
alter default privileges for role "supabase_admin" in schema "public" grant SELECT on tables to "service_role";
alter default privileges for role "supabase_admin" in schema "public" grant UPDATE on tables to "service_role";
alter default privileges for role "supabase_admin" in schema "public" grant DELETE on tables to "service_role";
alter default privileges for role "supabase_admin" in schema "public" grant TRUNCATE on tables to "service_role";
alter default privileges for role "supabase_admin" in schema "public" grant REFERENCES on tables to "service_role";
alter default privileges for role "supabase_admin" in schema "public" grant TRIGGER on tables to "service_role";
alter default privileges for role "supabase_admin" in schema "public" grant MAINTAIN on tables to "service_role";
do $publication_guard$ begin if not exists(select 1 from pg_publication where pubname='supabase_realtime') then create publication supabase_realtime; end if; end $publication_guard$;
alter publication supabase_realtime set (publish='insert, update, delete, truncate', publish_via_partition_root=false);
alter publication supabase_realtime add table "public"."anesthesia_records";
alter publication supabase_realtime add table "public"."anesthesia_timeline_events";
alter publication supabase_realtime add table "public"."appointments";
alter publication supabase_realtime add table "public"."consents";
alter publication supabase_realtime add table "public"."consultations";
alter publication supabase_realtime add table "public"."encounters";
alter publication supabase_realtime add table "public"."finance_entries";
alter publication supabase_realtime add table "public"."patients";
alter publication supabase_realtime add table "public"."preanesthetic_assessments";
alter publication supabase_realtime add table "public"."quotes";
alter publication supabase_realtime add table "public"."recovery_records";
alter publication supabase_realtime add table "public"."risk_assessments";
alter publication supabase_realtime owner to "postgres";
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('clinical-attachments','clinical-attachments',false,null,null) on conflict(id) do update set public=excluded.public,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('documentos-pdf','documentos-pdf',false,null,null) on conflict(id) do update set public=excluded.public,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
commit;
