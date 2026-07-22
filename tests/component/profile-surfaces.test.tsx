// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { UIMessage } from "ai";
import type { Profile } from "@shared/profile";
import { setAuthDialogOpen } from "@/lib/layers";

// The 029 profile surfaces driven through the REAL ChatClient (part rendering, invite wiring, LCP
// routing, save-injection) plus the leaf cards in isolation. External boundaries (transport + server
// actions + auth) are mocked exactly as the sibling ChatClient tests do.
const reconnectMock = vi.fn(async () => null);
const sendMessagesMock = vi.fn(async () => new ReadableStream({ start: (c) => c.close() }));
vi.mock("@/lib/chat-transport", () => ({
  useJobChatTransport: () => ({ sendMessages: sendMessagesMock, reconnectToStream: reconnectMock }),
}));
vi.mock("@/app/actions", () => ({
  sendMessage: vi.fn(),
  mintChatToken: vi.fn(),
  getMyProfile: vi.fn(async () => null),
  saveProfile: vi.fn(),
  deleteProfile: vi.fn(async () => ({ ok: true })),
  getProfileRunStatus: vi.fn(async () => ({ status: "pending" })),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/lib/auth-client", () => ({
  authClient: { signIn: { social: vi.fn() }, signOut: vi.fn(), useSession: () => ({ data: null, isPending: false }) },
}));

import { ChatClient } from "@/components/chat/ChatClient";
import { ProfileCard, ProfileExpanded } from "@/components/insight/ProfileCard";
import { PostingsCard } from "@/components/insight/PostingsCard";
import { InlinePromptCard } from "@/components/insight/InlinePromptCard";
import { LcpProfile } from "@/components/chat/LcpProfile";

const CONVERSATION_ID = "11111111-1111-4111-8111-111111111111";

const profile: Profile = {
  titles: ["Senior Backend Engineer"],
  seniority: "senior",
  skills: [
    { name: "ClickHouse", source: "github" },
    { name: "Go", source: "both" },
    { name: "Python", source: "resume" },
  ],
  locations: ["Berlin", "Munich"],
  remotePref: true,
  salaryMin: 120000,
  yearsExp: 8,
  domains: ["distributed systems"],
  ossHighlights: ["Merged PRs to trigger.dev", "ClickHouse migration CLI"],
  experience: [
    { title: "Senior Backend Engineer", company: "DataMesh", years: "2021-2026", bullets: ["A", "B", "C", "D", "E"] },
  ],
};

const postingsRows = Array.from({ length: 12 }, (_, i) => ({
  title: `Role ${i + 1}`,
  company: i < 9 ? "Google" : "Datadog",
  city: i % 2 === 0 ? "Munich" : null,
  remote: i % 3 === 0,
  salaryMin: i % 2 === 0 ? 95000 : null,
  salaryMax: i % 2 === 0 ? 140000 : null,
  experience: i % 2 === 0 ? "Senior" : "Mid",
  publishedAt: "2026-07-20",
  score: 1 - i * 0.01,
}));

function assistantPart(type: string, data: unknown): UIMessage {
  return { id: `m-${type}`, role: "assistant", parts: [{ type, id: `${type}-c0`, data } as UIMessage["parts"][number]] };
}

function renderChat(messages: UIMessage[], props: Record<string, unknown> = {}) {
  return render(
    <ChatClient conversationId={CONVERSATION_ID} initialMessages={messages} e2e={false} signedIn accountName="Ada" {...props} />,
  );
}

afterEach(() => {
  cleanup();
  setAuthDialogOpen(false);
});

