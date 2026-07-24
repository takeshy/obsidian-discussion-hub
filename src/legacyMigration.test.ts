import { expect, it } from "vitest";
import { mergeLegacySettings } from "./legacyMigration";
import { DEFAULT_SETTINGS, USER_MODEL_ID, USER_PROVIDER_ID } from "./types";

it("namespaces imported provider models and preserves human participants", () => {
  const migrated = mergeLegacySettings(DEFAULT_SETTINGS, "llm-hub", {
    defaultTurns: 3,
    participants: [
      { model: "api:openai:gpt", displayName: "GPT" },
      { model: "user", displayName: "You" },
    ],
    voters: [{ model: "api:openai:gpt", displayName: "GPT" }],
  });
  expect(migrated.defaultTurns).toBe(3);
  expect(migrated.participants[0]).toMatchObject({ providerId: "llm-hub", modelId: "api:openai:gpt" });
  expect(migrated.participants[1]).toMatchObject({ providerId: USER_PROVIDER_ID, modelId: USER_MODEL_ID });
});
