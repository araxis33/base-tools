// Browser alerts for Aero Vote Radar (aero.deftools.xyz), 3.11.2026.
//
// Two alerts a visitor can turn on with the radar's "Notify me" button:
//   - 10 min before Aero Autopilot can move again. The time is read from Aero's
//     LeafVoter on Base for Autopilot's two stakes (lastAllocated + 47 h cooldown
//     − reduction), so it follows the contract instead of a guessed schedule.
//   - when the visitor's own 47 h are up. The page sends only that time, never
//     the wallet address.
//
// Pushes go out without a payload (no encryption needed): the radar's service
// worker (docs/sw.js) asks /push/msg for the text that belongs to its endpoint.
// Each subscription lives in KV as an empty value with its record in the
// metadata, so the */10 cron reads them all with list() alone.
//
// Secret: VAPID_PRIVATE_JWK, the private half of VAPID_PUBLIC below (a P-256
// JWK). Without it nothing is sent.

export const VAPID_PUBLIC = 'BM4isbpzhnD995iVSo3vAWwfBPX9DYWBI_KHb6sIWWHTd99oPyBbi_Bg_DjTfP7IguLpC3ltHvk-75FGNd3M2pI';
const SUBJECT = 'https://aero.deftools.xyz';
const RADAR = 'https://aero.deftools.xyz/';

// Aero's LeafVoter (same address on every network) and Autopilot's stakes.
const LEAF_VOTER = '0x382409fad8503fbcdbb27a4211551fa03e884078';
const AUTOPILOT_STAKES = [20365, 20366]; // sAERO Maxi, USDC Maxi (relays found 31.10.2026)
const SEL_TOKEN_STATES = '0xaa9f3eca';
const SEL_COOLDOWN = '0x6f5aa6ab';
const SEL_REDUCTION = '0xbe8cfed2';

