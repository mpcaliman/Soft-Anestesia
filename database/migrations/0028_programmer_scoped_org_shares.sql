-- =============================================================================
-- Soft Anestesia — 0028: exceções entre clínicas explícitas, temporárias e auditadas
-- =============================================================================
-- Arquivo revisável. Aplicação remota continua bloqueada pela baseline/G3.
-- Sem inferir clínica ou autorização: compartilhamentos anteriores ficam
-- inativos até nova decisão manual do programador com motivo, módulos e prazo.
-- O prazo é verificado em cada leitura; a manutenção só materializa a expiração
-- no histórico. Ausência de pg_cron nunca prolonga acesso.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.org_shares
  add column if not exists ativo boolean not null default false,
  add column if not exists acesso text not null default 'leitura',
  add column if not exists motivo text,
  add column if not exists expira_em timestamptz,
  add column if not exists autorizado_por uuid references auth.users(id),
  add column if not exists autorizado_em timestamptz,
  add column if not exists revogado_por uuid references auth.users(id),
  add column if not exists revogado_em timestamptz,
  add column if not exists motivo_revogacao text,
  add column if not exists expirado_em timestamptz;

alter table public.org_shares alter column modulos drop default;
alter table public.org_shares enable row level security;

-- NOT VALID preserva metadados legados incompletos sem lhes devolver acesso.
-- As constraints passam a valer para toda nova autorização/alteração.
alter table public.org_shares drop constraint if exists org_shares_explicit_scope;
alter table public.org_shares add constraint org_shares_explicit_scope check (
  not ativo or (
    org_origem <> org_destino and acesso = 'leitura'
    and cardinality(modulos) > 0 and array_position(modulos, null) is null
    and modulos <@ array['pacientes','pre','consulta','anestesia','recuperacao',
                         'risco','termo','prescricao','documentos','financeiro',
                         'orcamento','agenda']::text[]
    and motivo is not null and length(btrim(motivo)) between 12 and 500
    and expira_em is not null and isfinite(expira_em)
    and autorizado_por is not null and autorizado_em is not null
    and expira_em > autorizado_em
    and expira_em <= autorizado_em + interval '90 days'
    and revogado_em is null and expirado_em is null
  )
) not valid;
alter table public.org_shares drop constraint if exists org_shares_read_only;
alter table public.org_shares add constraint org_shares_read_only
  check (acesso = 'leitura');

create or replace function app.guard_explicit_org_share()
returns trigger language plpgsql
set search_path = pg_catalog, public, app, auth
as $fn$
begin
  if tg_op = 'DELETE' then
    raise exception 'Revogue o compartilhamento; seu histórico não pode ser apagado.'
      using errcode = 'check_violation';
  end if;
  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id
       or new.org_origem is distinct from old.org_origem
       or new.org_destino is distinct from old.org_destino
       or new.criado_por is distinct from old.criado_por
       or new.criado_em is distinct from old.criado_em then
      raise exception 'Origem, destino e autoria original do compartilhamento são imutáveis.'
        using errcode = 'check_violation';
    end if;
    -- Manutenção não autoriza nem amplia escopo: só desativa um prazo vencido.
    if old.ativo and not new.ativo and old.expira_em <= statement_timestamp()
       and new.expirado_em is not null
       and (to_jsonb(new) - array['ativo','expirado_em']) =
           (to_jsonb(old) - array['ativo','expirado_em']) then
      return new;
    end if;
  end if;
  if auth.uid() is null or not app.eh_programador() then
    raise exception 'Apenas o programador pode autorizar ou revogar acesso entre clínicas.'
      using errcode = 'insufficient_privilege';
  end if;
  if new.ativo and (
     new.autorizado_por is distinct from auth.uid()
     or new.expira_em <= statement_timestamp()
     or new.autorizado_em is distinct from statement_timestamp()) then
    raise exception 'A autorização exige programador autenticado e prazo futuro explícito.'
      using errcode = 'check_violation';
  end if;
  return new;
end
$fn$;

drop trigger if exists trg_org_share_explicit on public.org_shares;
create trigger trg_org_share_explicit before insert or update or delete
  on public.org_shares for each row execute function app.guard_explicit_org_share();

