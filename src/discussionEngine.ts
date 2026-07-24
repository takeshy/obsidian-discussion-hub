import type {
  DiscussionAttachment,
  DiscussionConclusion,
  DiscussionParticipant,
  DiscussionProviderIntegration,
  DiscussionResponse,
  DiscussionResult,
  DiscussionSettings,
  DiscussionTurn,
  DiscussionVoteResult,
  DiscussionVoter,
} from "./types";
import { USER_MODEL_ID, USER_PROVIDER_ID } from "./types";

export type DiscussionPhase = "idle" | "thinking" | "concluding" | "voting" | "complete" | "error";

export interface UserInputRequest {
  type: "debate" | "vote";
  participantId: string;
  displayName: string;
  role?: string;
  candidates?: Array<{ id: string; displayName: string }>;
}

export interface UserInputResponse {
  content: string;
  votedForId?: string;
  reason?: string;
}

export interface DiscussionCallbacks {
  onPhaseChange?: (phase: DiscussionPhase) => void;
  onTurnStart?: (turn: number) => void;
  onResponseStream?: (participantId: string, content: string) => void;
  onTurnComplete?: (turn: DiscussionTurn) => void;
  onConclusionStream?: (participantId: string, content: string) => void;
  onVoteComplete?: (vote: DiscussionVoteResult) => void;
  onComplete?: (result: DiscussionResult) => void;
  onUserInputRequest?: (request: UserInputRequest) => Promise<UserInputResponse>;
}

export interface DiscussionEngineOptions {
  attachments?: DiscussionAttachment[];
  referenceContext?: string;
}

export type ProviderResolver = (providerId: string) => DiscussionProviderIntegration | undefined;

class DiscussionAbortError extends Error {
  constructor() {
    super("Discussion aborted");
    this.name = "AbortError";
  }
}

function isUser(ref: { providerId: string; modelId: string }): boolean {
  return ref.providerId === USER_PROVIDER_ID && ref.modelId === USER_MODEL_ID;
}

export class DiscussionEngine {
  private abortController: AbortController | null = null;
  private callbacks: DiscussionCallbacks = {};

  constructor(
    private readonly resolveProvider: ProviderResolver,
    private readonly settings: DiscussionSettings,
    private readonly options: DiscussionEngineOptions = {},
  ) {}

  setCallbacks(callbacks: DiscussionCallbacks): void {
    this.callbacks = callbacks;
  }

  stop(): void {
    this.abortController?.abort();
  }

  async run(
    theme: string,
    turnCount: number,
    participants: DiscussionParticipant[],
    voters: DiscussionVoter[],
  ): Promise<DiscussionResult> {
    if (!theme.trim()) throw new Error("Discussion theme is required.");
    if (participants.length === 0) throw new Error("At least one participant is required.");
    if (voters.length === 0) throw new Error("At least one voter is required.");
    this.abortController = new AbortController();
    const startTime = Date.now();
    const turns: DiscussionTurn[] = [];

    try {
      this.callbacks.onPhaseChange?.("thinking");
      for (let index = 1; index <= Math.max(1, turnCount); index += 1) {
        this.assertRunning();
        this.callbacks.onTurnStart?.(index);
        const context = this.turnPrompt(theme, turns, index);
        const responses = await Promise.all(participants.map((participant) => this.respond(participant, context, index === 1)));
        const turn = { turnNumber: index, responses, timestamp: Date.now() };
        turns.push(turn);
        this.callbacks.onTurnComplete?.(turn);
      }

      this.callbacks.onPhaseChange?.("concluding");
      const conclusionPrompt = this.conclusionPrompt(theme, turns);
      const conclusions = (await Promise.all(participants.map((participant) => this.conclude(participant, conclusionPrompt))))
        .filter((value): value is DiscussionConclusion => value !== null);
      if (conclusions.length === 0) throw new Error("No participant produced a conclusion.");

      this.callbacks.onPhaseChange?.("voting");
      const votingPrompt = this.votingPrompt(theme, conclusions);
      const votes = await Promise.all(voters.map((voter) => this.vote(voter, votingPrompt, conclusions)));
      const winnerIds = this.determineWinners(votes, conclusions);
      const finalConclusion = winnerIds.map((id) => conclusions.find((item) => item.participantId === id)?.content || "")
        .filter(Boolean).join("\n\n---\n\n");
      const result: DiscussionResult = {
        theme,
        turns,
        conclusions,
        votes,
        winnerId: winnerIds.length === 1 ? winnerIds[0] : null,
        winnerIds,
        isDraw: winnerIds.length > 1,
        finalConclusion,
        startTime,
        endTime: Date.now(),
        participants,
        voters,
      };
      this.callbacks.onPhaseChange?.("complete");
      this.callbacks.onComplete?.(result);
      return result;
    } catch (error) {
      if (this.abortController.signal.aborted) throw new DiscussionAbortError();
      this.callbacks.onPhaseChange?.("error");
      throw error;
    }
  }

