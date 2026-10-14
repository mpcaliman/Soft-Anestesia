-- =============================================================================
-- Soft Anestesia — 0036: a auditoria guarda O QUE MUDOU, não o documento inteiro
-- =============================================================================
-- Rode DEPOIS da 0035. Idempotente: redefine UMA função de gatilho e não toca
-- em dado nenhum, em tabela nenhuma, em permissão nenhuma. Nada do que já está
-- gravado é alterado ou apagado.
--
-- POR QUE EXISTE
--
-- A tabela de auditoria chegou a 155 MB — metade do banco — e a divisão por
-- ação mostrou a razão:
--
--   update   · anesthesia_records   1.524 linhas   55 MB   (~37 KB por linha)
--   finalize · anesthesia_records     167 linhas   15 MB   (~92 KB por linha)
--   insert   · anesthesia_records     207 linhas   15 MB   (~74 KB por linha)
--
-- Não é lixo acumulado nem efeito de defeito: 1.524 atualizações em três meses
-- é o número de quem trabalha todo dia. O que pesa é o gatilho gravar
-- `new_value := to_jsonb(new)` — A LINHA INTEIRA — a cada gravação. Uma ficha
-- de anestesia com gráfico, medicações e eventos tem dezenas de KB, e o
-- auto-save grava a cada pausa na digitação.
--
-- O CONSERTO DEIXA A AUDITORIA MELHOR, E NÃO SÓ MENOR
--
-- Para UPDATE, o que a auditoria precisa responder é "o que mudou, de que para
-- que" — e era justamente isso que ela NÃO dizia: guardava o documento depois,
-- e descobrir a diferença exigia comparar duas cópias de 40 KB à mão. A coluna
-- `previous_value` existe desde a 0001 e nunca foi usada.
--
-- Agora o UPDATE grava só os campos que mudaram, nos dois lados:
--   previous_value → {campo: valor antigo}
--   new_value      → {campo: valor novo}
--
-- O QUE CONTINUA GUARDANDO O DOCUMENTO INTEIRO, DE PROPÓSITO
--
-- insert, finalize, delete e restore. São os atos que valem como estado: o que
-- nasceu, o que foi ASSINADO, o que foi excluído e o que voltou. Numa
-- contestação é a esses quatro que se recorre, e neles o tamanho é o preço da
-- prova. `finalize` é o retrato do documento no instante da assinatura e não
-- pode virar diff.
--
-- Nada muda para quem lê a auditoria pela tela: o módulo, a ação, o autor, o
-- registro e a data continuam iguais. Muda o volume e a clareza do conteúdo.
-- =============================================================================

begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

/* O QUE DIFERE, DO LADO PEDIDO.
   Desce pelos objetos enquanto os dois lados forem objetos; chegando a valor,
   lista, texto ou ausência, devolve aquele valor inteiro — é o menor pedaço que
   ainda significa alguma coisa. O teto de profundidade existe para um documento
   malformado não virar recursão infinita dentro de um gatilho. */
create or replace function app.audit_diff(a jsonb, b jsonb, lado text, profundidade integer default 0)
returns jsonb language plpgsql immutable security invoker
set search_path = pg_catalog, public, app
as $diff$
declare
  k text;
  out jsonb := '{}'::jsonb;
  parte jsonb;
begin
  if profundidade > 8
     or jsonb_typeof(a) is distinct from 'object'
     or jsonb_typeof(b) is distinct from 'object' then
    return case when lado = 'novo' then b else a end;
  end if;
  for k in select jsonb_object_keys(a || b) loop
    if (a -> k) is distinct from (b -> k) then
      parte := app.audit_diff(a -> k, b -> k, lado, profundidade + 1);
      out := out || jsonb_build_object(k, parte);
    end if;
  end loop;
  return out;
end
$diff$;
revoke all on function app.audit_diff(jsonb,jsonb,text,integer) from public, anon;
grant execute on function app.audit_diff(jsonb,jsonb,text,integer) to authenticated;

create or replace function app.audit_row()
returns trigger language plpgsql security definer set search_path = public, app, auth as $$
declare
  jn jsonb;      -- new (ou old, em delete)
  jo jsonb;      -- old (em update/delete)
  v_action text;
  v_new jsonb;
  v_prev jsonb;
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

  if v_action = 'update' then
    /* A comparação tem de entrar DENTRO do documento, e não parar na coluna.
       O prontuário inteiro mora em `dados`: comparando só no nível da linha, o
       campo mudado seria sempre "dados" e a auditoria passaria a guardar o
       documento DUAS vezes — pior do que antes. `app.audit_diff` desce pelos
       objetos aninhados e devolve apenas o que de fato difere. */
    v_new  := app.audit_diff(jo, jn, 'novo');
    v_prev := app.audit_diff(jo, jn, 'anterior');
    /* Gravação que não mudou campo nenhum não vira linha de auditoria: ela não
       registra ato nenhum, e o auto-save produz várias assim. Também não vira
       linha a gravação em que só mexeu o maquinário — `updated_at` e `version`
       mudam a cada toque do auto-save e a cada CAS, sem que nada do prontuário
       tenha mudado. Uma auditoria com centenas de "update" cujo conteúdo é um
       carimbo de hora é uma auditoria mais difícil de ler, não mais completa.
       Quando o conteúdo muda de verdade, os dois carimbos continuam na linha,
       porque aí eles situam o ato no tempo. */
    if v_new is null
       or (v_new - 'updated_at' - 'version') = '{}'::jsonb then return null; end if;
  else
    /* insert, finalize, delete, restore: o estado inteiro, que é o que vale
       como prova nesses quatro. */
    v_new  := jn;
    v_prev := null;
  end if;

  insert into public.audit_logs(organization_id, user_id, patient_id, encounter_id,
                                module, record_id, action, previous_value, new_value, created_at)
  values (nullif(jn->>'organization_id','')::uuid, auth.uid(),
          nullif(jn->>'patient_id','')::uuid, nullif(jn->>'encounter_id','')::uuid,
          tg_table_name, nullif(jn->>'id','')::uuid, v_action, v_prev, v_new, now());
  return null; -- AFTER trigger
end $$;

commit;
