import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outputRoot = join(root, "dist");

const shared = [
  "firebase-config.js",
  "firebase-bridge.js",
  "supabase-config.js",
  "supabase-bridge.js",
  "vendor/firebase-app-compat.js",
  "vendor/firebase-auth-compat.js",
  "vendor/supabase.min.js",
  "icons",
];
const main = [
  "index.html",
  "styles.css",
  "app.js",
  "auth-action.html",
  "auth-action.js",
  "manifest.webmanifest",
  "offline.html",
  "sw.js",
  "vendor",
];
const admin = ["admin"];

async function copyEntries(entries, destination) {
  for (const entry of entries) {
    const target = join(destination, entry);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(root, entry), target, { recursive: true });
  }
}

await rm(outputRoot, { recursive: true, force: true });
await Promise.all([
  mkdir(join(outputRoot, "main"), { recursive: true }),
  mkdir(join(outputRoot, "admin"), { recursive: true }),
]);
await Promise.all([
  copyEntries([...shared, ...main], join(outputRoot, "main")),
  copyEntries([...shared, ...admin], join(outputRoot, "admin")),
]);

console.log("CredMais: ativos públicos gerados em dist/main e dist/admin.");
