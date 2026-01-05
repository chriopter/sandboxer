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

function getSelectedDir() {
  const el = document.getElementById("dirSelect");
  return el?.value || "/";
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

      // Update terminal scales for new card
      setTimeout(updateTerminalScales, 50);

      // Connect sync for new chat sessions
      if (data.mode === "chat") {
        connectChatSync(data.name);
      }

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

let killTimeout = null;
async function killSession(btn, name) {
  if (btn.classList.contains("confirm")) {
    await fetch("/kill?session=" + encodeURIComponent(name));
    cleanupAndReload();
  } else {
    btn.classList.add("confirm");
    btn.textContent = "?";
    clearTimeout(killTimeout);
    killTimeout = setTimeout(() => {
      btn.classList.remove("confirm");
      btn.textContent = "×";
    }, 2000);
  }
}

// ═══ Close All Sessions ═══

async function closeAllSessions() {
  const cards = document.querySelectorAll(".card");
  const visibleSessions = [...cards]
    .filter(card => card.style.display !== "none")
    .map(card => card.dataset.session);

  if (visibleSessions.length === 0) {
    showToast("No sessions to close", "info");
    return;
  }

  const dir = getSelectedDir();
  const folderName = dir === "/" ? "all folders" : dir.split("/").pop() || dir;

  if (!confirm(`Close ${visibleSessions.length} session(s) in "${folderName}"?`)) {
    return;
  }

  for (const name of visibleSessions) {
    await fetch("/kill?session=" + encodeURIComponent(name));
  }

  cleanupAndReload();
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

function onDirOrTypeChange() {
  const type = getSelectedType();
  const dir = getSelectedDir();
  const resumeWrap = document.getElementById("resumeWrap");

  if (type === "resume") {
    resumeWrap.classList.add("show");
    loadResumeSessions(dir);
  } else {
    resumeWrap.classList.remove("show");
  }

  // Filter visible sessions by selected folder
  filterSessionsByFolder(dir);

  // Update sidebar list immediately
  populateSidebar();

  // Save selected folder to server
  saveSelectedFolder(dir);
}

async function saveSelectedFolder(folder) {
  try {
    await fetch("/api/selected-folder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder }),
    });
  } catch (err) {
    console.warn("Failed to save selected folder:", err);
  }

  // Update URL to reflect folder (allows different tabs for different folders)
  const folderName = folder === "/" ? "" : folder.split("/").pop();
  const newPath = folderName ? "/" + folderName : "/";
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

  // Recalculate terminal scales after filtering (cards may have resized)
  setTimeout(updateTerminalScales, 50);

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

  // Recalculate terminal scales after sidebar animation
  setTimeout(updateTerminalScales, 250);
}

function initSidebar() {
  const saved = localStorage.getItem("sandboxer_sidebar");
  const isMobile = window.innerWidth <= 600;

  // On mobile, default to closed; on desktop, default to open
  if (saved === "closed" || (isMobile && saved !== "open")) {
    document.body.classList.add("sidebar-closed");
  }
  populateSidebar();
}

function populateSidebar() {
  const list = document.getElementById("sidebarList");
  const cards = document.querySelectorAll(".card");

  // Group sessions by type
  const groups = {
    chat: { label: "claude chat", color: "lavender", sessions: [] },
    claude: { label: "claude", color: "mauve", sessions: [] },
    lazygit: { label: "lazygit", color: "peach", sessions: [] },
    bash: { label: "bash", color: "green", sessions: [] },
    gemini: { label: "gemini", color: "blue", sessions: [] },
    other: { label: "other", color: "overlay1", sessions: [] },
  };

  cards.forEach(card => {
    if (card.style.display === "none") return;

    const name = card.dataset.session;
    const title = card.querySelector(".card-title")?.textContent || name;
    const mode = card.dataset.mode;

    // Detect session type from name patterns
    let type = "other";
    if (name.includes("-chat-") || name.startsWith("chat")) type = "chat";
    else if (name.includes("-claude-") || name.startsWith("claude")) type = "claude";
    else if (name.includes("-gemini-") || name.startsWith("gemini")) type = "gemini";
    else if (name.includes("-bash-") || name.startsWith("bash")) type = "bash";
    else if (name.includes("-lazygit-") || name.startsWith("lazygit")) type = "lazygit";
    else if (name.includes("-resume-") || name.startsWith("resume")) type = "claude"; // resume is claude

    groups[type].sessions.push({ name, title });
  });

  list.innerHTML = "";

  // Load expanded state from localStorage
  const expandedGroups = JSON.parse(localStorage.getItem("sandboxer_expanded_groups") || '["claude","lazygit","bash","gemini","other"]');

  // Render each group with sessions
  Object.entries(groups).forEach(([type, group]) => {
    if (group.sessions.length === 0) return;

    const details = document.createElement("details");
    details.className = "sidebar-group";
    details.dataset.type = type;
    if (expandedGroups.includes(type)) {
      details.open = true;
    }

    const summary = document.createElement("summary");
    summary.innerHTML = `<span class="group-label" style="color: var(--${group.color})">${group.label}</span>`;
    details.appendChild(summary);

    // Save expanded state on toggle
    details.addEventListener("toggle", () => {
      const expanded = JSON.parse(localStorage.getItem("sandboxer_expanded_groups") || "[]");
      if (details.open && !expanded.includes(type)) {
        expanded.push(type);
      } else if (!details.open && expanded.includes(type)) {
        expanded.splice(expanded.indexOf(type), 1);
      }
      localStorage.setItem("sandboxer_expanded_groups", JSON.stringify(expanded));
    });

    const ul = document.createElement("ul");
    ul.className = "group-sessions";

    group.sessions.forEach(({ name, title }) => {
      const li = document.createElement("li");
      li.textContent = title;
      li.title = name;
      li.onclick = () => {
        const card = document.querySelector('[data-session="' + name + '"]');
        const mode = card?.dataset.mode;
        if (mode === "chat" || type === "chat") {
          window.open("/chat?session=" + encodeURIComponent(name), "_blank");
        } else {
          window.open("/terminal?session=" + encodeURIComponent(name), "_blank");
        }
        toggleSidebar();
      };
      ul.appendChild(li);
    });

    details.appendChild(ul);
    list.appendChild(details);
  });

  if (list.children.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sidebar-empty";
    empty.textContent = "No sessions";
    list.appendChild(empty);
  }
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
    const baseIframeWidth = 830;
    const baseIframeHeight = 450;

    // Inverse zoom: lower zoom % = larger iframe = more content visible
    // 50% zoom -> 2x iframe size (shows 2x content, scaled down to fit)
    // 100% zoom -> 1x iframe size (normal)
    // 150% zoom -> 0.67x iframe size (shows less content, scaled up)
    const zoomFactor = zoomPercent / 100;
    const actualIframeWidth = baseIframeWidth / zoomFactor;
    const actualIframeHeight = baseIframeHeight / zoomFactor;

    // Set iframe dimensions (ttyd will reflow to fit)
    iframe.style.width = actualIframeWidth + 'px';
    iframe.style.height = actualIframeHeight + 'px';

    // Scale to fit container width
    const scale = terminalWidth / actualIframeWidth;
    terminal.style.setProperty("--terminal-scale", scale);
  });
}

