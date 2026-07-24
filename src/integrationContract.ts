import type { DiscussionProviderIntegration } from "./types";

export interface DiscussionIntegrationUnregisterRequest {
  id?: string;
  integration: unknown;
}

export function integrationContractErrors(integration: Partial<DiscussionProviderIntegration>): string[] {
  const errors: string[] = [];
  if (integration.protocolVersion !== 1) errors.push("protocolVersion must be 1");
  if (!integration.id) errors.push("id is required");
  if (!integration.name) errors.push("name is required");
  if (typeof integration.listModels !== "function") errors.push("listModels is required");
  if (typeof integration.streamText !== "function") errors.push("streamText is required");
  return errors;
}

export function shouldUnregisterIntegration(
  current: unknown,
  request: DiscussionIntegrationUnregisterRequest,
): boolean {
  return Boolean(request.id && current && request.integration && current === request.integration);
}
