const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cookieSession = require("cookie-session");

const PORT = process.env.PORT || 3000;
const ALLOWED_DOMAIN = (process.env.ALLOWED_DOMAIN || "junglecreations.com").toLowerCase();
const BASE_URL =
  process.env.BASE_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${PORT}`);
const MIN_PASSWORD = 10;
const DASHBOARD = fs.readFileSync(path.join(__dirname, "private", "index.html"), "utf8");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1); // Railway terminates TLS in front of us

const missing = ["DATABASE_URL", "SESSION_SECRET"].filter((k) => !process.env[k]);
if (missing.length) {
  // Fail closed: never serve the dashboard if sign-in isn't configured.
  console.error(`Sign-in not configured, missing: ${missing.join(", ")}`);
  app.use((req, res) => res.status(503).send(page("Not available yet", "<p>The dashboard will be available shortly.</p>")));
  app.listen(PORT, () => console.log(`Listening on ${PORT} (locked, sign-in not configured)`));
  return;
}

const db = require("./db");

app.use(
  cookieSession({
    name: "rtb_session",
    keys: [process.env.SESSION_SECRET],
    maxAge: 30 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: "lax",
    secure: BASE_URL.startsWith("https://"),
  })
);
app.use(express.urlencoded({ extended: false, limit: "10kb" }));
app.use((req, res, next) => {
  res.set("Cache-Control", "private, no-store");
  res.set("X-Frame-Options", "DENY");
  res.set("Referrer-Policy", "same-origin");
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString("hex");
  next();
});

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const csrfField = (req) => `<input type="hidden" name="_csrf" value="${req.session.csrf}">`;
const checkCsrf = (req, res, next) =>
  req.body._csrf && req.body._csrf === req.session.csrf ? next() : res.status(403).send(page("Please try again", `<p>That form expired. <a href="${req.originalUrl}">Reload the page</a> and try again.</p>`));

// Load the signed-in user on every request, so removing someone or resetting a password takes effect straight away.
app.use(
  wrap(async (req, res, next) => {
    const s = req.session;
    if (s.uid) {
      const { rows } = await db.pool.query("select * from users where id = $1", [s.uid]);
      if (rows[0] && rows[0].session_version === s.sv) req.user = rows[0];
      else s.uid = s.sv = null;
    }
    next();
  })
);

function signIn(req, user) {
  req.session.uid = user.id;
  req.session.sv = user.session_version;
  req.session.csrf = crypto.randomBytes(24).toString("hex");
  return db.pool.query("update users set last_login_at = now() where id = $1", [user.id]);
}

// ---- Sign in ----

const failures = new Map(); // key -> { count, until }
const LOCK_AFTER = 8;
const LOCK_MS = 15 * 60 * 1000;
const limited = (key) => {
  const f = failures.get(key);
  return f && f.count >= LOCK_AFTER && f.until > Date.now();
};
const fail = (key) => {
  if (failures.size > 10000) failures.clear();
  const f = failures.get(key);
  const fresh = !f || f.until < Date.now();
  failures.set(key, { count: fresh ? 1 : f.count + 1, until: Date.now() + LOCK_MS });
};

function loginPage(req, { email = "", error = "" } = {}) {
  return page(
    "Response to Brief Directory",
    `<p>Sign in to continue.</p>
     ${error ? `<p class="error">${esc(error)}</p>` : ""}
     <form method="post" action="/login">${csrfField(req)}
       <label>Work email<input type="email" name="email" value="${esc(email)}" autocomplete="username" required autofocus></label>
       <label>Password<input type="password" name="password" autocomplete="current-password" required></label>
       <button class="btn" type="submit">Sign in</button>
     </form>
     <p class="small">No account? Ask for an invite link. Forgotten your password? Ask for a reset link.</p>`
  );
}

app.get("/login", (req, res) => (req.user ? res.redirect("/") : res.send(loginPage(req))));

app.post(
  "/login",
  checkCsrf,
  wrap(async (req, res) => {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const keys = [`ip:${req.ip}`, `email:${email}`];
    if (keys.some(limited)) return res.status(429).send(loginPage(req, { email, error: "Too many attempts. Please wait 15 minutes and try again." }));

    const { rows } = await db.pool.query("select * from users where email = $1", [email]);
    const ok = await db.checkPassword(password, rows[0] && rows[0].password_hash);
    if (!rows[0] || !ok) {
      keys.forEach(fail);
      return res.status(401).send(loginPage(req, { email, error: "That email and password don't match." }));
    }
    keys.forEach((k) => failures.delete(k));
    await signIn(req, rows[0]);
    res.redirect("/");
  })
);

app.get("/logout", (req, res) => {
  req.session = null;
  res.redirect("/login");
});

// ---- Invite and reset links ----

const EXPIRED = page("This link has expired", "<p>Invite links work once and last a week. Ask whoever sent it for a new one.</p>");

function invitePage(req, invite, existing, { name = "", error = "" } = {}) {
  return page(
    existing ? "Choose a new password" : "Create your account",
    `<p>${esc(invite.email)}</p>
     ${error ? `<p class="error">${esc(error)}</p>` : ""}
     <form method="post">${csrfField(req)}
       <label>Your name<input name="name" value="${esc(name || (existing && existing.name) || "")}" autocomplete="name" required maxlength="100"></label>
       <label>Password <span class="hint">(at least ${MIN_PASSWORD} characters)</span><input type="password" name="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" required></label>
       <label>Confirm password<input type="password" name="confirm" autocomplete="new-password" minlength="${MIN_PASSWORD}" required></label>
       <button class="btn" type="submit">${existing ? "Save password" : "Create account"}</button>
     </form>`
  );
}

async function loadInvite(token) {
  const invite = await db.findInvite(token);
  if (!invite) return {};
  const { rows } = await db.pool.query("select * from users where email = $1", [invite.email]);
  return { invite, existing: rows[0] };
}

app.get(
  "/invite/:token",
  wrap(async (req, res) => {
    const { invite, existing } = await loadInvite(req.params.token);
    if (!invite) return res.status(410).send(EXPIRED);
    res.send(invitePage(req, invite, existing));
  })
);

app.post(
  "/invite/:token",
  checkCsrf,
  wrap(async (req, res) => {
    const { invite, existing } = await loadInvite(req.params.token);
    if (!invite) return res.status(410).send(EXPIRED);
    const name = String(req.body.name || "").trim().slice(0, 100);
    const password = String(req.body.password || "");
    const error = !name
      ? "Please enter your name."
      : password.length < MIN_PASSWORD
        ? `Your password needs at least ${MIN_PASSWORD} characters.`
        : password !== req.body.confirm
          ? "Those passwords don't match."
          : "";
    if (error) return res.status(400).send(invitePage(req, invite, existing, { name, error }));

    const user = await db.acceptInvite(req.params.token, name, password);
    if (!user) return res.status(410).send(EXPIRED);
    await signIn(req, user);
    res.redirect("/");
  })
);

// ---- Everything below needs a signed-in user ----

app.use((req, res, next) => (req.user ? next() : res.redirect("/login")));

app.get(["/", "/index.html"], (req, res) => {
  const bar = `<div id="rtb-account" style="position:fixed;right:12px;bottom:12px;z-index:2147483647;display:flex;gap:12px;align-items:center;padding:8px 14px;border-radius:999px;background:rgba(16,15,14,.92);border:1px solid #2a2622;font:500 12px Inter,-apple-system,sans-serif;color:#a89f97">
    <span>${esc(req.user.email)}</span>
    ${req.user.is_admin ? `<a href="/admin" style="color:#f6efe9">Manage access</a>` : ""}
    <a href="/logout" style="color:#f6efe9">Sign out</a></div>`;
  res.type("html").send(DASHBOARD.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${bar}</body>`));
});