create or replace function app.audit_explicit_org_share()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, auth
as $fn$
declare
  v_action text;
begin
  v_action := case
    when tg_op = 'INSERT' then 'org_share_authorized'
    when new.expirado_em is distinct from old.expirado_em
         and new.expirado_em is not null then 'org_share_expired'
    when old.ativo and not new.ativo then 'org_share_revoked'
    else 'org_share_reauthorized'
  end;
  insert into public.audit_logs(organization_id,user_id,module,record_id,action,
                                previous_value,new_value,created_at)
  values (new.org_origem,auth.uid(),'org_shares',new.id,v_action,
          case when tg_op = 'UPDATE' then to_jsonb(old) else null end,
          to_jsonb(new),statement_timestamp());
  return null;
end
$fn$;
drop trigger if exists trg_org_share_audit on public.org_shares;
create trigger trg_org_share_audit after insert or update on public.org_shares
  for each row execute function app.audit_explicit_org_share();

create or replace function app.expire_org_shares()
returns integer language plpgsql security definer
set search_path = pg_catalog, public
as $fn$
declare v_count integer;
begin
  update public.org_shares set ativo = false, expirado_em = statement_timestamp()
   where ativo and expira_em <= statement_timestamp();
  get diagnostics v_count = row_count;
  return v_count;
end
$fn$;

create or replace function app.compartilhada_para_mim(p_org uuid,p_modulo text)
returns boolean language sql stable security definer
set search_path = pg_catalog, public, app, auth
as $fn$
  select auth.uid() is not null and exists (
    select 1 from public.org_shares s
     where s.org_origem = p_org and s.org_origem <> s.org_destino
       and s.org_destino in (select app.org_ids())
       and app.pode_modulo(s.org_destino,p_modulo)
       and s.ativo and s.acesso = 'leitura'
       and length(btrim(s.motivo)) between 12 and 500
       and s.autorizado_por is not null and s.autorizado_em is not null
       and s.expira_em > statement_timestamp()
       and s.expira_em <= s.autorizado_em + interval '90 days'
       and s.revogado_em is null and s.expirado_em is null
       and cardinality(s.modulos) > 0 and p_modulo = any(s.modulos)
  )
$fn$;

create or replace function public.prog_authorize_org_share(
  p_org_origem uuid,p_org_destino uuid,p_modulos text[],p_motivo text,p_expira_em timestamptz
)
returns uuid language plpgsql security definer
set search_path = pg_catalog, public, app, auth
as $fn$
declare v_id uuid; v_modules text[];
begin
  if auth.uid() is null or not app.eh_programador() then
    raise exception 'Apenas o programador pode autorizar acesso entre clínicas.'
      using errcode = 'insufficient_privilege';
  end if;
  if p_org_origem is null or p_org_destino is null or p_org_origem = p_org_destino then
    raise exception 'Escolha duas clínicas diferentes.' using errcode = 'invalid_parameter_value';
  end if;
  if p_modulos is null or cardinality(p_modulos) = 0
     or array_position(p_modulos,null) is not null
     or not p_modulos <@ array['pacientes','pre','consulta','anestesia','recuperacao',
                              'risco','termo','prescricao','documentos','financeiro',
                              'orcamento','agenda']::text[] then
    raise exception 'Selecione explicitamente ao menos um módulo válido.'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_motivo is null or length(btrim(p_motivo)) not between 12 and 500 then
    raise exception 'Informe justificativa entre 12 e 500 caracteres, sem conteúdo clínico.'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_expira_em is null or not isfinite(p_expira_em)
     or p_expira_em <= statement_timestamp()
     or p_expira_em > statement_timestamp() + interval '90 days' then
    raise exception 'Informe prazo futuro de até 90 dias.' using errcode = 'invalid_parameter_value';
  end if;
  select array_agg(distinct m order by m) into v_modules from unnest(p_modulos) m;
  perform app.expire_org_shares();
  insert into public.org_shares(org_origem,org_destino,modulos,criado_por,ativo,acesso,
                               motivo,expira_em,autorizado_por,autorizado_em)
  values (p_org_origem,p_org_destino,v_modules,auth.uid(),true,'leitura',btrim(p_motivo),
          p_expira_em,auth.uid(),statement_timestamp())
  on conflict (org_origem,org_destino) do update set
    modulos = excluded.modulos,ativo = true,acesso = 'leitura',motivo = excluded.motivo,
    expira_em = excluded.expira_em,autorizado_por = excluded.autorizado_por,
    autorizado_em = excluded.autorizado_em,revogado_por = null,revogado_em = null,
    motivo_revogacao = null,expirado_em = null
  returning id into v_id;
  return v_id;
