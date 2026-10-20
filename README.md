# 근본

Price comparison and Instagram group-buy tracker for premium iconic baby gear (근본템): Stokke, Bugaboo, BabyBjörn, CYBEX, Nuna, Joie, egg, D.THRONE, Doona, Britax. No diapers or formula. The interface is Korean and mobile-first.

근본 is not a seller. Listings link out. There is no checkout.

## Sample data

The database seeds itself when it is empty. Every seeded price, seller, event, and import checklist is a **placeholder**:

- `is_sample` / `checklist_is_sample` is true
- source links point at `https://example.com/sample/...`
- seller names and titles contain `샘플`
- the site banner says the stored prices are samples

Do not treat those numbers as market prices. An admin can save a real quote only by turning the sample flag off and checking the confirmation box.

## Setup

```bash
npm install
npm run dev
```

Open http://localhost:3000. In development the admin password is `geunbon-dev` unless `ADMIN_PASSWORD` is set. Copy `.env.example` to `.env.local` before production.

```bash
npm test
npm run lint
npm run build
npm start
```

Production requires:

- `ADMIN_PASSWORD`
- `ADMIN_SESSION_SECRET` (at least 16 characters)

## Data layer

Pages and `/api/*` share one repository (`src/server`). Routes return JSON for a future Expo app:

```json
{ "ok": true, "data": {}, "meta": { "apiVersion": 1 } }
```

Without `DATABASE_URL`, the app uses in-memory [PGlite](https://pglite.dev/) (Postgres). Data lives for the server process and is reseeded on the next boot. Set `GEUNBON_DATA_DIR=.data/pglite` to persist that embedded database, or set `DATABASE_URL` for Postgres / Supabase.

```bash
# Supabase pooler (transaction mode). prepare is disabled in the client.
DATABASE_URL=postgresql://postgres.[ref]:[password]@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres
```

On startup the server runs `db/migrations/001_init.sql` and seeds when `brands` is empty. The SQL is Postgres-compatible (`uuid`, `timestamptz`, `jsonb`, checks). Apply that file in the Supabase SQL editor if you prefer to migrate there yourself.

The server uses a direct database role. Do not expose these tables with the Supabase anon key until you enable row level security and add policies. The service role bypasses RLS.

```bash
npm run db:seed    # migrate + seed if empty
npm run db:reset   # truncate and seed again (Postgres or GEUNBON_DATA_DIR)
```

Newsletter signups are stored in `newsletter_subscribers`. If `NEWSLETTER_WEBHOOK_URL` is set, the app also POSTs `{ email, source }` there after a new address is stored. A webhook failure does not roll back the row. No mail vendor SDK is included.

## API

Public routes send `Access-Control-Allow-Origin: *`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Process and database mode |
| GET | `/api/home` | Featured models, open group buys, events |
| GET | `/api/brands` | Brands |
| GET | `/api/brands/:slug` | Brand plus its models |
| GET | `/api/models?brand=&category=&featured=` | Model cards |
| GET | `/api/models/:slug` | Comparison, history, deal, checklist, group buys |
| GET | `/api/group-buys?status=&month=&on=` | Calendar data. Status is `ongoing`, `upcoming`, or `ended` |
| GET | `/api/events` | Brand events |
| POST | `/api/submissions` | Group-buy or tip. Stored as `pending` |
| POST | `/api/newsletter` | `{ email, source?, unsubscribe? }` |

Admin routes require the `geunbon_session` cookie from `POST /api/admin/login` with `{ password }`. The cookie is `HttpOnly` and `SameSite=Lax`. `Secure` is added only when that request is HTTPS (`X-Forwarded-Proto` or the request URL), so a local `next start` on `http://localhost` can keep the session.

| Method | Path |
| --- | --- |
| POST | `/api/admin/login` |
| POST | `/api/admin/logout` |
| GET | `/api/admin/session` |
| GET, POST | `/api/admin/brands`, `models`, `prices`, `group-buys`, `events` |
| PATCH, DELETE | `/api/admin/:resource/:id` |
| GET | `/api/admin/submissions`, `/api/admin/subscribers` |
| PATCH | `/api/admin/submissions/:id` with `{ status }` |

Approving a submission does not publish it. Create the price or group-buy row in admin.

Price channels are `group_buy`, `official`, `parallel_import`, `overseas`, `used`. Amounts are integer KRW. Overseas figures are already converted. The “평소보다 N% 저렴” badge compares the median official quote (at least two points) with the lowest latest price among group-buy, official, and parallel import. Used and overseas prices stay in the table and the chart, and they do not create the badge. A gap under 5% shows no badge.

## Pages

- `/` featured models, open group buys, brand events, newsletter
- `/models` and `/models/[slug]` comparison table, history chart, checklist, sources, checked dates
- `/group-buys` month calendar and list, trust flags, `광고` label
- `/submit` host listings and reader tips
- `/legal` party, link-out, ads, samples
- `/admin` brands, models, prices, group buys, events, submissions, newsletter

## Legal

- Paid placements must keep `is_ad` so the UI shows **광고**.
- Copy states that we are not a party to the sale.
- Links leave the site. There is no payment.
- Trust flags (통신판매업 신고, 청약철회 7일, 정식수입, KC, importer, domestic service) are stored claims, not a certification by this site.
