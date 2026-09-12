// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  const branchList = /** @type {HTMLElement} */ (document.getElementById("branch-list"));
  const commitList = /** @type {HTMLElement} */ (document.getElementById("commit-list"));
  const logHeader = /** @type {HTMLElement} */ (document.getElementById("log-header"));
  const statusBar = /** @type {HTMLElement} */ (document.getElementById("status-info"));
  const statusLoader = /** @type {HTMLElement} */ (document.getElementById("status-loader"));
  const details = /** @type {HTMLElement} */ (document.getElementById("details"));
  const detailsHeader = /** @type {HTMLElement} */ (document.getElementById("details-header"));
  const fileList = /** @type {HTMLElement} */ (document.getElementById("file-list"));
  const ciHash = /** @type {HTMLElement} */ (document.getElementById("ci-hash"));
  const ciMsg = /** @type {HTMLElement} */ (document.getElementById("ci-msg"));
  const consoleLogEl = /** @type {HTMLElement} */ (document.getElementById("console-log"));
  const consoleBadge = /** @type {HTMLElement} */ (document.getElementById("console-badge"));
  const changesList = /** @type {HTMLElement} */ (document.getElementById("changes-list"));
  const changesCount = /** @type {HTMLElement} */ (document.getElementById("changes-count"));
  const commitMessage = /** @type {HTMLTextAreaElement} */ (document.getElementById("commit-message"));
  const commitBtn = /** @type {HTMLButtonElement} */ (document.getElementById("commit-btn"));
  const amendCheck = /** @type {HTMLButtonElement} */ (document.getElementById("amend-check"));
  const rollbackBtn = /** @type {HTMLButtonElement} */ (document.getElementById("rollback-btn"));
  const commitMore = /** @type {HTMLButtonElement} */ (document.getElementById("commit-more"));
  const searchInput = /** @type {HTMLInputElement} */ (document.getElementById("search-input"));
  const branchFilterLabel = /** @type {HTMLElement} */ (document.getElementById("branch-filter"));
  const clearFilterBtn = /** @type {HTMLButtonElement} */ (document.getElementById("clear-filter"));
  const limitInput = /** @type {HTMLInputElement} */ (document.getElementById("limit-input"));
  const opBanner = /** @type {HTMLElement} */ (document.getElementById("op-banner"));
  const stashBtn = /** @type {HTMLButtonElement} */ (document.getElementById("stash-btn"));
  const stashList = /** @type {HTMLElement} */ (document.getElementById("stash-list"));
  const stashesTab = /** @type {HTMLElement} */ (document.getElementById("stashes-tab"));

  /** Commit whose file list is shown (single-select). */
  let selectedHash = null;
  /** All highlighted commit hashes (multi-select for squash). */
  let selectedHashes = new Set();
  /** Anchor row index for shift-range selection. */
  let anchorIndex = null;
  /** Commits in the current log, in display order (newest first). */
  let currentCommits = [];
  /** Names of remote-tracking refs (e.g. "origin/main"), for purple badges. */
  let remoteRefs = new Set();
  /** Revisions for the selected commit's file diffs. */
  let currentDiff = { rev: "", parentRev: "" };
  /** Name of the checked-out branch, for menu labels. */
  let currentBranch = null;
  /** Paths the user explicitly unchecked in the Changes view (persists across refresh). */
  const uncheckedPaths = new Set();
  /** Full message of HEAD, used to prefill the box when Amend is checked. */
  let headMessage = "";
  /** The user's typed message saved while Amend temporarily replaces it. */
  let preAmendMessage = "";
  /** Active branch filter (branch name) or null. */
  let branchFilter = null;
  /** Debounce timer for the search box. */
  let searchTimer = null;
  /** Pull integration strategy: "merge" or "rebase". */
  let integration = "merge";

  // Layout. LANE_W/ROW_H must stay in sync with .commit height in style.css.
  const LANE_W = 14;
  const ROW_H = 24;
  const NODE_R = 4;
  // Palette length MUST match PALETTE_SIZE in src/graph.ts.
  const PALETTE = [
    "#4e9bff", "#3fb950", "#d29922", "#db6d28", "#a371f7",
    "#e5534b", "#2eb8a6", "#c96198", "#8b949e", "#57ab5a",
  ];

  function graphSvg(graphRow, maxLane) {
    const w = (maxLane + 1) * LANE_W;
    const mid = ROW_H / 2;
    const parts = [];
    for (const e of graphRow.top) parts.push(edgePath(e, 0, mid));
    for (const e of graphRow.bottom) parts.push(edgePath(e, mid, ROW_H));
    const x = graphRow.lane * LANE_W + LANE_W / 2;
    const fill = PALETTE[graphRow.color % PALETTE.length];
    parts.push(
      `<circle cx="${x}" cy="${mid}" r="${NODE_R}" fill="${fill}" ` +
        `stroke="var(--vscode-panel-background)" stroke-width="1.5"/>`
    );
    return `<svg width="${w}" height="${ROW_H}" viewBox="0 0 ${w} ${ROW_H}">${parts.join("")}</svg>`;
  }

  function edgePath(edge, y0, y1) {
    const x0 = edge.from * LANE_W + LANE_W / 2;
    const x1 = edge.to * LANE_W + LANE_W / 2;
    const color = PALETTE[edge.color % PALETTE.length];
    const d =
      x0 === x1
        ? `M${x0},${y0} L${x1},${y1}`
        : `M${x0},${y0} C${x0},${(y0 + y1) / 2} ${x1},${(y0 + y1) / 2} ${x1},${y1}`;
    return `<path d="${d}" fill="none" stroke="${color}" stroke-width="2"/>`;
  }

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg.type === "data") {
      render(msg.data);
    } else if (msg.type === "commitFiles") {
      renderFiles(msg);
    } else if (msg.type === "console") {
      appendConsole(msg.entry);
    } else if (msg.type === "consoleHistory") {
      consoleLogEl.innerHTML = "";
      for (const entry of msg.entries) appendConsole(entry);
    } else if (msg.type === "filterState") {
      branchFilter = msg.filter.branch;
      searchInput.value = msg.filter.search || "";
      updateFilterUI();
    } else if (msg.type === "integrationState") {
      integration = msg.mode === "rebase" ? "rebase" : "merge";
      setIntegrationUI();
    } else if (msg.type === "limitState") {
      if (document.activeElement !== limitInput) limitInput.value = String(msg.limit);
    } else if (msg.type === "busy") {
      statusLoader.classList.toggle("hidden", !msg.busy);
    } else if (msg.type === "status") {
      renderChanges(msg.changes);
    } else if (msg.type === "error") {
      showError(msg.message);
    }
  });

  function showError(message) {
    branchList.innerHTML = "";
    commitList.innerHTML = "";
    statusBar.textContent = message;
  }

  function render(data) {
    currentBranch = data.currentBranch;
    headMessage = data.headMessage || "";
    currentCommits = data.commits;
    remoteRefs = new Set(data.branches.filter((b) => b.isRemote).map((b) => b.name));
    renderOperation(data.operation);
    renderBranches(data);
    updateFilterUI();
    renderCommits(data.commits, data.graph);
    if (data.hasMore) appendLoadMore();
    renderChanges(data.changes);
    renderStashes(data.stashes);
    hideDetails();
    renderStatus(data);
    logHeader.textContent = `Commits (${data.commits.length})`;
  }


  const FOLDER_SVG =
    '<svg viewBox="0 0 16 16"><path d="M1.8 4h4l1.4 1.6H14.2v7.1H1.8z" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/></svg>';
  const BRANCH_SVG =
    '<svg viewBox="0 0 16 16"><circle cx="4" cy="4" r="1.7"/><circle cx="4" cy="12" r="1.7"/><circle cx="12" cy="5.5" r="1.7"/><path d="M4 5.7v4.6M4 8.2h4a4 4 0 0 0 4-1" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';

  function sbIcon(svg, cls) {
    const span = document.createElement("span");
    span.className = "sb-icon" + (cls ? ` ${cls}` : "");
    span.innerHTML = svg;
    return span;
  }

  function sbTrack(kind, count) {
    const span = document.createElement("span");
    span.className = `sb-track ${kind}`;
    span.textContent = `${kind === "incoming" ? "\u2193" : "\u2191"}${count}`;
    span.title = kind === "incoming" ? `${count} incoming` : `${count} outgoing`;
    return span;
  }

  function renderStatus(data) {
    statusBar.innerHTML = "";
    statusBar.appendChild(sbIcon(FOLDER_SVG));
    const path = document.createElement("span");
    path.className = "sb-path";
    path.textContent = data.root;
    statusBar.appendChild(path);

    statusBar.appendChild(sbIcon(BRANCH_SVG, "sb-branch-icon"));
    const branch = document.createElement("span");
    branch.className = "sb-branch";
    branch.textContent = data.currentBranch || "detached HEAD";
    statusBar.appendChild(branch);

    const cur = data.branches.find((b) => b.isCurrent);
    if (cur && cur.behind > 0) statusBar.appendChild(sbTrack("incoming", cur.behind));
    if (cur && cur.ahead > 0) statusBar.appendChild(sbTrack("outgoing", cur.ahead));
  }

  /** Collapsed folder keys ("<group>:<path>"); absent = expanded (default). */
  const collapsedDirs = new Set();
  /** Last repo data, so a folder toggle can re-render without a round trip. */
  let lastBranchData = null;

  function renderBranches(data) {
    lastBranchData = data;
    branchList.innerHTML = "";
    const locals = data.branches.filter((b) => !b.isRemote);
    const remotes = data.branches.filter((b) => b.isRemote);
    branchList.appendChild(refGroup("Local", "local", locals, branchLeafRow));
    branchList.appendChild(refGroup("Remote", "remote", remotes, branchLeafRow));
    if (data.tags && data.tags.length) {
      branchList.appendChild(refGroup("Tags", "tag", data.tags, tagLeafRow));
    }
  }

  /** Build a path trie from refs, splitting each name on "/". */
  function buildRefTree(items) {
    const root = { name: "", path: "", children: new Map(), ref: null };
    for (const item of items) {
      let node = root;
      let path = "";
      for (const seg of item.name.split("/").filter(Boolean)) {
        path = path ? `${path}/${seg}` : seg;
        let child = node.children.get(seg);
        if (!child) {
          child = { name: seg, path, children: new Map(), ref: null };
          node.children.set(seg, child);
        }
        node = child;
      }
      node.ref = item; // an exact ref name lands on this node as a leaf
    }
    return root;
  }

  function refGroup(title, keyPrefix, items, renderLeaf) {
    const group = document.createElement("div");
    group.className = "branch-group";
    const heading = document.createElement("div");
    heading.className = "branch-group-title";
    heading.textContent = `${title} (${items.length})`;
    group.appendChild(heading);
    renderRefTree(group, buildRefTree(items), 0, keyPrefix, renderLeaf);
    return group;
  }

  /** Emit a node's children: folders first, then leaves, alphabetical within each. */
  function renderRefTree(container, node, depth, keyPrefix, renderLeaf) {
    const children = [...node.children.values()].sort((a, b) => {
      const aFolder = a.children.size > 0;
      const bFolder = b.children.size > 0;
      if (aFolder !== bFolder) return aFolder ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const child of children) {
      if (child.children.size > 0) {
        const key = `${keyPrefix}:${child.path}`;
        const collapsed = collapsedDirs.has(key);
        container.appendChild(dirRow(child, depth, key, collapsed));
        if (!collapsed) renderRefTree(container, child, depth + 1, keyPrefix, renderLeaf);
      }
      // A name that is both a folder and a ref shows as its own leaf too.
      if (child.ref) container.appendChild(renderLeaf(child.ref, child.name, depth));
    }
  }

  function dirRow(node, depth, key, collapsed) {
    const row = document.createElement("div");
    row.className = "branch branch-dir";
    row.style.setProperty("--depth", String(depth));
    const chevron = document.createElement("span");
    chevron.className = "dir-chevron";
    chevron.textContent = collapsed ? "\u25B8" : "\u25BE";
    const name = document.createElement("span");
    name.className = "branch-name dir-name";
    name.textContent = node.name;
    row.appendChild(chevron);
    row.appendChild(name);
    row.title = node.path;
    row.addEventListener("dblclick", () => {
      if (collapsedDirs.has(key)) collapsedDirs.delete(key);
      else collapsedDirs.add(key);
      renderBranches(lastBranchData);
      updateFilterUI();
    });
    return row;
  }

  function branchLeafRow(b, label, depth) {
    const row = document.createElement("div");
    row.className = "branch" + (b.isCurrent ? " current" : "");
    row.style.setProperty("--depth", String(depth));
    row.dataset.name = b.name;
    const spacer = document.createElement("span");
    spacer.className = "leaf-indent";
    row.appendChild(spacer);
    const nameSpan = document.createElement("span");
    nameSpan.className = "branch-name";
    nameSpan.textContent = label;
    row.appendChild(nameSpan);
    if (b.behind > 0) row.appendChild(trackBadge("incoming", b.behind));
    if (b.ahead > 0) row.appendChild(trackBadge("outgoing", b.ahead));
    row.title = b.upstream ? `${b.name} \u2192 ${b.upstream}` : b.name;
    row.addEventListener("dblclick", () => {
      branchFilter = b.name;
      updateFilterUI();
      sendFilter();
    });
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showMenu(e.clientX, e.clientY, branchMenu(b));
    });
    return row;
  }

  function tagLeafRow(t, label, depth) {
    const row = document.createElement("div");
    row.className = "branch tag-row";
    row.style.setProperty("--depth", String(depth));
    row.dataset.name = t.name;
    const spacer = document.createElement("span");
    spacer.className = "leaf-indent";
    row.appendChild(spacer);
    const name = document.createElement("span");
    name.className = "branch-name";
    name.textContent = label;
    row.appendChild(name);
    row.title = `${t.name} \u2192 ${t.shortHash}`;
    row.addEventListener("dblclick", () => {
      branchFilter = t.name;
      updateFilterUI();
      sendFilter();
    });
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showMenu(e.clientX, e.clientY, tagMenu(t));
    });
    return row;
  }

  function tagMenu(t) {
    return [
      { label: "Checkout", run: () => send("checkoutBranch", { name: t.name, isRemote: false }) },
      { label: `New Branch from '${t.name}'\u2026`, run: () => send("newBranch", { name: t.name }) },
      { sep: true },
      { label: "Push Tag", run: () => send("pushTag", { name: t.name }) },
      { label: `Delete Tag '${t.name}'`, danger: true, run: () => send("deleteTag", { name: t.name }) },
    ];
  }

  function trackBadge(kind, count) {
    const badge = document.createElement("span");
    badge.className = `track-badge ${kind}`;
    const arrow = kind === "incoming" ? "\u2193" : "\u2191";
    badge.textContent = `${arrow}${count}`;
    badge.title = kind === "incoming" ? `${count} incoming (pull)` : `${count} outgoing (push)`;
    return badge;
  }

  // ---- Log filtering (branch + free text) ----

  function sendFilter() {
    vscode.postMessage({
      type: "setFilter",
      branch: branchFilter,
      search: searchInput.value,
    });
  }

  function updateFilterUI() {
    if (branchFilter) {
      branchFilterLabel.textContent = `\u2387 ${branchFilter}`;
      branchFilterLabel.classList.remove("hidden");
    } else {
      branchFilterLabel.classList.add("hidden");
    }
    const active = Boolean(branchFilter) || searchInput.value.trim() !== "";
    clearFilterBtn.classList.toggle("hidden", !active);
    for (const el of branchList.querySelectorAll(".branch")) {
      el.classList.toggle("filter-active", el.dataset.name === branchFilter);
    }
  }

  searchInput.addEventListener("input", () => {
    updateFilterUI();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(sendFilter, 250);
  });

  clearFilterBtn.addEventListener("click", () => {
    branchFilter = null;
    searchInput.value = "";
    updateFilterUI();
    sendFilter();
  });

  function renderCommits(commits, graph) {
    commitList.innerHTML = "";
    const gutter = (graph.maxLane + 1) * LANE_W;
    commitList.style.setProperty("--graph-w", `${gutter}px`);
    const rowByHash = new Map(graph.rows.map((r) => [r.hash, r]));
    const frag = document.createDocumentFragment();
    commits.forEach((c, i) => {
      frag.appendChild(commitRow(c, rowByHash.get(c.hash), graph.maxLane, i));
    });
    commitList.appendChild(frag);
  }

  function appendLoadMore() {
    const el = document.createElement("div");
    el.className = "load-more";
    el.textContent = "Load more\u2026";
    el.addEventListener("click", () => vscode.postMessage({ type: "loadMore" }));
    commitList.appendChild(el);
  }

  limitInput.addEventListener("change", () => {
    const n = parseInt(limitInput.value, 10);
    if (n > 0) vscode.postMessage({ type: "setLimit", limit: n });
  });

  function commitRow(c, graphRow, maxLane, index) {
    const row = document.createElement("div");
    const atHead = c.refs.some((r) => r === "HEAD" || r.startsWith("HEAD ->"));
    row.className =
      "commit" +
      (selectedHashes.has(c.hash) ? " selected" : "") +
      (atHead ? " at-head" : "");
    row.dataset.hash = c.hash;

    const graph = document.createElement("div");
    graph.className = "commit-graph";
    if (graphRow) graph.innerHTML = graphSvg(graphRow, maxLane);
    row.appendChild(graph);

    const subject = document.createElement("div");
    subject.className = "commit-subject";
    subject.textContent = c.subject;
    subject.title = c.subject;

    const refs = document.createElement("div");
    refs.className = "commit-refs";
    const tagRefs = c.refs.filter((r) => r.startsWith("tag: "));
    const branchRefs = c.refs.filter((r) => !r.startsWith("tag: "));
    const localRefs = branchRefs.filter((r) => !remoteRefs.has(r));
    const remoteBranchRefs = branchRefs.filter((r) => remoteRefs.has(r));
    for (const ref of localRefs) {
      const badge = document.createElement("span");
      badge.className = "ref-tag ref-tag-local";
      badge.textContent = ref.replace(/^HEAD -> /, "");
      refs.appendChild(badge);
    }
    for (const ref of remoteBranchRefs) {
      const badge = document.createElement("span");
      badge.className = "ref-tag ref-tag-remote";
      badge.textContent = ref;
      refs.appendChild(badge);
    }
    for (const ref of tagRefs) {
      const badge = document.createElement("span");
      badge.className = "ref-tag ref-tag-tag";
      badge.textContent = ref.slice(5);
      refs.appendChild(badge);
    }

    const author = document.createElement("div");
    author.className = "commit-author";
    author.textContent = c.author;

    const date = document.createElement("div");
    date.className = "commit-date";
    date.textContent = formatDate(c.timestamp);

    row.appendChild(subject);
    row.appendChild(refs);
    row.appendChild(author);
    row.appendChild(date);

    row.addEventListener("click", (e) => {
      if (e.shiftKey && anchorIndex !== null) {
        const lo = Math.min(anchorIndex, index);
        const hi = Math.max(anchorIndex, index);
        selectedHashes = new Set(currentCommits.slice(lo, hi + 1).map((x) => x.hash));
      } else if (e.ctrlKey || e.metaKey) {
        if (selectedHashes.has(c.hash)) selectedHashes.delete(c.hash);
        else selectedHashes.add(c.hash);
        anchorIndex = index;
      } else {
        selectedHashes = new Set([c.hash]);
        anchorIndex = index;
        selectedHash = c.hash;
        vscode.postMessage({
          type: "selectCommit",
          hash: c.hash,
          parent: c.parents[0] || null,
        });
      }
      applyCommitSelection();
    });

    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (selectedHashes.size >= 2 && selectedHashes.has(c.hash)) {
        showMenu(e.clientX, e.clientY, [
          { label: `Squash ${selectedHashes.size} commits\u2026`, run: doSquash },
        ]);
      } else {
        showMenu(e.clientX, e.clientY, commitMenu(c));
      }
    });

    return row;
  }

  function applyCommitSelection() {
    for (const el of commitList.querySelectorAll(".commit")) {
      el.classList.toggle("selected", selectedHashes.has(el.dataset.hash));
    }
  }

  function doSquash() {
    const selected = currentCommits.filter((c) => selectedHashes.has(c.hash));
    vscode.postMessage({
      type: "squash",
      commits: selected.map((c) => ({ hash: c.hash, parents: c.parents })),
    });
  }

  const OP_NAME = { merge: "Merge", rebase: "Rebase", "cherry-pick": "Cherry-pick", revert: "Revert" };
  const OP_ACTION_LABEL = { continue: "Continue", skip: "Skip", abort: "Abort" };

  function renderOperation(op) {
    opBanner.innerHTML = "";
    if (!op || !op.type) {
      opBanner.classList.add("hidden");
      return;
    }
    opBanner.classList.remove("hidden");
    const label = document.createElement("span");
    label.className = "op-label";
    const conflicts =
      op.conflicts > 0 ? ` \u2014 ${op.conflicts} conflict${op.conflicts === 1 ? "" : "s"}` : "";
    label.textContent = `${OP_NAME[op.type] || op.type} in progress${conflicts}`;
    opBanner.appendChild(label);
    const actions = op.type === "merge" ? ["continue", "abort"] : ["continue", "skip", "abort"];
    for (const a of actions) {
      const btn = document.createElement("button");
      btn.className = "op-btn" + (a === "abort" ? " danger" : "");
      btn.textContent = OP_ACTION_LABEL[a];
      btn.addEventListener("click", () =>
        vscode.postMessage({ type: "opAction", op: op.type, action: a })
      );
      opBanner.appendChild(btn);
    }
  }

  const STATUS_LABEL = { A: "Added", M: "Modified", D: "Deleted", R: "Renamed", C: "Copied", T: "Type" };

  function hideDetails() {
    details.classList.add("hidden");
    fileList.innerHTML = "";
  }

  document.getElementById("ci-close").addEventListener("click", hideDetails);
  document.getElementById("ci-copy-hash").addEventListener("click", () => {
    if (currentDiff.rev) vscode.postMessage({ type: "action", action: "copyHash", hash: currentDiff.rev });
  });
  document.getElementById("ci-copy-msg").addEventListener("click", () => {
    if (currentDiff.rev) vscode.postMessage({ type: "action", action: "copyMessage", hash: currentDiff.rev });
  });

  function renderFiles(msg) {
    if (msg.hash !== selectedHash) return;
    currentDiff = { rev: msg.hash, parentRev: msg.parentRev };
    fileList.innerHTML = "";
    detailsHeader.textContent = `Changed Files (${msg.files.length})`;
    const commit = currentCommits.find((c) => c.hash === msg.hash);
    ciHash.textContent = commit ? commit.shortHash : msg.hash.slice(0, 7);
    ciMsg.textContent = commit ? commit.subject : "";
    ciMsg.title = commit ? commit.subject : "";
    for (const f of msg.files) {
      fileList.appendChild(fileRow(f));
    }
    details.classList.remove("hidden");
  }

  function fileRow(f) {
    const row = document.createElement("div");
    row.className = "file";
    row.title = STATUS_LABEL[f.status] || f.status;

    const badge = document.createElement("span");
    badge.className = `file-status status-${f.status}`;
    badge.textContent = f.status;

    const name = document.createElement("span");
    name.className = "file-name";
    const slash = f.path.lastIndexOf("/");
    name.textContent = slash < 0 ? f.path : f.path.slice(slash + 1);

    const dir = document.createElement("span");
    dir.className = "file-dir";
    dir.textContent = slash < 0 ? "" : f.path.slice(0, slash);

    row.appendChild(badge);
    row.appendChild(name);
    row.appendChild(dir);

    row.addEventListener("click", () => {
      vscode.postMessage({
        type: "openDiff",
        path: f.path,
        oldPath: f.oldPath || null,
        rev: currentDiff.rev,
        parentRev: currentDiff.parentRev,
      });
    });
    return row;
  }

  // ---- Changes view ----

  function renderChanges(changes) {
    changesList.innerHTML = "";
    const count = changes.length;
    changesCount.textContent = String(count);
    changesCount.classList.toggle("hidden", count === 0);
    if (count === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-view";
      empty.textContent = "No local changes.";
      changesList.appendChild(empty);
      return;
    }
    const tracked = changes.filter((c) => !c.untracked);
    const untracked = changes.filter((c) => c.untracked);
    if (tracked.length) changesList.appendChild(changeGroup("Changes", tracked));
    if (untracked.length) changesList.appendChild(changeGroup("Unversioned Files", untracked));
  }

  function changeGroup(title, changes) {
    const group = document.createElement("div");
    group.className = "change-group";
    const heading = document.createElement("div");
    heading.className = "branch-group-title";
    heading.textContent = `${title} (${changes.length})`;
    group.appendChild(heading);
    for (const c of changes) group.appendChild(changeRow(c));
    return group;
  }

  function changeRow(c) {
    const row = document.createElement("div");
    row.className = "change";

    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "change-check";
    box.dataset.path = c.path;
    box.dataset.status = c.status;
    box.dataset.oldPath = c.oldPath || "";
    box.checked = !uncheckedPaths.has(c.path);
    box.addEventListener("change", () => {
      if (box.checked) uncheckedPaths.delete(c.path);
      else uncheckedPaths.add(c.path);
    });
    row.appendChild(box);

    const badge = document.createElement("span");
    badge.className = `file-status status-${c.status}`;
    badge.textContent = c.status;
    row.appendChild(badge);

    const name = document.createElement("span");
    name.className = "file-name";
    const slash = c.path.lastIndexOf("/");
    name.textContent = slash < 0 ? c.path : c.path.slice(slash + 1);
    row.appendChild(name);

    const dir = document.createElement("span");
    dir.className = "file-dir";
    dir.textContent = slash < 0 ? "" : c.path.slice(0, slash);
    row.appendChild(dir);

    row.addEventListener("click", (e) => {
      if (e.target === box) return;
      vscode.postMessage({
        type: "openWorkingDiff",
        path: c.path,
        status: c.status,
        untracked: c.untracked,
        oldPath: c.oldPath || null,
      });
    });
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showMenu(e.clientX, e.clientY, [
        { label: "Show Diff", run: () => vscode.postMessage({ type: "openWorkingDiff", path: c.path, status: c.status, untracked: c.untracked, oldPath: c.oldPath || null }) },
        { sep: true },
        { label: "Stash", run: () => vscode.postMessage({ type: "stash", message: commitMessage.value, files: [c.path] }) },
        { label: "Rollback\u2026", danger: true, run: () => vscode.postMessage({ type: "rollback", files: [{ path: c.path, status: c.status, oldPath: c.oldPath || null }] }) },
      ]);
    });
    return row;
  }

  function doCommit(push) {
    const files = [];
    for (const box of changesList.querySelectorAll(".change-check")) {
      if (box.checked) files.push(box.dataset.path);
    }
    vscode.postMessage({
      type: "commit",
      message: commitMessage.value,
      files,
      amend: amendCheck.classList.contains("active"),
      push,
    });
  }

  commitBtn.addEventListener("click", () => doCommit(false));
  commitMore.addEventListener("click", (e) => {
    e.stopPropagation();
    const r = commitMore.getBoundingClientRect();
    showMenu(r.left, r.bottom, [
      { label: "Commit", run: () => doCommit(false) },
      { label: "Commit and Push", run: () => doCommit(true) },
    ]);
  });

  amendCheck.addEventListener("click", () => {
    const active = amendCheck.classList.toggle("active");
    if (active) {
      preAmendMessage = commitMessage.value;
      commitMessage.value = headMessage;
    } else {
      commitMessage.value = preAmendMessage;
    }
  });

  rollbackBtn.addEventListener("click", () => {
    const files = [];
    for (const box of changesList.querySelectorAll(".change-check")) {
      if (box.checked) {
        files.push({
          path: box.dataset.path,
          status: box.dataset.status,
          oldPath: box.dataset.oldPath || null,
        });
      }
    }
    if (files.length === 0) return;
    vscode.postMessage({ type: "rollback", files });
  });

  stashBtn.addEventListener("click", () => {
    const files = [];
    for (const box of changesList.querySelectorAll(".change-check")) {
      if (box.checked) files.push(box.dataset.path);
    }
    vscode.postMessage({ type: "stash", message: commitMessage.value, files });
  });

  // ---- Changes / Stashes sub-tabs ----

  for (const btn of document.querySelectorAll(".subtab")) {
    btn.addEventListener("click", () => {
      const sub = btn.getAttribute("data-subtab");
      for (const b of document.querySelectorAll(".subtab")) {
        b.classList.toggle("active", b === btn);
      }
      for (const pane of document.querySelectorAll(".subview")) {
        pane.classList.toggle("active", pane.id === `${sub}-pane`);
      }
    });
  }

  function setIntegrationUI() {
    for (const b of document.querySelectorAll("#integration-toggle .seg")) {
      b.classList.toggle("active", b.getAttribute("data-mode") === integration);
    }
  }

  for (const b of document.querySelectorAll("#integration-toggle .seg")) {
    b.addEventListener("click", () => {
      integration = b.getAttribute("data-mode");
      setIntegrationUI();
      vscode.postMessage({ type: "setIntegration", mode: integration });
    });
  }

  function renderStashes(stashes) {
    stashList.innerHTML = "";
    stashesTab.textContent = stashes.length ? `Stashes (${stashes.length})` : "Stashes";
    if (stashes.length === 0) {
      const empty = document.createElement("div");
      empty.className = "stash-empty";
      empty.textContent = "No stashes.";
      stashList.appendChild(empty);
      return;
    }
    for (const s of stashes) stashList.appendChild(stashRow(s));
  }

  function stashRow(s) {
    const row = document.createElement("div");
    row.className = "stash";

    const msg = document.createElement("span");
    msg.className = "stash-msg";
    msg.textContent = s.message;
    msg.title = `${s.selector}: ${s.message}`;
    row.appendChild(msg);

    const date = document.createElement("span");
    date.className = "stash-date";
    date.textContent = s.date;
    row.appendChild(date);

    const actions = document.createElement("span");
    actions.className = "stash-actions";
    for (const a of ["apply", "pop", "drop"]) {
      const btn = document.createElement("button");
      btn.className = "stash-btn" + (a === "drop" ? " danger" : "");
      btn.textContent = a[0].toUpperCase() + a.slice(1);
      btn.addEventListener("click", () =>
        vscode.postMessage({ type: "stashAction", action: a, selector: s.selector })
      );
      actions.appendChild(btn);
    }
    row.appendChild(actions);
    return row;
  }

  function formatDate(seconds) {
    const d = new Date(seconds * 1000);
    const now = Date.now();
    const diffDays = (now - d.getTime()) / 86400000;
    if (diffDays < 1 && d.getDate() === new Date().getDate()) {
      return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    }
    return d.toLocaleDateString(undefined, { year: "2-digit", month: "2-digit", day: "2-digit" });
  }

  // ---- Context menus ----

  const menuEl = document.createElement("div");
  menuEl.className = "context-menu hidden";
  document.body.appendChild(menuEl);

  function hideMenu() {
    menuEl.classList.add("hidden");
    menuEl.innerHTML = "";
  }

  function showMenu(x, y, items) {
    menuEl.innerHTML = "";
    for (const item of items) {
      if (item.sep) {
        const sep = document.createElement("div");
        sep.className = "menu-sep";
        menuEl.appendChild(sep);
        continue;
      }
      const el = document.createElement("div");
      el.className = "menu-item" + (item.danger ? " danger" : "");
      el.textContent = item.label;
      el.addEventListener("click", () => {
        hideMenu();
        item.run();
      });
      menuEl.appendChild(el);
    }
    menuEl.classList.remove("hidden");
    // Clamp within the viewport.
    const r = menuEl.getBoundingClientRect();
    const px = x + r.width > window.innerWidth ? window.innerWidth - r.width - 4 : x;
    const py = y + r.height > window.innerHeight ? window.innerHeight - r.height - 4 : y;
    menuEl.style.left = `${Math.max(0, px)}px`;
    menuEl.style.top = `${Math.max(0, py)}px`;
  }

  function send(action, payload) {
    vscode.postMessage({ type: "action", action, ...payload });
  }

  function branchMenu(b) {
    const items = [
      { label: "Checkout", run: () => send("checkoutBranch", { name: b.name, isRemote: b.isRemote }) },
      { label: `New Branch from '${b.name}'\u2026`, run: () => send("newBranch", { name: b.name }) },
      { sep: true },
      { label: "Fetch", run: () => send("fetch", {}) },
    ];
    if (b.isCurrent) items.push({ label: "Pull", run: () => send("pull", {}) });
    if (!b.isRemote && !b.isCurrent && b.upstream) {
      items.push({ label: "Update (fast-forward to upstream)", run: () => send("updateBranch", { name: b.name, upstream: b.upstream }) });
    }
    if (!b.isRemote) {
      items.push({ label: "Push", run: () => send("push", { name: b.name, upstream: b.upstream || null }) });
      items.push({ label: "Force Push (--force-with-lease)", danger: true, run: () => send("forcePush", { name: b.name, upstream: b.upstream || null }) });
    }
    if (!b.isCurrent && currentBranch) {
      items.push({ sep: true });
      items.push({ label: `Merge '${b.name}' into '${currentBranch}'`, run: () => send("merge", { name: b.name }) });
      items.push({ label: `Rebase '${currentBranch}' onto '${b.name}'`, run: () => send("rebase", { name: b.name }) });
    }
    items.push({ sep: true });
    if (!b.isRemote) items.push({ label: "Rename\u2026", run: () => send("renameBranch", { name: b.name }) });
    if (!b.isCurrent) items.push({ label: `Delete '${b.name}'`, danger: true, run: () => send("deleteBranch", { name: b.name, isRemote: b.isRemote }) });
    return items;
  }

  function commitMenu(c) {
    return [
      { label: "Checkout (detached)", run: () => send("checkoutCommit", { hash: c.hash }) },
      { label: "New Branch from here\u2026", run: () => send("newBranchFromCommit", { hash: c.hash }) },
      { label: "Create Tag Here\u2026", run: () => send("createTag", { hash: c.hash }) },
      { sep: true },
      { label: "Cherry-pick", run: () => send("cherryPick", { hash: c.hash }) },
      { label: "Revert", run: () => send("revert", { hash: c.hash }) },
      { sep: true },
      { label: "Reset current to here (soft)", run: () => send("reset", { hash: c.hash, mode: "soft" }) },
      { label: "Reset current to here (mixed)", run: () => send("reset", { hash: c.hash, mode: "mixed" }) },
      { label: "Reset current to here (hard)", danger: true, run: () => send("reset", { hash: c.hash, mode: "hard" }) },
      { sep: true },
      { label: "Copy Revision Number", run: () => send("copyHash", { hash: c.hash }) },
      { label: "Copy Message", run: () => send("copyMessage", { hash: c.hash }) },
    ];
  }

  document.addEventListener("click", hideMenu);
  document.addEventListener("scroll", hideMenu, true);
  window.addEventListener("blur", hideMenu);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideMenu();
  });

  // ---- View switching + console ----

  let activeView = "log";

  function setView(view) {
    activeView = view;
    for (const btn of document.querySelectorAll(".act")) {
      btn.classList.toggle("active", btn.getAttribute("data-view") === view);
    }
    for (const el of document.querySelectorAll(".view")) {
      el.classList.toggle("active", el.id === `view-${view}`);
    }
    if (view === "console") consoleBadge.classList.add("hidden");
  }

  for (const btn of document.querySelectorAll(".act")) {
    btn.addEventListener("click", () => {
      const view = btn.getAttribute("data-view");
      if (view) {
        setView(view);
      } else if (btn.getAttribute("data-action") === "fetch") {
        vscode.postMessage({ type: "action", action: "fetch" });
      } else if (btn.getAttribute("data-action") === "refresh") {
        vscode.postMessage({ type: "refresh" });
      }
    });
  }

  function appendConsole(entry) {
    const block = document.createElement("div");
    block.className = "console-entry" + (entry.ok ? "" : " failed");

    const cmd = document.createElement("div");
    cmd.className = "console-cmd";
    cmd.textContent = `$ ${entry.command}`;
    const time = document.createElement("span");
    time.className = "console-time";
    time.textContent = new Date(entry.ts).toLocaleTimeString();
    cmd.appendChild(time);
    block.appendChild(cmd);

    if (entry.stdout && entry.stdout.trim()) {
      const out = document.createElement("pre");
      out.className = "console-out";
      out.textContent = entry.stdout.replace(/\s+$/, "");
      block.appendChild(out);
    }
    if (entry.stderr && entry.stderr.trim()) {
      const err = document.createElement("pre");
      err.className = "console-err";
      err.textContent = entry.stderr.replace(/\s+$/, "");
      block.appendChild(err);
    }

    consoleLogEl.appendChild(block);
    consoleLogEl.scrollTop = consoleLogEl.scrollHeight;
    if (!entry.ok && activeView !== "console") {
      consoleBadge.classList.remove("hidden");
    }
  }

  vscode.postMessage({ type: "ready" });
})();
