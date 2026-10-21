-- 크롤러 v2: 수집 항목에 자동 추출 제안(모델·가격·공구 일정·링크 + 신뢰도)을 JSON 문자열로 함께 보관한다.
-- 제안은 검수 화면 보조 자료일 뿐이며, 사람이 승인하기 전까지 어떤 값도 게시 데이터로 이동하지 않는다.
ALTER TABLE ingested_items ADD COLUMN suggestions TEXT;
