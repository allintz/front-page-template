# Front Page: setup runbook for Claude

This repo is a template for a private, daily, AI-curated reading page. Each morning a GitHub Actions job fetches the reader's chosen feeds, asks Claude to pick and annotate the best items (plus web search on their topics), and publishes the edition to a password-protected Cloudflare Worker. The reader opens it as their Chrome new tab and as a home-screen app on their phone. Clicking a headline marks it read; "Save for later" keeps an item at the top until clicked.

If the user asks you to set this up (or just opens this repo and says "go"), follow the steps below in order. Keep the user's effort low: do everything you can yourself, and only hand them the steps that need their browser or a secret. Never ask the user to paste a token or password into the chat; secrets go straight from their terminal into `gh secret set` or `wrangler secret put`.

## Files

| File | What it is |
|---|---|
| `profile.md` | Who the reader is, their topics in priority order, what to skip, search ideas. The editor reads it every day. **The main thing to customize.** |
| `feeds.txt` | Sources checked daily (format documented at the top). Ships with an example list. |
| `config.json` | Page title, site URL, timezone, model, section names (page order; last one is the catch-all). |
| `prompt.md` | Editorial instructions; `{{PROFILE}}` is replaced with `profile.md`. Rarely needs edits. |
| `generate.py` | The build: fetch feeds, call `claude -p` (tools limited to WebSearch/WebFetch), validate links, publish via the Worker. `--fetch-only` tests feeds; `--dry-run` builds without publishing; `--include-shown` rebuilds today without skipping posts already shown. |
| `worker.js` | Cloudflare Worker: login, page rendering, read/save tracking, build endpoints. |
| `.github/workflows/build.yml` | Daily schedule. |
| `extension/` | Tiny Chrome extension that shows the page on every new tab. |

## Step 0: prerequisites

Check, and install what's missing (ask before installing anything):
- `python3` 3.9+, `node`/`npx`, `git`.
- `gh` (GitHub CLI), logged in: `gh auth status`. If not logged in, the user runs `gh auth login` in their terminal.
- A Cloudflare account (free tier is enough). The user runs `npx -y wrangler@4 login` in their terminal; it opens a browser.
- A Claude plan that includes Claude Code (Pro or Max), or an Anthropic API key. Builds cost roughly \$0.40 to \$1 each.

If this folder is a clone of the template repo, remove the template's remote (`git remote remove origin`) so their copy gets its own repo in step 4.

## Step 1: interview the user

Use AskUserQuestion (batched) to learn:
1. **Who they are and what they work on**, and their topics in priority order. Ask what they'd be annoyed to miss.
2. **Sources.** Start from the menu in `feeds.txt`: about 40 working sources on AI safety and governance, democracy and elections, news, and ideas,. Show it to the user as a short list grouped by its `# ---` headings (one line per source: name plus a few words on what it is). **The default is to keep all of them**; ask which groups or individual sources to drop, rather than making them pick from scratch. Ask whether any sources should **always** be included (every new post, no filtering); mark those with a note starting `ALWAYS`. Then ask what to add: newsletters, Substacks, blogs, outlets, forums, subreddits, think tanks. Offer to look at their most-visited sites in Chrome history (only with explicit permission; read the `History` SQLite file from a copy, top domains over the last 30 days) to jog their memory.
3. **What to skip.**
4. **Sections**: 3 to 5 headings for the page, in order. Suggest some from their topics.
5. **Timezone and build time** (default 6am local), and a **page title** (default "Front Page").
6. **Password** for the site: something they'll remember (their password manager will usually save it). The site is private by default; a password keeps strangers from seeing their reading list and marking things read.

Tell them up front what isn't possible: X/Twitter and other logged-in feeds (the build runs on a server without their logins), and sites that block automated readers (handled with targeted web search instead).

## Step 2: write their profile and sources

- Rewrite `profile.md` from scratch in plain prose (fill in every section of the template). Be concrete: name the organizations, people, bills, or beats they care about.
- Edit `feeds.txt`: delete the sources they dropped (keep the rest, including their `| notes`), and add theirs. Finding feeds for new sources:
  - Substack (including custom domains): `https://HOST/api/v1/archive?sort=new&limit=1` returns JSON. Use type `substack` with the host only.
  - Otherwise try `/feed`, `/rss`, `/feed.xml`, `/rss.xml`, `/atom.xml`, `?format=rss` (Squarespace), or look for `<link rel="alternate" type="application/rss+xml">` in the homepage HTML.
  - Reddit: `https://www.reddit.com/r/NAME/top.rss?t=day&limit=25`.
  - If a site has no feed or returns a Cloudflare challenge, use type `site` with the domain; the editor searches it daily.
  - Add a `| note` to any high-volume or mixed source (e.g. "only posts about X, at most 2 per day").
