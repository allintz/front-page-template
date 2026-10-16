// Front Page: private daily reading page.
// KV (binding FRONT): "edition" + "history" (written by generate.py via /api/build/*), "state" (read/saved, written here).
// Secrets: SITE_PASSWORD (login), BUILD_TOKEN (build endpoints). Login sets a year-long cookie so the phone home-screen app stays signed in.

const COOKIE = 'fp_auth';
const READ_KEEP_DAYS = 30;

async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function getState(env) {
  return (await env.FRONT.get('state', 'json')) || { read: {}, saved: {} };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Public: icons and manifest (home-screen install fetches these).
    if (/^\/(icon-\d+\.png|apple-touch-icon\.png|manifest\.webmanifest|favicon\.ico)$/.test(path)) {
      return env.ASSETS.fetch(request);
    }

    // Build endpoints for generate.py (GitHub Actions or the Mac), bearer-token auth.
    if (path.startsWith('/api/build/')) {
      if (!env.BUILD_TOKEN || request.headers.get('Authorization') !== `Bearer ${env.BUILD_TOKEN}`) {
        return json({ ok: false }, 401);
      }
      if (path === '/api/build/state' && request.method === 'GET') {
        const [state, history] = await Promise.all([getState(env), env.FRONT.get('history', 'json')]);
        return json({ state, history: history || {} });
      }
      // Fetch relay: Substack blocks GitHub Actions IPs, so the build fetches Substack feeds through here.
      if (path === '/api/build/fetch' && request.method === 'GET') {
        const target = url.searchParams.get('url') || '';
        if (!/^https:\/\//.test(target)) return json({ ok: false }, 400);
        const res = await fetch(target, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FrontPage/1.0)', Accept: 'application/json, application/xml, */*' } });
        return new Response(res.body, { status: res.status, headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/octet-stream' } });
      }
      if (path === '/api/build/edition' && request.method === 'PUT') {
        const { edition, history } = await request.json();
        if (!edition?.items) return json({ ok: false, error: 'bad edition' }, 400);
        await Promise.all([env.FRONT.put('edition', JSON.stringify(edition)), env.FRONT.put('history', JSON.stringify(history || {}))]);
        return json({ ok: true });
      }
      return json({ ok: false }, 404);
    }

    const token = await sha256('front-page:' + (env.SITE_PASSWORD || ''));
    const cookies = Object.fromEntries((request.headers.get('Cookie') || '').split(/;\s*/).map((c) => c.split('=')));
    const authed = env.SITE_PASSWORD && cookies[COOKIE] === token;

    if (path === '/login' && request.method === 'POST') {
      const form = await request.formData();
      if (env.SITE_PASSWORD && form.get('password') === env.SITE_PASSWORD) {
        return new Response(null, {
          status: 303,
          headers: { Location: '/', 'Set-Cookie': `${COOKIE}=${token}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=None` },
        });
      }
      return html(loginPage(true), 401);
    }
    if (!authed) return html(loginPage(false), 401);

    if (path === '/api/read' && request.method === 'POST') {
      const { id } = await request.json();
      const state = await getState(env);
      state.read[id] = Date.now();
      delete state.saved[id];
      const cutoff = Date.now() - READ_KEEP_DAYS * 864e5;
      for (const [k, t] of Object.entries(state.read)) if (t < cutoff) delete state.read[k];
      await env.FRONT.put('state', JSON.stringify(state));
      return json({ ok: true });
    }
    if (path === '/api/save' && request.method === 'POST') {
      const { id, on } = await request.json();
      const [state, edition] = await Promise.all([getState(env), env.FRONT.get('edition', 'json')]);
      if (on) {
        const item = [...(edition?.items || []), ...Object.values(state.saved)].find((i) => i.id === id);
        if (!item) return json({ ok: false, error: 'unknown item' }, 404);
        state.saved[id] = { ...item, saved_at: Date.now() };
        delete state.read[id];
      } else {
        delete state.saved[id];
      }
      await env.FRONT.put('state', JSON.stringify(state));
      return json({ ok: true });
    }
    if (path === '/' || path === '/index.html') {
      const [state, edition] = await Promise.all([getState(env), env.FRONT.get('edition', 'json')]);
      return html(renderPage(edition, state));
    }
    return new Response('Not found', { status: 404 });
  },
};

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

// ------------------------------------------------------------------ views ---

