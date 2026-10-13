-- =============================================================================
-- Soft Anestesia — 0035: exames em série entram na retificação
-- =============================================================================
-- Rode DEPOIS da 0034. Idempotente: redefine UMA função e não toca em dado
-- nenhum, em tabela nenhuma, em permissão nenhuma.
--
-- POR QUE EXISTE
-- A ficha passou a registrar os exames em SÉRIE: cada coleta com a sua data,
-- quantas forem necessárias (`_labSeries`), e o mesmo para os exames que não
-- são de sangue (`_exameSeries`). O motivo é clínico: o que diz alguma coisa
-- não é a creatinina de hoje, é a creatinina de hoje ao lado da de dois meses
-- atrás.
--
-- Acontece que o caso mais comum dessa série é exatamente o caso que a 0031
-- governa: o paciente faz a pré, ela é FINALIZADA, e os exames chegam depois.
-- Incluir uma coleta nova num documento finalizado é uma RETIFICAÇÃO — e a
-- 0031 só aceita campos internos (`_...`) que estejam na sua lista. Sem os
-- dois nomes aqui, o servidor recusaria a retificação e o exame que chegou
-- depois ficaria de fora da ficha. Foi para isso que a lista existe: ela
-- impede que um campo técnico qualquer atravesse a porta — então acrescentar
-- um campo é uma decisão explícita, não um efeito colateral.
--
-- A lista do cliente (`CAMPOS_CLINICOS_INTERNOS`, em index.html) e esta TÊM de
-- ser idênticas; há teste no repositório que compara as duas e reprova se
-- divergirem. Ao acrescentar um campo, mexa nas duas.
--
-- Nada mais da 0031 muda: as proteções de identidade, assinatura, credencial e
-- chave estrangeira continuam exatamente como estão abaixo, copiadas sem
-- alteração, porque esta função é redefinida inteira.
-- =============================================================================

begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

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
      -- `_labSeries` e `_exameSeries` são os dois nomes novos; o resto da lista
      -- é o da 0031, sem alteração.
      if left(k,1) = '_' and not (p_depth = 0 and k = any(array[
        '_medsLista','_procsExtra','_labExtras','_premedSel',
        '_seguimentos','_procsRealizados','_resumo',
        '_labSeries','_exameSeries'
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

commit;