// ---------------------------------------------------------------------------------------------------
// Leaf components
// ---------------------------------------------------------------------------------------------------
describe("InlinePromptCard", () => {
  test("renders the accent register anatomy + fires onAction", () => {
    const onAction = vi.fn();
    render(<InlinePromptCard text="Add your profile please" buttonLabel="Add your profile" onAction={onAction} />);
    expect(document.querySelector(".register-card")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add your profile" }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });
});

describe("ProfileCard (in-chat compact)", () => {
  test("renders identity, proven+claimed skills, legend, domains, one OSS line", () => {
    render(<ProfileCard profile={profile} />);
    expect(screen.getByText("Senior Backend Engineer")).toBeTruthy();
    // proven skills are accent tags (with ✓), the resume one a neutral pill
    expect(document.querySelectorAll(".tag").length).toBe(2);
    expect(document.querySelectorAll(".skill-claimed").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/proven in their GitHub code/)).toBeTruthy();
    expect(screen.getByText("distributed systems")).toBeTruthy();
    // ONE oss highlight in the compact card
    expect(screen.getByText("Merged PRs to trigger.dev")).toBeTruthy();
    expect(screen.queryByText("ClickHouse migration CLI")).toBeNull();
  });

  test("GitHub-skipped variant: all skills neutral + an informational add-GitHub note", () => {
    const skipped: Profile = { ...profile, skills: [{ name: "Python", source: "resume" }, { name: "Terraform", source: "resume" }] };
    const onEdit = vi.fn();
    render(<ProfileCard profile={skipped} onEdit={onEdit} />);
    expect(document.querySelectorAll(".tag").length).toBe(0); // nothing proven -> no accent tags
    expect(screen.getByText(/GitHub skipped/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add GitHub" }));
    expect(onEdit).toHaveBeenCalled();
  });

  test("foot chips fire onFollowup / onEdit / onOpenPanel", () => {
    const onFollowup = vi.fn();
    const onEdit = vi.fn();
    const onOpenPanel = vi.fn();
    render(<ProfileCard profile={profile} onFollowup={onFollowup} onEdit={onEdit} onOpenPanel={onOpenPanel} />);
    fireEvent.click(screen.getByRole("button", { name: "Find me a job that fits" }));
    expect(onFollowup).toHaveBeenCalledWith("Find me a job that fits");
    fireEvent.click(screen.getByRole("button", { name: "Edit profile" }));
    expect(onEdit).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open in panel →" }));
    expect(onOpenPanel).toHaveBeenCalled();
  });
});

describe("ProfileExpanded (LCP, read-only)", () => {
  test("renders every section with NO edit affordances and a per-role show-more", () => {
    render(<ProfileExpanded profile={profile} />);
    expect(screen.getByText("Skills — proven in code")).toBeTruthy();
    expect(screen.getByText("Experience — from the resume")).toBeTruthy();
    // read-only: no edit ✕ on tags, no "+ Add", no "Save changes" / "Delete profile"
    expect(document.querySelector(".tag button")).toBeNull();
    expect(screen.queryByRole("button", { name: /Add/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Save changes/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Delete/ })).toBeNull();
    // 5 bullets, only 3 shown until the per-role toggle
    expect(screen.getByText("· A")).toBeTruthy();
    expect(screen.queryByText("· D")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show 2 more ↓" }));
    expect(screen.getByText("· D")).toBeTruthy();
    // all OSS highlights in the expanded view
    expect(screen.getByText("· ClickHouse migration CLI")).toBeTruthy();
  });
});

describe("PostingsCard", () => {
  test("in-chat: verdict, 5-col table capped at 8, 'not listed', honesty caption, open-panel", () => {
    const onOpenPanel = vi.fn();
    render(<PostingsCard rows={postingsRows} total={23} onOpenPanel={onOpenPanel} />);
    expect(screen.getByText("23")).toBeTruthy(); // bolded total
    expect(screen.getByText(/showing the best 8/)).toBeTruthy();
    expect(document.querySelectorAll("tbody tr").length).toBe(8); // capped
    expect(screen.getAllByText("not listed").length).toBeGreaterThan(0);
    expect(screen.getByText(/Most matches are at Google/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open all 23 in panel" }));
    expect(onOpenPanel).toHaveBeenCalled();
  });

  test("no-matches variant: near-miss verdict + way-out chips", () => {
    const onEdit = vi.fn();
    render(<PostingsCard rows={[{ ...postingsRows[0], company: "Google", city: "Zurich" }]} total={0} onEdit={onEdit} />);
    expect(screen.getByText(/No strong matches yet/)).toBeTruthy();
    expect(screen.getByText(/Closest:/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Include one level up" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit profile" }));
    expect(onEdit).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------
// Part rendering + wiring through ChatClient
// ---------------------------------------------------------------------------------------------------
describe("part rendering (AC-1 render, AC-6)", () => {
  test("Should_RenderAuthInviteCard_When_PartPresent", () => {
    renderChat([assistantPart("data-auth-invite", { kind: "auth-invite" })], { signedIn: false });
    expect(document.querySelector(".register-card")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in with Google" })).toBeTruthy();
  });

  test("Should_RenderProfileCardOnceAfterReload_When_Persisted", () => {
    // A resumed thread with the persisted profile-card part renders exactly one card.
    renderChat([assistantPart("data-profile-card", { kind: "profile-card", profile })]);
    expect(screen.getAllByText("Senior Backend Engineer")).toHaveLength(1);
  });
});

describe("invite wiring (AC-2)", () => {
  test("Should_OpenLcpProfileForm_When_InviteClicked", async () => {
    renderChat([assistantPart("data-profile-invite", { kind: "profile-invite" })]);
    fireEvent.click(screen.getByRole("button", { name: "Add your profile" }));
    // the LCP profile form opens (empty state)
    expect(await screen.findByText("No profile yet")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Your profile" })).toBeTruthy();
  });
});

describe("LCP routing per new card", () => {
  test("profile card 'Open in panel' opens the read-only expanded profile", () => {
    renderChat([assistantPart("data-profile-card", { kind: "profile-card", profile })]);
    fireEvent.click(screen.getByRole("button", { name: "Open in panel →" }));
    expect(screen.getByRole("region", { name: "Profile" })).toBeTruthy();
    expect(screen.getByText("Experience — from the resume")).toBeTruthy();
  });

  test("postings 'Open all N in panel' opens the full list with filter chips", () => {
    renderChat([assistantPart("data-postings", { kind: "postings", rows: postingsRows, total: 23 })]);
    fireEvent.click(screen.getByRole("button", { name: "Open all 23 in panel" }));
    expect(screen.getByRole("region", { name: "Matching postings" })).toBeTruthy();
    // the LCP full list is uncapped (all 12 rows) with a filter group
    expect(document.querySelector(".lcp")?.querySelectorAll("tbody tr").length).toBe(12);
    expect(screen.getByRole("group", { name: "Filter postings" })).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------------------------------
// The form + save injection
// ---------------------------------------------------------------------------------------------------
describe("LcpProfile form", () => {
  test("Should_AppendProfileCardMessage_When_SaveCompletes (e2e build injects the card via onProfileSaved)", async () => {
    const onProfileSaved = vi.fn();
    render(
      <LcpProfile
        conversationId={CONVERSATION_ID}
        e2e
        onClose={vi.fn()}
        onProfileSaved={onProfileSaved}
        onProfileDeleted={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText(/GitHub username/), { target: { value: "mkoval" } });
    fireEvent.click(screen.getByRole("button", { name: "Build my profile" }));
    await waitFor(() => expect(onProfileSaved).toHaveBeenCalled());
    // saved summary shows the identity + counts, and Edit/Delete
    expect(await screen.findByText("Profile saved ✓")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit & re-save" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
  });

  test("delete from the saved state fires onProfileDeleted and returns to the empty form", async () => {
    const onProfileDeleted = vi.fn();
    render(
      <LcpProfile conversationId={CONVERSATION_ID} e2e onClose={vi.fn()} onProfileSaved={vi.fn()} onProfileDeleted={onProfileDeleted} />,
    );
    fireEvent.change(screen.getByLabelText(/GitHub username/), { target: { value: "mkoval" } });
    fireEvent.click(screen.getByRole("button", { name: "Build my profile" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(onProfileDeleted).toHaveBeenCalled());
    expect(screen.getByText("No profile yet")).toBeTruthy();
  });

  test("empty build with no inputs shows a validation message, never a save", () => {
    render(<LcpProfile conversationId={CONVERSATION_ID} e2e onClose={vi.fn()} onProfileSaved={vi.fn()} onProfileDeleted={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Build my profile" }));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/Add a resume or a GitHub username/);
  });
});

// exercised indirectly above; kept explicit so a regression in the wire is obvious
test("auth-invite card wires the auth dialog (guest)", async () => {
  renderChat([assistantPart("data-auth-invite", { kind: "auth-invite" })], { signedIn: false });
  fireEvent.click(screen.getByRole("button", { name: "Sign in with Google" }));
  await waitFor(() => expect(screen.getByRole("dialog", { name: "Create your free account" })).toBeTruthy());
  expect(within(document.body).getByRole("dialog")).toBeTruthy();
});
