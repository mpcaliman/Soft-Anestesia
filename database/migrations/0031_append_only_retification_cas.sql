-- =============================================================================
-- Soft Anestesia — 0031: retificação estruturada, append-only e CAS no servidor
-- =============================================================================
-- Proposta local após 0030. Não aplicada em produção ou na homologação parcial.
-- O prontuário assinado, suas FKs e sua revisão permanecem integralmente iguais.
-- Uma retificação aceita produz uma projeção clínica; a proposta concorrente
-- é preservada como outro adendo, com status conflict, sem substituir a aceita.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- NULL identifica adendos históricos/ordinários e propostas conflitantes.
-- Só o trigger atribui uma revisão aceita; JSON antigo não é uma cabeça CAS.
alter table public.addenda add column if not exists retification_revision bigint;
create unique index if not exists addenda_retification_revision_unique
  on public.addenda(organization_id, parent_table, parent_id, retification_revision)
  where retification_revision is not null;

create or replace function app.valid_retification_fields(p_value jsonb, p_depth integer default 0)
returns boolean
language plpgsql
immutable
security invoker
set search_path = pg_catalog, public, app
as $fn$
declare
  k text;
  v jsonb;
  kind text := jsonb_typeof(p_value);
begin
  if p_depth is null or p_depth < 0 or p_depth > 16 or kind is null then return false; end if;
  if kind = 'object' then
    for k, v in select key, value from jsonb_each(p_value) loop
      if lower(k) = any(array[
        '__proto__','constructor','prototype','id','patient_id','patientid',
        'patientref','patientkey','caseid','casekey','encounter_id','encounterid',
        'organization_id','organizationid','orgid','legacy_id','version',
        'created_by','created_at','updated_at','updated_by','finalized_at','finalized_by','signed_at','signed_by',
        'author_id','authorid','user_id','userid','uid','deviceid','tabid','sessionid',
        'access_token','refresh_token','dataurl','sig_dataurl','carimbo'
      ]) or left(lower(k),10) = 'assinatura' or left(lower(k),9) = 'signature'
         or left(lower(k),15) = 'data_assinatura' then
        return false;
      end if;
      if left(k,1) = '_' and not (p_depth = 0 and k = any(array[
        '_medsLista','_procsExtra','_labExtras','_premedSel',
        '_seguimentos','_procsRealizados','_resumo'
      ])) then return false; end if;
      if not app.valid_retification_fields(v,p_depth+1) then return false; end if;
    end loop;
  elsif kind = 'array' then
    for v in select value from jsonb_array_elements(p_value) loop
      if not app.valid_retification_fields(v,p_depth+1) then return false; end if;
    end loop;
  end if;
  return true;
end
$fn$;
revoke all on function app.valid_retification_fields(jsonb,integer) from public, anon;
grant execute on function app.valid_retification_fields(jsonb,integer) to authenticated;

create or replace function app.stamp_retification_cas()
returns trigger
language plpgsql
volatile
security invoker
set search_path = pg_catalog, public, app, auth
as $fn$
declare
  proposed jsonb;
  prior public.addenda%rowtype;
  head_id text := '';
  head_revision bigint := 0;
  outcome text;