- Update `config.json`: sections, timezone, page title.
- Test: `python3 generate.py --fetch-only > /dev/null`. It prints each source with its item count and any error. Zero items with no error just means nothing new in the last 7 days. Fix or remove sources that error.

## Step 3: Cloudflare Worker

```bash
npx -y wrangler@4 whoami                          # confirm login
npx -y wrangler@4 kv namespace create FRONT        # copy the id into wrangler.toml (REPLACE_WITH_KV_NAMESPACE_ID)
```

- Set the Worker `name` in `wrangler.toml` (default `front-page`).
- Write the user's chosen password to `.password` (gitignored, no trailing newline).
- Create the build token and store it outside the repo:
  ```bash
  mkdir -p ~/.config/front-page
  echo "BUILD_TOKEN=$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))')" >> ~/.config/front-page/secrets.env
  chmod 600 ~/.config/front-page/secrets.env
  grep '^BUILD_TOKEN=' ~/.config/front-page/secrets.env | cut -d= -f2- | tr -d '\n' | npx -y wrangler@4 secret put BUILD_TOKEN
  ```
- Deploy with `./deploy.sh` (deploys and sets `SITE_PASSWORD` from `.password`). The deploy output prints the URL, `https://NAME.SUBDOMAIN.workers.dev`. If wrangler asks to register a workers.dev subdomain, the user picks one.
- Put that URL in `config.json` (`site_url`), `extension/newtab.html`, and `extension/manifest.json` (replace `REPLACE_WITH_SITE_URL`, no trailing slash in config).
- Check: `curl -s -o /dev/null -w '%{http_code}' SITE_URL` returns 401 (login page).

## Step 4: GitHub repo and daily schedule

```bash
git init -q 2>/dev/null; git add -A && git commit -qm "My Front Page"
gh repo create front-page --private --source . --push
grep '^BUILD_TOKEN=' ~/.config/front-page/secrets.env | cut -d= -f2- | tr -d '\n' | gh secret set BUILD_TOKEN
```

Claude credentials for the build. Hand the user exactly one of these to run in **their own terminal** (do not run it for them, and never echo the token):
- Claude plan: run `claude setup-token`, copy the token it prints, then run `gh secret set CLAUDE_CODE_OAUTH_TOKEN -R OWNER/front-page` and paste it.
- API key: run `gh secret set ANTHROPIC_API_KEY -R OWNER/front-page` and paste the key. If both are set, the API key is used.

Confirm with `gh secret list`.

Schedule: convert the user's build time to UTC and set the `cron` line in `.github/workflows/build.yml` (format `minute hour * * *`, UTC; note daylight saving shifts it by an hour). Commit and push.

## Step 5: first build

```bash
gh workflow run build.yml
gh run watch $(gh run list --limit 1 --json databaseId -q '.[0].databaseId') --exit-status
gh run view --log | grep -E 'Error|claude cost|edition:'
```

Check the log for sources that failed only in the cloud (some sites block GitHub's servers; Substack is already handled through the Worker relay). Switch persistent failures to `site` entries. Then have the user open the site and sign in.

## Step 6: install on their devices

Give the user these steps:
- **Chrome new tab**: `chrome://extensions` → turn on Developer mode → Load unpacked → choose this repo's `extension` folder → open a new tab and sign in. Remove any other new-tab extension.
- **iPhone**: open the site in Safari, sign in, Share → Add to Home Screen. Open it from the icon and sign in once more (home-screen apps keep their own login).
- **Android**: open in Chrome, sign in, menu → Add to Home screen.

## Later changes

- To change topics, sources, or sections: edit `profile.md`, `feeds.txt`, or `config.json`, then commit and push. The next build uses them.
- Build now: `gh workflow run build.yml` (add `-f dry_run=true` to test without publishing).
- After editing `worker.js`: `./deploy.sh`.
- Failed scheduled builds email the repo owner (GitHub default).

## Known gotchas

- Substack blocks GitHub Actions IPs on its API. `generate.py` falls back to each Substack's RSS feed fetched through the Worker's `/api/build/fetch` relay, with retries on 429.
- Some sites (Cloudflare-protected news sites like Lawfare) block all feed readers: use `site` entries.
- Local Worker testing (`wrangler dev`) may need `--compatibility-date` set to an older date if the local runtime is behind.
- The build runs `claude -p` with only WebSearch and WebFetch enabled, and treats feed and web content as untrusted.
