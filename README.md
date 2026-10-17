# Udienza sponsor analytics dashboard

Private, self-hosted Metabase Community Edition dashboard for `dashboard.udienza.com`. Designed to work alongside [`lucab85/udienza.com`](https://github.com/lucab85/udienza.com), without touching its Astro/Vercel production deployment.

## Components

- **Metabase** — private dashboards, native account login, questions, and collections.
- **PostgreSQL** — Metabase application metadata plus a separate `udienza` analytics database.
- **Cloudflare (proxy or Tunnel) + Access** — public entry and login gate for `dashboard.udienza.com`, through the host's shared Caddy (no ports published by this stack).
- **Node.js worker** — imports Udienza episode metadata from the live audio RSS feed; enriches with video feed, optional YouTube views, and manually supplied analytics exports every 24 hours.

> **Data availability:** A fresh installation automatically imports episodes but **does not fabricate metrics**. YouTube public view counters require an API key and per-episode ID mapping. OP3, Apple, and Spotify metrics are currently CSV imports, not live connectors. Sponsor accounts, dashboards and campaigns must be created/configured after first launch.

## Requirements

- Linux VPS with Docker Engine and Docker Compose plugin. Metabase is capped at 900 MB (`-Xmx640m`); PostgreSQL and the worker at 256 MB each.
- The host's main stack (`/opt/apps`) running: Docker network `apps_apps`, the shared `caddy` with its internal `:8080` site, and `cloudflared` (token-managed tunnel). This is the same path used by postiz and twenty.
- `udienza.com` on Cloudflare DNS.
- A private GitHub repository for this source code (no secrets committed).

## Installation

```bash
git clone <your-private-repo-url> /opt/udienza-dashboard
cd /opt/udienza-dashboard
cp .env.example .env
openssl rand -hex 32   # paste output into POSTGRES_PASSWORD in .env
chmod 600 .env
docker compose up -d --build
docker compose logs -f ingest
```

**Do not proceed with a default/placeholder password.**

### Expose through the shared Caddy (same pattern as postiz)

1. Add both routes to `/opt/apps/proxy/Caddyfile`: a public site block (for the proxied DNS record) and a host route in the internal `:8080` site, before its final `handle` 404 fallback (for the tunnel):

   ```caddy
   dashboard.udienza.com {
   	reverse_proxy udienza-metabase:3000
   }
   ```

   ```caddy
   @dashboard host dashboard.udienza.com
   handle @dashboard {
   	reverse_proxy udienza-metabase:3000
   }
   ```

   Validate and reload:

   ```bash
   docker exec apps-caddy-1 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
   docker exec apps-caddy-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
   ```

2. DNS in the `udienza.com` Cloudflare zone, either:
   - **Proxied `A` record** `dashboard` → the VPS IP (orange cloud). Caddy obtains the origin certificate via HTTP-01; keep SSL mode **Full (strict)**. Or:
   - **Tunnel public hostname** `dashboard.udienza.com` → `HTTP` → `caddy:8080` (Zero Trust → Networks → Tunnels). This replaces the `A` record.
3. In Zero Trust → **Access → Applications**, add a self-hosted application for `dashboard.udienza.com` with a policy allowing only the intended emails (as for postiz). Sponsors must be in this policy as well as in Metabase. With the `A` record, the origin IP stays reachable directly, so Access is not a hard boundary there; Metabase login still applies.
4. Open `https://dashboard.udienza.com` and create the first Metabase administrator account immediately.

In Metabase, choose **Add database → PostgreSQL**:

| Field | Value |
| --- | --- |
| Display name | Udienza Analytics |
| Host | `udienza-postgres` (not `postgres`: on the shared network that name is the main stack's database) |
| Port | `5432` |
| Database | `udienza` |
| Username | `udienza` |
| Password | value of `POSTGRES_PASSWORD` |

The initial database creation SQL executes only when the PostgreSQL volume is empty. For later schema changes, use migrations (do **not** delete the volume).

## First charts

Use Metabase's notebook query builder against `episode_overview`:

1. Episode views: list `title`, `youtube_views_latest`, `op3_downloads_latest`.
2. Releases by month: group `episodes.published_at` by month, count rows.
3. Episode leaderboard: sort by `youtube_views_latest` (once YouTube metrics are imported).
4. Sponsor performance: configure `sponsors`, `campaigns`, `campaign_episodes`, and tracked `campaign_metrics` once your sponsor tracking data exists.

**Metric semantics:** YouTube view counts are cumulative snapshots, so never sum one episode's values across dates. The `episode_overview` view selects its newest value. Podcast download figures must state source, window, and whether values are daily or cumulative. Counts across platforms must not be called unique listeners.

## Import optional YouTube view counters

1. Create an API key enabled for **YouTube Data API v3**. Restrict the key appropriately (API restriction plus suitable network restriction for your VPS).
2. Put the key in `.env` as `YOUTUBE_API_KEY` (never in the CSV or repository).
3. The worker reads each episode's YouTube ID from the YouTube link in the feed show notes. Only if one is missing or wrong, add `guid,youtube_id` to `examples/youtube-mapping.csv` (exact GUID from the audio feed; 11-character video ID).
4. Run `docker compose up -d --force-recreate ingest` and `docker compose logs -f ingest`.

The worker imports published public view counters, **not** YouTube watch time, demographic information, or private channel analytics. Those require OAuth/YouTube Analytics authorization in a future integration.

## Import OP3, Apple or Spotify exports

Add validated rows to `examples/metrics.csv`:

```csv
guid,date,platform,metric,value,measurement_type
actual-guid-from-feed,2026-10-17,op3,downloads,120,cumulative
```

Use `daily` only for measurements covering exactly that date and `cumulative` for counters as of that date. The file is a **manual normalized import format**, not a direct export from the podcast services; transform service exports before importing. No numbers are displayed unless actually imported. Restart `ingest` to import immediately.

## Sponsor access and security

Metabase CE allows accounts and collection permissions. For each sponsor, create a **separate collection** and share only approved aggregate dashboards/questions. **Important:** hiding a collection does not reliably isolate underlying database rows. Unless you have verified data access policies, do **not** grant sponsor accounts broad query-builder/SQL access to the analytics database; do not assume collection visibility equals data isolation.

If sponsors need strictly confidential, per-sponsor row-level isolation, do not expose cross-sponsor tables through unrestricted Metabase accounts. Use vetted restricted database views/roles and a verified permissions model, or add an app-level sponsor portal with server-side authorization and Metabase signed guest embedding. Test using a real sponsor test account before sharing credentials.

Cloudflare Access is the first gate and Metabase login the second: still configure a strong admin password, disable public sharing, patch containers, and back up volumes. Do not add a published port to Metabase, which would bypass Access.

## Operations

```bash
docker compose ps
docker compose logs --tail=100 metabase ingest
docker compose pull && docker compose up -d --build
# Example logical backup (keep off the VPS and encrypt):
docker compose exec -T postgres pg_dumpall -U udienza > backup.sql
```

Schedule encrypted PostgreSQL backups separately. **Test restoration.** Pin container updates deliberately; avoid unreviewed automatic major upgrades. TLS terminates at Cloudflare; if the site does not load, check `docker logs apps-cloudflared-1` and `docker logs apps-caddy-1`.

## Repository boundary

This dashboard is a separate deployment. It reads the public Udienza RSS feeds and does not need credentials to your private website repository. The Astro production website, episode publishing automation, feeds, Cloudflare R2 storage, and existing Vercel deploy remain unchanged.

## Current implementation status

Working scaffolding: Docker Compose services, Cloudflare Tunnel/Access exposure, schema, RSS importer, public YouTube view sync (optional), normalized CSV import, operations instructions. Not yet populated with real analytics or sponsor accounts. No API keys, credentials, or VPS details are included.
