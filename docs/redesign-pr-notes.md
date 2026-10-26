# Local redesign PR notes

All branches remain local and stacked on `801ac47` (`origin/main`). No push, merge or deployment is part of this work.

## PR1 — tokens and fonts

Replace the previous palette and font stack with ledger tokens and licensed self-hosted Gowun Batang / Spoqa Han Sans Neo. The owner-approved supersession is recorded in `design-decisions.md` and the dev-daemon guide. The contrast test now resolves aliases and verifies each actual theme and stamp-fill contrast.

- [x] `npm run build`, `npm test` (80 files / 1567 tests), `npm run typecheck`, `npm run lint`.
- [x] `REDESIGN_SCREENSHOTS=1 npm test -- tests/redesign-pages.test.ts`.
- [x] `node_modules/.bin/tsx scripts/redesign-screenshots.ts .local/redesign-pr1`: home, deals and models at 320/390/1440, light/dark. No overflow or targets below 44px. Mobile light and desktop dark visually inspected. Art/hero structure is intentionally handled by PR2.
- [x] Zero deal database; repository model records only; no production/sample data changes.

Screenshot files and command logs are under ignored `.local/` and remain available in this worktree. The renderer executes the actual server page components against in-memory migrations and repository model records, wraps the actual layout, and supplies local assets via browser routes. It does not test a deployed Cloudflare runtime or client hydration. No server is started.
