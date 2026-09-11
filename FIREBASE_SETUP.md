# Firebase Authentication do CredMais

Configuração de produção concluída em 10/09/2026.

## Produção

- Firebase: `credmais-2ded3`
- Aplicativo web: `CredMais Web`
- Domínio autorizado: `agio-financas.santosjosiel2003.workers.dev`
- Provedores: e-mail/senha e Google
- Idioma dos e-mails: português do Brasil
- Plano Firebase: Spark, sem faturamento
- Dados financeiros: PostgreSQL do Supabase
- Autenticação: Firebase Authentication

`firebase-config.js` contém somente os identificadores públicos do aplicativo
Web. Nunca coloque credenciais administrativas ou chaves privadas no repositório.

## Integração com o Supabase

O projeto Firebase está cadastrado em **Authentication > Third-Party Auth** do
Supabase. Tokens Firebase sem a claim `role` são executados pelo PostgREST como
`anon`; as políticas RLS permitem esse papel, mas exigem que `owner_id` seja
exatamente igual ao `sub` autenticado do token. Uma chamada feita apenas com a
chave pública do projeto não possui esse UID e não acessa nenhuma linha.

A migração `supabase-firebase-migration.sql`:

- converte `owner_id` para texto sem trocar os valores;
- cria `activity_history` e `profiles` quando necessário;
- mantém clientes e empréstimos vinculados aos UIDs existentes;
- torna atômica a exclusão de clientes e empréstimos relacionados;
- recria as políticas RLS para Firebase e Supabase Auth.

As cinco contas antigas foram importadas no Firebase com o mesmo UID. Como as
senhas não podem ser transferidas pela API administrativa do Supabase, esses
usuários devem usar **Esqueci minha senha** no primeiro acesso.

O aplicativo também oferece **Continuar com Google**. Ao usar a mesma conta
Google do cadastro existente, o Firebase preserva a identidade e o vínculo com
os clientes e empréstimos desse UID.

## E-mails

O idioma padrão foi salvo como português do Brasil. O projeto Firebase aceitou
o domínio do aplicativo, mas informou no Console que alterações manuais do nome
do remetente, assunto e URL de ação não estão disponíveis para este projeto e
devem ser tratadas pelo Suporte do Firebase. Enquanto essa restrição existir, os
e-mails usam o modelo padrão em português e o manipulador seguro do Firebase,
que retorna ao domínio autorizado do CredMais ao concluir a ação.

## Verificação

Antes de uma publicação:

1. confirme que `firebase-config.js` aponta para `credmais-2ded3`;
2. confirme que o domínio de produção segue autorizado no Firebase;
3. teste recuperação de senha com uma conta controlada;
4. teste isolamento com duas contas: nenhuma pode enxergar dados da outra;
5. altere a versão de cache em `sw.js` quando houver mudança no aplicativo.