// Debounced version for resize events
let scaleTimeout;
function debouncedUpdateScales() {
  clearTimeout(scaleTimeout);
  scaleTimeout = setTimeout(updateTerminalScales, 100);
}

// Use ResizeObserver to detect when cards/terminals resize
const cardResizeObserver = new ResizeObserver(debouncedUpdateScales);
function observeCardResize(card) {
  cardResizeObserver.observe(card);
  // Also observe the terminal container directly
  const terminal = card.querySelector('.terminal');
  if (terminal) {
    cardResizeObserver.observe(terminal);
  }
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

// ═══ Auto-Reconnect Iframes ═══
// Note: Removed auto-reconnect on tab change as it was annoying.
// Iframes maintain their connection state on their own.

// ═══ Initialization ═══

(function init() {
  // Set up change listeners for custom dropdowns
  const dirSelect = document.getElementById("dirSelect");
  const typeSelect = document.getElementById("typeSelect");

  if (dirSelect) {
    dirSelect.addEventListener("change", onDirOrTypeChange);
  }

  if (typeSelect) {
    // Restore type preference
    const savedType = localStorage.getItem("sandboxer_type");
    if (savedType) {
      typeSelect.value = savedType;
    }
    typeSelect.addEventListener("change", onDirOrTypeChange);
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

  // Initialize terminal scaling - call multiple times to catch late-rendering cards
  updateTerminalScales();
  setTimeout(updateTerminalScales, 100);
  setTimeout(updateTerminalScales, 500);
  setTimeout(updateTerminalScales, 1000);
  window.addEventListener("load", () => {
    updateTerminalScales();
    setTimeout(updateTerminalScales, 100);
  });
  window.addEventListener("resize", debouncedUpdateScales);

  // Start stats updates
  updateStats();
  setInterval(updateStats, 5000);

  // Prevent beforeunload dialogs
  window.onbeforeunload = null;
  window.addEventListener("beforeunload", (e) => {
    // Hide iframes instead of removing to avoid black flash
    document.querySelectorAll("iframe").forEach((f) => f.style.visibility = "hidden");
    delete e.returnValue;
    return undefined;
  });

  // Chat sessions no longer need persistent SSE connections
  // Each message POST returns its own SSE stream
})();

// ═══ Chat Mode ═══
// Web chat interface with SSE streaming from Claude JSON output

const chatConnections = {};  // session -> EventSource

function openFullscreen(sessionName) {
  const card = document.querySelector('[data-session="' + sessionName + '"]');
  const mode = card?.dataset.mode || "cli";
  if (mode === "chat") {
    window.open("/chat?session=" + encodeURIComponent(sessionName), "_blank");
  } else {
    window.open("/terminal?session=" + encodeURIComponent(sessionName), "_blank");
  }
}

function connectChat(sessionName) {
  if (chatConnections[sessionName]) {
    return;  // Already connected
  }

  const card = document.querySelector('[data-session="' + sessionName + '"]');
  if (!card) return;

  const messagesContainer = card.querySelector(".chat-messages");
  if (!messagesContainer) return;

  const es = new EventSource("/api/chat-stream?session=" + encodeURIComponent(sessionName));
  chatConnections[sessionName] = es;

  let currentAssistantBubble = null;
  let currentAssistantText = "";

  es.onmessage = function(e) {
    try {
      const event = JSON.parse(e.data);
      handleChatEvent(sessionName, event, messagesContainer, {
        getCurrentBubble: function() { return currentAssistantBubble; },
        setCurrentBubble: function(b) { currentAssistantBubble = b; },
        getCurrentText: function() { return currentAssistantText; },
        setCurrentText: function(t) { currentAssistantText = t; },
      });
    } catch (err) {
      console.error("Failed to parse chat event:", err);
    }
  };

  es.addEventListener("end", function() {
    disconnectChat(sessionName);
  });

  es.onerror = function() {
    disconnectChat(sessionName);
  };
}

function disconnectChat(sessionName) {
  if (chatConnections[sessionName]) {
    chatConnections[sessionName].close();
    delete chatConnections[sessionName];
  }
}

function handleChatEvent(session, event, container, state) {
  // Handle different event types from Claude JSON stream
  if (event.type === "assistant") {
    // Full assistant message
    const content = event.message && event.message.content;
    if (content && Array.isArray(content)) {
      for (let i = 0; i < content.length; i++) {
        const block = content[i];
        if (block.type === "text") {
          renderChatMessage(container, "assistant", block.text);
        }
      }
    }
    state.setCurrentBubble(null);
    state.setCurrentText("");
  } else if (event.type === "content_block_start") {
    // Start of a new content block
    if (event.content_block && event.content_block.type === "text") {
      const bubble = document.createElement("div");
      bubble.className = "chat-message assistant streaming";
      container.appendChild(bubble);
      state.setCurrentBubble(bubble);
      state.setCurrentText("");
      container.scrollTop = container.scrollHeight;
    }
  } else if (event.type === "content_block_delta") {
    // Streaming text delta
    const delta = event.delta && event.delta.text;
    if (delta && state.getCurrentBubble()) {
      state.setCurrentText(state.getCurrentText() + delta);
      state.getCurrentBubble().textContent = state.getCurrentText();
      container.scrollTop = container.scrollHeight;
    }
  } else if (event.type === "content_block_stop") {
    // End of content block - remove streaming class
    if (state.getCurrentBubble()) {
      state.getCurrentBubble().classList.remove("streaming");
    }
    state.setCurrentBubble(null);
  } else if (event.type === "result") {
    // Completion result
    state.setCurrentBubble(null);
    state.setCurrentText("");
  }
}

function renderChatMessage(container, role, content, extra = {}) {
  const bubble = document.createElement("div");
  bubble.className = "chat-message " + role;

  if (extra.collapsible) {
    // Collapsible message (tool use, tool result, system)
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.innerHTML = extra.summary || role;
    details.appendChild(summary);
    const contentDiv = document.createElement("div");
    contentDiv.className = "collapsible-content";
    contentDiv.textContent = content;
    details.appendChild(contentDiv);
    bubble.appendChild(details);
  } else {
    bubble.textContent = content;
  }

  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;
  return bubble;
}

function renderToolUse(container, toolName, toolInput) {
  const bubble = document.createElement("div");
  bubble.className = "chat-message tool-use";
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.innerHTML = '<span is-="spinner" variant-="dots"></span> ' + toolName;
  details.appendChild(summary);
  if (toolInput) {
    const pre = document.createElement("pre");
    pre.textContent = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput, null, 2);
    details.appendChild(pre);
  }
  bubble.appendChild(details);
  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;
  return bubble;
}

function renderToolResult(container, toolName, result, isError) {
  const bubble = document.createElement("div");
  bubble.className = "chat-message tool-result" + (isError ? " error" : "");
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = (isError ? "✗ " : "✓ ") + toolName;
  details.appendChild(summary);
  const pre = document.createElement("pre");
  // Truncate long results
  const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  pre.textContent = text.length > 500 ? text.slice(0, 500) + "\n..." : text;
  details.appendChild(pre);
  bubble.appendChild(details);
  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;
  return bubble;
}

function renderSystemMessage(container, subtype, data) {
  const bubble = document.createElement("div");
  bubble.className = "chat-message system " + subtype;

  if (subtype === "init") {
    bubble.innerHTML = '<span class="system-label">model:</span> ' + (data.model || "unknown");
  } else if (subtype === "result" || subtype === "success") {
    const cost = data.total_cost_usd ? "$" + data.total_cost_usd.toFixed(4) : "";
    const duration = data.duration_ms ? (data.duration_ms / 1000).toFixed(1) + "s" : "";
    bubble.innerHTML = '<span class="system-label">done</span> ' + [duration, cost].filter(Boolean).join(" · ");
  } else {
    bubble.textContent = subtype;
  }

  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;
  return bubble;
}

function renderThinkingBlock(container, thinkingText) {
  const bubble = document.createElement("div");
  bubble.className = "chat-message thinking-block";
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.innerHTML = '<span is-="spinner" variant-="dots"></span> extended thinking';
  details.appendChild(summary);
  const pre = document.createElement("pre");
  const truncated = thinkingText.length > 500 ? thinkingText.slice(0, 500) + "\n..." : thinkingText;
  pre.textContent = truncated;
  details.appendChild(pre);
  bubble.appendChild(details);
  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;
  return bubble;
}

function setChatStatus(card, status, text) {
  const statusEl = card.querySelector(".chat-status");
  if (!statusEl) return;
  statusEl.className = "chat-status " + status;
  const textEl = statusEl.querySelector(".status-text");
  if (textEl) textEl.textContent = text || status;
}

async function sendChat(sessionName) {
  const card = document.querySelector('[data-session="' + sessionName + '"]');
  if (!card) return;

  const input = card.querySelector(".chat-input input");
  const messagesContainer = card.querySelector(".chat-messages");
  if (!input || !messagesContainer) return;

  const message = input.value.trim();
  if (!message) return;

  // Mark this session as actively sending (skip sync messages)
  activeSendingSessions.add(sessionName);

  // Render user message
  renderChatMessage(messagesContainer, "user", message);
  input.value = "";

  // Disable send button while processing
  const sendBtn = card.querySelector(".chat-input button");
  if (sendBtn) sendBtn.disabled = true;

  // Update status to working (status line shows thinking, no bubble needed)
  setChatStatus(card, "working", "thinking...");
  messagesContainer.scrollTop = messagesContainer.scrollHeight;

  // State for streaming response
  let currentBubble = null;
  let currentText = "";
  let currentToolBubble = null;
  let currentToolId = null;
  let renderedInit = false;  // Track if we already rendered init message
  let streamedResponse = false;  // Track if we got streaming response (skip final assistant msg)

  try {
    const res = await fetch("/api/chat-send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: sessionName, message: message }),
    });

    if (!res.ok) {
      showToast("Failed to send message", "error");
      return;
    }

    // Read SSE stream from POST response
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";  // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (!data || data === "{}") continue;

          try {
            const event = JSON.parse(data);

            // Handle title update
            if (event.type === "title_update" && event.title) {
              const titleEl = card.querySelector(".card-title");
              if (titleEl) {
                titleEl.textContent = event.title;
                populateSidebar();  // Update sidebar
              }
              continue;
            }


            // Handle different event types
            if (event.type === "system") {
              if (event.subtype === "init" && !renderedInit) {
                renderedInit = true;
                renderSystemMessage(messagesContainer, "init", event);
                setChatStatus(card, "working", "started");
              }
            } else if (event.type === "assistant") {
              // Skip if we already rendered via streaming
              if (streamedResponse) continue;

              const content = event.message && event.message.content;
              if (content && Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === "text" && block.text) {
                    setChatStatus(card, "working", "writing...");
                    if (!currentBubble) {
                      currentBubble = document.createElement("div");
                      currentBubble.className = "chat-message assistant";
                      messagesContainer.appendChild(currentBubble);
                    }
                    currentBubble.textContent = block.text;
                    messagesContainer.scrollTop = messagesContainer.scrollHeight;
                  } else if (block.type === "tool_use") {
                    // Hide assistant text bubble when tools start (avoid ghost text)
                    if (currentBubble) {
                      currentBubble.remove();
                    }
                    // Show tool being used with spinner
                    setChatStatus(card, "working", block.name + "...");
                    currentToolBubble = renderToolUse(messagesContainer, block.name, block.input?.command || block.input?.description || "");
                    currentToolId = block.id;
                    currentBubble = null;
                  } else if (block.type === "thinking" && block.thinking) {
                    // Extended thinking block
                    setChatStatus(card, "working", "thinking deeply...");
                    renderThinkingBlock(messagesContainer, block.thinking);
                  }
                }
              }
            } else if (event.type === "user") {
              // Tool result
              const content = event.message && event.message.content;
              if (content && Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === "tool_result") {
                    // Remove spinner from tool use bubble
                    if (currentToolBubble) {
                      const spinner = currentToolBubble.querySelector('[is-="spinner"]');
                      if (spinner) spinner.remove();
                    }
                    // Show tool result
                    const toolName = event.tool_use_result ? "result" : "tool";
                    const result = event.tool_use_result?.stdout || block.content || "";
                    renderToolResult(messagesContainer, toolName, result, block.is_error);
                    currentToolBubble = null;
                    currentToolId = null;
                  }
                }
              }
            } else if (event.type === "content_block_start") {
              if (event.content_block && event.content_block.type === "text") {
                streamedResponse = true;  // Mark that we got streaming, skip final assistant msg
                currentBubble = document.createElement("div");
                currentBubble.className = "chat-message assistant streaming";
                messagesContainer.appendChild(currentBubble);
                currentText = "";
                messagesContainer.scrollTop = messagesContainer.scrollHeight;
              } else if (event.content_block && event.content_block.type === "tool_use") {
                // Tool use from streaming - remove text bubble, show tool
                if (currentBubble) {
                  currentBubble.remove();
                  currentBubble = null;
                }
                setChatStatus(card, "working", (event.content_block.name || "tool") + "...");
                currentToolBubble = renderToolUse(messagesContainer, event.content_block.name || "tool", "");
              }
            } else if (event.type === "content_block_delta") {
              const delta = event.delta && event.delta.text;
              if (delta && currentBubble) {
                currentText += delta;
                currentBubble.textContent = currentText;
                messagesContainer.scrollTop = messagesContainer.scrollHeight;
              }
            } else if (event.type === "content_block_stop") {
              if (currentBubble) {
                currentBubble.classList.remove("streaming");
              }
            } else if (event.type === "result") {
              // Response complete - show summary
              if (currentBubble) {
                currentBubble.classList.remove("streaming");
              }
              renderSystemMessage(messagesContainer, event.subtype || "success", event);
              setChatStatus(card, "paused", "idle");
              // Remove spinners from any thinking blocks
              messagesContainer.querySelectorAll(".thinking-block [is-=\"spinner\"]").forEach(s => s.remove());
            }
          } catch (e) {
            console.error("Failed to parse SSE data:", e);
          }
        }
      }
    }
  } catch (err) {
    console.error("Chat error:", err);
    showToast("Failed to send message", "error");
    setChatStatus(card, "paused", "error");
  } finally {
    if (sendBtn) sendBtn.disabled = false;
    // Ensure status is set to idle if not already
    const statusEl = card.querySelector(".chat-status");
    if (statusEl && statusEl.classList.contains("working")) {
      setChatStatus(card, "paused", "idle");
    }
    // Allow sync messages again
    activeSendingSessions.delete(sessionName);
  }
}

