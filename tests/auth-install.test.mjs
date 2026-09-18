import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("installation entry is visible before sign-up and uses the existing flow", async () => {
  const [html, app, css] = await Promise.all([read("index.html"), read("app.js"), read("styles.css")]);
  const authBrand = html.match(/<section class="auth-brand">([\s\S]*?)<\/section>/)?.[1];
  assert.ok(authBrand, "authentication brand exists");
  assert.match(authBrand, /id="authInstallButton"[^>]*aria-controls="installModal"/);
  assert.ok(authBrand.indexOf("authInstallButton") < authBrand.indexOf("auth-points"));
  assert.match(app, /\$\("#authInstallButton"\)\.onclick = openInstall;/);
  assert.match(css, /\.auth-install-button \{[\s\S]*?min-height: 68px;/);
  assert.match(html, /id="installModal"/);
});

test("install button stays available without a browser prompt and hides once installed", async () => {
  const app = await read("app.js");
  const setup = app.match(/function setupPWA\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(setup);
  const buttons = {
    "#profileInstallButton": { hidden: true },
    "#authInstallButton": { hidden: true },
  };
  const events = {};
  let standalone = false;
  let successMessage = "";
  const context = {
    $: (selector) => buttons[selector],
    isStandalone: () => standalone,
    window: { addEventListener: (event, listener) => { events[event] = listener; } },
    navigator: {},
    toast: (message) => { successMessage = message; },
  };
  const start = runInNewContext(`let deferredInstallPrompt = null; ${setup}\nsetupPWA`, context);
  start();
  assert.equal(buttons["#authInstallButton"].hidden, false);
  assert.equal(buttons["#profileInstallButton"].hidden, false);

  events.beforeinstallprompt({ preventDefault() {} });
  assert.equal(buttons["#authInstallButton"].hidden, false);
  events.appinstalled();
  assert.equal(buttons["#authInstallButton"].hidden, true);
  assert.equal(buttons["#profileInstallButton"].hidden, true);
  assert.match(successMessage, /instalado com sucesso/);

  standalone = true;
  start();
  assert.equal(buttons["#authInstallButton"].hidden, true);
});

test("iPhone visitors get a Safari installation guide when no native prompt exists", async () => {
  const app = await read("app.js");
  const open = app.match(/function openInstall\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(open);
  const instructions = { innerHTML: "" };
  const confirm = { hidden: false };
  let opened = "";
  const context = {
    $: (selector) => selector === "#installInstructions" ? instructions : confirm,
    navigator: { userAgent: "iPhone" },
    isStandalone: () => false,
    openModal: (id) => { opened = id; },
    toast: () => {},
  };
  const show = runInNewContext(`let deferredInstallPrompt = null; ${open}\nopenInstall`, context);
  show();
  assert.equal(opened, "installModal");
  assert.equal(confirm.hidden, true);
  assert.match(instructions.innerHTML, /Safari/);
  assert.match(instructions.innerHTML, /Adicionar à Tela de Início/);
});
