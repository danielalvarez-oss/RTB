# Response to Brief Directory dashboard

A static dashboard (`index.html`) covering the RTB directory and Brand Lift Studies.
`package.json` and `railway.json` just tell Railway to serve that one file with
[`serve`](https://www.npmjs.com/package/serve), nothing else to configure.

## Deploy with Claude Code

Open this folder in Claude Code (`claude` in your terminal, inside this folder,
or point Claude Desktop's Code tab at it) and ask it to run the steps below.
Claude Code uses your own `git` and `railway` logins already set up on your
machine, so no tokens are typed into chat.

### 1. Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit: RTB directory dashboard"
gh repo create rtb-directory-dashboard --private --source=. --remote=origin --push
```

No `gh` CLI? Create an empty repo at github.com/new first, then:

```bash
git remote add origin https://github.com/<your-username>/rtb-directory-dashboard.git
git branch -M main
git push -u origin main
```

### 2. Deploy on Railway

```bash
railway login
railway init
railway up
```

Or skip GitHub entirely and deploy this folder straight from your machine:

```bash
railway login
railway init
railway up
```

Either way, Railway will build with Nixpacks, run `npm start`, and give you a
public `*.up.railway.app` URL. To connect a GitHub repo for auto-deploys on
every push instead of `railway up`, use the Railway dashboard: New Project >
Deploy from GitHub repo > pick `rtb-directory-dashboard`.

## Sign-in

The dashboard is invite-only (`server.js`, `db.js`). Only `@junglecreations.com`
addresses can be invited.

- **Admins** open **Manage access** (bottom-right of the dashboard, or `/admin`) to
  create invite links, send password-reset links, cancel unused links and remove people.
- **Invite links** work once and expire after 7 days. The admin sends each one
  themselves (Slack or email), which is what proves the person owns the address.
- **Removing someone** or resetting their password signs them out straight away.
- Sessions last 30 days; `/logout` signs out. Eight wrong passwords locks that
  email/IP out for 15 minutes.

Railway service variables:

| Variable | What it is |
| --- | --- |
| `DATABASE_URL` | Reference to this service's own Postgres (`Postgres-nTPQ`) |
| `SESSION_SECRET` | Long random string used to sign the login cookie |
| `BASE_URL` | Public URL, used to build invite links |
| `ALLOWED_DOMAIN` | Optional, defaults to `junglecreations.com` |

If `DATABASE_URL` or `SESSION_SECRET` is missing, the server stays locked rather
than serving the dashboard.

To create an invite from the command line (e.g. a new first admin):

```bash
railway ssh --service rtb-directory-dashboard -- node invite.js name@junglecreations.com --admin
```

A Google sign-in version is kept on the `google-sign-in` branch for when a Google
Cloud project is available.

## Updating the dashboard later

Replace `private/index.html` with the new version, then:

```bash
git add private/index.html
git commit -m "Update dashboard"
git push
```

Railway redeploys automatically from the `main` branch of the GitHub repo.
