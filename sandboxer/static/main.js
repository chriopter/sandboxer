/* Sandboxer - Dashboard JavaScript */

let resumeSessionsCache = {};

// ═══ WebTUI Select Dropdown Custom Element ═══

class SelectDropdown extends HTMLElement {
  connectedCallback() {
    const self = this;
    const details = this.querySelector("details");
    const summary = this.querySelector("summary");
    const buttons = Array.from(this.querySelectorAll("column > button"));

    buttons.forEach(btn => {
      btn.addEventListener("click", () => {
        // Update aria-selected on all buttons
        buttons.forEach(b => b.setAttribute("aria-selected", "false"));
        btn.setAttribute("aria-selected", "true");

        // Update data-value on the select-dropdown element
        const value = btn.getAttribute("data-value");
        self.setAttribute("data-value", value);

        // Update summary text with indicator
        if (summary) {
          const indicator = summary.querySelector(".dropdown-indicator");
          summary.textContent = btn.textContent.trim() + " ";
          if (indicator) {
            summary.appendChild(indicator);
          } else {
            const span = document.createElement("span");
            span.className = "dropdown-indicator";
            span.textContent = "˅";
            summary.appendChild(span);
          }
        }

        // Close the dropdown
        if (details) details.removeAttribute("open");

        // Dispatch change event
        self.dispatchEvent(new CustomEvent("change", { detail: { value } }));
      });
    });
  }

  get value() {
    return this.getAttribute("data-value") || "";
  }

  set value(v) {
    this.setAttribute("data-value", v);
    const summary = this.querySelector("summary");
    const btn = this.querySelector(`column > button[data-value="${v}"]`);
    if (summary && btn) {
      summary.textContent = btn.textContent.trim();
      // Update aria-selected
      this.querySelectorAll("column > button").forEach(b =>
        b.setAttribute("aria-selected", b === btn ? "true" : "false")
      );
    }
  }
}

customElements.define("select-dropdown", SelectDropdown);

// ═══ Dropdown Helpers ═══

// Cache for selected directory to avoid repeated DOM queries
let _selectedDirCache = null;
let _folderPathMap = null; // Maps folder name -> full path

function buildFolderPathMap() {
  _folderPathMap = {};
  const cards = document.querySelectorAll(".card[data-workdir]");
  cards.forEach(card => {
    const workdir = card.dataset.workdir;
    if (workdir && workdir !== "/") {
      const name = workdir.split("/").pop();
      _folderPathMap[name] = workdir;
    }
  });
}

function getSelectedDir() {
  if (_selectedDirCache !== null) return _selectedDirCache;

  // Get folder from URL path (e.g., /sandboxer -> sandboxer, /root -> /)
  const pathName = window.location.pathname.split("/")[1] || "root";
  if (pathName === "root") {
    _selectedDirCache = "/";
    return _selectedDirCache;
  }

  if (!_folderPathMap) buildFolderPathMap();
  _selectedDirCache = _folderPathMap[pathName] || "/";
  return _selectedDirCache;
}

function setSelectedDir(folder) {
  _selectedDirCache = folder;
  // Also update folder path map
  if (folder && folder !== "/") {
    if (!_folderPathMap) _folderPathMap = {};
    const name = folder.split("/").pop();
    _folderPathMap[name] = folder;
  }
}

function switchToFolder(folder) {
  // Update stored selection
  setSelectedDir(folder);

  // Filter visible sessions
  filterSessionsByFolder(folder);

  // Handle resume type
  const type = getSelectedType();
  if (type === "resume") {
    loadResumeSessions(folder);
  }

  // Save to server and update URL
  saveSelectedFolder(folder);
}

function getSelectedType() {
  const el = document.getElementById("typeSelect");
  return el?.value || "claude";
}

function getSelectedResume() {
  const el = document.getElementById("resumeSelect");
  return el?.value || "";
}

// ═══ Session Management ═══

async function createSession(forceType) {
  const type = forceType || getSelectedType();
  const dir = getSelectedDir();
  const resumeId = getSelectedResume();

  if (!forceType) localStorage.setItem("sandboxer_type", type);

  let url = "/api/create?type=" + type + "&dir=" + encodeURIComponent(dir);
  if (type === "resume" && resumeId) {
    url += "&resume_id=" + encodeURIComponent(resumeId);
  }

  try {
    const res = await fetch(url);
    const data = await res.json();

    if (data.ok && data.html) {
      const grid = document.querySelector(".grid");

      // Remove empty state if present
      const empty = grid.querySelector(".empty");
      if (empty) empty.remove();
      const tempEmpty = document.getElementById("temp-empty");
      if (tempEmpty) tempEmpty.remove();

      // Insert new card at beginning
      const template = document.createElement("template");
      template.innerHTML = data.html.trim();
      const newCard = template.content.firstChild;
      grid.prepend(newCard);

      // Initialize drag & drop and resize observer for new card
      initCardDragDrop(newCard);
      observeCardResize(newCard);

      // Set up iframe retry for the new card
      const iframe = newCard.querySelector(".terminal iframe");
      if (iframe) setupIframeRetry(iframe);

      // Update terminal scales for new card
      requestAnimationFrame(updateTerminalScales);

      // Update sidebar
      populateSidebar();

      // Save new order
      saveCardOrder();
    }
  } catch (err) {
    console.error("Failed to create session:", err);
    cleanupAndReload();
  }
}

function renameSession(name) {
  const newName = prompt("Rename session:", name);
  if (newName && newName !== name) {
    cleanupAndNavigate(
      "/rename?old=" + encodeURIComponent(name) + "&new=" + encodeURIComponent(newName)
    );
  }
}

// Store timeout IDs per button to avoid conflicts when clicking multiple kill buttons
const killTimeouts = new WeakMap();

async function killSession(btn, name) {
  if (!btn || !name) return;

  if (btn.classList.contains("confirm")) {
    // Clear the timeout since we're confirming
    const existingTimeout = killTimeouts.get(btn);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
      killTimeouts.delete(btn);
    }

    // Disable button to prevent double-clicks
    btn.disabled = true;
    btn.textContent = "...";

    try {
      const res = await fetch("/kill?session=" + encodeURIComponent(name));
      if (!res.ok && res.status !== 302) {
        throw new Error("Kill failed with status " + res.status);
      }

      // Remove card from DOM without full reload
      const card = btn.closest(".card");
      if (card) {
        card.remove();

        // Show empty state if no cards left
        const grid = document.querySelector(".grid");
        const remainingCards = grid.querySelectorAll(".card");
        if (remainingCards.length === 0) {
          grid.innerHTML = `
            <div class="empty">
              <div class="empty-icon">◇</div>
              <p>no active sessions</p>
              <p class="hint">create one below</p>
            </div>`;
        }

        // Update sidebar and save order
        populateSidebar();
        saveCardOrder();
      }
    } catch (err) {
      console.error("Failed to kill session:", err);
      showToast("Failed to kill session: " + err.message, "error");
      btn.disabled = false;
      btn.classList.remove("confirm");
      btn.textContent = "×";
      btn.title = "";
    }
  } else {
    btn.classList.add("confirm");
    btn.textContent = "✓";  // More visible confirm indicator
    btn.title = "Click again to confirm kill";

    // Clear any existing timeout for this specific button
    const existingTimeout = killTimeouts.get(btn);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    // Set new timeout for this button (5 seconds to confirm)
    const timeoutId = setTimeout(() => {
      btn.classList.remove("confirm");
      btn.textContent = "×";
      btn.title = "";
      killTimeouts.delete(btn);
    }, 5000);
    killTimeouts.set(btn, timeoutId);
  }
}

