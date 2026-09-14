import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildGraph, Graph } from "./graph";

const execFileAsync = promisify(execFile);

// Field / record separators unlikely to appear in commit content.
const FS = "\x1f"; // unit separator between fields
const RS = "\x1e"; // record separator between commits

export interface Commit {
  hash: string;
  shortHash: string;
  parents: string[];
  author: string;
  authorEmail: string;
  /** Author timestamp, seconds since epoch. */
  timestamp: number;
  /** Ref decorations, e.g. ["HEAD -> main", "origin/main"]. */
  refs: string[];
  subject: string;
}

export interface Branch {
  /** Short name, e.g. "main" or "origin/main". */
  name: string;
  /** Full ref, e.g. "refs/heads/main". */
  fullName: string;
  shortHash: string;
  /** Upstream short name if tracked. */
  upstream: string | null;
  isRemote: boolean;
  isCurrent: boolean;
  /** Commits the upstream has that this branch lacks (to pull). */
  behind: number;
  /** Commits this branch has that the upstream lacks (to push). */
  ahead: number;
}

export interface RepoData {
  root: string;
  currentBranch: string | null;
  branches: Branch[];
  commits: Commit[];
  graph: Graph;
  changes: WorkingChange[];
  /** Full message of HEAD, for amend prefill; "" if no commits. */
  headMessage: string;
  /** In-progress merge/rebase/cherry-pick/revert state, if any. */
  operation: RepoOperation;
  /** Saved stash entries, newest first. */
  stashes: Stash[];
  /** Tags, newest first. */
  tags: Tag[];
  /** True if more commits exist beyond the current limit. */
  hasMore: boolean;
}

async function git(
  cwd: string,
  args: string[],
  env?: Record<string, string>
): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    env: env ? { ...process.env, ...env } : process.env,
  });
  return stdout;
}