begin
  -- Nem INSERT direto permite ao cliente forjar a coluna interna.
  new.retification_revision := null;
  if not (new.data ? 'retificacao') then return new; end if;
  proposed := new.data->'retificacao';
  if new.reason not in ('correcao','retificacao')
     or length(new.legacy_id) > 180
     or jsonb_typeof(proposed) is distinct from 'object'
     or proposed->'schema' is distinct from '1'::jsonb
     or jsonb_typeof(proposed->'baseAdendoId') is distinct from 'string'
     or length(proposed->>'baseAdendoId') > 180
     or jsonb_typeof(proposed->'campos') is distinct from 'object'
     or proposed->'campos' = '{}'::jsonb
     or proposed - array['schema','baseAdendoId','campos'] <> '{}'::jsonb
     or octet_length(proposed::text) > 262144
     or not app.valid_retification_fields(proposed->'campos') then
    raise exception 'Proposta de retificação inválida.' using errcode = 'check_violation';
  end if;

  -- O stamp anterior valida pai finalizado e deriva organização/FKs/autor/hora.
  -- A defesa explícita impede que o lock revele uma cabeça fora do escopo RLS.
  if auth.uid() is null
     or not exists (select 1 from app.org_ids() as o(id) where o.id = new.organization_id)
     or not (app.has_role(new.organization_id,array['gestor'])
       or app.pode_editar_modulo(new.organization_id,app.module_for_table(new.parent_table)))
     or not app.can_access_addendum_parent(new.organization_id,new.parent_table,new.parent_id) then
    raise exception 'Retificação não autorizada.' using errcode = 'insufficient_privilege';
  end if;

  -- PostgREST usa READ COMMITTED. Uma transação com snapshot fixo deve repetir
  -- inteira, em vez de aceitar uma cabeça que ficou antiga durante a espera.
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'Repita a retificação em READ COMMITTED.' using errcode = 'serialization_failure';
  end if;
  -- O rótulo de autoria também vem da identidade autenticada, nunca de texto
  -- informado pelo aparelho. Ausência de perfil usa o UUID canônico.
  new.data := jsonb_set(new.data,'{autor_exibicao}',to_jsonb(coalesce(
    (select nullif(btrim(p.nome),'') from public.profiles p where p.id = auth.uid()),auth.uid()::text)));
  -- Serializa também UUID reutilizado simultaneamente em dois pais distintos.
  -- A identidade da operação é travada antes da identidade da cadeia.
  perform pg_advisory_xact_lock(hashtextextended(
    new.organization_id::text || '/addenda-operation/' || new.legacy_id,1));
  -- Lock transacional por org/tabela/UUID, sem UPDATE ou privilégio de UPDATE
  -- no pai imutável. Colisões do hash só serializam pais independentes.
  perform pg_advisory_xact_lock(hashtextextended(
    new.organization_id::text || '/' || new.parent_table || '/' || new.parent_id::text,0));

  -- Comando posterior ao lock: vê a transação concorrente recém-confirmada.
  -- Mesmo UUID de operação nunca confirma outra proposta por ignore-duplicates.
  select * into prior from public.addenda
   where organization_id = new.organization_id and legacy_id = new.legacy_id;
  if found then
    if prior.parent_table is distinct from new.parent_table
       or prior.parent_id is distinct from new.parent_id
       or prior.texto is distinct from new.texto
       or prior.reason is distinct from new.reason
       or prior.author_id is distinct from new.author_id
       or (prior.data->'retificacao') - array['status','revisao','baseAtualId'] is distinct from proposed then
      raise exception 'Identificador de retificação reutilizado para outra proposta.'
        using errcode = 'check_violation';
    end if;
    new.data := jsonb_set(new.data,'{retificacao}',prior.data->'retificacao');
    new.retification_revision := prior.retification_revision;
    return new;
  end if;

  select legacy_id,retification_revision into head_id,head_revision
    from public.addenda
   where organization_id = new.organization_id and parent_table = new.parent_table
     and parent_id = new.parent_id and retification_revision is not null
   order by retification_revision desc limit 1;
  head_id := coalesce(head_id,'');
  head_revision := coalesce(head_revision,0);
  outcome := case when proposed->>'baseAdendoId' = head_id then 'accepted' else 'conflict' end;
  if outcome = 'accepted' then new.retification_revision := head_revision+1; end if;
  new.data := jsonb_set(new.data,'{retificacao}',proposed || jsonb_build_object(
    'status',outcome,'revisao',coalesce(new.retification_revision,head_revision),'baseAtualId',head_id));
  return new;
end
$fn$;
revoke all on function app.stamp_retification_cas() from public, anon;
grant execute on function app.stamp_retification_cas() to authenticated;

-- PostgreSQL executa triggers de um mesmo evento em ordem alfabética.
-- `stamped` vem depois de `stamp`: autor/FKs/hora já foram derivados em 0020.
drop trigger if exists trg_addenda_stamped_retification on public.addenda;
create trigger trg_addenda_stamped_retification
  before insert on public.addenda
  for each row execute function app.stamp_retification_cas();

-- As policies SELECT/INSERT, append-only e audit de 0020/0025 são preservadas.
-- Realtime já publica addenda com replica identity full desde 0020.
revoke update, delete on table public.addenda from authenticated;
commit;
