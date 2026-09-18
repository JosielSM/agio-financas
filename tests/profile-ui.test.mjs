import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("profile controls remain legible and use recognizable provider icons", async () => {
  const [html, css, google, whatsapp] = await Promise.all([
    read("index.html"),
    read("styles.css"),
    read("icons/google.svg"),
    read("icons/whatsapp.svg"),
  ]);

  assert.match(css, /\.modal\.profile-modal \.modal-close\s*\{[^}]*color:\s*#075b43;[^}]*background:\s*#fff;/);
  assert.match(html, /id="profileGoogleButton"[\s\S]*?src="icons\/google\.svg"/);
  assert.match(google, /#4285F4/);
  assert.match(google, /#34A853/);
  assert.match(html, /id="paymentSupportButton"[^>]*>[\s\S]*?src="icons\/whatsapp\.svg"/);
  assert.match(html, /id="sidebarSupportButton"[^>]*>[\s\S]*?src="icons\/whatsapp\.svg"/);
  assert.match(whatsapp, /viewBox="0 0 24 24"/);
});

test("password fields offer an eye toggle across both applications", async () => {
  const [html, actionHtml, adminHtml, css, adminCss, app, action, adminApp] = await Promise.all([
    read("index.html"),
    read("auth-action.html"),
    read("admin/index.html"),
    read("styles.css"),
    read("admin/styles.css"),
    read("app.js"),
    read("auth-action.js"),
    read("admin/app.js"),
  ]);
  for (const id of ["loginPassword", "registerPassword", "registerPasswordConfirm", "newPassword", "confirmNewPassword", "deleteAccountPassword"])
    assert.match(html, new RegExp(`data-password-toggle="${id}"`));
  for (const id of ["actionPassword", "actionPasswordConfirm"])
    assert.match(actionHtml, new RegExp(`data-password-toggle="${id}"`));
  for (const id of ["loginPassword", "registerPassword", "registerPasswordConfirm"])
    assert.match(adminHtml, new RegExp(`data-password-toggle="${id}"`));
  assert.match(css, /icons\/eye\.svg/);
  assert.match(css, /icons\/eye-off\.svg/);
  assert.match(adminCss, /\.\.\/icons\/eye\.svg/);
  for (const script of [app, action, adminApp]) {
    assert.match(script, /classList\.toggle\("is-visible", show\)/);
    assert.match(script, /aria-pressed/);
  }
});

test("a Google-only account configures password by email, not within the app", async () => {
  const [html, app] = await Promise.all([read("index.html"), read("app.js")]);
  assert.match(html, /id="profilePasswordButton"/);
  assert.match(html, /id="profilePasswordAction">Configurar/);
  assert.match(app, /function openProfilePasswordSettings\(\)/);
  assert.match(app, /if \(!hasAccountProvider\("password", "email"\)\)\s*\{\s*sendProfilePasswordReset/);
  assert.match(app, /\$\("#profilePasswordButton"\)\.onclick = openProfilePasswordSettings/);
  assert.match(app, /\$\("#profileResetPasswordButton"\)\.onclick = \(\) => sendProfilePasswordReset\(\)/);
  assert.match(app, /if \(!hasAccountProvider\("password", "email"\)\)\s*return setFeedback\("passwordChangeFeedback"/);
});
