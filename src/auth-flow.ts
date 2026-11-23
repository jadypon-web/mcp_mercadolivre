// Browser OAuth flow shared by the `npm run auth` CLI and the connect_account
// tool, so the account can be connected without a terminal and without the
// keys ever passing through the chat.
//
// Meli only accepts HTTPS redirect URIs. With the default
// https://localhost/callback nothing answers after the authorization, so the
// browser shows an error page whose address holds ?code=...; the local page
// asks the user to paste that address. If the redirect URI points to this
// local server over plain http (old setups), the code is captured directly.
import http from "node:http";
import { spawn } from "node:child_process";
import { buildAuthUrl, exchangeCodeForTokens } from "./auth.js";
import { config, DEFAULT_REDIRECT_URI, saveCredentials } from "./config.js";

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

// Accepts the full address the browser landed on, or just the code.
export function extractCode(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.searchParams.get("code");
  } catch {
    const m = text.match(/[?&]code=([^&\s#]+)/);
    if (m) return decodeURIComponent(m[1]);
    return /^[\w-]{10,}$/.test(text) ? text : null;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function readBody(req: http.IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 20_000) {
        req.destroy();
        reject(new Error("body too large"));
      }
    });
    req.on("end", () => resolve(new URLSearchParams(raw)));
    req.on("error", reject);
  });
}

export function runAuthFlow(
  options: { timeoutMs?: number; openBrowser?: boolean; log?: (m: string) => void } = {}
): Promise<AuthFlowResult> {
  const { timeoutMs = 600_000, openBrowser = true, log = () => {} } = options;
  const port = config.setupPort;
  const base = `http://localhost:${port}`;
  const needsSetup = !config.clientId || !config.clientSecret;
  const startUrl = needsSetup ? `${base}/setup` : `${base}/authorize`;

  // Old-style redirect pointing at this very server: capture it directly.
  let directCallbackPath: string | null = null;
  try {
    const r = new URL(config.redirectUri);
    if (r.protocol === "http:" && ["localhost", "127.0.0.1"].includes(r.hostname) && Number(r.port || 80) === port) {
      directCallbackPath = r.pathname || "/callback";
    }
  } catch {
    // invalid redirect URI: the setup page lets the user fix it
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: AuthFlowResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      setTimeout(() => server.close(), 500);
      resolve(result);
    };

    const html = (res: http.ServerResponse, status: number, body: string) => {
      res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
      res.end(PAGE(body));
    };

    const exchange = (code: string, res: http.ServerResponse) => {
      exchangeCodeForTokens(code)
        .then(() => {
          html(res, 200, "<h1>Conta conectada!</h1><p>Pode fechar esta aba e voltar ao Claude.</p>");
          finish({ ok: true, authUrl: startUrl, message: `Account connected. Tokens saved to ${config.tokensFile}` });
        })
        .catch((err) => {
          html(
            res,
            500,
            `<h1>Não deu certo</h1><p>${escapeHtml((err as Error).message)}</p>
<p>Confira se o App ID, o Client Secret e o endereço de retorno são os mesmos da aplicação no DevCenter.
O código vale poucos minutos: <a href="/setup">corrigir os dados</a> ou <a href="/authorize">autorizar de novo</a>.</p>`
          );
        });
    };

    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", base);

        if (url.pathname === "/setup" && req.method === "GET") {
          html(res, 200, SETUP_FORM(config.clientId, config.redirectUri));
          return;
        }
        if (url.pathname === "/setup" && req.method === "POST") {
          const form = await readBody(req);
          const id = (form.get("client_id") ?? "").trim();
          const secret = (form.get("client_secret") ?? "").trim() || config.clientSecret;
          const redirect = (form.get("redirect_uri") ?? "").trim() || DEFAULT_REDIRECT_URI;
          if (!/^\d+$/.test(id) || secret.length < 10 || !/^https?:\/\//.test(redirect)) {
            html(res, 400, `<p>Confira os dados: o App ID tem só números, o Client Secret não pode ficar vazio e o endereço de retorno começa com https://. <a href="/setup">Voltar</a></p>`);
            return;
          }
          saveCredentials(id, secret, redirect);
          res.writeHead(303, { Location: "/authorize" });
          res.end();
          return;
        }
        if (url.pathname === "/authorize" && req.method === "GET") {
          if (!config.clientId || !config.clientSecret) {
            res.writeHead(303, { Location: "/setup" });
            res.end();
            return;
          }
          html(res, 200, AUTHORIZE_PAGE(buildAuthUrl(), Boolean(directCallbackPath)));
          return;
        }
        if (url.pathname === "/code" && req.method === "POST") {
          const form = await readBody(req);
          const code = extractCode(form.get("address") ?? "");
          if (!code) {
            html(res, 400, `<p>Não achei o código nesse endereço. Ele aparece depois de <code>?code=</code>. <a href="/authorize">Tentar de novo</a></p>`);
            return;
          }
          exchange(code, res);
          return;
        }
        if (directCallbackPath && url.pathname === directCallbackPath) {
          const code = url.searchParams.get("code");
          if (code) {
            exchange(code, res);
            return;
          }
        }
        if (url.pathname === "/") {
          res.writeHead(303, { Location: needsSetup ? "/setup" : "/authorize" });
          res.end();
          return;
        }
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
      } catch (err) {
        html(res, 500, `<p>Erro: ${escapeHtml((err as Error).message)}</p>`);
      }
    });

    server.on("error", (err) => {
      finish({
        ok: false,
        authUrl: startUrl,
        message: `Could not listen on port ${port}: ${(err as Error).message}`,
      });
    });

    const timer = setTimeout(() => {
      finish({
        ok: false,
        authUrl: startUrl,
        message: "Timed out waiting for the authorization in the browser (10 minutes). Call it again.",
      });
    }, timeoutMs);

    server.listen(port, "127.0.0.1", () => {
      log(`Open this page to connect the account:\n\n${startUrl}\n`);
      if (openBrowser) openInBrowser(startUrl);
    });
  });
}

