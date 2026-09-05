import { describe, expect, it } from "vitest";
import { DiscussionEngine, stripCardFormatting } from "./discussionEngine";
import { DEFAULT_SETTINGS, USER_MODEL_ID, USER_PROVIDER_ID, type DiscussionProviderIntegration } from "./types";

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
        onChunk(prompt.includes("Eligible voting targets") ? "VOTE: Alpha - best" : `${modelId} answer`);
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
        onChunk(messages[0].content.includes("Eligible voting targets") ? "VOTE: Alpha" : "answer");
      },
    };
    const participant = { id: "a", providerId: "test", modelId: "a", displayName: "Alpha" };
    const engine = new DiscussionEngine((providerId) => providerId === "test" ? provider : undefined, DEFAULT_SETTINGS, {
      attachments: [{ name: "context.md", mimeType: "text/markdown", type: "text", data: "Y29udGV4dA==" }],
    });
    await engine.run("Theme", 2, [participant], [{ ...participant }]);
    expect(attachmentCounts).toEqual([1, 0, 0, 0]);
  });

  it("states a participant role once, in the system prompt", async () => {
    const prompts: Array<{ system: string; user: string }> = [];
    const provider: DiscussionProviderIntegration = {
      protocolVersion: 1,
      id: "test",
      name: "Test",
      listModels: async () => [],
      streamText: async ({ messages, systemPrompt, onChunk }) => {
        prompts.push({ system: systemPrompt ?? "", user: messages[0].content });
        onChunk(messages[0].content.includes("Eligible voting targets") ? "VOTE: Alpha" : "answer");
      },
    };
    const participant = { id: "a", providerId: "test", modelId: "a", displayName: "Alpha", role: "Optimist" };
    const engine = new DiscussionEngine((id) => id === "test" ? provider : undefined, DEFAULT_SETTINGS);
    await engine.run("Theme", 1, [participant], [{ id: "v", providerId: "test", modelId: "a", displayName: "Voter" }]);
    const debate = prompts.filter((entry) => !entry.user.includes("Eligible voting targets"));
    expect(debate).not.toHaveLength(0);
    for (const entry of debate) {
      expect(entry.system).toContain("Optimist");
      expect(entry.user).not.toContain("Optimist");
    }
  });

  it("keeps the reason when the voted-for name contains a hyphen", async () => {
    const provider: DiscussionProviderIntegration = {
      protocolVersion: 1,
      id: "test",
      name: "Test",
      listModels: async () => [],
      streamText: async ({ messages, onChunk }) => {
        onChunk(messages[0].content.includes("Eligible voting targets") ? "VOTE: GPT-4 - solid reasoning" : "answer");
      },
    };
    const participant = { id: "a", providerId: "test", modelId: "a", displayName: "GPT-4" };
    const engine = new DiscussionEngine((id) => id === "test" ? provider : undefined, DEFAULT_SETTINGS);
    const result = await engine.run("Theme", 1, [participant], [{ ...participant, id: "v" }]);
    expect(result.votes[0].votedForId).toBe("a");
    expect(result.votes[0].reason).toBe("solid reasoning");
  });

  it("records a draw when voters explicitly choose one", async () => {
    const provider: DiscussionProviderIntegration = {
      protocolVersion: 1,
      id: "test",
      name: "Test",
      listModels: async () => [],
      streamText: async ({ messages, onChunk }) => {
        onChunk(messages[0].content.includes("Eligible voting targets") ? "VOTE: DRAW - both convincing" : "answer");
      },
    };
    const participants = [
      { id: "a", providerId: "test", modelId: "a", displayName: "Alpha" },
      { id: "b", providerId: "test", modelId: "b", displayName: "Beta" },
    ];
    const engine = new DiscussionEngine((id) => id === "test" ? provider : undefined, DEFAULT_SETTINGS);
    const result = await engine.run("Theme", 1, participants, [{ id: "v", providerId: "test", modelId: "a", displayName: "Voter" }]);
    expect(result.isDraw).toBe(true);
    expect(result.winnerId).toBeNull();
    expect(result.votes[0].reason).toBe("both convincing");
  });

  it("carries a slow human answer into the next turn and the conclusion", async () => {
    const prompts: string[] = [];
    const provider: DiscussionProviderIntegration = {
      protocolVersion: 1,
      id: "test",
      name: "Test",
      listModels: async () => [],
      streamText: async ({ messages, onChunk }) => {
        prompts.push(messages[0].content);
        onChunk(messages[0].content.includes("Eligible voting targets") ? "VOTE: AI" : "ai turn");
      },
    };
    const participants = [
      { id: "ai", providerId: "test", modelId: "m", displayName: "AI" },
      { id: "me", providerId: USER_PROVIDER_ID, modelId: USER_MODEL_ID, displayName: "You" },
    ];
    const engine = new DiscussionEngine((id) => id === "test" ? provider : undefined, DEFAULT_SETTINGS);
    let asked = 0;
    engine.setCallbacks({
      // The human answers long after the models have finished their own turn.
      onUserInputRequest: async () => {
        asked += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { content: `私の意見${asked}` };
      },
    });
    await engine.run("Theme", 2, participants, [{ id: "v", providerId: "test", modelId: "m", displayName: "Voter" }]);

    const turnTwo = prompts.find((prompt) => prompt.includes("Respond for turn 2"));
    expect(turnTwo).toContain("### You");
    expect(turnTwo).toContain("私の意見1");
    const conclusion = prompts.find((prompt) => prompt.includes(DEFAULT_SETTINGS.conclusionPrompt));
    expect(conclusion).toContain("私の意見1");
    expect(conclusion).toContain("私の意見2");
  });

  it("keeps only the answer when a model copies the transcript format", () => {
    expect(stripCardFormatting(
      "**Question to everyone:** いろんな種類がありますか？\n\n**My answer:** はい、たくさんあります。",
      "Gemini (gemini-3.8-flash)",
    )).toBe("はい、たくさんあります。");
    expect(stripCardFormatting("**Gemini (gemini-3.8-flash):** はい。", "Gemini (gemini-3.8-flash)")).toBe("はい。");
    expect(stripCardFormatting("Question to everyone: 何色ですか？", "Beta")).toBe("Question to everyone: 何色ですか？");
    expect(stripCardFormatting("色は決まっていません。", "Beta")).toBe("色は決まっていません。");
  });

  it("omits empty note sections and keeps the Keyword Wolf reveal", () => {
    const markdown = DiscussionEngine.toMarkdown({
      theme: "Keyword Wolf",
      turns: [],
      conclusions: [{ participantId: "a", displayName: "Alpha", content: "" }],
      votes: [{ voterId: "v", voterDisplayName: "Beta", votedForId: "a", votedForDisplayName: "Alpha" }],
      winnerId: "a",
      winnerIds: ["a"],
      isDraw: false,
      finalConclusion: "",
      startTime: 0,
      endTime: 1,
      participants: [],
      voters: [],
      activityMode: "keyword-wolf",
      keywordWolfReveal: "The Keyword Wolf was Alpha.",
    });
    expect(markdown).not.toContain("## Conclusions");
    expect(markdown).not.toContain("## Final Conclusion");
    expect(markdown).toContain("The Keyword Wolf was Alpha.");
  });
});
