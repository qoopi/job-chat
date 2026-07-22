import type { DataInsight } from "@shared/insight";
import type { ErrorKind, RefusalReason } from "@/lib/insight-format";

// A fixture conversation for the static port. Every insight is shaped exactly like the analytics
// catalog output (shared/analytics.ts SELECT columns) so the live path swaps the data source, not the components.
// One card per chart primitive + a plain answer + an error card exercise the surface for the
// chart-smoke test.

export type ThreadItem =
  | { role: "user"; text: string; time?: string }
  | { role: "ai"; text: string; time?: string }
  | { role: "ai"; insight: DataInsight; used?: string[]; time?: string }
  | { role: "ai"; error: ErrorKind; time?: string }
  | { role: "ai"; refusal: RefusalReason; time?: string };

export interface FixtureConversation {
  title: string;
  items: ThreadItem[];
}

const FRESH = "2026-07-18 19:12:00";

const histogram: DataInsight = {
  id: "fx-histogram",
  kind: "chart",
  chartType: "histogram",
  verdict: "Median posted salary for Data Engineers in San Francisco is $182k — 31% above LA.",
  series: [
    { bucket: 100000, count: 6, median: 182000 },
    { bucket: 120000, count: 12, median: 182000 },
    { bucket: 140000, count: 26, median: 182000 },
    { bucket: 160000, count: 44, median: 182000 },
    { bucket: 180000, count: 58, median: 182000 },
    { bucket: 200000, count: 52, median: 182000 },
    { bucket: 220000, count: 38, median: 182000 },
    { bucket: 240000, count: 22, median: 182000 },
    { bucket: 260000, count: 12, median: 182000 },
    { bucket: 280000, count: 6, median: 182000 },
  ],
  followups: ["Compare with LA", "Trend this year", "Senior roles only"],
  meta: {
    sql: `WITH salaried AS (
  SELECT (salary_min + salary_max) / 2 AS salary
  FROM postings FINAL
  WHERE salary_min IS NOT NULL AND salary_max IS NOT NULL
    AND title ILIKE '%data engineer%' AND city = 'San Francisco'
)
SELECT
  floor(salary / 20000) * 20000 AS bucket,
  count() AS count,
  round((SELECT quantileExact(0.5)(salary) FROM salaried)) AS median
FROM salaried
GROUP BY bucket
ORDER BY bucket
LIMIT 500`,
    sampleN: 412,
    updatedAt: FRESH,
  },
};

const bars: DataInsight = {
  id: "fx-bars",
  kind: "chart",
  chartType: "bars",
  verdict: "Amazon leads hiring with 214 open roles — 2× the next company.",
  series: [
    { company: "Amazon", count: 214 },
    { company: "Databricks", count: 121 },
    { company: "Google", count: 107 },
    { company: "Stripe", count: 96 },
    { company: "Airbnb", count: 84 },
    { company: "Datadog", count: 71 },
  ],
  followups: ["Only remote roles", "Amazon's open roles"],
  meta: {
    sql: `SELECT
  company,
  count() AS count
FROM postings FINAL
WHERE published_at > (SELECT max(published_at) FROM postings FINAL) - INTERVAL 30 DAY
GROUP BY company
ORDER BY count DESC, company ASC
LIMIT 10`,
    sampleN: 3483,
    updatedAt: FRESH,
  },
};

const trend: DataInsight = {
  id: "fx-trend",
  kind: "chart",
  chartType: "trend",
  verdict: "1,204 new postings this week — the strongest week since April.",
  series: [
    { day: "Apr 06", count: 540 },
    { day: "Apr 20", count: 612 },
    { day: "May 04", count: 588 },
    { day: "May 18", count: 704 },
    { day: "Jun 01", count: 760 },
    { day: "Jun 15", count: 812 },
    { day: "Jun 29", count: 905 },
    { day: "Jul 06", count: 980 },
    { day: "Jul 13", count: 1088 },
    { day: "Jul 18", count: 1204 },
  ],
  followups: ["Which roles grew most?", "By city"],
  meta: {
    sql: `SELECT
  toDate(published_at) AS day,
  count() AS count
FROM postings FINAL
WHERE published_at > (SELECT max(published_at) FROM postings FINAL) - INTERVAL 90 DAY
GROUP BY day
ORDER BY day
LIMIT 400`,
    sampleN: 3483,
    updatedAt: FRESH,
  },
};

