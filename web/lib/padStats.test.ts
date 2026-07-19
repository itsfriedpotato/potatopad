import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  creationsByCreator,
  firstPlantTimestamp,
  isPlanter,
  latestPlantTimestamp,
  topCoinByMarketCap,
  type CreationLike,
} from "./padStats";

const base = (over: Partial<CreationLike> & Pick<CreationLike, "token" | "creator">): CreationLike => ({
  timestamp: 1_700_000_000,
  ...over,
});

describe("creationsByCreator", () => {
  it("matches case-insensitively", () => {
    const list = [
      base({ token: "0x1", creator: "0xAbC" }),
      base({ token: "0x2", creator: "0xdef" }),
      base({ token: "0x3", creator: "0xabc" }),
    ];
    const mine = creationsByCreator(list, "0xABC");
    assert.equal(mine.length, 2);
    assert.deepEqual(
      mine.map((c) => c.token),
      ["0x1", "0x3"],
    );
  });

  it("returns empty on miss", () => {
    assert.equal(creationsByCreator([base({ token: "0x1", creator: "0x1" })], "0x2").length, 0);
  });
});

describe("isPlanter", () => {
  it("true only with ≥1 plant", () => {
    const list = [base({ token: "0x1", creator: "0xAa" })];
    assert.equal(isPlanter(list, "0xaa"), true);
    assert.equal(isPlanter(list, "0xbb"), false);
    assert.equal(isPlanter([], "0xaa"), false);
  });
});

describe("first/latest plant timestamps", () => {
  it("handles empty and mixed", () => {
    assert.equal(firstPlantTimestamp([]), null);
    assert.equal(latestPlantTimestamp([]), null);
    const list = [
      base({ token: "0x1", creator: "0xa", timestamp: 100 }),
      base({ token: "0x2", creator: "0xa", timestamp: 300 }),
      base({ token: "0x3", creator: "0xa", timestamp: 200 }),
    ];
    assert.equal(firstPlantTimestamp(list), 100);
    assert.equal(latestPlantTimestamp(list), 300);
  });

  it("ignores zero timestamps for first plant", () => {
    const list = [
      base({ token: "0x1", creator: "0xa", timestamp: 0 }),
      base({ token: "0x2", creator: "0xa", timestamp: 50 }),
    ];
    assert.equal(firstPlantTimestamp(list), 50);
  });
});

describe("topCoinByMarketCap", () => {
  it("picks highest finite positive; ignores null/0/non-finite", () => {
    const rows = [
      { marketCapEth: null },
      { marketCapEth: 0 },
      { marketCapEth: Number.NaN },
      { marketCapEth: 1.5, symbol: "A" },
      { marketCapEth: 3.2, symbol: "B" },
      { marketCapEth: 2.1, symbol: "C" },
    ];
    const top = topCoinByMarketCap(rows);
    assert.equal(top?.symbol, "B");
  });

  it("returns null when nothing priced", () => {
    assert.equal(topCoinByMarketCap([{ marketCapEth: null }, { marketCapEth: 0 }]), null);
  });
});
