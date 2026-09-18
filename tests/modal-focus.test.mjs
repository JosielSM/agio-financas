import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("both apps blur the background behind every dialog", async () => {
  const [mainCss, adminCss, mainHtml, adminHtml] = await Promise.all([
    read("styles.css"),
    read("admin/styles.css"),
    read("index.html"),
    read("admin/index.html"),
  ]);
  assert.match(mainCss, /\.modal-backdrop\s*\{[^}]*-webkit-backdrop-filter: blur\(8px\)[^}]*backdrop-filter: blur\(8px\)/);
  assert.match(adminCss, /\.backdrop\s*\{[^}]*-webkit-backdrop-filter: blur\(8px\)[^}]*backdrop-filter: blur\(8px\)/);
  assert.match(mainHtml, /id="modalBackdrop" hidden/);
  assert.match(adminHtml, /id="modalBackdrop" hidden/);
  assert.match(mainCss, /\.modal\.modal-underlay\s*\{[^}]*filter: blur\(5px\);[^}]*pointer-events: none;/);
});

test("a second dialog blurs the previous one and restores it when closed", async () => {
  const app = await read("app.js");
  const source = app.match(/function syncModalLayers\(activeModal = null\) \{[\s\S]*?\n\}\nfunction openModal/)?.[0]
    .replace(/\nfunction openModal$/, "");
  assert.ok(source, "modal layer synchronizer should exist");
  const modal = () => {
    const classes = new Set();
    const attributes = new Map();
    return {
      hidden: false,
      classes,
      attributes,
      classList: { toggle(name, active) { if (active) classes.add(name); else classes.delete(name); } },
      setAttribute(name, value) { attributes.set(name, value); },
      removeAttribute(name) { attributes.delete(name); },
      focus() { this.focused = true; },
    };
  };
  const first = modal();
  const second = modal();
  const background = { inert: false };
  const context = {
    document: {
      querySelectorAll: () => [first, second],
      getElementById: () => background,
    },
    first,
    second,
  };
  runInNewContext(`${source}\nsyncModalLayers(second);`, context);
  assert.equal(first.classes.has("modal-underlay"), true);
  assert.equal(first.attributes.get("aria-hidden"), "true");
  assert.equal(second.focused, true);
  assert.equal(background.inert, true);
  second.hidden = true;
  runInNewContext(`${source}\nsyncModalLayers();`, context);
  assert.equal(first.classes.has("modal-underlay"), false);
  assert.equal(first.attributes.has("aria-hidden"), false);
  first.hidden = true;
  runInNewContext(`${source}\nsyncModalLayers();`, context);
  assert.equal(background.inert, false);
});
