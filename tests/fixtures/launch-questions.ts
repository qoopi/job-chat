// The expected-values case table: the 7 launch questions mapped to the analytics tool, the
// designated visual (Q5 pinned to donut), and the expected verdict value/label computed by hand from
// the fixture (tests/fixtures/postings.fixture.ts). Consumed by the agent tests, which assert
// the agent picks this tool + chartType and lands this verdict number.
// `chartType` is the design visual: "bars" covers both sorted (Q4) and grouped (Q2) bars.

export interface LaunchQuestionCase {
  id: string;
  question: string;
  tool: string;
  params: Record<string, unknown>;
  chartType: "histogram" | "bars" | "trend" | "donut" | "table";
  expectedVerdict: number; // the headline number the verdict sentence must contain
  expectedLabel?: string; // the headline label (dominant category / winning city / latest title)
}

export const LAUNCH_QUESTIONS: LaunchQuestionCase[] = [
  {
    id: "Q1",
    question: "What is the median salary for engineers in San Francisco?",
    tool: "salary_distribution",
    params: { role: "Engineer", city: "San Francisco" },
    chartType: "histogram",
    expectedVerdict: 180000, // median of SF engineer salaries [170k, 180k, 200k]
  },
  {
    id: "Q2",
    question: "Do engineers get paid more in San Francisco or Los Angeles?",
    tool: "salary_compare",
    params: { role: "Engineer", cities: ["San Francisco", "Los Angeles"] },
    chartType: "bars",
    expectedVerdict: 180000, // SF median 180k beats LA median 140k
    expectedLabel: "San Francisco",
  },
  {
    id: "Q3",
    question: "How many new jobs opened this week?",
    tool: "postings_trend",
    params: { days: 7 },
    chartType: "trend",
    expectedVerdict: 10, // all 10 fixture postings fall in the 7-day window before the freshest
  },
  {
    id: "Q4",
    question: "Which companies are hiring the most right now?",
    tool: "top_companies",
    params: {},
    chartType: "bars",
    expectedVerdict: 4, // Google has 4 postings
    expectedLabel: "Google",
  },
  {
    id: "Q5",
    question: "What is the experience-level mix?",
    tool: "share_split",
    params: { dimension: "experience" },
    chartType: "donut",
    expectedVerdict: 5, // Senior is the largest level at 5 of 10
    expectedLabel: "Senior",
  },
  {
    id: "Q6",
    question: "What is the remote vs onsite vs hybrid split?",
    tool: "share_split",
    params: { dimension: "location_kind" },
    chartType: "donut",
    expectedVerdict: 4, // onsite is the largest kind at 4 of 10
    expectedLabel: "onsite",
  },
  {
    id: "Q7",
    question: "Latest senior roles at Google",
    tool: "latest_postings",
    params: { company: "Google", level: "Senior" },
    chartType: "table",
    expectedVerdict: 3, // 3 Google senior roles match
    expectedLabel: "Senior Software Engineer", // the most recently published of them
  },
];