  private assertRunning(): void {
    if (this.abortController?.signal.aborted) throw new DiscussionAbortError();
  }

  private async stream(
    ref: { providerId: string; modelId: string },
    prompt: string,
    onContent?: (content: string) => void,
    includeAttachments = false,
  ): Promise<string> {
    this.assertRunning();
    const provider = this.resolveProvider(ref.providerId);
    if (!provider) throw new Error(`Discussion provider is unavailable: ${ref.providerId}`);
    let content = "";
    await provider.streamText({
      modelId: ref.modelId,
      messages: [{
        role: "user",
        content: prompt,
        attachments: includeAttachments ? this.options.attachments : undefined,
      }],
      systemPrompt: this.settings.systemPrompt + (includeAttachments && this.options.referenceContext ? `\n\n${this.options.referenceContext}` : ""),
      abortSignal: this.abortController?.signal,
      onChunk: (chunk) => {
        content += chunk;
        onContent?.(content);
      },
    });
    this.assertRunning();
    if (!content.trim()) throw new Error(`${provider.name} returned an empty response.`);
    return content.trim();
  }

  private async respond(participant: DiscussionParticipant, prompt: string, firstTurn: boolean): Promise<DiscussionResponse> {
    try {
      let content: string;
      if (isUser(participant)) {
        const input = await this.callbacks.onUserInputRequest?.({
          type: "debate", participantId: participant.id, displayName: participant.displayName, role: participant.role,
        });
        content = input?.content.trim() || "";
      } else {
        const rolePrompt = participant.role ? `${prompt}\n\nYour position: ${participant.role}` : prompt;
        content = await this.stream(participant, rolePrompt, (value) => this.callbacks.onResponseStream?.(participant.id, value), firstTurn);
      }
      return { participantId: participant.id, displayName: participant.displayName, content, isConclusion: false, timestamp: Date.now() };
    } catch (error) {
      if (this.abortController?.signal.aborted) throw error;
      return { participantId: participant.id, displayName: participant.displayName, content: "", isConclusion: false, timestamp: Date.now(), error: String(error) };
    }
  }

  private async conclude(participant: DiscussionParticipant, prompt: string): Promise<DiscussionConclusion | null> {
    try {
      let content: string;
      if (isUser(participant)) {
        const input = await this.callbacks.onUserInputRequest?.({
          type: "debate", participantId: participant.id, displayName: participant.displayName, role: participant.role,
        });
        content = input?.content.trim() || "";
      } else {
        content = await this.stream(participant, participant.role ? `${prompt}\n\nYour position: ${participant.role}` : prompt,
          (value) => this.callbacks.onConclusionStream?.(participant.id, value));
      }
      return content ? { participantId: participant.id, displayName: participant.displayName, content } : null;
    } catch (error) {
      if (this.abortController?.signal.aborted) throw error;
      return null;
    }
  }

  private async vote(voter: DiscussionVoter, prompt: string, conclusions: DiscussionConclusion[]): Promise<DiscussionVoteResult> {
    let result: DiscussionVoteResult;
    if (isUser(voter)) {
      const input = await this.callbacks.onUserInputRequest?.({
        type: "vote",
        participantId: voter.id,
        displayName: voter.displayName,
        candidates: conclusions.map((item) => ({ id: item.participantId, displayName: item.displayName })),
      });
      const candidate = conclusions.find((item) => item.participantId === input?.votedForId);
      result = {
        voterId: voter.id,
        voterDisplayName: voter.displayName,
        votedForId: candidate?.participantId || "",
        votedForDisplayName: candidate?.displayName || "(invalid vote)",
        reason: input?.reason,
      };
    } else {
      try {
        result = this.parseVote(voter, await this.stream(voter, prompt), conclusions);
      } catch (error) {
        if (this.abortController?.signal.aborted) throw error;
        result = { voterId: voter.id, voterDisplayName: voter.displayName, votedForId: "", votedForDisplayName: "(error)", reason: String(error) };
      }
    }
    this.callbacks.onVoteComplete?.(result);
    return result;
  }

