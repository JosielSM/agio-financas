import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("financial amounts are prominent and never intentionally ellipsized", async () => {
  const css = await read("styles.css");
  assert.match(css, /#appView \.stats strong\s*\{[^}]*font: 700 clamp\(20px, 1\.7vw, 26px\)[^}]*font-variant-numeric: tabular-nums;[^}]*overflow-wrap: anywhere;/);
  assert.match(css, /#appView \.stats article:nth-child\(-n \+ 3\)\s*\{[^}]*grid-column: 1 \/ -1;/);
  assert.match(css, /#appView \.stats article:nth-child\(-n \+ 3\) strong\s*\{[^}]*font-size: clamp\(24px, 7vw, 32px\);/);
  assert.match(css, /\.installment-side strong\s*\{\s*font: 700 20px/);
  assert.match(css, /\.details-summary b\s*\{\s*font: 700 19px/);
  assert.match(css, /#appView \.loan-row \.loan-value\s*\{[^}]*grid-column: 1 \/ -1;/);
  assert.match(css, /\.calculation b\s*\{\s*font: 700 19px/);
});

test("the vector navigation and financial icons are available offline", async () => {
  const [css, sw] = await Promise.all([read("styles.css"), read("sw.js")]);
  assert.match(sw, /credmais-shell-v40/);
  for (const icon of ["home", "users", "wallet", "chart-up", "circle-check", "file-text", "history", "alert", "plus", "pencil", "trash"]) {
    await read(`icons/${icon}.svg`);
    assert.ok(css.includes(`icons/${icon}.svg`), `${icon} is not used in the interface`);
    assert.ok(sw.includes(`/icons/${icon}.svg`), `${icon} is not precached`);
  }
  assert.match(css, /\.bottom-link i\s*\{[^}]*width: 24px;/);
  assert.match(css, /\.stat-icon::before\s*\{[^}]*width: 24px;/);
});
