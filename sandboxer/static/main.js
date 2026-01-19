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
    claude: { label: "claude", color: "mauve", sessions: [] },
    loop: { label: "loop", color: "pink", sessions: [] },
    lazygit: { label: "lazygit", color: "peach", sessions: [] },
    bash: { label: "bash", color: "green", sessions: [] },
    gemini: { label: "gemini", color: "blue", sessions: [] },
    other: { label: "other", color: "overlay1", sessions: [] },
  };

  cards.forEach(card => {
    if (card.style.display === "none") return;

    const name = card.dataset.session;
    const title = card.querySelector(".card-title")?.textContent || name;

    // Detect session type from name patterns
    let type = "other";
    if (name.includes("-loop-") || name.startsWith("loop")) type = "loop";
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
        window.open("/terminal?session=" + encodeURIComponent(name), "_blank");
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

})();

function openFullscreen(sessionName) {
  window.open("/terminal?session=" + encodeURIComponent(sessionName), "_blank");
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

