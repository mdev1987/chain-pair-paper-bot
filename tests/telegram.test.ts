import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { splitMessage } from "../src/telegram.ts";

describe("splitMessage", () => {
  test("short text stays a single chunk", () => {
    assert.deepEqual(splitMessage("hello"), ["hello"]);
  });

  test("a single line longer than the limit is hard-sliced", () => {
    const line = "x".repeat(5000);
    const chunks = splitMessage(line);
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 3900, `chunk too long: ${chunk.length}`);
    }
    assert.equal(chunks.join(""), line);
  });

  test("long lines mix correctly with surrounding short lines", () => {    const text = ["before", "y".repeat(4000), "after"].join("\n");
    const chunks = splitMessage(text);
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 3900, `chunk too long: ${chunk.length}`);
    }
    // Content is preserved across the chunk sequence (hard-sliced pieces
    // of one line carry no newline separator between them).
    const merged = chunks.join("");
    assert.ok(merged.includes("before"));
    assert.ok(merged.includes("after"));
    assert.equal(merged.replace(/[^y]/g, "").length, 4000);
  });

  test("hard slices never split a MarkdownV2 escape sequence", () => {
    // 3899 plain chars + backslash lands the escape exactly on the cut.
    const line = `${"x".repeat(3899)}\\${"y".repeat(1200)}`;
    const chunks = splitMessage(line);
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 3900, `chunk too long: ${chunk.length}`);
      const trailing = chunk.match(/\\+$/)?.[0].length ?? 0;
      assert.equal(trailing % 2, 0, "chunk must not end in a lone escape backslash");
    }
    assert.equal(chunks.join(""), line);
  });
});
