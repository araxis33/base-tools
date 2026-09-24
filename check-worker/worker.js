// deftools-check: the server half of deftools.xyz/check.html.
//
// The on-chain check runs in the visitor's browser (check.js). This Worker does
// the two things a browser can't: keep the AI keys secret, and count the daily
// checks per visitor. Port of meme-scout/ai.py - keep the accuracy rules in step
// with it; the reasons behind each rule are written down there.
//
//   GET  /quota               -> { left, limit }
//   POST /start               -> { ok, ticket, left }   uses one check
//   POST /read {ticket, lang, facts} -> { text, sources, note }   the project read
//   POST /pay {tx}            -> { ok, added, credits }  credits paid checks (0.1 USDC each)
//   GET  /cg?p=<path>         -> CoinGecko answer for the homepage boards, cached
//   GET  /shares?t=NVDA,AAPL  -> real share prices for stocks.html, cached 60 s
//
// Secrets: GEMINI_API_KEY, GROQ_API_KEY, TAVILY_API_KEY (optional). KV: QUOTA.

const LIMIT = 3;
const ORIGINS = ['https://deftools.xyz', 'https://www.deftools.xyz', 'http://localhost:8765'];
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';
const GROQ = 'https://api.groq.com/openai/v1';
const GROQ_MODELS = ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b'];
const BROWSER = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36' };
const AUTO_PAGES = ['dexscreener.com', 'geckoterminal.com', 'basescan.org', 'etherscan.io', 'blockscout.com',
  'web3.binance.com', 'dextools.io', 'birdeye.so', 'defined.fi', 'coinstats.app', 'gmgn.ai'];
const USER_POSTS = ['binance.com/en/square', 'binance.com/square', 'x.com/', 'twitter.com/', 'reddit.com', 'medium.com',
  't.me/', 'youtube.com', 'tiktok.com', 'facebook.com', 'substack.com', 'warpcast.com', 'farcaster'];

let geminiModels = null;

function cors(req) {
  const o = req.headers.get('origin') || '';
  return { 'access-control-allow-origin': ORIGINS.includes(o) ? o : ORIGINS[0], 'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type, x-client, x-owner', 'vary': 'origin' };
}
const json = (req, body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...cors(req) } });
const day = () => new Date().toISOString().slice(0, 10);
const ipOf = (req) => req.headers.get('cf-connecting-ip') || 'unknown';

async function used(env, ip) { return parseInt((await env.QUOTA.get(`q:${ip}:${day()}`)) || '0', 10); }

// ---- paid checks: 0.1 USDC each, sent straight to his wallet ----------------
// Money never passes through us: the visitor's wallet sends USDC to PAY_TO with
// his Base builder code in the calldata, and this Worker only reads the receipt
// to credit the checks. Credits belong to a browser id (not the IP) so they
// survive a new network and do not expire at midnight.
const PAY_TO = '0x335a503b743b569ef1a9e6acc95f70307af146b0';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const PRICE_UNITS = 100000n; // 0.1 USDC, 6 decimals
// Several public Base nodes, tried in turn: mainnet.base.org refused under load
// on 23.09.2026 and a refusal read as "not confirmed yet", so a paid check was
// never credited. A node error is now a reason to ask the next node.
// Probed from inside the Worker on 23.09.2026: these five answer Cloudflare;
// publicnode wants a token, ankr a key, drpc and 1rpc hit limits, llamarpc 525.
const RPCS = ['https://mainnet.base.org', 'https://developer-access-mainnet.base.org', 'https://base.gateway.tenderly.co',
  'https://base.meowrpc.com', 'https://base-mainnet.public.blastapi.io'];

const clientOf = (req) => { const c = req.headers.get('x-client') || ''; return /^[a-f0-9-]{16,64}$/i.test(c) ? c.toLowerCase() : null; };
const isOwner = (req, env) => !!env.OWNER_KEY && req.headers.get('x-owner') === env.OWNER_KEY;
async function credits(env, client) { return client ? parseInt((await env.QUOTA.get(`c:${client}`)) || '0', 10) : 0; }
async function setCredits(env, client, n) { await env.QUOTA.put(`c:${client}`, String(n), { expirationTtl: 400 * 86400 }); }

