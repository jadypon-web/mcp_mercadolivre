// Browser OAuth flow shared by the `npm run auth` CLI and the connect_account
// tool (so the account can be connected from the chat, without a terminal).
import http from "node:http";
import { spawn } from "node:child_process";
import { buildAuthUrl, exchangeCodeForTokens } from "./auth.js";
import { config, saveCredentials } from "./config.js";

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
  const callbackUrl = new URL(config.redirectUri);
  const port = Number(callbackUrl.port) || 3333;
  const callbackPath = callbackUrl.pathname || "/callback";
  const setupUrl = `http://localhost:${port}/setup`;
  // Without App ID / Client Secret, start at a local form instead of Meli.
  const needsSetup = !config.clientId || !config.clientSecret;
  const authUrl = needsSetup ? setupUrl : buildAuthUrl();

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
      if (url.pathname === "/setup" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(SETUP_PAGE(config.redirectUri));
        return;
      }
      if (url.pathname === "/setup" && req.method === "POST") {
        let raw = "";
        req.on("data", (c) => {
          raw += c;
          if (raw.length > 10_000) req.destroy();
        });
        req.on("end", () => {
          const form = new URLSearchParams(raw);
          const id = (form.get("client_id") ?? "").trim();
          const secret = (form.get("client_secret") ?? "").trim();
          if (!/^\d+$/.test(id) || secret.length < 10) {
            res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
            res.end("<p>App ID deve ter só números e o Client Secret não pode ficar vazio. <a href='/setup'>Voltar</a></p>");
            return;
          }
          saveCredentials(id, secret);
          res.writeHead(302, { Location: buildAuthUrl() });
          res.end();
        });
        return;
      }
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

const SETUP_PAGE = (redirectUri: string) => `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Conectar Mercado Livre</title>
<style>body{font-family:system-ui,sans-serif;max-width:520px;margin:48px auto;padding:0 16px;color:#222}
label{display:block;margin:16px 0 6px;font-weight:600}input{width:100%;padding:10px;font-size:16px;box-sizing:border-box}
button{margin-top:20px;padding:12px 20px;font-size:16px;background:#3483fa;color:#fff;border:0;border-radius:6px;cursor:pointer}
.box{background:#f5f5f5;padding:12px;border-radius:6px;font-size:14px}code{background:#eee;padding:2px 4px}</style></head>
<body><h1>Conectar a conta do Mercado Livre</h1>
<p class="box">Os dados ficam só neste computador. No aplicativo criado em
developers.mercadolivre.com.br, a Redirect URI precisa ser exatamente <code>${redirectUri}</code>.</p>
<form method="post" action="/setup">
<label for="id">App ID</label><input id="id" name="client_id" inputmode="numeric" required autocomplete="off">
<label for="sec">Client Secret</label><input id="sec" name="client_secret" type="password" required autocomplete="off">
<button type="submit">Salvar e autorizar no Mercado Livre</button></form></body></html>`;
