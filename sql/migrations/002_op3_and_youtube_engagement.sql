-- Idempotent: the ingest worker applies every file in sql/migrations, in
-- name order, before each sync.

-- One row per OP3 download request (bots excluded by OP3). No IP data is
-- stored; audience_id is OP3's anonymous daily audience hash.
CREATE TABLE IF NOT EXISTS op3_downloads (
  time TIMESTAMPTZ NOT NULL,
  url TEXT NOT NULL,
  audience_id TEXT NOT NULL,
  guid TEXT REFERENCES episodes(guid) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('audio','video')),
  episode_id TEXT,
  agent_type TEXT,
  agent_name TEXT,
  device_type TEXT,
  device_name TEXT,
  country_code TEXT,
  continent_code TEXT,
  region_code TEXT,
  region_name TEXT,
  metro_code TEXT,
  timezone TEXT,
  PRIMARY KEY (time, url, audience_id)
);
CREATE INDEX IF NOT EXISTS op3_downloads_guid ON op3_downloads (guid);

-- A download as reported: one per audience, file and day, so retries and
-- range requests from the same app do not count twice.
CREATE OR REPLACE VIEW op3_downloads_counted AS
SELECT DISTINCT ON (audience_id, url, (time AT TIME ZONE 'UTC')::date) *
FROM op3_downloads
ORDER BY audience_id, url, (time AT TIME ZONE 'UTC')::date, time;

-- New columns go last: CREATE OR REPLACE VIEW can only append.
CREATE OR REPLACE VIEW episode_overview AS
SELECT e.guid, e.title, e.episode_url, e.published_at,
  MAX(l.value) FILTER (WHERE l.platform='youtube' AND l.metric='views') AS youtube_views_latest,
  MAX(l.value) FILTER (WHERE l.platform='op3' AND l.metric='downloads') AS op3_downloads_latest,
  MAX(l.value) FILTER (WHERE l.platform='youtube' AND l.metric='likes') AS youtube_likes_latest,
  MAX(l.value) FILTER (WHERE l.platform='youtube' AND l.metric='comments') AS youtube_comments_latest,
  MAX(l.value) FILTER (WHERE l.platform='op3' AND l.metric='downloads_audio') AS op3_audio_downloads_latest,
  MAX(l.value) FILTER (WHERE l.platform='op3' AND l.metric='downloads_video') AS op3_video_downloads_latest
FROM episodes e LEFT JOIN latest_episode_metrics l ON l.guid=e.guid
GROUP BY e.guid;
