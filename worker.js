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
.page { max-width: 50em; }
header.mast { text-align: center; border-bottom: 0; padding-bottom: 0; margin-bottom: 0; }
.ear { display: flex; justify-content: space-between; gap: 12px; font-variant: small-caps; letter-spacing: .06em; color: var(--muted); font-size: 15px; border-bottom: 1px solid var(--rule); padding-bottom: 6px; }
h1 { font-size: 64px; font-weight: 500; line-height: 1; margin: 14px 0 10px; letter-spacing: -0.01em; }
.rule2 { border-top: 3px double var(--fg); border-bottom: 1px solid var(--fg); height: 4px; margin: 0 0 14px; }
.dek { font-size: 21px; font-style: italic; color: var(--muted); margin: 0 auto 6px; max-width: 34em; text-wrap: balance; }
.status { font-size: 14px; color: var(--muted); margin: 0 0 6px; }
.status.stale { color: var(--mark); }
h2 { font-size: 15px; font-weight: 600; font-variant: small-caps; text-transform: lowercase; letter-spacing: .12em; margin: 40px 0 0; padding-top: 8px; border-top: 2px solid var(--fg); display: flex; justify-content: space-between; }
h2 .count { font-weight: 400; color: var(--muted); letter-spacing: .04em; }
.item { display: flow-root; padding: 18px 0; border-bottom: 1px solid var(--rule); }
.item:last-of-type { border-bottom: 0; }
.kicker { font-size: 13px; font-variant: small-caps; text-transform: lowercase; letter-spacing: .09em; color: var(--mark); margin-bottom: 2px; }
.kicker .when { color: var(--muted); letter-spacing: .04em; }
.item a.t { color: var(--link); text-decoration: none; font-weight: 600; font-size: 22px; line-height: 1.2; display: block; text-wrap: pretty; }
.item a.t:hover { text-decoration: underline; text-underline-offset: 3px; text-decoration-thickness: 1px; }
.item .b { margin: 6px 0 2px; font-size: 18px; line-height: 1.45; text-wrap: pretty; }
.thumb { display: block; float: right; width: 132px; aspect-ratio: 1; overflow: hidden; background: var(--rule); margin: 4px 0 10px 20px; }
.thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.meta { font-size: 14px; color: var(--muted); display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; }
.save { font: inherit; font-size: 14px; color: var(--muted); background: none; border: 0; padding: 6px 0; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; min-height: 32px; }
.save[aria-pressed="true"] { color: var(--mark); }
.item.read { opacity: .45; }
.item.read a.t::after { content: " (read)"; font-weight: 400; font-size: 15px; color: var(--muted); }
.lead { display: block; padding: 6px 0 22px; border-bottom: 1px solid var(--fg); }
.lead .thumb { float: none; width: 100%; aspect-ratio: 2 / 1; max-height: 340px; margin: 0 0 14px; }
.lead a.t { font-size: 38px; line-height: 1.08; font-weight: 600; letter-spacing: -0.005em; }
.lead .b { font-size: 20px; }
.empty { color: var(--muted); font-style: italic; }
footer { margin-top: 48px; font-size: 14px; color: var(--muted); border-top: 1px solid var(--rule); padding-top: 12px; }
footer details { margin-top: 6px; }
form.login { max-width: 22em; margin: 20vh auto 0; padding: 0 20px; }
form.login input { font: inherit; width: 100%; padding: 10px; margin: 10px 0; border: 1px solid var(--rule); background: transparent; color: var(--fg); }
form.login button { font: inherit; padding: 8px 16px; border: 1px solid var(--fg); background: transparent; color: var(--fg); cursor: pointer; }
@media (max-width: 560px) {
  body { font-size: 18px; }
  h1 { font-size: 44px; }
  .ear { font-size: 13px; }
  .lead a.t { font-size: 29px; }
  .dek { font-size: 18px; }
  .item a.t { font-size: 20px; }
  .item .b { font-size: 17px; }
  .thumb { width: 92px; margin-left: 14px; }
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

function when(published, tz) {
  if (!published) return '';
  const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });   // YYYY-MM-DD
  const days = Math.round((Date.parse(today) - Date.parse(published)) / 864e5);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(published + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function itemHtml(it, state, { lead = false, note = '', tz = 'America/New_York' } = {}) {
  const read = Boolean(state.read[it.id]);
  const saved = Boolean(state.saved[it.id]);
  const w = when(it.published, tz);
  const img = it.image
    ? `<a class="thumb ti" href="${esc(it.url)}" target="_blank" rel="noopener" tabindex="-1" aria-hidden="true"><img src="${esc(it.image)}" alt="" loading="${lead ? 'eager' : 'lazy'}" referrerpolicy="no-referrer" onerror="this.parentElement.remove()"></a>`
    : '';
  return `<article class="item${lead ? ' lead' : ''}${read ? ' read' : ''}" data-id="${esc(it.id)}">
${img}<div class="txt">
<div class="kicker">${esc(it.source)}${w ? ` <span class="when">· ${esc(w)}</span>` : ''}</div>
<a class="t" href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title)}</a>
${it.blurb ? `<p class="b">${esc(it.blurb)}</p>` : ''}
<div class="meta">${note ? `<span>${esc(note)}</span>` : ''}
<button class="save" type="button" aria-pressed="${saved}">${saved ? 'Saved' : 'Save for later'}</button></div>
</div>
</article>`;
}

function renderPage(edition, state) {
  const title = esc(edition?.title || 'Front Page');
  const now = new Date();
  const tz = edition?.timezone || 'America/New_York';
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: tz });
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
  if (lead) body += itemHtml(lead, state, { lead: true, tz });
  if (saved.length) {
    body += `<h2>Saved for later<span class="count">${saved.length}</span></h2>`;
    body += saved.map((i) => itemHtml(i, state, { note: `saved ${ago(new Date(i.saved_at).toISOString())}`, tz })).join('');
  }
  for (const sec of edition.sections || []) {
    const its = items.filter((i) => i.section === sec && i.id !== edition.lead_id && !state.saved[i.id]);
    if (!its.length) continue;
    body += `<h2>${esc(sec)}<span class="count">${its.length}</span></h2>` + its.map((i) => itemHtml(i, state, { tz })).join('');
  }

  const failed = (edition.sources || []).filter((s) => s.error).map((s) => s.source);
  return `<!doctype html><html lang="en"><head>${HEAD}<title>${title}</title></head><body><main class="page">
<header class="mast">
<div class="ear"><span>${esc(dateStr)}</span><span>${items.length} items · ${okSources} sources</span></div>
<h1>${title}</h1>
<div class="rule2"></div>
${edition.dek ? `<p class="dek">${esc(edition.dek)}</p>` : ''}
<p class="status${stale ? ' stale' : ''}">${stale ? `Built ${esc(edition.generated_local)}, more than a day ago; the daily build may have failed` : `Built ${esc(edition.generated_local)}`}</p>
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
  const a = e.target.closest('a.t, a.ti');
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
