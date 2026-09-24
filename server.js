const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cookieSession = require("cookie-session");
const { OAuth2Client } = require("google-auth-library");

const PORT = process.env.PORT || 3000;
const ALLOWED_DOMAIN = (process.env.ALLOWED_DOMAIN || "junglecreations.com").toLowerCase();
const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SESSION_SECRET } = process.env;
const BASE_URL =
  process.env.BASE_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${PORT}`);
const REDIRECT_URI = `${BASE_URL}/auth/google/callback`;
const DASHBOARD = path.join(__dirname, "private", "index.html");
const GOOGLE_ICON = `<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.6 13.3l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z"/><path fill="#FBBC05" d="M10.5 28.6c-.5-1.4-.8-2.9-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.6 10.7l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.5 2.3-6.3 0-11.6-4.1-13.5-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/></svg>`;

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1); // Railway terminates TLS in front of us

const missing = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "SESSION_SECRET"].filter((k) => !process.env[k]);
if (missing.length) {
  // Fail closed: never serve the dashboard if sign-in isn't configured.
  console.error(`Sign-in not configured, missing: ${missing.join(", ")}`);
  app.use((req, res) => res.status(503).send(page("Sign-in isn't set up yet", "<p>The dashboard will be available shortly.</p>")));
  app.listen(PORT, () => console.log(`Listening on ${PORT} (locked, sign-in not configured)`));
  return;
}

const google = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI);

app.use(
  cookieSession({
    name: "rtb_session",
    keys: [SESSION_SECRET],
    maxAge: 30 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: "lax",
    secure: BASE_URL.startsWith("https://"),
  })
);

app.use((req, res, next) => {
  res.set("Cache-Control", "private, no-store");
  res.set("X-Frame-Options", "DENY");
  res.set("Referrer-Policy", "same-origin");
  next();
});

const ERRORS = {
  domain: `Only @${ALLOWED_DOMAIN} Google accounts can sign in.`,
  failed: "Sign-in didn't complete. Please try again.",
};

app.get("/login", (req, res) => {
  if (req.session.user) return res.redirect("/");
  const error = ERRORS[req.query.error];
  res.send(
    page(
      "Response to Brief Directory",
      `<p>Sign in with your Jungle Creations Google account to continue.</p>
       ${error ? `<p class="error">${error}</p>` : ""}
       <a class="btn" href="/auth/google">${GOOGLE_ICON}<span>Sign in with Google</span></a>`
    )
  );
});

app.get("/auth/google", (req, res) => {
  const state = crypto.randomBytes(24).toString("hex");
  req.session.oauthState = state;
  res.redirect(
    google.generateAuthUrl({
      scope: ["openid", "email", "profile"],
      hd: ALLOWED_DOMAIN,
      prompt: "select_account",
      state,
    })
  );
});

app.get("/auth/google/callback", async (req, res) => {
  const expected = req.session.oauthState;
  req.session.oauthState = null;
  if (!req.query.code || !expected || req.query.state !== expected) return res.redirect("/login?error=failed");

  try {
    const { tokens } = await google.getToken(req.query.code);
    const ticket = await google.verifyIdToken({ idToken: tokens.id_token, audience: GOOGLE_CLIENT_ID });
    const p = ticket.getPayload();
    const email = (p.email || "").toLowerCase();
    if (!p.email_verified || p.hd !== ALLOWED_DOMAIN || !email.endsWith(`@${ALLOWED_DOMAIN}`)) {
      console.warn(`Rejected sign-in: ${email || "unknown"}`);
      return res.redirect("/login?error=domain");
    }
    req.session.user = { email, name: p.name || email };
    console.log(`Signed in: ${email}`);
    res.redirect("/");
  } catch (err) {
    console.error("Google sign-in failed:", err.message);
    res.redirect("/login?error=failed");
  }
});

app.get("/logout", (req, res) => {
  req.session = null;
  res.redirect("/login");
});

app.use((req, res, next) => (req.session.user ? next() : res.redirect("/login")));

app.get(["/", "/index.html"], (req, res) => res.sendFile(DASHBOARD));
app.use((req, res) => res.redirect("/"));

app.listen(PORT, () => console.log(`Listening on ${PORT}, allowing @${ALLOWED_DOMAIN}`));

function page(title, body) {
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in: Response to Brief Directory</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:#060606;color:#f6efe9;font:15px/1.5 Inter,-apple-system,BlinkMacSystemFont,sans-serif}
.card{width:100%;max-width:400px;padding:40px 32px;border:1px solid #2a2622;border-radius:16px;background:#100f0e;text-align:center}
.kicker{margin:0 0 8px;font-size:12px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:#a89f97}
h1{margin:0 0 12px;font:700 28px/1.2 "Playfair Display",Georgia,serif}
p{margin:0 0 24px;color:#cfc6be}
.error{padding:10px 12px;border-radius:8px;background:#3a1512;color:#ffb4a8}
.btn{display:inline-flex;align-items:center;gap:10px;padding:12px 20px;border-radius:999px;background:#f6efe9;color:#060606;font-weight:600;text-decoration:none}
.btn:hover{background:#fff}
.btn svg{width:18px;height:18px}
</style></head><body><main class="card"><p class="kicker">Jungle Creations</p><h1>${title}</h1>${body}</main></body></html>`;
}
