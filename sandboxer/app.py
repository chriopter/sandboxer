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


def build_folder_options(active_folder: str = None) -> str:
    """Build folder dropdown HTML with Claude session counts."""
    dirs = get_directories()
    sessions = get_sessions()
    selected = active_folder or _selected_folder

    # Count Claude sessions per folder
    counts = {}
    for s in sessions:
        if s.get("type") == "claude":
            workdir = s.get("workdir", "")
            counts[workdir] = counts.get(workdir, 0) + 1

    opts = []
    for d in dirs:
        label = "/" if d == "/" else os.path.basename(d)
        sel = " selected" if d == selected else ""
        # Add count for this folder
        count = counts.get(d, 0)
        count_str = f" ({count})" if count > 0 else ""
        opts.append(f'<option value="{escape(d)}"{sel}>{escape(label)}{count_str}</option>')
    return "\n".join(opts)


def cron_to_human(schedule: str) -> str:
    """Convert cron schedule to human-readable format."""
    if not schedule:
        return ""
    parts = schedule.split()
    if len(parts) != 5:
        return schedule

    minute, hour, dom, month, dow = parts

    # Every N minutes
    if minute.startswith("*/") and hour == "*" and dom == "*" and month == "*" and dow == "*":
        n = minute[2:]
        return f"every {n}m"

    # Every minute
    if minute == "*" and hour == "*" and dom == "*" and month == "*" and dow == "*":
        return "every min"

    # Every hour at specific minute
    if minute.isdigit() and hour == "*" and dom == "*" and month == "*" and dow == "*":
        return "every hour"

    # Specific time daily
    if minute.isdigit() and hour.isdigit() and dom == "*" and month == "*" and dow == "*":
        return f"daily {hour}:{minute.zfill(2)}"

    # Specific weekday
    dow_names = {0: "sun", 1: "mon", 2: "tue", 3: "wed", 4: "thu", 5: "fri", 6: "sat"}
    if minute.isdigit() and hour.isdigit() and dom == "*" and month == "*" and dow.isdigit():
        return f"{dow_names.get(int(dow), dow)} {hour}:{minute.zfill(2)}"

    return schedule[:15]


def get_crons() -> list[dict]:
    """Get all cron jobs from .sandboxer/cron-*.yaml files."""
    import glob
    crons = []
    for d in get_directories():
        if d == "/":
            continue
        pattern = f"{d}/.sandboxer/cron-*.yaml"
        for f in glob.glob(pattern):
            try:
                import yaml
                with open(f) as fp:
                    data = yaml.safe_load(fp)
                name = os.path.basename(f).replace("cron-", "").replace(".yaml", "")
                schedule = data.get("schedule", "")
                crons.append({
                    "name": name,
                    "path": f,
                    "workdir": d,
                    "schedule": schedule,
                    "schedule_human": cron_to_human(schedule),
                    "type": data.get("type", "bash"),
                    "command": data.get("command", ""),
                    "prompt": data.get("prompt", ""),
                    "condition": data.get("condition", ""),
                    "enabled": data.get("enabled", True),
                })
            except:
                pass
    return crons


