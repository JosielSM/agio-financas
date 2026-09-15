import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("every valueless data-close button is routed by attribute presence", async () => {
  const [html, app] = await Promise.all([read("index.html"), read("app.js")]);
  const closeButtons = html.match(/<button\b[^>]*\bdata-close(?:\s|>)[^>]*>/gi) || [];

  assert.ok(closeButtons.length >= 10, "expected all modal close buttons in the contract");
  assert.match(app, /button\.hasAttribute\("data-close"\)/);
  assert.doesNotMatch(app, /if\s*\(button\.dataset\.close\)/);
});

test("hidden feedback never intercepts the mobile navigation", async () => {
  const css = await read("styles.css");
  const hiddenToastRules = Array.from(
    css.matchAll(/\.toast\s*\{[\s\S]*?\n\}/g),
    (match) => match[0],
  );
  const visibleToastRules = Array.from(
    css.matchAll(/\.toast\.show\s*\{[\s\S]*?\n\}/g),
    (match) => match[0],
  );

  assert.ok(hiddenToastRules.some((rule) => /visibility:\s*hidden/.test(rule)));
  assert.ok(hiddenToastRules.some((rule) => /pointer-events:\s*none/.test(rule)));
  assert.ok(visibleToastRules.some((rule) => /visibility:\s*visible/.test(rule)));
  assert.ok(visibleToastRules.some((rule) => /pointer-events:\s*auto/.test(rule)));
});

test("the PWA cache changes with the interaction repair", async () => {
  const serviceWorker = await read("sw.js");
  assert.match(serviceWorker, /credmais-shell-v27/);
});

test("the sidebar keeps only the monthly report account action", async () => {
  const [html, app] = await Promise.all([read("index.html"), read("app.js")]);
  const sidebarBottom =
    html.match(/<div class="sidebar-bottom">[\s\S]*?<\/div><\/aside>/)?.[0] ||
    "";

  assert.match(sidebarBottom, /id="monthlyReportBtn"/);
  assert.doesNotMatch(sidebarBottom, /Senha e segurança|Instalar app|>\s*Sair\s*</);
  assert.doesNotMatch(
    sidebarBottom,
    /id="securityBtn"|id="installAppBtn"|id="logoutBtn"/,
  );
  assert.match(html, /id="profileSecurityButton"/);
  assert.match(html, /id="profileInstallButton"/);
  assert.match(html, /id="profileLogoutButton"/);
  assert.match(app, /async function signOutCurrentUser\(\)/);
  assert.doesNotMatch(app, /#securityBtn|#installAppBtn|#logoutBtn/);
});
