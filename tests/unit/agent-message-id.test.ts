import { describe, expect, it } from "vitest";
import { generateMessageId } from "../../trigger/chat";

// Conformance correction 2: responseMessage.id defaults to the AI SDK's 16-char generateId, NOT a
// uuid. The agent overrides it via uiMessageStreamOptions.generateMessageId so assistant-row ids fit
// the existing uuid messages.id column (no migration). This pins that the wired generator yields
// uuid-shaped ids.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("agent message-id generation", () => {
  it("mints uuid-shaped response ids when the agent is configured", () => {
    const id = generateMessageId();
    expect(id).toMatch(UUID_RE);
    // A generator, not a constant: distinct per call.
    expect(generateMessageId()).not.toBe(id);
  });
});