async function toggleMode(sessionName) {
  const card = document.querySelector('[data-session="' + sessionName + '"]');
  if (!card) return;

  const currentMode = card.dataset.mode || "cli";
  const targetMode = currentMode === "chat" ? "cli" : "chat";

  // Show loading state
  const toggleBtn = card.querySelector(".toggle-mode-btn");
  if (toggleBtn) {
    toggleBtn.textContent = "...";
    toggleBtn.disabled = true;
  }

  try {
    const res = await fetch("/api/chat-toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: sessionName, target_mode: targetMode }),
    });

    const data = await res.json();
    if (!data.ok) {
      throw new Error(data.error || "Toggle failed");
    }

    // Update card UI
    card.dataset.mode = targetMode;
    const terminalDiv = card.querySelector(".terminal");
    const chatDiv = card.querySelector(".chat");

    const sshBtn = card.querySelector(".ssh-btn");

    if (targetMode === "chat") {
      if (terminalDiv) terminalDiv.style.display = "none";
      if (chatDiv) chatDiv.style.display = "flex";
      if (toggleBtn) toggleBtn.textContent = "cli";
      if (sshBtn) sshBtn.style.display = "none";
    } else {
      if (terminalDiv) {
        terminalDiv.style.display = "block";
        // Update iframe src if we got a new terminal URL
        if (data.terminal_url) {
          const iframe = terminalDiv.querySelector("iframe");
          if (iframe) iframe.src = data.terminal_url;
        }
      }
      if (chatDiv) chatDiv.style.display = "none";
      if (toggleBtn) toggleBtn.textContent = "chat";
      if (sshBtn) sshBtn.style.display = "inline-block";
    }

    // Recalculate terminal scales
    setTimeout(updateTerminalScales, 100);

    // Update sidebar to reflect new mode
    populateSidebar();

  } catch (err) {
    showToast("Failed to toggle mode: " + err.message, "error");
    // Restore button state
    if (toggleBtn) {
      toggleBtn.textContent = currentMode === "chat" ? "cli" : "chat";
    }
  } finally {
    if (toggleBtn) toggleBtn.disabled = false;
  }
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