// ═══ Close All Sessions ═══

async function closeAllSessions() {
  const cards = document.querySelectorAll(".card");
  const visibleCards = [...cards].filter(card => card.style.display !== "none");

  if (visibleCards.length === 0) {
    showToast("No sessions to close", "info");
    return;
  }

  const dir = getSelectedDir();
  const folderName = dir === "/" ? "all folders" : dir.split("/").pop() || dir;

  if (!confirm(`Close ${visibleCards.length} session(s) in "${folderName}"?`)) {
    return;
  }

  // Kill all sessions
  for (const card of visibleCards) {
    const name = card.dataset.session;
    await fetch("/kill?session=" + encodeURIComponent(name));
    card.remove();
  }

  // Show empty state
  const grid = document.querySelector(".grid");
  const remainingCards = grid.querySelectorAll(".card");
  if (remainingCards.length === 0 || [...remainingCards].every(c => c.style.display === "none")) {
    const existingEmpty = grid.querySelector(".empty");
    if (!existingEmpty) {
      const emptyDiv = document.createElement("div");
      emptyDiv.className = "empty";
      emptyDiv.innerHTML = `
        <div class="empty-icon">◇</div>
        <p>no active sessions</p>
        <p class="hint">create one below</p>`;
      grid.appendChild(emptyDiv);
    }
  }

  // Update sidebar and save order
  populateSidebar();
  saveCardOrder();
  showToast(`Closed ${visibleCards.length} session(s)`, "success");
}

// ═══ Restart Sandboxer ═══

function restartSandboxer() {
  if (!confirm("Restart sandboxer service? The UI will briefly disconnect.")) {
    return;
  }
  showToast("Restarting sandboxer...", "info");
  fetch("/restart").then(() => {
    setTimeout(() => location.reload(), 2000);
  });
}

// ═══ SSH Session Takeover ═══

async function copySSH(sessionName) {
  const host = window.location.hostname;
  const cmd = `ssh -t sandboxer@${host} "sudo tmux attach -t '${sessionName}'"`;

  try {
    await navigator.clipboard.writeText(cmd);
    showToast("Copied: " + cmd, "success");
  } catch (err) {
    fallbackCopy(cmd);
    showToast("Copied: " + cmd, "success");
  }
}

async function copyTakeover() {
  const host = window.location.hostname;
  const dir = getSelectedDir();

  // Include folder context in SSH command
  let cmd;
  if (dir && dir !== "/") {
    cmd = `ssh -t sandboxer@${host} "sandboxer-shell -f '${dir}'"`;
  } else {
    cmd = `ssh -t sandboxer@${host} sandboxer-shell`;
  }

  try {
    await navigator.clipboard.writeText(cmd);
    showToast("Copied: " + cmd, "success");
  } catch (err) {
    fallbackCopy(cmd);
    showToast("Copied: " + cmd, "success");
  }
}

function fallbackCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  document.body.removeChild(ta);
}

function showToast(message, type = "info") {
  // Remove existing toast
  const existing = document.querySelector(".paste-toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.className = "paste-toast " + type;
  toast.textContent = message;
  document.body.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.add("show");
  });

  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ═══ Resume Sessions ═══

function formatTimeAgo(mtime) {
  const now = Date.now() / 1000;
  const diff = now - mtime;
  if (diff < 60) return "just now";
  if (diff < 3600) return Math.floor(diff / 60) + " min ago";
  if (diff < 86400)
    return Math.floor(diff / 3600) + " hour" + (Math.floor(diff / 3600) > 1 ? "s" : "") + " ago";
  if (diff < 604800)
    return Math.floor(diff / 86400) + " day" + (Math.floor(diff / 86400) > 1 ? "s" : "") + " ago";
  return new Date(mtime * 1000).toLocaleDateString();
}

async function loadResumeSessions(dir) {
  const resumeSelect = document.getElementById("resumeSelect");
  const optionsCol = document.getElementById("resumeOptions");
  const summary = resumeSelect?.querySelector("summary");

  if (!optionsCol) return;

  optionsCol.innerHTML = '<span style="padding:0.5em;color:var(--overlay0)">loading...</span>';
  if (summary) summary.textContent = "...";
  if (resumeSelect) resumeSelect.setAttribute("data-value", "");

  try {
    const res = await fetch("/api/resume-sessions?dir=" + encodeURIComponent(dir));
    const sessions = await res.json();
    resumeSessionsCache[dir] = sessions;

    if (sessions.length === 0) {
      optionsCol.innerHTML = '<span style="padding:0.5em;color:var(--overlay0)">(no sessions)</span>';
    } else {
      optionsCol.innerHTML = sessions
        .map((s) => {
          const timeAgo = formatTimeAgo(s.mtime);
          const label = s.summary.length > 25 ? s.summary.slice(0, 25) + "\u2026" : s.summary;
          return `<button data-value="${s.id}" size-="small" aria-selected="false">${label} <span style="color:var(--overlay0)">${timeAgo}</span></button>`;
        })
        .join("");

      // Set up click handlers for dynamically added buttons
      optionsCol.querySelectorAll("button").forEach(btn => {
        btn.addEventListener("click", () => {
          optionsCol.querySelectorAll("button").forEach(b => b.setAttribute("aria-selected", "false"));
          btn.setAttribute("aria-selected", "true");
          const value = btn.getAttribute("data-value");
          const label = btn.childNodes[0]?.textContent?.trim() || "...";
          if (resumeSelect) {
            resumeSelect.setAttribute("data-value", value);
            if (summary) summary.textContent = label;
            resumeSelect.querySelector("details")?.removeAttribute("open");
          }
        });
      });
    }
  } catch (err) {
    optionsCol.innerHTML = '<span style="padding:0.5em;color:var(--red)">(error)</span>';
  }
}

function onTypeChange() {
  const type = getSelectedType();
  const dir = getSelectedDir();
  const resumeWrap = document.getElementById("resumeWrap");

  if (type === "resume") {
    resumeWrap.classList.add("show");
    loadResumeSessions(dir);
  } else {
    resumeWrap.classList.remove("show");
  }
}

function saveSelectedFolder(folder) {
  const folderName = folder === "/" ? "root" : folder.split("/").pop();
  const newPath = "/" + folderName;
  if (window.location.pathname !== newPath) {
    window.history.replaceState(null, "", newPath);
  }
}

