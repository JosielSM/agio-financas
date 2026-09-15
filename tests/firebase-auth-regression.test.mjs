import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [bridge, adminServiceWorker, mainHtml, adminHtml] = await Promise.all([
  readFile(new URL("../firebase-bridge.js", import.meta.url), "utf8"),
  readFile(new URL("../admin/sw.js", import.meta.url), "utf8"),
  readFile(new URL("../index.html", import.meta.url), "utf8"),
  readFile(new URL("../admin/index.html", import.meta.url), "utf8"),
]);

test("Firebase Auth reports a missing SDK instead of failing silently", () => {
  assert.match(bridge, /auth\/sdk-not-loaded/);
  assert.match(bridge, /SDK não carregado/);
});

test("Firebase Auth falls back when local persistence is unavailable", () => {
  const local = bridge.indexOf("Auth.Persistence.LOCAL");
  const session = bridge.indexOf("Auth.Persistence.SESSION");
  const memory = bridge.indexOf("Auth.Persistence.NONE");

  assert.ok(local >= 0);
  assert.ok(session > local);
  assert.ok(memory > session);
});

test("Google login preserves a useful Firebase error code", () => {
  assert.match(bridge, /Falha no login Google:/);
  assert.match(bridge, /error\?\.code \|\| "auth\/unknown"/);
});

test("admin service worker never replaces external SDKs or scripts with HTML", () => {
  assert.match(
    adminServiceWorker,
    /requestUrl\.origin !== self\.location\.origin/,
  );
  assert.match(
    adminServiceWorker,
    /event\.request\.mode === "navigate"/,
  );
  assert.doesNotMatch(
    adminServiceWorker,
    /caches\.match\(event\.request\)[\s\S]{0,100}caches\.match\("\/admin\/index\.html"\)/,
  );
});

test("both PWAs self-host their versioned authentication dependencies", () => {
  for (const html of [mainHtml, adminHtml]) {
    assert.doesNotMatch(html, /<script[^>]+(?:gstatic|jsdelivr)/i);
    assert.match(html, /vendor\/firebase-app-compat\.js/);
    assert.match(html, /vendor\/firebase-auth-compat\.js/);
    assert.match(html, /vendor\/supabase\.min\.js/);
  }
});
