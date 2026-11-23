import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const serverDirectory = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const repositoryDirectory = resolve(serverDirectory, "..");
const loaded = dotenv.config({ path: resolve(repositoryDirectory, ".env.local"), override: true });
if (loaded.error) throw loaded.error;

const action = process.argv[2];
if (action !== "status" && action !== "deploy") {
  throw new Error("Usage: node scripts/neon-prisma.mjs <status|deploy>");
}

if (!process.env.DATABASE_URL || !process.env.DATABASE_URL_UNPOOLED) {
  throw new Error("Root .env.local must contain Neon DATABASE_URL and DATABASE_URL_UNPOOLED.");
}

process.env.DIRECT_URL = process.env.DATABASE_URL_UNPOOLED;
const prismaCli = resolve(repositoryDirectory, "node_modules", "prisma", "build", "index.js");
const result = spawnSync(process.execPath, [prismaCli, "migrate", action], {
  cwd: serverDirectory,
  env: process.env,
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
