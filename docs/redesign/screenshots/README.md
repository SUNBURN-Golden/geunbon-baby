# Browser evidence — 2026-10-26

PNG files are actual Chromium viewport screenshots of repository server-page markup and the shared layout, with fonts and images served locally through Playwright routes. The script checks 48 combinations (home, deals, models and explicitly labelled ledger regression fixtures at 320/390/721/1024/1280/1440px, each in light and dark mode) and writes a `metrics.json` into its ignored output directory; that file is not committed. Screenshots here retain the requested 320/390/1440 viewports; full pages and intermediate sizes remain in `.local/redesign-pr5`.

Home/deals use a genuinely empty in-memory deals table with the real migrations and repository model records. They contain no example offers. The `ledger-fixtures` images come exclusively from the existing two-price test fixture and its unknown/zero/unverified/expired variants; they are regression evidence, never production content.

| Page | Mobile light | Mobile dark | Desktop light | Desktop dark |
| --- | --- | --- | --- | --- |
| Home, zero deals | [320](home-320-light.png) · [390](home-390-light.png) | [320](home-320-dark.png) · [390](home-390-dark.png) | [1440](home-1440-light.png) | [1440](home-1440-dark.png) |
| Deals, zero deals | [320](deals-320-light.png) · [390](deals-390-light.png) | [320](deals-320-dark.png) · [390](deals-390-dark.png) | [1440](deals-1440-light.png) | [1440](deals-1440-dark.png) |
| Official-price models | [320](models-320-light.png) · [390](models-390-light.png) | [320](models-320-dark.png) · [390](models-390-dark.png) | [1440](models-1440-light.png) | [1440](models-1440-dark.png) |
| Regression fixtures | [320](ledger-fixtures-320-light.png) · [390](ledger-fixtures-390-light.png) | [320](ledger-fixtures-320-dark.png) · [390](ledger-fixtures-390-dark.png) | [1440](ledger-fixtures-1440-light.png) | [1440](ledger-fixtures-1440-dark.png) |

Reproduce from the repository root:

```sh
REDESIGN_SCREENSHOTS=1 npm test -- tests/redesign-pages.test.ts tests/two-price.test.ts
LEDGER_FIXTURES=1 node_modules/.bin/tsx scripts/redesign-screenshots.ts .local/redesign-pr5
node_modules/.bin/tsx scripts/card-screenshots.ts --out .local/redesign-model-cards
```

Checks include page and price overflow, 44px targets, hero height and counter overlap, self-hosted font availability, single-column mobile models, keyboard focus through all category links, mobile tab scrolling, theme background and the sticky legend. Screenshots use reduced motion. The existing unit suite checks theme contrast and `/models` date/discount exclusions.

This is local SSR/visual verification; it does not exercise Cloudflare bindings, a live production database or client hydration. No server or production deploy was needed.
