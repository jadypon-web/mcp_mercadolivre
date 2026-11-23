import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

// .env is loaded from the current working directory first (npx / MCP client
// launches), falling back to the package directory (local clone). Missing
// .env is fine when env vars are provided directly by the MCP client config.
function loadDotEnv(): void {
  let content: string | undefined;
  for (const dir of [process.cwd(), rootDir]) {
    try {
      content = fs.readFileSync(path.join(dir, ".env"), "utf8");
      break;
    } catch {
      // try next location
    }
  }
  if (content === undefined) return;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

// Tokens live in the cwd (npx: where you ran the auth command; overridable
// via ML_TOKENS_FILE). A pre-existing tokens.json in the package directory
// keeps local-clone setups working when launched from another directory.
function resolveTokensFile(): string {
  const fromEnv = (process.env.ML_TOKENS_FILE ?? "").trim();
  if (fromEnv && !fromEnv.includes("${")) return fromEnv;
  if (fromEnv) return path.join(os.homedir(), ".mcp-mercadolivre", "tokens.json");
  const cwdFile = path.join(process.cwd(), "tokens.json");
  const pkgFile = path.join(rootDir, "tokens.json");
  if (fs.existsSync(pkgFile) && !fs.existsSync(cwdFile)) return pkgFile;
  return cwdFile;
}

// Credentials can also be typed in a local browser page (connect_account);
// they are then saved next to the tokens, readable only by the user.
export function credentialsFile(): string {
  return path.join(path.dirname(resolveTokensFile()), "credentials.json");
}

function readSavedCredentials(): { client_id?: string; client_secret?: string } {
  try {
    return JSON.parse(fs.readFileSync(credentialsFile(), "utf8"));
  } catch {
    return {};
  }
}

export function saveCredentials(clientId: string, clientSecret: string): void {
  const file = credentialsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ client_id: clientId, client_secret: clientSecret }, null, 2),
    { mode: 0o600 }
  );
}

// Empty or unresolved placeholders (e.g. "${user_config.x}") count as unset.
function envValue(name: string): string {
  const v = (process.env[name] ?? "").trim();
  return v.startsWith("${") ? "" : v;
}

export const config = {
  get clientId(): string {
    return envValue("ML_CLIENT_ID") || (readSavedCredentials().client_id ?? "");
  },
  get clientSecret(): string {
    return envValue("ML_CLIENT_SECRET") || (readSavedCredentials().client_secret ?? "");
  },
  siteId: process.env.ML_SITE_ID ?? "MLB",
  redirectUri: process.env.ML_REDIRECT_URI ?? "http://localhost:3333/callback",
  tokensFile: resolveTokensFile(),
  readOnly: ["true", "1"].includes(
    (process.env.ML_READ_ONLY ?? "").toLowerCase()
  ),
  toolProfile: process.env.ML_TOOL_PROFILE ?? "all",
};
