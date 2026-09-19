import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("installment actions keep their routes and have recognizable buttons", async () => {
  const [app, css] = await Promise.all([read("app.js"), read("styles.css")]);
  const actions = app.match(/const paymentActions = `([\s\S]*?)`;\s*return `<article class="installment-card/);
  assert.ok(actions, "expanded installments should render an action group");
  for (const action of [
    'data-payment="paid"',
    'data-payment="interest"',
    'data-partial="${loan.id}"',
    'data-postpone="${loan.id}"',
    'data-payment="missed"',
    'data-payment="open"',
  ]) {
    assert.ok(actions[1].includes(action), `${action} should remain available`);
  }
  assert.match(actions[1], /role="group" aria-label="Ações da parcela"/);
  assert.match(app, /const actionIcon = '<span class="payment-action-icon" aria-hidden="true"><\/span>'/);
  assert.equal((actions[1].match(/\$\{actionIcon\}/g) || []).length, 6);
  assert.match(css, /#loanDetails \.payment-actions button\s*\{[^}]*min-height: 64px;[^}]*border: 1px solid var\(--action-border\);/);
  assert.match(css, /#loanDetails \.payment-action-icon::before\s*\{[^}]*width: 22px;[^}]*mask:/);
  assert.match(css, /#loanDetails \.payment-actions button:focus-visible\s*\{/);
  assert.match(css, /#loanDetails \.details-actions-menu button span\s*\{[^}]*font-size: 19px;/);
  assert.match(css, /\.dark #loanDetails \.payment-actions button\[data-payment="missed"\]/);
});

test("only the expanded installment gets a green outline in both themes", async () => {
  const [app, css] = await Promise.all([read("app.js"), read("styles.css")]);
  assert.match(app, /installment-card \$\{visualStatus\} \$\{expanded \? "expanded" : ""\}/);
  assert.match(app, /aria-expanded="\$\{expanded\}"/);
  assert.match(css, /#loanDetails \.installment-card\.expanded\s*\{[^}]*border: 2px solid #079668;[^}]*box-shadow:/);
  assert.match(css, /\.dark #loanDetails \.installment-card\.expanded\s*\{[^}]*border-color: #5ce3a8;/);
});