def run_cron(cron: dict):
    """Execute a cron job - creates visible tmux session for claude."""
    from datetime import datetime

    name = cron["name"]
    workdir = cron["workdir"]
    log_path = f"/var/log/sandboxer/cron-{name}.log"

    os.makedirs("/var/log/sandboxer", exist_ok=True)

    with open(log_path, "a") as log:
        log.write(f"\n{'='*60}\n")
        log.write(f"[{datetime.now().isoformat()}] CRON: {name}\n")
        log.flush()

        # Check condition if specified
        if cron.get("condition"):
            result = subprocess.run(
                cron["condition"], shell=True, cwd=workdir,
                capture_output=True, text=True
            )
            if result.returncode != 0:
                log.write(f"[{datetime.now().isoformat()}] CONDITION NOT MET ✗\n")
                return
            log.write(f"[{datetime.now().isoformat()}] CONDITION MET ✓\n")
            log.flush()

    # Execute based on type
    if cron["type"] == "claude":
        # Create tmux session like regular claude sessions
        prompt = cron.get("prompt", "Run scheduled task")
        session_name = f"cron-{name}"

        # Kill existing if any
        subprocess.run(["tmux", "kill-session", "-t", session_name], capture_output=True)

        # Create session
        subprocess.run(["tmux", "new-session", "-d", "-s", session_name, "-c", workdir], capture_output=True)
        subprocess.run(["tmux", "set", "-t", session_name, "mouse", "on"], capture_output=True)

        # Start claude with IS_SANDBOX=1 (same as web UI)
        # Use heredoc to avoid bash history expansion issues with ! and other special chars
        cmd = f"IS_SANDBOX=1 claude --dangerously-skip-permissions --system-prompt {SYSTEM_PROMPT} -p \"$(cat <<'PROMPT'\n{prompt}\nPROMPT\n)\""
        subprocess.run(["tmux", "send-keys", "-t", session_name, cmd, "Enter"], capture_output=True)

        # Register session
        _sessions[session_name] = {"workdir": workdir, "type": "claude"}
        if session_name not in _order:
            _order.insert(0, session_name)
        _save()

        with open(log_path, "a") as log:
            log.write(f"[{datetime.now().isoformat()}] SPAWNING CLAUDE → session: {session_name}\n")
    else:
        # Bash command - run in background and log
        command = cron.get("command", "echo 'No command specified'")

        def run_job():
            with open(log_path, "a") as log:
                log.write(f"[{datetime.now().isoformat()}] RUNNING: {command[:50]}...\n")
                log.flush()
                try:
                    result = subprocess.run(
                        command, shell=True, cwd=workdir,
                        capture_output=True, text=True, timeout=3600
                    )
                    if result.stdout:
                        log.write(result.stdout)
                    if result.stderr:
                        log.write(f"STDERR: {result.stderr}")
                    log.write(f"[{datetime.now().isoformat()}] EXIT: {result.returncode}\n")
                except subprocess.TimeoutExpired:
                    log.write(f"[{datetime.now().isoformat()}] TIMEOUT after 1h\n")
                except Exception as e:
                    log.write(f"[{datetime.now().isoformat()}] ERROR: {e}\n")

        threading.Thread(target=run_job, daemon=True).start()


def cron_scheduler():
    """Background thread that checks and runs crons."""
    import time
    from datetime import datetime
    from croniter import croniter

    last_run = {}  # Track last run time per cron

    while True:
        try:
            now = datetime.now()
            crons = get_crons()

            for cron in crons:
                if not cron.get("enabled", True):
                    continue
                if not cron.get("schedule"):
                    continue

                cron_id = cron["path"]
                schedule = cron["schedule"]

                try:
                    cron_iter = croniter(schedule, now)
                    prev_time = cron_iter.get_prev(datetime)

                    # Check if we should run (within last minute and not already run)
                    if (now - prev_time).total_seconds() < 60:
                        last = last_run.get(cron_id)
                        if last is None or (now - last).total_seconds() >= 60:
                            print(f"[cron] Running: {cron['name']}")
                            last_run[cron_id] = now
                            run_cron(cron)
                except Exception as e:
                    print(f"[cron] Error with {cron['name']}: {e}")
        except Exception as e:
            print(f"[cron] Scheduler error: {e}")

        time.sleep(30)  # Check every 30 seconds


