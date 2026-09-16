import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("client CPF is optional and receives accessible validation feedback", async () => {
  const [html, app] = await Promise.all([read("index.html"), read("app.js")]);
  const cpfInput = html.match(/<input id="clientCpf"[^>]*>/)?.[0] || "";

  assert.match(html, /CPF \(opcional\)/);
  assert.ok(cpfInput, "expected the CPF field");
  assert.doesNotMatch(cpfInput, /\brequired\b/);
  assert.match(cpfInput, /aria-describedby="clientCpfHelp"/);
  assert.match(html, /id="clientCpfHelp"/);
  assert.match(app, /function isValidCpf\(value\)/);
  assert.match(app, /\^\(\\d\)\\1\{10\}\$/);
  assert.match(app, /verificationDigit\(9\)/);
  assert.match(app, /verificationDigit\(10\)/);
  assert.match(app, /cpf: cpf \? formatCpf\(cpf\) : ""/);
  assert.match(app, /CPF inválido\. Corrija os números ou deixe o campo em branco\./);

  const validatorSource = app.match(
    /function isValidCpf\(value\) \{[\s\S]*?\n\}\nfunction renderClientCpfValidation/,
  )?.[0].replace(/\nfunction renderClientCpfValidation$/, "");
  assert.ok(validatorSource, "expected to extract the production CPF validator");
  const isValidCpf = Function(
    "digits",
    `${validatorSource}; return isValidCpf;`,
  )((value) => String(value || "").replace(/\D/g, ""));

  assert.equal(isValidCpf("529.982.247-25"), true);
  assert.equal(isValidCpf("529.982.247-24"), false);
  assert.equal(isValidCpf("111.111.111-11"), false);
  assert.equal(isValidCpf(""), false);
});

test("client CPF validation is also enforced by the database facade", async () => {
  const [sql, verification] = await Promise.all([
    read("supabase/migrations/20260916210000_optional_validated_client_cpf.sql"),
    read("supabase-cpf-validation-verification.sql"),
  ]);

  assert.match(sql, /private\.is_valid_optional_cpf/i);
  assert.match(sql, /security definer\s+set search_path = ''/i);
  assert.match(sql, /not private\.is_valid_optional_cpf\(item->>'cpf'\)/i);
  assert.match(sql, /existing\.cpf is not distinct from coalesce\(item->>'cpf', ''\)/i);
  assert.match(sql, /private\.sync_my_workspace_core_v1/i);
  assert.match(sql, /grant execute on function public\.sync_my_workspace_v1/i);
  assert.match(verification, /private\.is_valid_optional_cpf\(''\)/i);
  assert.match(verification, /529\.982\.247-25/);
  assert.match(verification, /529\.982\.247-24/);
  assert.match(verification, /rollback;/i);
});
