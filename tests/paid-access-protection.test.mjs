import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("active live Mercado Pago access is protected at the database boundary", async () => {
  const sql = await read(
    "supabase/migrations/20260917120000_protect_automatic_paid_access.sql",
  );
  assert.match(sql, /create or replace function private\.protect_automatic_paid_access\(\)/i);
  assert.match(sql, /security definer\s+set search_path = ''/i);
  assert.match(sql, /auth\.role\(\) = 'service_role'/i);
  assert.match(sql, /old\.status = 'active'/i);
  assert.match(sql, /old\.paid_until >= current_date/i);
  assert.match(sql, /payment\.status = 'approved'/i);
  assert.match(sql, /payment\.live_mode = true/i);
  assert.match(sql, /payment\.access_granted_at is not null/i);
  for (const column of [
    "status", "paid_until", "access_type", "access_amount", "approved_at",
    "approved_by", "last_payment_transaction_id", "access_reset_at",
  ]) {
    assert.match(sql, new RegExp(`new\\.${column}`));
    assert.match(sql, new RegExp(`old\\.${column}`));
  }
  assert.match(sql, /before update on public\.platform_accounts/i);
  assert.doesNotMatch(sql, /new\.monthly_fee|new\.pricing_tier/i);
  assert.match(sql, /commit;\s*$/i);
});

test("admin shows paid protection while retaining future-price editing", async () => {
  const [html, app, css] = await Promise.all([
    read("admin/index.html"),
    read("admin/app.js"),
    read("admin/styles.css"),
  ]);
  assert.match(html, /id="managePlanProtection"/);
  assert.match(html, /Preço de compras futuras/);
  assert.match(app, /function renderManagedBilling\(account\)/);
  assert.match(app, /const hasProtectedAutomaticAccess =/);
  for (const id of ["manageAccessSection", "resetAccessSection", "toggleBlock"]) {
    assert.match(app, new RegExp(`\\#${id}.*hidden = protectedPaidAccess`));
    assert.match(css, new RegExp(`\\#${id}\\[hidden\\]`));
  }
  assert.match(app, /async function saveManagedAccount\(/);
  assert.match(app, /bridge\.updatePlatformAccount\(/);
  assert.match(app, /async function grantAccess\(\)[\s\S]*?hasProtectedAutomaticAccess\(currentAccount\)/);
  assert.match(app, /async function toggleBlock\(\)[\s\S]*?hasProtectedAutomaticAccess\(account\)/);
  assert.match(app, /async function resetPlatformAccess\(\)[\s\S]*?hasProtectedAutomaticAccess\(account\)/);
});

test("production guard probe rolls back every temporary account and payment", async () => {
  const sql = await read("supabase-paid-access-verification.sql");
  assert.match(sql, /^begin;/im);
  assert.match(sql, /admin_set_platform_status/i);
  assert.match(sql, /admin_reset_platform_access_v1/i);
  assert.match(sql, /admin_grant_platform_access_v5/i);
  assert.match(sql, /admin_grant_platform_lifetime_v2/i);
  assert.match(sql, /admin_update_platform_account_v3/i);
  assert.match(sql, /request\.jwt\.claim\.role', 'service_role'/i);
  assert.match(sql, /^rollback;/im);
});
