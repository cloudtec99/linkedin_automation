# LinkedIn AutoPoster — Groq + Telegram + GitHub Actions

> **Free forever. No credit card. No local machine.**
> Groq (Llama-3.1-70B) writes the post → Telegram sends it to you → one tap → live on LinkedIn.

---

## Architecture

```
GitHub Cron — 10:00 AM IST every weekday
          │
          ▼
  generate.js calls Groq API (FREE)
  Llama-3.1-70B writes the post
          │
          ▼
  notify.js sends Telegram message:

  ┌────────────────────────────────────┐
  │ 🤖 Daily LinkedIn Post Ready       │
  │                                    │
  │  [post preview...]                 │
  │                                    │
  │  [✅ Approve]   [⏭️ Skip]          │
  │  [✏️ Edit]      [🔄 Regen]         │
  └────────────────────────────────────┘
          │
  Tap ✅ → webhook server → GitHub Action → LinkedIn API → "Post is LIVE ✅"
  Tap ✏️ → bot asks for edited text → tap ✅ → posts edited version
  Tap 🔄 → regenerates a fresh post
  Tap ⏭️ → skipped, nothing posted
```

---

## What you need (all free)

| Item | Where | Time |
|------|-------|------|
| Groq API key | console.groq.com | 2 min |
| Telegram Bot | @BotFather in Telegram | 3 min |
| LinkedIn credentials | linkedin.com/developers | 10 min |
| GitHub account | github.com | already have it |
| Railway account | railway.app | 2 min |

---

## Setup — step by step

### 1. Get Groq API key (2 min)

1. Go to **https://console.groq.com**
2. Sign up — no credit card asked
3. Click **API Keys → Create API Key**
4. Copy the key — starts with `gsk_...`

---

### 2. Create Telegram bot (3 min)

1. Open Telegram, search **@BotFather**
2. Send `/newbot` → choose a name and username
3. Copy the **Bot Token** — looks like `7123456789:AAFxxx...`
4. Send `/start` to your new bot (important — do this now)
5. Get your **Chat ID**:
   - Open: `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
   - Find `"chat":{"id":XXXXXXXXX}` — that number is your Chat ID

---

### 3. Set up LinkedIn API (10 min)

**Create app:**
1. Go to **https://www.linkedin.com/developers/apps/new**
2. Fill in app name, LinkedIn Page (create one if needed), logo
3. Under **Products** tab → Request **"Share on LinkedIn"**
4. Under **Auth** tab → add Redirect URL: `https://localhost`
5. Note your **Client ID** and **Client Secret**

**Get access token:**
```bash
# Step A — open this URL in your browser (replace YOUR_CLIENT_ID):
https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=YOUR_CLIENT_ID&redirect_uri=https://localhost&scope=openid%20profile%20email%20w_member_social

# You'll be redirected to https://localhost/?code=XXXX  — copy that code value

# Step B — exchange code for token:
curl -X POST https://www.linkedin.com/oauth/v2/accessToken \
  -d "grant_type=authorization_code" \
  -d "code=PASTE_CODE_HERE" \
  -d "redirect_uri=https://localhost" \
  -d "client_id=YOUR_CLIENT_ID" \
  -d "client_secret=YOUR_CLIENT_SECRET"
```
Copy `access_token` from the JSON response.

**Get your Person URN:**
```bash
curl -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  https://api.linkedin.com/v2/userinfo
```
Copy the `sub` field — this is your Person URN.

> ⏰ Access tokens expire every **60 days**. Set a calendar reminder to redo steps A & B.

---

### 4. Deploy webhook server on Railway (3 min)

The webhook server is a tiny Node.js app that receives your Telegram button taps
and triggers the GitHub Actions publish workflow.

```bash
# Install Railway CLI
npm install -g @railway/cli

# Clone this repo, then:
railway login
railway init     # choose "Empty Project"
railway up       # deploys webhook-server.js

# Get your public URL:
railway domain
# Looks like: https://linkedin-groq-xxxx.railway.app
```

Set these in the Railway **Variables** tab:
```
TELEGRAM_BOT_TOKEN   = your bot token
TELEGRAM_CHAT_ID     = your chat id
GH_PAT               = your GitHub PAT (next step)
GITHUB_REPOSITORY    = yourusername/linkedin-groq
WEBHOOK_URL          = https://your-app.railway.app/webhook
PORT                 = 3000
```

---

### 5. Create GitHub Personal Access Token (1 min)

The webhook server needs this to trigger GitHub Actions when you tap Approve.

1. GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens**
2. Click **Generate new token**
3. Set **Repository access** → your `linkedin-groq` repo
4. Under **Permissions** → **Actions** → set to **Read and Write**
5. Generate and copy — starts with `ghp_...`

---

### 6. Add GitHub Secrets (2 min)

Go to your repo → **Settings → Secrets and variables → Actions → New repository secret**

Add these **5 secrets**:

| Secret name | Value |
|-------------|-------|
| `GROQ_API_KEY` | `gsk_...` from step 1 |
| `TELEGRAM_BOT_TOKEN` | from BotFather |
| `TELEGRAM_CHAT_ID` | from getUpdates |
| `LINKEDIN_ACCESS_TOKEN` | from OAuth step |
| `LINKEDIN_PERSON_URN` | from userinfo API |

---

### 7. Test it

```bash
# Test generation locally:
GROQ_API_KEY=gsk_your_key node scripts/generate.js
```

Or trigger in GitHub:
- Go to **Actions** tab
- Click **"Generate & Send Daily LinkedIn Post"**
- Click **Run workflow**

You should get a Telegram message within ~20 seconds.

---

## Refresh LinkedIn token (every 60 days)

1. Re-run Step 3 Step A and B above
2. GitHub repo → **Settings → Secrets** → update `LINKEDIN_ACCESS_TOKEN`
3. Done — everything else stays the same

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| No Telegram message | Check `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` secrets; confirm you sent `/start` to the bot |
| Groq error in Actions log | Check `GROQ_API_KEY` secret is set correctly |
| "Post not found" in Telegram | Railway server restarted (in-memory cleared) — trigger a fresh generation |
| LinkedIn 401 | Token expired — redo OAuth, update `LINKEDIN_ACCESS_TOKEN` secret |
| LinkedIn 403 | App missing `w_member_social` — re-request it in the LinkedIn developer portal |
| Workflow not triggering on Approve | `GH_PAT` needs Actions read+write scope |

---

## Cost breakdown

| Service | Free limit | Daily usage |
|---------|-----------|-------------|
| GitHub Actions | 2,000 min/month | ~2 min/day |
| Groq (Llama-3.1-70B) | 14,400 req/day | 1 req/day |
| Railway | $5 credit/month | ~$0.10/month |
| Telegram | Unlimited | 2–3 messages |
| LinkedIn API | Unlimited | 1 post |

**Total: $0 / month** (Railway free credit covers it easily)
