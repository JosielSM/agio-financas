import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const migrationPath =
  "supabase/migrations/20260916193000_admin_billing_dashboard.sql";

test("admin dashboard prioritizes new users and automatic payments", async () => {
  const [html, app, styles] = await Promise.all([
    read("admin/index.html"),
    read("admin/app.js"),
    read("admin/styles.css"),
  ]);

  assert.match(html, /data-overview-feed="recent"[^>]*>Recém-cadastrados/);
  assert.match(html, /data-overview-feed="paid"[^>]*>Pagaram automaticamente/);
  assert.match(html, /data-filter="recent"[^>]*>Novos/);
  assert.match(html, /data-filter="auto_paid"[^>]*>Pagamento automático/);
  assert.match(html, /id="paymentsSection"/);
  assert.match(html, /data-section="payments"/);
  assert.match(app, /function renderOverviewFeed\(\)/);
  assert.match(app, /function renderPayments\(\)/);
  assert.match(app, /latestApprovedPayment/);
  assert.match(styles, /\.admin-topbar\{position:sticky/);
  assert.match(styles, /\.bottom-nav\{grid-template-columns:repeat\(4,1fr\)\}/);
  assert.match(styles, /@media\(max-width:720px\)/);
});

test("user profile explains billing status and payment origin", async () => {
  const [html, app] = await Promise.all([
    read("admin/index.html"),
    read("admin/app.js"),
  ]);

  for (const id of [
    "managePaymentOrigin",
    "managePaymentMethod",
    "managePaymentAmount",
    "managePaymentPlan",
    "managePaymentDate",
    "managePaymentHistory",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(app, /function renderManagedBilling\(account\)/);
  assert.match(app, /Mercado Pago automático/);
  assert.match(app, /Liberação manual paga/);
  assert.match(app, /Teste gratuito/);
  assert.match(app, /Histórico automático/);
});

test("payment dashboard RPC is admin-only and does not expose checkout secrets", async () => {
  const [sql, bridge, publicBoundary] = await Promise.all([
    read(migrationPath),
    read("supabase-bridge.js"),
    read("scripts/verify-public-boundary.mjs"),
  ]);

  assert.match(sql, /create or replace function public\.admin_get_platform_billing_dashboard_v1\(\)/i);
  assert.match(sql, /security definer\s+set search_path = ''/i);
  assert.match(sql, /not private\.is_platform_admin_id\(actor_id\)/i);
  assert.match(sql, /from public\.platform_payment_orders/i);
  assert.match(sql, /from public\.platform_payment_transactions/i);
  assert.match(sql, /limit 250/i);
  assert.doesNotMatch(sql, /checkout_url/i);
  assert.doesNotMatch(sql, /access_token/i);
  assert.match(bridge, /client\.rpc\("admin_get_platform_billing_dashboard_v1"\)/);
  assert.match(bridge, /payments: billingResult\.data\?\.payments \|\| \[\]/);
  assert.match(publicBoundary, /rpc\/admin_get_platform_billing_dashboard_v1/);
  assert.match(publicBoundary, /unauthenticated request read the administrative payment dashboard/);
});
