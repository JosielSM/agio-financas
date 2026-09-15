-- Desativa definitivamente o PIX manual da assinatura da plataforma.
-- O PIX particular de cada usuário para cobrar seus próprios clientes fica intacto.

begin;

update public.platform_settings set
  billing_recipient = '',
  billing_pix_key = '',
  billing_pix_type = 'Chave aleatória',
  billing_message = case
    when billing_message ~* '(\{pix\}|\{recebedor\}|chave[[:space:]]+pix|envie[[:space:]]+o[[:space:]]+comprovante)'
      then E'Olá, *{nome}*! 👋\n\n💎 *CREDMAIS PREMIUM*\n━━━━━━━━━━━━━━━━\n💳 Mensalidade: *{valor}*\n📅 Vencimento: *{vencimento}*\n\n⚡ *PAGAMENTO AUTOMÁTICO*\nEntre na sua conta do CredMais, escolha o período e toque em *Pagar agora*. O pagamento é feito no ambiente seguro do Mercado Pago.\n\n✅ Assim que o Mercado Pago confirmar, seu acesso será liberado automaticamente. Não é necessário enviar comprovante.\n\nAtenciosamente,\n*CredMais*'
    else billing_message
  end,
  updated_at = now()
where id = 1;

notify pgrst, 'reload schema';
commit;
