import type {
  Analytics,
  CorpusSummary,
  CoverageProfile,
  QueryResult,
} from "@shared/analytics";
import {
  deriveTitle,
  type Conversation,
  type Json,
  type Message,
  type MessageRole,
  type Store,
  type User,
} from "@shared/store";
import { FIXTURE_INGESTED_AT } from "../fixtures/postings.fixture";

// The faked run-path seams the eval injects so the ONLY network the harness touches is Bedrock:
// an IN-MEMORY Store (no real Postgres) and a fixture-derived Analytics (no real ClickHouse -
// scoring judges the agent's CHOICES, not the numbers).

/**
 * The in-memory Store: createChatRun persists incoming user turns, counts them
 * for the guard, and rebuilds the model history from its Store - all absorbed in memory here. Only the
 * run-path methods carry real behaviour; the auth/history methods (unused by the run) are minimal.
 */
export function createMemoryStore(): Store {
  const users = new Map<string, User>();
  const conversations = new Map<string, Conversation>();
  const messages: Message[] = []; // insertion order == chronological (getConversation preserves it)
  const now = () => new Date();

  return {
    async getOrCreateUser(guestId: string) {
      const existing = users.get(guestId);
      if (existing) return existing;
      const user: User = {
        user_id: guestId,
        created_at: now(),
        auth_user_id: null,
      };
      users.set(guestId, user);
      return user;
    },
    async createConversation(userId: string, firstQuestion: string) {
      const conv: Conversation = {
        id: crypto.randomUUID(),
        user_id: userId,
        title: deriveTitle(firstQuestion),
        created_at: now(),
      };
      conversations.set(conv.id, conv);
      return conv;
    },
    async appendMessage(
      conversationId: string,
      role: MessageRole,
      content: string,
      parts: Json | null,
    ) {
      const message: Message = {
        id: crypto.randomUUID(),
        conversation_id: conversationId,
        role,
        content,
        parts: parts ?? null,
        created_at: now(),
      };
      messages.push(message);
      return message;
    },
    async getConversation(conversationId: string) {
      const conversation = conversations.get(conversationId);
      if (!conversation) return null;
      return {
        conversation,
        messages: messages.filter((m) => m.conversation_id === conversationId),
      };
    },
    async getConversationOwner(conversationId: string) {
      const conv = conversations.get(conversationId);
      if (!conv) return null;
      return {
        user_id: conv.user_id,
        auth_user_id: users.get(conv.user_id)?.auth_user_id ?? null,
      };
    },
    async findUserByAuthId(authUserId: string) {
      for (const user of users.values())
        if (user.auth_user_id === authUserId) return user;
      return null;
    },
    async linkAuthUser() {
      return false; // unused by the eval run path
    },
    async adoptGuest() {
      // unused by the eval run path
    },
    async deleteConversation() {
      // unused by the eval run path
    },
    async renameConversation(conversationId: string, title: string) {
      const conv = conversations.get(conversationId);
      if (conv) conversations.set(conversationId, { ...conv, title });
    },
    async deleteTrailingAssistant(conversationId: string) {
      // The regenerate pop: remove the assistant row(s) trailing the last user turn for this conversation
      // (createChatRun calls this on a regenerate). Walk newest-first, dropping assistants until a user.
      const convMsgs = messages.filter((m) => m.conversation_id === conversationId);
      for (let i = convMsgs.length - 1; i >= 0 && convMsgs[i].role !== "user"; i--) {
        const at = messages.indexOf(convMsgs[i]);
        if (at >= 0) messages.splice(at, 1);
      }
    },
    async listConversations(userId: string) {
      return [...conversations.values()]
        .filter((c) => c.user_id === userId)
        .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
        .map(({ id, title, created_at }) => ({
          id,
          title,
          created_at,
        }));
    },
    async messageCounts({
      userId,
      sinceUtcMidnight,
    }: {
      userId?: string;
      sinceUtcMidnight: Date;
    }) {
      return messages.filter(
        (m) =>
          m.role === "user" &&
          m.created_at >= sinceUtcMidnight &&
          (userId === undefined ||
            conversations.get(m.conversation_id)?.user_id === userId),
      ).length;
    },
    // The profile methods are unused by the eval run path (the harness scores tool/mode choices, not
    // the profile feature) - minimal, honest stubs.
    async appendProfileCard() {},
    async getProfile() {
      return null;
    },
    async saveProfileInputs() {},
    async saveExtractedProfile() {
      return true;
    },
    async updateProfilePrefs() {
      return null;
    },
    async updateProfileSkills() {
      return null;
    },
    async clearResumePdf() {},
    async markExtractionFailed() {},
    async deleteProfile() {},
    async deleteMessage() {},
  };
}

