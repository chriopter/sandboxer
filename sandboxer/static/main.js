/* Sandboxer - Dashboard JavaScript */

let resumeSessionsCache = {};

// ═══ Session Management ═══

async function createSession(forceType) {
  const type = forceType || document.getElementById("type").value;
  const dir = document.getElementById("dir").value;
  const resumeId = document.getElementById("resumeSession").value;

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

      // Initialize drag & drop for new card
      initCardDragDrop(newCard);

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

  const dir = document.getElementById("dir").value;
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
  const dir = document.getElementById("dir").value;

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
  const select = document.getElementById("resumeSession");
  select.innerHTML = '<option value="">loading...</option>';

  try {
    const res = await fetch("/api/resume-sessions?dir=" + encodeURIComponent(dir));
    const sessions = await res.json();
    resumeSessionsCache[dir] = sessions;

    if (sessions.length === 0) {
      select.innerHTML = '<option value="">(no sessions to resume)</option>';
    } else {
      select.innerHTML = sessions
        .map((s) => {
          const timeAgo = formatTimeAgo(s.mtime);
          const msgs = s.message_count || 0;
          const branch = s.branch || "-";
          const label = s.summary.length > 40 ? s.summary.slice(0, 40) + "\u2026" : s.summary;
          return `<option value="${s.id}">${label} \u00B7 ${timeAgo} \u00B7 ${msgs} msgs \u00B7 ${branch}</option>`;
        })
        .join("");
    }
  } catch (err) {
    select.innerHTML = '<option value="">(error loading sessions)</option>';
  }
}

function onDirOrTypeChange() {
  const type = document.getElementById("type").value;
  const dir = document.getElementById("dir").value;
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
  grid.querySelectorAll(".card").forEach(initCardDragDrop);
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

  list.innerHTML = "";

  cards.forEach(card => {
    if (card.style.display === "none") return;

    const name = card.dataset.session;
    const title = card.querySelector(".card-title")?.textContent || name;

    const li = document.createElement("li");

    // Detect session type for icon styling
    let type = "other";
    if (name.startsWith("claude")) type = "claude";
    else if (name.startsWith("gemini")) type = "gemini";
    else if (name.startsWith("bash")) type = "bash";
    else if (name.startsWith("lazygit")) type = "lazygit";
    else if (name.startsWith("resume")) type = "resume";

    li.classList.add("type-" + type);
    li.textContent = title;
    li.title = name;
    li.onclick = () => {
      window.open("/terminal?session=" + encodeURIComponent(name), "_blank");
      toggleSidebar();
    };
    list.appendChild(li);
  });

  if (list.children.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No sessions";
    li.style.color = "var(--overlay0)";
    li.style.cursor = "default";
    list.appendChild(li);
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
    document.querySelector("#cpuStat span").textContent = data.cpu + "%";
    document.querySelector("#memStat span").textContent = data.mem + "%";
    document.querySelector("#diskStat span").textContent = data.disk + "%";
  } catch (e) {
    // ignore
  }
}

// ═══ Terminal Preview Scaling ═══

function updateTerminalScales() {
  document.querySelectorAll(".terminal").forEach(terminal => {
    const card = terminal.closest(".card");
    if (!card) return;

    // Get card width (accounting for padding)
    const cardWidth = card.offsetWidth;
    if (cardWidth === 0) return; // Not visible

    // Iframe is 800px wide, scale to fit card width
    const scale = Math.min(1, cardWidth / 800);
    terminal.style.setProperty("--terminal-scale", scale);
  });
}

// Debounced version for resize events
let scaleTimeout;
function debouncedUpdateScales() {
  clearTimeout(scaleTimeout);
  scaleTimeout = setTimeout(updateTerminalScales, 100);
}

// ═══ Preview Zoom ═══

function setZoomMode(value) {
  localStorage.setItem("sandboxer_zoom", value);

  // Update button active state
  document.querySelectorAll(".zoom-modes button").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.zoom === String(value));
  });

  // Recalculate scales (zoom affects base scale preference)
  updateTerminalScales();
}

function initZoomModes() {
  const saved = localStorage.getItem("sandboxer_zoom") || "75";
  setZoomMode(saved);

  // Button click handlers
  document.querySelectorAll(".zoom-modes button").forEach(btn => {
    btn.addEventListener("click", () => {
      setZoomMode(btn.dataset.zoom);
    });
  });
}

// ═══ View Modes ═══

function setViewMode(mode) {
  const grid = document.querySelector(".grid");
  const buttons = document.querySelectorAll(".view-modes button");

  if (grid) {
    grid.dataset.view = mode;
  }

  buttons.forEach(btn => {
    btn.classList.toggle("active", btn.dataset.view === mode);
  });

  localStorage.setItem("sandboxer_view_mode", mode);

  // Recalculate terminal scales after layout change
  setTimeout(updateTerminalScales, 50);
}

function getDefaultViewMode() {
  // Mobile defaults to 1 column
  if (window.matchMedia("(pointer: coarse)").matches) {
    return "1";
  }
  return "2";
}

function initViewModes() {
  const saved = localStorage.getItem("sandboxer_view_mode");
  const mode = saved || getDefaultViewMode();

  setViewMode(mode);

  // Button click handlers
  document.querySelectorAll(".view-modes button").forEach(btn => {
    btn.addEventListener("click", () => {
      setViewMode(btn.dataset.view);
    });
  });
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

let lastReconnect = 0;
const RECONNECT_COOLDOWN = 5000; // Don't reconnect more than once per 5 seconds

function reconnectIframes() {
  const now = Date.now();
  if (now - lastReconnect < RECONNECT_COOLDOWN) return;
  lastReconnect = now;

  document.querySelectorAll(".terminal iframe").forEach((iframe) => {
    if (iframe.src) {
      // Reload iframe to reconnect
      const src = iframe.src;
      iframe.src = "";
      iframe.src = src;
    }
  });
}

// Reconnect iframes when page becomes visible after being hidden (tab switch, screen wake)
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    reconnectIframes();
  }
});

// ═══ Initialization ═══

(function init() {
  // Restore type preference (folder is server-side via selected attribute)
  const savedType = localStorage.getItem("sandboxer_type");
  if (savedType) document.getElementById("type").value = savedType;

  // Apply initial folder filter (folder already selected by server)
  const currentDir = document.getElementById("dir").value;
  filterSessionsByFolder(currentDir);

  // Trigger change handler to show resume dropdown if needed
  const type = document.getElementById("type").value;
  if (type === "resume") {
    document.getElementById("resumeWrap").classList.add("show");
    loadResumeSessions(currentDir);
  }

  // Initialize dir dropdown (short/full path toggle)
  initDirDropdown();

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

  // Initialize view modes and zoom
  initViewModes();
  initZoomModes();

  // Initialize terminal scaling
  updateTerminalScales();
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
