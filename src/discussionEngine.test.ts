import { describe, expect, it } from "vitest";
import { DiscussionEngine } from "./discussionEngine";
import { DEFAULT_SETTINGS, type DiscussionProviderIntegration } from "./types";

describe("DiscussionEngine", () => {
  it("runs providers in parallel and determines a winner", async () => {
    let active = 0;
    let maximumActive = 0;
    const provider: DiscussionProviderIntegration = {
      protocolVersion: 1,
      id: "test",
      name: "Test",
      listModels: async () => [],
      streamText: async ({ modelId, messages, onChunk }) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        const prompt = messages[0].content;
        onChunk(prompt.includes("Format: VOTE") ? "VOTE: Alpha - best" : `${modelId} answer`);
        active -= 1;
      },
    };
    const participants = [
      { id: "a", providerId: "test", modelId: "a", displayName: "Alpha" },
      { id: "b", providerId: "test", modelId: "b", displayName: "Beta" },
    ];
    const engine = new DiscussionEngine((id) => id === "test" ? provider : undefined, DEFAULT_SETTINGS);
    const result = await engine.run("Theme", 1, participants, participants.map((item) => ({ ...item })));
    expect(maximumActive).toBe(2);
    expect(result.winnerId).toBe("a");
    expect(result.turns).toHaveLength(1);
  });

  it("hands attachments to providers only on the first discussion turn", async () => {
    const attachmentCounts: number[] = [];
    const provider: DiscussionProviderIntegration = {
      protocolVersion: 1,
      id: "test",
      name: "Test",
      listModels: async () => [],
      streamText: async ({ messages, onChunk }) => {
        attachmentCounts.push(messages[0].attachments?.length ?? 0);
        onChunk(messages[0].content.includes("Format: VOTE") ? "VOTE: Alpha" : "answer");
      },
    };
    const participant = { id: "a", providerId: "test", modelId: "a", displayName: "Alpha" };
    const engine = new DiscussionEngine((providerId) => providerId === "test" ? provider : undefined, DEFAULT_SETTINGS, {
      attachments: [{ name: "context.md", mimeType: "text/markdown", type: "text", data: "Y29udGV4dA==" }],
    });
    await engine.run("Theme", 2, [participant], [{ ...participant }]);
    expect(attachmentCounts).toEqual([1, 0, 0, 0]);
  });
});
