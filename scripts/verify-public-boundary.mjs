import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const configSource = await readFile(
  new URL("../supabase-config.js", import.meta.url),
  "utf8",
);
const projectUrl = configSource.match(/url:\s*["']([^"']+)["']/)?.[1];
const publishableKey = configSource.match(
  /publishableKey:\s*["']([^"']+)["']/,
)?.[1];
assert.ok(projectUrl && publishableKey, "Public Supabase configuration is missing");

const headers = {
  apikey: publishableKey,
  "Content-Type": "application/json",
};
const api = (path, options = {}) =>
  fetch(`${projectUrl}/rest/v1/${path}`, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) },
  });

for (const table of ["clients", "loans", "profiles", "platform_accounts"]) {
  const response = await api(`${table}?select=*&limit=1`);
  assert.equal(response.status, 200, `${table} should support an RLS-protected read`);
  assert.deepEqual(
    await response.json(),
    [],
    `${table} leaked data without an authenticated user`,
  );
}

const rejectedWrite = await api("clients", {
  method: "POST",
  headers: { Prefer: "return=representation" },
  body: JSON.stringify({
    id: crypto.randomUUID(),
    owner_id: crypto.randomUUID(),
    name: "Security boundary probe",
    cpf: "00000000000",
    phone: "0000000000",
  }),
});
assert.ok(
  [401, 403].includes(rejectedWrite.status),
  `Unauthenticated write returned unexpected status ${rejectedWrite.status}`,
);

const bootstrap = await api("rpc/bootstrap_platform_admin", {
  method: "POST",
  body: JSON.stringify({ p_activation_code: "disabled-security-probe" }),
});
const bootstrapBody = await bootstrap.text();
assert.ok(
  [400, 401, 403, 404].includes(bootstrap.status) &&
    /permission denied|not found|could not find|ADMIN_BOOTSTRAP_DISABLED|PGRST202/i.test(
      bootstrapBody,
    ),
  `Disabled bootstrap returned an unsafe response (${bootstrap.status}): ${bootstrapBody.slice(0, 240)}`,
);

const ensureAccount = await api("rpc/ensure_platform_account", {
  method: "POST",
  body: JSON.stringify({ p_display_name: "", p_phone: null }),
});
assert.ok(
  ensureAccount.status >= 400,
  "An unauthenticated request created a platform account",
);

const resetAccess = await api("rpc/admin_reset_platform_access_v1", {
  method: "POST",
  body: JSON.stringify({ p_user_id: "unauthenticated-security-probe" }),
});
assert.ok(
  resetAccess.status >= 400,
  "An unauthenticated request reset a platform subscription",
);

const billingDashboard = await api("rpc/admin_get_platform_billing_dashboard_v1", {
  method: "POST",
  body: "{}",
});
assert.ok(
  billingDashboard.status >= 400,
  "An unauthenticated request read the administrative payment dashboard",
);

console.log("CredMais: fronteira pública do Supabase validada.");
