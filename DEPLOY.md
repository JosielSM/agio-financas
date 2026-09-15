# Publicação segura do CredMais

O CredMais usa Firebase Authentication, PostgreSQL/Supabase e dois Workers Cloudflare
independentes. O aplicativo dos clientes e o painel administrativo não compartilham
arquivos, cache, manifesto ou escopo de PWA.

## 1. Banco de dados

Para a instalação de produção existente, use as migrações versionadas da pasta
`supabase/migrations`. Os arquivos SQL antigos na raiz permanecem no repositório
apenas como histórico e não devem ser reaplicados manualmente.

Antes de executar:

1. Crie um backup ou snapshot do banco no painel Supabase.
2. Confirme que o projeto selecionado é o CredMais.
3. Execute `npx supabase@2.117.0 db push --linked --include-all --skip-vault`.
   A migração usa transação e aborta integralmente se alguma validação falhar.
4. Execute `npx supabase@2.117.0 db query --linked --file
   supabase-production-verification.sql` e confirme o resultado
   `credmais_production_database_verified`.

A migração mantém os dados existentes e aplica, entre outras proteções:

- vínculo composto entre empréstimo, cliente e proprietário;
- RLS apenas para leitura das próprias linhas;
- escrita financeira exclusivamente por funções transacionais validadas;
- bloqueio de alterações financeiras quando a assinatura não está ativa;
- auditoria imutável das alterações de clientes, empréstimos e perfil;
- operações administrativas auditadas;
- desativação definitiva da função pública de criação do primeiro administrador;
- `search_path` seguro nas funções privilegiadas e privilégios mínimos.

Nunca coloque a chave `service_role`, senha do banco, token administrativo ou segredo
de pagamento no navegador, no Git ou em variável pública. O frontend utiliza somente
a URL e a chave pública existentes em `supabase-config.js`.

## 2. Autenticação Firebase

Siga `FIREBASE_SETUP.md`. O Supabase valida o token Firebase e usa o `sub` como
identidade do proprietário. Cadastro, confirmação de e-mail, login Google e
recuperação de senha permanecem no Firebase.

Contas autenticadas podem visualizar o aplicativo, mas qualquer cadastro, edição,
pagamento, empréstimo, exclusão ou sincronização exige assinatura ativa verificada
novamente no servidor. O modo offline nunca concede acesso de escrita.

## 3. Build e testes

Requer Node.js 20 ou superior:

```bash
npm run check
```

O comando executa o build isolado e os testes de segurança. Os artefatos são criados
em `dist/main` e `dist/admin`; SQL, documentação e código administrativo não são
publicados no aplicativo dos clientes.

Depois do deploy, execute também:

```bash
npm run verify:production
npm run verify:database-public
npm run verify:auth-boundary
npm run verify:access-control
```

O teste de autenticação cria e apaga automaticamente uma conta temporária. O teste de
liberação roda dentro de uma transação encerrada com `ROLLBACK`, sem preservar os dados
simulados.

## 4. Deploy dos dois aplicativos

Aplicativo dos clientes:

```bash
npm run deploy:main
```

Painel do proprietário:

```bash
npm run deploy:admin
```

O Worker atende primeiro todas as requisições e adiciona CSP, HSTS, proteção contra
MIME sniffing, enquadramento e permissões desnecessárias. Rotas `/api/*` desconhecidas
falham fechadas; POST em arquivos estáticos é recusado.

Produção atual:

- Clientes: `https://agio-financas.santosjosiel2003.workers.dev/`
- Administração: `https://credmais-controle.santosjosiel2003.workers.dev/admin/`

Cadastre ambos os domínios no Firebase Authentication. Cada Worker possui manifesto,
service worker, nome e escopo próprios, permitindo instalar os dois PWAs no mesmo
celular sem conflito.

## 5. Administração de assinaturas

Somente uma conta já registrada como administradora no banco consegue entrar no
painel. Não existe cadastro ou código de bootstrap pelo site público. A criação ou
recuperação de outro administrador deve ser feita diretamente no banco por uma pessoa
autorizada, com registro operacional.

O painel permite liberar 15 dias, períodos mensais, acesso gratuito, pago ou vitalício,
bloquear e renovar contas. Toda mudança crítica passa por uma função administrativa,
valida o administrador no servidor e grava auditoria. O vencimento é calculado a partir
da data atual para a nova concessão; meses não são somados silenciosamente ao prazo
anterior.

Esta versão mantém a confirmação e liberação administrativa e também aceita
pagamento automático pelo Mercado Pago. A integração usa API de servidor, webhook
assinado e idempotência; consulte `MERCADO_PAGO_SETUP.md` antes de habilitar as
credenciais reais.

## Checklist de entrada em produção

- `npm run check` sem falhas.
- Migração de produção aplicada e validada no projeto correto.
- Conta proprietária existente e login administrativo testado.
- Dois usuários de teste não conseguem ler nem alterar dados um do outro.
- Usuário pendente visualiza o sistema, mas não consegue gravar alterações.
- Usuário ativo cadastra cliente e empréstimo sem duplicação.
- Usuário vencido é bloqueado pelo banco e o painel registra o estado.
- Login Google, confirmação de e-mail e recuperação de senha testados.
- Logout remove dados financeiros locais e o modo offline não permite escrita.
- Os dois PWAs instalam separadamente em Android e iPhone.
- Cabeçalhos de segurança e `/api/health` conferidos nas duas URLs.
- Mercado Pago testado em sandbox, inclusive webhook repetido, rejeição e estorno.
- Chaves Mercado Pago e Supabase `service_role` presentes apenas nos Secrets do Worker.
- Backup, política de privacidade, termos de uso, canal de suporte e rotina de incidentes
  definidos antes de cobrar clientes reais.
