import Link from "next/link";
import { LandingComposer } from "@/components/landing/LandingComposer";
import { LandingSignIn } from "@/components/landing/LandingSignIn";
import { GITHUB_URL, HACKATHON_URL, SEARCHNAPPLY_URL } from "@/lib/links";
import { isE2E } from "@/lib/e2e";

// Landing (mock 4b) - product in one shell-colored screen. The ask box + chips (LandingComposer) submit
// the first message and hand off to the chat with the stream already attached (AC-3). AC-19: credit
// links live here - the hackathon credit in the header, GitHub + searchnapply in the footer.
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
        <LandingSignIn />
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
        <LandingComposer e2e={isE2E()} />
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
