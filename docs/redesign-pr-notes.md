# Local redesign PR notes

All branches remain local and stacked on `801ac47` (`origin/main`). No push, merge or deployment is part of this work.

## PR1 — tokens and fonts

Replace the previous palette and font stack with ledger tokens and licensed self-hosted Gowun Batang / Spoqa Han Sans Neo. The owner-approved supersession is recorded in `design-decisions.md` and the dev-daemon guide. The contrast test now resolves aliases and verifies each actual theme and stamp-fill contrast, including ink/text on the page background and the active tab's inverted label. (A stamp-text-on-paper pair is not tested: that combination is not used, and the dark accent would not pass on the always-light paper.)

- [x] `npm run build`, `npm test` (80 files / 1567 tests), `npm run typecheck`, `npm run lint`.
- [x] `REDESIGN_SCREENSHOTS=1 npm test -- tests/redesign-pages.test.ts`.
- [x] `node_modules/.bin/tsx scripts/redesign-screenshots.ts .local/redesign-pr1`: home, deals and models at 320/390/1440, light/dark. No overflow or targets below 44px. Mobile light and desktop dark visually inspected. Art/hero structure is intentionally handled by PR2.
- [x] Zero deal database; repository model records only; no production/sample data changes.

Screenshot files and command logs are under ignored `.local/` and remain available in this worktree. The renderer executes the actual server page components against in-memory migrations and repository model records, wraps the actual layout, and supplies local assets via browser routes. It does not test a deployed Cloudflare runtime or client hydration. No server is started.

## PR2 — compact hero and real counter

Move the hero before the active ledger, apply the exact owner-approved headline, and count active published deals at the same request instant as the cards. Replace the hero artwork with the double-rule stamp. Preserve its Korean caption in the supplemental introduction; retain all other Korean sections pending Argon. The real zero state reuses the current empty message and official-price CTA.

- [x] `npm run build`, `npm test` (80 files / 1567 tests), `npm run typecheck`, `npm run lint`.
- [x] Screenshot render command from PR1, followed by `node_modules/.bin/tsx scripts/redesign-screenshots.ts .local/redesign-pr2`.
- [x] All 18 mobile/desktop light/dark checks passed; zero horizontal overflow and no targets below 44px. Hero measured 187.5px at 320/390 and 175px at 1440. Mobile dark and desktop light visually inspected.
- [x] Hero/order/count and empty-state tests updated in this PR; no cards or prices in the zero state.
- [x] Review fixes: the hero tally is `aria-hidden` because the list heading announces the same count; the intermediate-width `clamp()` heading size lives here with the hero; README headline updated to the approved text.
- [ ] Mockup Korean wording and removal of supplemental copy: pending Argon; detailed file/line proposals are in `/workspace/rd-wt/logs/agamajung-copy-todo.md`.

## PR3 — index category tabs

Add native category links on home, deals and models, preserving every category (including car seats) and model search/brand parameters. Active categories use `aria-current="page"`; unsupported home/deal categories safely fall back to all. Home/deals filter joined model categories and keep the hero's global active count.

- [x] `npm run build`, `npm run typecheck`, `npm run lint`.
- [x] `npm test -- --maxWorkers=2`: 81 files / 1569 tests passed. An unrestricted run encountered unrelated existing timing failures under host contention; reducing workers passed without code changes to those systems.
- [x] Screenshot render command and `node_modules/.bin/tsx scripts/redesign-screenshots.ts .local/redesign-pr3`: 18 checks passed, 320/390/1440 light/dark, no overflow or undersized targets. Home 320 light and deals desktop dark visually inspected.
- [x] Link semantics, preserved query parameters and category filtering covered by tests. Tabs scroll within their own nav on mobile.
- [ ] “전체” is pending Argon; retain existing “모든 종류”.

### Review 2 fix — selected category focus

Use `var(--bg)` for the selected category's inset focus outline against its ink fill. The theme regression check verifies the actual CSS token at 3:1 or greater in both themes.

- [x] `npm run build:worker` (includes the production Next build), `npm test -- --maxWorkers=1` (81 files / 1569 tests), `npm run typecheck`, `npm run lint`.
- [x] Real local Wrangler app and isolated local D1: Playwright captured home, deals and models at 390px and 1440px, light and dark, including native keyboard focus on the selected tab. All 24 page/focus checks passed; zero page overflow, loaded fonts, 44px targets, focus contrast above 3:1.
- [x] Screenshots and metrics: `/workspace/rd-wt/logs/agamajung-shots/fix2-pr3/`. Mobile light and desktop dark focus screenshots visually inspected. Server stopped; no production access or data changes.
## PR4 — ledger cards and two-price tables

Use repository line art on paper stamp frames, a ruled official-left/group-buy-right price table, a sticky legend, and a calculated decorative discount stamp. Screen-reader labels and every existing status, comparison, source and disclosure string remain. Shared cards remain identical across home/deals/calendar/model detail. Deal detail keeps the original source image; unillustrated cards retain the safe-image fallback. No `/models` date or discount-badge restrictions were lifted.

- [x] `npm run build`, `npm run typecheck`, `npm run lint`.
- [x] `npm test -- --maxWorkers=1`: 81 files / 1570 tests passed. Single worker avoids the existing session-capture polling test's host-contention flake.
- [x] `REDESIGN_SCREENSHOTS=1 npm test -- tests/redesign-pages.test.ts tests/two-price.test.ts`.
- [x] `LEDGER_FIXTURES=1 node_modules/.bin/tsx scripts/redesign-screenshots.ts .local/redesign-pr4`: 24 screenshots/checks, 320/390/1440 light/dark, no page overflow or small targets. Fixture mobile light and desktop dark visually inspected.
- [x] The extra six screenshots explicitly show existing test fixtures (unknown, zero, unverified, higher and expired prices); these are never loaded into production data or routes. The real home/deals screenshots still show zero deals.
- [x] Updated hero/card, image-lifecycle and two-price expectations with the implementation; retained `/models` forbidden-date/discount tests.

Review fixes: `DealCard`/`DealList`/`LedgerPrices` take `showBadge` (default true) and `/models/[id]` passes `false`, so no `/models/*` route renders the stamp (tests in `two-price.test.ts` and `home-deals.test.ts`). The stamp is also hidden for a 0원 price. It is a whole-percent decoration (`Math.round`, hidden below 1%) while the retained sentence keeps one decimal (`formatGap`), so a 0.4% gap shows the sentence without a stamp. `tests/deals.test.ts` narrowed `not.toContain('/models/')` to `'href="/models/'` because cards now include `/img/models/…` art sources. A real-browser pass (wrangler dev against local D1) found the model-detail deal card collapsing to a ~85px strip at 1200px+ because the four-column `.deal-list` rule applied inside the half-width price column; `.comparison .deal-list` is now always one column. Owner to confirm: cards use repository art whenever it exists and ignore the deal's own `image_url` (deal detail still shows the source image).

Responsive accommodation: 1 column through 720px, 2 through 1199px, 4 at 1200px and above. Four thumbnail-plus-two-price columns at 721px cannot hold the real prices at the approved readable size; the intermediate layout preserves price legibility and AA targets. Retaining the current Korean metadata/disclosures also makes live cards taller than the mockup. The mockup's first-viewport card counts cannot be reproduced while retaining that copy and the existing navigation; copy removal remains pending Argon.