def build_sidebar_sessions() -> str:
    """Build sidebar session list HTML."""
    sessions = get_sessions()
    crons = get_crons()

    if not sessions and not crons:
        return '<li class="sidebar-empty">No sessions</li>'

    # Group sessions by type
    by_type = {}
    for s in sessions:
        t = s.get("type", "bash")
        if t not in by_type:
            by_type[t] = []
        by_type[t].append(s)

    html = []

    # Sessions
    for t in ["claude", "lazygit", "bash", "gemini"]:
        if t not in by_type:
            continue
        html.append(f'<li class="sidebar-type-header">{t}</li>')
        for s in by_type[t]:
            name = escape(s["name"])
            title = escape(s["title"])[:30]
            workdir = escape(s.get("workdir", ""))
            html.append(f'<li class="sidebar-session" data-session="{name}" data-workdir="{workdir}" onclick="focusSession(\'{name}\')">{title}</li>')

    # Crons (collapsible)
    if crons:
        html.append('<li class="sidebar-type-header sidebar-cron-header" onclick="toggleCrons()">cron <span class="cron-toggle">▼</span></li>')
        for c in crons:
            name = escape(c["name"])
            path = escape(c["path"])
            workdir = escape(c["workdir"])
            enabled = "enabled" if c["enabled"] else "disabled"
            schedule_human = escape(c.get("schedule_human", ""))
            freq = f' <span class="cron-freq">({schedule_human})</span>' if schedule_human else ""
            html.append(f'<li class="sidebar-cron {enabled}" data-workdir="{workdir}" onclick="openCron(\'{path}\')">{name}{freq}</li>')

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
      <button onclick="uploadClick('{escape(s['name'])}')" ondblclick="uploadDblClick('{escape(s['name'])}')" title="Click: paste, Double-click: browse">📎</button>
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

        # API: capture pane content (for initial render)
        if path == "/api/capture":
            name = q.get("session", [""])[0]
            if name:
                # Get pane dimensions
                dims = subprocess.run(
                    ["tmux", "display-message", "-t", name, "-p", "#{pane_width} #{pane_height}"],
                    capture_output=True, text=True
                )
                cols, rows = 80, 24
                if dims.returncode == 0:
                    parts = dims.stdout.strip().split()
                    if len(parts) == 2:
                        cols, rows = int(parts[0]), int(parts[1])

                r = subprocess.run(
                    ["tmux", "capture-pane", "-t", name, "-p", "-e"],
                    capture_output=True, text=True
                )
                self.send_json({
                    "content": r.stdout if r.returncode == 0 else "",
                    "cols": cols,
                    "rows": rows
                })
            else:
                self.send_json({"content": "", "cols": 80, "rows": 24})
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

        # API: create cron view (split pane: cat + log)
        if path == "/api/create-cron-view":
            cron_path = q.get("path", [""])[0]
            log_path = q.get("log", [""])[0]
            d = q.get("dir", [f"{GIT_DIR}/sandboxer"])[0]
            cron_name = os.path.basename(cron_path).replace("cron-", "").replace(".yaml", "")
            name = f"cron-{cron_name}"

            # Kill existing if any
            subprocess.run(["tmux", "kill-session", "-t", name], capture_output=True)

            # Create session
            subprocess.run(["tmux", "new-session", "-d", "-s", name, "-c", d], capture_output=True)
            subprocess.run(["tmux", "set", "-t", name, "mouse", "on"], capture_output=True)

            # Script that sets up split panes after terminal is sized
            script = f'''#!/bin/bash
sleep 0.3
tmux split-window -h -t {name} 2>/dev/null
tmux send-keys -t {name}:0.1 "clear; echo '─── Log ───'; mkdir -p /var/log/sandboxer; touch {log_path}; tail -f {log_path}" Enter 2>/dev/null
tmux select-pane -t {name}:0.0 2>/dev/null
clear
echo '─── {os.path.basename(cron_path)} ───'
echo
cat {cron_path}
echo
echo '>>> Press Enter to edit <<<'
read -r
nano {cron_path}
exec bash
'''
            # Write script to temp file and execute
            script_path = f"/tmp/cron-setup-{cron_name}.sh"
            with open(script_path, "w") as f:
                f.write(script)
            os.chmod(script_path, 0o755)
            subprocess.run(["tmux", "send-keys", "-t", name, f"bash {script_path}", "Enter"], capture_output=True)

            _sessions[name] = {"workdir": d, "type": "cron"}
            if name not in _order:
                _order.insert(0, name)
            _save()

            s = {"name": name, "title": f"cron: {cron_name}", "workdir": d, "type": "cron"}
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

        # Dashboard: /, /folder, /folder/session
        if len(parts) <= 2 and (len(parts) == 0 or parts[0] not in ("api", "static", "kill")):
            # Parse folder from URL
            url_folder = "/"
            url_session = None

            if len(parts) >= 1 and parts[0] != "terminal":
                folder_name = urllib.parse.unquote(parts[0])
                # Find full path matching this folder name
                for d in get_directories():
                    if os.path.basename(d) == folder_name:
                        url_folder = d
                        break

            if len(parts) == 2:
                url_session = urllib.parse.unquote(parts[1])

            sessions = get_sessions()
            cards = "".join(build_card(s) for s in sessions) or '<div class="empty">No sessions</div>'
            html = render(_tpl_index,
                         cards=cards,
                         folder_options=build_folder_options(url_folder),
                         sidebar_sessions=build_sidebar_sessions(),
                         active_folder=escape(url_folder),
                         active_session=escape(url_session or ""))
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

        if path == "/api/upload":
            import base64
            import time
            data = json.loads(body)
            filename = data.get("filename", "upload")
            content = base64.b64decode(data.get("content", ""))
            # Sanitize filename
            safe_name = "".join(c for c in filename if c.isalnum() or c in ".-_")
            # Add timestamp to avoid collisions
            ts = int(time.time())
            dest = f"/tmp/{ts}-{safe_name}"
            with open(dest, "wb") as f:
                f.write(content)
            self.send_json({"ok": True, "path": dest})
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

    # Start cron scheduler
    threading.Thread(target=cron_scheduler, daemon=True).start()

    print(f"sandboxer http://127.0.0.1:{PORT}")
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    server = socketserver.ThreadingTCPServer(("127.0.0.1", PORT), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
