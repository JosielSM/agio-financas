# Publicação: Firebase Authentication + Supabase + Cloudflare

Para ativar cadastro, confirmação de e-mail e recuperação de senha pelo Firebase,
siga primeiro `FIREBASE_SETUP.md`. O Supabase continua como banco de dados e aplica
as regras de acesso usando o token Firebase.

## 1. Criar e proteger o banco

1. Crie uma conta em https://supabase.com e clique em **New project**.
2. Escolha nome, região, senha forte do banco e aguarde a criação.
3. Abra **SQL Editor** > **New query**, cole todo o arquivo `supabase-schema.sql` deste repositório e clique em **Run**.
4. Para uma instalação nova, execute `supabase-schema.sql`. Para atualizar a instalação existente sem apagar dados, execute `supabase-firebase-migration.sql` conforme `FIREBASE_SETUP.md`.
5. Em uma instalação nova, execute `supabase-admin-migration.sql` para criar o painel do proprietário, as assinaturas, os testes gratuitos e o bloqueio de acesso no próprio banco. Essa migração preserva os dados financeiros e concede 30 dias às contas já existentes.
6. Em uma instalação que já possui o painel, execute somente `supabase-access-integrity-migration.sql`. Essa migração transacional e repetível instala qualquer coluna ausente, atualiza as funções de liberação e valida a proteção RLS sem apagar contas, vencimentos ou históricos.
7. Os arquivos `supabase-auto-expiry-migration.sql`, `supabase-reset-renewal-date-migration.sql` e `supabase-trial-access-migration.sql` permanecem apenas para registrar as atualizações antigas. Não é necessário executá-los depois da migração de integridade.

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

## Painel do proprietário

O painel administrativo fica em `/admin/` na mesma URL publicada e também pode ser
instalado como PWA. No primeiro acesso, crie ou entre em uma conta Firebase e use o
código único de ativação entregue fora do repositório. Somente a primeira conta que
confirmar esse código se torna proprietária; depois disso, o código é inutilizado.

No painel é possível configurar a mensalidade e o PIX, acompanhar contas pendentes,
ativas, vencidas e bloqueadas, liberar períodos de 1 a 12 meses e gerar mensagens de
cobrança para copiar ou abrir no WhatsApp. Para colaboradores, escolha **Vitalício —
colaborador**: a conta fica sem vencimento, sem mensalidade e fora da receita prevista.
No primeiro carregamento após um vencimento, o painel registra o bloqueio automático no
histórico e mostra um aviso persistente com os usuários que precisam renovar.

Para evitar conflito entre os dois PWAs, publique também o painel em um Worker separado:

```bash
npx wrangler deploy -c wrangler.admin.jsonc
```

O CredMais dos clientes continua no Worker `agio-financas`; o painel instalável usa o
Worker `credmais-controle`. Cadastre o domínio `credmais-controle.santosjosiel2003.workers.dev`
nos domínios autorizados do Firebase para permitir login Google e recuperação de senha.

## Modo de visualização sem assinatura

Toda conta autenticada entra no painel completo. Contas pendentes, vencidas ou bloqueadas
podem navegar e consultar seus próprios dados, mas cadastro, cobrança, empréstimos,
pagamentos, edições, relatórios e exclusões exigem acesso ativo. Execute também
`supabase-read-only-access-migration.sql` para separar no banco as permissões de leitura e
escrita; assim, a proteção não depende apenas dos botões da interface.

## Checklist antes de uso real

- RLS ativo nas duas tabelas.
- Apenas a Publishable/anon key está no site.
- Confirmação de e-mail ativada.
- Senha forte para o projeto Supabase.
- Dados de teste conferidos em um segundo usuário: ele não deve enxergar os clientes do primeiro.
- Conta proprietária ativada em `/admin/` e não contabilizada como cliente pagante.
- Conta de teste pendente até a liberação e bloqueada novamente após o vencimento.

O envio automático de WhatsApp permanece fora desta versão. Ele exigirá uma API de servidor e credenciais próprias do WhatsApp Business.
