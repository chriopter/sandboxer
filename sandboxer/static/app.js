/* Sandboxer - Minimal Dashboard */

// ═══ WebSocket Terminal ═══
let ws = null;
let currentSession = null;
const terminals = new Map();
const attachedOnce = new Set(); // Track terminals that have been attached (resized)

function initWS() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws/terminal`);
  ws.binaryType = "arraybuffer";

  ws.onmessage = (e) => {
    if (!currentSession) return;
    const t = terminals.get(currentSession);
    if (!t) return;
    if (typeof e.data === "string") {
      try {
        const parsed = JSON.parse(e.data);
        // Only treat as control message if it's an object (not number/string/etc)
        if (typeof parsed !== "object" || parsed === null) t.term.write(e.data);
      } catch { t.term.write(e.data); }
    } else {
      t.term.write(new Uint8Array(e.data));
    }
  };

  ws.onclose = () => setTimeout(initWS, 1000);
  ws.onopen = () => {
    // Check server state for session to restore, otherwise attach first visible
    const state = window.SANDBOXER_STATE || {};
    if (state.activeSession && terminals.has(state.activeSession)) {
      attachSession(state.activeSession);
      return;
    }

    const firstVisible = document.querySelector(".card:not([style*='display: none'])");
    if (firstVisible) {
      const name = firstVisible.dataset.session;
      if (name && terminals.has(name)) {
        attachSession(name);
      }
    }
  };
}

function wsSend(data) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(data);
}

// ═══ xterm.js ═══
const THEME = {
  background: "#1e1e2e", foreground: "#cdd6f4", cursor: "#f5e0dc",
  black: "#45475a", red: "#f38ba8", green: "#a6e3a1", yellow: "#f9e2af",
  blue: "#89b4fa", magenta: "#f5c2e7", cyan: "#94e2d5", white: "#bac2de",
};

function createTerminal(name, container) {
  if (terminals.has(name)) return terminals.get(name);

  const term = new Terminal({ cursorBlink: true, fontSize: 9, theme: THEME });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);

  try { term.loadAddon(new WebglAddon.WebglAddon()); } catch {}

  term.open(container);

  const doFit = () => { try { fit.fit(); } catch {} };

  term.onData((d) => currentSession === name && wsSend(d));
  term.onResize(({ rows, cols }) => currentSession === name && wsSend(JSON.stringify({ action: "resize", rows, cols })));

  // Intercept Ctrl+V to allow browser paste event to fire instead of xterm handling it
  term.attachCustomKeyEventHandler((e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "v") {
      // Return false to let browser handle it (triggers paste event)
      return false;
    }
    return true;
  });

  new ResizeObserver(() => doFit()).observe(container);

  // Use IntersectionObserver to fit when terminal becomes visible
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        doFit();
        // Also schedule fits after content might have loaded
        setTimeout(doFit, 100);
        setTimeout(doFit, 300);
      }
    });
  }, { threshold: 0.1 });
  observer.observe(container);

  terminals.set(name, { term, fit });

  // Force a layout reflow to ensure container has dimensions
  void container.offsetHeight;

  // Initial fit calls to handle layout settling
  doFit();
  requestAnimationFrame(() => {
    doFit();
    requestAnimationFrame(doFit);
  });
  setTimeout(doFit, 100);
  setTimeout(doFit, 300);
  setTimeout(doFit, 500);
  setTimeout(doFit, 1000);

  // Don't load content on creation - wait for hover/attach
  // This ensures tmux pane is resized to correct dimensions first

  return terminals.get(name);
}

async function loadTerminalContent(name, clear = false) {
  try {
    const t = terminals.get(name);
    if (!t) return;

    // Fit first to get correct dimensions
    const doFit = () => { try { t.fit.fit(); } catch {} };
    doFit();

    // Get current terminal dimensions - skip if not properly sized yet
    const cols = t.term.cols;
    const rows = t.term.rows;
    if (cols < 10 || rows < 5) return; // Not properly sized yet

    // Fetch content, resizing tmux pane to match terminal dimensions
    const res = await fetch(`/api/capture?session=${encodeURIComponent(name)}&cols=${cols}&rows=${rows}`);
    const data = await res.json();
    if (data.content) {
      if (clear) t.term.reset();
      t.term.write(data.content);
      // Refit after content to adjust scrollback
      requestAnimationFrame(doFit);
      setTimeout(doFit, 50);
    }
  } catch {}
}

function attachSession(name, skipUrlUpdate = false) {
  if (currentSession === name) return;
  if (currentSession) wsSend(JSON.stringify({ action: "detach" }));
  currentSession = name;
  attachedOnce.add(name); // Mark as attached (tmux pane will be resized)

  const t = terminals.get(name);
  if (!t) return;
  wsSend(JSON.stringify({ action: "attach", session: name, rows: t.term.rows, cols: t.term.cols }));

  // Update URL with current session
  if (!skipUrlUpdate) {
    updateUrl(getSelectedFolder(), name);
  }
}

// ═══ UI Actions ═══

function getSelectedFolder() {
  return document.getElementById("folder-select")?.value || "/";
}

function getSelectedType() {
  return document.getElementById("type-select")?.value || "claude";
}

async function createSession(type) {
  type = type || getSelectedType();
  const dir = getSelectedFolder();
  const res = await fetch(`/api/create?type=${type}&dir=${encodeURIComponent(dir)}`);
  const data = await res.json();
  if (data.ok) {
    const grid = document.querySelector(".grid");
    grid.querySelector(".empty")?.remove();
    grid.insertAdjacentHTML("afterbegin", data.html);
    initCard(grid.firstElementChild, true);
  }
}

async function killSession(name) {
  terminals.get(name)?.term.dispose();
  terminals.delete(name);
  await fetch(`/kill?session=${encodeURIComponent(name)}`);
  location.reload();
}

async function killAllSessions() {
  const visible = [...document.querySelectorAll(".card:not([style*='display: none'])")];
  if (!visible.length || !confirm(`Kill ${visible.length} sessions?`)) return;
  for (const card of visible) {
    const name = card.dataset.session;
    terminals.get(name)?.term.dispose();
    terminals.delete(name);
    await fetch(`/kill?session=${encodeURIComponent(name)}`);
    card.remove();
  }
}

function openFullscreen(name) {
  const slug = getFolderSlug(getSelectedFolder()) || "root";
  window.open(`/${slug}/terminal/${encodeURIComponent(name)}`, "_blank");
}

function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      showToast("Copied: " + text.substring(0, 60));
    }).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
    showToast("Copied: " + text.substring(0, 60));
  } catch (e) {
    showToast("Copy failed");
  }
  document.body.removeChild(ta);
}

function copySessionSSH(name) {
  const cmd = `ssh -t sandboxer@${location.hostname} sudo tmux attach -t '${name}'`;
  copyToClipboard(cmd);
}

async function doUpload(file, session) {
  showToast("Uploading...");

  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = reader.result.split(",")[1];
      try {
        const res = await fetch("/api/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: file.name, content: base64 })
        });
        const data = await res.json();
        if (data.ok && data.path) {
          // Attach to session and paste path
          if (session) attachSession(session);
          setTimeout(() => {
            wsSend(data.path + " ");
            showToast("Uploaded: " + data.path);
          }, 100);
          resolve(data.path);
        } else {
          showToast("Upload failed");
          resolve(null);
        }
      } catch (e) {
        showToast("Upload error");
        resolve(null);
      }
    };
    reader.readAsDataURL(file);
  });
}

function uploadFile(session) {
  const input = document.createElement("input");
  input.type = "file";
  input.onchange = () => {
    const file = input.files[0];
    if (file) doUpload(file, session);
  };
  input.click();
}

// Single click: attach session and show paste hint
function uploadClick(session) {
  attachSession(session);
  showToast("Ctrl+V to paste image");
}

// Double click: open file dialog
function uploadDblClick(session) {
  uploadFile(session);
}

function handlePaste(e) {
  const clipboard = e.clipboardData;
  if (!clipboard) return;

  const items = clipboard.items;
  const files = clipboard.files;

  // Try clipboard.files first (some browsers)
  if (files && files.length > 0) {
    const file = files[0];
    e.preventDefault();
    e.stopPropagation();
    const filename = file.name || `paste-${Date.now()}.${file.type.split("/")[1] || "png"}`;
    doUpload(new File([file], filename, { type: file.type }), currentSession);
    return;
  }

  // Try clipboard.items
  if (items) {
    for (const item of items) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          e.stopPropagation();
          let filename = file.name;
          if (!filename || filename === "image.png" || filename === "blob") {
            filename = `paste-${Date.now()}.${file.type.split("/")[1] || "png"}`;
          }
          doUpload(new File([file], filename, { type: file.type }), currentSession);
          return;
        }
      }
    }
  }
}

function focusSession(name) {
  // Scroll card into view and attach
  const card = document.querySelector(`[data-session="${name}"]`);
  if (card) {
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    attachSession(name); // This will also update the URL
    // Update sidebar active state
    document.querySelectorAll(".sidebar-session").forEach(el => {
      el.classList.toggle("active", el.dataset.session === name);
    });
  }
}

async function openCron(path) {
  // Create split tmux: left=cat cron, right=tail log
  const dir = getSelectedFolder();
  const name = path.split("/").pop().replace("cron-", "").replace(".yaml", "");
  const logPath = `/var/log/sandboxer/cron-${name}.log`;

  const res = await fetch(`/api/create-cron-view?path=${encodeURIComponent(path)}&log=${encodeURIComponent(logPath)}&dir=${encodeURIComponent(dir)}`);
  const data = await res.json();
  if (data.ok) {
    const grid = document.querySelector(".grid");
    grid.querySelector(".empty")?.remove();
    grid.insertAdjacentHTML("afterbegin", data.html);
    initCard(grid.firstElementChild, true);
  }
}

function copySSH() {
  const folder = getSelectedFolder();
  const cmd = folder === "/"
    ? `ssh -t sandboxer@${location.hostname} sandboxer-shell --all`
    : `ssh -t sandboxer@${location.hostname} sandboxer-shell -f '${folder}'`;
  copyToClipboard(cmd);
}

function showToast(msg) {
  const t = document.getElementById("toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2000);
}

// ═══ Card Init ═══

function initCard(card, autoAttach = false) {
  const name = card.dataset.session;
  if (!name) return;

  const container = card.querySelector(".xterm-container");
  if (!container || container.dataset.init) return;
  container.dataset.init = "1";

  createTerminal(name, container);

  card.addEventListener("mouseenter", () => attachSession(name));
  card.addEventListener("click", () => { attachSession(name); terminals.get(name)?.term.focus(); });

  if (autoAttach) {
    attachSession(name);
  }
}

// ═══ Stats ═══

async function loadStats() {
  try {
    const res = await fetch("/api/stats");
    const data = await res.json();

    const cpu = document.querySelector("#cpuStat .progress-fill");
    const cpuText = document.querySelector("#cpuStat .progress-text");
    if (cpu && cpuText) {
      cpu.style.width = data.cpu + "%";
      cpuText.textContent = `cpu ${data.cpu}%`;
    }

    const mem = document.querySelector("#memStat .progress-fill");
    const memText = document.querySelector("#memStat .progress-text");
    if (mem && memText) {
      mem.style.width = data.mem + "%";
      memText.textContent = `mem ${data.mem}%`;
    }
  } catch {}
}

// ═══ URL State ═══

function getFolderSlug(folderPath) {
  // Convert /home/sandboxer/git/sandboxer -> sandboxer
  if (!folderPath || folderPath === "/") return "";
  return folderPath.split("/").pop();
}

function updateUrl(folder, session) {
  const slug = getFolderSlug(folder);
  let path = "/";
  if (slug) {
    path = `/${encodeURIComponent(slug)}`;
    if (session) {
      path += `/${encodeURIComponent(session)}`;
    }
  }
  history.replaceState(null, "", path);
}

// ═══ Filter ═══

function filterCards(folder, skipUrlUpdate = false) {
  let firstVisible = null;

  // Filter cards - show only matching folder (or all if "/")
  document.querySelectorAll(".card").forEach(card => {
    const workdir = card.dataset.workdir || "";
    const show = folder === "/" || workdir === folder || workdir.startsWith(folder + "/");
    card.style.display = show ? "" : "none";
    if (show && !firstVisible) firstVisible = card;
  });

  // Filter sidebar sessions and crons
  document.querySelectorAll(".sidebar-session, .sidebar-cron").forEach(el => {
    const workdir = el.dataset.workdir || "";
    const show = folder === "/" || workdir === folder || workdir.startsWith(folder + "/");
    el.style.display = show ? "" : "none";
  });

  // Show/hide type headers based on visible children
  document.querySelectorAll(".sidebar-type-header").forEach(header => {
    let hasVisible = false;
    let next = header.nextElementSibling;
    while (next && !next.classList.contains("sidebar-type-header")) {
      if (next.style.display !== "none") hasVisible = true;
      next = next.nextElementSibling;
    }
    header.style.display = hasVisible ? "" : "none";
  });

  fetch("/api/selected-folder", { method: "POST", body: folder });

  // Update URL
  if (!skipUrlUpdate) {
    updateUrl(folder, currentSession);
  }

  // Attach first visible session
  if (firstVisible && ws?.readyState === WebSocket.OPEN) {
    const name = firstVisible.dataset.session;
    if (name) attachSession(name);
  }
}

// ═══ Sidebar ═══

function toggleSidebar() {
  document.body.classList.toggle("sidebar-collapsed");
  localStorage.setItem("sidebar-collapsed", document.body.classList.contains("sidebar-collapsed"));
}

function toggleCrons() {
  const toggle = document.querySelector(".cron-toggle");
  const crons = document.querySelectorAll(".sidebar-cron");
  const collapsed = toggle?.classList.toggle("collapsed");
  crons.forEach(c => c.classList.toggle("cron-hidden", collapsed));
  localStorage.setItem("crons-collapsed", collapsed);
}

function setColumns(n) {
  document.querySelector(".grid")?.setAttribute("data-cols", n);
  localStorage.setItem("grid-cols", n);
  // Update column selector
  const sel = document.getElementById("col-select");
  if (sel) sel.value = n;
  // Refit all terminals after layout settles
  setTimeout(() => {
    terminals.forEach(t => {
      t.fit.fit();
    });
  }, 100);
}

// ═══ Init ═══

document.addEventListener("DOMContentLoaded", () => {
  // Restore sidebar state
  if (localStorage.getItem("sidebar-collapsed") === "true") {
    document.body.classList.add("sidebar-collapsed");
  }

  // Restore cron collapsed state
  if (localStorage.getItem("crons-collapsed") === "true") {
    const toggle = document.querySelector(".cron-toggle");
    const crons = document.querySelectorAll(".sidebar-cron");
    if (toggle) toggle.classList.add("collapsed");
    crons.forEach(c => c.classList.add("cron-hidden"));
  }

  // Restore grid columns
  const cols = localStorage.getItem("grid-cols") || "2";
  setColumns(cols);

  // Init all cards and create terminals
  document.querySelectorAll(".card").forEach(card => initCard(card));

  // Init WebSocket (will auto-attach first visible on connect)
  initWS();

  // Folder filter - use server-rendered state from URL
  const select = document.getElementById("folder-select");
  const state = window.SANDBOXER_STATE || {};

  if (select) {
    // Server already set the correct selected option based on URL
    select.onchange = () => filterCards(select.value);
    filterCards(select.value, true); // Skip URL update on init

    // If URL had a session, attach it after cards are filtered
    if (state.activeSession && terminals.has(state.activeSession)) {
      attachSession(state.activeSession, true);
      // Scroll to and highlight the session
      const card = document.querySelector(`[data-session="${state.activeSession}"]`);
      if (card) {
        setTimeout(() => card.scrollIntoView({ behavior: "smooth", block: "center" }), 100);
      }
    }

    // Ensure URL is correct (in case accessed via /)
    updateUrl(select.value, currentSession);
  }

  // Stats
  loadStats();
  setInterval(loadStats, 5000);

  // Periodically refresh terminals that have been attached before (for multi-browser sync)
  // Only refresh terminals we've attached to, so tmux pane is at correct size
  setInterval(() => {
    terminals.forEach((t, name) => {
      if (name !== currentSession && attachedOnce.has(name)) {
        loadTerminalContent(name, true);
      }
    });
  }, 3000);

  // Handle Ctrl+V file paste (capture phase to intercept before xterm)
  document.addEventListener("paste", handlePaste, true);

  // Refit all terminals multiple times during page load to ensure proper sizing
  const refitAll = () => terminals.forEach(t => { try { t.fit.fit(); } catch {} });
  setTimeout(refitAll, 300);
  setTimeout(refitAll, 600);
  setTimeout(refitAll, 1000);
  setTimeout(refitAll, 2000);

  // Also refit when window gains focus (user switches back to tab)
  window.addEventListener("focus", () => {
    setTimeout(refitAll, 50);
  });
});
