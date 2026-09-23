-- =============================================================================
-- Soft Anestesia — DESTRAVAR A CRIAÇÃO DE AMBIENTES
-- =============================================================================
-- Sintoma: na aba Programador, "Criar ambiente" não faz nada (na verdade dá um
-- erro que some rápido demais para ser lido).
--
-- Causa: o APP mostra a aba conferindo o E-MAIL da conta. Quem autoriza de
-- verdade é o BANCO, por uma linha na tabela `app_programmers`. A semente da
-- migração 0009 só inseriu essa linha se a conta na nuvem JÁ EXISTISSE quando
-- ela rodou — se a conta veio depois, a tabela ficou vazia e toda ação falha.
--
-- Rode este arquivo inteiro no SQL Editor do Supabase. É idempotente: pode
-- rodar de novo quantas vezes quiser, não duplica nada.
--
-- TROQUE o e-mail abaixo se a conta que você usa no app for outra.
-- =============================================================================

-- 1) A migração 0009 já rodou? -----------------------------------------------
--    Se a próxima consulta devolver 0 linhas, PARE: rode antes o arquivo
--    0009_programador_ambientes.sql. Sem ele não existe nem a tabela nem a
--    função que o botão chama.
select count(*) as tabela_app_programmers_existe
  from information_schema.tables
 where table_schema = 'public' and table_name = 'app_programmers';

select count(*) as funcao_criar_ambiente_existe
  from information_schema.routines
 where routine_schema = 'public' and routine_name = 'prog_criar_ambiente';


-- 2) Quem é você na nuvem ----------------------------------------------------
--    Confirme que o e-mail abaixo aparece. Se não aparecer, a conta não existe
--    com esse endereço — e é por isso que nada funciona.
select id, email, created_at
  from auth.users
 where lower(email) = lower('mpcaliman@hotmail.com');


-- 3) Registrar a conta como PROGRAMADOR --------------------------------------
insert into public.app_programmers(user_id)
select id from auth.users
 where lower(email) = lower('mpcaliman@hotmail.com')
on conflict do nothing;


-- 4) Conferência: tem de voltar exatamente 1 linha, com o seu e-mail ---------
select u.email, p.criado_em
  from public.app_programmers p
  join auth.users u on u.id = p.user_id;


-- =============================================================================
-- DEPOIS DISTO
--   • Recarregue o app (Ctrl+F5) e volte à aba Programador.
--   • O aviso amarelo no topo tem de sumir. Se continuar, ele diz o que falta.
--
-- SOBRE CRIAR O USUÁRIO DO NOVO AMBIENTE
--   O gestor do novo ambiente precisa TER CONTA na nuvem antes de você criar o
--   ambiente para ele. Ele mesmo cria, no app: tela de entrada → "Criar conta".
--   Você também pode criá-la pelo painel do Supabase (Authentication → Users →
--   Add user).
--
--   O app NÃO cria conta para outra pessoa de propósito: isso exigiria a chave
--   de administrador do Supabase dentro do programa, e quem tivesse o app
--   teria o banco inteiro na mão.
-- =============================================================================
