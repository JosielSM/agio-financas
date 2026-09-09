# Publicação: Firebase Authentication + Supabase + Cloudflare

Para ativar cadastro, confirmação de e-mail e recuperação de senha pelo Firebase,
siga primeiro `FIREBASE_SETUP.md`. O Supabase continua como banco de dados e aplica
as regras de acesso usando o token Firebase.

## 1. Criar e proteger o banco

1. Crie uma conta em https://supabase.com e clique em **New project**.
2. Escolha nome, região, senha forte do banco e aguarde a criação.
3. Abra **SQL Editor** > **New query**, cole todo o arquivo `supabase-schema.sql` deste repositório e clique em **Run**.
4. Para uma instalação nova, execute `supabase-schema.sql`. Para atualizar a instalação existente sem apagar dados, execute `supabase-firebase-migration.sql` conforme `FIREBASE_SETUP.md`.

## 2. Conectar o site ao Supabase

1. Em **Project Settings** > **API**, copie a **Project URL** e a **Publishable key** (ou `anon` key).
2. Abra `supabase-config.js` e preencha `url` e `publishableKey`.
3. Nunca use nem publique a chave `service_role`: ela ignora as regras de segurança do banco.
4. O Supabase permanece responsável pelo PostgreSQL. A autenticação passa ao Firebase somente depois que `firebase-config.js` estiver preenchido; enquanto estiver vazio, o login Supabase atual permanece ativo durante a migração.

As políticas RLS comparam `owner_id` ao `sub` do token e fazem com que cada usuário autenticado só acesse as próprias linhas.

## 3. Publicar no Cloudflare Workers

1. No painel Cloudflare, abra **Workers & Pages** e selecione o Worker `agio-financas` já criado.
2. Abra **Settings** > **Builds** e confirme que o repositório GitHub está conectado à branch `main`.
3. Mantenha o comando de deploy como `npx wrangler deploy`.
4. A configuração `wrangler.jsonc` e `.assetsignore` deste repositório faz com que somente os arquivos do site sejam publicados; arquivos Git, SQL e documentação ficam fora do site público.
5. Faça um novo deploy ou aguarde o próximo push para `main`. A URL seguirá o formato `https://agio-financas.<sua-conta>.workers.dev`.
6. Volte à etapa 1.5 e cadastre exatamente essa URL no Supabase. A partir daí, todo push na branch `main` publicará a nova versão automaticamente.

## Checklist antes de uso real

- RLS ativo nas duas tabelas.
- Apenas a Publishable/anon key está no site.
- Confirmação de e-mail ativada.
- Senha forte para o projeto Supabase.
- Dados de teste conferidos em um segundo usuário: ele não deve enxergar os clientes do primeiro.

O envio automático de WhatsApp permanece fora desta versão. Ele exigirá uma API de servidor e credenciais próprias do WhatsApp Business.
