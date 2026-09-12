import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGraph, type Graph } from "../src/graph.ts";
import type { Commit } from "../src/git.ts";

/** Minimal Commit builder; only hash/parents drive graph layout. */
function commit(hash: string, parents: string[] = []): Commit {
  return {
    hash,
    shortHash: hash,
    parents,
    author: "a",
    authorEmail: "a@e",
    timestamp: 0,
    refs: [],
    subject: hash,
  };
}

const PALETTE_SIZE = 10; // must mirror graph.ts

/**
 * Core rendering invariant: the lanes leaving the bottom of a row must arrive,
 * unchanged in column and color, at the top of the next row. A break here would
 * render as a disconnected or color-flipping line in the graph gutter.
 */
function assertColumnContinuity(g: Graph): void {
  for (let i = 0; i + 1 < g.rows.length; i++) {
    const below = g.rows[i].bottom
      .map((e) => `${e.to}:${e.color}`)
      .sort();
    const above = g.rows[i + 1].top
      .map((e) => `${e.from}:${e.color}`)
      .sort();
    assert.deepEqual(above, below, `row ${i}->${i + 1} lane continuity`);
  }
}

/** No edge or node may reference a column beyond the reported width. */
function assertWithinBounds(g: Graph): void {
  for (const row of g.rows) {
    assert.ok(row.lane >= 0 && row.lane <= g.maxLane, "node lane in bounds");
    for (const e of [...row.top, ...row.bottom]) {
      assert.ok(e.from >= 0 && e.from <= g.maxLane, "edge.from in bounds");
      assert.ok(e.to >= 0 && e.to <= g.maxLane, "edge.to in bounds");
    }
  }
}

test("empty history yields no rows and zero width", () => {
  assert.deepEqual(buildGraph([]), { rows: [], maxLane: 0 });
});

test("rows preserve input order, count, and hashes", () => {
  const input = [commit("A", ["B"]), commit("B", ["C"]), commit("C")];
  const g = buildGraph(input);
  assert.equal(g.rows.length, input.length);
  assert.deepEqual(
    g.rows.map((r) => r.hash),
    ["A", "B", "C"],
  );
});

test("linear history stays on a single vertical lane", () => {
  const g = buildGraph([commit("A", ["B"]), commit("B", ["C"]), commit("C")]);
  assert.equal(g.maxLane, 0);
  for (const row of g.rows) {
    assert.equal(row.lane, 0);
    assert.equal(row.color, 0);
    for (const e of [...row.top, ...row.bottom]) {
      assert.equal(e.from, 0);
      assert.equal(e.to, 0); // vertical: never drifts sideways
    }
  }
  assertColumnContinuity(g);
});

test("a root commit terminates its lane (no outgoing edge)", () => {
  const g = buildGraph([commit("A", ["B"]), commit("B")]);
  const root = g.rows.at(-1)!;
  assert.equal(root.hash, "B");
  assert.deepEqual(root.bottom, []); // nothing flows below a parentless commit
});

test("merge forks into a new lane and reconverges", () => {
  // M merges branch tips X and Y; both descend from root Z.
  const g = buildGraph([
    commit("M", ["X", "Y"]),
    commit("X", ["Z"]),
    commit("Y", ["Z"]),
    commit("Z"),
  ]);
  assert.equal(g.maxLane, 1, "two concurrent branches => width 2");

  const m = g.rows[0];
  assert.equal(m.lane, 0);
  assert.equal(m.bottom.length, 2, "merge spawns two downward lanes");
  const mColors = new Set(m.bottom.map((e) => e.color));
  assert.equal(mColors.size, 2, "each parent lane gets a distinct color");

  const z = g.rows[3];
  assert.deepEqual(z.bottom, [], "root closes the graph");
  assert.equal(z.top.length, 2, "both branches converge into the root");
  for (const e of z.top) {
    assert.equal(e.to, z.lane, "converging lanes route into the node lane");
  }
  assertColumnContinuity(g);
  assertWithinBounds(g);
});

test("first parent keeps the node's lane and color", () => {
  const g = buildGraph([
    commit("M", ["X", "Y"]),
    commit("X", ["Z"]),
    commit("Y", ["Z"]),
    commit("Z"),
  ]);
  const m = g.rows[0];
  const firstParentEdge = m.bottom.find((e) => e.from === m.lane);
  assert.ok(firstParentEdge, "first parent continues the node's lane");
  assert.equal(
    firstParentEdge!.color,
    m.color,
    "first-parent lane inherits the node color",
  );
});

test("independent roots reuse a freed lane but get distinct colors", () => {
  const g = buildGraph([commit("A"), commit("B")]);
  assert.equal(g.maxLane, 0, "freed lane is reused, width stays 1");
  assert.equal(g.rows[0].lane, 0);
  assert.equal(g.rows[1].lane, 0);
  assert.notEqual(
    g.rows[0].color,
    g.rows[1].color,
    "a fresh branch draws a fresh color",
  );
});

test("node colors cycle within the palette size", () => {
  // PALETTE_SIZE + 1 independent roots: the last wraps to color 0.
  const roots = Array.from({ length: PALETTE_SIZE + 1 }, (_, i) =>
    commit(`R${i}`),
  );
  const g = buildGraph(roots);
  for (const row of g.rows) {
    assert.ok(row.color >= 0 && row.color < PALETTE_SIZE);
  }
  assert.equal(g.rows[0].color, 0);
  assert.equal(g.rows[PALETTE_SIZE].color, 0, "color index wraps modulo palette");
});

test("continuity and bounds hold on a branched-and-merged graph", () => {
  // H merges main (G) and feature (F); feature branched from E.
  const g = buildGraph([
    commit("H", ["G", "F"]),
    commit("G", ["E"]),
    commit("F", ["E"]),
    commit("E", ["D"]),
    commit("D"),
  ]);
  assertColumnContinuity(g);
  assertWithinBounds(g);
  assert.equal(g.rows.at(-1)!.hash, "D");
  assert.deepEqual(g.rows.at(-1)!.bottom, []);
});
