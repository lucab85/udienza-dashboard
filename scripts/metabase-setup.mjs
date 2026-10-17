// Idempotent Metabase provisioning: data source, sample cleanup, the
// "Udienza" collection, its questions and the overview dashboard.
// Safe to re-run: everything is matched by name and updated in place.
// Run with: docker compose run --rm metabase-setup
const base = process.env.MB_URL || 'http://metabase:3000';
const key = process.env.MB_API_KEY;
const pgPassword = process.env.POSTGRES_PASSWORD;
if (!key) throw new Error('Set MB_API_KEY in .env (Metabase Admin > Settings > Authentication > API keys)');
if (!pgPassword) throw new Error('POSTGRES_PASSWORD is not set');

const DB_NAME = 'Udienza Analytics';
const COLLECTION = 'Udienza';
const DASHBOARD = 'Udienza – Overview';

async function api(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'x-api-key': key, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function waitForMetabase() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(base + '/api/health')).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error('Metabase did not become healthy at ' + base);
}

async function ensureDatabase() {
  const details = { host: 'udienza-postgres', port: 5432, dbname: 'udienza', user: 'udienza', password: pgPassword, ssl: false };
  const existing = (await api('GET', '/api/database')).data.find(d => d.name === DB_NAME);
  if (existing) {
    await api('PUT', `/api/database/${existing.id}`, { details });
    console.log('Database updated:', DB_NAME);
    return existing.id;
  }
  const created = await api('POST', '/api/database', { engine: 'postgres', name: DB_NAME, details, is_full_sync: true });
  console.log('Database created:', DB_NAME);
  return created.id;
}

async function removeSamples() {
  for (const d of (await api('GET', '/api/database')).data.filter(d => d.is_sample)) {
    await api('DELETE', `/api/database/${d.id}`);
    console.log('Sample database removed:', d.name);
  }
  for (const c of (await api('GET', '/api/collection')).filter(c => c.is_sample && !c.archived)) {
    await api('PUT', `/api/collection/${c.id}`, { archived: true });
    console.log('Sample collection archived:', c.name);
  }
}

async function ensureCollection() {
  const existing = (await api('GET', '/api/collection')).find(c => c.name === COLLECTION && !c.archived && !c.personal_owner_id);
  if (existing) return existing.id;
  const created = await api('POST', '/api/collection', { name: COLLECTION, description: 'Udienza podcast analytics', parent_id: null });
  console.log('Collection created:', COLLECTION);
  return created.id;
}

// Cumulative YouTube counters are snapshots: totals over time take each
// episode's latest value as of each date, never a sum across dates.
const cards = [
  { key: 'episodes', name: 'Episodes published', display: 'scalar',
    sql: 'SELECT COUNT(*) AS episodes FROM episodes' },
  { key: 'yt_total', name: 'YouTube views (total)', display: 'scalar',
    sql: 'SELECT COALESCE(SUM(youtube_views_latest), 0) AS views FROM episode_overview' },
  { key: 'op3_total', name: 'OP3 downloads (total)', display: 'scalar',
    sql: 'SELECT COALESCE(SUM(op3_downloads_latest), 0) AS downloads FROM episode_overview' },
  { key: 'yt_by_episode', name: 'YouTube views by episode', display: 'row',
    sql: `SELECT title AS episode, youtube_views_latest AS views FROM episode_overview
WHERE youtube_views_latest IS NOT NULL ORDER BY youtube_views_latest DESC`,
    viz: { 'graph.dimensions': ['episode'], 'graph.metrics': ['views'] } },
  { key: 'yt_over_time', name: 'YouTube views over time', display: 'line',
    sql: `SELECT d.observed_on AS day, SUM(x.value) AS views
FROM (SELECT DISTINCT observed_on FROM episode_metrics WHERE platform = 'youtube' AND metric = 'views') d
CROSS JOIN LATERAL (
  SELECT DISTINCT ON (guid) value FROM episode_metrics m
  WHERE m.platform = 'youtube' AND m.metric = 'views' AND m.observed_on <= d.observed_on
  ORDER BY guid, observed_on DESC) x
GROUP BY d.observed_on ORDER BY d.observed_on`,
    viz: { 'graph.dimensions': ['day'], 'graph.metrics': ['views'] } },
  { key: 'releases', name: 'Releases per month', display: 'bar',
    sql: `SELECT date_trunc('month', published_at)::date AS month, COUNT(*) AS episodes
FROM episodes WHERE published_at IS NOT NULL GROUP BY 1 ORDER BY 1`,
    viz: { 'graph.dimensions': ['month'], 'graph.metrics': ['episodes'] } },
  { key: 'table', name: 'Episode performance', display: 'table',
    sql: `SELECT title AS episode, published_at::date AS published,
  youtube_views_latest AS youtube_views, op3_downloads_latest AS op3_downloads, episode_url AS url
FROM episode_overview ORDER BY published_at DESC` },
];

// 24-column grid.
const layout = {
  episodes: { row: 0, col: 0, size_x: 8, size_y: 3 },
  yt_total: { row: 0, col: 8, size_x: 8, size_y: 3 },
  op3_total: { row: 0, col: 16, size_x: 8, size_y: 3 },
  yt_by_episode: { row: 3, col: 0, size_x: 12, size_y: 7 },
  yt_over_time: { row: 3, col: 12, size_x: 12, size_y: 7 },
  releases: { row: 10, col: 0, size_x: 8, size_y: 6 },
  table: { row: 10, col: 8, size_x: 16, size_y: 6 },
};

async function ensureCards(databaseId, collectionId) {
  const items = (await api('GET', `/api/collection/${collectionId}/items?models=card`)).data;
  const ids = {};
  for (const c of cards) {
    const body = {
      name: c.name, display: c.display, collection_id: collectionId,
      visualization_settings: c.viz || {},
      dataset_query: { type: 'native', database: databaseId, native: { query: c.sql } },
    };
    const existing = items.find(i => i.name === c.name);
    ids[c.key] = existing ? (await api('PUT', `/api/card/${existing.id}`, body)).id
                          : (await api('POST', '/api/card', body)).id;
    console.log(existing ? 'Question updated:' : 'Question created:', c.name);
  }
  return ids;
}

async function ensureDashboard(collectionId, cardIds) {
  const items = (await api('GET', `/api/collection/${collectionId}/items?models=dashboard`)).data;
  const id = items.find(i => i.name === DASHBOARD)?.id
    ?? (await api('POST', '/api/dashboard', { name: DASHBOARD, collection_id: collectionId })).id;
  const dashcards = cards.map((c, i) => ({ id: -(i + 1), card_id: cardIds[c.key], ...layout[c.key] }));
  await api('PUT', `/api/dashboard/${id}`, { dashcards });
  console.log('Dashboard ready:', DASHBOARD, `(/dashboard/${id})`);
  return id;
}

await waitForMetabase();
const databaseId = await ensureDatabase();
await removeSamples();
await api('POST', `/api/database/${databaseId}/sync_schema`);
const collectionId = await ensureCollection();
const cardIds = await ensureCards(databaseId, collectionId);
const dashboardId = await ensureDashboard(collectionId, cardIds);
// Open the dashboard on the home page.
await api('PUT', '/api/setting/custom-homepage', { value: true });
await api('PUT', '/api/setting/custom-homepage-dashboard', { value: dashboardId });
console.log('Done.');
