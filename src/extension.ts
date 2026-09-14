import * as vscode from "vscode";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadRepoData, getStatus, getCommitFiles, showFile, runGit, getGitDir, getCommonGitDir, RepoData } from "./git";
import type { GitResult, RepoFilter } from "./git";
import { sanitizeBranchName } from "./branch";

const DIFF_SCHEME = "pwrgit-diff";

// GIT_SEQUENCE_EDITOR script: rewrites the interactive-rebase todo, marking every
// commit whose full hash is listed in SQUASH_HASHES as "squash" (kept-as-pick = oldest).
const SEQ_EDITOR_SCRIPT = `const fs = require("fs");
const todo = process.argv[2];
const squash = (process.env.SQUASH_HASHES || "").split(",").filter(Boolean);
const lines = fs.readFileSync(todo, "utf8").split("\\n").map((line) => {
  const m = line.match(/^(pick|p) ([0-9a-fA-F]+) /);
  if (m && squash.some((h) => h.startsWith(m[2]))) return line.replace(/^(pick|p) /, "squash ");
  return line;
});
fs.writeFileSync(todo, lines.join("\\n"));
`;

interface ConsoleEntry {
  command: string;
  ok: boolean;
  stdout: string;
  stderr: string;
  ts: number;
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new PwrgitViewProvider(context.extensionUri, context.globalState);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PwrgitViewProvider.viewType, provider),
    vscode.commands.registerCommand("pwrgit.refresh", () => provider.refresh()),
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, {
      provideTextDocumentContent(uri) {
        const { root, rev, path } = JSON.parse(uri.query) as {
          root: string;
          rev: string;
          path: string;
        };
        return showFile(root, rev, path);
      },
    }),
    { dispose: () => provider.disposeWatchers() }
  );
}

export function deactivate() {}

class PwrgitViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "pwrgit.view";

  private view?: vscode.WebviewView;
  private root?: string;
  private consoleLog: ConsoleEntry[] = [];
  private watchers: vscode.Disposable[] = [];
  private watchedRoot?: string;
  private refreshTimer?: NodeJS.Timeout;
  private filter: RepoFilter = { branch: null, search: "" };
  private integration: "merge" | "rebase";
  private commitLimit = 500;
  private branchesWidth = 240;
  private detailsWidth = 320;
  private busyCount = 0;
  private busyShown = false;
  private busyTimer?: NodeJS.Timeout;
  private pendingMeta = false;
  private pendingTree = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly state: vscode.Memento
  ) {
    this.integration = state.get("integration") === "rebase" ? "rebase" : "merge";
    const savedBranches = Number(this.state.get("branchesWidth"));
    if (Number.isFinite(savedBranches) && savedBranches >= 140) {
      this.branchesWidth = Math.min(1000, savedBranches);
    }
    const savedDetails = Number(this.state.get("detailsWidth"));
    if (Number.isFinite(savedDetails) && savedDetails >= 180) {
      this.detailsWidth = Math.min(1000, savedDetails);
    }
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === "ready" || msg?.type === "refresh") {
        if (msg.type === "ready") {
          if (this.consoleLog.length) {
            this.post({ type: "consoleHistory", entries: this.consoleLog });
          }
          this.post({ type: "filterState", filter: this.filter });
          this.post({ type: "integrationState", mode: this.integration });
          this.post({
            type: "layoutState",
            branchesWidth: this.branchesWidth,
            detailsWidth: this.detailsWidth,
          });
        }
        void this.refresh();
      } else if (msg?.type === "selectCommit") {
        void this.selectCommit(msg.hash, msg.parent ?? null);
      } else if (msg?.type === "openDiff") {
        void this.openDiff(msg);
      } else if (msg?.type === "action") {
        void this.handleAction(msg);
      } else if (msg?.type === "commit") {
        void this.commit(msg.message, msg.files, msg.amend, msg.push);
      } else if (msg?.type === "openWorkingDiff") {
        void this.openWorkingDiff(msg);
      } else if (msg?.type === "rollback") {
        void this.rollbackFiles(msg.files);
      } else if (msg?.type === "setFilter") {
        this.filter = { branch: msg.branch ?? null, search: msg.search ?? "" };
        void this.refresh();
      } else if (msg?.type === "squash") {
        void this.squash(msg.commits);
      } else if (msg?.type === "opAction") {
        void this.opAction(msg.op, msg.action);
      } else if (msg?.type === "stash") {
        void this.stashPush(msg.message, msg.files);
      } else if (msg?.type === "stashAction") {
        void this.stashAction(msg.action, msg.selector);
      } else if (msg?.type === "setIntegration") {
        this.integration = msg.mode === "rebase" ? "rebase" : "merge";
        void this.state.update("integration", this.integration);
      } else if (msg?.type === "setLimit") {
        const n = Math.max(1, Math.min(100000, Math.floor(Number(msg.limit) || 0)));
        if (n !== this.commitLimit) {
          this.commitLimit = n;
          void this.refresh();
        }
      } else if (msg?.type === "loadMore") {
        this.commitLimit += 500;
        void this.refresh();
      } else if (msg?.type === "setLayout") {
        if (typeof msg.branchesWidth === "number") {
          this.branchesWidth = Math.max(140, Math.min(1000, Math.round(msg.branchesWidth)));
          void this.state.update("branchesWidth", this.branchesWidth);
        }
        if (typeof msg.detailsWidth === "number") {
          this.detailsWidth = Math.max(180, Math.min(1000, Math.round(msg.detailsWidth)));
          void this.state.update("detailsWidth", this.detailsWidth);
        }
      }
    });

    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.view) return;
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) {
      this.post({ type: "error", message: "No workspace folder open." });
      return;
    }
    this.setBusy(1);
    try {
      const data = await loadRepoData(cwd, this.commitLimit, this.filter);
      if (!data) {
        this.post({ type: "error", message: "No git repository found." });
        return;
      }
      this.root = data.root;
      void this.ensureWatchers(data.root);
      this.post({ type: "data", data });
      this.post({ type: "limitState", limit: this.commitLimit });
    } catch (err) {
      this.post({ type: "error", message: `git failed: ${String(err)}` });
    } finally {
      this.setBusy(-1);
    }
  }

  /** Track in-flight git operations; show a status-bar loader if one runs past a short delay. */
  private setBusy(delta: number): void {
    this.busyCount = Math.max(0, this.busyCount + delta);
    if (this.busyCount > 0) {
      if (!this.busyShown && !this.busyTimer) {
        this.busyTimer = setTimeout(() => {
          this.busyTimer = undefined;
          this.busyShown = true;
          this.post({ type: "busy", busy: true });
        }, 150);
      }
    } else {
      clearTimeout(this.busyTimer);
      this.busyTimer = undefined;
      if (this.busyShown) {
        this.busyShown = false;
        this.post({ type: "busy", busy: false });
      }
    }
  }

  /** Create filesystem watchers for the repo so external git ops live-update the view. */
  private async ensureWatchers(root: string): Promise<void> {
    if (root === this.watchedRoot) return;
    this.disposeWatchers();
    this.watchedRoot = root;

    // Working-tree changes keep the Changes view current (edits before staging never
    // touch .git). A string glob is served by VS Code's existing recursive watcher and
    // honours files.watcherExclude (node_modules, .git/objects, …), unlike a
    // RelativePattern which spins up a separate recursive watcher that ignores excludes.
    // Non-.git edits only need a status refresh; .git touches need a full reload.
    const treeWatcher = vscode.workspace.createFileSystemWatcher("**");
    const onTree = (uri: vscode.Uri) => this.scheduleRefresh(isGitPath(uri));
    this.watchers.push(
      treeWatcher,
      treeWatcher.onDidChange(onTree),
      treeWatcher.onDidCreate(onTree),
      treeWatcher.onDidDelete(onTree)
    );

    // Git metadata: HEAD/index/ref updates from any tool. For the common repo this
    // covers everything; for a linked worktree the git dir holds only per-worktree
    // state (HEAD/index), so shared refs are watched via the common dir below.
    const gitDir = await getGitDir(root);
    if (gitDir) {
      this.wireMeta(
        vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(
            vscode.Uri.file(gitDir),
            "{HEAD,ORIG_HEAD,MERGE_HEAD,index,packed-refs,refs/**,logs/HEAD}"
          )
        )
      );
    }

    // Linked worktrees keep shared branches/tags in the common dir; watch it too.
    const commonDir = await getCommonGitDir(root);
    if (commonDir && commonDir !== gitDir) {
      this.wireMeta(
        vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(
            vscode.Uri.file(commonDir),
            "{packed-refs,refs/**,logs/HEAD}"
          )
        )
      );
    }
  }

  /** Wire a git-metadata watcher; any event triggers a full reload. */
  private wireMeta(watcher: vscode.FileSystemWatcher): void {
    this.watchers.push(
      watcher,
      watcher.onDidChange(() => this.scheduleRefresh(true)),
      watcher.onDidCreate(() => this.scheduleRefresh(true)),
      watcher.onDidDelete(() => this.scheduleRefresh(true))
    );
  }

  private scheduleRefresh(meta: boolean): void {
    if (meta) this.pendingMeta = true;
    else this.pendingTree = true;
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      const full = this.pendingMeta;
      this.pendingMeta = false;
      this.pendingTree = false;
      if (full) void this.refresh();
      else void this.refreshStatus();
    }, 400);
  }

  /** Lightweight refresh: reload only the working-tree status (for file-save events). */
  private async refreshStatus(): Promise<void> {
    if (!this.view || !this.root) return;
    this.setBusy(1);
    try {
      this.post({ type: "status", changes: await getStatus(this.root) });
    } catch {
      // ignore; a later full refresh will reconcile
    } finally {
      this.setBusy(-1);
    }
  }

  disposeWatchers(): void {
    clearTimeout(this.refreshTimer);
    for (const w of this.watchers) w.dispose();
    this.watchers = [];
    this.watchedRoot = undefined;
  }

  private async selectCommit(hash: string, parent: string | null): Promise<void> {
    if (!this.root) return;
    try {
      const files = await getCommitFiles(this.root, hash, parent);
      this.post({ type: "commitFiles", hash, parentRev: parent ?? "", files });
    } catch (err) {
      this.post({ type: "error", message: `git diff failed: ${String(err)}` });
    }
  }

  private async openDiff(msg: {
    path: string;
    oldPath: string | null;
    rev: string;
    parentRev: string;
  }): Promise<void> {
    if (!this.root) return;
    const root = this.root;
    const toUri = (rev: string, path: string) =>
      vscode.Uri.from({
        scheme: DIFF_SCHEME,
        path: `/${path}`,
        query: JSON.stringify({ root, rev, path }),
      });
    const base = msg.path.split("/").pop() ?? msg.path;
    const shortParent = msg.parentRev ? msg.parentRev.slice(0, 7) : "\u2205";
    const title = `${base} (${shortParent} \u2194 ${msg.rev.slice(0, 7)})`;
    await vscode.commands.executeCommand(
      "vscode.diff",
      toUri(msg.parentRev, msg.oldPath || msg.path),
      toUri(msg.rev, msg.path),
      title
    );
  }

  private async commit(
    message: string,
    files: string[],
    amend: boolean,
    push: boolean
  ): Promise<void> {
    if (!this.root) return;
    files = files ?? [];
    // Amend may re-commit with just a new message; a normal commit needs files.
    if (!amend && files.length === 0) {
      void vscode.window.showErrorMessage("Select at least one file to commit.");
      return;
    }
    if (!message || !message.trim()) {
      void vscode.window.showErrorMessage("Enter a commit message.");
      return;
    }
    // If amending a commit that is already on the upstream, the rewrite will need a force push.
    const amendingPushed =
      amend &&
      (await runGit(this.root, ["merge-base", "--is-ancestor", "HEAD", "@{u}"])).ok;
    if (files.length && !(await this.run(["add", "--", ...files]))) return;
    const args = ["commit"];
    if (amend) args.push("--amend");
    args.push("-m", message);
    if (files.length) args.push("--", ...files);
    if (!(await this.run(args))) return;
    if (push) await this.pushCurrent();
    if (amendingPushed && !push) {
      void vscode.window.showWarningMessage(
        "Amended a commit that was already pushed \u2014 use Force Push (--force-with-lease) to update the remote."
      );
    }
    await this.refresh();
  }

  /** Push the currently checked-out branch to its upstream (setting one if needed). */
  private async pushCurrent(): Promise<void> {
    const branchRes = await runGit(this.root!, ["symbolic-ref", "--short", "-q", "HEAD"]);
    const branch = branchRes.stdout.trim();
    if (!branch) {
      void vscode.window.showErrorMessage("Cannot push: HEAD is detached.");
      return;
    }
    const upRes = await runGit(this.root!, [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{u}",
    ]);
    await this.pushBranch(branch, upRes.ok ? upRes.stdout.trim() : null, false);
  }

  private async openWorkingDiff(msg: {
    path: string;
    status: string;
    untracked: boolean;
    oldPath: string | null;
  }): Promise<void> {
    if (!this.root) return;
    const root = this.root;
    const headUri = (path: string, rev: string) =>
      vscode.Uri.from({
        scheme: DIFF_SCHEME,
        path: `/${path}`,
        query: JSON.stringify({ root, rev, path }),
      });
    const base = msg.path.split("/").pop() ?? msg.path;
    const left = msg.untracked
      ? headUri(msg.path, "")
      : headUri(msg.oldPath || msg.path, "HEAD");
    const right =
      msg.status === "D"
        ? headUri(msg.path, "")
        : vscode.Uri.joinPath(vscode.Uri.file(root), msg.path);
    await vscode.commands.executeCommand(
      "vscode.diff",
      left,
      right,
      `${base} (working tree)`
    );
  }

  private async rollbackFiles(
    files: { path: string; status: string; oldPath: string | null }[]
  ): Promise<void> {
    if (!this.root || !files || files.length === 0) return;
    const n = files.length;
    const choice = await vscode.window.showWarningMessage(
      `Rollback changes to ${n} file${n === 1 ? "" : "s"}? This cannot be undone.`,
      { modal: true },
      "Rollback"
    );
    if (choice !== "Rollback") return;

    // Group by the git operation each status needs, so one command per group.
    const checkoutPaths: string[] = []; // M, D, T -> restore from HEAD
    const removePaths: string[] = []; // A (new file) and rename destination
    const cleanPaths: string[] = []; // ? untracked
    for (const f of files) {
      if (f.status === "?") {
        cleanPaths.push(f.path);
      } else if (f.status === "A") {
        removePaths.push(f.path);
      } else if (f.status === "R") {
        if (f.oldPath) checkoutPaths.push(f.oldPath);
        removePaths.push(f.path);
      } else {
        checkoutPaths.push(f.path);
      }
    }
    if (checkoutPaths.length) await this.run(["checkout", "HEAD", "--", ...checkoutPaths]);
    if (removePaths.length) await this.run(["rm", "-f", "--", ...removePaths]);
    if (cleanPaths.length) await this.run(["clean", "-f", "-d", "--", ...cleanPaths]);
    await this.refresh();
  }

  /** Squash a contiguous range of commits (newest-first) into their oldest member. */
  private async squash(
    commits: { hash: string; parents: string[] }[]
  ): Promise<void> {
    if (!this.root || !commits || commits.length < 2) return;
    if (commits.some((c) => c.parents.length > 1)) {
      void vscode.window.showErrorMessage("Cannot squash merge commits.");
      return;
    }
    for (let i = 0; i < commits.length - 1; i++) {
      if (commits[i].parents[0] !== commits[i + 1].hash) {
        void vscode.window.showErrorMessage(
          "Select a contiguous range of commits to squash."
        );
        return;
      }
    }
    const newest = commits[0].hash;
    const oldest = commits[commits.length - 1];
    const head = (await runGit(this.root, ["rev-parse", "HEAD"])).stdout.trim();
    if (newest !== head) {
      const anc = await runGit(this.root, ["merge-base", "--is-ancestor", newest, "HEAD"]);
      if (!anc.ok) {
        void vscode.window.showErrorMessage(
          "Squash only works on commits in the current branch's history."
        );
        return;
      }
    }
    const n = commits.length;
    const choice = await vscode.window.showWarningMessage(
      `Squash ${n} commits into one?`,
      { modal: true },
      "Squash"
    );
    if (choice !== "Squash") return;

    const scriptPath = path.join(os.tmpdir(), "pwrgit-rebase-seq.js");
    fs.writeFileSync(scriptPath, SEQ_EDITOR_SCRIPT);
    const env = {
      GIT_SEQUENCE_EDITOR: `node ${JSON.stringify(scriptPath)}`,
      GIT_EDITOR: "true",
      // Every selected commit except the oldest becomes "squash".
      SQUASH_HASHES: commits.slice(0, n - 1).map((c) => c.hash).join(","),
    };
    const base = oldest.parents[0];
    const args = base ? ["rebase", "-i", base] : ["rebase", "-i", "--root"];
    await this.run(args, env);
    await this.refresh();
  }

  /** Continue/skip/abort an in-progress merge/rebase/cherry-pick/revert. */
  private async opAction(op: string, action: string): Promise<void> {
    const table: Record<string, Record<string, string[]>> = {
      merge: { continue: ["merge", "--continue"], abort: ["merge", "--abort"] },
      rebase: {
        continue: ["rebase", "--continue"],
        skip: ["rebase", "--skip"],
        abort: ["rebase", "--abort"],
      },
      "cherry-pick": {
        continue: ["cherry-pick", "--continue"],
        skip: ["cherry-pick", "--skip"],
        abort: ["cherry-pick", "--abort"],
      },
      revert: {
        continue: ["revert", "--continue"],
        skip: ["revert", "--skip"],
        abort: ["revert", "--abort"],
      },
    };
    const args = table[op]?.[action];
    if (!args) return;
    // "continue" may open an editor for the commit message; keep it non-interactive.
    await this.run(args, action === "continue" ? { GIT_EDITOR: "true" } : undefined);
    await this.refresh();
  }

  /** Stash the checked files (or everything if none checked), including untracked. */
  private async stashPush(message: string, files: string[]): Promise<void> {
    if (!this.root) return;
    const args = ["stash", "push", "--include-untracked"];
    if (message && message.trim()) args.push("-m", message.trim());
    if (files && files.length) args.push("--", ...files);
    if (await this.run(args)) await this.refresh();
  }

  private async stashAction(action: string, selector: string): Promise<void> {
    if (!this.root || !selector) return;
    if (action === "drop") {
      const choice = await vscode.window.showWarningMessage(
        `Drop ${selector}? This permanently discards the stash.`,
        { modal: true },
        "Drop"
      );
      if (choice !== "Drop") return;
      if (await this.run(["stash", "drop", selector])) await this.refresh();
      return;
    }
    if (action === "apply" || action === "pop") {
      if (await this.run(["stash", action, selector])) await this.refresh();
    }
  }

  private async handleAction(msg: {
    action: string;
    name?: string;
    isRemote?: boolean;
    hash?: string;
    mode?: string;
    upstream?: string | null;
  }): Promise<void> {
    if (!this.root) return;
    let ok = false;
    switch (msg.action) {
      case "checkoutBranch": {
        const target = msg.isRemote
          ? String(msg.name).split("/").slice(1).join("/")
          : String(msg.name);
        ok = await this.run(["checkout", target]);
        break;
      }
      case "checkoutCommit":
        ok = await this.run(["checkout", String(msg.hash)]);
        break;
      case "fetch":
        ok = await this.run(["fetch", "--all", "--prune"]);
        break;
      case "pull":
        ok = await this.run(this.integration === "rebase" ? ["pull", "--rebase"] : ["pull"]);
        break;
      case "updateBranch":
        ok = await this.updateBranch(String(msg.name), msg.upstream ?? null);
        break;
      case "push":
        ok = await this.pushBranch(String(msg.name), msg.upstream ?? null, false);
        break;
      case "forcePush":
        ok = await this.forcePush(String(msg.name), msg.upstream ?? null);
        break;
      case "merge":
        ok = await this.run(["merge", String(msg.name)]);
        break;
      case "rebase":
        ok = await this.run(["rebase", String(msg.name)]);
        break;
      case "cherryPick":
        ok = await this.run(["cherry-pick", String(msg.hash)]);
        break;
      case "revert":
        ok = await this.run(["revert", "--no-edit", String(msg.hash)]);
        break;
      case "reset":
        ok = await this.resetTo(String(msg.hash), String(msg.mode));
        break;
      case "renameBranch":
        ok = await this.renameBranch(String(msg.name));
        break;
      case "newBranch":
        ok = await this.newBranch(String(msg.name));
        break;
      case "newBranchFromCommit":
        ok = await this.newBranch(String(msg.hash));
        break;
      case "deleteBranch":
        ok = await this.deleteBranch(String(msg.name), Boolean(msg.isRemote));
        break;
      case "createTag":
        ok = await this.createTag(String(msg.hash));
        break;
      case "pushTag":
        ok = await this.pushTag(String(msg.name));
        break;
      case "deleteTag":
        ok = await this.deleteTag(String(msg.name));
        break;
      case "copyHash":
        await vscode.env.clipboard.writeText(String(msg.hash));
        void vscode.window.showInformationMessage(
          `Copied ${String(msg.hash).slice(0, 8)}`
        );
        return;
      case "copyMessage": {
        const res = await runGit(this.root, ["show", "-s", "--format=%B", String(msg.hash)]);
        if (res.ok) await vscode.env.clipboard.writeText(res.stdout.trimEnd());
        return;
      }
    }
    if (ok) await this.refresh();
  }

  /** Run a git command, record it in the console, and return the raw result. */
  private async exec(args: string[], env?: Record<string, string>): Promise<GitResult> {
    this.setBusy(1);
    let res: GitResult;
    try {
      res = await runGit(this.root!, args, env);
    } finally {
      this.setBusy(-1);
    }
    const entry: ConsoleEntry = {
      command: `git ${args.join(" ")}`,
      ok: res.ok,
      stdout: res.stdout,
      stderr: res.stderr,
      ts: Date.now(),
    };
    this.consoleLog.push(entry);
    if (this.consoleLog.length > 500) this.consoleLog.shift();
    this.post({ type: "console", entry });
    return res;
  }

  private async run(args: string[], env?: Record<string, string>): Promise<boolean> {
    if (!this.root) return false;
    const res = await this.exec(args, env);
    if (!res.ok) {
      const line = res.stderr.split("\n").find((l) => l.trim()) ?? "git failed";
      void vscode.window.showErrorMessage(`git ${args[0]}: ${line}`);
    }
    return res.ok;
  }

  private async resetTo(hash: string, mode: string): Promise<boolean> {
    if (mode === "hard") {
      const choice = await vscode.window.showWarningMessage(
        `Hard reset current branch to ${hash.slice(0, 8)}? This discards uncommitted changes.`,
        { modal: true },
        "Reset Hard"
      );
      if (choice !== "Reset Hard") return false;
    }
    return this.run(["reset", `--${mode}`, hash]);
  }

  private async renameBranch(name: string): Promise<boolean> {
    const newName = await vscode.window.showInputBox({
      prompt: `Rename branch '${name}' to`,
      value: name,
    });
    if (!newName || newName === name) return false;
    return this.run(["branch", "-m", name, newName]);
  }

  private async newBranch(startPoint: string): Promise<boolean> {
    const newName = await vscode.window.showInputBox({
      prompt: `Create new branch from ${startPoint.slice(0, 12)}`,
      placeHolder: "feature/my-branch",
    });
    const branchName = sanitizeBranchName(newName ?? "");
    if (!branchName) return false;
    return this.run(["checkout", "-b", branchName, startPoint]);
  }

  private async deleteBranch(name: string, isRemote: boolean): Promise<boolean> {
    const choice = await vscode.window.showWarningMessage(
      `Delete branch '${name}'?`,
      { modal: true },
      "Delete"
    );
    if (choice !== "Delete") return false;
    if (isRemote) {
      const [remote, ...rest] = name.split("/");
      return this.run(["push", remote, "--delete", rest.join("/")]);
    }
    const res = await this.exec(["branch", "-d", name]);
    if (res.ok) return true;
    const force = await vscode.window.showWarningMessage(
      `Branch '${name}' is not fully merged. Force delete?`,
      { modal: true },
      "Force Delete"
    );
    if (force !== "Force Delete") return false;
    return this.run(["branch", "-D", name]);
  }

  private async createTag(hash: string): Promise<boolean> {
    const name = await vscode.window.showInputBox({
      prompt: `Create tag at ${hash.slice(0, 8)}`,
      placeHolder: "v1.0.0",
    });
    if (!name) return false;
    return this.run(["tag", name, hash]);
  }

  private async pushTag(name: string): Promise<boolean> {
    const remote = await this.pickRemote();
    if (!remote) return false;
    return this.run(["push", remote, name]);
  }

  private async deleteTag(name: string): Promise<boolean> {
    const choice = await vscode.window.showWarningMessage(
      `Delete tag '${name}'?`,
      { modal: true },
      "Delete"
    );
    if (choice !== "Delete") return false;
    return this.run(["tag", "-d", name]);
  }

  private async pushBranch(
    name: string,
    upstream: string | null,
    force: boolean
  ): Promise<boolean> {
    const remote = upstream ? upstream.split("/")[0] : await this.pickRemote();
    if (!remote) return false;
    const args = ["push"];
    if (force) args.push("--force-with-lease");
    if (!upstream) args.push("-u"); // set tracking for a not-yet-pushed branch
    args.push(remote, name);
    return this.run(args);
  }

  /** Fast-forward a non-checked-out local branch to its upstream (no checkout). */
  private async updateBranch(name: string, upstream: string | null): Promise<boolean> {
    if (!upstream) {
      void vscode.window.showErrorMessage(`'${name}' has no upstream to update from.`);
      return false;
    }
    const [remote, ...rest] = upstream.split("/");
    const remoteBranch = rest.join("/");
    // Refspec src:dst fast-forwards the local ref; git refuses non-fast-forward.
    return this.run(["fetch", remote, `${remoteBranch}:${name}`]);
  }

  private async forcePush(name: string, upstream: string | null): Promise<boolean> {
    const choice = await vscode.window.showWarningMessage(
      `Force-push '${name}' with --force-with-lease? This can overwrite remote history.`,
      { modal: true },
      "Force Push"
    );
    if (choice !== "Force Push") return false;
    return this.pushBranch(name, upstream, true);
  }

  private async pickRemote(): Promise<string | undefined> {
    const res = await runGit(this.root!, ["remote"]);
    const remotes = res.stdout.split("\n").map((r) => r.trim()).filter(Boolean);
    if (remotes.length === 0) {
      void vscode.window.showErrorMessage("No remote configured.");
      return undefined;
    }
    if (remotes.length === 1) return remotes[0];
    return vscode.window.showQuickPick(remotes, {
      placeHolder: "Select remote to push to",
    });
  }

  private post(msg: { type: string; [key: string]: unknown }): void {
    void this.view?.webview.postMessage(msg);
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const uri = (f: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", f));
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${uri("style.css")}" rel="stylesheet" />
  <title>pwrgit</title>
</head>
<body>
  <div id="op-banner" class="hidden"></div>
  <div id="app">
    <nav id="activitybar">
      <button class="act active" data-view="log" title="Git Log" aria-label="Git Log">
        <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="3" r="1.7"/><circle cx="4" cy="8" r="1.7"/><circle cx="4" cy="13" r="1.7"/><path d="M8 3h5M8 8h5M8 13h5" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/></svg>
      </button>
      <button class="act" data-view="changes" title="Changes" aria-label="Changes">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2h5l3 3v9H4z" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M6.2 8.2h3.6M8 6.4v3.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
        <span class="act-count hidden" id="changes-count"></span>
      </button>
      <button class="act act-btn" id="fetch-btn" data-action="fetch" title="Fetch all remotes" aria-label="Fetch">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v7M5 6.5 8 9.5 11 6.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 12.5h10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
      </button>
      <button class="act" data-view="console" title="Console" aria-label="Console">
        <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.6" y="2.6" width="12.8" height="10.8" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M4 6l2.4 2L4 10M8.4 10.2H12" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span class="act-badge hidden" id="console-badge"></span>
      </button>
      <button class="act act-btn act-bottom" id="refresh-btn" data-action="refresh" title="Refresh all" aria-label="Refresh">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M13.6 2.2v3h-3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    </nav>
    <div id="views">
      <div class="view active" id="view-log">
        <aside id="branches">
          <div class="pane-header branches-header">
            <span>Branches</span>
            <span class="seg-toggle" id="integration-toggle" title="Pull strategy">
              <button class="seg active" data-mode="merge">Merge</button>
              <button class="seg" data-mode="rebase">Rebase</button>
            </span>
          </div>
          <div id="branch-list"></div>
        </aside>
        <div id="divider"></div>
        <main id="log">
          <div class="pane-header log-header-bar">
            <span id="log-header">Commits</span>
            <span class="limit-box">Limit <input id="limit-input" type="number" min="1" step="100" /></span>
          </div>
          <div id="filter-bar">
            <input id="search-input" type="text" placeholder="Filter by message, author, or hash" />
            <span id="branch-filter" class="hidden"></span>
            <button id="clear-filter" class="hidden" title="Clear filters">Clear</button>
          </div>
          <div id="commit-list"></div>
        </main>
        <div id="divider-details" class="hidden"></div>
        <aside id="details" class="hidden">
          <div class="pane-header" id="details-header">Changed Files</div>
          <div id="commit-info">
            <div class="ci-row">
              <span class="ci-hash" id="ci-hash"></span>
              <button class="ci-icon" id="ci-copy-hash" title="Copy commit hash" aria-label="Copy commit hash"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M3.5 10.5H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h6.5a1 1 0 0 1 1 1v.5" fill="none" stroke="currentColor" stroke-width="1.2"/></svg></button>
              <button class="ci-icon ci-close" id="ci-close" title="Close" aria-label="Close"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></button>
            </div>
            <div class="ci-row">
              <span class="ci-msg" id="ci-msg"></span>
              <button class="ci-icon" id="ci-copy-msg" title="Copy commit message" aria-label="Copy commit message"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M3.5 10.5H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h6.5a1 1 0 0 1 1 1v.5" fill="none" stroke="currentColor" stroke-width="1.2"/></svg></button>
            </div>
          </div>
          <div id="file-list"></div>
        </aside>
      </div>
      <div class="view" id="view-changes">
        <div class="pane-header tab-header">
          <button class="subtab active" data-subtab="changes">Commit</button>
          <button class="subtab" data-subtab="stashes" id="stashes-tab">Stashes</button>
        </div>
        <div class="subview active" id="changes-pane">
          <div id="commit-box">
            <div id="commit-branch">On branch: <span id="commit-branch-name"></span></div>
            <textarea id="commit-message" rows="1" placeholder="Commit message"></textarea>
            <div id="commit-actions">
              <div class="split-btn">
                <button id="commit-btn">Commit</button>
                <button id="commit-more" class="split-caret" title="More commit options" aria-label="More commit options">\u25be</button>
              </div>
              <span class="seg-toggle"><button type="button" class="seg" id="amend-check">Amend</button></span>
              <button id="rollback-btn" class="secondary">Rollback</button>
              <button id="stash-btn" class="secondary">Stash</button>
            </div>
          </div>
          <div id="changes-list"></div>
        </div>
        <div class="subview" id="stashes-pane">
          <div id="stash-list"></div>
        </div>
      </div>
      <div class="view" id="view-console">
        <div class="pane-header">Console</div>
        <div id="console-log"></div>
      </div>
    </div>
  </div>
  <div id="status"><span id="status-info"></span><span id="status-loader" class="status-loader hidden" title="Git operation in progress"></span></div>
  <script nonce="${nonce}" src="${uri("main.js")}"></script>
</body>
</html>`;
  }
}

function isGitPath(uri: vscode.Uri): boolean {
  return /[/\\]\.git([/\\]|$)/.test(uri.fsPath);
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