async function rpc(method, params) {
  let last = 'no node answered';
  for (const url of RPCS) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      if (!r.ok) { last = `${url} ${r.status}`; continue; }
      const j = await r.json();
      if (j.error) { last = `${url} ${j.error.message || j.error.code}`; continue; }
      if (j.result === null && method === 'eth_getTransactionReceipt') { last = 'pending'; continue; }
      return j.result;
    } catch (e) { last = `${url} ${e}`; }
  }
  if (last === 'pending') return null; // every node agrees the tx is not mined yet
  throw new Error(last);
}

// Public Base RPCs mostly refuse Cloudflare's addresses (publicnode wants a
// token, llamarpc answers 525, mainnet.base.org said nothing - 23.09.2026), so a
// real payment stayed "pending". Blockscout answers Workers; it reads the same
// chain and lists the token transfers of a transaction.
async function viaBlockscout(tx) {
  const r = await fetch(`https://base.blockscout.com/api/v2/transactions/${tx}`, { headers: BROWSER });
  if (r.status === 404) return { pending: true };
  if (!r.ok) throw new Error('blockscout ' + r.status);
  const t = await r.json();
  if (!t.status || t.status === 'pending' || !t.block_number) return { pending: true };
  if (t.status !== 'ok') return { failed: true };
  const tt = await fetch(`https://base.blockscout.com/api/v2/transactions/${tx}/token-transfers`, { headers: BROWSER });
  const items = tt.ok ? ((await tt.json()).items || []) : [];
  let paid = 0n;
  for (const i of items) {
    if (((i.token || {}).address_hash || (i.token || {}).address || '').toLowerCase() === USDC
      && ((i.to || {}).hash || '').toLowerCase() === PAY_TO) paid += BigInt((i.total || {}).value || '0');
  }
  return { paid, ts: Date.parse(t.timestamp) / 1000 };
}

async function pay(req, env) {
  const client = clientOf(req);
  if (!client) return { error: 'no client id' };
  let body; try { body = await req.json(); } catch (e) { return { error: 'bad json' }; }
  const tx = String(body.tx || '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(tx)) return { error: 'bad tx' };
  if (await env.QUOTA.get(`p:${tx}`)) return { error: 'used', credits: await credits(env, client) };
  let paid = 0n, ts = 0;
  try {
    const rc = await rpc('eth_getTransactionReceipt', [tx]);
    if (!rc) return { pending: true };
    if (rc.status !== '0x1') return { error: 'failed tx' };
    for (const lg of rc.logs || []) {
      if ((lg.address || '').toLowerCase() === USDC && lg.topics && lg.topics[0] === TRANSFER
        && ('0x' + lg.topics[2].slice(-40)).toLowerCase() === PAY_TO) paid += BigInt(lg.data);
    }
    const blk = await rpc('eth_getBlockByNumber', [rc.blockNumber, false]);
    ts = blk ? parseInt(blk.timestamp, 16) : 0;
  } catch (e) {
    const b = await viaBlockscout(tx);
    if (b.pending) return { pending: true };
    if (b.failed) return { error: 'failed tx' };
    paid = b.paid; ts = b.ts;
  }
  const bought = Number(paid / PRICE_UNITS);
  if (bought < 1) return { error: 'no payment in tx' };
  if (!ts || Date.now() / 1000 - ts > 86400) return { error: 'too old' };
  await env.QUOTA.put(`p:${tx}`, client, { expirationTtl: 400 * 86400 });
  const now = (await credits(env, client)) + bought;
  await setCredits(env, client, now);
  console.log(JSON.stringify({ paid: tx, client, bought, units: String(paid) }));
  return { ok: true, added: bought, credits: now };
}

// ---- CoinGecko for the homepage boards ---------------------------------------
// The boards used to call CoinGecko from every visitor's browser. The free API
// answers a busy address with 429 and no CORS header, so the board fell back to
// its cache and read "18 h ago · offline". Here one copy serves everyone: fresh
// for a few minutes, and a week-old spare when CoinGecko refuses.
const CG = 'https://api.coingecko.com/api/v3/';
const CG_ALLOWED = [/^coins\/list\?include_platform=true$/, /^coins\/markets\?[\w=&%,.-]+$/];

function withCors(req, res, state) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(cors(req))) h.set(k, v);
  h.set('x-cg', state);
  h.set('cache-control', 'public, max-age=60');
  return new Response(res.body, { status: 200, headers: h });
}

