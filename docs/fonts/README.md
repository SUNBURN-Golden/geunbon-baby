# Display typography

Titles, logos and selected brand accents use Regular/400 Excalifont, then Regular/400 Gaegu for Hangul, measured local sans fallback aliases, then the unchanged `--font-sans` stack. The delivered webfonts are exposed under the namespaced CSS families `Agamajung Excalifont` and `Agamajung Gaegu`, and those names come first in the stack. Namespacing matters on machines that already have Excalifont or Gaegu installed: without it a failed vendored request could silently match the local display font. With it, the fallback is always the controlled aliases or the existing sans stack, which removes the fallback layout shift and guarantees that successfully rendered glyphs come from the delivered files. `font-synthesis: none` avoids artificial bold/italic. Every face, including local aliases, uses `font-display: swap`; neither display family has a `local()` source. There are no runtime font services or CDN requests.

`app/fonts.css` is generated; `app/layout.tsx` imports it and preloads only the Excalifont basic Latin subset (24,956 bytes) and Gaegu logo subset (2,580 bytes), with anonymous CORS. Other subsets are requested by Unicode coverage. Static assets and both licenses use the existing `public/` → `.open-next/assets` pipeline. No Worker configuration or Linux crawler dependency changed.

## Scope and layout

The display selectors in `app/globals.css` target public page titles/eyebrows, home section headings/editorial accents, product/deal card headings, the wordmarks, newsletter heading, illustration captions and the dedicated footer `.brand-slogan`. Navigation, controls, body copy, advertising, counts, dates, prices, comparison labels, tables, consent and verification/legal notices keep sans. Admin headings retain their original styles. The direct-child comparison overrides avoid changing shared deal-card titles nested inside a price section. Product cards still have exactly their original four items, and `.model-deal`/`.model-deal-price` rules are unchanged.

H1 sizes use `clamp()`, with 1.2 line height, balanced wrapping, `keep-all`, and emergency wrapping for long unbroken names. Handwriting is at least 18px. Product titles have no clipping or line clamp. The hero and manifesto have no forced `<br>`; their wording and emphasis are preserved. Header/title regions reserve space. Artwork captions occupy their own rows. The count has its own stable grid column. The English wordmark and artwork captions anchor to the left so changing glyph advances cannot move centered text. The product eyebrow is a single text interpolation with identical visible content, avoiding movement of separate adjacent React text nodes during the swap.

## Pinned sources and licenses

All original URLs, full commit SHAs, individual byte sizes, SHA-256 hashes, CSS mappings and Gaegu code points are recorded in [manifest.json](manifest.json).

