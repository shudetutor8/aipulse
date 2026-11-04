# AI Pulse

An AI news and discussion community that runs itself:

- **AI News** is collected from news feeds every 30 minutes, grouped by event and summarized by Claude, with links to the original articles.
- **Hot-topic polls** are written by Claude from the day's biggest stories every 6 hours. You approve them in Admin (or let them publish automatically).
- **Discussion of the day**: every morning Claude posts a neutral discussion starter about the hottest story, clearly labeled as written by AI.
- **Q&A and discussions**: members ask questions, answer, reply in threads, upvote, pick best answers and create their own polls.
- **AI stocks**: a discussion page for each AI company, with links to free quote pages for prices.
- **Safety**: a built-in spam check on every post, an AI moderation pass every 30 minutes, member reports, rate limits and account suspension.

It runs the same way as huamai88.com: **GitHub Pages** shows the website, **Supabase** stores members and posts, and **GitHub Actions** runs the automatic jobs. There's no server to pay for.

```
docs/                 the website (GitHub Pages serves this folder)
  config.js           ← your Supabase address and publishable key go here
jobs/run.mjs          the automatic jobs (news, polls, daily discussion, moderation)
.github/workflows/    the schedule that runs the jobs
supabase/schema.sql   the database: run once in Supabase
```

---

## Set it up (about 45 minutes)

### 1. Create the database (Supabase)
1. Go to **supabase.com** and sign in with GitHub. Click **New project**, give it a name, and save the database password somewhere safe.
2. Open **SQL Editor → New query**. Paste the whole file `supabase/schema.sql` and click **Run**. You should see "Success".
3. Open **Project Settings → API Keys** and copy into a private note:
   - **Project URL** (looks like `https://abcd1234.supabase.co`)
   - **Publishable key** (starts `sb_publishable_`). This one is safe to put on the website.
   - **Secret key** (starts `sb_secret_`). Never put this on the website or share it.

### 2. Get a Claude API key
On **console.anthropic.com**: add $5–10 of credit under Billing, set a monthly spend limit, then **API Keys → Create key**. Copy it into your private note.

### 3. Put the code on GitHub
1. On GitHub, click **New repository**. Name it `aipulse` and choose **Public**. (GitHub Pages is free only for public repositories, and scheduled jobs are free there too. Your secret keys stay private in GitHub's secret settings, never in the code.)
2. Upload the contents of this folder to the repository (or ask Claude to push it for you).

### 4. Connect the website to the database
Edit `docs/config.js` on GitHub (click the file, then the pencil icon) and fill in:
```js
supabaseUrl: "https://abcd1234.supabase.co",
supabaseKey: "sb_publishable_...",
githubRepo: "shudetutor8/aipulse",
```
Click **Commit changes**.

### 5. Turn on the website (GitHub Pages)
Repository **Settings → Pages**: under *Build and deployment*, choose **Deploy from a branch**, branch **main**, folder **/docs**, and click **Save**. After a minute your site is live at `https://shudetutor8.github.io/aipulse/`.

### 6. Turn on the automatic jobs (GitHub Actions)
1. Repository **Settings → Secrets and variables → Actions → New repository secret**. Add three secrets:
   - `SUPABASE_URL`: your Project URL
   - `SUPABASE_SECRET_KEY`: the **secret** key
   - `ANTHROPIC_API_KEY`: your Claude key
2. Open the **Actions** tab. If asked, click **I understand my workflows, go ahead and enable them**.
3. Click **Automatic jobs → Run workflow → Run workflow** to fetch the first news right away. After that it runs by itself.

### 7. Turn on login
In Supabase, **Authentication → URL Configuration**:
- **Site URL**: `https://shudetutor8.github.io/aipulse/`
- **Redirect URLs**: add the same address

Email sign-in links work right away. For "Continue with Google", turn on Google under **Authentication → Sign In / Providers** and follow Supabase's guide to create the Google keys.

### 8. Make yourself the admin
Open your site, log in, then in Supabase **SQL Editor** run (with your email):
```sql
update public.profiles set is_admin = true
where id = (select id from auth.users where email = 'you@example.com');
```
Reload the site. Your account menu now has **Admin**, where you approve the AI polls.

---

## Connect your GoDaddy domain

Once you've bought the domain (e.g. `yourname.com`):
1. In the repository, add a file `docs/CNAME` containing just your domain, for example `www.yourname.com`.
2. **Settings → Pages → Custom domain**: enter `www.yourname.com` and save. Tick **Enforce HTTPS** once it's available.
3. At **GoDaddy → My Products → your domain → DNS**, set the same records huamai88.com uses:
   - `CNAME` record: name `www`, value `shudetutor8.github.io`
   - Four `A` records for `@`: `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
4. In Supabase **URL Configuration**, change Site URL to `https://www.yourname.com/` and add it to Redirect URLs.

---

## Day to day

Open **Admin** on your site:
- **Polls waiting for review**: edit the wording, then approve or reject. To skip review, add a repository *variable* `AUTO_PUBLISH_POLLS` = `true` (Settings → Secrets and variables → Actions → Variables).
- **Flagged by automatic checks** and **Reports from members**: approve or hide.
- **News sources**: any feed showing an error can be paused or removed; add any RSS feed you like.
- **Newest members**: suspend accounts that break the rules.
- **Run jobs now on GitHub** opens the Actions page if you want news or polls immediately.

## Before you launch publicly
- Fill in the `[BRACKETED]` parts of the Terms and Privacy pages (in `docs/app.js`, search for `[DATE]`) and have them reviewed.
- Supabase's built-in email sends only a few sign-in emails per hour. Connect an email service (Resend, Postmark…) under **Authentication → Emails → SMTP Settings**.
- Post 10–20 good questions and discussions yourself so the first visitors don't see an empty site.

## Costs
GitHub Pages and Actions: free for public repositories. Supabase: free plan to start (Pro is $25/month when you grow). Claude API: a few dollars a month at small scale. Domain: about $10–20/year at GoDaddy.

## Good to know
- Pages use addresses like `/#/news/…`. Search engines index these poorly, so most search traffic will land on the home page. If search traffic becomes important, the next step is to move to a host that renders pages on the server.
- New posts appear immediately after the built-in spam check. The AI moderation pass then runs every 30 minutes and holds anything that breaks the rules for your review.
