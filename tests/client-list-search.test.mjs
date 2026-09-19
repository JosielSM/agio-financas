import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("client cards use a compact horizontal summary", async () => {
  const [app, css] = await Promise.all([read("app.js"), read("styles.css")]);
  assert.match(app, /class="client-card-open"[^>]*data-client-profile=[^>]*><span class="client-avatar">/);
  assert.match(app, /<span class="client-card-body">/);
  assert.match(css, /\.client-grid\s*\{[^}]*repeat\(auto-fill, minmax\(260px, 1fr\)\);[^}]*gap: 12px;/);
  assert.match(css, /\.client-card\s*\{[^}]*padding: 12px;/);
  assert.match(css, /\.client-card-open\s*\{[^}]*grid-template-columns: 38px minmax\(0, 1fr\);[^}]*min-height: 76px;/);
});

test("active loans can be searched by client without accents", async () => {
  const [app, html] = await Promise.all([read("app.js"), read("index.html")]);
  assert.match(html, /id="loanSearch"[^>]*placeholder="Buscar por cliente, contrato ou valor"/);
  assert.match(html, /id="loanCount"[^>]*aria-live="polite"/);
  assert.match(app, /\$\("#loanSearch"\)\.addEventListener\("input", renderLoans\);/);

  const helper = app.match(/const searchableText = \(\.\.\.values\) =>[\s\S]*?\.toLowerCase\(\);/)?.[0];
  const render = app.match(/function renderLoans\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(helper && render, "loan search implementation exists");

  const elements = {
    "#loanSearch": { value: "jose" },
    "#loanCount": { textContent: "" },
    "#loansList": { innerHTML: "" },
  };
  const context = {
    state: {
      clients: [
        { id: "c1", name: "José Lima", phone: "11999999999", cpf: "" },
        { id: "c2", name: "Maria Souza", phone: "11888888888", cpf: "" },
      ],
      loans: [
        { id: "jose-loan", clientId: "c1", contract: "EMP-101", amount: 300, frequency: 30 },
        { id: "maria-loan", clientId: "c2", contract: "EMP-202", amount: 500, frequency: 15 },
      ],
    },
    $: (selector) => elements[selector],
    isLoanFullyPaid: () => false,
    financialsForLoan: (loan) => ({ receivable: loan.amount }),
    money: (value) => `R$ ${value}`,
    formatFrequency: (value) => `${value} dias`,
    loanRow: (loan) => `<article>${loan.id}</article>`,
  };
  runInNewContext(`${helper}\n${render}\nrenderLoans();`, context);
  assert.match(elements["#loansList"].innerHTML, /jose-loan/);
  assert.doesNotMatch(elements["#loansList"].innerHTML, /maria-loan/);
  assert.equal(elements["#loanCount"].textContent, "1 empréstimo");
});