const PAGE = (body: string) => `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Conectar Mercado Livre</title>
<style>body{font-family:system-ui,sans-serif;max-width:600px;margin:40px auto;padding:0 16px;color:#222;line-height:1.5}
label{display:block;margin:16px 0 6px;font-weight:600}input,textarea{width:100%;padding:10px;font-size:15px;box-sizing:border-box}
button,.btn{display:inline-block;margin-top:16px;padding:12px 20px;font-size:16px;background:#3483fa;color:#fff;border:0;border-radius:6px;cursor:pointer;text-decoration:none}
.box{background:#f5f5f5;padding:12px;border-radius:6px;font-size:14px}code{background:#eee;padding:2px 4px}ol li{margin-bottom:10px}</style></head>
<body>${body}</body></html>`;

const SETUP_FORM = (clientId: string, redirectUri: string) => `
<h1>Conectar a conta do Mercado Livre</h1>
<p class="box">Os dados ficam só neste computador. Pegue-os no DevCenter
(developers.mercadolivre.com.br/devcenter), na sua aplicação.</p>
<form method="post" action="/setup">
<label for="id">App ID (Client ID)</label>
<input id="id" name="client_id" inputmode="numeric" required autocomplete="off" value="${escapeHtml(clientId)}">
<label for="sec">Client Secret (chave secreta)</label>
<input id="sec" name="client_secret" type="password" autocomplete="off" ${clientId ? 'placeholder="deixe vazio para manter a atual"' : "required"}>
<label for="uri">Endereço de retorno (Redirect URI)</label>
<input id="uri" name="redirect_uri" required autocomplete="off" value="${escapeHtml(redirectUri)}">
<p class="box">Precisa ser <b>exatamente igual</b> a um dos endereços de retorno cadastrados na aplicação.
Se for cadastrar um novo, use <code>${DEFAULT_REDIRECT_URI}</code>.</p>
<button type="submit">Salvar e continuar</button></form>`;

const AUTHORIZE_PAGE = (authUrl: string, automatic: boolean) => `
<h1>Autorizar no Mercado Livre</h1>
<ol>
<li><a class="btn" href="${escapeHtml(authUrl)}" target="_blank" rel="noopener">Abrir o Mercado Livre e autorizar</a><br>
Entre com a conta da loja e clique em <b>Permitir</b>.</li>
${
  automatic
    ? "<li>Pronto: esta página recebe a autorização sozinha.</li>"
    : `<li>Depois de permitir, vai abrir uma página que <b>não carrega</b> (“não é possível acessar esse site”). Isso é normal.</li>
<li>Copie o <b>endereço completo</b> dessa página (a barra lá em cima, começa com <code>https://localhost</code>) e cole aqui:
<form method="post" action="/code">
<textarea name="address" rows="3" required placeholder="https://localhost/callback?code=..."></textarea>
<button type="submit">Conectar</button></form></li>`
}
</ol>
<p><a href="/setup">Corrigir App ID / Client Secret / endereço de retorno</a></p>`;
