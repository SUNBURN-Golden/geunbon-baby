# Agamajung design decisions

## Accepted — 2026-10-26: ledger and index binder

Owner approval: implement the five small stacked PRs from agamajung-v2, and update prior design constraints in the same PRs. This decision applies to this site's background, accent and heading/body fonts.

- Light background `#FAF7F0`, ink `#1D3557`, text `#22262B`, muted `#5B5F66`.
- Dark background `#161B22`, ink `#A9BEDC`, text `#E6E1D6`, muted `#9AA4B2`.
- Stamp fill `#D93829` with white text; text accent `#B42318` light / `#FF6B5B` dark. Never use the fill as text.
- Heading and brand: self-hosted Gowun Batang Bold. Body and tabular prices: self-hosted Spoqa Han Sans Neo Regular/Bold. OFL licences ship in `public/fonts`.
- No shadows, blur, gradients, purple, emoji or 3D decorations. Only the desktop counter may rotate.
- Keep dark mode, reduced motion, Korean `word-break: keep-all`, WCAG AA contrast and 44px targets.
- Use live published deal data and the existing timing rules. Empty means zero; never seed example deals to fill the layout.
- Korean strings stay unchanged pending Argon, except the owner-approved headline: `너는 건강하게만 오렴, 좋은 것을 골라둘게.`
- `/models` cards continue to forbid dates and discount badges. Crawler code stays separate and untouched.

## Superseded — pre-2026-10-26 palette and typography

The previous implementation used ivory `#f8f6f0`, sage and brown `#8b6344`, system sans and system serif fonts; earlier design instructions described ivory/terracotta, no new colours, light-only and home colour-only changes. Those palette, font and scope constraints are superseded by the owner-approved per-site decision above. They remain recorded here as history, not active rules.

No `AGENTS.md`, design lock, `DESIGN.md`, `DECISIONS` or `docs/longblack-structure-spec.md` exists in this worktree at base `801ac47`. This record captures the supersession without inventing or deleting historical files.
