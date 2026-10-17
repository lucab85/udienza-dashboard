# Deployment checklist

- [ ] Create a **private** GitHub repository, e.g. `lucab85/udienza-dashboard`.
- [ ] Push this project's files; verify `.env` is excluded by `.gitignore`.
- [ ] Add DNS `A` record for `dashboard.udienza.com` to your VPS's IP.
- [ ] Install Docker Engine and Docker Compose plugin on VPS.
- [ ] Copy `.env.example` to `.env`; replace placeholder with a generated secret.
- [ ] Check firewall for TCP 80 and 443; do **not** publish PostgreSQL.
- [ ] Run `docker compose up -d --build` and inspect container logs.
- [ ] Complete initial Metabase admin setup over HTTPS.
- [ ] Add internal PostgreSQL `udienza` database as a data source.
- [ ] Verify imported episode rows against live RSS.
- [ ] Build Overview and Episodes dashboards.
- [ ] Configure optional YouTube API key, mappings, and metrics exports.
- [ ] Disable public dashboard sharing; validate sponsor test-account visibility.
- [ ] Set up and test encrypted, off-VPS PostgreSQL backups.