function filterSessionsByFolder(selectedDir) {
  const cards = document.querySelectorAll(".card");
  const grid = document.querySelector(".grid");
  const emptyState = document.querySelector(".empty");
  let visibleCount = 0;

  cards.forEach((card) => {
    const cardWorkdir = card.dataset.workdir;

    // Show card if:
    // 1. Selected "/" (show all)
    // 2. Card has no workdir (legacy sessions before tracking)
    // 3. Card workdir matches or starts with selected folder
    const showCard =
      selectedDir === "/" ||
      !cardWorkdir ||
      cardWorkdir === selectedDir ||
      cardWorkdir.startsWith(selectedDir + "/");

    card.style.display = showCard ? "" : "none";
    if (showCard) visibleCount++;
  });

  // Note: No need to recalculate scales - hiding cards doesn't change visible card sizes

  // Handle empty state - show message if no cards match
  if (emptyState) {
    emptyState.style.display = visibleCount === 0 ? "" : "none";
  } else if (visibleCount === 0 && grid) {
    // Create temporary empty state if none exists
    const existingTemp = document.getElementById("temp-empty");
    if (!existingTemp) {
      const tempEmpty = document.createElement("div");
      tempEmpty.id = "temp-empty";
      tempEmpty.className = "empty";
      tempEmpty.innerHTML = `
        <div class="empty-icon">◇</div>
        <p>no sessions in this folder</p>
        <p class="hint">create one below or select another folder</p>
      `;
      grid.appendChild(tempEmpty);
    }
  } else {
    // Remove temp empty state if we have visible cards
    const existingTemp = document.getElementById("temp-empty");
    if (existingTemp) existingTemp.remove();
  }
}

// ═══ Drag & Drop Reordering ═══

let draggedCard = null;

function initCardDragDrop(card) {
  const grid = document.querySelector(".grid");

  card.addEventListener("dragstart", (e) => {
    draggedCard = card;
    card.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", card.dataset.session);
  });

  card.addEventListener("dragend", () => {
    draggedCard?.classList.remove("dragging");
    draggedCard = null;
    document.querySelectorAll(".card.drag-over").forEach((c) => c.classList.remove("drag-over"));
    saveCardOrder();
  });

  card.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (!draggedCard || draggedCard === card) return;
    e.dataTransfer.dropEffect = "move";
    card.classList.add("drag-over");
  });

  card.addEventListener("dragleave", () => {
    card.classList.remove("drag-over");
  });

  card.addEventListener("drop", (e) => {
    e.preventDefault();
    card.classList.remove("drag-over");
    if (!draggedCard || draggedCard === card) return;

    const allCards = [...grid.querySelectorAll(".card")];
    const draggedIndex = allCards.indexOf(draggedCard);
    const targetIndex = allCards.indexOf(card);

    if (draggedIndex < targetIndex) {
      card.after(draggedCard);
    } else {
      card.before(draggedCard);
    }
  });
}

function initDragAndDrop() {
  const grid = document.querySelector(".grid");
  grid.querySelectorAll(".card").forEach(card => {
    initCardDragDrop(card);
    observeCardResize(card);
  });
}

async function saveCardOrder() {
  const cards = document.querySelectorAll(".card");
  const order = [...cards].map((c) => c.dataset.session);

  try {
    await fetch("/api/order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order }),
    });
  } catch (err) {
    console.warn("Failed to save card order:", err);
  }
}

// ═══ Navigation Helpers ═══

function cleanupAndNavigate(url) {
  // Hide iframes instead of removing to avoid black flash
  document.querySelectorAll("iframe").forEach((f) => f.style.visibility = "hidden");
  location.href = url;
}

function cleanupAndReload() {
  // Hide iframes instead of removing to avoid black flash
  document.querySelectorAll("iframe").forEach((f) => f.style.visibility = "hidden");
  location.reload();
}

// ═══ Sidebar ═══

function toggleSidebar() {
  const isClosed = document.body.classList.contains("sidebar-closed");

  if (isClosed) {
    document.body.classList.remove("sidebar-closed");
    localStorage.setItem("sandboxer_sidebar", "open");
  } else {
    document.body.classList.add("sidebar-closed");
    localStorage.setItem("sandboxer_sidebar", "closed");
  }

  // Recalculate terminal scales after sidebar animation completes
  setTimeout(updateTerminalScales, 300);
}

function initSidebar() {
  const saved = localStorage.getItem("sandboxer_sidebar");
  const isMobile = window.innerWidth <= 600;

  // On mobile, default to closed; on desktop, default to open
  if (saved === "closed" || (isMobile && saved !== "open")) {
    document.body.classList.add("sidebar-closed");
  }
  // Load directories and crons first, then populate sidebar
  Promise.all([loadDirectories(), loadCrons()]).then(() => populateSidebar());
}

// All git directories (cached from API)
let directoriesCache = [];

async function loadDirectories() {
  try {
    const res = await fetch("/api/directories");
    if (!res.ok) {
      // Auth redirect or error - fallback to empty
      directoriesCache = [];
      return;
    }
    const data = await res.json();
    directoriesCache = data.directories || [];
  } catch (err) {
    console.warn("Failed to load directories:", err);
    directoriesCache = [];
  }
}