async function coingecko(req, ctx, p) {
  if (!CG_ALLOWED.some((r) => r.test(p))) return json(req, { error: 'not allowed' }, 400);
  const cache = caches.default;
  const ttl = p.startsWith('coins/list') ? 43200 : 180;
  const fresh = new Request('https://cg.cache/fresh/' + p);
  const stale = new Request('https://cg.cache/stale/' + p);
  const hit = await cache.match(fresh);
  if (hit) return withCors(req, hit, 'hit');
  let res = null;
  try { res = await fetch(CG + p, { headers: { accept: 'application/json', ...BROWSER } }); } catch (e) { /* use the spare */ }
  if (res && res.ok) {
    const body = await res.arrayBuffer();
    const make = (age) => new Response(body, { headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${age}` } });
    ctx.waitUntil(Promise.all([cache.put(fresh, make(ttl)), cache.put(stale, make(7 * 86400))]));
    return withCors(req, make(ttl), 'miss');
  }
  const old = await cache.match(stale);
  if (old) return withCors(req, old, 'stale');
  return json(req, { error: 'coingecko ' + (res ? res.status : 'unreachable') }, 502);
}

// Real share prices for stocks.html: Yahoo sends no CORS headers, so the page
// can't ask it directly. Last trade, previous close and today's regular session.
async function shares(req, ctx, t) {
  const list = t.split(',').filter((x) => /^[A-Z]{1,5}$/.test(x)).slice(0, 12);
  if (!list.length) return json(req, { error: 'no tickers' }, 400);
  const key = new Request('https://shares.cache/' + list.join(','));
  const hit = await caches.default.match(key);
  if (hit) return withCors(req, hit, 'hit');
  const out = {};
  await Promise.all(list.map(async (s) => {
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${s}?interval=1m&range=1d`, { headers: BROWSER });
      const m = (await r.json()).chart.result[0].meta;
      const reg = (m.currentTradingPeriod || {}).regular || {};
      out[s] = { price: m.regularMarketPrice, time: m.regularMarketTime, prevClose: m.chartPreviousClose,
        open: reg.start, close: reg.end };
    } catch (e) { out[s] = null; }
  }));
  const res = new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=60' } });
  ctx.waitUntil(caches.default.put(key, res.clone()));
  return withCors(req, res, 'miss');
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors(req) });
    if (url.pathname === '/cg') return coingecko(req, ctx, url.searchParams.get('p') || '');
    if (url.pathname === '/shares') return shares(req, ctx, url.searchParams.get('t') || '');
    const ip = ipOf(req);
    const client = clientOf(req);
    const owner = isOwner(req, env);

    if (url.pathname === '/quota') {
      return json(req, { left: Math.max(0, LIMIT - (await used(env, ip))), limit: LIMIT,
        credits: await credits(env, client), owner, payTo: PAY_TO });
    }

    if (url.pathname === '/start' && req.method === 'POST') {
      const n = await used(env, ip);
      let c = await credits(env, client);
      if (!owner) {
        if (n < LIMIT) await env.QUOTA.put(`q:${ip}:${day()}`, String(n + 1), { expirationTtl: 2 * 86400 });
        else if (c > 0) { c -= 1; await setCredits(env, client, c); }
        else return json(req, { ok: false, left: 0, credits: 0 });
      }
      const ticket = crypto.randomUUID();
      await env.QUOTA.put(`t:${ticket}`, ip, { expirationTtl: 1800 });
      return json(req, { ok: true, ticket, left: owner ? LIMIT : Math.max(0, LIMIT - n - 1), credits: c, owner });
    }

    if (url.pathname === '/pay' && req.method === 'POST') {
      try { return json(req, await pay(req, env)); } catch (e) { return json(req, { error: String(e).slice(0, 200) }, 500); }
    }

    if (url.pathname === '/read' && req.method === 'POST') {
      let body;
      try { body = await req.json(); } catch (e) { return json(req, { error: 'bad json' }, 400); }
      const holder = body.ticket && (await env.QUOTA.get(`t:${body.ticket}`));
      if (!holder) return json(req, { error: 'no ticket' }, 403);
      await env.QUOTA.delete(`t:${body.ticket}`); // one read per check
      try {
        return json(req, await projectRead(env, body.facts || {}, body.lang === 'ru' ? 'ru' : 'en'));
      } catch (e) {
        return json(req, { error: String(e).slice(0, 200) }, 500);
      }
    }
    return json(req, { error: 'not found' }, 404);
  },
};

// ------------------------------------------------------------ gathering

