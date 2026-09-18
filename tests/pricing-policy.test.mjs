import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("admin exposes launch, standard, lifetime and per-user pricing choices", async () => {
  const [html, app, bridge] = await Promise.all([
    read("admin/index.html"),
    read("admin/app.js"),
    read("supabase-bridge.js"),
  ]);

  assert.match(html, /R\$ 39,90\/mês/);
  assert.match(html, /R\$ 59,90\/mês/);
  assert.match(html, /15 dias/);
  assert.match(html, /name="managePricing" value="launch_locked"/);
  assert.match(html, /name="managePricing" value="global"/);
  assert.match(html, /name="managePricing" value="custom"/);
  assert.match(html, /id="standardMonthlyFee"/);
  assert.match(html, /Vitalício — colaborador/);
  assert.match(app, /account\.monthly_fee \?\? state\.settings\?\.default_monthly_fee/);
  assert.match(bridge, /admin_update_platform_settings_v3/);
  assert.match(bridge, /admin_update_platform_account_v3/);
  assert.match(bridge, /admin_grant_platform_access_v6/);
  assert.match(bridge, /p_pricing_tier/);
  assert.match(bridge, /pricingTier === "custom"/);
});

test("database protects launch users and grants a one-time 15-day trial", async () => {
  const sql = await read(
    "supabase/migrations/20260915170000_launch_pricing_and_trial.sql",
  );

  assert.match(sql, /launch_monthly_fee[\s\S]{0,80}39\.90/i);
  assert.match(sql, /standard_monthly_fee[\s\S]{0,80}59\.90/i);
  assert.match(sql, /trial_days[\s\S]{0,80}15/i);
  assert.match(sql, /pricing_tier in \('global', 'launch_locked', 'custom', 'lifetime'\)/i);
  assert.match(sql, /where account\.pricing_tier is null/i);
  assert.match(sql, /monthly_fee = 39\.90[\s\S]{0,120}pricing_tier = 'launch_locked'/i);
  assert.match(sql, /status = 'active'[\s\S]{0,120}paid_until = current_date \+ 14[\s\S]{0,120}access_type = 'free'/i);
  assert.match(sql, /on conflict \(user_id\) do nothing/i);
  assert.match(sql, /Teste gratuito de 15 dias iniciado automaticamente/i);
  assert.match(sql, /admin_update_platform_settings_v3/i);
  assert.match(sql, /launchAccountsPreserved/i);
  assert.match(sql, /security definer\s+set search_path = ''/i);
  assert.match(sql, /commit;\s*$/i);
});

test("main app explains the active trial and lets the user subscribe early", async () => {
  const [html, app] = await Promise.all([read("index.html"), read("app.js")]);

  assert.match(html, /id="trialBanner"/);
  assert.match(html, /id="trialUpgradeButton"/);
  assert.match(html, /Teste gratuitamente por 15 dias/);
  assert.match(app, /function activeFreeTrial/);
  assert.match(app, /TESTE GRATUITO ENCERRADO/);
  assert.match(app, /Seu preço de lançamento está protegido/);
  assert.match(app, /renderTrialBanner\(access\)/);
});

test("billing exposes only the one-time Mercado Pago checkout", async () => {
  const [mainHtml, mainApp, adminHtml, worker] = await Promise.all([
    read("index.html"),
    read("app.js"),
    read("admin/index.html"),
    read("src/mercado-pago.js"),
  ]);

  assert.doesNotMatch(mainHtml, /accessBillingPixKey|accessSendReceipt|accessCopyPix/);
  assert.doesNotMatch(mainHtml, /automaticSubscriptionButton|Assinar mensalmente/);
  assert.doesNotMatch(mainApp, /copyAccessPix|sendAccessReceipt|Use o PIX manual/);
  assert.doesNotMatch(mainApp, /startBillingCheckout\("subscription"\)/);
  assert.doesNotMatch(adminHtml, /id="billingPixKey"|id="billingRecipient"/);
  assert.match(adminHtml, /id="chargePayment"/);
  assert.doesNotMatch(worker, /Use o PIX manual/);
  assert.match(worker, /body\.mode !== "one_time"/);
  assert.match(worker, /recurring:\s*false/);
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
