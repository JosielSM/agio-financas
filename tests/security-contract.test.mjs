import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("browser mutations use validated database functions", async () => {
  const bridge = await read("supabase-bridge.js");
  const directWrite =
    /\.from\(["'](?:clients|loans|activity_history|profiles|platform_accounts|platform_settings)["']\)[\s\S]{0,100}?\.(?:insert|upsert|update|delete)\(/;
  assert.doesNotMatch(bridge, directWrite);
  for (const rpc of [
    "sync_my_workspace_v1",
    "save_my_profile_v1",
    "delete_my_loan_v1",
    "delete_my_client_v1",
    "admin_update_platform_account_v3",
    "admin_update_platform_settings_v4",
  ]) {
    assert.match(bridge, new RegExp(`\\b${rpc}\\b`));
  }
  assert.doesNotMatch(bridge, /bootstrap_platform_admin/);
  assert.match(bridge, /acesso foi bloqueado por segurança/i);
  assert.doesNotMatch(bridge, /compatible = await client\.rpc/);
});

test("database migration removes direct writes and cross-tenant links", async () => {
  const sql = await read(
    "supabase/migrations/20260914214500_production_hardening.sql",
  );
  assert.match(sql, /foreign key \(client_id, owner_id\)/i);
  assert.match(sql, /revoke all on public\.loans from public, anon, authenticated/i);
  assert.match(sql, /add column if not exists expiry_notified_at timestamptz/i);
  assert.match(sql, /security definer\s+set search_path = ''/i);
  assert.match(sql, /workspace_audit_log/i);
  assert.match(sql, /ADMIN_BOOTSTRAP_DISABLED/);
  assert.match(sql, /has_function_privilege\('anon', 'public\.bootstrap_platform_admin\(text\)'/i);
  assert.match(sql, /commit;\s*$/i);
});

test("production verification independently checks every database boundary", async () => {
  const sql = await read("supabase-production-verification.sql");
  assert.match(sql, /expiry_notified_at/i);
  assert.match(sql, /loans_client_owner_id_fkey/i);
  assert.match(sql, /privilege_type in \('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'\)/i);
  assert.match(sql, /cmd <> 'SELECT'/i);
  assert.match(sql, /bootstrap_platform_admin\(text\)/i);
  assert.match(sql, /admin_update_platform_settings_v4\(numeric,text,integer,text,text\)/i);
  assert.match(sql, /trial_days between 1 and 90/i);
  assert.match(sql, /search_path=%/i);
});

test("access-control verification covers every manual subscription path", async () => {
  const sql = await read("supabase-access-control-verification.sql");
  assert.match(sql, /admin_grant_platform_access_v5/i);
  assert.match(sql, /15,\s*'days'[\s\S]*?'launch_locked'[\s\S]*?'free'/i);
  assert.match(sql, /admin_grant_platform_lifetime_v2/i);
  assert.match(sql, /admin_set_platform_status\(test_user_id, 'blocked'\)/i);
  assert.match(sql, /make_interval\(months => 2\)/i);
  assert.match(sql, /rollback;/i);
});

test("authenticated production probe deletes its temporary accounts", async () => {
  const probe = await read("scripts/verify-auth-boundary.mjs");
  assert.match(probe, /finally\s*{/i);
  assert.match(probe, /rpc\/delete_my_account_data/i);
  assert.match(probe, /firebase\("delete", \{ idToken \}\)/i);
});

test("free backup includes operational data and stays outside the repository", async () => {
  const [query, script] = await Promise.all([
    read("scripts/backup-query.sql"),
    read("scripts/backup-credmais.ps1"),
  ]);
  for (const table of [
    "platform_settings",
    "platform_accounts",
    "platform_admins",
    "clients",
    "loans",
    "activity_history",
    "profiles",
    "platform_access_log",
    "workspace_audit_log",
  ]) {
    assert.match(query, new RegExp(`public\\.${table}\\b`));
  }
  assert.doesNotMatch(query, /platform_admin_bootstrap/i);
  assert.match(script, /CredMais Backups/);
  assert.match(script, /A pasta de backup deve ficar fora do repositório Git/);
  assert.match(script, /Get-FileHash[\s\S]*SHA256/i);
  assert.match(script, /RetentionDays/);
  assert.match(script, /expectedTemporaryPrefix/);
});

test("production builds do not publish SQL or the other application", async () => {
  const main = join(fileURLToPath(new URL("dist/main/", root)), "index.html");
  const admin = join(
    fileURLToPath(new URL("dist/admin/", root)),
    "admin",
    "index.html",
  );
  await Promise.all([access(main), access(admin)]);

  await assert.rejects(access(new URL("dist/main/admin/index.html", root)));
  await assert.rejects(access(new URL("dist/admin/app.js", root)));
  await assert.rejects(
    access(
      new URL(
        "dist/main/supabase/migrations/20260914214500_production_hardening.sql",
        root,
      ),
    ),
  );
});

test("offline cached subscription cannot authorize a write", async () => {
  const app = await read("app.js");
  assert.match(app, /if \(access\?\.offline\) return false;/);
  assert.match(app, /clearSignedOutData\(\)/);
  assert.match(app, /credmais_cache_owner/);
});

test("strict CSP is compatible with every published HTML page", async () => {
  for (const page of ["index.html", "auth-action.html", "admin/index.html"]) {
    const html = await read(page);
    assert.doesNotMatch(
      html,
      /<script\b(?![^>]*\bsrc\s*=)[^>]*>[\s\S]*?<\/script>/i,
      `${page} contains an inline script blocked by production CSP`,
    );
    assert.doesNotMatch(
      html,
      /\son[a-z]+\s*=/i,
      `${page} contains an inline event handler blocked by production CSP`,
    );
  }
});
