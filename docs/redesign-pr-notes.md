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
