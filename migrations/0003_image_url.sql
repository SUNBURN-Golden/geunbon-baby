-- Images remain private until an administrator approves their publication.
ALTER TABLE ingested_items ADD COLUMN image_url TEXT;
ALTER TABLE deals ADD COLUMN image_url TEXT;