const HEAD = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Front Page">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="theme-color" content="#fdfdf8" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#171714" media="(prefers-color-scheme: dark)">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="icon" href="/icon-192.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400;0,500;0,600;1,400&display=swap" rel="stylesheet">
<style>
:root {
  --bg: #fdfdf8; --fg: #111111; --muted: #4a4a46; --rule: #dddcd4; --mark: #8b1e1e; --link: #111111;
  --f-body: "EB Garamond", Garamond, "Times New Roman", serif;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #171714; --fg: #e9e7de; --muted: #a9a79c; --rule: #34332d; --mark: #e0786e; --link: #e9e7de; color-scheme: dark } }
:root[data-theme="dark"] { --bg: #171714; --fg: #e9e7de; --muted: #a9a79c; --rule: #34332d; --mark: #e0786e; --link: #e9e7de; color-scheme: dark }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--fg); font-family: var(--f-body); font-size: 19px; line-height: 1.5; }
.page { max-width: 44em; margin: 0 auto; padding: max(40px, env(safe-area-inset-top)) 20px 80px; }
header { border-bottom: 1px solid var(--fg); padding-bottom: 14px; margin-bottom: 8px; }
.date { font-variant: small-caps; letter-spacing: .06em; color: var(--muted); font-size: 16px; }
h1 { font-size: 44px; font-weight: 400; line-height: 1.05; margin: 2px 0 8px; }
.dek { font-size: 21px; font-style: italic; color: var(--muted); margin: 0 0 8px; text-wrap: pretty; }
.status { font-size: 14px; color: var(--muted); margin: 0; }
.status.stale { color: var(--mark); }
h2 { font-size: 24px; font-weight: 400; font-style: italic; margin: 36px 0 4px; padding-bottom: 4px; border-bottom: 1px solid var(--rule); }
h2 .count { font-style: normal; font-size: 15px; color: var(--muted); margin-left: 6px; }
.item { padding: 14px 0; border-bottom: 1px solid var(--rule); }
.item:last-child { border-bottom: 0; }
.item a.t { color: var(--link); text-decoration: none; font-weight: 500; font-size: 21px; line-height: 1.25; display: block; text-wrap: pretty; }
.item a.t:hover { text-decoration: underline; text-underline-offset: 3px; }
.item .b { margin: 4px 0 4px; }
.meta { font-size: 14px; color: var(--muted); display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; }
.save { font: inherit; font-size: 14px; color: var(--muted); background: none; border: 0; padding: 6px 0; margin-left: auto; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; min-height: 32px; }
.save[aria-pressed="true"] { color: var(--mark); }
.item.read { opacity: .45; }
.item.read a.t::after { content: " (read)"; font-weight: 400; font-size: 15px; color: var(--muted); }
.lead { padding: 22px 0 18px; border-bottom: 1px solid var(--fg); }
.lead a.t { font-size: 32px; line-height: 1.12; font-weight: 500; }
.lead .b { font-size: 20px; }
.empty { color: var(--muted); font-style: italic; }
footer { margin-top: 48px; font-size: 14px; color: var(--muted); border-top: 1px solid var(--rule); padding-top: 12px; }
footer details { margin-top: 6px; }
form.login { max-width: 22em; margin: 20vh auto 0; padding: 0 20px; }
form.login input { font: inherit; width: 100%; padding: 10px; margin: 10px 0; border: 1px solid var(--rule); background: transparent; color: var(--fg); }
form.login button { font: inherit; padding: 8px 16px; border: 1px solid var(--fg); background: transparent; color: var(--fg); cursor: pointer; }
@media (max-width: 560px) {
  body { font-size: 18px; }
  h1 { font-size: 36px; }
  .lead a.t { font-size: 27px; }
  .item a.t { font-size: 20px; }
}
</style>`;

function loginPage(failed) {
  return `<!doctype html><html lang="en"><head>${HEAD}<title>Front Page</title></head><body>
<form class="login" method="post" action="/login">
<h1>Front Page</h1>
${failed ? '<p class="status stale">Wrong password.</p>' : ''}
<input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus>
<button type="submit">Sign in</button>
</form></body></html>`;
}

function ago(iso) {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 864e5);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
}

function itemHtml(it, state, { lead = false, note = '' } = {}) {
  const read = Boolean(state.read[it.id]);
  const saved = Boolean(state.saved[it.id]);
  const date = it.published ? `<span>${esc(it.published)}</span>` : '';
  return `<article class="item${lead ? ' lead' : ''}${read ? ' read' : ''}" data-id="${esc(it.id)}">
<a class="t" href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title)}</a>
${it.blurb ? `<p class="b">${esc(it.blurb)}</p>` : ''}
<div class="meta"><span>${esc(it.source)}</span>${date}${note ? `<span>${esc(note)}</span>` : ''}
<button class="save" type="button" aria-pressed="${saved}">${saved ? 'Saved' : 'Save for later'}</button></div>
</article>`;
}

function renderPage(edition, state) {
  const title = esc(edition?.title || 'Front Page');
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: edition?.timezone || 'America/New_York' });
  if (!edition) {
    return `<!doctype html><html lang="en"><head>${HEAD}<title>${title}</title></head><body><main class="page">