/**
 * A fixture-derived Analytics: every query returns the SAME small, schema-valid QueryResult built from
 * the reference dataset's domain values (tests/fixtures/postings.fixture.ts). It never executes a query
 * or computes a real aggregate - the harness scores the agent's CHOICES, not the data. The rows carry
 * a superset of the columns any verdict/insight reads, so buildInsight /
 * buildComposedInsight always produce a valid, non-empty card (=> the run registers "data" mode).
 */
export function fakeAnalytics(): Analytics {
  const rows: Record<string, unknown>[] = [
    {
      label: "Google",
      company: "Google",
      city: "San Francisco",
      region: "California",
      country: "United States",
      title: "Senior Software Engineer",
      experience_level: "Senior",
      employment_type: "full-time",
      location_kind: "onsite",
      bucket: "2026-05-01",
      day: "2026-05-01",
      count: 4,
      median: 180000,
      median_salary: 180000,
      p25_salary: 150000,
      p75_salary: 200000,
      n: 4,
    },
    {
      label: "Meta",
      company: "Meta",
      city: "Los Angeles",
      region: "California",
      country: "United States",
      title: "Backend Engineer",
      experience_level: "Senior",
      employment_type: "full-time",
      location_kind: "hybrid",
      bucket: "2026-06-01",
      day: "2026-06-01",
      count: 2,
      median: 150000,
      median_salary: 150000,
      p25_salary: 130000,
      p75_salary: 170000,
      n: 2,
    },
    {
      label: "Stripe",
      company: "Stripe",
      city: "San Francisco",
      region: "California",
      country: "United States",
      title: "Data Engineer",
      experience_level: "Junior",
      employment_type: "contract",
      location_kind: "remote",
      bucket: "2026-07-01",
      day: "2026-07-01",
      count: 2,
      median: 170000,
      median_salary: 170000,
      p25_salary: 140000,
      p75_salary: 190000,
      n: 2,
    },
  ];
  const result = (sql: string): QueryResult => ({
    sql,
    rows,
    meta: { sampleN: 8, freshestAt: FIXTURE_INGESTED_AT },
  });
  return {
    runQuery: async (name) => result(`-- fake template ${name}`),
    runComposedQuery: async () => result(`-- fake query_postings`),
    getPostingDetail: async () => null,
    // A fixed, schema-valid postings result so a with-profile search case registers a postings card
    // (=> "data" mode). It never scores real rows - the harness judges the agent's CHOICES.
    searchPostings: async () => ({
      rows: [
        { title: "Senior Backend Engineer", company: "Google", city: "Berlin", remote: true, salaryMin: 150000, salaryMax: 190000, experience: "Senior", publishedAt: "2026-07-18 10:00:00", score: 9 },
        { title: "Staff Engineer", company: "Meta", city: "Berlin", remote: false, salaryMin: null, salaryMax: null, experience: "Staff", publishedAt: "2026-07-17 10:00:00", score: 7 },
      ],
      total: 2,
      meta: { freshestAt: FIXTURE_INGESTED_AT, topCompany: "Google", topShare: 0.5 },
    }),
    coverageProfile: fakeCoverageProfile,
    corpusSummary: fakeCorpusSummary,
  };
}

/**
 * The corpus summary shape a with-corpus run would inject, matching the fixture's domain values. The eval
 * runner does NOT wire the CORPUS note into createChatRun (routing is scored under the shipped prompt
 * text, not the note), so this only satisfies the Analytics contract - it is never rendered in a run.
 */
export function fakeCorpusSummary(): Promise<CorpusSummary> {
  return Promise.resolve({
    total: 3488,
    freshestAt: FIXTURE_INGESTED_AT,
    salaryCoverage: 0.65,
    sources: [{ source: "searchnapply", share: 1 }],
    topCities: ["San Francisco", "Los Angeles", "Berlin"],
    countries: ["United States", "Germany"],
    experienceLevels: ["Senior", "Junior", "Staff"],
    employmentTypes: ["full-time", "contract"],
    locationKinds: ["onsite", "hybrid", "remote"],
  });
}

/**
 * The corpus shape the eval injects into the system prompt, matching the live ground
 * truth so a market-wide question exercises the SAME DATA SCOPE note production ships (mostly Google).
 */
export function fakeCoverageProfile(): Promise<CoverageProfile> {
  return Promise.resolve({
    total: 3488,
    distinctCompanies: 7,
    topCompany: "Google",
    topCompanyShare: 0.93,
    freshestAt: FIXTURE_INGESTED_AT,
    salaryCoverage: 0.65,
  });
}
