const MERCADO_PAGO_API = "https://api.mercadopago.com";
const CHECKOUT_PLANS = Object.freeze([1, 2, 3, 6, 12]);
const USER_BODY_LIMIT = 8 * 1024;
const WEBHOOK_BODY_LIMIT = 32 * 1024;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function isProduction(env) {
  return String(env.MERCADO_PAGO_ENV || "sandbox").toLowerCase() === "production";
}

function validMercadoAccessToken(env) {
  const token = String(env.MERCADO_PAGO_ACCESS_TOKEN || "").trim();
  if (!/^[\x21-\x7e]{10,}$/.test(token)) return false;
  return isProduction(env) ? token.startsWith("APP_USR-") : token.startsWith("TEST-");
}

function billingConfigured(env) {
  return Boolean(
    env.SUPABASE_URL &&
      env.SUPABASE_PUBLISHABLE_KEY &&
      env.SUPABASE_SERVICE_ROLE_KEY &&
      validMercadoAccessToken(env) &&
      env.MERCADO_PAGO_WEBHOOK_SECRET &&
      env.APP_ORIGIN,
  );
}

function methodNotAllowed(allow) {
  return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405, {
    Allow: allow,
  });
}

async function readBoundedJson(request, maxBytes) {
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > maxBytes) {
    throw new HttpError(413, "BODY_TOO_LARGE", "A solicitação é muito grande.");
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > maxBytes) {
    throw new HttpError(413, "BODY_TOO_LARGE", "A solicitação é muito grande.");
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Os dados enviados são inválidos.");
  }
}

function bearerToken(request) {
  const authorization = request.headers.get("authorization") || "";
  if (!authorization.startsWith("Bearer ") || authorization.length < 20) {
    throw new HttpError(401, "AUTH_REQUIRED", "Entre novamente para continuar.");
  }
  return authorization.slice(7).trim();
}

function supabaseBaseUrl(env) {
  try {
    const url = new URL(env.SUPABASE_URL);
    if (url.protocol !== "https:") throw new Error("protocol");
    return url.origin;
  } catch {
    throw new HttpError(503, "BILLING_NOT_CONFIGURED", "Pagamento indisponível.");
  }
}

