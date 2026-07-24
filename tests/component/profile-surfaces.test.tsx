// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { UIMessage } from "ai";
import type { Profile } from "@shared/profile";
import { setAuthDialogOpen } from "@/lib/layers";
import { closeAuthDialog } from "@/lib/auth-dialog";

// The 029 profile surfaces driven through the REAL ChatClient (part rendering, invite wiring, detail panel
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
  updateProfilePrefs: vi.fn(),
  updateProfileSkills: vi.fn(),
}));
// `push` is a shared, captured mock so the F3 abandon tests can assert a stale send never navigates to a spurious new conversation (the fresh-chat send branch calls router.push).
const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock, replace: vi.fn() }) }));
vi.mock("@/lib/auth-client", () => ({
  authClient: { signIn: { social: vi.fn() }, signOut: vi.fn(), useSession: () => ({ data: null, isPending: false }) },
}));
// The poll's own contract (attempt ceiling, the re-save edge) is exhaustively unit-tested in
// profile-poll.test.ts; here it is mocked so ProfilePanel's ERROR-STATE RENDERING (which copy, gated on
// whether a prior profile existed) is tested in isolation from the poll's real timers.
vi.mock("@/lib/profile-poll", () => ({ pollProfileSave: vi.fn() }));

import { ChatClient } from "@/components/chat/ChatClient";
import { ProfileCard, ProfileExpanded } from "@/components/insight/ProfileCard";
import { PostingsCard } from "@/components/insight/PostingsCard";
import { InlinePromptCard } from "@/components/insight/InlinePromptCard";
import { ProfilePanel } from "@/components/chat/ProfilePanel";
import {
  deleteProfile,
  getMyProfile,
  saveProfile,
  updateProfilePrefs,
  updateProfileSkills,
  type MyProfile,
} from "@/app/actions";
import { pollProfileSave } from "@/lib/profile-poll";
import { profileCardMessageId } from "@/lib/profile-card-id";

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
  canonicalRoles: [],
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

// The saved-profile getMyProfile fixture (a prior profile exists) and the fresh-first-save-failure one
// (no profile row's extraction ever completed) - used by the error-state and card-on-delete cases below.
const savedMyProfile: MyProfile = {
  profile,
  githubUsername: "octocat",
  extractedAt: "2026-07-22T09:00:00Z",
  extractionFailed: false,
};
const freshFailureMyProfile: MyProfile = {
  profile: null,
  githubUsername: null,
  extractedAt: null,
  extractionFailed: true,
};

