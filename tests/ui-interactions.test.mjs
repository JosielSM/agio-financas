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
  assert.match(serviceWorker, /credmais-shell-v65/);
});

test("the loan form uses installment language and reveals only the selected interest explanation", async () => {
  const [html, css] = await Promise.all([read("index.html"), read("styles.css")]);

  assert.match(html, /Quantidade de parcelas<input id="loanInstallments"/);
  assert.doesNotMatch(html, /Quantidade de pagamentos<input id="loanInstallments"/);
  assert.match(css, /input:not\(:checked\) \+ \.interest-mode-card small/);
  assert.match(css, /input:not\(:checked\) \+ \.interest-mode-card em/);
  assert.match(css, /input:checked \+ \.interest-mode-card\s*\{[^}]*interestModeReveal/);
});

test("a new loan starts with neutral placeholders instead of suggested financial values", async () => {
  const [html, app, css] = await Promise.all([
    read("index.html"),
    read("app.js"),
    read("styles.css"),
  ]);

  assert.match(html, /id="loanInterest"[^>]*placeholder="0,00"[^>]*required/);
  assert.doesNotMatch(html, /id="loanInterest"[^>]*value="10"/);
  assert.match(html, /id="loanInstallments"[^>]*placeholder="0"[^>]*required/);
  assert.doesNotMatch(html, /id="loanInstallments"[^>]*value="6"/);
  assert.match(html, /id="loanFrequency" required><option value="" selected disabled>Selecione a frequência/);
  assert.match(app, /setCurrencyInput\(\$\("#loanLateFee"\), 0, false\)/);
  assert.match(app, /\$\("#loanFrequency"\)\.value = ""/);
  assert.match(css, /\.loan-modal input::placeholder/);
  assert.match(css, /\.loan-modal select:required:invalid/);
});

test("the payment dialog keeps only payment choices and non-overlapping controls", async () => {
  const [html, app, css] = await Promise.all([
    read("index.html"),
    read("app.js"),
    read("styles.css"),
  ]);
  const accessView =
    html.match(/<main id="accessView"[\s\S]*?<div id="appView"/)?.[0] || "";

  assert.match(accessView, /class="access-card-tools"/);
  assert.match(accessView, /id="accessTheme"/);
  assert.match(accessView, /id="accessDismiss"/);
  assert.match(accessView, /id="automaticPaymentButton"/);
  assert.match(accessView, /id="automaticPaymentButtonLabel"/);
  assert.match(accessView, /PIX com confirmação automática ou cartão/);
  assert.match(accessView, /Sem renovação automática/);
  assert.doesNotMatch(accessView, /automaticSubscriptionButton|Assinar mensalmente/);
  assert.doesNotMatch(
    accessView,
    /accessRequestForm|accessPhone|accessRequestButton|accessContinue|accessRefresh|accessLogout/,
  );
  assert.doesNotMatch(
    app,
    /#accessRequestForm|#accessPhone|#accessRequestButton|#accessContinue|#accessRefresh|#accessLogout/,
  );
  assert.match(css, /\.access-card-tools\s*\{[\s\S]*?display:\s*flex/);
  assert.match(css, /\.mercado-pay-button\s*\{[\s\S]*?min-height:\s*78px/);
  assert.match(css, /\.mercado-pay-button\s*\{[\s\S]*?linear-gradient/);
  assert.match(css, /\.payment-plan b\s*\{[\s\S]*?font-size:\s*15px/);
  assert.match(css, /\.access-price b\s*\{[\s\S]*?34px Outfit/);
  assert.match(css, /\.access-shell\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(css, /\.automatic-payment-total b\s*\{[\s\S]*?white-space:\s*nowrap/);
  assert.match(css, /\.dark \.automatic-payment-total b\s*\{[\s\S]*?color:\s*#8bd2ff/);
  assert.match(app, /\[\$\("#headerTheme"\), \$\("#authTheme"\), \$\("#accessTheme"\)\]/);
});

test("the sidebar keeps the report and direct WhatsApp support actions", async () => {
  const [html, app] = await Promise.all([read("index.html"), read("app.js")]);
  const sidebarBottom =
    html.match(/<div class="sidebar-bottom">[\s\S]*?<\/div><\/aside>/)?.[0] ||
    "";

  assert.match(sidebarBottom, /id="monthlyReportBtn"/);
  assert.match(sidebarBottom, /id="sidebarSupportButton"/);
  assert.match(sidebarBottom, /data-platform-support/);
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

test("support opens the configured WhatsApp without a prefilled message", async () => {
  const [html, app, adminHtml, adminApp] = await Promise.all([
    read("index.html"),
    read("app.js"),
    read("admin/index.html"),
    read("admin/app.js"),
  ]);
  const supportHandler =
    app.match(/function openPlatformSupport\(\)\s*\{[\s\S]*?\n\}/)?.[0] || "";

  assert.match(html, /id="paymentSupportButton"[^>]+data-platform-support/);
  assert.match(html, /id="sidebarSupportButton"[^>]+data-platform-support/);
  assert.match(app, /access\?\.supportPhone/);
  assert.match(supportHandler, /https:\/\/wa\.me\/\$\{phone\}/);
  assert.doesNotMatch(supportHandler, /\?text=|encodeURIComponent/);
  assert.match(adminHtml, /id="supportPhone"/);
  assert.match(adminHtml, /sem mensagem automática/i);
  assert.match(adminApp, /WhatsApp de suporte válido com DDD/);
});
