import { describe, expect, it } from "vitest";
import { integrationContractErrors, shouldUnregisterIntegration } from "./integrationContract";
import type { DiscussionProviderIntegration } from "./types";

function adapter(id = "provider"): DiscussionProviderIntegration {
  return {
    protocolVersion: 1,
    id,
    name: id,
    listModels: async () => [{ id: "model", name: "Model" }],
    streamText: async ({ onChunk }) => { onChunk("ok"); },
  };
}

describe("discussion integration contract", () => {
  it("accepts the versioned provider contract", () => {
    expect(integrationContractErrors(adapter())).toEqual([]);
  });

  it("requires the streaming entry point", () => {
    expect(integrationContractErrors({ protocolVersion: 1, id: "x", name: "X", listModels: async () => [] }))
      .toContain("streamText is required");
  });

  it("only unregisters the same adapter instance", () => {
    const current = adapter();
    expect(shouldUnregisterIntegration(current, { id: current.id, integration: current })).toBe(true);
    expect(shouldUnregisterIntegration(current, { id: current.id, integration: adapter() })).toBe(false);
  });
});
