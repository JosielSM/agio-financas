import assert from "node:assert/strict";

const MAIN = "https://agio-financas.santosjosiel2003.workers.dev";
const ADMIN = "https://credmais-controle.santosjosiel2003.workers.dev";

async function request(url, options) {
  const response = await fetch(url, options);
  return { response, body: await response.text() };
}

function verifySecurityHeaders(response) {
  assert.match(
    response.headers.get("content-security-policy") || "",
    /frame-ancestors 'none'/,
  );
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.match(
    response.headers.get("strict-transport-security") || "",
    /max-age=31536000/,
  );
}

for (const [origin, application] of [
  [MAIN, "credmais"],
  [ADMIN, "credmais-controle"],
]) {
  const { response, body } = await request(`${origin}/api/health`);
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(body).application, application);
  verifySecurityHeaders(response);
}

const mainPage = await request(`${MAIN}/`);
assert.equal(mainPage.response.status, 200);
assert.match(mainPage.body, /CredMais/);
assert.match(mainPage.body, /vendor\/supabase\.min\.js/);
assert.match(mainPage.body, /vendor\/firebase-auth-compat\.js/);
assert.doesNotMatch(mainPage.body, /<script[^>]+(?:gstatic|jsdelivr)/i);
assert.doesNotMatch(
  mainPage.body,
  /<script\b(?![^>]*\bsrc\s*=)[^>]*>[\s\S]*?<\/script>/i,
);
verifySecurityHeaders(mainPage.response);

const adminPage = await request(`${ADMIN}/admin/`);
assert.equal(adminPage.response.status, 200);
assert.match(adminPage.body, /CredMais Controle/);
assert.doesNotMatch(adminPage.body, /Criar conta administrativa/i);
assert.match(adminPage.body, /vendor\/supabase\.min\.js/);
assert.match(adminPage.body, /vendor\/firebase-auth-compat\.js/);
assert.doesNotMatch(adminPage.body, /<script[^>]+(?:gstatic|jsdelivr)/i);
verifySecurityHeaders(adminPage.response);

for (const origin of [MAIN, ADMIN]) {
  for (const asset of [
    "/vendor/firebase-app-compat.js",
    "/vendor/firebase-auth-compat.js",
    "/vendor/supabase.min.js",
  ]) {
    const sdk = await request(`${origin}${asset}`);
    assert.equal(sdk.response.status, 200, `${origin}${asset} is unavailable`);
    assert.match(
      sdk.response.headers.get("content-type") || "",
      /javascript/,
      `${origin}${asset} has an invalid content type`,
    );
    assert.ok(sdk.body.length > 20_000, `${origin}${asset} is incomplete`);
  }
}

const adminRedirect = await request(`${ADMIN}/`, { redirect: "manual" });
assert.equal(adminRedirect.response.status, 302);
assert.equal(adminRedirect.response.headers.get("location"), `${ADMIN}/admin/`);

const [adminLeak, legacySqlLeak, migrationLeak, rejectedPost, unknownApi] =
  await Promise.all([
  request(`${MAIN}/admin/index.html`),
  request(`${MAIN}/supabase-production-hardening-migration.sql`),
  request(
    `${MAIN}/supabase/migrations/20260914214500_production_hardening.sql`,
  ),
  request(`${MAIN}/`, { method: "POST" }),
  request(`${MAIN}/api/private`),
]);
assert.equal(adminLeak.response.status, 404);
assert.equal(legacySqlLeak.response.status, 404);
assert.equal(migrationLeak.response.status, 404);
assert.equal(rejectedPost.response.status, 405);
assert.equal(unknownApi.response.status, 404);

console.log("CredMais: produção validada nos dois Workers.");