const AHEAD = 15 * 60; // alert Autopilot when it is at most this many seconds away
const PUSH_HOSTS = /(^|\.)(fcm\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/;

const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const utf8 = (s) => new TextEncoder().encode(s);

async function keyOf(endpoint) {
  const h = await crypto.subtle.digest('SHA-256', utf8(endpoint));
  return 'push:' + [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 40);
}

// When Autopilot's stakes can move next, in unix seconds (the earlier of the two).
export async function autopilotReadyAt(rpc) {
  const call = (data) => rpc('eth_call', [{ to: LEAF_VOTER, data }, 'latest']);
  const cooldown = BigInt(await call(SEL_COOLDOWN));
  const times = await Promise.all(AUTOPILOT_STAKES.map(async (id) => {
    const [state, reduction] = await Promise.all([call(SEL_TOKEN_STATES + word(id)), call(SEL_REDUCTION + word(id))]);
    const last = BigInt('0x' + state.slice(2 + 64, 2 + 128));
    return Number(last + cooldown - BigInt(reduction));
  }));
  return Math.min(...times);
}

// ---- requests from the radar page and its service worker ------------------
export async function pushRoute(req, env, url, json) {
  if (req.method !== 'POST') return json(req, { error: 'POST only' }, 405);
  let body;
  try { body = await req.json(); } catch { return json(req, { error: 'bad json' }, 400); }
  const endpoint = String((body.sub && body.sub.endpoint) || body.endpoint || '');
  let host = '';
  try { const u = new URL(endpoint); if (u.protocol === 'https:') host = u.hostname; } catch { /* checked below */ }
  if (!PUSH_HOSTS.test(host) || endpoint.length > 600) return json(req, { error: 'not a push endpoint' }, 400);
  const key = await keyOf(endpoint);

  if (url.pathname === '/push/sub') {
    // No "ready" means the page did not look the wallet up this time: keep the time sent before.
    const old = (await env.QUOTA.getWithMetadata(key)).metadata || {};
    const ready = 'ready' in body ? Number(body.ready) || 0 : old.r || 0;
    const rec = { e: endpoint, ap: !!body.autopilot, r: ready > Date.now() / 1000 ? Math.round(ready) : 0 };
    if (!rec.ap && !rec.r && !body.wallet) { await env.QUOTA.delete(key); return json(req, { ok: true, off: true }); }
    // Keep a message that is waiting for the service worker to pick it up.
    if (old.m) rec.m = old.m;
    await env.QUOTA.put(key, '', { metadata: rec, expirationTtl: 120 * 86400 });
    return json(req, { ok: true });
  }
  if (url.pathname === '/push/unsub') {
    await env.QUOTA.delete(key);
    return json(req, { ok: true });
  }
  if (url.pathname === '/push/msg') {
    const { metadata } = await env.QUOTA.getWithMetadata(key);
    return json(req, (metadata && metadata.m) || { title: 'Aero Vote Radar', body: 'Open the radar to see your timers.' });
  }
  return json(req, { error: 'not found' }, 404);
}

// ---- sending -------------------------------------------------------------
async function vapidAuth(env, endpoint, cache) {
  const aud = new URL(endpoint).origin;
  if (cache[aud]) return cache[aud];
  if (!cache.key) cache.key = await crypto.subtle.importKey('jwk', JSON.parse(env.VAPID_PRIVATE_JWK), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = b64u(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(utf8(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUBJECT })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, cache.key, utf8(head + '.' + claims));
  return (cache[aud] = `vapid t=${head}.${claims}.${b64u(sig)}, k=${VAPID_PUBLIC}`);
}

async function send(env, endpoint, cache) {
  const r = await fetch(endpoint, { method: 'POST', headers: { TTL: '1800', Urgency: 'high', Authorization: await vapidAuth(env, endpoint, cache), 'Content-Length': '0' } });
  return r.status;
}

const until = (s) => (s <= 60 ? 'now' : 'in ' + Math.round(s / 60) + ' min');
const hhmm = (t) => new Date(t * 1000).toISOString().slice(11, 16) + ' UTC';

// Called from the */10 cron.
export async function runPushes(env, rpc) {
  if (!env.VAPID_PRIVATE_JWK) return { skipped: 'no VAPID_PRIVATE_JWK' };
  const now = Math.floor(Date.now() / 1000);
  let ap = 0, apMsg = null, apMark = null;
  try {
    ap = await autopilotReadyAt(rpc);
    // A 25-minute band so one of the 10-minute runs always lands in it.
    if (ap - now <= AHEAD && ap - now > -10 * 60) {
      apMark = 'push-ap:' + ap;
      if (await env.QUOTA.get(apMark)) apMark = null;
      else apMsg = { title: 'Aero Autopilot moves ' + until(ap - now), body: 'Its 47 h end at ' + hhmm(ap) + '. See where the radar would put sAERO now.', url: RADAR };
    }
  } catch (e) { console.log('push: autopilot read failed', e.message); }

  const out = { autopilot: ap, sent: 0, gone: 0, failed: 0 };
  const cache = {};
  let cursor;
  do {
    const page = await env.QUOTA.list({ prefix: 'push:', cursor });
    cursor = page.list_complete ? undefined : page.cursor;
    for (const k of page.keys) {
      const rec = k.metadata;
      if (!rec || !rec.e) continue;
      let msg = null;
      if (rec.r && rec.r <= now + 5 * 60) {
        msg = { title: 'Your 47 h on Aero are up', body: 'Your sAERO can move again. The radar shows where it earns most right now.', url: RADAR };
        rec.r = 0;
      } else if (apMsg && rec.ap) msg = apMsg;
      if (!msg) continue;
      rec.m = msg;
      try {
        await env.QUOTA.put(k.name, '', { metadata: rec, expirationTtl: 120 * 86400 });
        const status = await send(env, rec.e, cache);
        if (status === 404 || status === 410) { await env.QUOTA.delete(k.name); out.gone++; }
        else if (status >= 200 && status < 300) out.sent++;
        else { out.failed++; console.log('push: status', status, new URL(rec.e).host); }
      } catch (e) { out.failed++; console.log('push: send failed', e.message); }
    }
  } while (cursor);
  if (apMark) await env.QUOTA.put(apMark, '1', { expirationTtl: 3 * 86400 });
  return out;
}
