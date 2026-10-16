#!/usr/bin/env python3
"""Front Page daily build.

1. Fetch recent posts from feeds.txt (stdlib only).
2. Read reading state (what the reader clicked or saved) from the Worker.
3. Ask Claude (via `claude -p`, tools limited to WebSearch/WebFetch) to pick and
   annotate items and add topic news from web search. Returns JSON only.
4. Validate links and write the edition to KV. Saved-for-later items live in
   KV "state" and are rendered by the Worker, so they persist across editions.

Usage: generate.py [--fetch-only] [--dry-run]
  --fetch-only  print the candidate feed items and stop (no Claude call)
  --dry-run     build the edition but write it to data/edition.json, not KV
"""
import datetime as dt
import hashlib
import html
import json
import os
import random
import re
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
CONFIG = json.loads((ROOT / "config.json").read_text())
SITE = os.environ.get("FRONT_PAGE_URL") or CONFIG["site_url"].rstrip("/")
CLAUDE_BIN = os.environ.get("CLAUDE_BIN") or shutil.which("claude") or str(Path.home() / ".local/bin/claude")
MODEL = os.environ.get("FRONT_PAGE_MODEL") or CONFIG.get("model", "claude-sonnet-5-5")
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"
FEED_WINDOW_DAYS = 7   # long enough for weekly newsletters; anything shown before is filtered out
RECENT_DAYS = 7   # items shown in the last week are passed to Claude so it doesn't repeat them
SECTIONS = CONFIG["sections"]   # page order; the last one is the catch-all

NOW = dt.datetime.now(dt.timezone.utc)
TIMEZONE = CONFIG.get("timezone", "America/New_York")
LOCAL_NOW = NOW.astimezone(ZoneInfo(TIMEZONE))


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def item_id(url: str) -> str:
    u = urllib.parse.urlsplit(url.strip())
    norm = f"{u.netloc.lower().removeprefix('www.')}{u.path.rstrip('/')}"
    return hashlib.sha1(norm.encode()).hexdigest()[:12]


def http_get(url, data=None, headers=None, timeout=20):
    h = {"User-Agent": UA, "Accept": "*/*"}
    h.update(headers or {})
    req = urllib.request.Request(url, data=data, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def clean(text, n=280):
    text = re.sub(r"<[^>]+>", " ", html.unescape(text or ""))
    text = re.sub(r"\s+", " ", text).strip()
    return text[:n]


def parse_date(s):
    if not s:
        return None
    s = s.strip()
    for fmt in ("%a, %d %b %Y %H:%M:%S %z", "%a, %d %b %Y %H:%M:%S %Z", "%Y-%m-%dT%H:%M:%S%z"):
        try:
            d = dt.datetime.strptime(s, fmt)
            return d if d.tzinfo else d.replace(tzinfo=dt.timezone.utc)
        except ValueError:
            pass
    try:
        d = dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=dt.timezone.utc)
    except ValueError:
        return None


# ------------------------------------------------------------------ feeds ---

def read_feeds():
    feeds = []
    for line in (ROOT / "feeds.txt").read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split(None, 2)
        if len(parts) < 2:
            continue
        name, _, note = (parts[2] if len(parts) > 2 else parts[1]).partition("|")
        feeds.append({"type": parts[0], "src": parts[1], "name": name.strip(), "note": note.strip()})
    return feeds


def fetch_substack(f):
    host = f["src"].removeprefix("https://").strip("/")
    try:
        raw = http_get(f"https://{host}/api/v1/archive?sort=new&limit=12")
    except urllib.error.HTTPError:
        # Substack blocks datacenter IPs (GitHub Actions) on its API; its RSS feed,
        # fetched through the Worker relay, still works.
        relay = f"{SITE}/api/build/fetch?url=" + urllib.parse.quote(f"https://{host}/feed", safe="")
        for wait in (0, 5, 15, 30):  # Substack rate-limits bursts (429); back off and retry
            time.sleep(wait + random.random() * 3)
            try:
                return parse_rss(http_get(relay, headers={"Authorization": f"Bearer {os.environ['BUILD_TOKEN']}"}))
            except urllib.error.HTTPError as e:
                if e.code != 429 or wait == 30:
                    raise
    out = []
    for p in json.loads(raw):
        out.append({
            "title": p.get("title") or "",
            "url": p.get("canonical_url") or f"https://{host}/p/{p.get('slug')}",
            "summary": clean(p.get("subtitle") or p.get("description") or ""),
            "published": p.get("post_date"),
            "paywalled": p.get("audience") == "only_paid",
        })
    return out