async function uploadImageToSession(sessionName, file) {
  if (!file || !file.type.startsWith("image/")) {
    showToast("Not an image", "error");
    return;
  }

  showToast("Uploading...", "info");

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
    const filename = file.name || `upload_${Date.now()}.png`;
    const uploadRes = await fetch("/api/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: base64, filename })
    });
    const uploadData = await uploadRes.json();
    if (!uploadData.ok) {
      throw new Error(uploadData.error || "Upload failed");
    }

    // Inject path into session
    await fetch("/api/inject", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: sessionName, text: uploadData.path + " " })
    });

    showToast(uploadData.path, "success");
  } catch (err) {
    showToast("Upload failed: " + err.message, "error");
  }
}

// Set up file input listeners for all cards
document.querySelectorAll('.card-image-input').forEach(input => {
  input.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    const sessionName = input.dataset.session;
    if (file && sessionName) {
      uploadImageToSession(sessionName, file);
    }
    e.target.value = ''; // Reset for next upload
  });
});

// ═══ Chat Image Upload ═══

function triggerChatImageUpload(sessionName) {
  const card = document.querySelector(`[data-session="${sessionName}"]`);
  const input = card?.querySelector('.chat-image-input');
  if (input) input.click();
}

async function uploadImageToChat(sessionName, file) {
  if (!file || !file.type.startsWith("image/")) {
    showToast("Not an image", "error");
    return;
  }

  const card = document.querySelector(`[data-session="${sessionName}"]`);
  const textInput = card?.querySelector(".chat-input input[type='text']");

  showToast("Uploading...", "info");

  try {
    // Convert to base64
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(",")[1]);
      reader.onerror = () => reject(new Error("Failed to read file"));
      reader.readAsDataURL(file);
    });

    // Upload to /tmp
    const filename = file.name || `upload_${Date.now()}.png`;
    const uploadRes = await fetch("/api/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: base64, filename })
    });
    const uploadData = await uploadRes.json();
    if (!uploadData.ok) {
      throw new Error(uploadData.error || "Upload failed");
    }

    // Insert path into chat input
    if (textInput) {
      const currentVal = textInput.value;
      textInput.value = uploadData.path + " " + currentVal;
      textInput.focus();
    }

    showToast("Image ready: " + uploadData.path, "success");
  } catch (err) {
    showToast("Upload failed: " + err.message, "error");
  }
}

