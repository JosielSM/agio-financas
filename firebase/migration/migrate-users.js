"use strict";

const crypto = require("node:crypto");
const { createClient } = require("@supabase/supabase-js");
const { applicationDefault, initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  console.error(
    "Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY somente neste terminal.",
  );
  process.exit(1);
}

initializeApp({ credential: applicationDefault() });
const firebaseAuth = getAuth();
const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function ensureFirebaseUser(user) {
  const properties = {
    uid: user.id,
    email: user.email,
    emailVerified: Boolean(user.email_confirmed_at),
    displayName:
      user.user_metadata?.full_name || user.email?.split("@")[0] || "Usuário",
    disabled: user.banned_until
      ? new Date(user.banned_until).getTime() > Date.now()
      : false,
    // A senha original não pode ser exportada pela API administrativa do Supabase.
    // A senha aleatória força o usuário a usar "Esqueci minha senha" no primeiro acesso.
    password: `${crypto.randomBytes(32).toString("base64url")}Aa1!`,
  };
  try {
    await firebaseAuth.createUser(properties);
  } catch (error) {
    if (error.code !== "auth/uid-already-exists") throw error;
  }
  const existing = await firebaseAuth.getUser(user.id);
  await firebaseAuth.setCustomUserClaims(user.id, {
    ...(existing.customClaims || {}),
    role: "authenticated",
  });
}

async function migrate() {
  let page = 1;
  let migrated = 0;
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({
      page,
      perPage: 1000,
    });
    if (error) throw error;
    const users = (data.users || []).filter((user) => user.email);
    for (const user of users) {
      await ensureFirebaseUser(user);
      migrated += 1;
    }
    if ((data.users || []).length < 1000) break;
    page += 1;
  }
  console.log(
    `${migrated} conta(s) migrada(s), mantendo os UIDs dos dados financeiros.`,
  );
  console.log(
    "As pessoas devem usar 'Esqueci minha senha' no primeiro acesso ao Firebase.",
  );
}

migrate().catch((error) => {
  console.error("Migração interrompida:", error.message);
  process.exitCode = 1;
});
