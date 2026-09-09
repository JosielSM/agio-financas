# Ativação do Firebase Authentication no CredMais

O código do aplicativo já está preparado para usar o Firebase em cadastro, login,
confirmação de e-mail, recuperação e troca de senha. Até a configuração abaixo ser
concluída, `firebase-config.js` permanece vazio e o login atual pelo Supabase continua
funcionando. Isso evita bloquear os usuários durante a migração.

## 1. Criar e conectar o aplicativo web

1. No Firebase Console, crie ou abra o projeto do CredMais.
2. Em **Configurações do projeto > Seus aplicativos**, registre um aplicativo Web.
3. Copie `apiKey`, `authDomain`, `projectId` e `appId` para `firebase-config.js`.
4. Em **Authentication > Sign-in method**, ative **E-mail/senha**.
5. Em **Authentication > Settings > Authorized domains**, adicione o domínio publicado
   do CredMais e, se necessário para testes, `localhost`.

Não coloque chave privada nem credencial do Firebase Admin no site. O objeto de
configuração Web é público por definição e o acesso real é protegido pelo Firebase,
pelas claims e pelas políticas RLS.

## 2. Preservar os clientes e empréstimos existentes

Antes de preencher `firebase-config.js`, execute uma vez o arquivo
`supabase-firebase-migration.sql` no **Supabase > SQL Editor**. Ele:

- mantém as linhas atuais;
- permite que `owner_id` receba UIDs do Firebase;
- atualiza as políticas para comparar o `sub` do token;
- cria `profiles`, onde ficam nome e dados PIX.

Contas antigas devem ser criadas no Firebase com o mesmo UID UUID que já possuíam no
Supabase. Se um usuário receber outro UID, ele será tratado corretamente como outra
conta e não enxergará os dados antigos. Nunca altere `owner_id` em massa sem uma cópia
de segurança e sem uma tabela de correspondência validada.

O utilitário `firebase/migration/migrate-users.js` faz essa importação mantendo o UID.
Ele precisa ser executado localmente por quem possui as credenciais administrativas:

1. Baixe uma conta de serviço do Firebase e aponte
   `GOOGLE_APPLICATION_CREDENTIALS` para o arquivo, sem copiá-lo para o repositório.
2. Defina `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` apenas no terminal local.
3. Entre em `firebase/migration`, execute `npm install` e depois `npm run migrate`.

A API administrativa do Supabase não entrega as senhas originais. Por isso o script
mantém usuário, nome, e-mail, confirmação e UID, mas cria uma senha aleatória. No
primeiro acesso, cada usuário deve clicar em **Esqueci minha senha** para escolher uma
nova senha pelo e-mail do CredMais.

## 3. Permitir que o token Firebase consulte o Supabase

1. Em **Supabase > Authentication > Third-party Auth**, adicione **Firebase** e informe
   exatamente o `projectId` do Firebase.
2. O token precisa da claim `role: "authenticated"`. O projeto contém as funções em
   `firebase/functions/index.js` para adicioná-la antes do cadastro e de cada login.
3. Ative **Firebase Authentication with Identity Platform**, necessário para as
   blocking functions.
4. Na raiz do repositório, associe o projeto e publique as funções:

   ```text
   firebase use SEU_PROJECT_ID
   cd firebase/functions
   npm install
   cd ../..
   firebase deploy --only functions
   ```

5. Só depois disso preencha e publique `firebase-config.js`.

## 4. E-mails com o nome CredMais

Em **Firebase > Authentication > Templates**, edite pelo menos **Verificação de
endereço de e-mail** e **Redefinição de senha**.

Use os seguintes dados:

- Nome público do projeto: `CredMais`
- Nome do remetente: `CredMais`
- Assunto de confirmação: `Confirme seu e-mail no CredMais`
- Assunto de recuperação: `Redefina sua senha do CredMais`
- Idioma padrão do modelo: português do Brasil
- URL personalizada da ação: `https://SEU-DOMINIO/auth-action.html`

Texto sugerido para confirmação:

> Olá! Confirme seu endereço de e-mail para ativar sua conta CredMais. Por segurança,
> este link é individual e possui prazo de validade. Se você não criou esta conta,
> ignore esta mensagem.

Texto sugerido para recuperação:

> Recebemos uma solicitação para redefinir a senha da sua conta CredMais. Use o link
> abaixo para criar uma nova senha. Se não foi você, ignore esta mensagem e sua senha
> continuará a mesma.

A tela aberta pelo link já usa logotipo, cores, textos e modo responsivo do CredMais.
Os modelos nativos do Firebase permitem personalizar remetente, assunto, texto e
domínio, mas não oferecem liberdade total para montar um e-mail HTML com qualquer
layout. Para um e-mail inteiramente desenhado (logo grande, cards e rodapé próprio),
será necessário gerar o link com Firebase Admin em um backend e enviá-lo por um
serviço de e-mail/SMTP.

## 5. Remetente e links com domínio próprio

Em cada modelo, escolha **Customize domain** e informe o domínio do CredMais. Adicione
no provedor do domínio os registros TXT/CNAME mostrados pelo Firebase e espere a
validação. Depois clique em **Apply Custom Domain**. Isso faz o remetente e o link de
autenticação exibirem o domínio da marca em vez do domínio padrão do Firebase.

## Checklist de ativação

- Faça backup do Supabase.
- Execute `supabase-firebase-migration.sql`.
- Migre os usuários existentes mantendo o mesmo UID.
- Ative E-mail/senha e os domínios autorizados no Firebase.
- Cadastre o Firebase em Third-party Auth no Supabase.
- Publique as funções que definem `role: authenticated`.
- Personalize os dois modelos e a URL `auth-action.html`.
- Preencha `firebase-config.js`, publique e teste com uma conta sem dados.
- Teste isolamento com duas contas: nenhuma pode enxergar dados da outra.