- Excalidraw revision `7ded689cad49331167e29fd88b38f38d3736d576`: [Excalifont source](https://github.com/excalidraw/excalidraw/blob/7ded689cad49331167e29fd88b38f38d3736d576/packages/excalidraw/fonts/Excalifont/index.ts). All seven WOFF2 binaries and their Unicode mappings are unchanged, including accented Latin and combining marks.
- Google Fonts revision `bbda7253fc363238b05d97515ca71f8ae49c4fa9`: [Gaegu Regular](https://github.com/google/fonts/blob/bbda7253fc363238b05d97515ca71f8ae49c4fa9/ofl/gaegu/Gaegu-Regular.ttf), [complete OFL](https://github.com/google/fonts/blob/bbda7253fc363238b05d97515ca71f8ae49c4fa9/ofl/gaegu/OFL.txt).

The Excalifont directory does not supply a standalone `OFL.txt` at this revision. Its complete license and copyright metadata are embedded in `index.ts`. [Excalifont.upstream.ts.txt](Excalifont.upstream.ts.txt) preserves that pinned source. The delivered `public/fonts/excalifont/OFL.txt` is the exact text from immediately after `Origin File Name Table:` through the final OFL disclaimer, before `licenseURL:`; only CRLF → LF normalization is allowed. This retains the copyright, designer metadata, license introduction, all five conditions, termination and disclaimer. The offline suite compares extraction byte-for-byte. Gaegu's complete OFL is delivered unchanged in `public/fonts/gaegu/OFL.txt`.

Gaegu contains 2,350 supported modern Hangul syllables and 51 supported compatibility jamo within the requested blocks. All 2,401 are preserved, including characters absent from current copy. The four logo syllables are isolated; the remainder is sorted numerically into groups of up to 256, excluding those four. All Gaegu CSS ranges are exact and disjoint, limited to `U+AC00-D7A3` and `U+3131-318E`. The source lacks 8,865 code points in these blocks; `gaeguSourceGaps` records them explicitly. Unsupported characters use the sans fallback; CSS does not falsely advertise them as Gaegu. All Hangul in seeded product titles is supported, as are the tested `ㄱ`/`ㅎ` jamo.

There are 18 downloadable faces totaling **470,720 bytes**: seven unchanged Excalifont subsets and eleven generated Gaegu subsets. Individual sizes are in the manifest; page-specific request bytes are in the verification summary. Only 27,536 bytes are preloaded.

## Reproduction

Font generation is a separate local tool, with no runtime or crawler dependencies:

```sh
python3 -m venv .local/font-venv
.local/font-venv/bin/pip install fonttools==4.65.0 brotli==1.2.0
.local/font-venv/bin/python scripts/vendor-display-fonts.py
```

The script fetches exclusively from pinned revisions into `.local/font-sources`, verifies cached source hashes against the manifest, generates real WOFF2 files with deterministic ordering/timestamps, and compares each output cmap against its requested source-supported code points. It records source/font/license SHA-256 checksums and tools. Original TTF files are not served or bundled. Re-running with the same sources/tools reproduces the output binaries.

[Fallback measurements](fallback-metrics.json) record Chromium measurements made **before** assigning aliases. To remeasure on a machine with these exact installed fonts:

```sh
npx tsx scripts/measure-display-fallbacks.ts
.local/font-venv/bin/python scripts/vendor-display-fonts.py
```

The measurement tool explicitly loads the full local names `Noto Sans Regular` and `Noto Sans CJK KR`, measures widths, fits the Latin scale over the seeded/editorial corpus, and measures punctuation separately. Alias ascent/descent values match the display fonts' source metrics after scaling. These local aliases are sans fonts; they never bypass the vendored display fonts. Their purpose is stable fallback geometry in the recorded Linux environment. On systems without those local fonts, the unchanged final sans stack remains available; matching every OS fallback is not claimed.

## Verification

The daemon's checks are exactly:

```sh
npm run lint
npm run typecheck
npm test
npm run build
```

The additional Worker integration and browser checks use local Wrangler/Miniflare only:

```sh
npm run db:migrate
npm run db:seed
npm run build:worker
npx wrangler dev --local --port 8787
# In another terminal, BEFORE changing typography:
npx tsx scripts/typography-check.ts --baseline
# After implementation and a fresh Worker build:
npx tsx scripts/typography-check.ts --verify
npx tsx scripts/card-screenshots.ts --out .local/card-qa
```

`--quick` narrows debugging to delayed loading at 390px/light. It is not the acceptance run. Browser execution is outside Vitest, whose setup prohibits sockets/browsers. The offline typography suite checks hashes, full licenses, source extraction, CSS coverage/ranges, seeded glyph coverage, swap/preload declarations and scope invariants.

The browser harness captures actual SSR HTML and CSS from local Wrangler, removes scripts for deterministic comparison, and serves isolated snapshots using only local font/image assets. Populated home/deal fixtures reuse the values and real components exercised by `tests/deals.test.ts`; no fixture writes to D1, seed files or site data. It also checks every delivered font/license over local Wrangler against its manifest checksum. The baseline was captured before modifying typography, in this same worktree. Seeded pages contain no active deals; their content is independent of wall-clock time. Populated fixtures use the fixed clock `2026-10-21T03:00:00Z`.

For each of seven pages × three widths (320, 390, 1440) × two themes × four modes (cold, warm, 900ms delayed, blocked), the harness records three repetitions, their CLS session-window scores and shift nodes, H1 line counts/bounds, first fallback bounds, loaded faces, retained sans samples, contrast and request bytes. A buffered layout-shift observer is installed before navigation; observations extend through font readiness/image decoding plus 400ms. The fallback capture is at 150ms. Warm navigation reuses a context/cache without interception. Cold/delayed/blocked repetitions clear the cache. Light/dark screenshots cover every page/width, with additional delayed-fallback screenshots. CDP `CSS.getPlatformFontsForNode` inspects actual glyph use, including Latin/digits, `BabyBjörn`, accented/combining Latin, Hangul and compatibility jamo. Additional isolated consent/legal/table probes retain sans.

The recorded H1 corpus is `/`, `/models/model-1`, `/deals`, `/models`, the longest seeded product (`/models/model-21`, `넥스트 시스템(토들넥스트+피파넥스트+베이스)`), a populated home carousel, and the existing `A carefully checked deal` detail fixture. Acceptance limits are three lines at 390px and two at 1440px. Arbitrarily long future titles may grow naturally; there is no truncation or reduction below 18px.

Full per-repeat results, affected nodes, geometry and screenshots remain under ignored `.local/typography/{baseline,verification}.json` and `.local/typography/*.png`. The portable [verification summary](verification-summary.json) retains every repetition's CLS score and its corresponding baseline, worst scores, request bytes and the tested environment. Font-shape checks use actual loaded glyphs; computed family alone is insufficient.
