import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("admin supports a global price and a per-user override", async () => {
  const [html, app, bridge] = await Promise.all([
    read("admin/index.html"),
    read("admin/app.js"),
    read("supabase-bridge.js"),
  ]);

  assert.match(html, /name="managePricing" value="default"/);
  assert.match(html, /name="managePricing" value="custom"/);
  assert.match(html, /id="defaultMonthlyFee"/);
  assert.match(app, /account\.monthly_fee \?\? state\.settings\?\.default_monthly_fee/);
  assert.match(bridge, /admin_update_platform_account_v2/);
  assert.match(bridge, /admin_grant_platform_access_v4/);
  assert.match(bridge, /p_use_default_fee/);
  assert.match(bridge, /p_monthly_fee: useDefaultFee \? null/);
});

test("subscription billing exposes only the automatic checkout", async () => {
  const [mainHtml, mainApp, adminHtml, worker] = await Promise.all([
    read("index.html"),
    read("app.js"),
    read("admin/index.html"),
    read("src/mercado-pago.js"),
  ]);

  assert.doesNotMatch(mainHtml, /accessBillingPixKey|accessSendReceipt|accessCopyPix/);
  assert.doesNotMatch(mainApp, /copyAccessPix|sendAccessReceipt|Use o PIX manual/);
  assert.doesNotMatch(adminHtml, /id="billingPixKey"|id="billingRecipient"/);
  assert.match(adminHtml, /id="chargePayment"/);
  assert.doesNotMatch(worker, /Use o PIX manual/);
});

test("database pricing policy calculates server-side and invalidates stale orders", async () => {
  const [sql, automaticOnlySql] = await Promise.all([
    read("supabase/migrations/20260915140000_global_and_custom_pricing.sql"),
    read("supabase/migrations/20260915143000_disable_manual_platform_pix.sql"),
  ]);

  assert.match(sql, /coalesce\(account_row\.monthly_fee, setting_row\.default_monthly_fee/i);
  assert.match(sql, /monthly_fee = requested_fee/i);
  assert.match(sql, /case when p_use_default_fee then null/i);
  assert.match(sql, /failure_reason = 'PRICE_CHANGED'/i);
  assert.match(sql, /monthly_fee is distinct from effective_fee/i);
  assert.doesNotMatch(
    sql,
    /update public\.platform_accounts set[\s\S]{0,180}monthly_fee = order_row\.monthly_fee/i,
  );
  assert.match(sql, /security definer\s+set search_path = ''/i);
  assert.match(sql, /commit;\s*$/i);
  assert.match(automaticOnlySql, /billing_pix_key = ''/i);
  assert.match(automaticOnlySql, /PAGAMENTO AUTOMÁTICO/i);
  assert.match(automaticOnlySql, /commit;\s*$/i);
});
