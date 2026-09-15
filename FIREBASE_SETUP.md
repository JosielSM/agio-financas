# Firebase Authentication do CredMais

## Produção

- Projeto Firebase: `credmais-2ded3`
- Aplicativo web: `CredMais Web`
- Provedores: e-mail/senha e Google
- Idioma dos e-mails: português do Brasil
- Dados financeiros: PostgreSQL/Supabase
- Autenticação: Firebase Authentication

`firebase-config.js` contém apenas identificadores públicos do aplicativo Web. Chaves
privadas, credenciais de conta de serviço e tokens administrativos nunca podem ser
incluídos no repositório ou enviados ao navegador.

## Domínios autorizados

Mantenha autorizados no Firebase Authentication:

- `agio-financas.santosjosiel2003.workers.dev`
- `credmais-controle.santosjosiel2003.workers.dev`

Adicione futuros domínios personalizados antes da troca de URL. Não autorize curingas
nem domínios que não sejam controlados pelo proprietário.

## Senhas e provedores

A política de produção exige no mínimo 10 caracteres, letra maiúscula, letra minúscula
e número. A política está em modo de aplicação, incluindo atualização no próximo login
para credenciais antigas que não atendam aos requisitos.

O aplicativo oferece:

- criação de conta com confirmação de e-mail;
- login por e-mail e senha;
- recuperação segura por e-mail;
- login com Google;
- indicação no perfil de quais provedores estão vinculados;
- alteração de senha para contas que usam senha.

O login Google só leva à conta financeira correta quando o Firebase resolve a mesma
identidade/UID. Nunca tente associar dados apenas comparando um e-mail recebido do
navegador.

## Integração com o Supabase

O projeto Firebase está cadastrado em **Authentication > Third-Party Auth** do
Supabase. Tokens Firebase sem a claim `role` chegam ao PostgREST como `anon`; por isso,
as funções e políticas não confiam no papel isoladamente. Elas exigem o `sub` válido do
token e comparam esse UID ao `owner_id`.

Aplique `supabase/migrations/20260914214500_production_hardening.sql` pelo Supabase CLI
antes de publicar esta versão. Ela substitui as migrações de autenticação, integridade
e assinatura anteriores para a instalação já existente.

As contas importadas preservam o UID, mas senhas antigas não são transferíveis. Esses
usuários devem usar **Esqueci minha senha** ou entrar com um provedor Google já vinculado.

## E-mails

Os modelos nativos usam português do Brasil. Personalização completa do remetente,
domínio, assunto e identidade visual depende dos recursos liberados pelo Firebase ou de
um serviço transacional próprio. Não use uma solução no frontend que exponha segredo de
SMTP ou conta de serviço.

## Verificação antes de publicar

1. Confirme que `firebase-config.js` aponta para `credmais-2ded3`.
2. Confira os dois domínios de produção autorizados.
3. Teste cadastro e confirmação com um endereço controlado.
4. Teste **Esqueci minha senha** e confirme o retorno ao domínio CredMais.
5. Teste login Google novo e login Google de uma conta já vinculada.
6. Confirme que e-mail não verificado não obtém privilégios indevidos.
7. Faça logout e verifique que os dados financeiros locais foram removidos.
8. Teste isolamento com duas contas: nenhuma pode acessar dados da outra.
