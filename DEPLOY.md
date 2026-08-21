# Publicação: Supabase + Cloudflare Pages

## 1. Criar e proteger o banco

1. Crie uma conta em https://supabase.com e clique em **New project**.
2. Escolha nome, região, senha forte do banco e aguarde a criação.
3. Abra **SQL Editor** > **New query**, cole todo o arquivo `supabase-schema.sql` deste repositório e clique em **Run**.
4. Em **Authentication** > **Providers** > **Email**, mantenha o provedor Email ativo. Para testes rápidos, você pode desativar temporariamente **Confirm email**. Antes de atender usuários reais, ative a confirmação novamente.
5. Em **Authentication** > **URL Configuration**, informe a URL final do Cloudflare Pages em **Site URL** e adicione-a em **Redirect URLs**.

## 2. Conectar o site ao Supabase

1. Em **Project Settings** > **API**, copie a **Project URL** e a **Publishable key** (ou `anon` key).
2. Abra `supabase-config.js` e preencha `url` e `publishableKey`.
3. Nunca use nem publique a chave `service_role`: ela ignora as regras de segurança do banco.
4. Faça commit e push. Ao detectar os dois valores, o site passa a usar Supabase Auth e PostgreSQL; com valores vazios, continua em modo local de demonstração.

As políticas RLS do arquivo SQL fazem com que cada usuário autenticado só acesse linhas cujo `owner_id` é o seu próprio usuário.

## 3. Publicar no Cloudflare Pages

1. No painel Cloudflare, abra **Workers & Pages** > **Create application** > **Pages** > **Connect to Git**.
2. Autorize o GitHub e escolha o repositório `JosielSM/agio-financas`.
3. Selecione a branch de produção `main`.
4. Use **Framework preset: None**, **Build command: `exit 0`** e **Build output directory: `.`**.
5. Clique em **Save and Deploy**. A Cloudflare fornecerá uma URL `https://<nome>.pages.dev`.
6. Volte à etapa 1.5 e cadastre exatamente essa URL no Supabase. A partir daí, todo push na branch `main` publica uma nova versão automaticamente.

## Checklist antes de uso real

- RLS ativo nas duas tabelas.
- Apenas a Publishable/anon key está no site.
- Confirmação de e-mail ativada.
- Senha forte para o projeto Supabase.
- Dados de teste conferidos em um segundo usuário: ele não deve enxergar os clientes do primeiro.

O envio automático de WhatsApp permanece fora desta versão. Ele exigirá uma API de servidor e credenciais próprias do WhatsApp Business.
