-- searchnapply job postings, deduped by the natural key (source, external_id).
-- ReplacingMergeTree(ingested_at): re-pulls overwrite; the freshest ingest wins.
-- location_kind mapping pinned from a full-corpus probe (2026-07-18): searchnapply
-- locations[].kind in {0->onsite, 1->remote, 2->hybrid}; the Enum values equal the source ints.
CREATE TABLE IF NOT EXISTS postings
(
    source            LowCardinality(String),
    external_id       String,
    title             String,
    company           LowCardinality(String),
    city              Nullable(String),
    region            Nullable(String),
    country           Nullable(String),
    location_kind     Enum8('onsite' = 0, 'remote' = 1, 'hybrid' = 2),
    employment_type   LowCardinality(String),
    experience_level  LowCardinality(String),
    salary_min        Nullable(Float64),
    salary_max        Nullable(Float64),
    salary_currency   Nullable(String),
    published_at      DateTime('UTC'),
    ingested_at       DateTime('UTC') DEFAULT now()
)
ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (source, external_id)
COMMENT 'searchnapply job postings; dedupe key (source, external_id), version ingested_at';
