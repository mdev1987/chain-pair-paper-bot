import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { liveState } from "../src/execution/live-state.ts";

describe("live kill-switch nets gains and bounds stuck bags", () => {
  test("gains offset losses in the daily halt", () => {
    liveState.resetForTests();
    try {
      liveState.recordRealizedPnl(10);
      liveState.recordRealizedPnl(-5);
      assert.equal(liveState.dailyNetPnlUsd, 5);
      assert.equal(liveState.dailyLossUsd, 0);
      assert.equal(liveState.isHalted(), false);
      liveState.recordRealizedPnl(-35); // net -30 vs default limit 25
      assert.equal(liveState.dailyLossUsd, 30);
      assert.equal(liveState.isHalted(), true);
    } finally {
      liveState.resetForTests();
    }
  });

  test("open exposure trips the halt even with flat realized net", () => {
    liveState.resetForTests();
    try {
      liveState.setLiveOpenExposureUsd(30); // three $10 bags, limit 25
      assert.equal(liveState.isHalted(), true);
      liveState.setLiveOpenExposureUsd(0);
      assert.equal(liveState.isHalted(), false);
    } finally {
      liveState.resetForTests();
    }
  });
});