const clean = (t, n) => t.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim().slice(0, n);

async function get(url, opts = {}) {
  try { const r = await fetch(url, { headers: BROWSER, ...opts }); return r.ok ? r : null; } catch (e) { return null; }
}

async function website(url) {
  const r = await get(url, { redirect: 'follow' });
  if (!r || !(r.headers.get('content-type') || '').includes('text/html')) return [null, []];
  const html = (await r.text()).slice(0, 200000);
  const repos = [...new Set(html.match(/https?:\/\/github\.com\/[\w.-]+(?:\/[\w.-]+)?/g) || [])].slice(0, 3);
  const title = (html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1];
  return [{ title: 'Project site: ' + (title ? clean(title, 80) : url) + ' (opened today)', url, text: clean(html, 1500) }, repos];
}

async function github(repoUrl) {
  const m = repoUrl.match(/https?:\/\/github\.com\/([\w.-]+)(?:\/([\w.-]+))?/);
  if (!m) return null;
  let [, owner, repo] = m;
  const api = 'https://api.github.com', h = { headers: { ...BROWSER, accept: 'application/vnd.github+json' } };
  if (!repo) {
    const r = (await get(`${api}/orgs/${owner}/repos?sort=pushed&per_page=1`, h)) || (await get(`${api}/users/${owner}/repos?sort=pushed&per_page=1`, h));
    const list = r ? await r.json() : [];
    if (!list.length) return null;
    repo = list[0].name;
  }
  const info = await get(`${api}/repos/${owner}/${repo}`, h);
  if (!info) return null;
  const j = await info.json();
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const c = await get(`${api}/repos/${owner}/${repo}/commits?since=${since}&per_page=100`, h);
  const n = c ? (await c.json()).length : '?';
  return { title: `GitHub ${owner}/${repo} (checked today)`, url: `https://github.com/${owner}/${repo}`,
    text: `Stars ${j.stargazers_count}, last push ${(j.pushed_at || '').slice(0, 10)}, commits in 30 days: ${n}${n === 100 ? '+' : ''}. ${j.description || ''}` };
}

