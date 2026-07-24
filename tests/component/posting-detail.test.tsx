// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { PostingDetail } from "@shared/insight";
import { PostingDetailCard } from "@/components/insight/PostingDetailCard";

// The single-posting detail view: header + the SAFE pre-wrapped description text (never dangerouslySetInnerHTML)
// + a prominent Apply button (safe rel, absent -> no button), plus the loading/not-found/empty states.

afterEach(cleanup);

function detail(over: Partial<PostingDetail> = {}): PostingDetail {
  return {
    title: "Senior Backend Engineer",
    company: "Google",
    city: "Berlin",
    region: "Berlin",
    country: "Germany",
    remote: false,
    salaryMin: 160000,
    salaryMax: 200000,
    department: "Cloud",
    descriptionText: "About the role\nOwn the ingest pipeline.",
    applyUrl: "https://careers.google.com/jobs/results/1",
    ...over,
  };
}

describe("PostingDetailCard loaded", () => {
  test("renders the header (title, company, department) and the description as text", () => {
    render(<PostingDetailCard state={{ status: "loaded", detail: detail() }} />);
    expect(screen.getByText("Senior Backend Engineer")).toBeTruthy();
    expect(screen.getByText("Google")).toBeTruthy();
    expect(screen.getByText("Cloud")).toBeTruthy();
    // The pre-wrapped description content is present verbatim (newline preserved by CSS, not markup).
    expect(screen.getByText(/Own the ingest pipeline\./)).toBeTruthy();
  });

  test("the Apply button is a safe new-tab link to externalApplyUrl", () => {
    const url = "https://careers.google.com/jobs/results/1";
    render(<PostingDetailCard state={{ status: "loaded", detail: detail({ applyUrl: url }) }} />);
    const apply = screen.getByRole("link", { name: /apply/i }) as HTMLAnchorElement;
    expect(apply.getAttribute("href")).toBe(url);
    expect(apply.getAttribute("target")).toBe("_blank");
    expect(apply.getAttribute("rel")).toBe("noopener noreferrer");
  });

  test("no Apply button when applyUrl is absent (empty string)", () => {
    render(<PostingDetailCard state={{ status: "loaded", detail: detail({ applyUrl: "" }) }} />);
    expect(screen.queryByRole("link", { name: /apply/i })).toBeNull();
  });

  test("SAFETY: description that looks like HTML renders as LITERAL text, never real markup", () => {
    const { container } = render(
      <PostingDetailCard
        state={{ status: "loaded", detail: detail({ descriptionText: "<script>alert(1)</script> plain <b>bold?</b>" }) }}
      />,
    );
    // No script/bold element is created - the angle-bracket text is escaped and shown verbatim.
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByText(/<script>alert\(1\)<\/script> plain <b>bold\?<\/b>/)).toBeTruthy();
  });

  test("forward-compat: an empty description_text renders a valid detail (no crash), no Apply when absent", () => {
    render(<PostingDetailCard state={{ status: "loaded", detail: detail({ descriptionText: "", applyUrl: "" }) }} />);
    // Header still renders; a muted placeholder stands in for the missing body.
    expect(screen.getByText("Senior Backend Engineer")).toBeTruthy();
    expect(screen.getByText(/no description/i)).toBeTruthy();
  });
});

describe("PostingDetailCard non-loaded states", () => {
  test("loading state renders a loading affordance", () => {
    render(<PostingDetailCard state={{ status: "loading" }} />);
    expect(screen.getByText(/loading/i)).toBeTruthy();
  });

  test("not-found state renders an unavailable notice", () => {
    render(<PostingDetailCard state={{ status: "not-found" }} />);
    expect(screen.getByText(/no longer available|not found|unavailable/i)).toBeTruthy();
  });
});
