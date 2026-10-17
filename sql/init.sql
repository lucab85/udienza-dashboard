-- Runs only on the first initialization of the PostgreSQL volume.
CREATE DATABASE metabase;
\connect udienza
CREATE TABLE IF NOT EXISTS episodes (
  guid TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  episode_url TEXT,
  published_at TIMESTAMPTZ,
  audio_url TEXT,
  video_url TEXT,
  youtube_id VARCHAR(11),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS episode_metrics (
  guid TEXT NOT NULL REFERENCES episodes(guid) ON DELETE CASCADE,
  observed_on DATE NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('youtube','op3','apple','spotify','other')),
  metric TEXT NOT NULL,
  value BIGINT NOT NULL CHECK (value >= 0),
  measurement_type TEXT NOT NULL DEFAULT 'cumulative' CHECK (measurement_type IN ('cumulative','daily')),
  PRIMARY KEY (guid, observed_on, platform, metric)
);
CREATE TABLE IF NOT EXISTS sponsors (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS campaigns (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sponsor_id BIGINT NOT NULL REFERENCES sponsors(id),
  name TEXT NOT NULL,
  starts_on DATE,
  ends_on DATE,
  tracking_url TEXT,
  UNIQUE (sponsor_id, name)
);
CREATE TABLE IF NOT EXISTS campaign_episodes (
  campaign_id BIGINT NOT NULL REFERENCES campaigns(id),
  guid TEXT NOT NULL REFERENCES episodes(guid),
  PRIMARY KEY (campaign_id, guid)
);
CREATE TABLE IF NOT EXISTS campaign_metrics (
  campaign_id BIGINT NOT NULL REFERENCES campaigns(id),
  observed_on DATE NOT NULL,
  metric TEXT NOT NULL CHECK (metric IN ('clicks','conversions','impressions')),
  value BIGINT NOT NULL CHECK (value >= 0),
  PRIMARY KEY(campaign_id, observed_on, metric)
);
-- Cumulative snapshots are not additive across days.
CREATE OR REPLACE VIEW latest_episode_metrics AS
SELECT DISTINCT ON (guid, platform, metric)
  guid, platform, metric, value, observed_on
FROM episode_metrics
ORDER BY guid, platform, metric, observed_on DESC;

-- A dashboard-friendly rollup without double-counting cumulative YouTube views.
CREATE OR REPLACE VIEW episode_overview AS
SELECT e.guid, e.title, e.episode_url, e.published_at,
  MAX(l.value) FILTER (WHERE l.platform='youtube' AND l.metric='views') AS youtube_views_latest,
  MAX(l.value) FILTER (WHERE l.platform='op3' AND l.metric='downloads') AS op3_downloads_latest
FROM episodes e LEFT JOIN latest_episode_metrics l ON l.guid=e.guid
GROUP BY e.guid;
