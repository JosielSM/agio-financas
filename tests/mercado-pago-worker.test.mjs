import assert from "node:assert/strict";
import test from "node:test";

import { createMercadoSignature } from "../src/mercado-pago.js";
import { handleRequest } from "../src/worker.js";

function environment(overrides = {}) {
  return {
    APP_KIND: "main",
    APP_ORIGIN: "https://credmais.test",
    MERCADO_PAGO_ENV: "sandbox",
    MERCADO_PAGO_ACCESS_TOKEN: "TEST-access-token",
    MERCADO_PAGO_WEBHOOK_SECRET: "webhook-secret",
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "publishable-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    ASSETS: { fetch: async () => new Response("asset") },
    ...overrides,
  };
}

test("billing configuration never exposes payment secrets", async () => {
  const response = await handleRequest(
    new Request("https://credmais.test/api/billing/config"),
    environment(),
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.enabled, true);
  assert.equal(body.recurring, false);
  assert.deepEqual(body.plans, [1, 2, 3, 6, 12]);
  assert.doesNotMatch(JSON.stringify(body), /access-token|service-role|webhook-secret/);
});

test("billing stays disabled when the Mercado Pago token is masked", async () => {
  const response = await handleRequest(
    new Request("https://credmais.test/api/billing/config"),
    environment({
      MERCADO_PAGO_ENV: "production",
      MERCADO_PAGO_ACCESS_TOKEN: "••••••••••••••••••••",
    }),
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.enabled, false);
});

test("checkout requires an authenticated Firebase session", async () => {
  const response = await handleRequest(
    new Request("https://credmais.test/api/billing/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ months: 1, mode: "one_time" }),
    }),
    environment(),
  );
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, "AUTH_REQUIRED");
});

test("checkout rejects a manipulated plan before contacting providers", async (t) => {
  let fetchCalls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetchCalls += 1;
    return new Response("{}");
  });
  const response = await handleRequest(
    new Request("https://credmais.test/api/billing/checkout", {
      method: "POST",
      headers: {
        Authorization: "Bearer firebase-id-token-long-enough",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ months: 4, mode: "one_time" }),
    }),
    environment(),
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "INVALID_PLAN");
  assert.equal(fetchCalls, 0);
});

test("checkout rejects the retired recurring mode before contacting providers", async (t) => {
  let fetchCalls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetchCalls += 1;
    return new Response("{}");
  });
  const response = await handleRequest(
    new Request("https://credmais.test/api/billing/checkout", {
      method: "POST",
      headers: {
        Authorization: "Bearer firebase-id-token-long-enough",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ months: 1, mode: "subscription" }),
    }),
    environment(),
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "INVALID_PAYMENT_MODE");
  assert.equal(fetchCalls, 0);
});

test("checkout reports a production credential refused by Mercado Pago", async (t) => {
  const originalConsoleError = console.error;
  const logs = [];
  console.error = (message) => logs.push(String(message));
  t.after(() => {
    console.error = originalConsoleError;
  });
  t.mock.method(globalThis, "fetch", async (url) => {
    const target = String(url);
    if (target.includes("/rpc/create_platform_payment_order_v1")) {
      return Response.json({
        orderId: "9a81d30e-1963-4adc-a2f9-f9d80e4c5151",
        requestKey: "checkout-request-key",
        planMonths: 1,
        amount: 39.9,
        email: "cliente@example.test",
        name: "Cliente",
        processing: false,
        checkoutUrl: "",
      });
    }
    if (target.endsWith("/checkout/preferences")) {
      return Response.json(
        {
          error: "forbidden",
          message: "Unauthorized result from policies",
          cause: [{ code: "PA_UNAUTHORIZED_RESULT_FROM_POLICIES" }],
        },
        { status: 403 },
      );
    }
    if (target.includes("/rpc/system_mark_mercado_checkout_error_v1")) {
      return Response.json({ ok: true });
    }
    return Response.json({ error: "unexpected" }, { status: 500 });
  });

  const response = await handleRequest(
    new Request("https://credmais.test/api/billing/checkout", {
      method: "POST",
      headers: {
        Authorization: "Bearer firebase-id-token-long-enough",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ months: 1, mode: "one_time" }),
    }),
    environment({
      MERCADO_PAGO_ENV: "production",
      MERCADO_PAGO_ACCESS_TOKEN: "APP_USR-access-token-for-tests",
    }),
  );
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.error, "MERCADO_PAGO_NOT_AUTHORIZED");
  assert.match(body.message, /não autorizou esta aplicação/i);
  assert.ok(logs.some((entry) => entry.includes("PA_UNAUTHORIZED_RESULT_FROM_POLICIES")));
  assert.ok(logs.every((entry) => !entry.includes("TEST-access-token")));
});

test("webhook rejects an invalid Mercado Pago signature", async (t) => {
  let fetchCalls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetchCalls += 1;
    return new Response("{}");
  });
  const response = await handleRequest(
    new Request(
      "https://credmais.test/api/webhooks/mercado-pago?type=payment&data.id=123",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-request-id": "request-1",
          "x-signature": "ts=1700000000,v1=invalid",
        },
        body: JSON.stringify({ type: "payment", data: { id: "123" } }),
      },
    ),
    environment(),
  );
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, "INVALID_WEBHOOK_SIGNATURE");
  assert.equal(fetchCalls, 0);
});

test("signed webhook verifies the payment at Mercado Pago before the database", async (t) => {
  const dataId = "987654321";
  const requestId = "request-verified";
  const timestamp = "1700000000";
  const signature = await createMercadoSignature(
    "webhook-secret",
    `id:${dataId};request-id:${requestId};ts:${timestamp};`,
  );
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("api.mercadopago.com/v1/payments/")) {
      return Response.json({
        id: Number(dataId),
        status: "approved",
        status_detail: "accredited",
        external_reference: "9a81d30e-1963-4adc-a2f9-f9d80e4c5151",
        transaction_amount: 40,
        currency_id: "BRL",
        payment_method_id: "pix",
        payment_type_id: "bank_transfer",
        date_approved: "2026-09-14T12:00:00Z",
        live_mode: false,
        installments: 1,
      });
    }
    if (String(url).includes("/rpc/system_process_mercado_payment_v1")) {
      return Response.json({ accepted: true, granted: true });
    }
    return Response.json({ error: "unexpected" }, { status: 500 });
  });

  const response = await handleRequest(
    new Request(
      `https://credmais.test/api/webhooks/mercado-pago?type=payment&data.id=${dataId}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-request-id": requestId,
          "x-signature": `ts=${timestamp},v1=${signature}`,
        },
        body: JSON.stringify({ type: "payment", data: { id: dataId } }),
      },
    ),
    environment(),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /api\.mercadopago\.com\/v1\/payments\/987654321/);
  assert.match(calls[1].url, /system_process_mercado_payment_v1/);
  assert.equal(calls[1].options.headers.apikey, "service-role-key");
  assert.equal(
    calls[1].options.headers.Authorization,
    "Bearer service-role-key",
  );
});
