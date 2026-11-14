// backend/scripts/gmail_auth.js — `npm run gmail:auth`
// One-time: lets the Gmail account in MAIL_USER authorize the app to send email through the Gmail API, and prints the
// GMAIL_REFRESH_TOKEN for .env. Run it on a computer with a browser (your PC), then copy the token to the server.
// Needs GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env from a Google Cloud OAuth client of type "Desktop app".
import crypto from "crypto";
import http from "http";
import { exec } from "child_process";
import dotenv from "dotenv";

dotenv.config();

const clientId = process.env.GMAIL_CLIENT_ID?.trim();
const clientSecret = process.env.GMAIL_CLIENT_SECRET?.trim();
const expectedEmail = process.env.MAIL_USER?.trim().toLowerCase();

if (!clientId || !clientSecret) {
  console.error("Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env first (see DEPLOYMENT.md, \"Email with the Gmail API\").");
  process.exit(1);
}

// gmail.send = send only (can't read the mailbox); openid + email only to confirm which account signed in
const SCOPES = ["https://www.googleapis.com/auth/gmail.send", "openid", "email"];
const state = crypto.randomBytes(16).toString("hex");
const verifier = crypto.randomBytes(48).toString("base64url");
const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");

const server = http.createServer();
server.listen(0, "127.0.0.1", () => {
  const redirectUri = `http://127.0.0.1:${server.address().port}`;
  const url =
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPES.join(" "),
      access_type: "offline", // ask for a refresh token
      prompt: "consent", // always return one, even if this account authorized before
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      ...(expectedEmail ? { login_hint: expectedEmail } : {}),
    });

  console.log(`\nSign in as ${expectedEmail || "the Gmail account that should send the emails"} and allow "Send email on your behalf".`);
  console.log("If the browser doesn't open, copy this link into it:\n");
  console.log(url + "\n");
  const opener = process.platform === "win32" ? `start "" "${url}"` : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
  exec(opener, () => {});

  server.on("request", async (req, res) => {
    const params = new URL(req.url, redirectUri).searchParams;
    if (!params.has("code") && !params.has("error")) {
      res.writeHead(404).end();
      return;
    }
    const finish = (status, message, exitCode) => {
      res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<p style="font-family:sans-serif;font-size:16px">${message}</p>`);
      server.close();
      setTimeout(() => process.exit(exitCode), 100);
    };

    if (params.get("state") !== state) return finish(400, "State mismatch. Run npm run gmail:auth again.", 1);
    if (params.get("error")) {
      console.error(`Google returned: ${params.get("error")}`);
      return finish(400, "Not authorized. You can close this tab.", 1);
    }

    try {
      const response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code: params.get("code"),
          code_verifier: verifier,
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error_description || body.error || response.status);
      if (!body.refresh_token) throw new Error("Google sent no refresh token.");
      if (!String(body.scope || "").includes("gmail.send")) {
        throw new Error('"Send email on your behalf" was not allowed. Run it again and tick that box.');
      }

      const email = JSON.parse(Buffer.from(String(body.id_token).split(".")[1] || "", "base64url").toString() || "{}").email;
      console.log(`Authorized: ${email || "(unknown account)"}`);
      if (expectedEmail && email && email.toLowerCase() !== expectedEmail) {
        console.warn(`WARNING: MAIL_USER is ${expectedEmail}, but you signed in as ${email}. Emails are sent from the signed-in`);
        console.warn("account, so set MAIL_USER to that address (or run this again with the right account).");
      }
      console.log("\nPut this in .env (on the server too):\n");
      console.log(`GMAIL_REFRESH_TOKEN=${body.refresh_token}\n`);
      finish(200, "Done. Go back to the terminal for the token; you can close this tab.", 0);
    } catch (err) {
      console.error(`Could not get the token: ${err.message}`);
      finish(500, "Something went wrong. Check the terminal.", 1);
    }
  });
});

setTimeout(() => {
  console.error("Timed out after 5 minutes without a sign-in. Run npm run gmail:auth again.");
  process.exit(1);
}, 5 * 60 * 1000).unref();
