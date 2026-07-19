import Link from "next/link";
import { SendIcon } from "@/components/icons";
import { GITHUB_URL, HACKATHON_URL, SEARCHNAPPLY_URL } from "@/lib/links";

// Landing (mock 4b) - product in one shell-colored screen. The form and chips submit the first message
// and hand off to the chat (006 wires the handoff; inert here). AC-19: credit links live here - the
// hackathon credit in the header, GitHub + searchnapply in the footer.
const CHIPS = [
  "Find me a job that fits",
  "Median salary for a Data Engineer in SF",
  "Top companies hiring right now",
];

export default function Landing() {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--shell-bg)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* header: wordmark + hackathon credit (partner colors) + inert Sign in */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "24px 40px",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
          <div className="sb-brand" style={{ padding: 0 }}>
            jobchat.dev
          </div>
          <a
            href={HACKATHON_URL}
            target="_blank"
            rel="noreferrer"
            style={{ fontSize: "var(--fs-xs)", color: "var(--shell-fg-dim)" }}
          >
            built for the <span style={{ color: "var(--clickhouse)", fontWeight: 600 }}>ClickHouse</span>{" "}
            &times; <span style={{ color: "var(--triggerdev)", fontWeight: 600 }}>Trigger.dev</span> hackathon
          </a>
        </div>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <button className="btn btn-shell btn-sm" type="button" disabled title="Coming soon">
            Sign in
          </button>
          <span style={{ fontSize: "var(--fs-2xs)", color: "var(--shell-fg-dim)" }}>soon</span>
        </span>
      </header>

      {/* hero */}
      <main
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 22,
          padding: 24,
          textAlign: "center",
        }}
      >
        <h1
          style={{
            margin: 0,
            fontSize: 44,
            fontWeight: 600,
            letterSpacing: "-0.02em",
            color: "var(--shell-strong)",
            lineHeight: 1.15,
          }}
        >
          The jobs market, answered.
        </h1>
        <p style={{ margin: 0, fontSize: 16, color: "var(--shell-fg-dim)", maxWidth: 520 }}>
          Ask a question, get a verdict with a chart — from 3,483 live postings. Add your resume
          and it finds the roles that fit you.
        </p>
        <div style={{ width: "100%", maxWidth: 560, marginTop: 10 }}>
          <div className="input-bar focused" style={{ padding: "12px 12px 12px 18px" }}>
            <textarea rows={1} aria-label="What are you looking for" placeholder="What are you looking for?" />
            <button className="send" type="button" aria-label="Send" style={{ width: 38, height: 38 }}>
              <SendIcon size={16} />
            </button>
          </div>
        </div>
        <div
          style={{
            display: "flex",
            gap: 10,
            flexWrap: "wrap",
            justifyContent: "center",
            maxWidth: 640,
          }}
        >
          {CHIPS.map((c) => (
            <button
              key={c}
              className="chip"
              type="button"
              style={{ background: "transparent", borderColor: "var(--shell-border)", color: "var(--shell-fg)" }}
            >
              {c}
            </button>
          ))}
        </div>
      </main>

      {/* footer credits: GitHub + searchnapply */}
      <footer
        style={{
          display: "flex",
          justifyContent: "center",
          gap: 8,
          padding: "20px 40px",
          fontSize: "var(--fs-xs)",
          color: "var(--shell-fg-dim)",
        }}
      >
        <Link href={GITHUB_URL} target="_blank" rel="noreferrer" style={{ color: "var(--shell-fg)" }}>
          GitHub
        </Link>
        <span>·</span>
        <span>
          Data by{" "}
          <a href={SEARCHNAPPLY_URL} target="_blank" rel="noreferrer" style={{ color: "var(--shell-fg)" }}>
            searchnapply.com
          </a>
        </span>
      </footer>
    </div>
  );
}
