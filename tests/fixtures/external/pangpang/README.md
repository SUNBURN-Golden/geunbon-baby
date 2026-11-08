These are sanitized copies of the real public Pangpang pages approved by 준태님 on 2026-11-02 at 22:15 KST. Originals were supplied at `/workspace/agamajung/fixtures/pangpang/`, saved with a normal browser user agent. Tests make no live requests.

| File | Source |
| --- | --- |
| list.html | https://09pangpang.com/ |
| deal1.html | https://09pangpang.com/post/849822 |
| deal2.html | https://09pangpang.com/post/849751 |
| deal3.html | https://09pangpang.com/post/849770 |

Scripts, styles, SVG, private/hidden regions, embeds, images/media, metadata, and unused attributes were removed using the collector DOM scanner. Public product/seller text, category buttons, schedule text, relevant classes, hrefs, data-feed-index and accessible duplicate anchors remain. The saved listing retains 191 anchors, 60 post links and 30 visible product cards. It does not reproduce the reported 768-link production page. The separately labeled synthetic 768-anchor test checks enumeration and processing limits.

Reference time: 2026-11-02T22:15:00+09:00. No fixture publishes a price. Missing prices and opening-only end dates remain null.

The bounded alias/evidence classifier accepts four listing products via the existing baby-keyword path, excludes one by its diaper/formula rule, and rejects 25 for insufficient baby/model evidence. Direct inspection of the saved listing identifies them as:

| Product | Title | Classification |
| --- | --- | --- |
| `/post/849822` | 바밤단호박 | Keyword eligible; no model identity |
| `/post/849770` | 사파 3in1 열제본 코팅기 BM100 | Keyword eligible; no model identity |
| `/post/849751` | 루솔 이유식 | Keyword eligible; no model identity |
| `/post/849583` | 아기 바라클라바 | Keyword eligible; no model identity |
| `/post/849637` | 캔코 기저귀 가방 | Excluded category |
| `/post/849654` | 실내 점프 트레이닝 | Insufficient evidence; no model suggestions |

Removing the training/tray substring false positive changes eligibility without changing parsing or scheduling. The discovery scenario still schedules one detail, defers 29 products and records one receipt. All 191 anchors, 60 product-link occurrences, 30 products, three parsed real details and null prices are preserved. These are review candidates, not verified premium products.

The narrower collect profile accepts zero of these 30 cards. Pipeline submission tests use an explicitly synthetic eligible stroller detail, with test-only source authorization.
