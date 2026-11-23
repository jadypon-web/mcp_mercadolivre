// Browser OAuth flow shared by the `npm run auth` CLI and the connect_account
// tool (so the account can be connected from the chat, without a terminal).
import http from "node:http";
import { spawn } from "node:child_process";
import { buildAuthUrl, exchangeCodeForTokens } from "./auth.js";
import { config } from "./config.js";

export function openInBrowser(url: string): void {
  try {
    if (process.platform === "win32") {
      // `start` treats the first quoted argument as the window title.
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    } else {
      const opener = process.platform === "darwin" ? "open" : "xdg-open";
      spawn(opener, [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    // caller shows the URL anyway
  }
}

export interface AuthFlowResult {
  ok: boolean;
  message: string;
  authUrl: string;
}

// Listens on the redirect URI, opens the authorization page and resolves when
// Meli redirects back with ?code= (or on timeout).
export function runAuthFlow(
  options: { timeoutMs?: number; openBrowser?: boolean; log?: (m: string) => void } = {}
): Promise<AuthFlowResult> {
  const { timeoutMs = 180_000, openBrowser = true, log = () => {} } = options;
  if (!config.clientId || !config.clientSecret) {
    return Promise.resolve({
      ok: false,
      authUrl: "",
      message:
        "ML_CLIENT_ID and ML_CLIENT_SECRET are not set. Fill them in the plugin settings (or .env) first.",
    });
  }
  const callbackUrl = new URL(config.redirectUri);
  const port = Number(callbackUrl.port) || 3333;
  const callbackPath = callbackUrl.pathname || "/callback";
  const authUrl = buildAuthUrl();

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: AuthFlowResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      resolve(result);
    };

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);
      if (url.pathname !== callbackPath) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Missing 'code' query parameter.");
        return;
      }
      exchangeCodeForTokens(code)
        .then(() => {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(
            "<h1>Conta conectada!</h1><p>Pode fechar esta aba e voltar ao Claude.</p>"
          );
          finish({ ok: true, authUrl, message: `Account connected. Tokens saved to ${config.tokensFile}` });
        })
        .catch((err) => {
          res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(`Falha ao conectar: ${(err as Error).message}`);
          finish({ ok: false, authUrl, message: `Token exchange failed: ${(err as Error).message}` });
        });
    });

    server.on("error", (err) => {
      finish({
        ok: false,
        authUrl,
        message: `Could not listen on port ${port}: ${(err as Error).message}`,
      });
    });

    const timer = setTimeout(() => {
      finish({
        ok: false,
        authUrl,
        message: "Timed out waiting for the authorization in the browser. Call it again.",
      });
    }, timeoutMs);

    server.listen(port, () => {
      log(`Listening for the OAuth callback on ${config.redirectUri}`);
      log(`Open this URL to authorize:\n\n${authUrl}\n`);
      if (openBrowser) openInBrowser(authUrl);
    });
  });
}