function populateSidebar() {
  const list = document.getElementById("sidebarList");
  const cards = document.querySelectorAll(".card");

  // Type metadata
  const typeInfo = {
    chat: { label: "chat", color: "lavender" },
    claude: { label: "claude", color: "mauve" },
    loop: { label: "loop", color: "pink" },
    lazygit: { label: "lazygit", color: "peach" },
    bash: { label: "bash", color: "green" },
    gemini: { label: "gemini", color: "blue" },
    other: { label: "other", color: "overlay1" },
    cron: { label: "cron", color: "yellow" },
  };

  // Group sessions by folder, then by type
  // Structure: { folderPath: { type: [sessions] } }
  const folders = {};
  const cronSessions = []; // Collect cron-created sessions

  // Initialize all directories from cache (so empty folders appear too)
  directoriesCache.forEach(dir => {
    if (!folders[dir]) folders[dir] = {};
  });

  cards.forEach(card => {
    const name = card.dataset.session;
    const title = card.querySelector(".card-title")?.textContent || name;
    const isChat = card.classList.contains("card-chat");
    const workdir = card.dataset.workdir || "/";
    const cardType = card.dataset.type; // Type from session metadata

    // Use card's data-type attribute if available, otherwise detect from name
    let type = "other";
    if (cardType && cardType !== "") {
      // Use the stored session type
      type = cardType;
    } else if (isChat || name.includes("-chat-") || name.startsWith("chat")) {
      type = "chat";
    } else if (name.includes("-loop-") || name.startsWith("loop")) {
      type = "loop";
    } else if (name.includes("-claude-") || name.startsWith("claude")) {
      type = "claude";
    } else if (name.includes("-gemini-") || name.startsWith("gemini")) {
      type = "gemini";
    } else if (name.includes("-bash-") || name.startsWith("bash")) {
      type = "bash";
    } else if (name.includes("-lazygit-") || name.startsWith("lazygit")) {
      type = "lazygit";
    } else if (name.includes("-resume-") || name.startsWith("resume")) {
      type = "claude";
    } else if (name.startsWith("cron-")) {
      // Only fallback to cronSessions if we have no type info
      // (legacy sessions before type tracking)
      cronSessions.push({ name, title, isChat, workdir });
      return;
    }

    // Initialize folder and type groups
    if (!folders[workdir]) folders[workdir] = {};
    if (!folders[workdir][type]) folders[workdir][type] = [];

    folders[workdir][type].push({ name, title, isChat });
  });

  // Add crons from cronsCache grouped by folder
  cronsCache.forEach(cron => {
    const workdir = cron.repo_path;
    if (!folders[workdir]) folders[workdir] = {};
    if (!folders[workdir].cron) folders[workdir].cron = [];

    // Find child sessions for this cron
    const repoName = workdir.split("/").pop();
    const prefix = `cron-${repoName}-${cron.name}-`;
    const children = cronSessions.filter(s => s.name.startsWith(prefix));

    // Build title with frequency indicator
    let cronTitle = cron.name;
    if (!cron.enabled) cronTitle += " (off)";
    const freqHtml = cron.frequency ? `<span class="cron-freq">(${cron.frequency})</span>` : "";

    folders[workdir].cron.push({
      name: cron.id,
      title: cronTitle,
      titleHtml: cronTitle + " " + freqHtml,
      isCron: true,
      cron: cron,
      children: children
    });
  });

  // Build folder path map from collected data (avoids DOM queries later)
  _folderPathMap = {};
  Object.keys(folders).forEach(path => {
    if (path && path !== "/") {
      const name = path.split("/").pop();
      _folderPathMap[name] = path;
    }
  });

  // Get currently selected folder
  const selectedDir = getSelectedDir();

  // Sort folders alphabetically, but "/" last
  const sortedFolders = Object.keys(folders).sort((a, b) => {
    if (a === "/") return 1;
    if (b === "/") return -1;
    return a.localeCompare(b);
  });

  // Use DocumentFragment for batched DOM updates
  const fragment = document.createDocumentFragment();

  // Track all folder details elements for accordion behavior
  const allFolderDetails = [];

  // Render folder tree
  sortedFolders.forEach(folderPath => {
    const folderTypes = folders[folderPath];
    const folderName = folderPath === "/" ? "/" : folderPath.split("/").pop();

    // Count AI sessions (claude, chat, loop, gemini - not lazygit/bash/cron)
    const aiTypes = ["claude", "chat", "loop", "gemini"];
    const aiCount = aiTypes.reduce((sum, type) => {
      return sum + (folderTypes[type]?.length || 0);
    }, 0);

    const folderDetails = document.createElement("details");
    folderDetails.className = "sidebar-folder";
    folderDetails.dataset.folder = folderPath;
    allFolderDetails.push(folderDetails);

    // Only expand the currently selected folder
    if (folderPath === selectedDir || (selectedDir === "/" && sortedFolders.length === 1)) {
      folderDetails.open = true;
    }

    const folderSummary = document.createElement("summary");
    const countBadge = aiCount > 0 ? ` <span class="folder-count">(${aiCount})</span>` : "";
    folderSummary.innerHTML = `<span class="folder-label">${folderName}</span>${countBadge}`;
    folderDetails.appendChild(folderSummary);

    // Accordion behavior: collapse others when one is opened, and switch view
    folderDetails.addEventListener("toggle", () => {
      if (folderDetails.open) {
        allFolderDetails.forEach(other => {
          if (other !== folderDetails) other.open = false;
        });
        // Switch the main view to this folder
        switchToFolder(folderPath);
      }
    });

    // Type order for consistent display
    const typeOrder = ["claude", "chat", "loop", "gemini", "lazygit", "bash", "cron", "other"];

    typeOrder.forEach(type => {
      const sessions = folderTypes[type];
      if (!sessions || sessions.length === 0) return;

      const info = typeInfo[type];
      const typeKey = `${folderPath}:${type}`;

      const typeDetails = document.createElement("details");
      typeDetails.className = "sidebar-type";
      typeDetails.dataset.type = type;
      typeDetails.open = type !== "cron"; // Cron collapsed by default

      const typeSummary = document.createElement("summary");
      typeSummary.innerHTML = `<span class="type-label" style="color: var(--${info.color})">${info.label}</span>`;
      typeDetails.appendChild(typeSummary);

      const ul = document.createElement("ul");
      ul.className = "type-sessions";

      sessions.forEach(({ name, title, titleHtml, isChat, isCron, cron, children }) => {
        const li = document.createElement("li");
        if (titleHtml) {
          li.innerHTML = titleHtml;
        } else {
          li.textContent = title;
        }
        li.title = name;

        const folder = folderPath === "/" ? "root" : folderPath.split("/").pop();

        if (isCron) {
          li.onclick = () => {
            openCronViewer(cron.id);
            toggleSidebar();
          };
          ul.appendChild(li);

          if (children && children.length > 0) {
            children.forEach(child => {
              const childLi = document.createElement("li");
              childLi.className = "cron-child";
              childLi.textContent = "└ " + child.name.split("-").pop();
              childLi.title = child.name;
              childLi.onclick = () => {
                window.open(`/${folder}/terminal/${encodeURIComponent(child.name)}`, "_blank");
                toggleSidebar();
              };
              ul.appendChild(childLi);
            });
          }
        } else {
          li.onclick = () => {
            const endpoint = (isChat || type === "chat") ? "chat" : "terminal";
            window.open(`/${folder}/${endpoint}/${encodeURIComponent(name)}`, "_blank");
            toggleSidebar();
          };
          ul.appendChild(li);
        }
      });

      typeDetails.appendChild(ul);
      folderDetails.appendChild(typeDetails);
    });

    fragment.appendChild(folderDetails);
  });

  if (fragment.children.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sidebar-empty";
    empty.textContent = "No sessions";
    fragment.appendChild(empty);
  }

  // Single DOM update - clear and append
  list.innerHTML = "";
  list.appendChild(fragment);
}

// ═══ Modal ═══

function showModal() {
  document.getElementById("modal").classList.add("show");
}

function hideModal() {
  document.getElementById("modal").classList.remove("show");
}

// ═══ System Stats ═══

async function updateStats() {
  try {
    const res = await fetch("/api/stats");
    const data = await res.json();

    // Parse values
    const cpuVal = parseInt(data.cpu) || 0;
    const memVal = parseInt(data.mem) || 0;

    // Update CPU progress bar
    const cpuFill = document.querySelector("#cpuStat .progress-fill");
    const cpuText = document.querySelector("#cpuStat .progress-text");
    if (cpuFill) cpuFill.style.width = cpuVal + "%";
    if (cpuText) cpuText.textContent = "cpu " + cpuVal + "%";

    // Update MEM progress bar
    const memFill = document.querySelector("#memStat .progress-fill");
    const memText = document.querySelector("#memStat .progress-text");
    if (memFill) memFill.style.width = memVal + "%";
    if (memText) memText.textContent = "mem " + memVal + "%";

    // Update version label (only once)
    const versionLabel = document.getElementById("versionLabel");
    if (versionLabel && data.version && !versionLabel.textContent) {
      versionLabel.textContent = data.version;
    }
  } catch (e) {
    // ignore
  }
}

// ═══ Terminal Preview Scaling ═══

