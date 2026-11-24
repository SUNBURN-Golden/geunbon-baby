INSERT INTO models(id,brand,name,category,importer,official_price,source_url,checked,verify_level,note) VALUES
('model-42','하베브릭스','바람개비 아기체육관','play_gym','미확인',NULL,'https://m.whittlestore.com/views/shop/shopview?iniCategory=91&pack_content_id=4463&thisCategory=546','2026-11-24','official_unpublished','제품 페이지로 구성 확인. 국내 공식 정상가는 미확인.'),
('model-43','Lovevery','The Play Gym','play_gym','미확인',NULL,'https://lovevery.com/products/the-play-gym','2026-11-24','official_unpublished','제품 페이지로 구성 확인. 국내 공식 정상가는 미확인.')
ON CONFLICT(id) DO NOTHING;
