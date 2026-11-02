import fs from "node:fs";

/** Scripts run outside Next, so load .env / .env.local ourselves (Next does this for the server). */
for (const f of [".env", ".env.local"]) {
  if (fs.existsSync(f)) process.loadEnvFile(f);
}