/** Resolve the git repository root containing `cwd`, or null if none. */
export async function findRepoRoot(cwd: string): Promise<string | null> {
  try {
    const out = await git(cwd, ["rev-parse", "--show-toplevel"]);
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** Absolute path to the repository's git directory (handles worktrees/submodules). */
export async function getGitDir(root: string): Promise<string | null> {
  try {
    const out = await git(root, ["rev-parse", "--absolute-git-dir"]);
    return out.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Absolute path to the *common* git directory (shared across linked worktrees).
 * Equals the git dir for a normal repo; for a linked worktree it is the main
 * `.git` where shared refs/packed-refs/logs live.
 */
export async function getCommonGitDir(root: string): Promise<string | null> {
  try {
    const out = await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    return out.trim() || null;
  } catch {
    // Older git without --path-format: value may be relative to the repo root.
    try {
      const out = (await git(root, ["rev-parse", "--git-common-dir"])).trim();
      if (!out) return null;
      return path.isAbsolute(out) ? out : path.resolve(root, out);
    } catch {
      return null;
    }
  }
}

async function getCurrentBranch(root: string): Promise<string | null> {
  try {
    const out = await git(root, ["symbolic-ref", "--short", "-q", "HEAD"]);
    return out.trim() || null;
  } catch {
    return null; // detached HEAD
  }
}

/** Full commit message of HEAD, or "" if the repo has no commits. */
async function getHeadMessage(root: string): Promise<string> {
  try {
    return (await git(root, ["log", "-1", "--format=%B"])).replace(/\n+$/, "");
  } catch {
    return "";
  }
}

async function getBranches(root: string): Promise<Branch[]> {
  const fmt = [
    "%(refname)",
    "%(refname:short)",
    "%(objectname:short)",
    "%(upstream:short)",
    "%(HEAD)",
    "%(upstream:track)",
    "%(symref)",
  ].join(FS);
  const out = await git(root, [
    "for-each-ref",
    `--format=${fmt}`,
    "refs/heads",
    "refs/remotes",
  ]);
  const branches: Branch[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [fullName, name, shortHash, upstream, head, track, symref] =
      line.split(FS);
    const isRemote = fullName.startsWith("refs/remotes");
    // Skip stray remote entries: symbolic refs (e.g. origin/HEAD), bare
    // remote-level refs without a branch ("origin"), or a literal .../HEAD.
    if (isRemote && (symref || !name.includes("/") || name.endsWith("/HEAD"))) {
      continue;
    }
    branches.push({
      fullName,
      name,
      shortHash,
      upstream: upstream || null,
      isRemote,
      isCurrent: head === "*",
      behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
      ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0),
    });
  }
  // For local branches without an upstream, "ahead" isn't defined by track info.
  // Approximate outgoing as commits not reachable from any remote-tracking ref.
  const hasRemotes = branches.some((b) => b.isRemote);
  if (hasRemotes) {
    await Promise.all(
      branches
        .filter((b) => !b.isRemote && !b.upstream)
        .map(async (b) => {
          const out = await git(root, [
            "rev-list",
            "--count",
            b.fullName,
            "--not",
            "--remotes",
          ]);
          b.ahead = Number(out.trim()) || 0;
        })
    );
  }
  return branches;
}

async function getCommits(
  root: string,
  limit: number,
  branch: string | null
): Promise<Commit[]> {
  const fmt =
    ["%H", "%h", "%P", "%an", "%ae", "%at", "%D", "%s"].join(FS) + RS;
  const scope = branch ? [branch] : ["--all"];
  const args = ["log", ...scope, "--date-order", `--max-count=${limit}`, `--format=${fmt}`];
  let out: string;
  try {
    out = await git(root, args);
  } catch {
    // Branch ref may have gone away (e.g. deleted while filtered); fall back to all.
    out = await git(root, ["log", "--all", "--date-order", `--max-count=${limit}`, `--format=${fmt}`]);
  }
  const commits: Commit[] = [];
  for (const record of out.split(RS)) {
    const line = record.replace(/^\n/, "");
    if (!line.trim()) continue;
    const [hash, shortHash, parents, author, authorEmail, at, refs, subject] =
      line.split(FS);
    commits.push({
      hash,
      shortHash,
      parents: parents ? parents.split(" ").filter(Boolean) : [],
      author,
      authorEmail,
      timestamp: Number(at) || 0,
      refs: refs
        ? refs.split(",").map((r) => r.trim()).filter(Boolean)
        : [],
      subject,
    });
  }
  return commits;
}


export interface RepoOperation {
  /** In-progress operation, or null when the tree is clean of sequencer state. */
  type: "merge" | "rebase" | "cherry-pick" | "revert" | null;
  /** Number of unmerged (conflicted) paths. */
  conflicts: number;
}

/** Detect an in-progress merge/rebase/cherry-pick/revert and count conflicts. */
async function getOperation(root: string): Promise<RepoOperation> {
  const gitDir = await getGitDir(root);
  let type: RepoOperation["type"] = null;
  if (gitDir) {
    const has = (p: string) => fs.existsSync(path.join(gitDir, p));
    if (has("rebase-merge") || has("rebase-apply")) type = "rebase";
    else if (has("MERGE_HEAD")) type = "merge";
    else if (has("CHERRY_PICK_HEAD")) type = "cherry-pick";
    else if (has("REVERT_HEAD")) type = "revert";
  }
  let conflicts = 0;
  try {
    const out = await git(root, ["diff", "--name-only", "--diff-filter=U"]);
    conflicts = out.split("\n").filter((l) => l.trim()).length;
  } catch {
    conflicts = 0;
  }
  return { type, conflicts };
}

export interface RepoFilter {
  /** Restrict the log to a single branch ref; null = all refs. */
  branch: string | null;
  /** Free-text filter on commit subject or hash; "" = no filter. */
  search: string;
}

export async function loadRepoData(
  cwd: string,
  commitLimit = 500,
  filter: RepoFilter = { branch: null, search: "" }
): Promise<RepoData | null> {
  const root = await findRepoRoot(cwd);
  if (!root) return null;
  const [currentBranch, branches, commits, changes, headMessage, operation, stashes, tags] =
    await Promise.all([
      getCurrentBranch(root),
      getBranches(root),
      getCommits(root, commitLimit + 1, filter.branch),
      getStatus(root),
      getHeadMessage(root),
      getOperation(root),
      getStashes(root),
      getTags(root),
    ]);
  // Fetched one extra to detect whether more history exists beyond the limit.
  const hasMore = commits.length > commitLimit;
  const limited = hasMore ? commits.slice(0, commitLimit) : commits;
  const q = filter.search.trim().toLowerCase();
  const shown = q
    ? limited.filter(
        (c) =>
          c.subject.toLowerCase().includes(q) ||
          c.hash.toLowerCase().startsWith(q) ||
          c.author.toLowerCase().includes(q) ||
          c.authorEmail.toLowerCase().includes(q)
      )
    : limited;
  return {
    root,
    currentBranch,
    branches,
    commits: shown,
    graph: buildGraph(shown),
    changes,
    headMessage,
    operation,
    stashes,
    tags,
    hasMore,
  };
}

export interface WorkingChange {
  /** Display status: M, A, D, R, or ? (untracked). */
  status: string;
  /** Repo-relative path (destination path for renames). */
  path: string;
  /** Source path for renames, else null. */
  oldPath: string | null;
  /** True for untracked ("??") entries. */
  untracked: boolean;
}

/** Parse `git status --porcelain -z` into one entry per changed path. */
export async function getStatus(root: string): Promise<WorkingChange[]> {
  const out = await git(root, ["status", "--porcelain=v1", "-z"]);
  const chunks = out.split("\0");
  const changes: WorkingChange[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue;
    const x = chunk[0];
    const y = chunk[1];
    const path = chunk.slice(3);
    const untracked = x === "?" && y === "?";
    let oldPath: string | null = null;
    if (x === "R" || x === "C") {
      // Rename/copy: the following chunk is the source path.
      oldPath = chunks[++i] ?? null;
    }
    let status: string;
    if (untracked) status = "?";
    else if (x === "R" || y === "R") status = "R";
    else if (x === "A" || y === "A") status = "A";
    else if (x === "D" || y === "D") status = "D";
    else status = "M";
    changes.push({ status, path, oldPath, untracked });
  }
  return changes;
}

export interface Stash {
  /** 0-based position; matches stash@{index}. */
  index: number;
  /** Ref selector, e.g. "stash@{0}". */
  selector: string;
  /** Stash subject, e.g. "WIP on main: abc123 …". */
  message: string;
  /** Relative time, e.g. "2 hours ago". */
  date: string;
}

async function getStashes(root: string): Promise<Stash[]> {
  const out = await git(root, [
    "stash",
    "list",
    `--format=%gd${FS}%gs${FS}%cr`,
  ]);
  const stashes: Stash[] = [];
  let index = 0;
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [selector, message, date] = line.split(FS);
    stashes.push({ index: index++, selector, message, date });
  }
  return stashes;
}

export interface Tag {
  name: string;
  /** Short hash of the commit the tag points to (dereferenced for annotated tags). */
  shortHash: string;
  /** Creator date (tagger date for annotated, commit date for lightweight), unix seconds. */
  timestamp: number;
}

async function getTags(root: string): Promise<Tag[]> {
  const fmt = [
    "%(refname:short)",
    "%(objectname:short)",
    "%(*objectname:short)",
    "%(creatordate:unix)",
  ].join(FS);
  const out = await git(root, [
    "for-each-ref",
    `--format=${fmt}`,
    "--sort=-creatordate",
    "refs/tags",
  ]);
  const tags: Tag[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [name, obj, deref, date] = line.split(FS);
    tags.push({ name, shortHash: deref || obj, timestamp: Number(date) || 0 });
  }
  return tags;
}

export interface CommitFile {
  /** Single-letter change status: A, M, D, R, C, T. */
  status: string;
  /** Repo-relative path after the change (new path for renames). */
  path: string;
  /** Original path for renames/copies, else null. */
  oldPath: string | null;
}

// Git's canonical empty-tree object; base for diffing a root commit.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Files changed by `hash` relative to its first parent (or empty tree for a root commit). */
export async function getCommitFiles(
  root: string,
  hash: string,
  parent: string | null
): Promise<CommitFile[]> {
  const base = parent || EMPTY_TREE;
  const out = await git(root, [
    "diff",
    "--name-status",
    "--find-renames",
    base,
    hash,
  ]);
  const files: CommitFile[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const fields = line.split("\t");
    const status = fields[0][0];
    if (status === "R" || status === "C") {
      files.push({ status, path: fields[2], oldPath: fields[1] });
    } else {
      files.push({ status, path: fields[1], oldPath: null });
    }
  }
  return files;
}

// Blobs larger than this are shown as a placeholder instead of loaded into the diff.
const MAX_DIFF_BYTES = 2 * 1024 * 1024;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Blob content of `path` at revision `rev` for diffing; "" if absent there.
 * Binary and oversized blobs return a short placeholder (including the blob id so a
 * changed binary still shows as different across revisions) instead of raw bytes.
 */
export async function showFile(
  root: string,
  rev: string,
  path: string
): Promise<string> {
  if (!rev) return "";
  const spec = `${rev}:${path}`;
  let size: number;
  try {
    size = Number((await git(root, ["cat-file", "-s", spec])).trim());
  } catch {
    return ""; // blob absent at this revision (e.g. added/deleted side)
  }
  if (size > MAX_DIFF_BYTES) {
    const oid = (await git(root, ["rev-parse", "--short", spec])).trim();
    return `\u27e8 Large file not shown \u2014 ${oid}, ${formatBytes(size)} \u27e9\n`;
  }
  let content: string;
  try {
    content = await git(root, ["show", spec]);
  } catch {
    return "";
  }
  if (content.includes("\u0000")) {
    const oid = (await git(root, ["rev-parse", "--short", spec])).trim();
    return `\u27e8 Binary file not shown \u2014 ${oid}, ${formatBytes(size)} \u27e9\n`;
  }
  return content;
}

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Run an arbitrary git command, capturing failure instead of throwing. */
export async function runGit(
  root: string,
  args: string[],
  env?: Record<string, string>
): Promise<GitResult> {
  try {
    return { ok: true, stdout: await git(root, args, env), stderr: "" };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return {
      ok: false,
      stdout: err.stdout ?? "",
      stderr: (err.stderr ?? String(e)).trim(),
    };
  }
}
