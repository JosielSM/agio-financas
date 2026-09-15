import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [firebaseSource, supabaseSource] = await Promise.all([
  readFile(new URL("../firebase-config.js", import.meta.url), "utf8"),
  readFile(new URL("../supabase-config.js", import.meta.url), "utf8"),
]);

const firebaseApiKey = firebaseSource.match(/apiKey:\s*["']([^"']+)["']/)?.[1];
const supabaseUrl = supabaseSource.match(/url:\s*["']([^"']+)["']/)?.[1];
const supabaseKey = supabaseSource.match(
  /publishableKey:\s*["']([^"']+)["']/,
)?.[1];

assert.ok(firebaseApiKey, "Public Firebase configuration is missing");
assert.ok(supabaseUrl && supabaseKey, "Public Supabase configuration is missing");

const probeId = crypto.randomUUID().replaceAll("-", "");
const email = `credmais-smoke-${probeId}@example.com`;
const password = `CredMais9${probeId}Aa`;
let idToken = "";
let platformAccountCreated = false;

const firebase = (operation, body) =>
  fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:${operation}?key=${encodeURIComponent(firebaseApiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );

const supabase = (path, body, token = idToken) =>
  fetch(`${supabaseUrl}/rest/v1/${path}`, {
    method: "POST",
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

try {
  const signup = await firebase("signUp", {
    email,
    password,
    returnSecureToken: true,
  });
  const signupBody = await signup.json();
  assert.equal(
    signup.status,
    200,
    `Firebase test signup failed (${signup.status}): ${signupBody?.error?.message || "unknown error"}`,
  );
  assert.ok(signupBody.idToken && signupBody.localId);
  idToken = signupBody.idToken;

  const ensureAccount = await supabase("rpc/ensure_platform_account", {
    p_display_name: "CredMais security probe",
    p_phone: null,
  });
  const ensureBody = await ensureAccount.json();
  assert.equal(
    ensureAccount.status,
    200,
    `Firebase token was not accepted by Supabase (${ensureAccount.status})`,
  );
  platformAccountCreated = true;
  assert.equal(ensureBody.userId, signupBody.localId);
  assert.equal(ensureBody.status, "pending");

  const access = await supabase("rpc/has_active_platform_access", {});
  assert.equal(access.status, 200);
  assert.equal(await access.json(), false, "A new account received access unexpectedly");

  const rejectedWrite = await supabase("clients", {
    id: crypto.randomUUID(),
    owner_id: signupBody.localId,
    name: "Authenticated boundary probe",
  });
  assert.ok(
    [401, 403].includes(rejectedWrite.status),
    `Direct authenticated write returned unexpected status ${rejectedWrite.status}`,
  );

  const rejectedSync = await supabase("rpc/sync_my_workspace_v1", {
    p_clients: [],
    p_loans: [],
    p_history: [],
    p_profile: {},
  });
  const rejectedSyncBody = await rejectedSync.text();
  assert.ok(
    rejectedSync.status >= 400 && /assinatura|acesso|permission/i.test(rejectedSyncBody),
    `A pending account could write through the protected RPC (${rejectedSync.status})`,
  );

  console.log(
    "CredMais: Firebase, Supabase e bloqueio de assinatura validados com uma conta temporária.",
  );
} finally {
  if (idToken && platformAccountCreated) {
    const cleanup = await supabase("rpc/delete_my_account_data", {});
    assert.ok(
      cleanup.ok,
      `Supabase test account cleanup failed (${cleanup.status})`,
    );
  }
  if (idToken) {
    const cleanup = await firebase("delete", { idToken });
    assert.ok(cleanup.ok, `Firebase test account cleanup failed (${cleanup.status})`);
  }
}
