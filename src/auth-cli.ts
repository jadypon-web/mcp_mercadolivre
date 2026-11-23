#!/usr/bin/env node
import { runAuthFlow } from "./auth-flow.js";
import { loadTokens } from "./token-store.js";

if (loadTokens()) {
  console.log("Existing tokens found — they will be replaced.");
}

const result = await runAuthFlow({ log: (m) => console.log(m) });
if (result.ok) {
  console.log(result.message);
  process.exit(0);
} else {
  console.error(result.message);
  if (result.authUrl) console.error(`\nAuthorization URL:\n${result.authUrl}`);
  process.exit(1);
}