async function supabaseRpc(env, functionName, body, options = {}) {
  const service = Boolean(options.service);
  const apiKey = service
    ? env.SUPABASE_SERVICE_ROLE_KEY
    : env.SUPABASE_PUBLISHABLE_KEY;
  const authorization = service ? apiKey : options.accessToken;
  if (!apiKey || !authorization) {
    throw new HttpError(503, "BILLING_NOT_CONFIGURED", "Pagamento indisponível.");
  }
  const response = await fetch(
    `${supabaseBaseUrl(env)}/rest/v1/rpc/${encodeURIComponent(functionName)}`,
    {
      method: "POST",
      headers: {
        apikey: apiKey,
        Authorization: `Bearer ${authorization}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body || {}),
    },
  );
  const responseText = await response.text();
  let responseBody = null;
  try {
    responseBody = responseText ? JSON.parse(responseText) : null;
  } catch {
    responseBody = null;
  }
  if (!response.ok) {
    console.error(
      JSON.stringify({
        message: "supabase_rpc_failed",
        rpc: functionName,
        status: response.status,
        code: responseBody?.code || "UNKNOWN",
      }),
    );
    if (!service && response.status === 401) {
      throw new HttpError(401, "AUTH_EXPIRED", "Sua sessão expirou. Entre novamente.");
    }
    throw new HttpError(
      response.status >= 500 ? 503 : 400,
      "PAYMENT_REQUEST_FAILED",
      service
        ? "Não foi possível confirmar o pagamento agora."
        : responseBody?.message || "Não foi possível iniciar o pagamento.",
    );
  }
  return responseBody;
}

async function mercadoRequest(env, pathname, options = {}) {
  const response = await fetch(`${MERCADO_PAGO_API}${pathname}`, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${env.MERCADO_PAGO_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
      ...(options.idempotencyKey
        ? { "X-Idempotency-Key": options.idempotencyKey }
        : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const responseText = await response.text();
  let responseBody = null;
  try {
    responseBody = responseText ? JSON.parse(responseText) : null;
  } catch {
    responseBody = null;
  }
  if (!response.ok) {
    const causes = Array.isArray(responseBody?.cause)
      ? responseBody.cause
          .map((cause) => String(cause?.code || cause?.description || "").slice(0, 120))
          .filter(Boolean)
          .slice(0, 3)
      : [];
    const providerError = String(
      responseBody?.error || responseBody?.code || causes[0] || "UNKNOWN",
    ).slice(0, 120);
    const providerMessage = String(responseBody?.message || responseText || "")
      .replace(/[\r\n\t]+/g, " ")
      .slice(0, 240);
    console.error(
      JSON.stringify({
        message: "mercado_pago_request_failed",
        path: pathname,
        status: response.status,
        providerError,
        providerMessage,
        causes,
        providerContentType: String(response.headers.get("content-type") || "").slice(0, 80),
        providerRequestId: String(
          response.headers.get("x-request-id") ||
            response.headers.get("x-correlation-id") ||
            "",
        ).slice(0, 120),
      }),
    );
    if (response.status === 401) {
      throw new HttpError(
        503,
        "MERCADO_PAGO_INVALID_CREDENTIAL",
        "A credencial de produção do Mercado Pago precisa ser atualizada pelo administrador.",
      );
    }
    if (response.status === 403) {
      throw new HttpError(
        503,
        "MERCADO_PAGO_NOT_AUTHORIZED",
        "O Mercado Pago ainda não autorizou esta aplicação a criar cobranças reais. O administrador já foi informado.",
      );
    }
    throw new HttpError(
      response.status >= 500 ? 503 : 400,
      "MERCADO_PAGO_ERROR",
      "O Mercado Pago não conseguiu criar ou consultar o pagamento.",
    );
  }
  return responseBody;
}

function applicationOrigin(env) {
  try {
    const origin = new URL(env.APP_ORIGIN);
    if (origin.protocol !== "https:") throw new Error("protocol");
    return origin.origin;
  } catch {
    throw new HttpError(503, "BILLING_NOT_CONFIGURED", "Endereço do aplicativo inválido.");
  }
}

function validCheckoutUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "mercadopago.com" ||
        url.hostname.endsWith(".mercadopago.com") ||
        url.hostname === "mercadopago.com.br" ||
        url.hostname.endsWith(".mercadopago.com.br"))
    );
  } catch {
    return false;
  }
}

function selectCheckoutUrl(order, production) {
  const selected = production
    ? order.checkoutUrl
    : order.sandboxCheckoutUrl || order.checkoutUrl;
  if (!validCheckoutUrl(selected)) {
    throw new HttpError(502, "INVALID_CHECKOUT_URL", "Checkout inválido.");
  }
  return selected;
}

async function createOneTimeCheckout(env, order) {
  const origin = applicationOrigin(env);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const preference = await mercadoRequest(env, "/checkout/preferences", {
    method: "POST",
    idempotencyKey: order.requestKey,
    body: {
      items: [
        {
          id: `credmais-${order.planMonths}m`,
          title: `CredMais Premium - ${order.planMonths} ${order.planMonths === 1 ? "mês" : "meses"}`,
          description: "Acesso completo à plataforma CredMais",
          quantity: 1,
          currency_id: "BRL",
          unit_price: Number(order.amount),
        },
      ],
      payer: {
        email: order.email,
        name: order.name || undefined,
      },
      external_reference: order.orderId,
      statement_descriptor: "CREDMAIS",
      back_urls: {
        success: `${origin}/?pagamento=sucesso`,
        pending: `${origin}/?pagamento=pendente`,
        failure: `${origin}/?pagamento=falha`,
      },
      auto_return: "approved",
      notification_url: `${origin}/api/webhooks/mercado-pago`,
      expires: true,
      expiration_date_from: new Date().toISOString(),
      expiration_date_to: expiresAt.toISOString(),
      payment_methods: {
        excluded_payment_types: [{ id: "ticket" }],
        installments: 12,
      },
    },
  });
  return {
    reference: String(preference.id || ""),
    checkoutUrl: preference.init_point,
    sandboxCheckoutUrl: preference.sandbox_init_point || "",
    expiresAt: expiresAt.toISOString(),
  };
}

async function checkout(request, env) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  if (!billingConfigured(env)) {
    return json(
      {
        ok: false,
        error: "BILLING_NOT_CONFIGURED",
        message: "O pagamento pelo Mercado Pago está temporariamente indisponível. Tente novamente em alguns instantes.",
      },
      503,
    );
  }
  const accessToken = bearerToken(request);
  const body = await readBoundedJson(request, USER_BODY_LIMIT);
  if (!body || Array.isArray(body) || typeof body !== "object") {
    throw new HttpError(400, "INVALID_REQUEST", "Os dados enviados são inválidos.");
  }
  if (body.mode !== "one_time") {
    throw new HttpError(
      400,
      "INVALID_PAYMENT_MODE",
      "Use o pagamento único por Pix ou cartão.",
    );
  }
  const months = Number(body.months);
  if (!CHECKOUT_PLANS.includes(months)) {
    throw new HttpError(400, "INVALID_PLAN", "Escolha um período de pagamento válido.");
  }

  const order = await supabaseRpc(
    env,
    "create_platform_payment_order_v1",
    { p_plan_months: months, p_payment_mode: "one_time" },
    { accessToken },
  );
  if (order.processing) {
    throw new HttpError(
      409,
      "CHECKOUT_INITIALIZING",
      "Seu checkout já está sendo preparado. Aguarde alguns segundos e tente novamente.",
    );
  }
  if (order.checkoutUrl) {
    return json({
      ok: true,
      orderId: order.orderId,
      checkoutUrl: selectCheckoutUrl(order, isProduction(env)),
      reused: true,
    });
  }

  try {
    const created = await createOneTimeCheckout(env, order);
    if (!created.reference || !validCheckoutUrl(created.checkoutUrl)) {
      throw new HttpError(502, "INVALID_PROVIDER_RESPONSE", "Checkout inválido.");
    }
    await supabaseRpc(
      env,
      "system_attach_mercado_checkout_v1",
      {
        p_order_id: order.orderId,
        p_provider_reference: created.reference,
        p_checkout_url: created.checkoutUrl,
        p_sandbox_checkout_url: created.sandboxCheckoutUrl,
        p_expires_at: created.expiresAt,
        p_live_mode: isProduction(env),
      },
      { service: true },
    );
    return json({
      ok: true,
      orderId: order.orderId,
      checkoutUrl: selectCheckoutUrl(
        {
          checkoutUrl: created.checkoutUrl,
          sandboxCheckoutUrl: created.sandboxCheckoutUrl,
        },
        isProduction(env),
      ),
      reused: false,
    });
  } catch (error) {
    await supabaseRpc(
      env,
      "system_mark_mercado_checkout_error_v1",
      {
        p_order_id: order.orderId,
        p_reason: error?.code || "CHECKOUT_CREATION_FAILED",
      },
      { service: true },
    ).catch(() => undefined);
    throw error;
  }
}

function parseSignature(header) {
  const values = {};
  for (const part of String(header || "").split(",")) {
    const separator = part.indexOf("=");
    if (separator > 0) {
      values[part.slice(0, separator).trim()] = part.slice(separator + 1).trim();
    }
  }
  return values;
}

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function createMercadoSignature(secret, manifest) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToHex(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(manifest)),
  );
}

function constantTimeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function validateMercadoSignature(request, secret, dataId) {
  const parsed = parseSignature(request.headers.get("x-signature"));
  const requestId = request.headers.get("x-request-id") || "";
  if (!parsed.ts || !parsed.v1 || !/^\d+$/.test(parsed.ts)) return false;
  const normalizedId = String(dataId || "").toLowerCase();
  const manifest = [
    normalizedId ? `id:${normalizedId};` : "",
    requestId ? `request-id:${requestId};` : "",
    `ts:${parsed.ts};`,
  ].join("");
  const expected = await createMercadoSignature(secret, manifest);
  return constantTimeEqual(expected, parsed.v1.toLowerCase());
}

function normalizePaymentStatus(status) {
  const value = String(status || "").toLowerCase();
  return [
    "pending",
    "in_process",
    "authorized",
    "approved",
    "rejected",
    "cancelled",
    "refunded",
    "charged_back",
  ].includes(value)
    ? value
    : null;
}

function normalizeSubscriptionStatus(status) {
  const value = String(status || "").toLowerCase();
  if (value === "canceled") return "cancelled";
  return ["pending", "authorized", "paused", "cancelled"].includes(value)
    ? value
    : null;
}

async function processPaymentWebhook(env, dataId) {
  const payment = await mercadoRequest(env, `/v1/payments/${encodeURIComponent(dataId)}`);
  const status = normalizePaymentStatus(payment.status);
  const externalReference = String(payment.external_reference || "");
  if (!status || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(externalReference)) {
    return { accepted: false, reason: "UNSUPPORTED_PAYMENT" };
  }
  return supabaseRpc(
    env,
    "system_process_mercado_payment_v1",
    {
      p_external_reference: externalReference,
      p_provider_payment_id: String(payment.id),
      p_status: status,
      p_amount: payment.transaction_amount,
      p_currency: payment.currency_id,
      p_payment_method: payment.payment_method_id || "",
      p_payment_type: payment.payment_type_id || "",
      p_paid_at: payment.date_approved || null,
      p_live_mode: Boolean(payment.live_mode),
      p_details: {
        statusDetail: String(payment.status_detail || "").slice(0, 120),
        installments: Number(payment.installments || 0),
      },
    },
    { service: true },
  );
}

async function processSubscriptionWebhook(env, dataId) {
  const subscription = await mercadoRequest(
    env,
    `/preapproval/${encodeURIComponent(dataId)}`,
  );
  const status = normalizeSubscriptionStatus(subscription.status);
  const externalReference = String(subscription.external_reference || "");
  if (!status || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(externalReference)) {
    return { accepted: false, reason: "UNSUPPORTED_SUBSCRIPTION" };
  }
  return supabaseRpc(
    env,
    "system_sync_mercado_subscription_v1",
    {
      p_external_reference: externalReference,
      p_provider_subscription_id: String(subscription.id),
      p_status: status,
      p_amount: subscription.auto_recurring?.transaction_amount,
      p_currency: subscription.auto_recurring?.currency_id,
      p_next_payment_date: subscription.next_payment_date || null,
      p_live_mode: isProduction(env),
    },
    { service: true },
  );
}

async function webhook(request, env) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  if (!billingConfigured(env)) {
    return json({ ok: false, error: "BILLING_NOT_CONFIGURED" }, 503);
  }
  const url = new URL(request.url);
  const body = await readBoundedJson(request, WEBHOOK_BODY_LIMIT);
  const dataId = url.searchParams.get("data.id") || body?.data?.id;
  if (!dataId) throw new HttpError(400, "MISSING_DATA_ID", "Notificação inválida.");
  if (!(await validateMercadoSignature(request, env.MERCADO_PAGO_WEBHOOK_SECRET, dataId))) {
    throw new HttpError(401, "INVALID_WEBHOOK_SIGNATURE", "Assinatura inválida.");
  }

  const type = String(url.searchParams.get("type") || url.searchParams.get("topic") || body.type || "").toLowerCase();
  let result = { accepted: false, reason: "IGNORED_NOTIFICATION_TYPE" };
  if (type === "payment") result = await processPaymentWebhook(env, dataId);
  else if (["subscription_preapproval", "preapproval"].includes(type)) {
    result = await processSubscriptionWebhook(env, dataId);
  }
  console.log(
    JSON.stringify({
      message: "mercado_pago_webhook_processed",
      type,
      dataId: String(dataId),
      accepted: Boolean(result?.accepted),
      granted: Boolean(result?.granted),
      reason: result?.reason || null,
    }),
  );
  return json({ ok: true });
}

async function billingStatus(request, env) {
  if (request.method !== "GET") return methodNotAllowed("GET");
  if (!billingConfigured(env)) {
    return json({ ok: false, error: "BILLING_NOT_CONFIGURED" }, 503);
  }
  const accessToken = bearerToken(request);
  const status = await supabaseRpc(
    env,
    "get_my_billing_status_v1",
    {},
    { accessToken },
  );
  return json({ ok: true, ...status });
}

async function handleBillingRequest(request, env) {
  const pathname = new URL(request.url).pathname;
  try {
    if (pathname === "/api/billing/config") {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return json({
        ok: true,
        enabled: billingConfigured(env),
        environment: isProduction(env) ? "production" : "sandbox",
        plans: CHECKOUT_PLANS,
        recurring: false,
      });
    }
    if (pathname === "/api/billing/checkout") return await checkout(request, env);
    if (pathname === "/api/billing/status") return await billingStatus(request, env);
    if (pathname === "/api/webhooks/mercado-pago") return await webhook(request, env);
    return null;
  } catch (error) {
    if (error instanceof HttpError) {
      return json(
        { ok: false, error: error.code, message: error.message },
        error.status,
      );
    }
    throw error;
  }
}

export {
  CHECKOUT_PLANS,
  HttpError,
  billingConfigured,
  constantTimeEqual,
  createMercadoSignature,
  handleBillingRequest,
  validateMercadoSignature,
};
