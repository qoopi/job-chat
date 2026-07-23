// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ScoredPostingRow } from "@shared/insight";
import { PostingsCard, PostingsPanel } from "@/components/insight/PostingsCard";
import { DataTable } from "@/components/insight/charts/DataTable";

// AC-1 link-outs: a postings row TITLE becomes a link when apply_url is present, opening in a new tab with
// the safe rel; an absent/empty apply_url renders EXACTLY as today (plain title, no anchor, no dead link).
// Two surfaces: the ScoredPostingRow card/panel and the latest_postings DataTable.

afterEach(cleanup);

function scored(over: Partial<ScoredPostingRow> = {}): ScoredPostingRow {
  return {
    title: "Senior Backend Engineer",
    company: "Google",
    city: "Berlin",
    remote: true,
    salaryMin: 160000,
    salaryMax: 200000,
    experience: "Senior",
    publishedAt: "2026-07-18",
    score: 12,
    ...over,
  };
}

function expectSafeLink(anchor: HTMLAnchorElement, href: string) {
  expect(anchor.getAttribute("href")).toBe(href);
  expect(anchor.getAttribute("target")).toBe("_blank");
  expect(anchor.getAttribute("rel")).toBe("noopener noreferrer");
}

describe("PostingsCard / PostingsPanel title link-out", () => {
  test("a row WITH apply_url renders the title as a safe new-tab link", () => {
    const url = "https://careers.google.com/jobs/results/1";
    render(<PostingsCard rows={[scored({ title: "Role A", applyUrl: url })]} total={1} onOpenPanel={() => {}} />);
    const anchor = screen.getByRole("link", { name: "Role A" }) as HTMLAnchorElement;
    expectSafeLink(anchor, url);
  });

  test("a row WITHOUT apply_url renders the title as plain text - no anchor (empty-url snapshot-compat)", () => {
    render(<PostingsCard rows={[scored({ title: "Role B" })]} total={1} onOpenPanel={() => {}} />);
    expect(screen.getByText("Role B")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Role B" })).toBeNull();
  });

  test("an empty-string apply_url is treated as absent (plain text, never a dead link)", () => {
    render(<PostingsCard rows={[scored({ title: "Role C", applyUrl: "" })]} total={1} onOpenPanel={() => {}} />);
    expect(screen.queryByRole("link", { name: "Role C" })).toBeNull();
  });

  test("the panel list links the same way (both surfaces share the table body)", () => {
    const url = "https://stripe.com/jobs/listing/9";
    render(
      <PostingsPanel
        rows={[scored({ title: "Linked", applyUrl: url }), scored({ title: "Plain" })]}
        total={2}
      />,
    );
    expectSafeLink(screen.getByRole("link", { name: "Linked" }) as HTMLAnchorElement, url);
    expect(screen.queryByRole("link", { name: "Plain" })).toBeNull();
  });
});

describe("DataTable latest_postings link-out (apply_url column)", () => {
  const row = (title: string, apply_url: string) => ({
    title,
    company: "Google",
    city: "San Francisco",
    experience_level: "Senior",
    salary_min: 150000,
    salary_max: 190000,
    salary_currency: "USD",
    published_at: "2026-07-18 10:00:00",
    apply_url,
  });

  test("links the title when apply_url is present and never renders apply_url as its own column", () => {
    const url = "https://www.google.com/about/careers/applications/jobs/results/1";
    const { container } = render(<DataTable rows={[row("Senior Software Engineer", url)]} />);
    expectSafeLink(
      screen.getByRole("link", { name: "Senior Software Engineer" }) as HTMLAnchorElement,
      url,
    );
    // apply_url is not surfaced as a header or a raw-URL cell.
    const headers = Array.from(container.querySelectorAll("th")).map((th) => th.textContent);
    expect(headers.some((h) => /apply/i.test(h ?? ""))).toBe(false);
    expect(within(container).queryByText(url)).toBeNull();
  });

  test("an empty apply_url row shows the plain title, no anchor (and still no apply_url column)", () => {
    const { container } = render(<DataTable rows={[row("Recruiter", "")]} />);
    expect(screen.queryByRole("link", { name: "Recruiter" })).toBeNull();
    expect(screen.getByText("Recruiter")).toBeTruthy();
    const headers = Array.from(container.querySelectorAll("th")).map((th) => th.textContent);
    expect(headers.some((h) => /apply/i.test(h ?? ""))).toBe(false);
  });

  test("a table WITHOUT any apply_url key is untouched (other insights render every column, no links)", () => {
    const { container } = render(<DataTable rows={[{ company: "Google", count: 4 }]} />);
    expect(container.querySelectorAll("a").length).toBe(0);
    const headers = Array.from(container.querySelectorAll("th")).map((th) => th.textContent);
    expect(headers).toEqual(["Company", "Count"]);
  });
});