def fetch_rss(f):
    return parse_rss(http_get(f["src"]))


def parse_rss(raw):
    root = ET.fromstring(raw)
    out = []
    atom = "{http://www.w3.org/2005/Atom}"
    for it in root.iter("item"):
        out.append({
            "title": clean(it.findtext("title"), 200),
            "url": (it.findtext("link") or "").strip(),
            "summary": clean(it.findtext("description")),
            "published": it.findtext("pubDate") or it.findtext("{http://purl.org/dc/elements/1.1/}date"),
        })
    for it in root.iter(f"{atom}entry"):
        link = it.find(f"{atom}link[@rel='alternate']") or it.find(f"{atom}link")
        out.append({
            "title": clean(it.findtext(f"{atom}title"), 200),
            "url": link.get("href") if link is not None else "",
            "summary": clean(it.findtext(f"{atom}summary") or it.findtext(f"{atom}content")),
            "published": it.findtext(f"{atom}published") or it.findtext(f"{atom}updated"),
        })
    return out


def fetch_forum(f):
    host = "www.lesswrong.com" if f["type"] == "lesswrong" else "forum.effectivealtruism.org"
    q = {"query": '{ posts(input: {terms: {view: "magic", limit: 30}}) { results { title pageUrl postedAt baseScore commentCount } } }'}
    raw = http_get(f"https://{host}/graphql", data=json.dumps(q).encode(),
                   headers={"Content-Type": "application/json"})
    out = []
    for p in json.loads(raw)["data"]["posts"]["results"]:
        out.append({
            "title": p["title"],
            "url": p["pageUrl"],
            "summary": f"karma {p['baseScore']}, {p['commentCount']} comments",
            "published": p["postedAt"],
        })
    return out


FETCHERS = {"substack": fetch_substack, "rss": fetch_rss, "lesswrong": fetch_forum, "eaforum": fetch_forum}


def fetch_all(feeds):
    feeds = [f for f in feeds if f["type"] in FETCHERS]
    cutoff = NOW - dt.timedelta(days=FEED_WINDOW_DAYS)

    def one(f):
        try:
            items = FETCHERS[f["type"]](f)
        except Exception as e:  # one dead feed must not sink the build
            return f, [], f"{type(e).__name__}: {e}"
        keep = []
        for it in items:
            d = parse_date(it.get("published"))
            if not it.get("url") or not it.get("title") or (d and d < cutoff):
                continue
            it["published"] = d.date().isoformat() if d else None
            it["source"] = f["name"]
            it["id"] = item_id(it["url"])
            keep.append(it)
        return f, keep[:12], None

    with ThreadPoolExecutor(8) as ex:
        results = list(ex.map(one, feeds))
    cands, report = [], []
    for f, items, err in results:
        report.append({"source": f["name"], "items": len(items), "error": err})
        cands.extend(items)
    return cands, report


# ----------------------------------------------------------------- Worker ---
# Build state (read/saved state, shown-item history) lives in the Worker's KV, so the
# build can run anywhere (GitHub Actions or the Mac). Authenticated with BUILD_TOKEN.

