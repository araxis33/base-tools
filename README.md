# base-tools

The onchain toolstack for **Base** builders and degens.

A directory of Base ecosystem tools — wallets, AI agents, trading bots, terminals, trackers, bridges, DEXs and lending — plus live token boards built from CoinGecko's API, linking out to GeckoTerminal and Basescan.

## Live site

https://deftools.xyz/

## What's inside

22 tools across 8 categories:

- **Wallets & Apps** — Base App, Rabby, Rainbow
- **AI Agents** — Virtuals Protocol, Bankr, Clanker
- **Trading Bots** — Banana Gun, GMGN.ai, Maestro
- **Terminals** — DexScreener, DEXTools, GeckoTerminal, Basescan
- **Tracking & Alerts** — Cielo Finance, RayBot
- **Bridges** — Relay, Superbridge, Brid.gg
- **DEX & Swap** — Aerodrome Finance, Uniswap, Matcha
- **Lending** — Morpho

Plus three live boards built from CoinGecko's `base-ecosystem` category, filtered down to tokens whose only chain is Base: top by 24h volume, best 24h gainers, and a hand-picked blue-chip list. Every row carries the contract address, linked to Basescan and copyable. Refreshed client-side and cached locally for five minutes, with the stamp saying how old a cached board actually is; a board that cannot load says so and offers a retry rather than going blank, and one failing request no longer takes the other boards down with it.

`scout.html` is a second page: live stats from an automated scanner watching every new pool on Base and Robinhood Chain, read from `scout-stats.json`.

## Stack

Two static pages, no build step, no backend. Client-side fetch only.

## Notes

Links are direct — no affiliate/cashback programs. Not financial advice; always verify contract addresses before trading.
# base-tools
Directory of Base ecosystem tools plus a live trending tokens board.
