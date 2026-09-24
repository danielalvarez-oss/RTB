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

The dashboard sits behind Google sign-in (`server.js`). Only verified
`@junglecreations.com` Google accounts get in; everyone else is sent back to the
login page. Sessions last 30 days; `/logout` signs out.

Railway service variables:

| Variable | What it is |
| --- | --- |
| `GOOGLE_CLIENT_ID` | OAuth client ID from Google Cloud (Web application) |
| `GOOGLE_CLIENT_SECRET` | That client's secret |
| `SESSION_SECRET` | Long random string used to sign the login cookie |
| `BASE_URL` | Public URL, e.g. `https://rtb-directory-dashboard-production.up.railway.app` |
| `ALLOWED_DOMAIN` | Optional, defaults to `junglecreations.com` |

The Google client's authorised redirect URI must be `<BASE_URL>/auth/google/callback`.
If any of the first three are missing, the server stays locked rather than
serving the dashboard.

## Updating the dashboard later

Replace `private/index.html` with the new version, then:

```bash
git add private/index.html
git commit -m "Update dashboard"
git push
```

Railway redeploys automatically from the `main` branch of the GitHub repo.
