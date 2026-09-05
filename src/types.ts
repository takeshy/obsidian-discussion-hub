export type DiscussionRole = "user" | "assistant";
export type ActivityMode = "discussion" | "riddle" | "keyword-wolf";

export interface DiscussionAttachment {
  name: string;
  mimeType: string;
  data: string;
  type?: "image" | "pdf" | "text" | "audio" | "video";
  sourcePath?: string;
}

export interface DiscussionMessage {
  role: DiscussionRole;
  content: string;
  attachments?: DiscussionAttachment[];
}

export interface DiscussionModel {
  id: string;
  name: string;
  description?: string;
  attachmentMimeTypes?: string[];
}

export interface DiscussionStreamRequest {
  modelId: string;
  messages: DiscussionMessage[];
  systemPrompt: string;
  abortSignal?: AbortSignal;
  onChunk: (text: string) => void;
}

export interface LegacyDiscussionSettings {
  systemPrompt?: string;
  conclusionPrompt?: string;
  votePrompt?: string;
  outputFolder?: string;
  defaultTurns?: number;
  participants?: Array<{ id?: string; model: string; displayName?: string; role?: string }>;
  voters?: Array<{ id?: string; model: string; displayName?: string }>;
}

export interface DiscussionProviderIntegration {
  protocolVersion: 1;
  id: string;
  name: string;
  listModels: () => Promise<DiscussionModel[]>;
  streamText: (request: DiscussionStreamRequest) => Promise<void>;
  getLegacyDiscussionSettings?: () => Promise<LegacyDiscussionSettings | null> | LegacyDiscussionSettings | null;
}

export interface DiscussionProviderRef {
  providerId: string;
  modelId: string;
}

export interface DiscussionParticipant extends DiscussionProviderRef {
  id: string;
  displayName: string;
  role?: string;
}

export interface DiscussionVoter extends DiscussionProviderRef {
  id: string;
  displayName: string;
  privateInstruction?: string;
  excludedParticipantId?: string;
}

export interface DiscussionResponse {
  participantId: string;
  displayName: string;
  content: string;
  isConclusion: boolean;
  timestamp: number;
  error?: string;
}

export interface DiscussionTurn {
  turnNumber: number;
  responses: DiscussionResponse[];
  timestamp: number;
}

export interface DiscussionConclusion {
  participantId: string;
  displayName: string;
  content: string;
}

export interface DiscussionVoteResult {
  voterId: string;
  voterDisplayName: string;
  votedForId: string;
  votedForDisplayName: string;
  reason?: string;
}

export interface DiscussionResult {
  theme: string;
  turns: DiscussionTurn[];
  conclusions: DiscussionConclusion[];
  votes: DiscussionVoteResult[];
  winnerId: string | null;
  winnerIds: string[];
  isDraw: boolean;
  finalConclusion: string;
  startTime: number;
  endTime: number;
  participants: DiscussionParticipant[];
  voters: DiscussionVoter[];
  activityMode?: ActivityMode;
  keywordWolfReveal?: string;
}

export interface DiscussionSettings {
  systemPrompt: string;
  conclusionPrompt: string;
  votePrompt: string;
  outputFolder: string;
  defaultTurns: number;
  participants: DiscussionParticipant[];
  voters: DiscussionVoter[];
  allowDrawVote: boolean;
}

/** Saved settings plus the overrides an activity applies to a single run. Never persisted. */
export interface DiscussionRunSettings extends DiscussionSettings {
  enableVoting?: boolean;
  activityMode?: ActivityMode;
}

export interface DiscussionHubSettings extends DiscussionSettings {
  importedLegacyProviders: string[];
}

export interface OpenDiscussionRequest {
  theme?: string;
  attachments?: DiscussionAttachment[];
}

export interface RunDiscussionRequest extends OpenDiscussionRequest {
  turns?: number;
  participants?: DiscussionParticipant[];
  voters?: DiscussionVoter[];
  abortSignal?: AbortSignal;
}

export const USER_PROVIDER_ID = "discussion-hub";
export const USER_MODEL_ID = "user";

export const DEFAULT_SETTINGS: DiscussionHubSettings = {
  systemPrompt: "You are participating in a structured discussion. Give a clear, substantive response and engage with the other positions.",
  conclusionPrompt: "Based on the discussion, provide your final conclusion.",
  votePrompt: "Vote for the strongest conclusion and briefly explain why.",
  outputFolder: "discussions",
  defaultTurns: 2,
  participants: [],
  voters: [],
  allowDrawVote: true,
  importedLegacyProviders: [],
};