// ---- Admin: invites and people ----

const requireAdmin = (req, res, next) => (req.user.is_admin ? next() : res.redirect("/"));
const fmt = (d) => (d ? new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/London" }) : "Never");

app.get(
  "/admin",
  requireAdmin,
  wrap(async (req, res) => {
    const flash = req.session.flash;
    req.session.flash = null;
    const [{ rows: users }, { rows: invites }] = await Promise.all([
      db.pool.query("select * from users order by lower(name)"),
      db.pool.query("select * from invites where used_at is null and expires_at > now() order by created_at desc"),
    ]);

    const link = flash && flash.token ? `${BASE_URL}/invite/${flash.token}` : "";
    const notice = flash
      ? flash.error
        ? `<p class="error">${esc(flash.error)}</p>`
        : link
          ? `<div class="notice"><p>${flash.reset ? "Password reset" : "Invite"} link for <strong>${esc(flash.email)}</strong>. Send it to them yourself. It works once and lasts ${db.INVITE_DAYS} days, and it won't be shown again.</p>
             <div class="copy"><input id="link" value="${esc(link)}" readonly><button class="btn" type="button" onclick="navigator.clipboard.writeText(document.getElementById('link').value);this.textContent='Copied'">Copy</button></div></div>`
          : `<p class="ok">${esc(flash.message)}</p>`
      : "";

    const post = (action, label, confirmText, cls = "link") =>
      `<form method="post" action="${action}" onsubmit="return confirm(${esc(JSON.stringify(confirmText))})">${csrfField(req)}<button class="${cls}" type="submit">${label}</button></form>`;

    const userRows = users
      .map(
        (u) => `<tr><td>${esc(u.name)}${u.is_admin ? ' <span class="tag">Admin</span>' : ""}<div class="muted">${esc(u.email)}</div></td>
          <td class="muted">${fmt(u.last_login_at)}</td>
          <td class="actions">${post(`/admin/users/${u.id}/reset`, "Reset link", `Create a password reset link for ${u.email}? Their current password keeps working until they use it.`)}
          ${u.id === req.user.id ? "" : post(`/admin/users/${u.id}/remove`, "Remove", `Remove ${u.email}? They'll be signed out straight away.`, "link danger")}</td></tr>`
      )
      .join("");
    const inviteRows = invites
      .map(
        (i) => `<tr><td>${esc(i.email)}${i.is_admin ? ' <span class="tag">Admin</span>' : ""}</td><td class="muted">Expires ${fmt(i.expires_at)}</td>
          <td class="actions">${post(`/admin/invites/${i.id}/revoke`, "Cancel", `Cancel the link for ${i.email}?`, "link danger")}</td></tr>`
      )
      .join("");

    res.send(
      page(
        "Manage access",
        `${notice}
         <form method="post" action="/admin/invites" class="invite">${csrfField(req)}
           <label>Invite someone<input type="email" name="email" placeholder="name@${ALLOWED_DOMAIN}" required></label>
           <label class="check"><input type="checkbox" name="admin" value="1"> Can manage access too</label>
           <button class="btn" type="submit">Create invite link</button>
         </form>
         <h2>People with access (${users.length})</h2>
         <table><thead><tr><th>Name</th><th>Last signed in</th><th></th></tr></thead><tbody>${userRows}</tbody></table>
         ${invites.length ? `<h2>Links not used yet</h2><table><tbody>${inviteRows}</tbody></table>` : ""}
         <p class="small"><a href="/">Back to the dashboard</a></p>`,
        { wide: true }
      )
    );
  })
);

app.post(
  "/admin/invites",
  requireAdmin,
  checkCsrf,
  wrap(async (req, res) => {
    const email = String(req.body.email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+$/.test(email) || !email.endsWith(`@${ALLOWED_DOMAIN}`)) {
      req.session.flash = { error: `Only @${ALLOWED_DOMAIN} email addresses can be invited.` };
      return res.redirect("/admin");
    }
    const { rows } = await db.pool.query("select 1 from users where email = $1", [email]);
    const token = await db.createInvite(email, { isAdmin: req.body.admin === "1", createdBy: req.user.email });
    req.session.flash = { token, email, reset: rows.length > 0 };
    res.redirect("/admin");
  })
);

app.post(
  "/admin/users/:id/reset",
  requireAdmin,
  checkCsrf,
  wrap(async (req, res) => {
    const { rows } = await db.pool.query("select * from users where id = $1", [req.params.id]);
    if (!rows[0]) return res.redirect("/admin");
    const token = await db.createInvite(rows[0].email, { createdBy: req.user.email });
    req.session.flash = { token, email: rows[0].email, reset: true };
    res.redirect("/admin");
  })
);

app.post(
  "/admin/users/:id/remove",
  requireAdmin,
  checkCsrf,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (id !== req.user.id) {
      const { rows } = await db.pool.query("delete from users where id = $1 returning email", [id]);
      if (rows[0]) {
        await db.pool.query("delete from invites where email = $1 and used_at is null", [rows[0].email]);
        console.log(`${req.user.email} removed ${rows[0].email}`);
        req.session.flash = { message: `Removed ${rows[0].email}.` };
      }
    }
    res.redirect("/admin");
  })
);

