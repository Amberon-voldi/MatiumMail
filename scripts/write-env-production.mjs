// Amplify build helper: Amplify exposes console environment variables only at
// BUILD time, but Next.js server code needs them at RUNTIME. This copies the
// app's variables into .env.production (inside the build output; .env* is
// gitignored). Values are JSON-quoted and "$" escaped so Next's dotenv
// expansion can't alter passwords. Values are never printed.
import { appendFileSync } from "node:fs";

const REQUIRED = [
  "APP_URL",
  "DB_HOST",
  "DB_USER",
  "DB_PASSWORD",
  "DB_NAME",
  "DB_TLS",
  "DB_TLS_CA_PEM_BASE64",
  "CREDENTIAL_KEYS",
  "CREDENTIAL_ACTIVE_KEY_ID",
];
const OPTIONAL = ["DB_PORT", "DB_CONNECTION_LIMIT", "SESSION_IDLE_HOURS", "SESSION_ABSOLUTE_DAYS"];

const has = (k) => process.env[k] !== undefined && process.env[k] !== "";
const missing = REQUIRED.filter((k) => !has(k));
if (missing.length) {
  console.error(`Missing Amplify environment variables: ${missing.join(", ")}`);
  process.exit(1);
}
// The server refuses to start without an https:// APP_URL; fail the build instead.
if (!/^https:\/\/[^/\s]+\/?$/.test(process.env.APP_URL)) {
  console.error("APP_URL must be the site's https:// address, e.g. https://webmail.example.com");
  process.exit(1);
}

// Quote so Next's dotenv parser returns the value byte-for-byte:
//  - no double quote  → "…" with "$" escaped (dotenv-expand honours \$)
//  - double quote only → '…' (single-quoted values are taken literally)
//  - both quote kinds  → refuse rather than risk a silently mangled secret
function quote(key, value) {
  if (/[\r\n]/.test(value)) throw new Error(`${key} contains a line break, which .env files can't hold safely.`);
  // Next's dotenv-expand runs inside both quote styles, so "$" is escaped in both.
  if (!value.includes('"')) return `"${value.replaceAll("$", "\\$")}"`;
  if (!value.includes("'")) return `'${value.replaceAll("$", "\\$")}'`;
  throw new Error(`${key} contains both ' and " characters; change it or set it without one of them.`);
}

const keys = [...REQUIRED, ...OPTIONAL].filter(has);
let lines;
try {
  lines = keys.map((k) => `${k}=${quote(k, process.env[k])}`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
appendFileSync(".env.production", lines.join("\n") + "\n");
console.log(`Wrote ${keys.length} variables to .env.production (values not printed)`);
