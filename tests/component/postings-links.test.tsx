// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ScoredPostingRow } from "@shared/insight";
import { PostingsCard, PostingsPanel } from "@/components/insight/PostingsCard";
import { DataTable } from "@/components/insight/charts/DataTable";

// The postings row TITLE now CLICKS THROUGH to the in-app posting detail (Apply moved into that detail,
// superseding the old title-as-external-link). A row carrying the natural key (source, externalId) renders a
// title BUTTON that opens the detail; an older snapshot row (no key) renders plain text - never a link, never
// a dead affordance. Both card + panel surfaces share the table body. The latest_postings DataTable is a
// DIFFERENT surface and keeps its own apply_url link-out (asserted below).

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
    source: "GoogleCareers",
    externalId: "1",
    ...over,
  };
}

function expectSafeLink(anchor: HTMLAnchorElement, href: string) {
  expect(anchor.getAttribute("href")).toBe(href);
  expect(anchor.getAttribute("target")).toBe("_blank");
  expect(anchor.getAttribute("rel")).toBe("noopener noreferrer");
}

describe("PostingsCard / PostingsPanel title click-through to detail", () => {
  test("a row WITH the natural key renders a title BUTTON that opens the detail (not a link)", () => {
    const onOpenPosting = vi.fn();
    render(
      <PostingsCard
        rows={[scored({ title: "Role A", source: "Lever", externalId: "abc" })]}
        total={1}
        onOpenPanel={() => {}}
        onOpenPosting={onOpenPosting}
      />,
    );
    // No external anchor - Apply lives in the detail now.
    expect(screen.queryByRole("link", { name: "Role A" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Role A" }));
    expect(onOpenPosting).toHaveBeenCalledWith("Lever", "abc");
  });

  test("a legacy apply_url on the row does NOT make the title a link (Apply moved to the detail)", () => {
    render(
      <PostingsCard
        rows={[scored({ title: "Role L", applyUrl: "https://careers.google.com/jobs/results/1" })]}
        total={1}
        onOpenPanel={() => {}}
        onOpenPosting={() => {}}
      />,
    );
    expect(screen.queryByRole("link", { name: "Role L" })).toBeNull();
    expect(screen.getByRole("button", { name: "Role L" })).toBeTruthy();
  });

  test("a row WITHOUT the natural key renders plain text - no button, no anchor (snapshot-compat)", () => {
    render(
      <PostingsCard
        rows={[scored({ title: "Role B", source: undefined, externalId: undefined })]}
        total={1}
        onOpenPanel={() => {}}
        onOpenPosting={() => {}}
      />,
    );
    expect(screen.getByText("Role B")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Role B" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Role B" })).toBeNull();
  });

  test("the panel list opens the detail the same way (both surfaces share the table body)", () => {
    const onOpenPosting = vi.fn();
    render(
      <PostingsPanel
        rows={[
          scored({ title: "Keyed", source: "Ashby", externalId: "x9" }),
          scored({ title: "Plain", source: undefined, externalId: undefined }),
        ]}
        total={2}
        onOpenPosting={onOpenPosting}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Keyed" }));
    expect(onOpenPosting).toHaveBeenCalledWith("Ashby", "x9");
    expect(screen.queryByRole("button", { name: "Plain" })).toBeNull();
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
