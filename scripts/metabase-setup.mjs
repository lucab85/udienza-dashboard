// Idempotent Metabase provisioning: data source, sample cleanup, the
// "Udienza" collection, its questions and dashboards.
// Safe to re-run: everything is matched by name and updated in place.
// Run with: docker compose run --rm metabase-setup
const base = process.env.MB_URL || 'http://metabase:3000';
const key = process.env.MB_API_KEY;
const pgPassword = process.env.POSTGRES_PASSWORD;
if (!key) throw new Error('Set MB_API_KEY in .env (Metabase Admin > Settings > Authentication > API keys)');
if (!pgPassword) throw new Error('POSTGRES_PASSWORD is not set');

const DB_NAME = 'Udienza Analytics';
const COLLECTION = 'Udienza';

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

// Each question names its dashboard and position on the 24-column grid.
// Cumulative YouTube counters are snapshots: totals over time take each
// episode's latest value as of each date, never a sum across dates.
const OVERVIEW = 'Udienza – Overview';
const AUDIENCE = 'Udienza – Audience';
const cards = [
  { name: 'Episodes published', display: 'scalar', dashboard: OVERVIEW, pos: [0, 0, 6, 3],
    sql: 'SELECT COUNT(*) AS episodes FROM episodes' },
  { name: 'YouTube views (total)', display: 'scalar', dashboard: OVERVIEW, pos: [0, 6, 6, 3],
    sql: 'SELECT COALESCE(SUM(youtube_views_latest), 0) AS views FROM episode_overview' },
  { name: 'YouTube likes and comments', display: 'table', dashboard: OVERVIEW, pos: [0, 12, 6, 3],
    sql: `SELECT COALESCE(SUM(youtube_likes_latest), 0) AS likes, COALESCE(SUM(youtube_comments_latest), 0) AS comments
FROM episode_overview` },
  { name: 'OP3 downloads (total)', display: 'scalar', dashboard: OVERVIEW, pos: [0, 18, 6, 3],
    sql: 'SELECT COALESCE(SUM(op3_downloads_latest), 0) AS downloads FROM episode_overview' },
  { name: 'YouTube views by episode', display: 'row', dashboard: OVERVIEW, pos: [3, 0, 12, 7],
    sql: `SELECT title AS episode, youtube_views_latest AS views FROM episode_overview
WHERE youtube_views_latest IS NOT NULL ORDER BY youtube_views_latest DESC`,
    viz: { 'graph.dimensions': ['episode'], 'graph.metrics': ['views'] } },
  { name: 'YouTube views over time', display: 'line', dashboard: OVERVIEW, pos: [3, 12, 12, 7],
    sql: `SELECT d.observed_on AS day, SUM(x.value) AS views
FROM (SELECT DISTINCT observed_on FROM episode_metrics WHERE platform = 'youtube' AND metric = 'views') d
CROSS JOIN LATERAL (
  SELECT DISTINCT ON (guid) value FROM episode_metrics m
  WHERE m.platform = 'youtube' AND m.metric = 'views' AND m.observed_on <= d.observed_on
  ORDER BY guid, observed_on DESC) x
GROUP BY d.observed_on ORDER BY d.observed_on`,
    viz: { 'graph.dimensions': ['day'], 'graph.metrics': ['views'] } },
  { name: 'Releases per month', display: 'bar', dashboard: OVERVIEW, pos: [10, 0, 8, 6],
    sql: `SELECT date_trunc('month', published_at)::date AS month, COUNT(*) AS episodes
FROM episodes WHERE published_at IS NOT NULL GROUP BY 1 ORDER BY 1`,
    viz: { 'graph.dimensions': ['month'], 'graph.metrics': ['episodes'] } },
  { name: 'Episode performance', display: 'table', dashboard: OVERVIEW, pos: [10, 8, 16, 6],
    sql: `SELECT title AS episode, published_at::date AS published,
  youtube_views_latest AS youtube_views, youtube_likes_latest AS likes, youtube_comments_latest AS comments,
  op3_audio_downloads_latest AS audio_downloads, op3_video_downloads_latest AS video_downloads, episode_url AS url
FROM episode_overview ORDER BY published_at DESC` },

  // Audience: OP3 podcast-app downloads, one per audience, file and day.
  { name: 'Podcast downloads', display: 'scalar', dashboard: AUDIENCE, pos: [0, 0, 8, 3],
    sql: 'SELECT COUNT(*) AS downloads FROM op3_downloads_counted' },
  { name: 'Audio downloads', display: 'scalar', dashboard: AUDIENCE, pos: [0, 8, 8, 3],
    sql: "SELECT COUNT(*) AS downloads FROM op3_downloads_counted WHERE kind = 'audio'" },
  { name: 'Video downloads', display: 'scalar', dashboard: AUDIENCE, pos: [0, 16, 8, 3],
    sql: "SELECT COUNT(*) AS downloads FROM op3_downloads_counted WHERE kind = 'video'" },
  { name: 'Audio vs video downloads per day', display: 'bar', dashboard: AUDIENCE, pos: [3, 0, 24, 6],
    sql: `SELECT (time AT TIME ZONE 'UTC')::date AS day, kind, COUNT(*) AS downloads
FROM op3_downloads_counted GROUP BY 1, 2 ORDER BY 1, 2`,
    viz: { 'graph.dimensions': ['day', 'kind'], 'graph.metrics': ['downloads'], 'stackable.stack_type': 'stacked' } },
  { name: 'Downloads by episode, audio vs video', display: 'row', dashboard: AUDIENCE, pos: [9, 0, 12, 7],
    sql: `SELECT e.title AS episode, d.kind, COUNT(*) AS downloads
FROM op3_downloads_counted d JOIN episodes e ON e.guid = d.guid
GROUP BY 1, 2 ORDER BY 3 DESC`,
    viz: { 'graph.dimensions': ['episode', 'kind'], 'graph.metrics': ['downloads'], 'stackable.stack_type': 'stacked' } },
  { name: 'Downloads by country', display: 'map', dashboard: AUDIENCE, pos: [9, 12, 12, 7],
    sql: `SELECT country_code AS country, COUNT(*) AS downloads
FROM op3_downloads_counted WHERE country_code IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`,
    viz: { 'map.type': 'region', 'map.region': 'world_countries', 'map.dimension': 'country', 'map.metric': 'downloads' } },
  { name: 'Top podcast apps', display: 'row', dashboard: AUDIENCE, pos: [16, 0, 8, 7],
    sql: `SELECT COALESCE(agent_name, 'Unknown') AS app, COUNT(*) AS downloads
FROM op3_downloads_counted GROUP BY 1 ORDER BY 2 DESC LIMIT 15`,
    viz: { 'graph.dimensions': ['app'], 'graph.metrics': ['downloads'] } },
  { name: 'Devices', display: 'pie', dashboard: AUDIENCE, pos: [16, 8, 8, 7],
    sql: `SELECT COALESCE(device_type, 'unknown') AS device, COUNT(*) AS downloads
FROM op3_downloads_counted GROUP BY 1 ORDER BY 2 DESC`,
    viz: { 'pie.dimension': 'device', 'pie.metric': 'downloads' } },
  { name: 'Top regions and cities', display: 'table', dashboard: AUDIENCE, pos: [16, 16, 8, 7],
    sql: `SELECT country_code AS country, region_name AS region, COUNT(*) AS downloads
FROM op3_downloads_counted WHERE region_name IS NOT NULL GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 25` },
  { name: 'First 7 days per episode', display: 'table', dashboard: AUDIENCE, pos: [23, 0, 24, 6],
    sql: `SELECT e.title AS episode, e.published_at::date AS published,
  COUNT(*) FILTER (WHERE d.time < e.published_at + interval '7 days') AS downloads_7d,
  COUNT(*) FILTER (WHERE d.time < e.published_at + interval '30 days') AS downloads_30d,
  COUNT(*) AS downloads_all
FROM episodes e JOIN op3_downloads_counted d ON d.guid = e.guid
GROUP BY e.guid, e.title, e.published_at ORDER BY e.published_at DESC` },
];

