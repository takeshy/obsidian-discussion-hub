import {
  USER_MODEL_ID,
  USER_PROVIDER_ID,
  type DiscussionHubSettings,
  type LegacyDiscussionSettings,
} from "./types";

export function mergeLegacySettings(
  current: DiscussionHubSettings,
  providerId: string,
  legacy: LegacyDiscussionSettings,
): DiscussionHubSettings {
  const ref = (model: string) => model === "user"
    ? { providerId: USER_PROVIDER_ID, modelId: USER_MODEL_ID }
    : { providerId, modelId: model };
  return {
    ...current,
    systemPrompt: legacy.systemPrompt || current.systemPrompt,
    conclusionPrompt: legacy.conclusionPrompt || current.conclusionPrompt,
    votePrompt: legacy.votePrompt || current.votePrompt,
    outputFolder: legacy.outputFolder || current.outputFolder,
    defaultTurns: legacy.defaultTurns || current.defaultTurns,
    participants: (legacy.participants ?? []).map((item, index) => ({
      id: item.id || `legacy-participant-${index}`,
      ...ref(item.model),
      displayName: item.displayName || item.model,
      role: item.role,
    })),
    voters: (legacy.voters ?? []).map((item, index) => ({
      id: item.id || `legacy-voter-${index}`,
      ...ref(item.model),
      displayName: item.displayName || item.model,
    })),
  };
}