function updateTerminalScales() {
  const zoomPercent = parseInt(localStorage.getItem("sandboxer_zoom") || "100");

  document.querySelectorAll(".terminal").forEach(terminal => {
    const terminalWidth = terminal.offsetWidth || terminal.getBoundingClientRect().width;
    if (terminalWidth === 0) return; // Not visible

    const iframe = terminal.querySelector('iframe');
    if (!iframe) return;

    // Base iframe size at 100% zoom
    const baseVisibleWidth = 830;  // Visible content width
    const baseScrollbarWidth = 20; // Extra width for scrollbar (gets clipped)
    const baseIframeHeight = 450;

    // Inverse zoom: lower zoom % = larger iframe = more content visible
    // 50% zoom -> 2x iframe size (shows 2x content, scaled down to fit)
    // 100% zoom -> 1x iframe size (normal)
    // 150% zoom -> 0.67x iframe size (shows less content, scaled up)
    const zoomFactor = zoomPercent / 100;
    const actualVisibleWidth = baseVisibleWidth / zoomFactor;
    const actualIframeWidth = (baseVisibleWidth + baseScrollbarWidth) / zoomFactor;
    const actualIframeHeight = baseIframeHeight / zoomFactor;

    // Set iframe dimensions (ttyd will reflow to fit)
    iframe.style.width = actualIframeWidth + 'px';
    iframe.style.height = actualIframeHeight + 'px';

    // Scale based on visible width so scrollbar extends beyond container
    const scale = terminalWidth / actualVisibleWidth;
    terminal.style.setProperty("--terminal-scale", scale);
  });
}

// Debounced version for resize events
let scaleTimeout;
let lastResizeTime = 0;
function debouncedUpdateScales() {
  // Throttle: ignore rapid consecutive calls
  const now = Date.now();
  if (now - lastResizeTime < 50) return;
  lastResizeTime = now;

  clearTimeout(scaleTimeout);
  scaleTimeout = setTimeout(updateTerminalScales, 150);
}

// Use ResizeObserver to detect when cards/terminals resize
// Only observe cards, not individual terminals (reduces callback frequency)
const cardResizeObserver = new ResizeObserver((entries) => {
  // Only trigger if width actually changed (not just content scroll)
  for (const entry of entries) {
    const { width } = entry.contentRect;
    const lastWidth = entry.target._lastObservedWidth || 0;
    if (Math.abs(width - lastWidth) > 5) {
      entry.target._lastObservedWidth = width;
      debouncedUpdateScales();
      break; // Only need to trigger once
    }
  }
});

function observeCardResize(card) {
  cardResizeObserver.observe(card);
}

// ═══ View & Zoom Dropdowns ═══

function setViewMode(mode) {
  const grid = document.querySelector(".grid");
  if (grid) {
    grid.dataset.view = mode;
  }
  localStorage.setItem("sandboxer_view_mode", mode);

  // Update dropdown summary text
  const viewSelect = document.getElementById("viewSelect");
  if (viewSelect) {
    const summary = viewSelect.querySelector("summary");
    const indicator = summary?.querySelector(".dropdown-indicator");
    if (summary) {
      summary.textContent = mode + " col ";
      if (indicator) summary.appendChild(indicator);
      else {
        const span = document.createElement("span");
        span.className = "dropdown-indicator";
        span.textContent = "˅";
        summary.appendChild(span);
      }
    }
  }

  // Recalculate terminal scales after layout change
  setTimeout(updateTerminalScales, 50);
}

function setZoomMode(value) {
  localStorage.setItem("sandboxer_zoom", value);

  // Update dropdown summary text
  const zoomSelect = document.getElementById("zoomSelect");
  if (zoomSelect) {
    const summary = zoomSelect.querySelector("summary");
    const indicator = summary?.querySelector(".dropdown-indicator");
    if (summary) {
      summary.textContent = value + "% ";
      if (indicator) summary.appendChild(indicator);
      else {
        const span = document.createElement("span");
        span.className = "dropdown-indicator";
        span.textContent = "˅";
        summary.appendChild(span);
      }
    }
  }

  // Recalculate scales with new zoom level
  updateTerminalScales();
}

function getDefaultViewMode() {
  // Mobile defaults to 1 column
  if (window.matchMedia("(pointer: coarse)").matches) {
    return "1";
  }
  return "2";
}

function initViewZoomDropdowns() {
  const viewSelect = document.getElementById("viewSelect");
  const zoomSelect = document.getElementById("zoomSelect");

  // Restore saved values
  const savedView = localStorage.getItem("sandboxer_view_mode") || getDefaultViewMode();
  const savedZoom = localStorage.getItem("sandboxer_zoom") || "100";

  // Set initial values
  setViewMode(savedView);
  setZoomMode(savedZoom);

  // View dropdown change handler
  if (viewSelect) {
    viewSelect.addEventListener("change", (e) => {
      setViewMode(e.detail.value);
    });
  }

  // Zoom dropdown change handler
  if (zoomSelect) {
    zoomSelect.addEventListener("change", (e) => {
      setZoomMode(e.detail.value);
    });
  }
}


// ═══ Dir Dropdown (show repo name only) ═══

function initDirDropdown() {
  const dir = document.getElementById("dir");
  if (!dir) return;

  [...dir.options].forEach(opt => {
    opt.textContent = opt.value.split("/").pop() || "/";
  });
}

// ═══ Iframe Connection Retry ═══
// Retry loading iframes that fail to connect (ttyd may not be ready yet)

function setupIframeRetry(iframe) {
  if (!iframe.src || iframe.dataset.retrySetup) return;
  iframe.dataset.retrySetup = "true";
  iframe.dataset.retryCount = "0";

  iframe.addEventListener("error", () => retryIframe(iframe));

  // Also detect blank/failed loads via load event
  iframe.addEventListener("load", () => {
    // Give ttyd a moment to render content
    setTimeout(() => {
      try {
        // Check if iframe loaded successfully by testing if we can access it
        // If ttyd isn't ready, the iframe may load but show an error page
        const doc = iframe.contentDocument || iframe.contentWindow?.document;
        if (doc && doc.body && doc.body.innerHTML.length < 100) {
          // Suspiciously small content - might be an error page
          retryIframe(iframe);
        }
      } catch (e) {
        // Cross-origin - means ttyd loaded successfully
      }
    }, 500);
  });
}

function initIframeRetry() {
  document.querySelectorAll(".terminal iframe").forEach(setupIframeRetry);
}

function retryIframe(iframe) {
  const retryCount = parseInt(iframe.dataset.retryCount || "0");
  const maxRetries = 3;
  const retryDelay = 1000; // 1 second between retries

  if (retryCount >= maxRetries) {
    console.warn("Max retries reached for iframe:", iframe.src);
    return;
  }

  iframe.dataset.retryCount = String(retryCount + 1);
  console.log(`Retrying iframe (${retryCount + 1}/${maxRetries}):`, iframe.src);

  setTimeout(() => {
    // Force reload by resetting src
    const src = iframe.src;
    iframe.src = "";
    requestAnimationFrame(() => {
      iframe.src = src;
    });
  }, retryDelay);
}

// ═══ Initialization ═══

