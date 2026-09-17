import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

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
  assert.match(offlineBanner, /id="offlineBannerTitle"/);
  assert.match(offlineBanner, /id="offlineRefreshButton"/);
  assert.doesNotMatch(offlineBanner, /data-payment-months|automaticPaymentButton/);
  assert.match(offlineMode, /\$\("#accessView"\)\.hidden = true/);
  assert.match(offlineMode, /\$\("#subscriptionBanner"\)\.hidden = true/);
  assert.match(offlineMode, /applyPlatformRestrictions\(\)/);
});

test("access verification uses the live RPC even when the browser reports offline", async () => {
  const app = await read("app.js");
  const resolver = app.match(/async function resolvePlatformAccess\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(resolver);
  let probes = 0;
  const resolve = runInNewContext(`${resolver}\nresolvePlatformAccess`, {
    navigator: { onLine: false },
    window: { credmaisBridge: { platformAccess: async () => ({ enabled: true, status: "active" }) } },
    state: { user: { id: "test-user" } },
    rememberVerifiedPlatformAccess: (access) => ({ ...access, offline: false }),
    probeAppReachability: async () => { probes += 1; return false; },
    offlinePlatformAccess: (_, connectionState) => ({ offline: true, connectionState }),
  });
  const access = await resolve();
  assert.equal(access.status, "active");
  assert.equal(access.offline, false);
  assert.equal(probes, 0);
  assert.doesNotMatch(resolver, /navigator\.onLine/);
});

test("an access service error is not mislabeled as missing internet", async () => {
  const app = await read("app.js");
  const resolver = app.match(/async function resolvePlatformAccess\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(resolver);
  const makeResolve = (appReachable) => runInNewContext(`${resolver}\nresolvePlatformAccess`, {
    window: { credmaisBridge: { platformAccess: async () => { throw new Error("RPC failed"); } } },
    state: { user: { id: "test-user" } },
    rememberVerifiedPlatformAccess: (access) => access,
    probeAppReachability: async () => appReachable,
    offlinePlatformAccess: (_, connectionState) => ({ offline: true, connectionState }),
  });
  assert.equal((await makeResolve(true)()).connectionState, "unavailable");
  assert.equal((await makeResolve(false)()).connectionState, "offline");
});

test("the connectivity probe bypasses cached API data", async () => {
  const [app, worker] = await Promise.all([read("app.js"), read("sw.js")]);
  const probe = app.match(/async function probeAppReachability\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(probe);
  let request;
  const check = runInNewContext(`${probe}\nprobeAppReachability`, {
    AbortController,
    Date,
    setTimeout: () => 1,
    clearTimeout: () => {},
    console: { warn: () => {} },
    fetch: async (url, options) => { request = { url, options }; return { status: 503 }; },
  });
  assert.equal(await check(), true);
  assert.match(request.url, /^\/api\/health\?connectivity=/);
  assert.equal(request.options.cache, "no-store");
  const failedCheck = runInNewContext(`${probe}\nprobeAppReachability`, {
    AbortController,
    Date,
    setTimeout: () => 1,
    clearTimeout: () => {},
    console: { warn: () => {} },
    fetch: async () => { throw new TypeError("network unavailable"); },
  });
  assert.equal(await failedCheck(), false);
  assert.match(worker, /requestUrl\.pathname\.startsWith\("\/api\/"\)\)\s*return/);
});

test("the recovery timer retries without a user click or browser online event", async () => {
  const app = await read("app.js");
  const start = app.match(/function startAccessRecovery\(\) \{[\s\S]*?\n\}/)?.[0];
  const stop = app.match(/function stopAccessRecovery\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(start && stop);
  let tick;
  let calls = 0;
  const context = {
    state: { user: { id: "test-user" } },
    window: { credmaisBridge: { enabled: true } },
    document: { hidden: false },
    accessRecoveryTimer: null,
    setInterval: (callback, delay) => { tick = callback; assert.equal(delay, 12000); return 1; },
    clearInterval: () => {},
    refreshFromCloud: async ({ allowWhileModalOpen }) => {
      assert.equal(allowWhileModalOpen, true);
      calls += 1;
    },
  };
  runInNewContext(`${start}\n${stop}\nstartAccessRecovery();`, context);
  tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  runInNewContext(`${stop}\nstopAccessRecovery();`, context);
  assert.equal(context.accessRecoveryTimer, null);
});

test("access verification fails closed and recovers automatically", async () => {
  const app = await read("app.js");
  const refresh =
    app.match(/async function refreshFromCloud\([\s\S]*?\n\}/)?.[0] || "";

  assert.match(app, /function startAccessRecovery\(/);
  assert.match(app, /setInterval\(\(\) => \{[\s\S]*?refreshFromCloud\(\{ allowWhileModalOpen: true \}\)[\s\S]*?\}, 12000\)/);
  assert.match(app, /function stopAccessRecovery\(/);
  assert.match(app, /window\.addEventListener\("offline"/);
  assert.match(app, /window\.addEventListener\("online", \(\) => \{/);
  assert.doesNotMatch(app.match(/window\.addEventListener\("offline", \(\) => \{[\s\S]*?\n\}\);/)?.[0] || "", /showOfflineMode/);
  assert.doesNotMatch(refresh, /!\$\("#accessView"\)\.hidden/);
  assert.match(refresh, /stopAccessRecovery\(\)/);
});

test("offline mutations are stopped before any write", async () => {
  const app = await read("app.js");
  const guard =
    app.match(/function requirePlatformAccess\([\s\S]*?\n\}/)?.[0] || "";

  assert.match(guard, /platformOfflineReadOnly\(\)/);
  assert.match(guard, /showOfflineMode\(state\.platformAccess\)/);
  assert.match(guard, /verificação automática da conexão/);
  assert.match(app, /if \(liveAccess\.offline\) \{\s*showOfflineMode\(liveAccess\);/);
});
