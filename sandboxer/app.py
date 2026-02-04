#!/usr/bin/env python3
"""Sandboxer - Minimal web terminal manager."""

import asyncio
import http.server
import json
import os
import signal
import socketserver
import subprocess
import threading
import urllib.parse
from html import escape

# ═══ Config ═══
PORT = 8081
WS_PORT = 8082
GIT_DIR = "/home/sandboxer/git"
DATA_DIR = "/etc/sandboxer"
SYSTEM_PROMPT = os.path.join(os.path.dirname(os.path.dirname(__file__)), "config", "system-prompt.txt")

# Session state (persisted to JSON)
_sessions: dict[str, dict] = {}  # name -> {workdir, type}
_order: list[str] = []
_selected_folder: str = "/"


# ═══ Persistence ═══

def _load():
    global _sessions, _order, _selected_folder
    try:
        with open(f"{DATA_DIR}/sessions.json") as f:
            _sessions = json.load(f)
    except:
        _sessions = {}
    try:
        with open(f"{DATA_DIR}/order.json") as f:
            _order = json.load(f)
    except:
        _order = []
    try:
        with open(f"{DATA_DIR}/selected_folder") as f:
            _selected_folder = f.read().strip() or "/"
    except:
        _selected_folder = "/"


def _save():
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(f"{DATA_DIR}/sessions.json", "w") as f:
        json.dump(_sessions, f)
    with open(f"{DATA_DIR}/order.json", "w") as f:
        json.dump(_order, f)


# ═══ tmux Operations ═══

def get_tmux_sessions() -> list[str]:
    """Get list of tmux session names."""
    r = subprocess.run(["tmux", "list-sessions", "-F", "#{session_name}"],
                       capture_output=True, text=True)
    if r.returncode != 0:
        return []
    return [s for s in r.stdout.strip().split("\n") if s and not s.startswith("split-")]


def get_pane_title(name: str) -> str:
    """Get pane title for a session."""
    r = subprocess.run(["tmux", "display-message", "-t", name, "-p", "#{pane_title}"],
                       capture_output=True, text=True)
    title = r.stdout.strip() if r.returncode == 0 else ""
    if title.startswith("✳ "):
        title = title[2:]
    return title if title and title != "Window Title" else name


def create_session(name: str, session_type: str, workdir: str):
    """Create a tmux session."""
    subprocess.run(["tmux", "new-session", "-d", "-s", name, "-c", workdir], capture_output=True)
    subprocess.run(["tmux", "set", "-t", name, "mouse", "on"], capture_output=True)

    if session_type == "claude":
        cmd = f"IS_SANDBOX=1 claude --dangerously-skip-permissions --system-prompt {SYSTEM_PROMPT}"
        subprocess.run(["tmux", "send-keys", "-t", name, cmd, "Enter"], capture_output=True)
    elif session_type == "gemini":
        subprocess.run(["tmux", "send-keys", "-t", name, "gemini", "Enter"], capture_output=True)
    elif session_type == "lazygit":
        subprocess.run(["tmux", "send-keys", "-t", name, "lazygit", "Enter"], capture_output=True)

    _sessions[name] = {"workdir": workdir, "type": session_type}
    if name not in _order:
        _order.append(name)
    _save()


def kill_session(name: str):
    """Kill a tmux session."""
    subprocess.run(["tmux", "kill-session", "-t", name], capture_output=True)
    _sessions.pop(name, None)
    if name in _order:
        _order.remove(name)
    _save()


def generate_name(session_type: str, workdir: str) -> str:
    """Generate session name: <dir>-<type>-<n>."""
    dir_name = os.path.basename(workdir.rstrip("/")) or "root"
    dir_name = dir_name.replace(".", "_")
    prefix = f"{dir_name}-{session_type}-"

    existing = get_tmux_sessions()
    max_n = 0
    for s in existing:
        if s.startswith(prefix):
            try:
                max_n = max(max_n, int(s[len(prefix):]))
            except:
                pass
    return f"{prefix}{max_n + 1}"


# ═══ Session List ═══

def get_sessions() -> list[dict]:
    """Get ordered session list with metadata."""
    tmux = set(get_tmux_sessions())

    # Clean stale entries
    for name in list(_sessions.keys()):
        if name not in tmux:
            del _sessions[name]
    _order[:] = [n for n in _order if n in tmux]

    # Build ordered list
    result = []
    seen = set()
    for name in _order:
        if name in tmux:
            meta = _sessions.get(name, {})
            result.append({
                "name": name,
                "title": get_pane_title(name),
                "workdir": meta.get("workdir", ""),
                "type": meta.get("type", "bash"),
            })
            seen.add(name)

    # Add untracked sessions
    for name in tmux - seen:
        result.append({"name": name, "title": get_pane_title(name), "workdir": "", "type": "bash"})
        _order.append(name)

    _save()
    return result


def get_directories() -> list[str]:
    """Get list of git directories."""
    dirs = ["/"]
    try:
        for e in sorted(os.listdir(GIT_DIR)):
            p = f"{GIT_DIR}/{e}"
            if os.path.isdir(p) and not e.startswith("."):
                dirs.append(p)
    except:
        pass
    return dirs


def build_folder_options() -> str:
    """Build folder dropdown HTML."""
    dirs = get_directories()
    opts = []
    for d in dirs:
        label = "/" if d == "/" else os.path.basename(d)
        sel = " selected" if d == _selected_folder else ""
        opts.append(f'<option value="{escape(d)}"{sel}>{escape(label)}</option>')
    return "\n".join(opts)


