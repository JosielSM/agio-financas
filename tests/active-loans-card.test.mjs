import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const app = await readFile(new URL("../app.js", import.meta.url), "utf8");

test("active-loan summary counts open, overdue and paid installments", () => {
  const source = app.match(/function activeLoanOperationalSummary\(loans\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(source, "active loan summary helper exists");
  const context = {
    paymentStateFor: (loan, index) => loan.states[index],
    dateFor: (loan, index) => loan.dueStates[index],
    dueStatus: (status) => status,
  };
  const result = runInNewContext(
    `${source}\nactiveLoanOperationalSummary([
      { installments: 3, states: ["paid", "open", "missed"], dueStates: ["A vencer", "A vencer", "A vencer"] },
      { installments: 2, states: ["partial", "open"], dueStates: ["Vencida", "Vencida"] }
    ]);`,
    context,
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(result)),
    { total: 5, paid: 1, open: 4, overdue: 3, progress: 20 },
  );
});

test("dashboard renders the operational state and updates accessible progress", () => {
  assert.match(app, /loanAlert\.classList\.toggle\("overdue", loanOperations\.overdue > 0\)/);
  assert.match(app, /loanProgress\.style\.setProperty\("--active-progress", `\$\{loanOperations\.progress\}%`\)/);
  assert.match(app, /loanProgress\.setAttribute\("aria-valuenow", String\(loanOperations\.progress\)\)/);
  assert.match(app, /`\$\{loanOperations\.progress\}% das parcelas quitadas`/);
});
