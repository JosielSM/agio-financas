import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTENT_SECURITY_POLICY,
  SECURITY_HEADERS,
  handleRequest,
} from "../src/worker.js";

function environment(appKind = "main") {
  return {
    APP_KIND: appKind,
    ASSETS: {
      async fetch() {
        return new Response("<!doctype html><title>CredMais</title>", {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      },
    },
  };
}

test("health check does not expose secrets or user data", async () => {
  const response = await handleRequest(
    new Request("https://credmais.test/api/health"),
    environment(),
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(body).sort(), ["application", "ok", "version"]);
});

test("unknown API route fails closed", async () => {
  const response = await handleRequest(
    new Request("https://credmais.test/api/private"),
    environment(),
  );
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, "NOT_FOUND");
});

test("writes to static routes are rejected", async () => {
  const response = await handleRequest(
    new Request("https://credmais.test/", { method: "POST" }),
    environment(),
  );
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("Allow"), "GET, HEAD");
});

test("admin root redirects only to its isolated application", async () => {
  const response = await handleRequest(
    new Request("https://controle.test/", { redirect: "manual" }),
    environment("admin"),
  );
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), "https://controle.test/admin/");
});

test("security policy blocks framing and browser capabilities", () => {
  assert.equal(SECURITY_HEADERS["X-Frame-Options"], "DENY");
  assert.equal(SECURITY_HEADERS["X-Content-Type-Options"], "nosniff");
  assert.match(CONTENT_SECURITY_POLICY, /frame-ancestors 'none'/);
  assert.match(CONTENT_SECURITY_POLICY, /object-src 'none'/);
  assert.doesNotMatch(CONTENT_SECURITY_POLICY, /script-src[^;]*'unsafe-inline'/);
});
