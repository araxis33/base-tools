# deftools

Tools for **Base**: check a token before you buy it, check a tokenized US stock, build a basket of stocks from one sentence, and trade from your own wallet. Plus a directory of Base apps and four live token boards.

Live site: **https://deftools.xyz/**

## Tools on the site

| Tool | Page | What it does | Code |
|---|---|---|---|
| **Token Check** | [deftools.xyz/check](https://deftools.xyz/check.html) | Paste a Base or Robinhood Chain token address and get a trust score from 1 to 10 for the token and for the project behind it. The token: a sell simulation, who launched it and what became of their earlier coins, holders who got coins straight from the deployer, what a $500 exit really returns. The project: audit, team, investors, docs, GitHub, socials, a working product, each with its source. 3 free checks a day, then 0.1 USDC each. | [`check.html`](check.html), [`check.js`](check.js), server: [`check-worker/`](check-worker) |
| **Stock Check** | [deftools.xyz/stocks](https://deftools.xyz/stocks.html) | Any of the 36 Coinbase tokenized US stocks on Base: is it the official token, its price against the real share, pool depth, what a round trip costs, where you can borrow against it. | [`stocks.html`](stocks.html) |
| **Thesis** | [deftools.xyz/thesis](https://deftools.xyz/thesis.html) | Write one sentence about what you believe and get a basket of tokenized stocks, priced across every pool and routed through the deepest. Stock memes filtered by real money, what you hold, and selling it. | [`thesis.html`](thesis.html), [`thesis-core.js`](thesis-core.js), [`thesis-memes.js`](thesis-memes.js) |
| **Arc fees** | [deftools.xyz/arc](https://deftools.xyz/arc.html) | Arc prices gas in USDC, so fees are shown in dollars and cents. Live numbers, a pool check, and the 18-vs-6 decimals trap that breaks ported balance checks. | [`arc.html`](arc.html), [`arc-pool.js`](arc-pool.js) |
| **Live token boards** | [deftools.xyz](https://deftools.xyz/#trending) | Biggest 24h losers and gainers among Base-native tokens, hand-picked blue chips, and the ten most traded stocks. Every row has a Buy button. | [`index.html`](index.html), server: [`check-worker/boards.js`](check-worker/boards.js) |
| **Scout stats** | [deftools.xyz/scout](https://deftools.xyz/scout.html) | Public statistics of the Meme-Scout scanner, which watched every new pool on Base and Robinhood Chain. | [`scout.html`](scout.html) |

Separate repositories, linked from the site:

- [aero-vote-radar](https://github.com/araxis33/aero-vote-radar) — which Aerodrome pools to vote for with veAERO ([aero.deftools.xyz](https://aero.deftools.xyz))
- [arc-contract-check](https://github.com/araxis33/arc-contract-check) — who can change a contract on Arc
- [meme-scout](https://github.com/araxis33/meme-scout) — the Telegram bot whose token checks Token Check is built on

## Trading

Buy and sell run through the KyberSwap aggregator and are signed in your own wallet. Buying with native ETH is one transaction with no approval; selling approves exactly the amount being sold, not an unlimited allowance. Nothing is custodied and no key leaves the browser.

## Directory

24 apps across 6 categories: wallets and apps, stocks and launchpads, trading bots, terminals, tracking and alerts, DeFi (swap, bridge, lend). A star marks what I use myself.

## How it is built

- Static pages on GitHub Pages, no build step.
- A Cloudflare Worker ([`check-worker/`](check-worker)) keeps the AI keys for the project read, counts free checks, and rebuilds the homepage boards every 15 minutes, so a visit makes one request instead of asking CoinGecko and DexScreener itself.
- GitHub Actions ([`.github/workflows/`](.github/workflows)) run the slower jobs on a schedule: the list of Base-native coins, stock memes, Arc pools, and a daily check of the stock list against base.org.
- Tests: `node --test "test/*.test.js"`.

## Notes

Links are direct, no affiliate or cashback programs. Not financial advice; always verify contract addresses before trading.

Built by [@Def7771](https://x.com/Def7771).
