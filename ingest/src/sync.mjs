import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { XMLParser } from 'fast-xml-parser';

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', trimValues: true, parseTagValue: false });
const array = v => v == null ? [] : Array.isArray(v) ? v : [v];
const string = v => typeof v === 'string' ? v : (v?.['#text'] || '');
const today = new Date().toISOString().slice(0, 10);
const youtubeId = text => text.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/)?.[1] || null;

async function loadFeed(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'UdienzaSponsorDashboard/0.1' } });
  if (!res.ok) throw new Error(`Feed returned HTTP ${res.status}: ${url}`);
  const xml = parser.parse(await res.text());
  const items = array(xml?.rss?.channel?.item);
  if (!items.length) throw new Error(`Feed had no items: ${url}`);
  return items;
}

function parseEpisode(item) {
  const guid = string(item.guid).trim();
  const title = string(item.title).trim();
  if (!guid || !title) return null;
  const enclosures = array(item.enclosure);
  const media = enclosures[0]?.['@_url'] || null;
  const mime = enclosures[0]?.['@_type'] || '';
  const published = item.pubDate ? new Date(item.pubDate) : null;
  return { guid, title, url: string(item.link) || null,
    published: published && !Number.isNaN(published.valueOf()) ? published.toISOString() : null,
    audio: mime.startsWith('audio/') ? media : null,
    video: mime.startsWith('video/') ? media : null,
    youtube: youtubeId(`${string(item['content:encoded'])} ${string(item.description)}`) };
}

async function importFeeds() {
  const audio = (await loadFeed(process.env.AUDIO_FEED_URL || 'https://www.udienza.com/feed.xml')).map(parseEpisode).filter(Boolean);
  // Video is optional: failing it should not block the audio feed.
  let video = [];
  try { video = (await loadFeed(process.env.VIDEO_FEED_URL || 'https://www.udienza.com/feed-video.xml')).map(parseEpisode).filter(Boolean); }
  catch (e) { console.warn('Video feed skipped:', e.message); }
  const videosByUrl = new Map(video.filter(e => e.url).map(e => [e.url.replace(/\/$/, ''), e]));
  const videosByTitle = new Map(video.map(e => [e.title.toLowerCase(), e]));
  for (const e of audio) {
    const matching = videosByUrl.get(e.url?.replace(/\/$/, '')) || videosByTitle.get(e.title.toLowerCase());
    await db.query(`INSERT INTO episodes (guid,title,episode_url,published_at,audio_url,video_url,youtube_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (guid) DO UPDATE SET title=EXCLUDED.title, episode_url=EXCLUDED.episode_url,
      published_at=EXCLUDED.published_at, audio_url=EXCLUDED.audio_url,
      video_url=COALESCE(EXCLUDED.video_url,episodes.video_url),
      youtube_id=COALESCE(EXCLUDED.youtube_id,episodes.youtube_id), updated_at=now()`,
      [e.guid, e.title, e.url, e.published, e.audio, matching?.video || null, matching?.youtube || e.youtube]);
  }
  console.log(`Imported ${audio.length} audio episodes (${video.length} video entries available)`);
}

async function importMapping() {
  let content;
  try { content = await readFile('/app/data/youtube-mapping.csv', 'utf8'); } catch { return; }
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#') || line.startsWith('guid,')) continue;
    const [guid,id] = line.split(',').map(s => s.trim());
    if (!guid || !/^[\w-]{11}$/.test(id || '')) { console.warn('Invalid mapping line:', line); continue; }
    const r = await db.query('UPDATE episodes SET youtube_id=$1 WHERE guid=$2', [id,guid]);
    if (!r.rowCount) console.warn('No episode for YouTube mapping:', guid);
  }
}

async function youtube() {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) { console.log('YouTube sync skipped (no key)'); return; }
  const result = await db.query('SELECT guid,youtube_id FROM episodes WHERE youtube_id IS NOT NULL');
  const ids = result.rows;
  for (let i=0;i<ids.length;i+=50) {
    const batch = ids.slice(i,i+50);
    const url = new URL('https://www.googleapis.com/youtube/v3/videos');
    url.searchParams.set('part','statistics');
    url.searchParams.set('id',batch.map(x=>x.youtube_id).join(','));
    url.searchParams.set('key',key);
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`YouTube API returned HTTP ${response.status}: ${(await response.text()).slice(0,200)}`);
    const stats = new Map((await response.json()).items?.map(x=>[x.id,x.statistics]) || []);
    for (const episode of batch) {
      const count = stats.get(episode.youtube_id)?.viewCount;
      if (count === undefined) continue;
      await db.query(`INSERT INTO episode_metrics (guid,observed_on,platform,metric,value,measurement_type)
        VALUES ($1,$2,'youtube','views',$3,'cumulative')
        ON CONFLICT (guid,observed_on,platform,metric) DO UPDATE SET value=EXCLUDED.value`,
        [episode.guid,today,count]);
    }
  }
  console.log('YouTube counters imported for',ids.length,'mapped episodes');
}

async function importManualMetrics() {
  let content;
  try { content = await readFile('/app/data/metrics.csv','utf8'); } catch { return; }
  let count = 0;
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#') || line.startsWith('guid,')) continue;
    const [guid,date,platform,metric,value,type='cumulative'] = line.split(',').map(v=>v.trim());
    if (!guid || !/^\d{4}-\d{2}-\d{2}$/.test(date||'') || !['youtube','op3','apple','spotify','other'].includes(platform) || !metric || !/^\d+$/.test(value||'') || !['daily','cumulative'].includes(type)) {
      throw new Error('Invalid metrics CSV line: ' + line);
    }
    const r = await db.query(`INSERT INTO episode_metrics (guid,observed_on,platform,metric,value,measurement_type)
      SELECT $1,$2,$3,$4,$5,$6 WHERE EXISTS (SELECT 1 FROM episodes WHERE guid=$1)
      ON CONFLICT (guid,observed_on,platform,metric) DO UPDATE SET value=EXCLUDED.value,measurement_type=EXCLUDED.measurement_type`,
      [guid,date,platform,metric,value,type]);
    if (!r.rowCount) throw new Error('CSV references unknown episode GUID: '+guid);
    count++;
  }
  console.log('Manual metric rows imported:', count);
}

try {
  await importFeeds();
  await importMapping();
  await youtube();
  await importManualMetrics();
  console.log('Sync completed',new Date().toISOString());
} catch (e) { console.error('Sync failed:',e); process.exitCode=1; }
finally { await db.end(); }
