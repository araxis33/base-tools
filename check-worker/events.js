// How many people press what (06.11.2026). Cloudflare's analytics see visits only, so nobody
// could say whether anyone opens a stock or buys through us. One counter per action per day:
// no cookies, no addresses, no IP. Read with: npx wrangler kv key get --binding QUOTA ev:2026-11-06
const EVENTS = new Set([
  'stock_open', 'stock_amount', 'stock_buy',
  'thesis_buy', 'thesis_buyall', 'thesis_share', 'thesis_tx',
  'night_trade', 'night_tx', 'night_game',
  'radar_notify', 'radar_stakes',
]);
const KEEP_SECONDS = 400 * 86400;

export async function countEvent(req, env, origins, now = Date.now()) {
  if (!origins.includes(req.headers.get('origin') || '')) return new Response(null, { status: 403 });
  const name = (await req.text()).trim().slice(0, 32);
  if (!EVENTS.has(name)) return new Response(null, { status: 400 });
  const key = 'ev:' + new Date(now).toISOString().slice(0, 10);
  let day = {};
  try { day = JSON.parse((await env.QUOTA.get(key)) || '{}'); } catch (e) { /* start the day over */ }
  day[name] = (day[name] || 0) + 1;
  await env.QUOTA.put(key, JSON.stringify(day), { expirationTtl: KEEP_SECONDS });
  return new Response(null, { status: 204 });
}
