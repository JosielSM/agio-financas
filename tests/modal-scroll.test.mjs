import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("mobile modals scroll inside the area still visible above the keyboard", async () => {
  const [css, app, html] = await Promise.all([
    read("styles.css"),
    read("app.js"),
    read("index.html"),
  ]);
  assert.match(css, /top: var\(--modal-visual-top/);
  assert.match(css, /max-height: var\(\s*--modal-visual-height/);
  assert.match(css, /overflow-y: auto;/);
  assert.match(app, /window\.visualViewport\?\.addEventListener\("resize"/);
  assert.match(app, /window\.visualViewport\?\.addEventListener\("scroll"/);
  assert.match(app, /requestAnimationFrame\(keepFocusedModalFieldVisible\)/);
  assert.match(html, /id="clientModal"[\s\S]*?id="clientSaveBtn"/);
});

test("visual viewport sizing leaves room to scroll after the phone keyboard opens", async () => {
  const app = await read("app.js");
  const source = app.match(/function syncModalViewport\(\) \{[\s\S]*?\n\}\nfunction clearModalViewport/)?.[0]
    .replace(/\nfunction clearModalViewport$/, "");
  assert.ok(source, "viewport synchronizer should exist");
  const values = new Map();
  const style = {
    setProperty(name, value) { values.set(name, value); },
    removeProperty(name) { values.delete(name); },
  };
  const context = {
    document: {
      body: { classList: { contains: () => true } },
      documentElement: { style },
    },
    window: {
      innerWidth: 390,
      innerHeight: 760,
      visualViewport: { height: 330, offsetTop: 24 },
    },
  };
  runInNewContext(`${source}\nsyncModalViewport();`, context);
  assert.equal(values.get("--modal-visual-top"), "32px");
  assert.equal(values.get("--modal-visual-height"), "314px");

  context.window.innerWidth = 900;
  runInNewContext(`${source}\nsyncModalViewport();`, context);
  assert.equal(values.has("--modal-visual-top"), false);
  assert.equal(values.has("--modal-visual-height"), false);
});
