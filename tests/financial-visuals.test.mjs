import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("financial amounts are prominent and never intentionally ellipsized", async () => {
  const css = await read("styles.css");
  assert.match(css, /#appView \.stats strong\s*\{[^}]*font: 700 clamp\(20px, 1\.7vw, 26px\)[^}]*font-variant-numeric: tabular-nums;[^}]*overflow-wrap: anywhere;/);
  assert.match(css, /#appView \.stats\s*\{[^}]*grid-template-columns: repeat\(6, minmax\(0, 1fr\)\);/);
  assert.match(css, /#appView \.stats article:nth-child\(-n \+ 3\)\s*\{[^}]*grid-column: span 2;/);
  assert.match(css, /#appView \.stats article:nth-child\(-n \+ 3\) strong\s*\{[^}]*font: 700 clamp\(17px, 4\.8vw, 19px\)/);
  assert.match(css, /#appView \.stats article:nth-child\(n \+ 4\)\s*\{[^}]*grid-column: span 3;/);
  assert.match(css, /#appView \.client-stat-values\s*\{[^}]*grid-template-columns: 1fr;/);
  assert.match(css, /#appView \.client-stat-values > span\s*\{[^}]*grid-template-columns: 25px minmax\(0, 1fr\);/);
  assert.match(css, /#appView \.stats article:nth-child\(n \+ 4\) > strong\s*\{[^}]*font: 700 18px/);
  assert.match(css, /#appView \.loan-row \.loan-value b\s*\{[^}]*font-size: 18px;/);
  assert.match(css, /\.installment-side strong\s*\{\s*font: 700 20px/);
  assert.match(css, /\.details-summary b\s*\{\s*font: 700 19px/);
  assert.match(css, /#appView \.loan-row \.loan-value\s*\{[^}]*grid-column: 1 \/ -1;/);
  assert.match(css, /\.calculation b\s*\{\s*font: 700 19px/);
});

test("the vector navigation and financial icons are available offline", async () => {
  const [css, sw] = await Promise.all([read("styles.css"), read("sw.js")]);
  assert.match(sw, /credmais-shell-v48/);
  for (const icon of ["home", "users", "wallet", "chart-up", "circle-check", "file-text", "history", "alert", "plus", "pencil", "trash"]) {
    await read(`icons/${icon}.svg`);
    assert.ok(css.includes(`icons/${icon}.svg`), `${icon} is not used in the interface`);
    assert.ok(sw.includes(`/icons/${icon}.svg`), `${icon} is not precached`);
  }
  assert.match(css, /\.bottom-link i\s*\{[^}]*width: 24px;/);
  assert.match(css, /\.stat-icon::before\s*\{[^}]*width: 24px;/);
});

test("dashboard money cards distinguish capital, receivables and monthly receipts in both themes", async () => {
  const [css, html] = await Promise.all([read("styles.css"), read("index.html")]);
  for (const id of ["statLent", "statReceivable", "statReceived"])
    assert.match(html, new RegExp(`id="${id}"`));
  for (const position of [1, 2, 3]) {
    assert.match(css, new RegExp(`#appView \\.stats article:nth-child\\(${position}\\) \\{[^}]*--metric-number:`));
    assert.match(css, new RegExp(`\\.dark #appView \\.stats article:nth-child\\(${position}\\) \\{[^}]*--metric-number:`));
  }
  assert.match(css, /#appView \.stats article:nth-child\(-n \+ 3\)\s*\{[^}]*border-top: 4px solid var\(--metric-accent\);[^}]*linear-gradient/);
  assert.match(css, /#appView \.stats article:nth-child\(-n \+ 3\) > strong\s*\{[^}]*color: var\(--metric-number\);/);
  assert.match(css, /@media \(max-width: 680px\)\s*\{\s*#appView \.stats article:nth-child\(-n \+ 3\)/);
});

test("client and active-loan cards remain distinct and readable on mobile and in dark mode", async () => {
  const [css, html] = await Promise.all([read("styles.css"), read("index.html")]);
  for (const id of ["statClients", "statActiveClients", "statLoans"])
    assert.match(html, new RegExp(`id="${id}"`));
  for (const position of [4, 5]) {
    assert.match(css, new RegExp(`#appView \\.stats article:nth-child\\(${position}\\) \\{[^}]*--metric-number:`));
    assert.match(css, new RegExp(`\\.dark #appView \\.stats article:nth-child\\(${position}\\) \\{[^}]*--metric-number:`));
  }
  assert.match(css, /#appView \.stats article:nth-child\(n \+ 4\)\s*\{[^}]*border-top: 4px solid var\(--metric-accent\);[^}]*linear-gradient/);
  assert.match(css, /#appView \.stats article:nth-child\(4\) \.client-stat-values\s*\{[^}]*grid-template-columns: 1fr;/);
  assert.match(css, /#appView \.stats article:nth-child\(4\) \.client-stat-values > span\s*\{[^}]*grid-template-columns: 29px minmax\(0, 1fr\);/);
});