(function init() {
  // Set up change listener for type dropdown
  const typeSelect = document.getElementById("typeSelect");

  if (typeSelect) {
    // Restore type preference
    const savedType = localStorage.getItem("sandboxer_type");
    if (savedType) {
      typeSelect.value = savedType;
    }
    typeSelect.addEventListener("change", onTypeChange);
  }

  // Apply initial folder filter
  filterSessionsByFolder(getSelectedDir());

  // Trigger change handler to show resume dropdown if needed
  if (getSelectedType() === "resume") {
    document.getElementById("resumeWrap").classList.add("show");
    loadResumeSessions(getSelectedDir());
  }

  // Initialize drag and drop
  initDragAndDrop();

  // Initialize sidebar
  initSidebar();

  // Initialize iframe retry for ttyd connection failures
  initIframeRetry();

  // Focus iframe on hover (dispatch real mouse events)
  document.querySelectorAll(".terminal").forEach((terminal) => {
    terminal.addEventListener("mouseenter", (e) => {
      const iframe = terminal.querySelector("iframe");
      if (iframe) {
        const rect = iframe.getBoundingClientRect();
        const evt = new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
          view: window
        });
        iframe.dispatchEvent(evt);
      }
    });
  });

  // Initialize view and zoom dropdowns
  initViewZoomDropdowns();

  // Initialize terminal scaling once on load
  window.addEventListener("load", updateTerminalScales);
  window.addEventListener("resize", debouncedUpdateScales);
  // Single delayed call to catch any late-rendering
  requestAnimationFrame(() => {
    updateTerminalScales();
  });

  // Start stats updates - relaxed polling for single-user system
  // Stats update every 15s (was 5s), crons every 2min (was 60s)
  updateStats();
  let statsInterval = setInterval(updateStats, 15000);

  // Refresh crons periodically (only rebuild sidebar if changed)
  let cronsInterval = setInterval(async () => {
    const changed = await loadCrons();
    if (changed) populateSidebar();
  }, 120000);

  // Pause polling completely when tab is not visible
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      clearInterval(statsInterval);
      clearInterval(cronsInterval);
    } else {
      // Resume polling and immediately update
      updateStats();
      loadCrons().then(changed => {
        if (changed) populateSidebar();
      });
      statsInterval = setInterval(updateStats, 15000);
      cronsInterval = setInterval(async () => {
        const changed = await loadCrons();
        if (changed) populateSidebar();
      }, 120000);
    }
  });

  // Prevent beforeunload dialogs
  window.onbeforeunload = null;
  window.addEventListener("beforeunload", (e) => {
    // Hide iframes instead of removing to avoid black flash
    document.querySelectorAll("iframe").forEach((f) => f.style.visibility = "hidden");
    delete e.returnValue;
    return undefined;
  });

})();

function openFullscreen(sessionName) {
  const dir = getSelectedDir();
  const folder = dir === "/" ? "root" : dir.split("/").pop();
  window.open(`/${folder}/terminal/${encodeURIComponent(sessionName)}`, "_blank");
}

// ═══ Cronjobs ═══

let cronsCache = [];
let cronsCacheHash = "";

async function loadCrons() {
  try {
    const res = await fetch("/api/crons");
    const data = await res.json();
    const newCrons = data.crons || [];
    // Only update if changed (compare by JSON hash)
    const newHash = JSON.stringify(newCrons);
    if (newHash !== cronsCacheHash) {
      cronsCache = newCrons;
      cronsCacheHash = newHash;
      return true; // Changed
    }
    return false; // No change
  } catch (err) {
    console.warn("Failed to load crons:", err);
    cronsCache = [];
    cronsCacheHash = "";
    return true; // Assume changed on error
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
}

function openCronViewer(cronId) {
  // cronId is like "repo:name"
  const folder = cronId.split(":")[0] || "root";
  window.open(`/${folder}/cron/${encodeURIComponent(cronId)}`, "_blank");
}

function openChat(sessionName) {
  const dir = getSelectedDir();
  const folder = dir === "/" ? "root" : dir.split("/").pop();
  window.open(`/${folder}/chat/${encodeURIComponent(sessionName)}`, "_blank");
}

// ═══ Image Upload from Mini Views ═══

// Hidden paste target for clipboard images
let cardPasteTarget = null;
let cardPasteSession = null;
let cardPasteTimeout = null;

function setupCardPasteTarget() {
  if (cardPasteTarget) return;

  cardPasteTarget = document.createElement("textarea");
  cardPasteTarget.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0;";
  cardPasteTarget.setAttribute("aria-hidden", "true");
  document.body.appendChild(cardPasteTarget);

  cardPasteTarget.addEventListener("paste", (e) => {
    const items = e.clipboardData?.items;
    if (!items || !cardPasteSession) return;

    for (const item of items) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          uploadImageToSession(cardPasteSession, file);
          cardPasteSession = null;
          clearTimeout(cardPasteTimeout);
          return;
        }
      }
    }

    showToast("No image in clipboard - double-click to browse", "info");
    cardPasteSession = null;
    clearTimeout(cardPasteTimeout);
  });

  cardPasteTarget.addEventListener("blur", () => {
    cardPasteSession = null;
  });
}

function triggerImageUpload(sessionName) {
  setupCardPasteTarget();

  // Check if mobile
  const isMobile = window.matchMedia("(pointer: coarse)").matches;

  if (isMobile) {
    // Mobile: directly open file picker
    const card = document.querySelector(`[data-session="${sessionName}"]`);
    const input = card?.querySelector('.card-image-input');
    if (input) input.click();
  } else {
    // Desktop: enable paste mode
    cardPasteSession = sessionName;
    cardPasteTarget.focus();
    showToast("Ctrl+V to paste, or double-click to browse", "info");

    clearTimeout(cardPasteTimeout);
    cardPasteTimeout = setTimeout(() => {
      if (cardPasteSession === sessionName) {
        cardPasteSession = null;
        showToast("Paste timed out", "info");
      }
    }, 10000);
  }
}

function triggerImageBrowse(sessionName) {
  const card = document.querySelector(`[data-session="${sessionName}"]`);
  const input = card?.querySelector('.card-image-input');
  if (input) input.click();
}

async function uploadFileToSession(sessionName, file) {
  if (!file) return null;

  try {
    // Convert to base64
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        const base64Data = result.split(",")[1];
        resolve(base64Data);
      };
      reader.onerror = () => reject(new Error("Failed to read file"));
      reader.readAsDataURL(file);
    });

    // Upload
    const filename = file.name || `upload_${Date.now()}`;
    const uploadRes = await fetch("/api/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: base64, filename })
    });
    const uploadData = await uploadRes.json();
    if (!uploadData.ok) {
      throw new Error(uploadData.error || "Upload failed");
    }

    return uploadData.path;
  } catch (err) {
    throw err;
  }
}

