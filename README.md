# base-tools

The onchain toolstack for **Base** builders and degens.

A directory of Base ecosystem tools — wallets, AI agents, trading bots, terminals, trackers, bridges, DEXs and lending — plus live token boards and a swap you can run without leaving the page.

## Live site

https://deftools.xyz/

## What's inside

24 tools across 9 categories:

- **Wallets & Apps** — Coinbase Wallet, Rabby, Rainbow, Glider
- **AI Agents** — Virtuals Protocol, Bankr
- **Launchpads** — The Stonks Exchange, Feel.cash
- **Trading Bots** — Banana Gun, Fomo, GMGN.ai, Maestro
- **Terminals** — DexScreener, DEXTools, GeckoTerminal, Basescan
- **Tracking & Alerts** — Cielo Finance, RayBot, Blocktronics
- **Bridges** — Relay
- **DEX & Swap** — Aerodrome Finance, Uniswap, Matcha
- **Lending** — Morpho

Four live boards: biggest 24h losers (with a volume floor, so the list is real sell-offs rather than untraded dust), best 24h gainers, a hand-picked blue-chip list, and the ten tokenized equities on Base. The first three are built from CoinGecko's `base-ecosystem` category, filtered down to tokens whose only chain is Base; the equities are priced straight from their pools, because CoinGecko does not carry them.

Boards are cached locally for five minutes, and the stamp says how old a cached board actually is. A board that cannot load says so and offers a retry rather than going blank, and one failing request no longer takes the others down with it.

Every row has a **Buy** button. The trade runs through the KyberSwap aggregator and is signed in your own wallet: buying with native ETH is one transaction and no approval, selling grants an allowance for exactly the amount being sold rather than the unlimited one most interfaces ask for. Nothing is custodied and no key leaves the browser.

Two more pages:

- `thesis.html` — write a sentence, get a basket of tokenized stocks weighted by how much each company answers it, priced across every pool on Base.
- `scout.html` — live stats from an automated scanner watching every new pool on Base and Robinhood Chain, read from `scout-stats.json`.

## Stack

Three static pages, no build step, no backend. Client-side fetch only.

## Notes

Links are direct — no affiliate/cashback programs. Not financial advice; always verify contract addresses before trading.