// Set up chat image input listeners
document.querySelectorAll('.chat-image-input').forEach(input => {
  input.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    const sessionName = input.dataset.session;
    if (file && sessionName) {
      uploadImageToChat(sessionName, file);
    }
    e.target.value = '';
  });
});


// ═══ Chat Sync Across Tabs ═══

const chatSyncConnections = {};  // session -> EventSource
const activeSendingSessions = new Set();  // Sessions we're currently sending to (skip sync for these)

function connectChatSync(sessionName) {
  if (chatSyncConnections[sessionName]) {
    return;  // Already connected
  }

  const es = new EventSource("/api/chat-sync?session=" + encodeURIComponent(sessionName));
  chatSyncConnections[sessionName] = es;

  es.onmessage = (e) => {
    if (!e.data || e.data === "{}") return;

    // Skip sync messages for sessions we're actively sending to (we render directly from POST)
    if (activeSendingSessions.has(sessionName)) {
      return;
    }

    try {
      const event = JSON.parse(e.data);
      const card = document.querySelector('[data-session="' + sessionName + '"]');
      if (!card) return;

      // Handle title update
      if (event.type === "title_update" && event.title) {
        const titleEl = card.querySelector(".card-title");
        if (titleEl) {
          titleEl.textContent = event.title;
          populateSidebar();  // Update sidebar to reflect new title
        }
        return;
      }

      const messagesContainer = card.querySelector(".chat-messages");
      if (!messagesContainer) return;

      // Handle synced messages and history
      if (event.type === "user_message") {
        // User message from another tab or history
        renderChatMessage(messagesContainer, "user", event.content);
      } else if (event.type === "assistant_message") {
        // Clean format from history
        renderChatMessage(messagesContainer, "assistant", event.content);
      } else if (event.type === "system_message") {
        // System message (CLI context, mode switch, etc.)
        renderChatMessage(messagesContainer, "system", event.content);
      } else if (event.type === "assistant") {
        const content = event.message?.content;
        if (content && Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && block.text) {
              renderChatMessage(messagesContainer, "assistant", block.text);
            } else if (block.type === "tool_use") {
              renderToolUse(messagesContainer, block.name, block.input?.command || block.input?.description || "");
            }
          }
        }
      } else if (event.type === "user") {
        // Tool result
        const content = event.message?.content;
        if (content && Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "tool_result") {
              const result = event.tool_use_result?.stdout || block.content || "";
              renderToolResult(messagesContainer, "result", result, block.is_error);
            }
          }
        }
      } else if (event.type === "system") {
        if (event.subtype === "init") {
          renderSystemMessage(messagesContainer, "init", event);
        }
      } else if (event.type === "result") {
        renderSystemMessage(messagesContainer, event.subtype || "success", event);
      }
    } catch (err) {
      console.error("Chat sync error:", err);
    }
  };

  es.onerror = () => {
    // Reconnect after 2 seconds
    delete chatSyncConnections[sessionName];
    setTimeout(() => connectChatSync(sessionName), 2000);
  };
}

function disconnectChatSync(sessionName) {
  if (chatSyncConnections[sessionName]) {
    chatSyncConnections[sessionName].close();
    delete chatSyncConnections[sessionName];
  }
}

// Connect sync for all chat sessions on page load
document.querySelectorAll('.card[data-mode="chat"]').forEach(function(card) {
  const sessionName = card.dataset.session;
  if (sessionName) {
    connectChatSync(sessionName);
  }
});
