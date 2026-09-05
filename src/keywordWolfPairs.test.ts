import { describe, expect, it } from "vitest";
import { KEYWORD_WOLF_PAIRS, randomKeywordWolfPair } from "./keywordWolfPairs";

describe("Keyword Wolf pairs", () => {
  it("bundles between 200 and 300 distinct pairs", () => {
    expect(KEYWORD_WOLF_PAIRS.length).toBeGreaterThanOrEqual(200);
    expect(KEYWORD_WOLF_PAIRS.length).toBeLessThanOrEqual(300);
    expect(new Set(KEYWORD_WOLF_PAIRS.map((pair) => `${pair.majority}|${pair.wolf}`)).size).toBe(KEYWORD_WOLF_PAIRS.length);
    for (const pair of KEYWORD_WOLF_PAIRS) expect(pair.majority).not.toBe(pair.wolf);
  });

  it("can reverse which word is assigned to the wolf", () => {
    expect(randomKeywordWolfPair(() => 0)).toEqual(KEYWORD_WOLF_PAIRS[0]);
    const values = [0.999, 0.9];
    expect(randomKeywordWolfPair(() => values.shift() ?? 0)).toEqual({ majority: KEYWORD_WOLF_PAIRS.at(-1)?.wolf, wolf: KEYWORD_WOLF_PAIRS.at(-1)?.majority });
  });
});
