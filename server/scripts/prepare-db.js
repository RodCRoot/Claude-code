// Picks the Prisma datasource provider based on DATABASE_URL so the same
// schema works for local SQLite dev and Postgres in production.
//
// Run before `prisma generate` / `prisma db push`. Idempotent.

const fs = require("fs");
const path = require("path");

const schemaPath = path.resolve(__dirname, "../prisma/schema.prisma");
const url = process.env.DATABASE_URL || "file:./dev.db";
const isPostgres = /^postgres(ql)?:\/\//.test(url);
const provider = isPostgres ? "postgresql" : "sqlite";

let schema = fs.readFileSync(schemaPath, "utf8");
const updated = schema.replace(
  /(datasource\s+db\s*\{[^}]*?provider\s*=\s*")(sqlite|postgresql)(")/s,
  `$1${provider}$3`
);

if (updated !== schema) {
  fs.writeFileSync(schemaPath, updated);
  console.log(`Prisma datasource provider set to "${provider}".`);
} else {
  console.log(`Prisma datasource provider already "${provider}".`);
}
