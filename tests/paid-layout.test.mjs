import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("settled loans and paid installments have separate, persistent views", async () => {
  const app = await read("app.js");
  const functions = ["renderPaid", "paidInstallmentDate", "selectPaidView"]
    .map((name) => app.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`))?.[0]);
  assert.ok(functions.every(Boolean));

  const nodes = Object.fromEntries([
    "paidLoanCount", "paidInstallmentCount", "paidLoansList", "paidInstallmentsList",
    "paidLoansPanel", "paidInstallmentsPanel",
  ].map((id) => [id, { textContent: "", innerHTML: "", hidden: false }]));
  const tabs = ["loans", "installments"].map((paidView) => ({
    dataset: { paidView },
    classList: { contains: (value) => value === "paid-view-tab" },
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
  }));
  const state = {
    paidView: "loans",
    clients: [{ id: "c1", name: "Ana" }, { id: "c2", name: "Bia" }],
    loans: [
      {
        id: "fully-paid", clientId: "c1", contract: "EMP-001", installments: 2,
        paymentStates: [
          { status: "paid", receivedTotal: 50, createdAt: "2026-09-10T12:00:00Z" },
          { status: "paid", receivedTotal: 50, createdAt: "2026-09-12T12:00:00Z" },
        ],
      },
      {
        id: "partly-paid", clientId: "c2", contract: "EMP-002", installments: 2,
        paymentStates: [
          { status: "paid", receivedTotal: 30, createdAt: "2026-09-11T12:00:00Z" },
          { status: "open" },
        ],
      },
    ],
  };
  const context = {
    state,
    document: { querySelectorAll: () => tabs },
    $: (selector) => nodes[selector.slice(1)],
    isLoanFullyPaid: (loan) => loan.paymentStates.every((payment) => payment.status === "paid"),
    paymentStateFor: (loan, index) => loan.paymentStates[index].status,
    installmentInfo: () => ({ due: 50 }),
    receivedAmountFor: (loan, index) => loan.paymentStates[index].receivedTotal || 0,
    financialsForLoan: (loan) => ({
      received: loan.paymentStates.reduce((sum, payment) => sum + (payment.receivedTotal || 0), 0),
    }),
    dateFor: () => new Date("2026-09-01T12:00:00Z"),
    escapeHtml: (value) => value,
    money: (value) => `R$ ${Number(value).toFixed(2)}`,
  };
  const actions = runInNewContext(
    `${functions.join("\n")}\n({ renderPaid, selectPaidView })`,
    context,
  );
  actions.renderPaid();
  assert.equal(nodes.paidLoanCount.textContent, 1);
  assert.equal(nodes.paidInstallmentCount.textContent, 3);
  assert.match(nodes.paidLoansList.innerHTML, /EMP-001/);
  assert.doesNotMatch(nodes.paidLoansList.innerHTML, /EMP-002/);
  assert.equal((nodes.paidInstallmentsList.innerHTML.match(/class="settlement-card"/g) || []).length, 3);
  assert.match(nodes.paidInstallmentsList.innerHTML, /EMP-002/);
  assert.equal(nodes.paidLoansPanel.hidden, false);
  assert.equal(nodes.paidInstallmentsPanel.hidden, true);

  actions.selectPaidView("installments");
  actions.renderPaid();
  assert.equal(state.paidView, "installments");
  assert.equal(nodes.paidLoansPanel.hidden, true);
  assert.equal(nodes.paidInstallmentsPanel.hidden, false);
  assert.equal(tabs[1].attributes["aria-pressed"], "true");
});

test("paid cards reserve a full content column on narrow screens", async () => {
  const [html, css, app] = await Promise.all([
    read("index.html"), read("styles.css"), read("app.js"),
  ]);
  assert.match(html, /id="paidLoansPanel"/);
  assert.match(html, /id="paidInstallmentsPanel"/);
  assert.match(html, /class="paid-view-tab"[^>]*data-paid-view="loans"/);
  assert.match(html, /class="paid-view-tab"[^>]*data-paid-view="installments"/);
  assert.match(css, /\.settlement-card \{[\s\S]*?grid-template-columns: 38px minmax\(0, 1fr\)/);
  assert.match(css, /\.settlement-content \{\s*min-width: 0/);
  assert.match(css, /@media \(max-width: 680px\) \{[\s\S]*?\.settlement-card \{\s*grid-template-columns: 34px minmax\(0, 1fr\)/);
  assert.doesNotMatch(css, /\.paid-card/);
  assert.match(app, /if \(button\.dataset\.paidView\) \{\s*selectPaidView\(button\.dataset\.paidView\)/);
});