end
$fn$;

create or replace function public.prog_revoke_org_share(p_share_id uuid,p_motivo text)
returns boolean language plpgsql security definer
set search_path = pg_catalog, public, app, auth
as $fn$
declare v_changed integer;
begin
  if auth.uid() is null or not app.eh_programador() then
    raise exception 'Apenas o programador pode revogar acesso entre clínicas.'
      using errcode = 'insufficient_privilege';
  end if;
  if p_motivo is null or length(btrim(p_motivo)) not between 12 and 500 then
    raise exception 'Informe justificativa da revogação entre 12 e 500 caracteres.'
      using errcode = 'invalid_parameter_value';
  end if;
  perform app.expire_org_shares();
  update public.org_shares set ativo = false,revogado_por = auth.uid(),
    revogado_em = statement_timestamp(),motivo_revogacao = btrim(p_motivo)
   where id = p_share_id and ativo;
  get diagnostics v_changed = row_count;
  return v_changed = 1;
end
$fn$;

create or replace function public.prog_list_org_shares()
returns setof public.org_shares language plpgsql security definer
set search_path = pg_catalog, public, app, auth
as $fn$
begin
  if auth.uid() is null or not app.eh_programador() then
    raise exception 'Apenas o programador pode revisar exceções entre clínicas.'
      using errcode = 'insufficient_privilege';
  end if;
  perform app.expire_org_shares();
  return query select * from public.org_shares order by criado_em desc;
end
$fn$;

-- O Data API não permite alterar/apagar a tabela; RPCs estreitas fazem as
-- decisões e o mesmo commit grava a auditoria. Compartilhamento nunca concede
-- INSERT/UPDATE/DELETE clínico: as policies organizacionais de 0025 continuam.
revoke insert,update,delete,truncate on table public.org_shares from public,anon,authenticated;
drop policy if exists shares_ins on public.org_shares;
drop policy if exists shares_upd on public.org_shares;
drop policy if exists shares_del on public.org_shares;
drop policy if exists shares_prog_all on public.org_shares;
grant select on table public.org_shares to authenticated;

revoke all on function app.guard_explicit_org_share() from public,anon,authenticated;
revoke all on function app.audit_explicit_org_share() from public,anon,authenticated;
revoke all on function app.expire_org_shares() from public,anon,authenticated;
revoke all on function app.compartilhada_para_mim(uuid,text) from public,anon;
grant execute on function app.compartilhada_para_mim(uuid,text) to authenticated;
revoke all on function public.prog_authorize_org_share(uuid,uuid,text[],text,timestamptz)
  from public,anon,authenticated;
revoke all on function public.prog_revoke_org_share(uuid,text) from public,anon,authenticated;
revoke all on function public.prog_list_org_shares() from public,anon,authenticated;
grant execute on function public.prog_authorize_org_share(uuid,uuid,text[],text,timestamptz)
  to authenticated;
grant execute on function public.prog_revoke_org_share(uuid,text) to authenticated;
grant execute on function public.prog_list_org_shares() to authenticated;
grant execute on function app.expire_org_shares() to service_role;

-- Quando Cron já foi aprovado/instalado, materializa a auditoria de expiração.
-- Não instala extensão nem abre API adicional. Sem Cron, a revisão programador
-- ou manutenção service_role materializa o evento; leitura expira pelo relógio.
do $block$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is not null then
    perform cron.schedule('soft-anestesia-expire-org-shares','*/5 * * * *',
                          'select app.expire_org_shares()');
  end if;
end
$block$;

comment on table public.org_shares is
  'Exceção manual do programador; apenas leitura, módulos explícitos, motivo, prazo e auditoria. Legado inativo até reaprovação.';
commit;