def build_sidebar_sessions() -> str:
    """Build sidebar session list HTML."""
    sessions = get_sessions()
    if not sessions:
        return '<li class="sidebar-empty">No sessions</li>'

    # Group by type
    by_type = {}
    for s in sessions:
        t = s.get("type", "bash")
        if t not in by_type:
            by_type[t] = []
        by_type[t].append(s)

    html = []
    for t in ["claude", "lazygit", "bash", "gemini"]:
        if t not in by_type:
            continue
        html.append(f'<li class="sidebar-type-header">{t}</li>')
        for s in by_type[t]:
            name = escape(s["name"])
            title = escape(s["title"])[:30]
            workdir = escape(s.get("workdir", ""))
            html.append(f'<li class="sidebar-session" data-session="{name}" data-workdir="{workdir}" onclick="focusSession(\'{name}\')">{title}</li>')

    return "\n".join(html)


# ═══ Templates ═══

_tpl_index = None
_tpl_terminal = None

def load_templates():
    global _tpl_index, _tpl_terminal
    tpl_dir = os.path.join(os.path.dirname(__file__), "templates")
    with open(f"{tpl_dir}/index.html") as f:
        _tpl_index = f.read()
    with open(f"{tpl_dir}/terminal.html") as f:
        _tpl_terminal = f.read()


def render(tpl: str, **kw) -> str:
    for k, v in kw.items():
        tpl = tpl.replace("{{" + k + "}}", str(v))
    return tpl


def build_card(s: dict) -> str:
    return f'''<article class="card" data-session="{escape(s['name'])}" data-workdir="{escape(s['workdir'])}" data-type="{escape(s['type'])}">
  <header>
    <span class="card-title">{escape(s['title'])}</span>
    <div class="card-actions">
      <button class="btn-teal" onclick="copySessionSSH('{escape(s['name'])}')">ssh</button>
      <button onclick="openFullscreen('{escape(s['name'])}')">⧉</button>
      <button class="btn-red" onclick="killSession('{escape(s['name'])}')">×</button>
    </div>
  </header>
  <div class="terminal"><div class="xterm-container"></div></div>
</article>'''


# ═══ HTTP Handler ═══

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def send_html(self, html: str, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(html.encode())

    def send_json(self, data, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def do_GET(self):
        p = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(p.query)
        path = p.path

        # Static files
        if path.startswith("/static/"):
            fpath = os.path.join(os.path.dirname(__file__), path[1:])
            if os.path.isfile(fpath):
                self.send_response(200)
                ct = "text/css" if fpath.endswith(".css") else "application/javascript" if fpath.endswith(".js") else "image/png"
                self.send_header("Content-Type", ct)
                self.end_headers()
                with open(fpath, "rb") as f:
                    self.wfile.write(f.read())
                return
            self.send_response(404)
            self.end_headers()
            return

        # API: sessions
        if path == "/api/sessions":
            self.send_json(get_sessions())
            return

        # API: stats
        if path == "/api/stats":
            import psutil
            self.send_json({
                "cpu": int(psutil.cpu_percent()),
                "mem": int(psutil.virtual_memory().percent),
            })
            return

        # API: create session
        if path == "/api/create":
            t = q.get("type", ["claude"])[0]
            d = q.get("dir", [f"{GIT_DIR}/sandboxer"])[0]
            name = generate_name(t, d)
            create_session(name, t, d)
            s = {"name": name, "title": name, "workdir": d, "type": t}
            self.send_json({"ok": True, "name": name, "html": build_card(s)})
            return

        # Kill session
        if path == "/kill":
            name = q.get("session", [""])[0]
            if name:
                kill_session(name)
            self.send_response(302)
            self.send_header("Location", "/")
            self.end_headers()
            return

        # Fullscreen terminal
        parts = [x for x in path.split("/") if x]
        if len(parts) == 3 and parts[1] == "terminal":
            name = urllib.parse.unquote(parts[2])
            title = get_pane_title(name)
            html = render(_tpl_terminal, session_name=escape(name), session_title=escape(title), title_html=escape(title))
            self.send_html(html)
            return

        # Dashboard
        if len(parts) <= 1:
            sessions = get_sessions()
            cards = "".join(build_card(s) for s in sessions) or '<div class="empty">No sessions</div>'
            html = render(_tpl_index, cards=cards, folder_options=build_folder_options(), sidebar_sessions=build_sidebar_sessions())
            self.send_html(html)
            return

        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        global _selected_folder
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        path = urllib.parse.urlparse(self.path).path

        if path == "/api/order":
            data = json.loads(body)
            _order[:] = data.get("order", [])
            _save()
            self.send_json({"ok": True})
            return

        if path == "/api/selected-folder":
            _selected_folder = body.decode().strip() or "/"
            os.makedirs(DATA_DIR, exist_ok=True)
            with open(f"{DATA_DIR}/selected_folder", "w") as f:
                f.write(_selected_folder)
            self.send_json({"ok": True})
            return

        self.send_response(404)
        self.end_headers()


# ═══ Main ═══

def start_ws():
    from . import ws
    asyncio.run(ws.main("127.0.0.1", WS_PORT))


def main():
    signal.signal(signal.SIGTERM, lambda *a: exit(0))
    signal.signal(signal.SIGINT, lambda *a: exit(0))

    _load()
    load_templates()

    # Start WebSocket server
    threading.Thread(target=start_ws, daemon=True).start()

    print(f"sandboxer http://127.0.0.1:{PORT}")
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    server = socketserver.ThreadingTCPServer(("127.0.0.1", PORT), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
