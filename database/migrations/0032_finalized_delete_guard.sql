-- =============================================================================
-- Soft Anestesia — 0032: preserva originais finalizados também contra DELETE
-- =============================================================================
-- Nova migração depois de 0031; não reescreve o histórico aplicado de 0020.
-- A sequência 0001–0032 é o formato histórico deste repositório. A tentativa
-- de gerar por `supabase migration new` não pôde ser concluída porque a CLI
-- não está instalada no workspace; nenhum pacote foi baixado para contornar.
-- Não executada remotamente. Rollback de fixtures deve ser transacional;
-- cascades administrativos não são uma forma válida de remover evidências.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create or replace function app.guard_finalized()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, app
as $fn$
begin
  -- A coluna canônica cobre os registros atuais. Os outros sinais preservam
  -- originais antigos assinados/finalizados ainda sem carimbo normalizado.
  if old.finalized_at is not null
     or lower(coalesce(old.status, '')) in ('finalized','signed')
     or lower(coalesce(old.data->>'_finalizado', 'false')) = 'true' then
    raise exception 'Registro finalizado/assinado é imutável. Use um adendo para correções (record %, tabela %).', old.id, tg_table_name
      using errcode = 'check_violation';
  end if;
  -- BEFORE DELETE precisa devolver OLD para que a exclusão autorizada de um
  -- rascunho prossiga. Devolver NEW cancelaria a operação silenciosamente.
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$fn$;
revoke all on function app.guard_finalized() from public, anon, authenticated, service_role;

do $block$
declare t text;
begin
  foreach t in array array[
    'preanesthetic_assessments','consultations','anesthesia_records',
    'recovery_records','risk_assessments','consents','prescriptions','documents',
    'cash_closings'
  ] loop
    -- Falhar fechado evita uma "aplicação bem-sucedida" sobre baseline parcial.
    if to_regclass(format('public.%I', t)) is null then
      raise exception 'Tabela public.% ausente; reconcilie a baseline antes de proteger originais.', t;
    end if;
    execute format('drop trigger if exists trg_guard on public.%I', t);
    execute format(
      'create trigger trg_guard before update or delete on public.%I '
      'for each row execute function app.guard_finalized()', t
    );
    -- Inclusive cascades e sessões administrativas em replica conservam o
    -- guard. Não há exceção para proprietário, programador ou service_role.
    execute format('alter table public.%I enable always trigger trg_guard', t);
  end loop;
end
$block$;

-- Não altera RLS, grants de tabelas, original, adendos, auditoria ou Realtime.
commit;
