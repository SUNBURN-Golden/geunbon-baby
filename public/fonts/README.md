# Self-hosted fonts

Gowun Batang Bold and Spoqa Han Sans Neo Regular/Bold use SIL OFL 1.1; see the two adjacent licence files. WOFF2 subsets were regenerated with fontTools 4.65 from the prepared original font sources (`gb.ttf`, `sp-Regular.ttf`, `sp-Bold.ttf`). They include KS X 1001 characters, printable ASCII, and the characters in `app`, `lib`, `seed` and `shared`, including the approved headline. This expands the mockup-only subsets to cover the production page text. Unsupported future input uses the CSS fallback.

Regeneration: `python3 scripts/subset-fonts.py <prepared-source-directory>` (fontTools with Brotli required). Font sources are build inputs, not runtime network requests.
