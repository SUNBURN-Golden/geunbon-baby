-- 근본 schema. Postgres and Supabase compatible.
-- The Next.js server uses a direct database role. Do not expose these tables
-- with the Supabase anon key until row level security is enabled and policies
-- are written. Service-role connections bypass RLS.

CREATE TABLE IF NOT EXISTS brands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  name_ko text NOT NULL,
  country text,
  website_url text,
  summary text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT brands_slug_format CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);

CREATE TABLE IF NOT EXISTS models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL REFERENCES brands (id) ON DELETE CASCADE,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  name_ko text NOT NULL,
  category text NOT NULL,
  summary text NOT NULL DEFAULT '',
  featured boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  kc_mark boolean NOT NULL DEFAULT false,
  importer_name text,
  domestic_as boolean NOT NULL DEFAULT false,
  warranty_note text,
  checklist_is_sample boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT models_slug_format CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT models_category_check CHECK (
    category IN (
      'stroller',
      'compact_stroller',
      'high_chair',
      'bouncer',
      'car_seat',
      'travel_system'
    )
  )
);

CREATE INDEX IF NOT EXISTS models_brand_idx ON models (brand_id);

CREATE TABLE IF NOT EXISTS price_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id uuid NOT NULL REFERENCES models (id) ON DELETE CASCADE,
  channel text NOT NULL,
  amount_krw integer NOT NULL,
  source_name text NOT NULL,
  source_url text NOT NULL,
  checked_on date NOT NULL,
  is_sample boolean NOT NULL DEFAULT true,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT price_quotes_channel_check CHECK (
    channel IN ('group_buy', 'official', 'parallel_import', 'overseas', 'used')
  ),
  CONSTRAINT price_quotes_amount_check CHECK (amount_krw >= 0 AND amount_krw <= 30000000)
);

CREATE INDEX IF NOT EXISTS price_quotes_model_idx ON price_quotes (model_id, channel, checked_on DESC);

CREATE TABLE IF NOT EXISTS group_buys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id uuid NOT NULL REFERENCES models (id) ON DELETE CASCADE,
  title text NOT NULL,
  seller_name text NOT NULL,
  instagram_handle text,
  price_krw integer,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  source_url text NOT NULL,
  is_ad boolean NOT NULL DEFAULT false,
  is_sample boolean NOT NULL DEFAULT true,
  has_mail_order_registration boolean NOT NULL DEFAULT false,
  has_cooling_off boolean NOT NULL DEFAULT false,
  is_official_import boolean NOT NULL DEFAULT false,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT group_buys_dates_check CHECK (ends_on >= starts_on),
  CONSTRAINT group_buys_price_check CHECK (
    price_krw IS NULL OR (price_krw >= 0 AND price_krw <= 30000000)
  )
);

CREATE INDEX IF NOT EXISTS group_buys_dates_idx ON group_buys (starts_on, ends_on);

CREATE TABLE IF NOT EXISTS brand_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL REFERENCES brands (id) ON DELETE CASCADE,
  title text NOT NULL,
  summary text NOT NULL DEFAULT '',
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  source_url text,
  is_sample boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT brand_events_dates_check CHECK (ends_on >= starts_on)
);

CREATE TABLE IF NOT EXISTS submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  payload jsonb NOT NULL,
  contact_email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  CONSTRAINT submissions_kind_check CHECK (kind IN ('group_buy', 'tip')),
  CONSTRAINT submissions_status_check CHECK (status IN ('pending', 'approved', 'rejected'))
);

CREATE INDEX IF NOT EXISTS submissions_status_idx ON submissions (status, created_at DESC);

CREATE TABLE IF NOT EXISTS newsletter_subscribers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  source text NOT NULL DEFAULT 'web',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT newsletter_email_check CHECK (position('@' IN email) > 1)
);
