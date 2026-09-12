import type { Commit } from "./git";

// Number of distinct lane colors. MUST match the palette length in media/main.js.
const PALETTE_SIZE = 10;

/** A line segment within one commit row's cell, between lane columns. */
export interface GraphEdge {
  /** Source lane column. */
  from: number;
  /** Target lane column. */
  to: number;
  /** Palette color index. */
  color: number;
}

export interface GraphRow {
  hash: string;
  /** Column the commit node occupies. */
  lane: number;
  /** Node color (palette index). */
  color: number;
  /** Edges in the top half: cell top -> node row (incoming from children). */
  top: GraphEdge[];
  /** Edges in the bottom half: node row -> cell bottom (outgoing to parents). */
  bottom: GraphEdge[];
}

export interface Graph {
  rows: GraphRow[];
  /** Highest lane column used; gutter width = (maxLane + 1) * laneWidth. */
  maxLane: number;
}

/**
 * Assign each commit to a lane and derive the edges connecting rows.
 *
 * Requires `commits` in child-before-parent order (git log --date-order/--topo-order).
 * Lanes are never shifted once allocated, so passing lines stay vertical; freed
 * lanes are reused by later commits, bounding width to concurrent branch count.
 */
export function buildGraph(commits: Commit[]): Graph {
  // laneTarget[i] = hash the lane is flowing toward next, or null if the lane is free.
  const laneTarget: (string | null)[] = [];
  const laneColor: number[] = [];
  let colorCounter = 0;
  let maxLane = 0;
  const rows: GraphRow[] = [];

  const allocLane = (): number => {
    for (let i = 0; i < laneTarget.length; i++) {
      if (laneTarget[i] === null) return i;
    }
    laneTarget.push(null);
    laneColor.push(0);
    return laneTarget.length - 1;
  };

  for (const c of commits) {
    const beforeTarget = laneTarget.slice();
    const beforeColor = laneColor.slice();

    // Lanes flowing into this commit (edges from already-drawn children).
    const incoming: number[] = [];
    for (let i = 0; i < laneTarget.length; i++) {
      if (laneTarget[i] === c.hash) incoming.push(i);
    }

    let nodeLane: number;
    let nodeColor: number;
    if (incoming.length > 0) {
      nodeLane = incoming[0];
      nodeColor = laneColor[nodeLane];
      // Extra incoming lanes merge into the node and free up.
      for (let k = 1; k < incoming.length; k++) {
        laneTarget[incoming[k]] = null;
      }
    } else {
      nodeLane = allocLane();
      nodeColor = colorCounter++ % PALETTE_SIZE;
      laneColor[nodeLane] = nodeColor;
    }

    // Route parents downward. First parent continues the node's lane and keeps
    // its color; each extra parent (merge) branches into a fresh lane.
    const bornCols = new Set<number>();
    if (c.parents.length === 0) {
      laneTarget[nodeLane] = null;
    } else {
      laneTarget[nodeLane] = c.parents[0];
      bornCols.add(nodeLane);
      for (let p = 1; p < c.parents.length; p++) {
        const lane = allocLane();
        laneColor[lane] = colorCounter++ % PALETTE_SIZE;
        laneTarget[lane] = c.parents[p];
        bornCols.add(lane);
      }
    }

    const top: GraphEdge[] = [];
    for (let col = 0; col < beforeTarget.length; col++) {
      const target = beforeTarget[col];
      if (target === null) continue;
      const to = target === c.hash ? nodeLane : col;
      top.push({ from: col, to, color: beforeColor[col] });
    }

    const bottom: GraphEdge[] = [];
    for (let col = 0; col < laneTarget.length; col++) {
      if (laneTarget[col] === null) continue;
      const from = bornCols.has(col) ? nodeLane : col;
      bottom.push({ from, to: col, color: laneColor[col] });
    }

    maxLane = Math.max(maxLane, laneTarget.length - 1);
    rows.push({ hash: c.hash, lane: nodeLane, color: nodeColor, top, bottom });
  }

  return { rows, maxLane };
}