app.post(
  "/admin/invites/:id/revoke",
  requireAdmin,
  checkCsrf,
  wrap(async (req, res) => {
    await db.pool.query("delete from invites where id = $1 and used_at is null", [Number(req.params.id)]);
    req.session.flash = { message: "Link cancelled." };
    res.redirect("/admin");
  })
);

app.use((req, res) => res.redirect("/"));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send(page("Something went wrong", `<p>Please try again in a moment. <a href="/">Back to the dashboard</a></p>`));
});

db.migrate()
  .then(() => app.listen(PORT, () => console.log(`Listening on ${PORT}, invite-only for @${ALLOWED_DOMAIN}`)))
  .catch((err) => {
    console.error("Database setup failed:", err);
    process.exit(1);
  });

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function page(title, body, { wide = false } = {}) {
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title === "Response to Brief Directory" ? "Sign in" : esc(title)}: Response to Brief Directory</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:#060606;color:#f6efe9;font:15px/1.5 Inter,-apple-system,BlinkMacSystemFont,sans-serif}
.card{width:100%;max-width:${wide ? 760 : 400}px;padding:40px 32px;border:1px solid #2a2622;border-radius:16px;background:#100f0e}
.kicker{margin:0 0 8px;font-size:12px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:#a89f97}
h1{margin:0 0 12px;font:700 28px/1.2 "Playfair Display",Georgia,serif}
h2{margin:32px 0 8px;font-size:15px;font-weight:600}
p{margin:0 0 20px;color:#cfc6be}
a{color:#f6efe9}
form{margin:0}
label{display:block;margin:0 0 16px;font-size:13px;font-weight:500;color:#cfc6be}
.hint,.muted{color:#8a827b;font-weight:400;font-size:13px}
input[type=email],input[type=password],input:not([type]),#link{display:block;width:100%;margin-top:6px;padding:11px 12px;border:1px solid #3a3530;border-radius:8px;background:#060606;color:#f6efe9;font:inherit}
input:focus{outline:2px solid #f6efe9;outline-offset:1px}
.check{display:flex;gap:8px;align-items:center}
.btn{display:inline-flex;align-items:center;justify-content:center;padding:11px 20px;border:0;border-radius:999px;background:#f6efe9;color:#060606;font:600 15px Inter,sans-serif;cursor:pointer;text-decoration:none}
.btn:hover{background:#fff}
form>.btn{width:100%}
.invite>.btn{width:auto}
.link{padding:0;border:0;background:none;color:#f6efe9;font:500 13px Inter,sans-serif;text-decoration:underline;cursor:pointer}
.danger{color:#ff9b8c}
.error{padding:10px 12px;border-radius:8px;background:#3a1512;color:#ffb4a8}
.ok{padding:10px 12px;border-radius:8px;background:#12301c;color:#a6e3b8}
.notice{margin-bottom:24px;padding:16px;border-radius:12px;background:#1b1916;border:1px solid #3a3530}
.notice p{margin-bottom:12px}
.copy{display:flex;gap:8px}.copy #link{margin:0}
.small{margin:24px 0 0;font-size:13px;color:#8a827b}
.tag{padding:1px 8px;border-radius:999px;background:#2a2622;font-size:11px;font-weight:600;color:#cfc6be}
table{width:100%;border-collapse:collapse}
th{padding:8px 8px 8px 0;text-align:left;font-size:12px;font-weight:500;color:#8a827b;border-bottom:1px solid #2a2622}
td{padding:12px 8px 12px 0;border-bottom:1px solid #1e1c19;vertical-align:top}
.actions{text-align:right;white-space:nowrap}.actions form{display:inline;margin-left:12px}
@media (max-width:560px){.card{padding:28px 20px}.actions form{display:block;margin:0 0 6px}}
</style></head><body><main class="card"><p class="kicker">Jungle Creations</p><h1>${esc(title)}</h1>${body}</main></body></html>`;
}