def worker(method, path, body=None):
    req = urllib.request.Request(
        SITE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {os.environ['BUILD_TOKEN']}",
                 "Content-Type": "application/json", "User-Agent": "front-page-build"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


# ----------------------------------------------------------------- Claude ---

def ask_claude(cands, recent, saved_titles, feeds):
    prompt = (ROOT / "prompt.md").read_text().replace("{{PROFILE}}", (ROOT / "profile.md").read_text().strip())
    payload = {
        "today": LOCAL_NOW.strftime("%A %Y-%m-%d"),
        "sections": SECTIONS,
        "feed_candidates": [{k: c[k] for k in ("id", "source", "title", "url", "summary", "published")} | (
            {"paywalled": True} if c.get("paywalled") else {}) for c in cands],
        "source_notes": {f["name"]: f["note"] for f in feeds if f["note"] and f["type"] != "site"},
        "sites_to_search": [{"domain": f["src"], "name": f["name"], "note": f["note"]} for f in feeds if f["type"] == "site"],
        "recently_shown_urls": recent,
        "saved_for_later": saved_titles,
    }
    full = prompt + "\n\n## Input data\n\n```json\n" + json.dumps(payload, indent=1) + "\n```\n"
    env = dict(os.environ)
    if env.get("ANTHROPIC_API_KEY"):
        env.pop("CLAUDE_CODE_OAUTH_TOKEN", None)  # bill to the API key (Max-plan credits)
    else:
        env.pop("ANTHROPIC_API_KEY", None)  # an empty value (unset GitHub secret) must not shadow the OAuth token
    workdir = DATA / "claude-cwd"
    workdir.mkdir(exist_ok=True)
    r = subprocess.run(
        [CLAUDE_BIN, "-p", "--model", MODEL, "--output-format", "json",
         "--tools", "WebSearch,WebFetch", "--allowedTools", "WebSearch,WebFetch",
         "--setting-sources", "",
         "--strict-mcp-config", "--no-session-persistence"],
        input=full, cwd=workdir, env=env, capture_output=True, text=True, timeout=1800)
    if r.returncode != 0:
        raise RuntimeError(f"claude exited {r.returncode}: {r.stderr[-800:]} {r.stdout[-800:]}")
    outer = json.loads(r.stdout)
    text = outer.get("result", "")
    log(f"claude cost: ${outer.get('total_cost_usd', 0):.2f}, turns: {outer.get('num_turns')}")
    m = re.search(r"```json\s*(\{.*\})\s*```", text, re.S) or re.search(r"(\{.*\})", text, re.S)
    if not m:
        raise RuntimeError(f"no JSON in Claude reply: {text[:500]}")
    return json.loads(m.group(1)), outer.get("total_cost_usd")


def link_ok(url):
    try:
        req = urllib.request.Request(url, method="GET", headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status < 400
    except urllib.error.HTTPError as e:
        return e.code in (401, 403, 405, 429)  # bot walls and paywalls still mean the page exists
    except Exception:
        return False


# ------------------------------------------------------------------- main ---

def main():
    args = set(sys.argv[1:])
    DATA.mkdir(exist_ok=True)
    feeds = read_feeds()
    cands, report = fetch_all(feeds)
    for r in report:
        log(f"  {r['source']:<40} {r['items']:>3}  {r['error'] or ''}")
    if "--fetch-only" in args:
        print(json.dumps(cands, indent=1))
        return

    remote = worker("GET", "/api/build/state")
    history = remote.get("history") or {}   # every item shown, with first_seen, so nothing repeats
    state = remote.get("state") or {"read": {}, "saved": {}}

    cands = [c for c in cands if c["id"] not in history]  # only show each feed post once
    week_ago = (NOW - dt.timedelta(days=RECENT_DAYS)).isoformat()
    recent = [h["url"] for h in history.values() if h["first_seen"] >= week_ago]
    saved_titles = [s.get("title") for s in state.get("saved", {}).values()]

    out, cost = ask_claude(cands, recent, saved_titles, feeds)
    by_id = {c["id"]: c for c in cands}

    items, seen = [], set()
    for it in out.get("items", []):
        url = (it.get("url") or "").strip()
        if not url.startswith("http"):
            continue
        iid = item_id(url)
        if iid in seen:
            continue
        if iid not in by_id and not link_ok(url):
            log(f"  dropped dead link: {url}")
            continue
        seen.add(iid)
        src = by_id.get(iid, {})
        section = it.get("section") if it.get("section") in SECTIONS else SECTIONS[-1]
        items.append({
            "id": iid, "url": url,
            "title": it.get("title") or src.get("title", url),
            "source": it.get("source") or src.get("source", urllib.parse.urlsplit(url).netloc),
            "section": section,
            "blurb": it.get("blurb", ""),
            "importance": int(it.get("importance", 1)),
            "published": it.get("published") or src.get("published"),
        })

    stamp = NOW.isoformat()
    for i in items:
        if i["id"] not in history:
            history[i["id"]] = i | {"first_seen": stamp}
    # Keep history to 30 days.
    month_ago = (NOW - dt.timedelta(days=30)).isoformat()
    history = {k: v for k, v in history.items() if v["first_seen"] >= month_ago}

    lead = out.get("lead_url")
    edition = {
        "generated_at": stamp,
        "generated_local": LOCAL_NOW.strftime("%Y-%m-%d %H:%M"),
        "dek": out.get("dek", ""),
        "lead_id": item_id(lead) if lead else (items[0]["id"] if items else None),
        "sections": SECTIONS,
        "items": items,
        "sources": report,
        "searches": out.get("searches", []),
        "cost_usd": cost,
        "model": MODEL,
        "timezone": TIMEZONE,
        "title": CONFIG.get("page_title", "Front Page"),
    }
    (DATA / "edition.json").write_text(json.dumps(edition, indent=1))
    if "--dry-run" not in args:
        worker("PUT", "/api/build/edition", {"edition": edition, "history": history})
    log(f"edition: {len(items)} items")


if __name__ == "__main__":
    main()
