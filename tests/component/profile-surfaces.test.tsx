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
// The poll's own contract (attempt ceiling, the re-save edge) is exhaustively unit-tested in
// profile-poll.test.ts; here it is mocked so LcpProfile's ERROR-STATE RENDERING (which copy, gated on
// whether a prior profile existed) is tested in isolation from the poll's real timers.
vi.mock("@/lib/profile-poll", () => ({ pollProfileSave: vi.fn() }));

import { ChatClient } from "@/components/chat/ChatClient";
import { ProfileCard, ProfileExpanded } from "@/components/insight/ProfileCard";
import { PostingsCard } from "@/components/insight/PostingsCard";
import { InlinePromptCard } from "@/components/insight/InlinePromptCard";
import { LcpProfile } from "@/components/chat/LcpProfile";
import { deleteProfile, getMyProfile, saveProfile, type MyProfile } from "@/app/actions";
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
  sessionStorage.clear(); // the pending-invite tests below stash a real sessionStorage key
  // These action mocks are SHARED module-level vi.fn()s; `mockResolvedValueOnce` queues values that
  // outlive a test if the component under test never consumed them (e.g. a test that never opens the
  // LCP form leaves its queued `getMyProfile` value to bleed into the NEXT test's first call). Reset the
  // call history + queues and restore each factory's original default so every test starts clean.
  vi.mocked(getMyProfile).mockReset().mockResolvedValue(null);
  vi.mocked(saveProfile).mockReset();
  vi.mocked(deleteProfile).mockReset().mockResolvedValue({ ok: true });
  vi.mocked(pollProfileSave).mockReset();
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

  // Inherited requirement (028 review, binding): the Update form MUST prefill the stored github_username
  // AND indicate a resume is on file - saveProfileInputs is full-replace, so an empty field on re-save
  // would otherwise clear it silently with no warning shown.
  test("Should_PrefillGithubAndIndicateResumeOnFile_When_EditingASavedProfile", async () => {
    vi.mocked(getMyProfile).mockResolvedValueOnce(savedMyProfile);
    render(<LcpProfile conversationId={CONVERSATION_ID} onClose={vi.fn()} onProfileSaved={vi.fn()} onProfileDeleted={vi.fn()} />);
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
describe("pending profile-invite replay across the auth redirect", () => {
  // The post-auth return: `/auth/complete` lands back on this SAME conversation with `fromAuth=1`. The
  // queued flag (set above) is read-once and, on this genuine post-auth arrival, replayed as the
  // profile-invite card in the live thread.
  test("Should_ReplayProfileInviteCardOnce_When_PostAuthArrivalWithPendingInvite", async () => {
    sessionStorage.setItem(`jobchat_pending_profile_invite:${CONVERSATION_ID}`, "1");
    renderChat([], { fromAuth: true });
    expect(await screen.findByRole("button", { name: "Add your profile" })).toBeTruthy();
    // read-once: the flag is cleared once consumed, so it can never fire a second time from storage alone
    expect(sessionStorage.getItem(`jobchat_pending_profile_invite:${CONVERSATION_ID}`)).toBeNull();
  });

  // Mutation-check: the exactly-once guarantee must live at the sessionStorage layer itself, not just a
  // component mount ref - a SECOND ChatClient mount for the SAME conversation (a StrictMode double-invoke,
  // or a real remount) after the first already consumed the flag must NOT inject a second card.
  test("Should_NotReplayOnSecondUnrelatedMount_When_PendingInviteAlreadyConsumed", async () => {
    sessionStorage.setItem(`jobchat_pending_profile_invite:${CONVERSATION_ID}`, "1");
    const first = renderChat([], { fromAuth: true });
    await screen.findByRole("button", { name: "Add your profile" });
    first.unmount();

    renderChat([], { fromAuth: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.queryByRole("button", { name: "Add your profile" })).toBeNull();
  });

  // The flag is taken-and-cleared on ANY signed-in mount (a signed-in user never legitimately owns one),
  // but only INJECTED on a genuine post-auth arrival. A LATER ordinary signed-in mount that happens to
  // find a stale flag (the guest abandoned the sign-in, then returned via an unrelated navigation) must
  // not surface the card either - it is garbage-collected instead.
  test("Should_NotInjectInvite_When_OrdinarySignedInMountFindsAStalePendingFlag", async () => {
    sessionStorage.setItem(`jobchat_pending_profile_invite:${CONVERSATION_ID}`, "1");
    renderChat([]); // signed in (renderChat default), fromAuth absent
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.queryByRole("button", { name: "Add your profile" })).toBeNull();
    expect(sessionStorage.getItem(`jobchat_pending_profile_invite:${CONVERSATION_ID}`)).toBeNull(); // still cleared
  });
});

// ---------------------------------------------------------------------------------------------------
// Card-on-delete: the active-conversation card-and-row rule, plus the orphan case in other conversations
// ---------------------------------------------------------------------------------------------------
describe("card-on-delete", () => {
  test("Should_RemoveLiveThreadCardAndDeletePersistedRow_When_ProfileDeletedInActiveConversation", async () => {
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

    fireEvent.click(screen.getByRole("button", { name: "Edit profile" })); // opens the LCP form
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() => expect(deleteProfile).toHaveBeenCalledWith(CONVERSATION_ID)); // the persisted row
    await waitFor(() => expect(document.querySelector(".insight")).toBeNull()); // the live thread card
  });

  // The binding rule scopes the DELETE to the ACTIVE conversation only (the deterministic id is PER
  // conversation) - a card persisted in a DIFFERENT conversation is never touched, so it renders as plain
  // history even when the account's CURRENT profile state (getMyProfile) is empty (e.g. deleted elsewhere).
  test("Should_RenderPersistedCardAsHistory_When_AccountCurrentlyHasNoProfile (orphan card, other conversation)", async () => {
    const OTHER_CONV = "22222222-2222-4222-8222-222222222222";
    const cardId = await profileCardMessageId(OTHER_CONV);
    // getMyProfile (the account's LIVE current state) is never even called here - the LCP profile panel
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
// The poll's error outcome -> LcpProfile's error-state copy (gated on whether a prior profile existed)
// ---------------------------------------------------------------------------------------------------
describe("LcpProfile error state (poll contract)", () => {
  test("Should_ShowNothingWasSaved_When_FreshExtractionFailsWithNoPriorProfile", async () => {
    vi.mocked(getMyProfile).mockResolvedValueOnce(freshFailureMyProfile);
    render(<LcpProfile conversationId={CONVERSATION_ID} onClose={vi.fn()} onProfileSaved={vi.fn()} onProfileDeleted={vi.fn()} />);
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
    render(<LcpProfile conversationId={CONVERSATION_ID} onClose={vi.fn()} onProfileSaved={vi.fn()} onProfileDeleted={vi.fn()} />);

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
    render(<LcpProfile conversationId={CONVERSATION_ID} onClose={vi.fn()} onProfileSaved={vi.fn()} onProfileDeleted={vi.fn()} />);

    await screen.findByText("No profile yet"); // confirms local state resolved empty (profile stays null)
    fireEvent.change(screen.getByLabelText(/GitHub username/), { target: { value: "mkoval" } });
    fireEvent.click(screen.getByRole("button", { name: "Build my profile" }));

    expect(await screen.findByText("Couldn’t build the profile")).toBeTruthy();
    expect(screen.getByText("Your previous profile is untouched.")).toBeTruthy();
  });
});
