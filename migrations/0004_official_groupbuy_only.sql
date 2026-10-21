-- Remove only the legacy seed price snippets, preserving unrelated notes and all prices/relations.
-- Match brand/name rather than positional seed IDs. REPLACE makes reruns harmless.
UPDATE models
SET note = REPLACE(note, 'SSG 신세계백화점에는 510,000원으로 표시돼 확인 필요', '')
WHERE brand = 'Stokke' AND name = '트립트랩 하이체어(오크)';

UPDATE models
SET note = REPLACE(note, '공식몰 할인가 1,390,000원 표시(재고 소진 임박)', '')
WHERE brand = 'Stokke' AND name = '익스플로리 X';

UPDATE models
SET note = REPLACE(note, '갤러리아 5% 할인 2,223,000원', '')
WHERE brand = 'Bugaboo' AND name = '폭스5 리뉴';

UPDATE models
SET note = REPLACE(note, '검색 요약상 259,000~300,000원 범위, 단일 공식가 미확인', '단일 공식가 미확인')
WHERE brand = 'Ergobaby' AND name = '옴니 브리즈';

UPDATE models
SET note = REPLACE(note, ' 비공식 판매가 701,400원(옥션, 2026-07-24 기준)', '')
WHERE brand = 'Doona' AND name = '두나 카시트 겸용 유모차';
