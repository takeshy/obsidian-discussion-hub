import type {
  DiscussionAttachment,
  DiscussionConclusion,
  DiscussionParticipant,
  DiscussionProviderIntegration,
  DiscussionResponse,
  DiscussionResult,
  DiscussionRunSettings,
  DiscussionTurn,
  DiscussionVoteResult,
  DiscussionVoter,
} from "./types";
import { USER_MODEL_ID, USER_PROVIDER_ID } from "./types";

export const DRAW_VOTE_ID = "__discussion_draw__";

export type DiscussionPhase = "idle" | "thinking" | "concluding" | "voting" | "complete" | "error";

export interface UserInputRequest {
  type: "debate" | "vote" | "question" | "answer";
  participantId: string;
  displayName: string;
  role?: string;
  candidates?: Array<{ id: string; displayName: string }>;
  targetDisplayName?: string;
  question?: string;
}

export interface UserInputResponse {
  content: string;
  votedForId?: string;
  reason?: string;
  targetId?: string;
  cancelled?: boolean;
}

export interface DiscussionCallbacks {
  onPhaseChange?: (phase: DiscussionPhase) => void;
  onTurnStart?: (turn: number) => void;
  onResponseStream?: (participantId: string, content: string) => void;
  onTurnComplete?: (turn: DiscussionTurn) => void;
  onConclusionStream?: (participantId: string, content: string) => void;
  onConclusionComplete?: (conclusion: DiscussionConclusion) => void;
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

/** An empty turn is a participant that said nothing, not a failure; models should not read it as one. */
function responseText(response: DiscussionResponse): string {
  return response.content || (response.error ? `[Error: ${response.error}]` : "[No response]");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Models sometimes copy the rendered card format; keep only the question or answer itself. */
export function stripCardFormatting(text: string, speaker?: string): string {
  const label = "\\s*\\**\\s*[：:]\\s*\\**\\s*";
  const stripped = text
    .replace(/^\s*\**\s*(?:Question to [^\n:：]*|質問)\s*\**\s*[：:][^\n]*(?:\n+|$)/i, "")
    .replace(new RegExp(`^\\s*\\**\\s*(?:QUESTION|My answer|Answer|回答|答え)${label}`, "i"), "")
    .replace(speaker ? new RegExp(`^\\s*\\**\\s*${escapeRegExp(speaker)}${label}`, "i") : /(?!)/, "")
    .trim();
  // Nothing left means the model wrote only the echo; show that rather than a blank answer.
  return stripped || text.trim();
}

export class DiscussionEngine {
  private abortController: AbortController | null = null;
  private callbacks: DiscussionCallbacks = {};
  private userInputQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly resolveProvider: ProviderResolver,
    private readonly settings: DiscussionRunSettings,
    private readonly options: DiscussionEngineOptions = {},
  ) {}

  setCallbacks(callbacks: DiscussionCallbacks): void {
    this.callbacks = callbacks;
  }

  stop(): void {
    this.abortController?.abort();
  }

  private requestUserInput(request: UserInputRequest): Promise<UserInputResponse | undefined> {
    const pending = this.userInputQueue.then(() => this.callbacks.onUserInputRequest?.(request));
    this.userInputQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async run(
    theme: string,
    turnCount: number,
    participants: DiscussionParticipant[],
    voters: DiscussionVoter[],
  ): Promise<DiscussionResult> {
    if (!theme.trim()) throw new Error("Discussion theme is required.");
    if (participants.length === 0) throw new Error("At least one participant is required.");
    if (this.settings.enableVoting !== false && voters.length === 0) throw new Error("At least one voter is required.");
    this.abortController = new AbortController();
    const startTime = Date.now();
    const turns: DiscussionTurn[] = [];
    const totalTurns = Math.max(1, turnCount);

    try {
      this.callbacks.onPhaseChange?.("thinking");
      for (let index = 1; index <= totalTurns; index += 1) {
        this.assertRunning();
        this.callbacks.onTurnStart?.(index);
        const context = this.turnPrompt(theme, turns, index);
        const responses = this.settings.activityMode === "keyword-wolf"
          ? await this.runKeywordWolfTurn(theme, turns, participants, index, totalTurns)
          : await Promise.all(participants.map((participant) => this.respond(participant, context, index === 1)));
        const turn = { turnNumber: index, responses, timestamp: Date.now() };
        turns.push(turn);
        this.callbacks.onTurnComplete?.(turn);
      }

      let conclusions: DiscussionConclusion[];
      if (this.settings.activityMode === "keyword-wolf") {
        // Keyword Wolf votes directly for players; it has no separate conclusion turn.
        conclusions = participants.map((participant) => ({
          participantId: participant.id,
          displayName: participant.displayName,
          content: "",
        }));
      } else {
        this.callbacks.onPhaseChange?.("concluding");
        const conclusionPrompt = this.conclusionPrompt(theme, turns);
        conclusions = (await Promise.all(participants.map((participant) => this.conclude(participant, conclusionPrompt))))
          .filter((value): value is DiscussionConclusion => value !== null);
      }
      if (conclusions.length === 0) throw new Error("No participant produced a conclusion.");

      let votes: DiscussionVoteResult[] = [];
      let winnerIds: string[] = [];
      if (this.settings.enableVoting !== false) {
        this.callbacks.onPhaseChange?.("voting");
        const votingPrompt = this.votingPrompt(theme, conclusions, turns);
        votes = await Promise.all(voters.map((voter) => this.vote(voter, votingPrompt, conclusions)));
        winnerIds = this.determineWinners(votes, conclusions);
      }
      const finalConclusion = this.settings.enableVoting === false
        ? conclusions.map((item) => `## ${item.displayName}\n${item.content}`).join("\n\n")
        : winnerIds.map((id) => conclusions.find((item) => item.participantId === id)?.content || "")
          .filter(Boolean).join("\n\n---\n\n");
      const explicitDraw = votes.some((vote) => vote.votedForId === DRAW_VOTE_ID)
        && winnerIds.length === conclusions.length;
      const isDraw = winnerIds.length > 1 || explicitDraw;
      const result: DiscussionResult = {
        theme,
        turns,
        conclusions,
        votes,
        winnerId: isDraw ? null : winnerIds.length === 1 ? winnerIds[0] : null,
        winnerIds,
        isDraw,
        finalConclusion,
        startTime,
        endTime: Date.now(),
        participants,
        voters,
        activityMode: this.settings.activityMode,
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
    const privateInstruction = "privateInstruction" in ref && ref.privateInstruction
      ? String(ref.privateInstruction)
      : "role" in ref && ref.role ? String(ref.role) : "";
    await provider.streamText({
      modelId: ref.modelId,
      messages: [{
        role: "user",
        content: prompt,
        attachments: includeAttachments ? this.options.attachments : undefined,
      }],
      systemPrompt: this.settings.systemPrompt
        + (privateInstruction ? `\n\n${privateInstruction}` : "")
        + (includeAttachments && this.options.referenceContext ? `\n\n${this.options.referenceContext}` : ""),
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
        const input = await this.requestUserInput({
          type: "debate", participantId: participant.id, displayName: participant.displayName, role: participant.role,
        });
        content = input?.content.trim() || "";
      } else {
        content = await this.stream(participant, prompt, (value) => this.callbacks.onResponseStream?.(participant.id, value), firstTurn);
      }
      return { participantId: participant.id, displayName: participant.displayName, content, isConclusion: false, timestamp: Date.now() };
    } catch (error) {
      if (this.abortController?.signal.aborted) throw error;
      return { participantId: participant.id, displayName: participant.displayName, content: "", isConclusion: false, timestamp: Date.now(), error: String(error) };
    }
  }

  private async runKeywordWolfTurn(
    theme: string,
    previousTurns: DiscussionTurn[],
    participants: DiscussionParticipant[],
    turnNumber: number,
    totalTurns: number,
  ): Promise<DiscussionResponse[]> {
    if (participants.length < 2) throw new Error("Keyword Wolf requires at least two participants.");
    const history = this.keywordWolfHistory(theme, previousTurns);
    // The closing round is a one-on-one interrogation; every earlier round questions everyone.
    const specificTargetRound = totalTurns > 1 && turnNumber === totalTurns;
    return Promise.all(participants.map(async (asker, askerIndex) => {
      this.assertRunning();
      const candidates = participants.filter((participant) => participant.id !== asker.id);
      let target = candidates[askerIndex % candidates.length];
      let question = "";
      const answers = new Map<string, string>();
      const publish = () => {
        const renderedAnswers = candidates
          .filter((participant) => !specificTargetRound || participant.id === target.id)
          .filter((participant) => answers.has(participant.id))
          .map((participant) => `**${participant.displayName}:** ${answers.get(participant.id)}`);
        const content = `**Question to ${specificTargetRound ? target.displayName : "everyone"}:** ${question}`
          + (renderedAnswers.length > 0 ? `\n\n${renderedAnswers.join("\n\n")}` : "");
        this.callbacks.onResponseStream?.(asker.id, content);
        return content;
      };
      if (isUser(asker)) {
        const input = await this.requestUserInput({
          type: "question",
          participantId: asker.id,
          displayName: asker.displayName,
          role: asker.role,
          targetDisplayName: specificTargetRound ? target.displayName : "everyone else",
          candidates: specificTargetRound ? candidates.map((participant) => ({ id: participant.id, displayName: participant.displayName })) : undefined,
        });
        if (specificTargetRound) target = candidates.find((participant) => participant.id === input?.targetId) ?? target;
        question = input?.content.trim() || "";
      } else {
        const rawQuestion = await this.stream(
          asker,
          specificTargetRound
            ? `${history}\n\n# Your task\nChoose one player to question. Candidates: ${candidates.map((participant) => participant.displayName).join(", ")}. Do not say your keyword.\nFormat:\nTARGET: [Name]\nQUESTION: [Question]`
            : `${history}\n\n# Your task\nAsk every other player one concise question that helps compare their keywords without saying your own keyword. Reply with the question text only.`,
          (content) => { question = stripCardFormatting(content); publish(); },
        );
        if (specificTargetRound) {
          const normalized = rawQuestion.toLocaleLowerCase();
          target = [...candidates].sort((a, b) => b.displayName.length - a.displayName.length)
            .find((participant) => normalized.includes(participant.displayName.toLocaleLowerCase())) ?? target;
          question = rawQuestion.match(/QUESTION\s*[：:]\s*([\s\S]+)/i)?.[1]?.trim() || rawQuestion.replace(/^TARGET[^\n]*\n?/i, "").trim();
        } else question = stripCardFormatting(rawQuestion);
      }
      publish();

      const respondents = specificTargetRound ? [target] : candidates;
      await Promise.all(respondents.map(async (respondent) => {
        let answer = "";
        if (isUser(respondent)) {
          answer = (await this.requestUserInput({
            type: "answer",
            participantId: respondent.id,
            displayName: respondent.displayName,
            role: respondent.role,
            targetDisplayName: asker.displayName,
            question,
          }))?.content.trim() || "";
        } else {
          answer = stripCardFormatting(await this.stream(
            respondent,
            `${history}\n\n# Your task\n${asker.displayName} asks ${specificTargetRound ? "you" : "everyone"}: ${question}`
              + "\nReply with your answer only: do not repeat the question, do not prefix your name, and never write your secret keyword.",
            (content) => { answers.set(respondent.id, stripCardFormatting(content, respondent.displayName)); publish(); },
          ), respondent.displayName);
        }
        answers.set(respondent.id, answer);
        publish();
      }));
      return {
        participantId: asker.id,
        displayName: asker.displayName,
        content: publish(),
        isConclusion: false,
        timestamp: Date.now(),
      };
    }));
  }

  private async conclude(participant: DiscussionParticipant, prompt: string): Promise<DiscussionConclusion | null> {
    try {
      let content: string;
      if (isUser(participant)) {
        const input = await this.requestUserInput({
          type: "debate", participantId: participant.id, displayName: participant.displayName, role: participant.role,
        });
        content = input?.content.trim() || "";
      } else {
        content = await this.stream(participant, prompt, (value) => this.callbacks.onConclusionStream?.(participant.id, value));
      }
      if (!content) return null;
      const conclusion = { participantId: participant.id, displayName: participant.displayName, content };
      this.callbacks.onConclusionComplete?.(conclusion);
      return conclusion;
    } catch (error) {
      if (this.abortController?.signal.aborted) throw error;
      return null;
    }
  }

  private async vote(voter: DiscussionVoter, prompt: string, conclusions: DiscussionConclusion[]): Promise<DiscussionVoteResult> {
    let result: DiscussionVoteResult;
    const eligibleConclusions = voter.excludedParticipantId
      ? conclusions.filter((item) => item.participantId !== voter.excludedParticipantId)
      : conclusions;
    if (isUser(voter)) {
      const input = await this.requestUserInput({
        type: "vote",
        participantId: voter.id,
        displayName: voter.displayName,
        candidates: [
          ...eligibleConclusions.map((item) => ({ id: item.participantId, displayName: item.displayName })),
          ...(this.settings.allowDrawVote ? [{ id: DRAW_VOTE_ID, displayName: "Draw" }] : []),
        ],
      });
      const candidate = eligibleConclusions.find((item) => item.participantId === input?.votedForId);
      const drawVote = this.settings.allowDrawVote && input?.votedForId === DRAW_VOTE_ID;
      result = {
        voterId: voter.id,
        voterDisplayName: voter.displayName,
        votedForId: drawVote ? DRAW_VOTE_ID : candidate?.participantId || "",
        votedForDisplayName: drawVote ? "Draw" : candidate?.displayName || "(invalid vote)",
        reason: input?.reason,
      };
    } else {
      try {
        const self = voter.excludedParticipantId
          ? conclusions.find((item) => item.participantId === voter.excludedParticipantId)?.displayName
          : undefined;
        const candidateList = eligibleConclusions
          .map((candidate, index) => `CANDIDATE_${index + 1}: ${candidate.displayName}`)
          .join("\n");
        const voterPrompt = `${prompt}${self ? `\n\nYou are ${self}. You cannot vote for yourself.` : ""}`
          + `\n\n# Eligible voting targets\n${candidateList}`
          + "\n\nRespond with: VOTE: CANDIDATE_[number] - [Reason]"
          + (this.settings.allowDrawVote ? "\nIf no side deserves to win, respond with: VOTE: DRAW - [Reason]" : "");
        result = this.parseVote(voter, await this.stream(voter, voterPrompt), eligibleConclusions);
      } catch (error) {
        if (this.abortController?.signal.aborted) throw error;
        result = { voterId: voter.id, voterDisplayName: voter.displayName, votedForId: "", votedForDisplayName: "(error)", reason: String(error) };
      }
    }
    this.callbacks.onVoteComplete?.(result);
    return result;
  }

  private turnPrompt(theme: string, turns: DiscussionTurn[], currentTurn: number): string {
    const history = turns.map((turn) => `## Turn ${turn.turnNumber}\n${turn.responses.map((item) => `### ${item.displayName}\n${responseText(item)}`).join("\n\n")}`).join("\n\n");
    return `# Discussion theme\n${theme}${history ? `\n\n# Previous discussion\n${history}` : ""}\n\n# Your task\nRespond for turn ${currentTurn}. Build on, challenge, or refine the positions shared so far.`;
  }

  private keywordWolfHistory(theme: string, turns: DiscussionTurn[]): string {
    const rounds = turns.map((turn) => `## Round ${turn.turnNumber}\n${turn.responses
      .map((item) => `### Asked by ${item.displayName}\n${responseText(item)}`).join("\n\n")}`).join("\n\n");
    return `# Game\n${theme}${rounds ? `\n\n# Rounds so far\n${rounds}` : ""}`;
  }

  private conclusionPrompt(theme: string, turns: DiscussionTurn[]): string {
    return `${this.turnPrompt(theme, turns, turns.length + 1)}\n\n${this.settings.conclusionPrompt}`;
  }

  private votingPrompt(theme: string, conclusions: DiscussionConclusion[], turns: DiscussionTurn[]): string {
    // Each voter appends its own eligible-candidate list and response format, because
    // a voter may be barred from voting for itself.
    if (this.settings.activityMode === "keyword-wolf") {
      return `${this.keywordWolfHistory(theme, turns)}\n\n${this.settings.votePrompt}`;
    }
    const text = conclusions.map((item) => `## ${item.displayName}\n${item.content}`).join("\n\n");
    return `# Discussion theme\n${theme}\n\n# Final conclusions\n${text}\n\n${this.settings.votePrompt}`;
  }

  /** Reads the reason that follows the vote itself, so hyphens inside a name are not mistaken for the separator. */
  private static voteReason(response: string, from: number): string | undefined {
    const rest = response.slice(from);
    return rest.match(/(?:reason|理由)\s*[：:]\s*([\s\S]+)/i)?.[1]?.trim()
      || rest.match(/[-–—]\s*([\s\S]+)/)?.[1]?.trim();
  }

  private parseVote(voter: DiscussionVoter, response: string, conclusions: DiscussionConclusion[]): DiscussionVoteResult {
    const draw = this.settings.allowDrawVote ? response.match(/(?:VOTE|投票)\s*[：:]\s*(?:DRAW|引き分け)/i) : null;
    if (draw) {
      return {
        voterId: voter.id,
        voterDisplayName: voter.displayName,
        votedForId: DRAW_VOTE_ID,
        votedForDisplayName: "Draw",
        reason: DiscussionEngine.voteReason(response, (draw.index ?? 0) + draw[0].length),
      };
    }
    const numbered = response.match(/(?:VOTE|投票(?:先)?)\s*[：:]\s*(?:CANDIDATE[_\s-]*)?(\d+)/i);
    const numberedCandidate = numbered ? conclusions[Number(numbered[1]) - 1] : undefined;
    if (numbered && numberedCandidate) {
      return {
        voterId: voter.id,
        voterDisplayName: voter.displayName,
        votedForId: numberedCandidate.participantId,
        votedForDisplayName: numberedCandidate.displayName,
        reason: DiscussionEngine.voteReason(response, (numbered.index ?? 0) + numbered[0].length),
      };
    }
    const normalized = response.toLocaleLowerCase();
    const candidates = [...conclusions].sort((a, b) => b.displayName.length - a.displayName.length);
    const match = candidates.find((candidate) => normalized.includes(candidate.displayName.toLocaleLowerCase()));
    const nameEnd = match ? normalized.indexOf(match.displayName.toLocaleLowerCase()) + match.displayName.length : 0;
    const reason = DiscussionEngine.voteReason(response, nameEnd);
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
    const drawVotes = this.settings.allowDrawVote ? votes.filter((vote) => vote.votedForId === DRAW_VOTE_ID).length : 0;
    const maximum = Math.max(0, ...counts.values());
    if (drawVotes > 0 && drawVotes >= maximum) return conclusions.map((item) => item.participantId);
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
    const conclusions = result.conclusions.filter((conclusion) => conclusion.content.trim());
    if (conclusions.length > 0) {
      lines.push("## Conclusions", "");
      for (const conclusion of conclusions) lines.push(`### ${conclusion.displayName}`, "", conclusion.content, "");
    }
    if (result.votes.length > 0) {
      lines.push("## Voting Results", "");
      for (const vote of result.votes) lines.push(`- **${vote.voterDisplayName}** → **${vote.votedForDisplayName}**${vote.reason ? `: ${vote.reason}` : ""}`);
      lines.push("");
    }
    if (result.keywordWolfReveal) lines.push("## Reveal", "", result.keywordWolfReveal, "");
    if (result.finalConclusion) lines.push("## Final Conclusion", "", result.finalConclusion);
    else if (result.votes.length > 0 && !result.keywordWolfReveal) lines.push("## Final Conclusion", "", "No winner");
    return lines.join("\n");
  }
}
