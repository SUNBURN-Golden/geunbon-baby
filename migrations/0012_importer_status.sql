-- Importer verification status separated from the public importer name. Add-only.
ALTER TABLE models ADD COLUMN importer_status TEXT NOT NULL DEFAULT 'unconfirmed' CHECK (importer_status IN ('confirmed','unconfirmed','recheck_failed'));
UPDATE models SET importer = replace(importer, ' (기존 정보, 재확인 실패)', ''), importer_status = 'recheck_failed' WHERE importer LIKE '% (기존 정보, 재확인 실패)';
UPDATE models SET importer_status = 'unconfirmed' WHERE importer = '미확인';
UPDATE models SET importer_status = 'confirmed' WHERE importer_status = 'unconfirmed' AND ((brand = 'Stokke' AND importer = '스토케코리아') OR (brand = 'Bugaboo' AND importer = '부가부코리아(유)') OR (brand = 'Nuna' AND importer = '(주)에이원월드') OR (brand = 'BabyBjorn' AND importer = '베이비뵨㈜') OR (brand = 'D.THRONE' AND importer = '디트로네 주식회사(국내 브랜드)'));