async function uploadFilesToSession(sessionName, files) {
  if (!files || files.length === 0) return;

  // Convert FileList to array immediately to prevent it being cleared during async ops
  const fileArray = Array.from(files);

  console.log('[upload] uploadFilesToSession called with', fileArray.length, 'files');
  showToast(`Uploading ${fileArray.length} file(s)...`, "info");

  const paths = [];
  for (let i = 0; i < fileArray.length; i++) {
    const file = fileArray[i];
    console.log('[upload] uploading file', i + 1, 'of', fileArray.length, ':', file.name);
    try {
      const path = await uploadFileToSession(sessionName, file);
      console.log('[upload] got path:', path);
      if (path) paths.push(path);
    } catch (err) {
      console.error('[upload] failed:', err);
      showToast("Upload failed: " + err.message, "error");
    }
  }

  console.log('[upload] all paths:', paths);
  if (paths.length > 0) {
    const text = paths.join(" ") + " ";
    console.log('[upload] injecting text:', text);
    // Inject all paths into session
    await fetch("/api/inject", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: sessionName, text })
    });

    showToast(`Uploaded ${paths.length} file(s)`, "success");
  }
}

// Backwards compatibility alias
async function uploadImageToSession(sessionName, file) {
  showToast("Uploading...", "info");
  try {
    const path = await uploadFileToSession(sessionName, file);
    if (path) {
      await fetch("/api/inject", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: sessionName, text: path + " " })
      });
      showToast(path, "success");
    }
  } catch (err) {
    showToast("Upload failed: " + err.message, "error");
  }
}

// Set up file input listener using event delegation (handles dynamically created cards too)
document.addEventListener('change', (e) => {
  if (!e.target.classList.contains('card-image-input')) return;

  const input = e.target;
  const files = input.files;
  const sessionName = input.dataset.session;

  console.log('[upload] files selected:', files?.length, 'session:', sessionName);

  if (files && files.length > 0 && sessionName) {
    if (files.length === 1) {
      uploadImageToSession(sessionName, files[0]);
    } else {
      uploadFilesToSession(sessionName, files);
    }
  }
  input.value = ''; // Reset for next upload
});

// ═══ Keyboard Navigation ═══

let focusedCardIndex = -1;
let focusedSidebarItem = null;
let keyboardHelpVisible = false;

function getVisibleCards() {
  return [...document.querySelectorAll(".card")].filter(c => c.style.display !== "none");
}