async function search(env, q) {
  if (env.TAVILY_API_KEY) {
    const r = await get('https://api.tavily.com/search', { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.TAVILY_API_KEY}` },
      body: JSON.stringify({ query: q, max_results: 6, search_depth: 'basic' }) });
    if (r) return ((await r.json()).results || []).map((x) => ({ title: clean(x.title || '', 100), url: x.url,
      text: clean(((x.published_date || '').slice(0, 10) + ' ' + (x.content || '')).trim(), 400) }));
  }
  const r = await get('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q));
  if (!r) return [];
  const html = await r.text(), out = [];
  const re = /class="result__a" href="([^"]+)">([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && out.length < 6) {
    let href = m[1];
    const u = href.match(/uddg=([^&]+)/);
    if (u) href = decodeURIComponent(u[1]);
    if (!href.includes('duckduckgo.com/y.js')) out.push({ title: clean(m[2], 100), url: href, text: clean(m[3], 300) });
  }
  return out;
}

function aboutThis(m, f, host, altName) {
  const blob = `${m.title} ${m.url} ${m.text}`.toLowerCase();
  if (blob.includes((f.address || '').toLowerCase()) || (host && blob.includes(host))) return true;
  return [f.name, altName].some((n) => n && n.length >= 4 && n.toLowerCase() !== (f.symbol || '').toLowerCase() && blob.includes(n.toLowerCase()));
}

async function gather(env, f) {
  const cg = f.cg || {};
  const siteUrl = (f.websites || [])[0] || (cg.homepage || [])[0];
  const host = siteUrl ? new URL(siteUrl).host.replace(/^www\./, '') : null;
  const name = f.name, alt = cg.name;
  const queries = [`"${alt || name}" ${f.symbol} crypto`, `"${alt || name}" founders team co-founder`,
    `"${alt || name}" raised funding round investors`, `"${alt || name}" partnership integration`];
  const [[site, siteRepos], ...found] = await Promise.all([siteUrl ? website(siteUrl) : Promise.resolve([null, []]), ...queries.map((q) => search(env, q))]);
  const repos = (cg.repos || []).concat(siteRepos, (f.socials || []).filter((s) => /github/.test(s[0] || '')).map((s) => s[1]));
  const gh = repos.length ? await github(repos[0]) : null;
  const cgMat = cg.id ? { title: `CoinGecko: ${cg.name} (card updated ${cg.updated || '?'})`, url: `https://www.coingecko.com/en/coins/${cg.id}`,
    text: `Categories: ${(cg.categories || []).join(', ')}. Launched: ${cg.genesis || '?'}. Listed on ${cg.cex || 0} exchanges. ${cg.description || ''}`.slice(0, 900) } : null;
  const materials = [site, cgMat, gh].filter(Boolean);
  const seen = new Set(materials.map((m) => m.url));
  let dropped = 0;
  for (const group of found) for (const m of group) {
    if (!m.url || seen.has(m.url) || AUTO_PAGES.some((b) => m.url.includes(b))) continue;
    seen.add(m.url);
    if (!aboutThis(m, f, host, alt)) { dropped++; continue; }
    materials.push(USER_POSTS.some((b) => m.url.includes(b)) ? { ...m, title: 'USER POST, not an official announcement: ' + m.title } : m);
  }
  return { materials: materials.slice(0, 16), dropped, searchDown: !found.some((g) => g.length) };
}

// ------------------------------------------------------------ the model

function prompt(f, mats, lang) {
  const today = new Date().toISOString().slice(0, 10);
  const facts = [`market cap $${Math.round(f.mcap || 0)}, liquidity $${Math.round(f.liq || 0)}, 24h volume $${Math.round(f.vol || 0)}, age ${Math.round(f.ageH || 0)} h`,
    f.buyers === null || f.buyers === undefined ? `buys 24h ${f.dsBuys}, sells ${f.dsSells}` : `buyers 24h ${f.buyers}, sellers ${f.sellers}`]
    .concat((f.stop || []).map((s) => 'stop: ' + s), (f.warn || []).map((s) => 'risk: ' + s), (f.good || []).map((s) => 'plus: ' + s),
      (f.rights || []).map((s) => 'team rights (a note; for a mature project this is not an alarm): ' + s)).join('\n');
  const verdictWords = f.trust ? `${f.trust}/10 (10 = most trustworthy, 1 = almost certainly a trap)` : f.verdict;
  const L = lang === 'ru'
    ? { answer: 'Ответь по-русски простым языком', p: ['Продукт', 'Развитие', 'Кто стоит', 'Партнёрства', 'Итог'], words: '«Не брать», «Ждать» или «Можно смотреть»', nf: 'в собранных материалах не найдено', claim: 'по словам проекта', post: 'пост пользователя, не подтверждено', unk: '(дата неизвестна)', old: '(устарело, <месяц год>)' }
    : { answer: 'Answer in plain English', p: ['Product', 'Development', 'Who is behind it', 'Partnerships', 'Summary'], words: '"Don\'t buy", "Wait" or "Worth a look"', nf: 'not found in the gathered sources', claim: 'according to the project', post: 'user post, unconfirmed', unk: '(date unknown)', old: '(outdated, <month year>)' };
  return `You are an independent crypto project analyst. Today is ${today}.
Below are materials I gathered myself, numbered [1], [2]... Rely ONLY on them and on the on-chain facts. Add nothing from your own memory: it is outdated, and only verifiable information is wanted.

Token: ${f.symbol} (${f.name}), chain ${f.chain}, contract ${f.address}
On-chain facts (measured today, these are true):
${facts}
The on-chain trust score: ${verdictWords}

Materials:
${mats.map((m, i) => `[${i + 1}] ${m.title} — ${m.url}\n${m.text}`).join('\n')}

${L.answer}, EXACTLY five points, each one or two short lines, with source numbers:
1. ${L.p[0]} — is there a working product or is it just a coin/meme. What exactly works.
2. ${L.p[1]} — updates, code, activity over the last month.
3. ${L.p[2]} — team (public or anonymous), investors, sponsors, funds.
4. ${L.p[3]} — collaborations, integrations, listings.
5. ${L.p[4]} — two sentences: the main thing FOR the project and the main thing AGAINST, from the facts above. The reader decides: do NOT write buy, don't buy, wait or recommend, do not repeat the score and do not refer to "the rules". Team rights and large wallets at a mature large project are normal governance, not an argument against. No advice on how much to put in.

Hard rules:
- Every claim with its source number in brackets. If it is not in the materials write exactly "${L.nf}". NEVER turn "not found" into "none": do not write "the team is anonymous", "no investors", "no audit" unless a material says so. Missing information is not a minus and not an argument in the verdict.
- Cite the on-chain facts as [${lang === 'ru' ? 'ончейн' : 'on-chain'}] — they were measured today, never add a date mark to them. Write the whole answer in ${lang === 'ru' ? 'Russian' : 'English'}, including the verdict words.
- Dates: a claim without a date gets "${L.unk}"; older than three months from today gets "${L.old}".
- A material may be about another project with the same ticker. If site, address or description do not match, do not use it.
- Who is speaking: the project's own site is a claim — write "${L.claim}". Posts on Binance Square, X, Reddit, Medium, forums are not official news — write "${L.post}". A listing is confirmed only by the exchange itself or CoinGecko.
- Crunchbase, Tracxn, CB Insights, CryptoRank, RootData, Messari are reference sites, not investors or partners. An investor is only a fund or company named as having put money in.
- No intro, no markdown, no asterisks. At most 1300 characters.`;
}

async function askGemini(env, p) {
  if (!env.GEMINI_API_KEY) return [null, 'no key'];
  if (!geminiModels) {
    const r = await get(`${GEMINI}/models?pageSize=200`, { headers: { 'x-goog-api-key': env.GEMINI_API_KEY } });
    const names = r ? ((await r.json()).models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent')).map((m) => m.name.split('/')[1]) : [];
    const num = (suffix) => names.map((n) => [n, (n.match(new RegExp(`^gemini-(\\d+(?:\\.\\d+)?)-${suffix}$`)) || [])[1]])
      .filter((x) => x[1]).sort((a, b) => parseFloat(b[1]) - parseFloat(a[1])).map((x) => x[0]);
    geminiModels = num('flash').slice(0, 3).concat(num('flash-lite').slice(0, 2));
    if (!geminiModels.length) geminiModels = ['gemini-flash-latest'];
  }
  let last = '';
  for (const model of geminiModels) {
    const r = await fetch(`${GEMINI}/models/${model}:generateContent`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({ contents: [{ parts: [{ text: p }] }], generationConfig: { temperature: 0.1 } }) }).catch(() => null);
    if (!r || !r.ok) { last = `${model}: ${r ? r.status : 'network'}`; continue; }
    const c = ((await r.json()).candidates || [{}])[0];
    const text = ((c.content || {}).parts || []).map((x) => x.text || '').join('').trim();
    if (text) return [text, model];
  }
  return [null, last];
}

async function askGroq(env, p) {
  if (!env.GROQ_API_KEY) return [null, 'no key'];
  let last = '';
  for (const model of GROQ_MODELS) {
    const body = { model, max_tokens: 2000, temperature: 0.1, messages: [{ role: 'user', content: p }] };
    if (model.includes('gpt-oss')) body.reasoning_effort = 'medium';
    const r = await fetch(`${GROQ}/chat/completions`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.GROQ_API_KEY}` }, body: JSON.stringify(body) }).catch(() => null);
    if (!r || !r.ok) { last = `${model}: ${r ? r.status : 'network'}`; if (r && (r.status === 401 || r.status === 429)) break; continue; }
    const text = (((await r.json()).choices || [{}])[0].message || {}).content || '';
    if (text.trim()) return [text.trim(), model];
  }
  return [null, last];
}

async function projectRead(env, f, lang) {
  const { materials, dropped, searchDown } = await gather(env, f);
  if (!materials.length) return { text: lang === 'ru' ? 'Про проект в открытых источниках ничего не нашлось — ни сайта, ни упоминаний.' : 'Nothing about the project in open sources — no site, no mentions.', sources: [] };
  const p = prompt(f, materials, lang);
  let [text, model] = await askGemini(env, p);
  if (!text) [text, model] = await askGroq(env, p);
  if (!text) return { error: 'models busy' };
  text = text.replace(/\*\*/g, '').replace(/\*/g, '');
  const cited = [...new Set((text.match(/\[(\d+)\]/g) || []).map((x) => parseInt(x.slice(1), 10)))].filter((n) => n > 0 && n <= materials.length).sort((a, b) => a - b);
  // The reader sees only "AI"; the model and what failed go to the Worker log.
  console.log(JSON.stringify({ read: f.symbol, model, sources: materials.length, dropped, searchDown }));
  return { text, sources: cited.map((n) => ({ n, url: materials[n - 1].url })), note: lang === 'ru' ? 'Разбор: ИИ' : 'Analysis: AI' };
}