async function ensureCards(databaseId, collectionId) {
  const items = (await api('GET', `/api/collection/${collectionId}/items?models=card`)).data;
  for (const c of cards) {
    const body = {
      name: c.name, display: c.display, collection_id: collectionId,
      visualization_settings: c.viz || {},
      dataset_query: { type: 'native', database: databaseId, native: { query: c.sql } },
    };
    const existing = items.find(i => i.name === c.name);
    c.id = existing ? (await api('PUT', `/api/card/${existing.id}`, body)).id
                    : (await api('POST', '/api/card', body)).id;
    console.log(existing ? 'Question updated:' : 'Question created:', c.name);
  }
}

async function ensureDashboard(collectionId, name) {
  const items = (await api('GET', `/api/collection/${collectionId}/items?models=dashboard`)).data;
  const id = items.find(i => i.name === name)?.id
    ?? (await api('POST', '/api/dashboard', { name, collection_id: collectionId })).id;
  const dashcards = cards.filter(c => c.dashboard === name).map((c, i) => {
    const [row, col, size_x, size_y] = c.pos;
    return { id: -(i + 1), card_id: c.id, row, col, size_x, size_y };
  });
  await api('PUT', `/api/dashboard/${id}`, { dashcards });
  console.log('Dashboard ready:', name, `(/dashboard/${id})`);
  return id;
}

await waitForMetabase();
const databaseId = await ensureDatabase();
await removeSamples();
await api('POST', `/api/database/${databaseId}/sync_schema`);
const collectionId = await ensureCollection();
await ensureCards(databaseId, collectionId);
const dashboardId = await ensureDashboard(collectionId, OVERVIEW);
await ensureDashboard(collectionId, AUDIENCE);
// Open the dashboard on the home page.
await api('PUT', '/api/setting/custom-homepage', { value: true });
await api('PUT', '/api/setting/custom-homepage-dashboard', { value: dashboardId });
console.log('Done.');
