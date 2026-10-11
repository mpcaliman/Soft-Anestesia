-- =============================================================================
-- Soft Anestesia — 0023: recibos idempotentes para gravações cloud-first
-- =============================================================================
-- Local/G1 somente. Não aplicar em Supabase remoto sem autorização G3.
--
-- Uma resposta pode se perder depois que o Postgres confirmou a transação.
-- Sem um identificador persistido na própria linha, a retentativa parece uma
-- edição concorrente e vira conflito falso. As duas colunas abaixo permitem
-- reconhecer exatamente a mesma operação + conteúdo depois de timeout/crash.
-- =============================================================================

begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $block$
declare
  t text;
  c text;
begin
  foreach t in array array[
    'patients','appointments',
    'preanesthetic_assessments','consultations','anesthesia_records',
    'recovery_records','risk_assessments','consents','prescriptions',
    'documents','finance_entries','quotes'
  ] loop
    execute format(
      'alter table public.%I add column if not exists last_operation_id uuid',
      t
    );
    execute format(
      'alter table public.%I add column if not exists last_operation_checksum text',
      t
    );

    c := t || '_operation_receipt_valid';
    if not exists (
      select 1
        from pg_constraint
       where conname = c
         and conrelid = format('public.%I', t)::regclass
    ) then
      execute format(
        'alter table public.%I add constraint %I check (' ||
        '(last_operation_id is null and last_operation_checksum is null) or ' ||
        '(last_operation_id is not null and last_operation_checksum ~ ''^[0-9a-f]{64}$''))',
        t, c
      );
    end if;

    -- UUID aleatório torna colisão acidental desprezível. A unicidade por
    -- organização impede que a mesma operação seja aplicada a duas linhas.
    execute format(
      'create unique index if not exists %I on public.%I(organization_id, last_operation_id) ' ||
      'where last_operation_id is not null',
      'ux_' || t || '_last_operation', t
    );
  end loop;
end
$block$;

commit;
