import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("administrative profile keeps billing visible and mutations in separate dialogs", async () => {
  const [html, app] = await Promise.all([read("admin/index.html"), read("admin/app.js")]);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, "all DOM ids must be unique");
  for (const id of ["manageModal", "actionsModal", "editAccountModal", "accessModal", "dangerModal", "historyModal", "settingsModal", "managePaymentStatus", "manageNextPrice", "manualPaymentMethod", "openGlobalHistory"]) {
    assert.ok(ids.includes(id), `${id} is present`);
  }
  const profile = html.match(/id="manageModal"[\s\S]*?(?=<section class="modal action-list-modal")/)?.[0];
  assert.ok(profile);
  assert.doesNotMatch(profile, /id="manageForm"|id="grantAccess"|id="toggleBlock"/);
  assert.match(app, /openAccountAction\("editAccountModal"\)/);
  assert.match(app, /openHistory\(state\.managedUserId\)/);
  assert.match(app, /openHistory\(\)/);
  assert.doesNotMatch(app, /\$\("#refreshAccounts"\)|\$\("#refreshPayments"\)/);
});

test("current automatic payment is matched by transaction id, not a historic list item", async () => {
  const [app, bridge, sql] = await Promise.all([
    read("admin/app.js"), read("supabase-bridge.js"),
    read("supabase/migrations/20260917150000_admin_panel_clarity.sql"),
  ]);
  assert.match(app, /String\(currentPayment\?\.transactionId\) === String\(account\.last_payment_transaction_id\)/);
  assert.match(bridge, /admin_get_platform_account_history_v1/);
  assert.match(bridge, /admin_grant_platform_access_v6/);
  assert.match(sql, /not private\.is_platform_admin_id\(actor_id\)/);
  assert.match(sql, /payment\.id = account\.last_payment_transaction_id/);
  assert.match(sql, /last_payment_transaction_id = null/);
  assert.match(sql, /manual_payment_method = case/);
  assert.match(sql, /paymentMethod', coalesce\(p_payment_method, 'courtesy'\)/);
  assert.match(sql, /limit p_limit \+ 1 offset p_offset/);
});

test("monthly payment indicators use server totals beyond the recent list", async () => {
  const [sql, bridge, app] = await Promise.all([
    read("supabase/migrations/20260917160000_admin_payment_totals.sql"),
    read("supabase-bridge.js"), read("admin/app.js"),
  ]);
  assert.match(sql, /'approvedAmountMonth'/);
  assert.match(sql, /'approvedCountMonth'/);
  assert.match(sql, /from public\.platform_payment_orders payment_order[\s\S]*?left join lateral/);
  assert.match(sql, /limit 250/);
  assert.match(bridge, /paymentTotals: billingResult\.data\?\.totals \|\| null/);
  assert.match(app, /state\.paymentTotals\?\.approvedAmountMonth/);
});