  private turnPrompt(theme: string, turns: DiscussionTurn[], currentTurn: number): string {
    const history = turns.map((turn) => `## Turn ${turn.turnNumber}\n${turn.responses.map((item) => `### ${item.displayName}\n${item.content || `[Error: ${item.error}]`}`).join("\n\n")}`).join("\n\n");
    return `# Discussion theme\n${theme}${history ? `\n\n# Previous discussion\n${history}` : ""}\n\n# Your task\nRespond for turn ${currentTurn}. Build on, challenge, or refine the positions shared so far.`;
  }

  private conclusionPrompt(theme: string, turns: DiscussionTurn[]): string {
    return `${this.turnPrompt(theme, turns, turns.length + 1)}\n\n${this.settings.conclusionPrompt}`;
  }

  private votingPrompt(theme: string, conclusions: DiscussionConclusion[]): string {
    const text = conclusions.map((item) => `## ${item.displayName}\n${item.content}`).join("\n\n");
    return `# Discussion theme\n${theme}\n\n# Final conclusions\n${text}\n\n${this.settings.votePrompt}\nFormat: VOTE: [Name] - [Reason]`;
  }

  private parseVote(voter: DiscussionVoter, response: string, conclusions: DiscussionConclusion[]): DiscussionVoteResult {
    const normalized = response.toLocaleLowerCase();
    const candidates = [...conclusions].sort((a, b) => b.displayName.length - a.displayName.length);
    const match = candidates.find((candidate) => normalized.includes(candidate.displayName.toLocaleLowerCase()));
    const reason = response.match(/(?:reason|理由)[：:]?\s*([\s\S]+)/i)?.[1]?.trim()
      || response.match(/[-–—]\s*([\s\S]+)/)?.[1]?.trim();
    return {
      voterId: voter.id,
      voterDisplayName: voter.displayName,
      votedForId: match?.participantId || "",
      votedForDisplayName: match?.displayName || "(invalid vote)",
      reason: reason || (match ? response.trim() : "Unable to parse vote"),
    };
  }

  private determineWinners(votes: DiscussionVoteResult[], conclusions: DiscussionConclusion[]): string[] {
    const counts = new Map(conclusions.map((item) => [item.participantId, 0]));
    for (const vote of votes) if (counts.has(vote.votedForId)) counts.set(vote.votedForId, (counts.get(vote.votedForId) || 0) + 1);
    const maximum = Math.max(0, ...counts.values());
    return maximum === 0 ? [] : [...counts].filter(([, count]) => count === maximum).map(([id]) => id);
  }

  static toMarkdown(result: DiscussionResult): string {
    const lines = [`# AI Discussion: ${result.theme}`, "", `**Date:** ${new Date(result.startTime).toLocaleString()}`, "", "## Participants", ""];
    for (const participant of result.participants) lines.push(`- ${participant.displayName}${participant.role ? ` (${participant.role})` : ""}`);
    lines.push("", "## Discussion", "");
    for (const turn of result.turns) {
      lines.push(`### Turn ${turn.turnNumber}`, "");
      for (const response of turn.responses) lines.push(`#### ${response.displayName}`, "", response.error ? `> Error: ${response.error}` : response.content, "");
    }
    lines.push("## Conclusions", "");
    for (const conclusion of result.conclusions) lines.push(`### ${conclusion.displayName}`, "", conclusion.content, "");
    lines.push("## Voting Results", "");
    for (const vote of result.votes) lines.push(`- **${vote.voterDisplayName}** → **${vote.votedForDisplayName}**${vote.reason ? `: ${vote.reason}` : ""}`);
    lines.push("", "## Final Conclusion", "", result.finalConclusion || "No winner");
    return lines.join("\n");
  }
}
