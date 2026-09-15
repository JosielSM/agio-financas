import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("offline mode is distinct from a payment lock", async () => {
  const app = await read("app.js");

  assert.match(app, /function platformOfflineReadOnly\(/);
  assert.match(app, /function platformPaymentLocked\(/);
  assert.match(app, /access\?\.enabled && !access\?\.offline/);
  assert.match(app, /if \(access\?\.offline\) \{\s*showOfflineMode\(access\);/);
  assert.match(app, /banner\.hidden = !paymentLocked/);
});

test("offline users see cached data without seeing payment plans", async () => {
  const [html, app] = await Promise.all([read("index.html"), read("app.js")]);
  const offlineBanner =
    html.match(/<aside class="offline-banner"[\s\S]*?<\/aside>/)?.[0] || "";
  const offlineMode =
    app.match(/function showOfflineMode\([\s\S]*?\n\}/)?.[0] || "";

  assert.match(offlineBanner, /id="offlineBanner"/);
  assert.match(offlineBanner, /id="offlineRefreshButton"/);
  assert.doesNotMatch(offlineBanner, /data-payment-months|automaticPaymentButton/);
  assert.match(offlineMode, /\$\("#accessView"\)\.hidden = true/);
  assert.match(offlineMode, /\$\("#subscriptionBanner"\)\.hidden = true/);
  assert.match(offlineMode, /applyPlatformRestrictions\(\)/);
});

test("access verification fails closed and recovers automatically", async () => {
  const app = await read("app.js");
  const refresh =
    app.match(/async function refreshFromCloud\([\s\S]*?\n\}/)?.[0] || "";

  assert.match(app, /if \(navigator\.onLine === false\) return offlinePlatformAccess\(\)/);
  assert.match(app, /return offlinePlatformAccess\(error\)/);
  assert.match(app, /window\.addEventListener\("offline"/);
  assert.match(app, /window\.addEventListener\("online", \(\) => refreshFromCloud/);
  assert.doesNotMatch(refresh, /!\$\("#accessView"\)\.hidden/);
  assert.match(refresh, /Conexão restabelecida\. Seu acesso continua liberado/);
});

test("offline mutations are stopped before any write", async () => {
  const app = await read("app.js");
  const guard =
    app.match(/function requirePlatformAccess\([\s\S]*?\n\}/)?.[0] || "";

  assert.match(guard, /platformOfflineReadOnly\(\)/);
  assert.match(guard, /showOfflineMode\(state\.platformAccess\)/);
  assert.match(guard, /Você está offline/);
  assert.match(app, /showOfflineMode\(offlinePlatformAccess\(error\)\)/);
});