function focusCard(index) {
  const cards = getVisibleCards();
  if (cards.length === 0) return;

  // Remove previous focus
  document.querySelectorAll(".card.keyboard-focus").forEach(c => c.classList.remove("keyboard-focus"));

  // Clamp index
  focusedCardIndex = Math.max(0, Math.min(index, cards.length - 1));
  const card = cards[focusedCardIndex];
  card.classList.add("keyboard-focus");
  card.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function moveFocusInGrid(direction) {
  const cards = getVisibleCards();
  if (cards.length === 0) return;

  // Get current grid columns from CSS
  const grid = document.querySelector(".grid");
  const gridStyle = getComputedStyle(grid);
  const cols = gridStyle.gridTemplateColumns.split(" ").length || 2;

  if (focusedCardIndex < 0) {
    focusCard(0);
    return;
  }

  let newIndex = focusedCardIndex;
  switch (direction) {
    case "up": newIndex = Math.max(0, focusedCardIndex - cols); break;
    case "down": newIndex = Math.min(cards.length - 1, focusedCardIndex + cols); break;
    case "left": newIndex = Math.max(0, focusedCardIndex - 1); break;
    case "right": newIndex = Math.min(cards.length - 1, focusedCardIndex + 1); break;
  }
  focusCard(newIndex);
}

function getFocusedCard() {
  const cards = getVisibleCards();
  if (focusedCardIndex >= 0 && focusedCardIndex < cards.length) {
    return cards[focusedCardIndex];
  }
  return null;
}

function getSidebarItems() {
  // Get all focusable sidebar items: folder summaries and session list items
  const items = [];
  document.querySelectorAll("#sidebarList .sidebar-folder").forEach(folder => {
    items.push({ type: "folder", element: folder.querySelector("summary"), folder });
    if (folder.open) {
      folder.querySelectorAll(".sidebar-type").forEach(typeGroup => {
        items.push({ type: "type", element: typeGroup.querySelector("summary"), typeGroup });
        if (typeGroup.open) {
          typeGroup.querySelectorAll(".type-sessions li").forEach(li => {
            items.push({ type: "session", element: li });
          });
        }
      });
    }
  });
  return items;
}

function focusSidebarItem(index) {
  const items = getSidebarItems();
  if (items.length === 0) return;

  // Remove previous focus
  document.querySelectorAll("#sidebarList .keyboard-focus").forEach(el => el.classList.remove("keyboard-focus"));

  // Clamp index
  const newIndex = Math.max(0, Math.min(index, items.length - 1));
  focusedSidebarItem = newIndex;

  const item = items[newIndex];
  item.element.classList.add("keyboard-focus");
  item.element.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function moveSidebarFocus(direction) {
  const items = getSidebarItems();
  if (items.length === 0) return;

  if (focusedSidebarItem === null) {
    focusSidebarItem(0);
    return;
  }

  let newIndex = focusedSidebarItem;
  if (direction === "up") newIndex = Math.max(0, focusedSidebarItem - 1);
  else if (direction === "down") newIndex = Math.min(items.length - 1, focusedSidebarItem + 1);

  focusSidebarItem(newIndex);
}

function activateSidebarItem() {
  const items = getSidebarItems();
  if (focusedSidebarItem === null || focusedSidebarItem >= items.length) return;

  const item = items[focusedSidebarItem];
  if (item.type === "folder") {
    item.folder.open = !item.folder.open;
    // Re-focus after toggle (item list changed)
    setTimeout(() => focusSidebarItem(focusedSidebarItem), 10);
  } else if (item.type === "type") {
    item.typeGroup.open = !item.typeGroup.open;
    setTimeout(() => focusSidebarItem(focusedSidebarItem), 10);
  } else if (item.type === "session") {
    item.element.click();
  }
}

function collapseSidebarItem() {
  const items = getSidebarItems();
  if (focusedSidebarItem === null || focusedSidebarItem >= items.length) return;

  const item = items[focusedSidebarItem];
  if (item.type === "folder" && item.folder.open) {
    item.folder.open = false;
  } else if (item.type === "type" && item.typeGroup.open) {
    item.typeGroup.open = false;
  }
  setTimeout(() => focusSidebarItem(focusedSidebarItem), 10);
}

function expandSidebarItem() {
  const items = getSidebarItems();
  if (focusedSidebarItem === null || focusedSidebarItem >= items.length) return;

  const item = items[focusedSidebarItem];
  if (item.type === "folder" && !item.folder.open) {
    item.folder.open = true;
  } else if (item.type === "type" && !item.typeGroup.open) {
    item.typeGroup.open = true;
  }
  setTimeout(() => focusSidebarItem(focusedSidebarItem), 10);
}

function showKeyboardHelp() {
  // Remove existing help
  const existing = document.getElementById("keyboard-help");
  if (existing) {
    existing.remove();
    keyboardHelpVisible = false;
    return;
  }

  keyboardHelpVisible = true;
  const help = document.createElement("div");
  help.id = "keyboard-help";
  help.className = "keyboard-help";
  help.innerHTML = `
    <div class="keyboard-help-content" box-="round">
      <div class="keyboard-help-header">
        <h3>Keyboard Shortcuts</h3>
        <button onclick="document.getElementById('keyboard-help').remove()" size-="small">×</button>
      </div>
      <div class="keyboard-help-sections">
        <div class="keyboard-help-section">
          <h4>Global</h4>
          <dl>
            <dt>?</dt><dd>Toggle this help</dd>
            <dt>Tab</dt><dd>Cycle focus areas</dd>
            <dt>n</dt><dd>New session</dd>
            <dt>s</dt><dd>Focus sidebar</dd>
            <dt>g</dt><dd>Focus grid</dd>
            <dt>Esc</dt><dd>Clear focus / close</dd>
            <dt>1-9</dt><dd>Open card by number</dd>
          </dl>
        </div>
        <div class="keyboard-help-section">
          <h4>Grid Navigation</h4>
          <dl>
            <dt>↑/k</dt><dd>Move up</dd>
            <dt>↓/j</dt><dd>Move down</dd>
            <dt>←/h</dt><dd>Move left</dd>
            <dt>→/l</dt><dd>Move right</dd>
            <dt>Enter/o</dt><dd>Open session</dd>
            <dt>x</dt><dd>Kill session</dd>
            <dt>c</dt><dd>Copy SSH command</dd>
          </dl>
        </div>
        <div class="keyboard-help-section">
          <h4>Sidebar Navigation</h4>
          <dl>
            <dt>↑/k</dt><dd>Move up</dd>
            <dt>↓/j</dt><dd>Move down</dd>
            <dt>←/h</dt><dd>Collapse</dd>
            <dt>→/l</dt><dd>Expand</dd>
            <dt>Enter</dt><dd>Toggle/Open</dd>
          </dl>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(help);
}

// Track which area has focus
let focusArea = null; // "grid" | "sidebar" | null

function setFocusArea(area) {
  focusArea = area;
  document.body.dataset.focusArea = area || "";

  // Visual feedback
  document.getElementById("sidebar")?.classList.toggle("has-keyboard-focus", area === "sidebar");
  document.querySelector(".grid")?.classList.toggle("has-keyboard-focus", area === "grid");

  // Initialize focus if needed
  if (area === "grid" && focusedCardIndex < 0) {
    focusCard(0);
  } else if (area === "sidebar" && focusedSidebarItem === null) {
    focusSidebarItem(0);
  }
}

function clearFocus() {
  focusArea = null;
  focusedCardIndex = -1;
  focusedSidebarItem = null;
  document.body.dataset.focusArea = "";
  document.querySelectorAll(".keyboard-focus").forEach(el => el.classList.remove("keyboard-focus"));
  document.getElementById("sidebar")?.classList.remove("has-keyboard-focus");
  document.querySelector(".grid")?.classList.remove("has-keyboard-focus");
}

// Main keyboard handler
document.addEventListener("keydown", (e) => {
  // Ignore if typing in input/textarea or iframe has focus
  if (e.target.matches("input, textarea, [contenteditable], iframe")) return;
  // Also ignore if active element is inside the grid cards (clicking on terminal preview)
  if (document.activeElement?.closest(".card .terminal")) return;

  // Ignore if modal is open (except Escape)
  const modal = document.getElementById("modal");
  if (modal?.classList.contains("show") && e.key !== "Escape") return;

  const key = e.key.toLowerCase();

  // Tab key: cycle between sidebar and grid
  if (key === "tab") {
    e.preventDefault();
    if (e.shiftKey) {
      // Shift+Tab: reverse cycle
      if (focusArea === "grid") {
        setFocusArea("sidebar");
        if (document.body.classList.contains("sidebar-closed")) toggleSidebar();
      } else {
        setFocusArea("grid");
      }
    } else {
      // Tab: forward cycle
      if (focusArea === "sidebar") {
        setFocusArea("grid");
      } else {
        setFocusArea("sidebar");
        if (document.body.classList.contains("sidebar-closed")) toggleSidebar();
      }
    }
    return;
  }

  // Global shortcuts
  switch (key) {
    case "?":
      e.preventDefault();
      showKeyboardHelp();
      return;

    case "escape":
      e.preventDefault();
      if (keyboardHelpVisible) {
        document.getElementById("keyboard-help")?.remove();
        keyboardHelpVisible = false;
      } else if (modal?.classList.contains("show")) {
        hideModal();
      } else {
        clearFocus();
      }
      return;

    case "n":
      if (!e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        createSession();
      }
      return;

    case "s":
      if (!e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setFocusArea("sidebar");
        // Open sidebar if closed
        if (document.body.classList.contains("sidebar-closed")) {
          toggleSidebar();
        }
      }
      return;

    case "g":
      if (!e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setFocusArea("grid");
      }
      return;
  }

  // Number keys 1-9: open card by position
  if (/^[1-9]$/.test(key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    const cards = getVisibleCards();
    const index = parseInt(key) - 1;
    if (index < cards.length) {
      const sessionName = cards[index].dataset.session;
      if (sessionName) {
        openFullscreen(sessionName);
      }
    }
    return;
  }

  // Area-specific navigation
  if (focusArea === "grid") {
    handleGridKeyboard(e, key);
  } else if (focusArea === "sidebar") {
    handleSidebarKeyboard(e, key);
  }
});

function handleGridKeyboard(e, key) {
  switch (key) {
    case "arrowup":
    case "k":
      e.preventDefault();
      moveFocusInGrid("up");
      break;

    case "arrowdown":
    case "j":
      e.preventDefault();
      moveFocusInGrid("down");
      break;

    case "arrowleft":
    case "h":
      e.preventDefault();
      moveFocusInGrid("left");
      break;

    case "arrowright":
    case "l":
      e.preventDefault();
      moveFocusInGrid("right");
      break;

    case "enter":
    case "o":
      e.preventDefault();
      const card = getFocusedCard();
      if (card) {
        const sessionName = card.dataset.session;
        if (card.classList.contains("card-chat")) {
          openChat(sessionName);
        } else {
          openFullscreen(sessionName);
        }
      }
      break;

    case "x":
      e.preventDefault();
      const cardToKill = getFocusedCard();
      if (cardToKill) {
        const killBtn = cardToKill.querySelector(".kill-btn");
        if (killBtn) killBtn.click();
      }
      break;

    case "c":
      e.preventDefault();
      const cardToCopy = getFocusedCard();
      if (cardToCopy) {
        const sessionName = cardToCopy.dataset.session;
        if (sessionName) copySSH(sessionName);
      }
      break;
  }
}

function handleSidebarKeyboard(e, key) {
  switch (key) {
    case "arrowup":
    case "k":
      e.preventDefault();
      moveSidebarFocus("up");
      break;

    case "arrowdown":
    case "j":
      e.preventDefault();
      moveSidebarFocus("down");
      break;

    case "arrowleft":
    case "h":
      e.preventDefault();
      collapseSidebarItem();
      break;

    case "arrowright":
    case "l":
      e.preventDefault();
      expandSidebarItem();
      break;

    case "enter":
    case " ":
      e.preventDefault();
      activateSidebarItem();
      break;
  }
}

