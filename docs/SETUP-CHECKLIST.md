# Deployment checklist

- [ ] Create a **private** GitHub repository, e.g. `lucab85/udienza-dashboard`.
- [ ] Push this project's files; verify `.env` is excluded by `.gitignore`.
- [ ] Install Docker Engine and Docker Compose plugin on VPS.
- [ ] Copy `.env.example` to `.env`; replace placeholder with a generated secret.
- [ ] Do **not** publish PostgreSQL or Metabase ports.
- [ ] Run `docker compose up -d --build` and inspect container logs.
- [ ] Add the `dashboard.udienza.com` site block and `@dashboard` `:8080` route to the shared Caddy; validate and reload.
- [ ] Point `dashboard.udienza.com` at the host: proxied `A` record, or tunnel public hostname → `http://caddy:8080`.
- [ ] Add a Cloudflare Access application and policy for `dashboard.udienza.com`.
- [ ] Complete initial Metabase admin setup over HTTPS.
- [ ] Add internal PostgreSQL `udienza` database as a data source.
- [ ] Verify imported episode rows against live RSS.
- [ ] Build Overview and Episodes dashboards.
- [ ] Configure optional YouTube API key, mappings, and metrics exports.
- [ ] Disable public dashboard sharing; validate sponsor test-account visibility.
- [ ] Set up and test encrypted, off-VPS PostgreSQL backups.
