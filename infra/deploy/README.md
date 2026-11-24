# Stokku staging deploy — owner: Deployment (T-005)

Free-tier path, verified facts as of 2026-11 (re-check pricing pages before
signing up). **Nothing here has been signed up for yet** — the channel decides
which account to create; all configs and commands below are ready to run.

DECISIONS.md D8: staging in **Singapore** (`sin`/ap-southeast-1). No customer
PII at launch.

## Recommended stack (no credit card anywhere)

| Piece | Provider | Free plan facts (2026-11) |
|---|---|---|
| Postgres | **Neon** free | permanent, no card, Singapore region, 1 GB/project, 100 CU-h/month, scales to zero after 5 min idle, restore window only 6 h → **our `infra/backup.sh` is the real backup**, run it on a schedule |
| API | **Render** free web service | 512 MB, Singapore region, Docker deploy (`infra/api.Dockerfile`), spins down after 15 min idle (~1 min cold start), 750 instance-h/month |
| Web | **Render** free static site | global CDN, free; built from `apps/web` |

Alternative: **Fly.io** Free plan — better runtime (no cold starts, region
`sin`, $5 usage/month incl. one $4 Managed Postgres Developer cluster), but
**requires a credit card** ($1 trial credit lasts 7 days without one).
If the channel is fine adding a card, Fly is the stronger option; the exact
commands are below.

Avoid for staging: Render free Postgres (1 GB, **deleted 30 days after
creation**), Supabase/Tigris-style Fly extensions (not on Free).

---

## Path A — Render + Neon (recommended, cardless)

1. **Create the Neon database** (whoever the channel picks):
   - Sign up → New Project → Region **Singapore (ap-southeast-1)**.
   - Save the pooled connection string as `DATABASE_URL`
     (keep it in the deploy vault/`.env`, never in git).
2. **Migrate + seed** from a machine with the repo (sqlx + psql installed):
   ```sh
   cp .env.example .env        # fill DATABASE_URL with the Neon URL
   make migrate && make seed   # then make verify for the full DB proof
   ```
3. **Render**: sign up → New → **Web Service** → connect the repo →
   - Region: **Singapore**
   - Runtime: **Docker** → Dockerfile path: `infra/api.Dockerfile`
   - Instance type: **Free**
   - Health check path: `/health`
   - Environment: `DATABASE_URL` (Neon), `JWT_SECRET` (`openssl rand -base64 48`),
     `APP_BASE_URL=https://<web-app-name>.onrender.com`
   - A `render.yaml` blueprint with these settings is in this folder
     (`render.yaml`).
4. **Web**: New → **Static Site** → connect the repo →
   - Build command: `corepack enable && pnpm install --no-frozen-lockfile && pnpm --filter ./apps/web run build`
   - Publish directory: `apps/web/dist`
   - Set `APP_BASE_URL` env for the API service to the static site URL.
   - (Render free static build env is Node-based; if `corepack` is missing
     there, fall back to `npx pnpm@12.23.0 install …` — check on first deploy.)
5. **Post-deploy checklist** (see "Staging checklist" below).

CLI equivalents (optional, after the first dashboard run):
```sh
# neon CLI: neon projects create --name stokku-staging --region aws-ap-southeast-1
# render CLI: render blueprint launch  (uses render.yaml in this folder)
```

## Path B — Fly.io (stronger runtime, needs a card)

```sh
# one-time, by whoever owns the account:
fly auth signup                      # Free plan: $1 credit, 7 days, no card
                                     # add a card → $5 usage/month

# API app (run from repo root):
fly launch --name stokku-api-staging --region sin --no-deploy \
  --dockerfile infra/api.Dockerfile
fly secrets set DATABASE_URL=... JWT_SECRET=... APP_BASE_URL=...
fly deploy --ha=false                # 1 machine: fits the 3-machine Free cap
fly status && curl https://stokku-api-staging.fly.dev/health

# DB: one Managed Postgres Developer cluster on Free ($4/mo from the $5):
fly postgres create --name stokku-pg-staging --region sin
fly postgres attach stokku-pg-staging   # sets DATABASE_URL as a secret
# then from a checkout: make migrate && make seed

# multi-arch image if we later push to a registry:
docker buildx build --platform linux/amd64,linux/arm64 \
  -f infra/api.Dockerfile -t <registry>/stokku-api:<tag> --push .
```
A starter `fly.toml` is in this folder (adjust app name).

Web on Fly: serve `apps/web/dist` as a second Fly app (nginx image or
[tin](https://fly.io/docs/app-guides/static/)) — only if we go all-Fly.

---

## Staging checklist (run after every deploy)

- [ ] `curl https://<staging-api>/health` → 200, DB status OK
- [ ] Demo tenant login works (`owner@demo.test` seed credentials are in
      the DB branch report/seed script, not in git)
- [ ] `make verify` against the staging DB passes (RLS, change_log,
      3-month reconcile)
- [ ] `infra/backup.sh` produces a dump; restore drill per T-503:
      restore into a scratch DB and compare `v_laba_rugi` totals
- [ ] Acceptance A1–A8 spot-check on the deployed web app
- [ ] No secrets in git: `git ls-files | xargs grep -l 'DATABASE_URL\|JWT_SECRET'`
      shows only `.env.example`
- [ ] Neon/Render dashboards: no unexpected cost line

## Branch protection ("red CI blocks merge")

On the GitHub repo (Settings → Branches → Add rule for `main`):
- Require a pull request before merging
- Require status checks to pass: **Web…**, **API…**, **Migrations…**,
  **Compose…** (the four jobs in `.github/workflows/ci.yml`)
- Require branches up to date before merging

Until the repo is pushed to GitHub, `make test` is the local CI gate.

## Rollback

- API: Render/Fly keep previous releases — redeploy the prior build
  (`render releases` / `fly releases rollback`).
- DB: migrations are forward-only; restore the latest dump:
  `pg_restore --clean --if-exists -d "$DATABASE_URL" backups/stokku-<stamp>.dump`
- Web: static site — redeploy previous commit.
