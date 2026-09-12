import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeBranchName } from "../src/branch.ts";

test("replaces spaces with hyphens", () => {
  assert.equal(sanitizeBranchName("my new branch"), "my-new-branch");
});

test("collapses runs of whitespace (tabs included) into one hyphen", () => {
  assert.equal(sanitizeBranchName("feature   x\ty"), "feature-x-y");
});

test("trims leading and trailing whitespace before collapsing", () => {
  assert.equal(sanitizeBranchName("  spaced out  "), "spaced-out");
});

test("leaves an already-valid ref name untouched", () => {
  assert.equal(sanitizeBranchName("feature/my-branch"), "feature/my-branch");
});

test("whitespace-only input yields an empty (rejected) name", () => {
  assert.equal(sanitizeBranchName("   "), "");
});