afterEach(() => {
  cleanup();
  setAuthDialogOpen(false);
  closeAuthDialog(); // the auth-dialog store is a module singleton - reset it too, else an opened-dialog test leaks `dialogOpen` into later tests (a stuck AuthDialog makes ChatClient's Esc handler yield)
  sessionStorage.clear(); // the pending-invite tests below stash a real sessionStorage key
  // These action mocks are SHARED module-level vi.fn()s; `mockResolvedValueOnce` queues values that
  // outlive a test if the component under test never consumed them (e.g. a test that never opens the
  // detail panel form leaves its queued `getMyProfile` value to bleed into the NEXT test's first call). Reset the
  // call history + queues and restore each factory's original default so every test starts clean.
  vi.mocked(getMyProfile).mockReset().mockResolvedValue(null);
  vi.mocked(saveProfile).mockReset();
  vi.mocked(deleteProfile).mockReset().mockResolvedValue({ ok: true });
  vi.mocked(updateProfilePrefs).mockReset();
  vi.mocked(updateProfileSkills).mockReset();
  vi.mocked(pollProfileSave).mockReset();
  pushMock.mockClear();
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
    // Source-honest copy (ruled deviation from the mock): true under BOTH causes of this state - a
    // GitHub read failure AND a read that proved nothing - never asserts a read failure that may not
    // have happened.
    expect(screen.getByText(/couldn.t verify skills from GitHub/)).toBeTruthy();
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

describe("ProfileExpanded (detail panel, read-only)", () => {
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

  // 039: skills split by source - github/both are "proven in code" accent tags, resume-only is a claimed chip.
  test("splits skills by source into proven-in-code vs from-the-resume", () => {
    render(<ProfileExpanded profile={profile} />);
    const provenSection = screen.getByText("Skills — proven in code").parentElement as HTMLElement;
    expect(within(provenSection).getByText("ClickHouse")).toBeTruthy(); // source github
    expect(within(provenSection).getByText("Go")).toBeTruthy(); // source both
    expect(within(provenSection).queryByText("Python")).toBeNull();
    const claimedSection = screen.getByText("Skills — from the resume").parentElement as HTMLElement;
    expect(within(claimedSection).getByText("Python")).toBeTruthy(); // source resume
  });

  // 039: the experience list collapses after 2 roles behind a "Show N more".
  test("experience list shows the first 2 roles, the rest behind a Show-N-more collapse", () => {
    const threeRoles: Profile = {
      ...profile,
      experience: [
        { title: "Role One", company: "A", years: "2024-2026", bullets: ["x"] },
        { title: "Role Two", company: "B", years: "2022-2024", bullets: ["y"] },
        { title: "Role Three", company: "C", years: "2020-2022", bullets: ["z"] },
      ],
    };
    render(<ProfileExpanded profile={threeRoles} />);
    expect(screen.getByText("Role One")).toBeTruthy();
    expect(screen.getByText("Role Two")).toBeTruthy();
    expect(screen.queryByText("Role Three")).toBeNull(); // hidden behind the collapse
    fireEvent.click(screen.getByRole("button", { name: "Show 1 more role ↓" }));
    expect(screen.getByText("Role Three")).toBeTruthy();
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
    fireEvent.click(screen.getByRole("button", { name: "Open top 12 of 23 in panel" }));
    expect(onOpenPanel).toHaveBeenCalled();
  });

  // A 0-result search renders a COMPACT notice - an honest sentence plus the two way-out chips - never the
  // hollow chart-card frame (no table, no chart shell, no "0" headline). The two chips do something real:
  // "Include one level up" (band relaxation) and "Edit profile"; "Broaden location" was a no-op and is gone.
  test("no-matches variant: compact notice with an honest sentence + the two REAL way-out chips", () => {
    const onEdit = vi.fn();
    const { container } = render(<PostingsCard rows={[]} total={0} onEdit={onEdit} onFollowup={vi.fn()} />);
    expect(screen.getByText(/No strong matches/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Include one level up" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Broaden location" })).toBeNull();
    // no hollow chart-card frame, no table, no bold "0" headline
    expect(container.querySelector(".insight")).toBeNull();
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelector(".postings-empty")).not.toBeNull();
    expect(screen.queryByText("0")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit profile" }));
    expect(onEdit).toHaveBeenCalled();
  });

  // The 029-inherited rows-cap-50 contract (030's emitter obligation): total<=50 means the `rows` array
  // IS the complete matched set, so "Open all {total}" is literal; total>50 means the emitter carried
  // only the top-50 rows, so the chip must NOT claim "all" - it must read "Open top 50 of {total}".
  test("boundary: total=50 (rows genuinely complete) keeps the literal 'Open all N' copy", () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ ...postingsRows[0], title: `Role ${i}` }));
    render(<PostingsCard rows={rows} total={50} onOpenPanel={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Open all 50 in panel" })).toBeTruthy();
  });

  test("boundary: total=51 (rows capped at 50) adapts the chip copy - never overclaims 'all'", () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ ...postingsRows[0], title: `Role ${i}` }));
    render(<PostingsCard rows={rows} total={51} onOpenPanel={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Open top 50 of 51 in panel" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open all 51 in panel" })).toBeNull();
  });

  // Item 1 (register 19/20): the "Only remote" / "Only with salary" chips are CLIENT-SIDE toggles over
  // the delivered rows - they NEVER send a chat turn (the old behavior re-derived search params and
  // returned MORE rows). Counts are honest to the delivered set; composable (AND); toggling off restores.
  // postingsRows: 12 rows, remote at i%3==0 (=4), salary listed at i%2==0 (=6), remote&salary at i∈{0,6} (=2).
  test("chip toggles filter the delivered rows locally and NEVER send a chat turn (honest counts)", () => {
    const onFollowup = vi.fn();
    render(<PostingsCard rows={postingsRows} total={23} onFollowup={onFollowup} onOpenPanel={vi.fn()} />);
    // Chip labels carry the honest live count of matching delivered rows.
    const remoteChip = screen.getByRole("button", { name: /Only remote · 4/ });
    const salaryChip = screen.getByRole("button", { name: /Only with salary · 6/ });
    // Baseline: full delivered set, 8 shown of the 23 server total.
    expect(document.querySelectorAll("tbody tr").length).toBe(8);
    expect(screen.getByText("8 of 23 matches")).toBeTruthy();

    // Toggle remote: 4 remote rows, all shown; aria-pressed; footer honest to the delivered subset.
    fireEvent.click(remoteChip);
    expect(remoteChip.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelectorAll("tbody tr").length).toBe(4);
    expect(screen.getByText("4 of 4 shown")).toBeTruthy();
    // Composable (AND) with salary: remote AND salary-listed = 2 rows.
    fireEvent.click(salaryChip);
    expect(document.querySelectorAll("tbody tr").length).toBe(2);
    expect(screen.getByText("2 of 2 shown")).toBeTruthy();

    // Toggling both off restores the full delivered set + the server-total footer.
    fireEvent.click(remoteChip);
    fireEvent.click(salaryChip);
    expect(document.querySelectorAll("tbody tr").length).toBe(8);
    expect(screen.getByText("8 of 23 matches")).toBeTruthy();

    // Never a chat turn - the whole point of the fix.
    expect(onFollowup).not.toHaveBeenCalled();
  });

  test("empty-filter-result: a filter that matches nothing shows a message, not an empty table", () => {
    const noRemote = postingsRows.map((r) => ({ ...r, remote: false }));
    render(<PostingsCard rows={noRemote} total={23} onOpenPanel={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Only remote · 0/ }));
    expect(document.querySelectorAll("tbody tr").length).toBe(0);
    expect(screen.getByText(/None of these 12 match that filter/)).toBeTruthy();
  });

  // 037b should-fix: under an active filter the Verdict headline must stay consistent with the visible
  // rows. The unfiltered headline reads "23 postings match your profile — showing the best 8"; over a
  // 4-row filtered table the "showing the best 8" tail is a visible honesty contradiction. It is
  // suppressed while a filter is active (the honest server total stays), and restored when the filter clears.
  test("verdict headline drops the 'showing the best N' tail under an active filter (server total honest), restores on clear", () => {
    render(<PostingsCard rows={postingsRows} total={23} onOpenPanel={vi.fn()} />);
    const verdict = () => document.querySelector(".verdict")?.textContent ?? "";
    // Baseline (no filter): server total AND the capped-shown tail.
    expect(verdict()).toContain("23 postings match your profile");
    expect(verdict()).toContain("showing the best 8");

    // Filter active (4 remote rows shown): the "showing the best 8" tail would contradict the 4-row
    // table, so it is gone; the honest server total (23) claim remains.
    const remoteChip = screen.getByRole("button", { name: /Only remote · 4/ });
    fireEvent.click(remoteChip);
    expect(document.querySelectorAll("tbody tr").length).toBe(4);
    expect(verdict()).toContain("23 postings match your profile");
    expect(verdict()).not.toContain("showing the best");

    // Filter cleared: the original headline is restored verbatim.
    fireEvent.click(remoteChip);
    expect(verdict()).toContain("showing the best 8");
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
  test("Should_OpenProfilePanelForm_When_InviteClicked", async () => {
    renderChat([assistantPart("data-profile-invite", { kind: "profile-invite" })]);
    fireEvent.click(screen.getByRole("button", { name: "Add your profile" }));
    // the detail panel profile form opens (empty state)
    expect(await screen.findByText("No profile yet")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Your profile" })).toBeTruthy();
  });
});

describe("detail panel routing per new card", () => {
  test("profile card 'Open in panel' opens the read-only expanded profile", () => {
    renderChat([assistantPart("data-profile-card", { kind: "profile-card", profile })]);
    fireEvent.click(screen.getByRole("button", { name: "Open in panel →" }));
    expect(screen.getByRole("region", { name: "Profile" })).toBeTruthy();
    expect(screen.getByText("Experience — from the resume")).toBeTruthy();
  });

  test("postings 'Open all N in panel' opens the full list with filter chips", () => {
    renderChat([assistantPart("data-postings", { kind: "postings", rows: postingsRows, total: 23 })]);
    fireEvent.click(screen.getByRole("button", { name: "Open top 12 of 23 in panel" }));
    expect(screen.getByRole("region", { name: "Matching postings" })).toBeTruthy();
    // the detail panel full list is uncapped (all 12 rows) with a filter group
    expect(document.querySelector(".detail-panel")?.querySelectorAll("tbody tr").length).toBe(12);
    expect(screen.getByRole("group", { name: "Filter postings" })).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------------------------------
// The form + save injection
// ---------------------------------------------------------------------------------------------------
describe("ProfilePanel form", () => {
  test("Should_AppendProfileCardMessage_When_SaveCompletes (e2e build injects the card via onProfileSaved)", async () => {
    const onProfileSaved = vi.fn();
    render(
      <ProfilePanel
        conversationId={CONVERSATION_ID}
        e2e
        onClose={vi.fn()}
        onProfileSaved={onProfileSaved}
      />,
    );
    fireEvent.change(screen.getByLabelText(/GitHub username/), { target: { value: "mkoval" } });
    fireEvent.click(screen.getByRole("button", { name: "Build my profile" }));
    await waitFor(() => expect(onProfileSaved).toHaveBeenCalled());
    // saved summary shows the identity + counts, and Edit/Delete
    expect(await screen.findByText("Profile saved ✓")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit & re-save" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete profile" })).toBeTruthy();
  });

  test("delete from the saved state returns to the empty form (e2e: local reset, no server call)", async () => {
    render(<ProfilePanel conversationId={CONVERSATION_ID} e2e onClose={vi.fn()} onProfileSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/GitHub username/), { target: { value: "mkoval" } });
    fireEvent.click(screen.getByRole("button", { name: "Build my profile" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete profile" }));
    expect(await screen.findByText("No profile yet")).toBeTruthy();
  });

  test("empty build with no inputs shows a validation message, never a save", () => {
    render(<ProfilePanel conversationId={CONVERSATION_ID} e2e onClose={vi.fn()} onProfileSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Build my profile" }));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/Add a resume or a GitHub username/);
  });

  // The in-thread parsing indicator toggles around the extraction poll: ON before the poll runs, and the
  // parent clears it WITH the injected card on success (so this panel does not clear it on the success path).
  test("signals parsing ON before the poll and hands the saved profile to the parent (success)", async () => {
    const onParsingChange = vi.fn();
    const onProfileSaved = vi.fn();
    vi.mocked(saveProfile).mockResolvedValue({ ok: true, runId: "run-1" } as never);
    vi.mocked(pollProfileSave).mockResolvedValue({ outcome: "saved", profile, githubUsername: "octocat" });
    render(
      <ProfilePanel
        conversationId={CONVERSATION_ID}
        onClose={vi.fn()}
        onProfileSaved={onProfileSaved}
        onParsingChange={onParsingChange}
      />,
    );
    fireEvent.change(await screen.findByLabelText(/GitHub username/), { target: { value: "octocat" } });
    fireEvent.click(screen.getByRole("button", { name: "Build my profile" }));
    await waitFor(() => expect(onProfileSaved).toHaveBeenCalledWith(profile));
    expect(onParsingChange).toHaveBeenCalledWith(true);
    // The success path leaves the clear to the parent (which does it with the card) - never here.
    expect(onParsingChange).not.toHaveBeenCalledWith(false);
  });

  // On a failed extraction the panel clears the indicator itself (no card will land in the thread).
  test("clears the parsing indicator when the extraction poll fails", async () => {
    const onParsingChange = vi.fn();
    vi.mocked(saveProfile).mockResolvedValue({ ok: true, runId: "run-1" } as never);
    vi.mocked(pollProfileSave).mockResolvedValue({ outcome: "error", hadPriorProfile: false });
    render(
      <ProfilePanel
        conversationId={CONVERSATION_ID}
        onClose={vi.fn()}
        onProfileSaved={vi.fn()}
        onParsingChange={onParsingChange}
      />,
    );
    fireEvent.change(await screen.findByLabelText(/GitHub username/), { target: { value: "octocat" } });
    fireEvent.click(screen.getByRole("button", { name: "Build my profile" }));
    await screen.findByText("Couldn’t build the profile");
    expect(onParsingChange).toHaveBeenCalledWith(true);
    expect(onParsingChange).toHaveBeenCalledWith(false);
  });

  // Inherited requirement (028 review, binding): the Update form MUST prefill the stored github_username
  // AND indicate a resume is on file - saveProfileInputs is full-replace, so an empty field on re-save
  // would otherwise clear it silently with no warning shown.
  test("Should_PrefillGithubAndIndicateResumeOnFile_When_EditingASavedProfile", async () => {
    vi.mocked(getMyProfile).mockResolvedValueOnce(savedMyProfile);
    render(<ProfilePanel conversationId={CONVERSATION_ID} onClose={vi.fn()} onProfileSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit & re-save" }));
    expect((screen.getByLabelText(/GitHub username/) as HTMLInputElement).value).toBe("octocat");
    expect(screen.getByText("A resume is on file. Re-upload to replace it.")).toBeTruthy();
  });
});

// exercised indirectly above; kept explicit so a regression in the wire is obvious
test("auth-invite card wires the auth dialog (guest)", async () => {
  renderChat([assistantPart("data-auth-invite", { kind: "auth-invite" })], { signedIn: false });
  fireEvent.click(screen.getByRole("button", { name: "Sign in with Google" }));
  // The redirect ahead (Google sign-in) is a FULL-PAGE navigation that wipes React state; the pending
  // profile-invite survives it via sessionStorage (same mechanism as the queued-draft carrying the
  // capped guest's draft across the identical redirect).
  expect(sessionStorage.getItem(`jobchat_pending_profile_invite:${CONVERSATION_ID}`)).toBe("1");
  await waitFor(() => expect(screen.getByRole("dialog", { name: "Create your free account" })).toBeTruthy());
  expect(within(document.body).getByRole("dialog")).toBeTruthy();
});

// ---------------------------------------------------------------------------------------------------
// The pending profile-invite across the REAL auth boundary (the Google redirect)
// ---------------------------------------------------------------------------------------------------
describe("pending profile-invite across the auth redirect (F2: opens the FORM, injects nothing)", () => {
  // The post-auth return: `/auth/complete` lands back on this SAME conversation with `fromAuth=1`. The
  // queued flag (set above) is read-once and, on this genuine post-auth arrival, OPENS the profile form
  // (interaction-spec flow C step 4) - never a second invite card (F2 replaced injectProfileInvite with openProfile).
  test("Should_OpenProfileFormAndInjectNothing_When_PostAuthArrivalWithPendingInvite", async () => {
    sessionStorage.setItem(`jobchat_pending_profile_invite:${CONVERSATION_ID}`, "1");
    renderChat([], { fromAuth: true });
    // the profile panel opens and resolves to the empty form (getMyProfile -> null)...
    expect(await screen.findByRole("region", { name: "Your profile" })).toBeTruthy();
    expect(await screen.findByText("No profile yet")).toBeTruthy();
    // ...and NO invite card was injected into the thread
    expect(screen.queryByRole("button", { name: "Add your profile" })).toBeNull();
    // read-once: the flag is cleared once consumed, so it can never fire a second time from storage alone
    expect(sessionStorage.getItem(`jobchat_pending_profile_invite:${CONVERSATION_ID}`)).toBeNull();
  });

  // Mutation-check: the exactly-once guarantee lives at the sessionStorage layer itself - a SECOND ChatClient
  // mount for the SAME conversation (a StrictMode double-invoke, or a real remount) after the first already
  // consumed the flag must NOT open the form again.
  test("Should_NotReopenFormOnSecondMount_When_PendingInviteAlreadyConsumed", async () => {
    sessionStorage.setItem(`jobchat_pending_profile_invite:${CONVERSATION_ID}`, "1");
    const first = renderChat([], { fromAuth: true });
    await screen.findByRole("region", { name: "Your profile" });
    first.unmount();

    renderChat([], { fromAuth: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.queryByRole("region", { name: "Your profile" })).toBeNull();
  });

  // The flag is taken-and-cleared on ANY signed-in mount (a signed-in user never legitimately owns one),
  // but only ACTED ON (form opened) on a genuine post-auth arrival. A LATER ordinary signed-in mount that
  // happens to find a stale flag (the guest abandoned the sign-in, then returned via an unrelated
  // navigation) must not open the form either - the flag is garbage-collected instead.
  test("Should_NotOpenForm_When_OrdinarySignedInMountFindsAStalePendingFlag", async () => {
    sessionStorage.setItem(`jobchat_pending_profile_invite:${CONVERSATION_ID}`, "1");
    renderChat([]); // signed in (renderChat default), fromAuth absent
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.queryByRole("region", { name: "Your profile" })).toBeNull();
    expect(sessionStorage.getItem(`jobchat_pending_profile_invite:${CONVERSATION_ID}`)).toBeNull(); // still cleared
  });
});

// ---------------------------------------------------------------------------------------------------
// F1: dedupe invite cards from uncoordinated sources (rendered through the real ChatClient view memo)
// ---------------------------------------------------------------------------------------------------
describe("F1 invite-card dedupe", () => {
  test("Should_RenderOneCardPerKind_When_DuplicateInviteSourcesInThread", () => {
    // Three profile-invite parts under DIFFERENT message ids (an inject + a resume re-stream + an .out
    // replay) - reconcileMessagesById can't fold them (distinct ids); dedupeInviteCards must.
    const dupInvites: UIMessage[] = ["inv-a", "inv-b", "inv-c"].map(
      (id) =>
        ({
          id,
          role: "assistant",
          parts: [{ type: "data-profile-invite", id: `${id}-p`, data: { kind: "profile-invite" } }],
        }) as UIMessage,
    );
    renderChat(dupInvites);
    expect(screen.getAllByRole("button", { name: "Add your profile" })).toHaveLength(1);
    expect(document.querySelectorAll(".register-card")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------
// F3: guarded one-shot auto-continue - after an invite-started profile save, re-run the fit question once
// ---------------------------------------------------------------------------------------------------
describe("F3 auto-continue after profile save", () => {
  const FIT_Q = "find me a job that fits";
  function threadWithInvite(): UIMessage[] {
    return [
      { id: "u-fit", role: "user", parts: [{ type: "text", text: FIT_Q }] } as UIMessage,
      assistantPart("data-profile-invite", { kind: "profile-invite" }),
    ];
  }

  test("Should_AutoResendFitQuestionOnce_When_ProfileSavedAfterInvite", async () => {
    renderChat(threadWithInvite(), { e2e: true }); // signed in; e2e build injects the card + fires onProfileSaved
    expect(screen.getAllByText(FIT_Q)).toHaveLength(1); // only the original ask so far
    fireEvent.click(screen.getByRole("button", { name: "Add your profile" })); // arms the auto-continue + opens the form
    fireEvent.change(screen.getByLabelText(/GitHub username/), { target: { value: "mkoval" } });
    fireEvent.click(screen.getByRole("button", { name: "Build my profile" }));
    // the fit question is re-asked exactly once (original + the one auto re-run)
    await waitFor(() => expect(screen.getAllByText(FIT_Q)).toHaveLength(2));
  });

  test("Should_NotAutoResend_When_NoInviteStartedTheFlow", async () => {
    // The form is opened by the fromAuth path over an EMPTY thread (a stale pending flag, no trailing invite),
    // so nothing is armed; a save must not re-send anything.
    sessionStorage.setItem(`jobchat_pending_profile_invite:${CONVERSATION_ID}`, "1");
    renderChat([], { e2e: true, fromAuth: true });
    await screen.findByRole("region", { name: "Your profile" });
    fireEvent.change(screen.getByLabelText(/GitHub username/), { target: { value: "mkoval" } });
    fireEvent.click(screen.getByRole("button", { name: "Build my profile" }));
    await screen.findByText("Profile saved ✓");
    await Promise.resolve();
    await Promise.resolve();
    expect(document.querySelectorAll(".bubble.user")).toHaveLength(0); // no auto-resent user turn
  });

  test("Should_AutoResendOnlyOnce_When_ProfileSavedTwice (double-save -> one)", async () => {
    renderChat(threadWithInvite(), { e2e: true });
    fireEvent.click(screen.getByRole("button", { name: "Add your profile" }));
    fireEvent.change(screen.getByLabelText(/GitHub username/), { target: { value: "mkoval" } });
    fireEvent.click(screen.getByRole("button", { name: "Build my profile" }));
    await waitFor(() => expect(screen.getAllByText(FIT_Q)).toHaveLength(2)); // save #1 auto-continues
    // Re-save from the saved state; the ref was consumed by save #1, so no second auto-send.
    fireEvent.click(await screen.findByRole("button", { name: "Edit & re-save" }));
    fireEvent.change(screen.getByLabelText(/GitHub username/), { target: { value: "mkoval2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Profile saved ✓");
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.getAllByText(FIT_Q)).toHaveLength(2); // still exactly one auto re-run
  });

  // F3 stale-ref regression (repro A): an armed auto-continue must be CLEARED when the form is abandoned
  // via Esc (not saved). Re-opening from the title bar (no re-arm) and saving must NOT fire the stale send.
  test("Should_NotAutoResend_When_FormEscAbandonedThenReopenedAndSaved", async () => {
    renderChat(threadWithInvite(), { e2e: true }); // signed in as Ada
    expect(screen.getAllByText(FIT_Q)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Add your profile" })); // arms + opens the form
    await screen.findByRole("region", { name: "Your profile" });
    // Abandon via Esc - the window keydown close path that bypassed the ref clear.
    await act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Your profile" })).toBeNull());
    // Re-open from the title-bar account menu (openProfile - never re-arms).
    fireEvent.click(screen.getByRole("button", { name: "Account: Ada" }));
    fireEvent.click(screen.getByRole("button", { name: "Your profile" }));
    await screen.findByRole("region", { name: "Your profile" });
    fireEvent.change(screen.getByLabelText(/GitHub username/), { target: { value: "mkoval" } });
    fireEvent.click(screen.getByRole("button", { name: "Build my profile" }));
    await screen.findByText("Profile saved ✓");
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.getAllByText(FIT_Q)).toHaveLength(1); // still only the original ask - no stale re-send
  });

  // F3 stale-ref regression (repro B, worse): New chat abandons the flow AND arms freshChatRef. A surviving
  // stale ref would make the next save start a spurious BRAND-NEW conversation (router.push). Must not happen.
  test("Should_NotAutoResendOrCreateConversation_When_NewChatAbandonsThenSaved", async () => {
    renderChat(threadWithInvite(), { e2e: true });
    fireEvent.click(screen.getByRole("button", { name: "Add your profile" })); // arms + opens the form
    await screen.findByRole("region", { name: "Your profile" });
    fireEvent.click(screen.getByRole("button", { name: "New chat" })); // clears the thread + closes the form (bypassed the ref clear); arms freshChatRef
    await waitFor(() => expect(screen.queryByRole("region", { name: "Your profile" })).toBeNull());
    // Re-open from the title bar (no re-arm) over the now-empty thread and save.
    fireEvent.click(screen.getByRole("button", { name: "Account: Ada" }));
    fireEvent.click(screen.getByRole("button", { name: "Your profile" }));
    await screen.findByRole("region", { name: "Your profile" });
    fireEvent.change(screen.getByLabelText(/GitHub username/), { target: { value: "mkoval" } });
    fireEvent.click(screen.getByRole("button", { name: "Build my profile" }));
    await screen.findByText("Profile saved ✓");
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.queryAllByText(FIT_Q)).toHaveLength(0); // New chat cleared the thread; nothing re-added
    expect(pushMock).not.toHaveBeenCalled(); // no spurious new conversation navigated to
  });
});

// ---------------------------------------------------------------------------------------------------
// Card-on-delete: the active-conversation card-and-row rule, plus the orphan case in other conversations
// ---------------------------------------------------------------------------------------------------
describe("profile-delete keeps the thread card (041 req 3: history is history)", () => {
  test("Should_KeepLiveThreadCardAndDeleteRow_When_ProfileDeletedInActiveConversation", async () => {
    const cardId = await profileCardMessageId(CONVERSATION_ID);
    vi.mocked(getMyProfile).mockResolvedValueOnce(savedMyProfile);
    renderChat([
      {
        id: cardId,
        role: "assistant",
        parts: [{ type: "data-profile-card", id: `${cardId}-card`, data: { kind: "profile-card", profile } }],
      } as UIMessage,
    ]);
    expect(document.querySelector(".insight")).toBeTruthy(); // the live ProfileCard in the thread

    fireEvent.click(screen.getByRole("button", { name: "Edit profile" })); // opens the detail panel form
    fireEvent.click(await screen.findByRole("button", { name: "Delete profile" }));

    // The persisted profile ROW is deleted (no conversationId - delete never scopes to a thread)...
    await waitFor(() => expect(deleteProfile).toHaveBeenCalled());
    // ...but the streamed card STAYS as history (deleting your profile never rewrites past turns), and the
    // panel returns to the empty/upload state.
    expect(await screen.findByText("No profile yet")).toBeTruthy();
    expect(document.querySelector(".insight")).toBeTruthy();
  });

  // A card persisted in ANY conversation renders as plain history even when the account's CURRENT profile
  // state (getMyProfile) is empty (deleted) - now the invariant for the active conversation too.
  test("Should_RenderPersistedCardAsHistory_When_AccountCurrentlyHasNoProfile (orphan card, other conversation)", async () => {
    const OTHER_CONV = "22222222-2222-4222-8222-222222222222";
    const cardId = await profileCardMessageId(OTHER_CONV);
    // getMyProfile (the account's LIVE current state) is never even called here - the detail panel profile panel
    // is not opened - which is the point: the persisted part renders independent of it.
    render(
      <ChatClient
        conversationId={OTHER_CONV}
        initialMessages={[
          {
            id: cardId,
            role: "assistant",
            parts: [{ type: "data-profile-card", id: `${cardId}-card`, data: { kind: "profile-card", profile } }],
          } as UIMessage,
        ]}
        e2e={false}
        signedIn
        accountName="Ada"
      />,
    );
    expect(screen.getByText("Senior Backend Engineer")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------------------------------
// 041: the inline profile editor (salary/location prefs + skill chips). One "Save changes" round persists
// both; a failed save leaves the previous truth; chip add/remove; edits never auto-send (no onProfileSaved).
// ---------------------------------------------------------------------------------------------------
describe("profile editor (041 inline edits)", () => {
  test("edits salary + location, saves in one round, and re-renders from the returned row", async () => {
    vi.mocked(getMyProfile).mockResolvedValueOnce(savedMyProfile);
    const returned: Profile = {
      ...profile,
      salaryMin: 150000,
      locations: ["SF"],
      remotePref: true,
      skills: [...profile.skills, { name: "Kafka", source: "resume" }],
    };
    vi.mocked(updateProfilePrefs).mockResolvedValueOnce({
      ok: true,
      profile: { ...profile, salaryMin: 150000, locations: ["SF"], remotePref: true },
    });
    vi.mocked(updateProfileSkills).mockResolvedValueOnce({ ok: true, profile: returned });
    render(<ProfilePanel conversationId={CONVERSATION_ID} onClose={vi.fn()} onProfileSaved={vi.fn()} />);

    // The editor loads seeded from the saved row.
    const salary = (await screen.findByLabelText(/salary/i)) as HTMLInputElement;
    expect(salary.value).toBe("120000");
    const location = screen.getByLabelText(/location/i) as HTMLInputElement;
    expect(location.value).toBe("Berlin or Munich or remote");

    fireEvent.change(salary, { target: { value: "150000" } });
    fireEvent.change(location, { target: { value: "SF or remote" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(updateProfilePrefs).toHaveBeenCalledWith({ salary: 150000, location: "SF or remote" }));
    await waitFor(() => expect(updateProfileSkills).toHaveBeenCalled());
    // Re-renders from the RETURNED row (the Kafka chip the server sent back appears).
    expect(await screen.findByText("Kafka")).toBeTruthy();
  });

  test("a failed save shows an error, keeps the previous truth, and never partially applies (skills untried)", async () => {
    vi.mocked(getMyProfile).mockResolvedValueOnce(savedMyProfile);
    vi.mocked(updateProfilePrefs).mockResolvedValueOnce({ ok: false, reason: "invalid_input" });
    render(<ProfilePanel conversationId={CONVERSATION_ID} onClose={vi.fn()} onProfileSaved={vi.fn()} />);

    const salary = (await screen.findByLabelText(/salary/i)) as HTMLInputElement;
    fireEvent.change(salary, { target: { value: "-5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(updateProfileSkills).not.toHaveBeenCalled(); // prefs failed first -> no cross-surface partial write
  });

  test("removes a github-proven chip and adds a new resume chip; save sends the edited array", async () => {
    vi.mocked(getMyProfile).mockResolvedValueOnce(savedMyProfile);
    vi.mocked(updateProfilePrefs).mockResolvedValueOnce({ ok: true, profile });
    vi.mocked(updateProfileSkills).mockResolvedValueOnce({ ok: true, profile });
    render(<ProfilePanel conversationId={CONVERSATION_ID} onClose={vi.fn()} onProfileSaved={vi.fn()} />);
    await screen.findByLabelText(/salary/i);

    // Removing a github-proven chip is allowed (the user owns their profile).
    fireEvent.click(screen.getByRole("button", { name: "Remove ClickHouse" }));
    expect(screen.queryByText("ClickHouse")).toBeNull();
    // Add a new (resume-sourced) chip via the + Add input.
    fireEvent.change(screen.getByLabelText("Add a skill"), { target: { value: "Kafka" } });
    fireEvent.click(screen.getByRole("button", { name: "+ Add" }));
    expect(screen.getByText("Kafka")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(updateProfileSkills).toHaveBeenCalledWith({
        skills: [
          { name: "Go", source: "both" },
          { name: "Python", source: "resume" },
          { name: "Kafka", source: "resume" },
        ],
      }),
    );
  });

  test("Save never re-injects the thread card or auto-sends (onProfileSaved untouched by an inline edit)", async () => {
    vi.mocked(getMyProfile).mockResolvedValueOnce(savedMyProfile);
    vi.mocked(updateProfilePrefs).mockResolvedValueOnce({ ok: true, profile });
    vi.mocked(updateProfileSkills).mockResolvedValueOnce({ ok: true, profile });
    const onProfileSaved = vi.fn();
    render(<ProfilePanel conversationId={CONVERSATION_ID} onClose={vi.fn()} onProfileSaved={onProfileSaved} />);
    await screen.findByLabelText(/salary/i);
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateProfileSkills).toHaveBeenCalled());
    expect(onProfileSaved).not.toHaveBeenCalled(); // inline edits do NOT fire the card inject / F3 auto-continue
  });
});

// ---------------------------------------------------------------------------------------------------
// The poll's error outcome -> ProfilePanel's error-state copy (gated on whether a prior profile existed)
// ---------------------------------------------------------------------------------------------------
describe("ProfilePanel error state (poll contract)", () => {
  test("Should_ShowNothingWasSaved_When_FreshExtractionFailsWithNoPriorProfile", async () => {
    vi.mocked(getMyProfile).mockResolvedValueOnce(freshFailureMyProfile);
    render(<ProfilePanel conversationId={CONVERSATION_ID} onClose={vi.fn()} onProfileSaved={vi.fn()} />);
    expect(await screen.findByText("Couldn’t build the profile")).toBeTruthy();
    expect(screen.getByText("Nothing was saved.")).toBeTruthy();
    expect(screen.queryByText("Your previous profile is untouched.")).toBeNull();
  });

  // The re-save edge (028/029 inherited requirement): a WORKING profile re-saves and extraction fails
  // terminally - the poll's own outcome carries `hadPriorProfile: true`, and the error copy must say so.
  test("Should_ShowPreviousProfileUntouched_When_ResaveFailsWithPriorProfile (re-save edge)", async () => {
    vi.mocked(getMyProfile).mockResolvedValueOnce(savedMyProfile).mockResolvedValueOnce(savedMyProfile);
    vi.mocked(saveProfile).mockResolvedValueOnce({ ok: true, taskState: "queued", runId: "run_x" });
    vi.mocked(pollProfileSave).mockResolvedValueOnce({ outcome: "error", hadPriorProfile: true });
    render(<ProfilePanel conversationId={CONVERSATION_ID} onClose={vi.fn()} onProfileSaved={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit & re-save" })); // github already prefilled -> passes the build() guard
    fireEvent.click(await screen.findByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("Couldn’t build the profile")).toBeTruthy();
    expect(screen.getByText("Your previous profile is untouched.")).toBeTruthy();
  });

  // Nit (review): the error copy must key off the POLL OUTCOME's own hadPriorProfile, not local `profile`
  // state - they can diverge in a multi-tab race (another tab creates a profile between this tab's empty
  // initial load and this tab's save). Local `profile` here stays null throughout; only the outcome says
  // a prior profile existed.
  test("Should_TrustPollOutcomeOverLocalState_When_TheyDiverge (multi-tab race)", async () => {
    vi.mocked(getMyProfile).mockResolvedValueOnce(null); // this tab's initial load: no profile known locally
    vi.mocked(saveProfile).mockResolvedValueOnce({ ok: true, taskState: "queued", runId: "run_y" });
    vi.mocked(pollProfileSave).mockResolvedValueOnce({ outcome: "error", hadPriorProfile: true });
    render(<ProfilePanel conversationId={CONVERSATION_ID} onClose={vi.fn()} onProfileSaved={vi.fn()} />);

    await screen.findByText("No profile yet"); // confirms local state resolved empty (profile stays null)
    fireEvent.change(screen.getByLabelText(/GitHub username/), { target: { value: "mkoval" } });
    fireEvent.click(screen.getByRole("button", { name: "Build my profile" }));

    expect(await screen.findByText("Couldn’t build the profile")).toBeTruthy();
    expect(screen.getByText("Your previous profile is untouched.")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------------------------------
// 039 item 3: when extraction completes while the panel is open (saving state), the panel transitions
// to the FULL read-only profile automatically - identity header, source ticks, skills split by source,
// experience, OSS - keeping "Find me a job that fits" + "Edit & re-save" wired; still display-only.
// ---------------------------------------------------------------------------------------------------
describe("post-parse full profile (039 item 3)", () => {
  test("saving transitions to the full profile view with Find/Edit wired and inline editing surfaces (041)", async () => {
    vi.mocked(getMyProfile).mockResolvedValue(null); // empty form, and the build()'s prior-capture read
    vi.mocked(saveProfile).mockResolvedValueOnce({ ok: true, taskState: "queued", runId: "run_z" });
    vi.mocked(pollProfileSave).mockResolvedValueOnce({ outcome: "saved", profile, githubUsername: "octocat" });
    const onFindJob = vi.fn();
    render(
      <ProfilePanel
        conversationId={CONVERSATION_ID}
        onClose={vi.fn()}
        onFindJob={onFindJob}
        onProfileSaved={vi.fn()}
      />,
    );

    // Kick a build from the empty form; the SavingState shows while the poll runs.
    await screen.findByText("No profile yet");
    fireEvent.change(screen.getByLabelText(/GitHub username/), { target: { value: "octocat" } });
    fireEvent.click(screen.getByRole("button", { name: "Build my profile" }));

    // Lands on the full profile: confirmation + identity header (headline role) + skills split + experience + all OSS.
    expect(await screen.findByText("Profile saved ✓")).toBeTruthy();
    // The identity header is the profile-form's first div (the headline role also recurs as an experience title).
    expect((document.querySelector(".profile-form > div") as HTMLElement).textContent).toBe("Senior Backend Engineer");
    expect(screen.getByText("Skills — proven in code")).toBeTruthy();
    expect(screen.getByText("Skills — from the resume")).toBeTruthy();
    expect(screen.getByText("Experience — from the resume")).toBeTruthy();
    expect(screen.getByText("· ClickHouse migration CLI")).toBeTruthy(); // OSS list (not just the first)

    // "Find me a job that fits" is wired; "Edit & re-save" is kept; 041 adds the editable salary/location
    // inputs + a "Save changes" button (the inline edit surface).
    fireEvent.click(screen.getByRole("button", { name: "Find me a job that fits" }));
    expect(onFindJob).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Edit & re-save" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeTruthy();
    expect(screen.getByLabelText(/salary/i)).toBeTruthy();
    expect(screen.getByLabelText(/location/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete profile" })).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------------------------------
// Item 2 (register 16): a post-auth return whose account ALREADY has a profile on file must SKIP the form
// and auto-continue the queued fit question (the same F3 one-shot machinery, armed at a new site). No
// profile -> the form opens (F2 unchanged). `hasProfile` is the SSR-resolved signal the page passes down.
// ---------------------------------------------------------------------------------------------------
describe("Item 2 fromAuth-with-profile auto-continue (register 16)", () => {
  const FIT_Q = "find me a job that fits";
  function threadWithInvite(): UIMessage[] {
    return [
      { id: "u-fit", role: "user", parts: [{ type: "text", text: FIT_Q }] } as UIMessage,
      assistantPart("data-profile-invite", { kind: "profile-invite" }),
    ];
  }

  test("Should_SkipFormAndAutoContinue_When_PostAuthArrivalWithProfileOnFile", async () => {
    sessionStorage.setItem(`jobchat_pending_profile_invite:${CONVERSATION_ID}`, "1");
    renderChat(threadWithInvite(), { e2e: true, fromAuth: true, hasProfile: true });
    // The queued fit question is re-asked exactly once (original + one auto re-run) - no manual "So?".
    await waitFor(() => expect(screen.getAllByText(FIT_Q)).toHaveLength(2));
    // The form is NOT opened (a profile is already on file), and getMyProfile is never consulted.
    expect(screen.queryByRole("region", { name: "Your profile" })).toBeNull();
    expect(getMyProfile).not.toHaveBeenCalled();
    // read-once: the flag is cleared on consumption.
    expect(sessionStorage.getItem(`jobchat_pending_profile_invite:${CONVERSATION_ID}`)).toBeNull();
  });

  test("Should_OpenFormAndNotAutoContinue_When_PostAuthArrivalWithoutProfile (F2 unchanged)", async () => {
    sessionStorage.setItem(`jobchat_pending_profile_invite:${CONVERSATION_ID}`, "1");
    renderChat(threadWithInvite(), { e2e: true, fromAuth: true }); // hasProfile defaults false
    // No profile on file -> the form opens (interaction-spec flow C step 4)...
    expect(await screen.findByRole("region", { name: "Your profile" })).toBeTruthy();
    // ...and the fit question is NOT auto-resent (it waits for the save to fire the armed continuation).
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.getAllByText(FIT_Q)).toHaveLength(1);
  });
});
