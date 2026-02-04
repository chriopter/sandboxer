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

  const term = new Terminal({ cursorBlink: true, fontSize: 13, theme: THEME });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);

  try { term.loadAddon(new WebglAddon.WebglAddon()); } catch {}

  term.open(container);
  setTimeout(() => fit.fit(), 50);

  term.onData((d) => currentSession === name && wsSend(d));
  term.onResize(({ rows, cols }) => currentSession === name && wsSend(JSON.stringify({ action: "resize", rows, cols })));

  new ResizeObserver(() => fit.fit()).observe(container);

  terminals.set(name, { term, fit });
  return terminals.get(name);
}

function attachSession(name) {
  if (currentSession === name) return;
  if (currentSession) wsSend(JSON.stringify({ action: "detach" }));
  currentSession = name;

  const t = terminals.get(name);
  if (!t) return;
  wsSend(JSON.stringify({ action: "attach", session: name, rows: t.term.rows, cols: t.term.cols }));
  t.term.focus();
}

// ═══ UI Actions ═══

function getSelectedFolder() {
  return document.getElementById("folder-select")?.value || "/";
}

async function createSession(type) {
  const dir = getSelectedFolder();
  const res = await fetch(`/api/create?type=${type}&dir=${encodeURIComponent(dir)}`);
  const data = await res.json();
  if (data.ok) {
    const grid = document.querySelector(".grid");
    grid.querySelector(".empty")?.remove();
    grid.insertAdjacentHTML("afterbegin", data.html);
    initCard(grid.firstElementChild);
  }
}

async function killSession(name) {
  if (!confirm(`Kill ${name}?`)) return;
  terminals.get(name)?.term.dispose();
  terminals.delete(name);
  await fetch(`/kill?session=${encodeURIComponent(name)}`);
  document.querySelector(`[data-session="${name}"]`)?.remove();
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

function copyMosh(name) {
  const cmd = `mosh sandboxer@${location.hostname} -- sudo tmux attach -t '${name}'`;
  navigator.clipboard.writeText(cmd);
  showToast("Copied mosh command");
}

function copyMoshFolder() {
  const folder = getSelectedFolder();
  const cmd = folder === "/"
    ? `mosh sandboxer@${location.hostname} -- sandboxer-shell --all`
    : `mosh sandboxer@${location.hostname} -- sandboxer-shell -f '${folder}'`;
  navigator.clipboard.writeText(cmd);
  showToast("Copied mosh command");
}

function showToast(msg) {
  const t = document.getElementById("toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2000);
}

// ═══ Card Init ═══

function initCard(card) {
  const name = card.dataset.session;
  if (!name) return;

  const container = card.querySelector(".xterm-container");
  if (!container || container.dataset.init) return;
  container.dataset.init = "1";

  createTerminal(name, container);

  card.addEventListener("mouseenter", () => attachSession(name));
  card.addEventListener("click", () => { attachSession(name); terminals.get(name)?.term.focus(); });
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
  document.querySelectorAll(".card").forEach(card => {
    const workdir = card.dataset.workdir || "";
    const show = folder === "/" || workdir.startsWith(folder) || !workdir;
    card.style.display = show ? "" : "none";
  });
  fetch("/api/selected-folder", { method: "POST", body: folder });
}

// ═══ Init ═══

document.addEventListener("DOMContentLoaded", () => {
  initWS();
  document.querySelectorAll(".card").forEach(initCard);

  const select = document.getElementById("folder-select");
  if (select) {
    select.onchange = () => filterCards(select.value);
    filterCards(select.value);
  }

  loadStats();
  setInterval(loadStats, 5000);
});