<header><div class="date">${esc(dateStr)}</div><h1>${title}</h1></header>
<p class="empty">No edition yet. The first one appears after the daily build runs.</p></main></body></html>`;
  }
  const hoursOld = (Date.now() - Date.parse(edition.generated_at)) / 36e5;
  const stale = hoursOld > 30;
  const items = edition.items || [];
  const lead = items.find((i) => i.id === edition.lead_id);
  const saved = Object.values(state.saved || {}).sort((a, b) => b.saved_at - a.saved_at);
  const okSources = (edition.sources || []).filter((s) => !s.error).length;

  let body = '';
  if (lead) body += itemHtml(lead, state, { lead: true });
  if (saved.length) {
    body += `<h2>Saved for later<span class="count">${saved.length}</span></h2>`;
    body += saved.map((i) => itemHtml(i, state, { note: `saved ${ago(new Date(i.saved_at).toISOString())}` })).join('');
  }
  for (const sec of edition.sections || []) {
    const its = items.filter((i) => i.section === sec && i.id !== edition.lead_id && !state.saved[i.id]);
    if (!its.length) continue;
    body += `<h2>${esc(sec)}<span class="count">${its.length}</span></h2>` + its.map((i) => itemHtml(i, state)).join('');
  }

  const failed = (edition.sources || []).filter((s) => s.error).map((s) => s.source);
  return `<!doctype html><html lang="en"><head>${HEAD}<title>${title}</title></head><body><main class="page">
<header>
<div class="date">${esc(dateStr)}</div>
<h1>${title}</h1>
${edition.dek ? `<p class="dek">${esc(edition.dek)}</p>` : ''}
<p class="status${stale ? ' stale' : ''}">Built ${esc(edition.generated_local)}${stale ? ' (more than a day old; the daily build may have failed)' : ''} · ${items.length} items from ${okSources} feeds and web search</p>
</header>
${body}
<footer>
Click a headline and it counts as read. Saved items stay at the top until you open them.
<details><summary>Sources and searches</summary>
<p>Feeds: ${(edition.sources || []).map((s) => `${esc(s.source)} (${s.error ? 'failed' : s.items})`).join(', ')}.</p>
${(edition.searches || []).length ? `<p>Searches: ${edition.searches.map(esc).join('; ')}.</p>` : ''}
${failed.length ? `<p>Failed today: ${failed.map(esc).join(', ')}.</p>` : ''}
<p>Model: ${esc(edition.model || '')}${edition.cost_usd ? ` · build cost $${Number(edition.cost_usd).toFixed(2)}` : ''}</p>
</details>
</footer>
</main>
<script>
const post = (path, data) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), keepalive: true });
document.addEventListener('click', (e) => {
  const a = e.target.closest('a.t');
  if (a) {
    const art = a.closest('.item');
    document.querySelectorAll('.item[data-id="' + art.dataset.id + '"]').forEach((n) => n.classList.add('read'));
    post('/api/read', { id: art.dataset.id });
    return;
  }
  const btn = e.target.closest('button.save');
  if (btn) {
    const id = btn.closest('.item').dataset.id;
    const on = btn.getAttribute('aria-pressed') !== 'true';
    document.querySelectorAll('.item[data-id="' + id + '"] button.save').forEach((b) => {
      b.setAttribute('aria-pressed', on); b.textContent = on ? 'Saved' : 'Save for later';
    });
    post('/api/save', { id, on });
  }
});
// Refresh when the app comes back to the foreground after a while, so a new edition shows up.
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) hiddenAt = Date.now();
  else if (hiddenAt && Date.now() - hiddenAt > 30 * 60e3) location.reload();
});
</script>
</body></html>`;
}
