The original four fixtures below are sanitized copies of the real public Pangpang pages approved by 준태님 on 2026-11-02 at 22:15 KST. Originals were supplied at `/workspace/agamajung/fixtures/pangpang/`, saved with a normal browser user agent. Tests make no live requests.

| File | Source |
| --- | --- |
| list.html | https://09pangpang.com/ |
| deal1.html | https://09pangpang.com/post/849822 |
| deal2.html | https://09pangpang.com/post/849751 |
| deal3.html | https://09pangpang.com/post/849770 |

Scripts, styles, SVG, private/hidden regions, embeds, images/media, metadata, and unused attributes were removed using the collector DOM scanner. Public product/seller text, category buttons, schedule text, relevant classes, hrefs, data-feed-index and accessible duplicate anchors remain. The saved listing retains 191 anchors, 60 post links and 30 visible product cards. It does not reproduce the reported 768-link production page. The separately labeled synthetic 768-anchor test checks enumeration and processing limits.

Reference time: 2026-11-02T22:15:00+09:00. No fixture publishes a price. Missing prices and opening-only end dates remain null.

The unchanged discovery classifier accepts five listing products, excludes one by its diaper/formula rule, and rejects 24 for insufficient baby/model evidence. The five include the existing `트레이닝` → `트레이` false positive; they are not five verified premium products. The narrower collect profile accepts zero of these 30 cards. Pipeline submission tests use an explicitly synthetic eligible stroller detail, with test-only source authorization.

## Fresh HTTP capture: 2026-11-05 (KST)

`list-2026-11-05.html` is an authentic listing response from `https://09pangpang.com/`, captured at **2026-11-05 08:12:04.291 KST** (`2026-11-04T23:12:04.291Z`). The filename uses the local capture date. It is not a rendered DOM or a synthesized page.

Acquisition used the current Linux `Scheduler.get` / `pinnedRequest`, its crawler user agent and UTF-8 `response.body`, with the existing operator-enabled Pangpang policy and existing operator-configured trusted egress. The runtime DB was read only: its domain was not stopped or cooling down, and its daily budget state was copied into a temporary audit store. All three acquisition attempts were charged there. The first failed at DNS address validation before HTTP because the runtime egress configuration had not yet been supplied; it was not retried with a new egress setting, but with the operator's already configured setting. Two subsequent robots/listing pairs succeeded (four HTTP GETs total, no detail probes); the first response was discarded in memory after an overly strict sanitization equality check detected whitespace changes. The second response produced this fixture. Robots, the larger of five seconds/Crawl-delay, byte bounds, URL policy and redirect identity were enforced. There were no block responses, rate-limit retries, browser fallback, cookies, logins or source-authorization changes. No runtime DB, queue or PM2 state was modified.

The 398,112-byte HTTP body was sanitized in memory before saving. The collector DOM scanner removed scripts/styles/templates/SVG and hidden/private/input regions. Serialization additionally removed head metadata, forms, embeds and media; only `class`, `href`, `data-feed-index` and `datetime` attributes were retained. Text passed through the shared privacy filter and HTML escaping, normalizing whitespace (including spaces around inline category/schedule separators). Two unsafe non-product hrefs were replaced with `#removed-unsafe-link`; three email-protection fragments were removed. Product title nodes, card/container boundaries, all 60 product hrefs (including `?source=home`) and their duplicate relationships remain. No product title, identity or card was invented. No original response, scripts, credentials or encoded contact addresses are retained.

- HTTP-body SHA-256 (before sanitization): `770e2a6f8018609770acc543ecc6ca58754bf9dca10c331c71227f11cc564cfb`
- Saved-fixture SHA-256: `30965bf1724f860118ac70eb30f97ca6479ee06fd85bebc231eeb21f9a94b207`

The raw response and saved fixture each parse 30 products. Independently of `extractPangpang`, an HTML anchor inventory and manual review of each card's title, destination and schedule identified the following 30 genuine distinct product/group-buy cards, in response order. Every card has one visible tracked link and one untracked accessible duplicate. There are **no omitted product cards**: 30/30 (100%) expected identities, 30 duplicates, and 131 non-product anchors. Navigation, search, categories, legal and contact links are not products, even when their text mentions baby equipment.

| ID | Reviewed title |
| --- | --- |
| 854600 | 미니두두 스카프 |
| 854596 | 크림표 밤부골지쫄핏 |
| 854593 | 트루엔키즈 점프업 아르기닌 1000 |
| 854592 | 몽베이비 장난감 정리함 |
| 854595 | 리나마켓 × 바인허브 연말 세일 |
| 854584 | 숨사이 탈취제 모음전 3차 |
| 854590 | 아이주 골라담기 |
| 854482 | 304 올스텐 거꾸로 양치컵 |
| 854588 | 킥보드 |
| 854483 | 라이브오랄스 어린이 실리콘 개구기 |
| 854583 | 미니미 압력밥솥 & 전용인덕션 |
| 854568 | 닥터 점키 블랙프라이데이 공구 |
| 854466 | 위드나르 리페어 커버 비비 |
| 854212 | 효소 |
| 854240 | 스트링 밍크 후드 베스트 |
| 854442 | 미쁨곰탕 |
| 854553 | 뉴발란스 패딩 세탁 클리어 |
| 854443 | 미쁨 곰탕 |
| 854576 | 또띵 미니와플블럭 |
| 854499 | 네오필세럼 |
| 854283 | 퓨어잇 아기 간식 |
| 854558 | 닥터브레드 우리쌀빵 |
| 854535 | 올리타리아 유기농 엑스트라버진 올리브오일 |
| 854308 | 키움북스 세이펜 레이온펜 & 통통 자연동화 |
| 854302 | 황토찜질팩 |
| 854242 | 몬스터 챌린지 교구 |
| 854300 | MTS 테라큐어펜 |
| 854162 | 미니 깜찍 팝업북 |
| 854396 | 기모맨투맨 |
| 854522 | 닥터체크 분홍이 소프트 |

The unchanged discovery classifier accepts six IDs: `854596`, `854592`, `854590`, `854483`, `854442`, `854283`; the other 24 are `not_baby_item`. This is classifier eligibility, not verification of premium equipment or permission to publish. Category is genuinely absent on `854600` and `854595`; they still parse with an empty category. `854583` has no schedule; dates remain null. Every price remains null. Missing metadata does not cause whole-page extraction. The original November 2 fixtures and their five classifier matches remain unchanged.

`tests/pangpang.test.ts` pins the reviewed canonical identities, accounting and unchanged eligibility, separately replays all captured non-product anchors, and exercises the fresh fixture through mocked discover with page/depth limits and deferred counts. All regression requests are mocked; running these tests cannot fetch the source.
