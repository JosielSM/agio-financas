# Mercado Pago no CredMais

O CredMais aceita duas modalidades sem armazenar dados bancários:

- pagamento avulso por PIX ou cartão para 1, 2, 3, 6 ou 12 meses;
- assinatura mensal recorrente no cartão.

A liberação nunca é feita pelo retorno visual do checkout. O Worker valida a
assinatura do webhook, consulta o pagamento diretamente na API do Mercado Pago e
só então pede ao banco para liberar o acesso. Eventos repetidos são idempotentes e
não adicionam meses novamente.

## 1. Aplicar o banco

Com o projeto correto vinculado ao Supabase:

```bash
npx supabase@2.117.0 db push --linked --include-all --skip-vault
```

A migração `20260914233000_mercado_pago_billing.sql` cria pedidos, transações e
assinaturas com RLS ativo. As funções que confirmam pagamentos são executáveis
somente pela função `service_role`; o navegador não tem permissão de escrita nessas
tabelas.

## 2. Criar a aplicação no Mercado Pago

No painel Mercado Pago Developers, crie uma aplicação para pagamentos on-line e
ative o Checkout Pro e Assinaturas. Comece com as credenciais de teste.

Cadastre este endereço em Webhooks:

```text
https://agio-financas.santosjosiel2003.workers.dev/api/webhooks/mercado-pago
```

Habilite notificações de pagamentos e de assinaturas. Copie o segredo de assinatura
do webhook da mesma aplicação/ambiente do Access Token.

## 3. Guardar os três segredos no Worker

Execute os comandos abaixo e cole cada valor somente no prompt protegido do
Wrangler. Eles não devem entrar em `wrangler.jsonc`, `.env`, conversa, print ou Git.

```bash
npx wrangler@4.131.2 secret put MERCADO_PAGO_ACCESS_TOKEN
npx wrangler@4.131.2 secret put MERCADO_PAGO_WEBHOOK_SECRET
npx wrangler@4.131.2 secret put SUPABASE_SERVICE_ROLE_KEY
```

Em `SUPABASE_SERVICE_ROLE_KEY`, use a chave secreta de servidor do projeto CredMais
em Supabase > Project Settings > API. Nunca use essa chave no navegador.

## 4. Testar antes de cobrar

O arquivo `wrangler.jsonc` começa com `MERCADO_PAGO_ENV` igual a `sandbox`.

1. Execute `npm run check`.
2. Publique com `npm run deploy:main`.
3. Entre com um usuário comum bloqueado.
4. Gere um checkout e pague com um comprador/cartão de teste do Mercado Pago.
5. No painel Mercado Pago, use a simulação de Webhook se o pagamento de teste não
   disparar uma notificação real.
6. Confirme que o acesso foi liberado uma única vez e que o registro apareceu no
   histórico administrativo.
7. Reenvie o mesmo webhook e confirme que a data não mudou novamente.
8. Teste pagamento rejeitado, pendente, estornado e assinatura cancelada.

## 5. Ativar produção

Somente depois dos testes:

1. substitua os dois segredos Mercado Pago pelas credenciais de produção;
2. confirme o segredo do Webhook de produção;
3. altere `MERCADO_PAGO_ENV` para `production` em `wrangler.jsonc`;
4. execute novamente `npm run check` e `npm run deploy:main`;
5. faça uma cobrança real de valor controlado e confira pagamento, liberação,
   histórico e estorno.

O preço mensal continua sendo configurado no painel administrativo. O Worker não
aceita valores enviados pelo navegador: ele sempre lê a mensalidade da conta no
banco e calcula o total no servidor. A liberação manual continua disponível para
dinheiro físico ou testes gratuitos.
