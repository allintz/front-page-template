# Front Page

A private reading page that Claude writes for you every morning, from the newsletters, blogs, and outlets you choose plus a daily web search on your topics. It opens as your Chrome new tab and as an app on your phone. Clicking a headline marks it read; **Save for later** keeps something at the top until you get to it.

Inspired by [ThariqS/ai-newtab](https://github.com/ThariqS/ai-newtab); this version runs on a schedule in the cloud (no computer needs to be on), works on your phone, and remembers what you've read.

## Set it up (about 20 minutes, mostly Claude's work)

You need: [Claude Code](https://claude.com/claude-code) (the desktop app's Code tab works), a Claude Pro or Max plan or an Anthropic API key, a GitHub account, and a free Cloudflare account.

Open Claude Code in an empty folder and say:

> Clone https://github.com/allintz/front-page-template and set up my Front Page.

Claude follows the runbook in [CLAUDE.md](CLAUDE.md): it interviews you about your topics, shows you the default menu of about 40 sources (AI safety and governance, democracy and elections, news, ideas) to trim, adds your own, finds working feeds, deploys your own copy, and walks you through the few steps that need your browser (logging in to Cloudflare and GitHub, adding your Claude token).

## Cost

Each daily build is one Claude session, about \$0.40 to \$1 on Sonnet. Hosting is free (Cloudflare Workers free tier, GitHub Actions free minutes).

## Privacy

Your page, reading history, and saved items live in your own Cloudflare account behind a password. Your sources and profile live in your own private GitHub repo. The build sends feed headlines and your profile to Claude.