const donut: DataInsight = {
  id: "fx-donut",
  kind: "chart",
  chartType: "donut",
  verdict: "46% of open roles are remote — onsite is down to 22%.",
  series: [
    { label: "remote", count: 1602 },
    { label: "hybrid", count: 1115 },
    { label: "onsite", count: 766 },
  ],
  followups: ["Remote share by seniority", "Trend since January"],
  meta: {
    sql: `SELECT
  toString(location_kind) AS label,
  count() AS count
FROM postings FINAL
GROUP BY label
ORDER BY count DESC, label ASC
LIMIT 20`,
    sampleN: 3483,
    updatedAt: FRESH,
  },
};

const table: DataInsight = {
  id: "fx-table",
  kind: "table",
  verdict: "14 recent senior roles; the latest is a Staff Analytics Engineer at Airbnb.",
  rows: [
    { title: "Staff Analytics Engineer", company: "Airbnb", city: "Remote (US)", experience_level: "staff", salary_min: 205000, salary_max: 240000, published_at: "2026-07-15" },
    { title: "Senior Data Engineer", company: "Stripe", city: "San Francisco", experience_level: "senior", salary_min: 190000, salary_max: 220000, published_at: "2026-07-16" },
    { title: "Data Platform Engineer", company: "Databricks", city: "San Francisco", experience_level: "senior", salary_min: 185000, salary_max: 225000, published_at: "2026-07-11" },
    { title: "Senior BI Engineer", company: "Netflix", city: "Remote (US)", experience_level: "senior", salary_min: 180000, salary_max: 215000, published_at: "2026-07-12" },
    { title: "Data Infrastructure Engineer", company: "Datadog", city: "New York", experience_level: "senior", salary_min: 175000, salary_max: 200000, published_at: "2026-07-13" },
  ],
  followups: ["What is the typical salary for these?", "Who else is hiring right now?"],
  meta: {
    sql: `SELECT
  title, company, city, experience_level,
  salary_min, salary_max, salary_currency,
  toString(published_at) AS published_at
FROM postings FINAL
WHERE experience_level = 'senior'
ORDER BY published_at DESC, external_id DESC
LIMIT 20`,
    sampleN: 14,
    updatedAt: FRESH,
  },
};

export const FIXTURE_CONVERSATION: FixtureConversation = {
  title: "Data Engineer pay in SF",
  items: [
    { role: "user", text: "Median salary for a Data Engineer in San Francisco", time: "10:42" },
    { role: "ai", insight: histogram, used: ["Compare with LA"], time: "10:42" },
    { role: "user", text: "Top companies hiring right now", time: "10:44" },
    { role: "ai", insight: bars, time: "10:44" },
    { role: "user", text: "What is new on the market this week?", time: "10:46" },
    { role: "ai", insight: trend, time: "10:46" },
    { role: "user", text: "Remote vs onsite vs hybrid", time: "10:47" },
    { role: "ai", insight: donut, time: "10:47" },
    { role: "user", text: "Show me the latest senior roles", time: "10:49" },
    { role: "ai", insight: table, time: "10:49" },
    { role: "user", text: "Is it a good time to switch jobs?", time: "10:51" },
    {
      role: "ai",
      text: "Postings are up 12% this quarter and senior roles close fastest. If you have 5+ years of data experience, yes.",
      time: "10:51",
    },
    { role: "user", text: "asd… qwsdf zxcv", time: "10:52" },
    { role: "ai", error: "unanswerable", time: "10:52" },
  ],
};
