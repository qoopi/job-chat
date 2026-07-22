import Link from "next/link";
import { LandingComposer } from "@/components/landing/LandingComposer";
import { LandingSignIn } from "@/components/landing/LandingSignIn";
import { GITHUB_URL, HACKATHON_URL, SEARCHNAPPLY_URL } from "@/lib/links";
import { isE2E } from "@/lib/e2e";
import { listOwnerConversations, resolveViewer } from "@/lib/server-store";

// Landing (mock 4b) - product in one shell-colored screen. The ask box + chips (LandingComposer) submit
// the first message and hand off to the chat with the stream already attached. Credit
// links live here: the hackathon credit in the header, GitHub + searchnapply in the footer.
// The header is session-aware - the session is read server-side (resolveViewer) and seeds
// LandingSignIn (signed-in shows "Open your chats" -> the most recent conversation + the account chip/menu;
// guest shows Sign in), and a signed-in visitor gets a "Welcome back" sub-line. Skipped under E2E (no
// Postgres/auth session there), where the landing is always the guest surface.
export default async function Landing() {
  const e2e = isE2E();
  const viewer = e2e ? null : await resolveViewer();
  // "Open your chats" targets the most recent conversation (else a fresh shell), and the last title feeds
  // the welcome sub-line. One list read, signed-in only.
  const recent = viewer?.accountUserId
    ? (await listOwnerConversations(viewer.accountUserId))[0]
    : undefined;
  const openChatsHref = recent ? `/chat/${recent.id}` : "/chat/new";
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
            built for the{" "}
            <span style={{ color: "var(--clickhouse)", fontWeight: 600 }}>
              ClickHouse
            </span>{" "}
            &times;{" "}
            <span style={{ color: "var(--triggerdev)", fontWeight: 600 }}>
              Trigger.dev
            </span>{" "}
            hackathon
          </a>
        </div>
        <LandingSignIn
          signedIn={viewer?.signedIn ?? false}
          accountName={viewer?.accountName ?? undefined}
          accountEmail={viewer?.accountEmail ?? undefined}
          openChatsHref={openChatsHref}
        />
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
        <p
          style={{
            margin: 0,
            fontSize: 16,
            color: "var(--shell-fg-dim)",
            maxWidth: 520,
          }}
        >
          Ask a question, get a verdict with a chart — from 3,483 live postings.
          Add your resume and it finds the roles that fit you.
        </p>
        {viewer?.signedIn && recent ? (
          <p
            style={{
              margin: "-6px 0 0",
              fontSize: 14,
              color: "var(--shell-fg)",
            }}
          >
            Welcome back
            {viewer.accountName
              ? `, ${viewer.accountName.split(/\s+/)[0]}`
              : ""}{" "}
            — continue{" "}
            <Link
              href={`/chat/${recent.id}`}
              style={{ color: "var(--accent-ink)", fontWeight: 600 }}
            >
              “{recent.title}”
            </Link>{" "}
            or ask something new.
          </p>
        ) : null}
        <LandingComposer e2e={e2e} />
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
        <Link
          href={GITHUB_URL}
          target="_blank"
          rel="noreferrer"
          style={{ color: "var(--shell-fg)" }}
        >
          GitHub
        </Link>
        <span>·</span>
        <span>
          Data by{" "}
          <a
            href={SEARCHNAPPLY_URL}
            target="_blank"
            rel="noreferrer"
            style={{ color: "var(--shell-fg)" }}
          >
            searchnapply.com
          </a>
        </span>
      </footer>
    </div>
  );
}
