-- Totais do mês calculados sobre todos os pagamentos, não somente a amostra recente.
begin;

create or replace function public.admin_get_platform_billing_dashboard_v1()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id text := private.current_user_id();
  payment_rows jsonb;
  payment_totals jsonb;
begin
  if not private.is_platform_admin_id(actor_id) then
    raise exception 'Acesso administrativo negado';
  end if;

  select coalesce(jsonb_agg(row_payload order by sort_at desc), '[]'::jsonb)
  into payment_rows
  from (
    select
      coalesce(transaction_row.paid_at, transaction_row.created_at, payment_order.updated_at, payment_order.created_at) as sort_at,
      jsonb_build_object(
        'id', payment_order.id, 'userId', payment_order.user_id,
        'status', coalesce(transaction_row.status, payment_order.status),
        'mode', payment_order.payment_mode, 'planMonths', payment_order.plan_months,
        'monthlyFee', payment_order.monthly_fee,
        'amount', coalesce(transaction_row.amount, payment_order.amount),
        'currency', coalesce(transaction_row.currency, payment_order.currency),
        'paymentMethod', coalesce(transaction_row.payment_method, ''),
        'paymentType', coalesce(transaction_row.payment_type, ''),
        'paidAt', transaction_row.paid_at,
        'createdAt', payment_order.created_at,
        'updatedAt', greatest(payment_order.updated_at, coalesce(transaction_row.updated_at, payment_order.updated_at)),
        'accessGrantedAt', coalesce(transaction_row.access_granted_at, payment_order.access_granted_at),
        'failureReason', coalesce(payment_order.failure_reason, ''),
        'providerPaymentId', coalesce(transaction_row.provider_payment_id, ''),
        'liveMode', coalesce(transaction_row.live_mode, payment_order.live_mode)
      ) as row_payload
    from public.platform_payment_orders payment_order
    left join lateral (
      select payment_transaction.*
      from public.platform_payment_transactions payment_transaction
      where payment_transaction.order_id = payment_order.id
      order by coalesce(payment_transaction.paid_at, payment_transaction.created_at) desc,
        payment_transaction.id desc
      limit 1
    ) transaction_row on true
    order by sort_at desc
    limit 250
  ) recent_payments;

  select jsonb_build_object(
    'approvedCountMonth', count(*) filter (
      where payment.status = 'approved' and payment.live_mode = true
        and payment.access_granted_at is not null
        and date_trunc('month', timezone('America/Sao_Paulo', coalesce(payment.paid_at, payment.access_granted_at)))
          = date_trunc('month', timezone('America/Sao_Paulo', now()))
    ),
    'approvedAmountMonth', coalesce(sum(payment.amount) filter (
      where payment.status = 'approved' and payment.live_mode = true
        and payment.access_granted_at is not null
        and date_trunc('month', timezone('America/Sao_Paulo', coalesce(payment.paid_at, payment.access_granted_at)))
          = date_trunc('month', timezone('America/Sao_Paulo', now()))
    ), 0),
    'pendingCount', count(*) filter (
      where coalesce(payment.status, payment_order.status)
        in ('creating', 'pending', 'in_process', 'authorized')
    ),
    'failedCount', count(*) filter (
      where coalesce(payment.status, payment_order.status)
        in ('rejected', 'cancelled', 'refunded', 'charged_back', 'expired', 'error')
    )
  ) into payment_totals
  from public.platform_payment_orders payment_order
  left join lateral (
    select payment_transaction.*
    from public.platform_payment_transactions payment_transaction
    where payment_transaction.order_id = payment_order.id
    order by coalesce(payment_transaction.paid_at, payment_transaction.created_at) desc,
      payment_transaction.id desc
    limit 1
  ) payment on true;

  return jsonb_build_object('payments', payment_rows, 'totals', payment_totals);
end;
$$;

notify pgrst, 'reload schema';
commit;
