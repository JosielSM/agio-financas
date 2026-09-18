import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("routine access refresh keeps an open plan dialog visible", async () => {
  const app = await read("app.js");
  const source = app.match(/async function refreshFromCloud\([\s\S]*?\n\}/)?.[0];
  assert.ok(source);
  for (const status of ["active", "expired"]) {
    const accessView = { hidden: false };
    const gateCalls = [];
    const access = { enabled: true, status, accessType: "paid" };
    const state = {
      user: { id: "user-1" },
      platformAccess: access,
      accessPromptDismissed: true,
      clients: [],
      loans: [],
      history: [],
    };
    const $ = (selector) => {
      if (selector === "#accessView") return accessView;
      if (selector === "#offlineBanner") return { hidden: true };
      throw new Error(`Unexpected selector: ${selector}`);
    };
    const refresh = runInNewContext(`${source}\nrefreshFromCloud`, {
      $,
      state,
      window: {
        credmaisBridge: {
          enabled: true,
          load: async () => ({ clients: [], loans: [], history: [] }),
        },
      },
      document: { hidden: false },
      refreshingFromCloud: false,
      hasOpenModal: () => false,
      platformOfflineReadOnly: () => false,
      platformPaymentLocked: () => status !== "active",
      resolvePlatformAccess: async () => access,
      stopAccessRecovery: () => {},
      platformAccessAllowed: () => status === "active",
      renderTrialBanner: () => {},
      renderPlatformSupport: () => {},
      showAccessGate: (_, options) => gateCalls.push(options),
      applyPlatformRestrictions: () => {},
      pendingSyncPayload: () => null,
      render: () => {},
      toast: () => {},
    });
    await refresh();
    assert.deepEqual(gateCalls.map((call) => call.openPrompt), [true]);
    assert.equal(accessView.hidden, false);
  }
});

test("checkout plans stop at six months across page, Worker and database", async () => {
  const [html, app, worker, css, originalMigration, limitMigration] =
    await Promise.all([
      read("index.html"),
      read("app.js"),
      read("src/mercado-pago.js"),
      read("styles.css"),
      read("supabase/migrations/20260915140000_global_and_custom_pricing.sql"),
      read("supabase/migrations/20260918120000_limit_checkout_to_six_months.sql"),
    ]);
  assert.deepEqual(
    [...html.matchAll(/data-payment-months="(\d+)"/g)].map((match) => Number(match[1])),
    [1, 2, 3, 6],
  );
  assert.match(app, /plans: \[1, 2, 3, 6\]/);
  assert.match(worker, /CHECKOUT_PLANS = Object\.freeze\(\[1, 2, 3, 6\]\)/);
  assert.match(css, /\.payment-plan-list \{\s*display: grid;\s*grid-template-columns: repeat\(4, 1fr\)/);
  const functionBody = (sql) => sql.match(
    /create or replace function public\.create_platform_payment_order_v1\([\s\S]*?\n\$\$;/,
  )?.[0];
  assert.equal(
    functionBody(limitMigration),
    functionBody(originalMigration)?.replace("(1, 2, 3, 6, 12)", "(1, 2, 3, 6)"),
    "the database guard must change without altering billing behavior",
  );
});
