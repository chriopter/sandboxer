/* Sandboxer - Minimal Dashboard */

// ═══ WebSocket Terminal ═══
let ws = null;
let currentSession = null;
const terminals = new Map();

function initWS() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws/terminal`);
  ws.binaryType = "arraybuffer";

  ws.onmessage = (e) => {
    if (!currentSession) return;
    const t = terminals.get(currentSession);
    if (!t) return;
    if (typeof e.data === "string") {
      try { JSON.parse(e.data); } catch { t.term.write(e.data); }
    } else {
      t.term.write(new Uint8Array(e.data));
    }
  };

  ws.onclose = () => setTimeout(initWS, 1000);
  ws.onopen = () => {
    // Auto-attach first visible session
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
  setTimeout(() => fit.fit(), 50);

  term.onData((d) => currentSession === name && wsSend(d));
  term.onResize(({ rows, cols }) => currentSession === name && wsSend(JSON.stringify({ action: "resize", rows, cols })));

  new ResizeObserver(() => fit.fit()).observe(container);

  terminals.set(name, { term, fit });

  // Load initial content (so terminals render without hover)
  loadTerminalContent(name);

  return terminals.get(name);
}

async function loadTerminalContent(name, clear = false) {
  try {
    const res = await fetch(`/api/capture?session=${encodeURIComponent(name)}`);
    const data = await res.json();
    if (data.content) {
      const t = terminals.get(name);
      if (t) {
        if (clear) t.term.reset();
        t.term.write(data.content);
      }
    }
  } catch {}
}

function attachSession(name) {
  if (currentSession === name) return;
  if (currentSession) wsSend(JSON.stringify({ action: "detach" }));
  currentSession = name;

  const t = terminals.get(name);
  if (!t) return;
  wsSend(JSON.stringify({ action: "attach", session: name, rows: t.term.rows, cols: t.term.cols }));
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
  const folder = getSelectedFolder().split("/").pop() || "root";
  location.href = `/${folder}/terminal/${encodeURIComponent(name)}`;
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

function focusSession(name) {
  // Scroll card into view and attach
  const card = document.querySelector(`[data-session="${name}"]`);
  if (card) {
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    attachSession(name);
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

// ═══ Filter ═══

function filterCards(folder) {
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

  // Folder filter
  const select = document.getElementById("folder-select");
  if (select) {
    select.onchange = () => filterCards(select.value);
    filterCards(select.value);
  }

  // Stats
  loadStats();
  setInterval(loadStats, 5000);

  // Periodically refresh all non-attached terminals (for multi-browser sync)
  setInterval(() => {
    terminals.forEach((t, name) => {
      if (name !== currentSession) {
        loadTerminalContent(name, true);
      }
    });
  }, 3000);
});
