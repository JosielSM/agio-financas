import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("client profile shows loan history and only offers installments when present", async () => {
  const app = await read("app.js");
  const render = app.match(/function renderClientProfile\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(render, "client profile renderer exists");

  const content = { innerHTML: "" };
  const state = { clients: [{ id: "c1", name: "Ana Silva", phone: "11999999999", cpf: "", note: "" }], loans: [] };
  const context = {
    state,
    $: (selector) => selector === "#clientProfileContent" ? content : null,
    closeModals: () => { throw new Error("client should exist"); },
    initials: () => "AS",
    escapeHtml: (value) => String(value),
    money: (value) => `R$ ${Number(value || 0).toFixed(2)}`,
    isLoanFullyPaid: (loan) => loan.paymentStates.every((payment) => payment === "paid"),
    paymentStateFor: (loan, index) => loan.paymentStates[index],
    dateFor: (_, index) => new Date(`2026-09-${String(index + 10).padStart(2, "0")}T12:00:00Z`),
    financialsForLoan: (loan) => ({ receivable: loan.paymentStates.includes("open") ? loan.amount : 0 }),
    installmentStatus: (loan, index) => loan.paymentStates[index] === "paid" ? "Quitada" : "A vencer",
    installmentStatusClass: (status) => status === "Quitada" ? "status-paid" : "status-upcoming",
    installmentInfo: () => ({ due: 50 }),
    lateCharge: () => ({ value: 0 }),
    receivedAmountFor: () => 50,
  };
  const actions = runInNewContext(
    `let selectedClientProfileId = "c1"; let clientProfileTab = "loans"; ${render}\n({ renderClientProfile, showInstallments() { clientProfileTab = "installments"; renderClientProfile(); } })`,
    context,
  );

  actions.renderClientProfile();
  assert.match(content.innerHTML, /Nenhum empréstimo ainda/);
  assert.doesNotMatch(content.innerHTML, /data-client-profile-tab="installments"/);

  state.loans = [{ id: "without-installments", clientId: "c1", contract: "EMP-000", amount: 100, installments: 0, paymentStates: [], createdAt: "2026-07-01T12:00:00Z" }];
  actions.renderClientProfile();
  assert.match(content.innerHTML, /EMP-000/);
  assert.doesNotMatch(content.innerHTML, /data-client-profile-tab="installments"/);

  state.loans = [
    { id: "old", clientId: "c1", contract: "EMP-001", amount: 100, installments: 1, paymentStates: ["paid"], createdAt: "2026-08-01T12:00:00Z" },
    { id: "new", clientId: "c1", contract: "EMP-002", amount: 200, installments: 2, paymentStates: ["open", "paid"], createdAt: "2026-09-01T12:00:00Z" },
    { id: "other", clientId: "c2", contract: "EMP-OTHER", amount: 300, installments: 1, paymentStates: ["open"] },
  ];
  actions.renderClientProfile();
  assert.match(content.innerHTML, /Empréstimos <b>2<\/b>/);
  assert.match(content.innerHTML, /Parcelas <b>3<\/b>/);
  assert.match(content.innerHTML, /EMP-001/);
  assert.match(content.innerHTML, /EMP-002/);
  assert.doesNotMatch(content.innerHTML, /EMP-OTHER/);
  assert.ok(content.innerHTML.indexOf("EMP-002") < content.innerHTML.indexOf("EMP-001"), "newest loan comes first");
  assert.match(content.innerHTML, /data-client-loan="new"/);
  assert.match(content.innerHTML, /Quitado/);

  actions.showInstallments();
  assert.equal((content.innerHTML.match(/class="client-installment-row"/g) || []).length, 3);
  assert.match(content.innerHTML, /data-client-installment="0"/);
  assert.doesNotMatch(content.innerHTML, /EMP-OTHER/);
});

test("client list opens a profile without losing direct edit and delete actions", async () => {
  const [app, html, css] = await Promise.all([read("app.js"), read("index.html"), read("styles.css")]);
  assert.match(html, /id="clientProfileModal"[^>]*aria-labelledby="clientProfileTitle"/);
  assert.match(app, /class="client-card-open"[^>]*data-client-profile=/);
  assert.match(app, /if \(button\.dataset\.clientProfile\) \{\s*openClientProfile/);
  assert.match(app, /if \(button\.dataset\.clientLoan\) \{\s*openClientLoanDetails/);
  assert.match(app, /data-edit-client=/);
  assert.match(app, /data-delete-client=/);
  assert.match(css, /\.client-profile-modal \{[\s\S]*?width: min\(720px/);
  assert.match(css, /@media \(max-width: 680px\) \{[\s\S]*?\.client-profile-modal \{/);
});
