import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const migrationPath =
  "supabase/migrations/20260916160000_admin_reset_platform_access.sql";

test("admin user profile exposes a confirmed plan reset with feedback", async () => {
  const [html, app, bridge, serviceWorker] = await Promise.all([
    read("admin/index.html"),
    read("admin/app.js"),
    read("supabase-bridge.js"),
    read("admin/sw.js"),
  ]);

  assert.match(html, /id="resetPlatformAccess"/);
  assert.match(html, /Clientes, empréstimos, histórico e preço especial não são apagados/);
  assert.match(app, /async function resetPlatformAccess\(\)/);
  assert.match(app, /window\.confirm\(/);
  assert.match(app, /Cobranças pendentes serão invalidadas/);
  assert.match(app, /await bridge\.resetPlatformAccess\(account\.user_id\)/);
  assert.match(app, /await loadDashboard\(\)/);
  assert.match(app, /Plano resetado/);
  assert.match(bridge, /admin_reset_platform_access_v1/);
  assert.match(serviceWorker, /credmais-admin-v15/);
});

test("plan reset is admin-only, audit logged and preserves user business data", async () => {
  const sql = await read(migrationPath);

  assert.match(sql, /security definer\s+set search_path = ''/i);
  assert.match(sql, /not private\.is_platform_admin_id\(actor_id\)/i);
  assert.match(sql, /private\.is_platform_admin_id\(p_user_id\)/i);
  assert.match(sql, /status = 'pending'[\s\S]{0,100}paid_until = null/i);
  assert.match(sql, /access_type = 'paid'[\s\S]{0,80}access_amount = 0/i);
  assert.match(sql, /last_payment_transaction_id = null/i);
  assert.match(sql, /access_reset_at = now\(\)/i);
  assert.match(sql, /'access_reset'/i);
  assert.match(sql, /'businessDataPreserved', true/i);
  assert.match(sql, /'pricingPreserved', true/i);
  assert.doesNotMatch(sql, /delete\s+from\s+public\.(clients|loans|history)/i);

  const accountUpdate = sql.match(
    /update public\.platform_accounts\s+set[\s\S]*?where user_id = p_user_id\s+returning \* into saved;/i,
  )?.[0];
  assert.ok(accountUpdate, "expected the scoped platform account reset update");
  assert.doesNotMatch(accountUpdate, /monthly_fee\s*=/i);
  assert.doesNotMatch(accountUpdate, /pricing_tier\s*=/i);
  assert.doesNotMatch(accountUpdate, /trial_started_at\s*=/i);
});

test("reset invalidates stale checkouts and cannot silently orphan recurring billing", async () => {
  const [sql, publicBoundary] = await Promise.all([
    read(migrationPath),
    read("scripts/verify-public-boundary.mjs"),
  ]);

  assert.match(sql, /status in \('pending', 'authorized', 'paused'\)/i);
  assert.match(sql, /Cancele-a no Mercado Pago antes de resetar o plano/i);
  assert.match(sql, /failure_reason = 'ADMIN_ACCESS_RESET'/i);
  assert.match(sql, /ORDER_INVALIDATED_BY_ADMIN_RESET/i);
  assert.match(sql, /order_row\.created_at <= account\.access_reset_at/i);
  assert.match(sql, /grant execute on function public\.admin_reset_platform_access_v1\(text\)[\s\S]*to anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.system_process_mercado_payment_v1\([\s\S]*\) to service_role/i);
  assert.match(sql, /commit;\s*$/i);
  assert.match(publicBoundary, /rpc\/admin_reset_platform_access_v1/);
  assert.match(publicBoundary, /unauthenticated request reset a platform subscription/i);
});
