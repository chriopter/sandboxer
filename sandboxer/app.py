#!/usr/bin/env python3
"""Sandboxer - Web terminal session manager."""

import base64
import hashlib
import hmac
import http.cookies
import http.server
import json
import os
import secrets
import signal
import socket
import socketserver
import subprocess
import threading
import time
import urllib.parse
from html import escape

from . import sessions
from . import db
from . import tactical
from . import hooks

PORT = 8081

# Paths
APP_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(APP_DIR, "static")
TACTICAL_STATIC_DIR = os.path.join(APP_DIR, "tactical", "static")
TEMPLATES_DIR = os.path.join(APP_DIR, "templates")
UPLOADS_DIR = "/tmp/sandboxer_uploads"
PASSWORD_FILE = "/etc/sandboxer/password"
SESSIONS_FILE = "/etc/sandboxer/sessions.json"
SELECTED_FOLDER_FILE = "/etc/sandboxer/selected_folder"

# Session duration: 30 days in seconds
SESSION_DURATION = 30 * 24 * 60 * 60

# Ensure uploads directory exists
os.makedirs(UPLOADS_DIR, exist_ok=True)
os.makedirs(os.path.dirname(SESSIONS_FILE), exist_ok=True)

# Session storage: {token: expiry_timestamp}
_auth_sessions: dict[str, float] = {}


def _load_sessions():
    """Load sessions from disk."""
    global _auth_sessions
    if os.path.isfile(SESSIONS_FILE):
        try:
            with open(SESSIONS_FILE) as f:
                data = json.load(f)
            now = time.time()
            _auth_sessions = {k: v for k, v in data.items() if v > now}
            _save_sessions()
        except (json.JSONDecodeError, IOError):
            _auth_sessions = {}


def _save_sessions():
    """Save sessions to disk."""
    try:
        with open(SESSIONS_FILE, "w") as f:
            json.dump(_auth_sessions, f)
    except IOError:
        pass


def get_password_hash() -> str | None:
    if os.path.isfile(PASSWORD_FILE):
        with open(PASSWORD_FILE) as f:
            return f.read().strip()
    return None


def verify_password(password: str) -> bool:
    stored = get_password_hash()
    if not stored:
        return True
    if stored.startswith("sha256:"):
        expected = stored[7:]
        actual = hashlib.sha256(password.encode()).hexdigest()
        return hmac.compare_digest(expected, actual)
    return False


def create_session() -> str:
    token = secrets.token_urlsafe(32)
    expiry = time.time() + SESSION_DURATION
    _auth_sessions[token] = expiry
    _save_sessions()
    return token


def is_valid_session(token: str) -> bool:
    if token not in _auth_sessions:
        return False
    if _auth_sessions[token] < time.time():
        del _auth_sessions[token]
        _save_sessions()
        return False
    return True


def destroy_session(token: str):
    if token in _auth_sessions:
        del _auth_sessions[token]
        _save_sessions()


def get_selected_folder() -> str:
    if os.path.isfile(SELECTED_FOLDER_FILE):
        try:
            with open(SELECTED_FOLDER_FILE) as f:
                return f.read().strip() or "/home/sandboxer/git/sandboxer"
        except IOError:
            pass
    return "/home/sandboxer/git/sandboxer"


def save_selected_folder(folder: str):
    try:
        with open(SELECTED_FOLDER_FILE, "w") as f:
            f.write(folder)
    except IOError:
        pass


MIME_TYPES = {
    ".css": "text/css",
    ".js": "application/javascript",
    ".html": "text/html",
    ".png": "image/png",
    ".ico": "image/x-icon",
}

_templates: dict[str, str] = {}


def load_templates():
    for filename in os.listdir(TEMPLATES_DIR):
        if filename.endswith(".html"):
            path = os.path.join(TEMPLATES_DIR, filename)
            with open(path, "r") as f:
                _templates[filename] = f.read()


def render_template(name: str, **context) -> str:
    template = _templates.get(name, "")
    for key, value in context.items():
        template = template.replace("{{" + key + "}}", str(value))
    return template


def build_single_card(s: dict) -> str:
    display_name = s.get("title") or s["name"]
    workdir = s.get("workdir") or ""
    port = sessions.get_ttyd_port(s["name"])
    terminal_url = f"/t/{port}/" if port else ""

    return f"""<article class="card" draggable="true" data-session="{escape(s['name'])}" data-workdir="{escape(workdir)}">
  <header>
    <span class="card-title" onclick="renameSession('{escape(s['name'])}')">{escape(display_name)}</span>
    <div class="card-actions">
      <button size-="small" variant-="teal" class="ssh-btn" onclick="event.stopPropagation(); copySSH('{escape(s['name'])}')">ssh</button>
      <button size-="small" class="img-btn" onclick="event.stopPropagation(); triggerImageUpload('{escape(s['name'])}')" ondblclick="event.stopPropagation(); triggerImageBrowse('{escape(s['name'])}')">↑</button>
      <input type="file" class="card-image-input" multiple style="display:none" data-session="{escape(s['name'])}">
      <button size-="small" class="fullscreen-header-btn" onclick="event.stopPropagation(); openFullscreen('{escape(s['name'])}')">⧉</button>
      <button size-="small" variant-="red" class="kill-btn" onclick="event.stopPropagation(); killSession(this, '{escape(s['name'])}')">×</button>
    </div>
  </header>
  <div class="terminal">
    <iframe src="{terminal_url}" scrolling="no" sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock"></iframe>
  </div>
</article>"""


def build_session_cards(sessions_list: list[dict]) -> str:
    if not sessions_list:
        return """
<div class="empty">
  <div class="empty-icon">&#9671;</div>
  <p>no active sessions</p>
  <p class="hint">create one below</p>
</div>"""
    return "".join(build_single_card(s) for s in sessions_list)


def filter_sessions_by_folder(sessions_list: list[dict], folder: str) -> list[dict]:
    """Filter sessions to only those matching the selected folder."""
    if folder == "/":
        return sessions_list  # Show all

    filtered = []
    for s in sessions_list:
        workdir = s.get("workdir") or ""
        # Show if: no workdir (legacy), exact match, or subfolder
        if not workdir or workdir == folder or workdir.startswith(folder + "/"):
            filtered.append(s)
    return filtered


def build_dir_options(selected_folder: str | None = None) -> str:
    """Build HTML buttons for directory dropdown."""
    dirs = sessions.get_directories()
    selected = selected_folder or get_selected_folder()

    # Count sessions per folder
    folder_counts = {}
    for workdir in sessions.session_workdirs.values():
        folder_counts[workdir] = folder_counts.get(workdir, 0) + 1

    buttons = []
    for d in dirs:
        name = d.split("/")[-1] if d != "/" else "/"
        count = folder_counts.get(d, 0)
        label = f"{name} ({count})" if count > 0 else name
        aria = "true" if d == selected else "false"
        buttons.append(f'<button data-value="{escape(d)}" size-="small" aria-selected="{aria}">{escape(label)}</button>')
    return "\n          ".join(buttons)


def get_folder_display_name(folder: str, max_len: int = 10, include_count: bool = False) -> str:
    """Get display name for a folder path, truncated if needed."""
    if folder == "/":
        return "/"
    name = folder.split("/")[-1] or folder
    if len(name) > max_len:
        name = name[:max_len-1] + "…"

    if include_count:
        count = sum(1 for w in sessions.session_workdirs.values() if w == folder)
        if count > 0:
            name = f"{name} ({count})"

    return name


def folder_name_to_path(name: str) -> str | None:
    if name == "/":
        return "/"
    dirs = sessions.get_directories()
    for d in dirs:
        if d.rstrip("/").split("/")[-1] == name:
            return d
    if name in dirs:
        return name
    return None


def path_to_folder_name(path: str) -> str:
    if path == "/":
        return ""
    return path.rstrip("/").split("/")[-1]


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def get_cookie(self, name: str) -> str | None:
        cookie_header = self.headers.get("Cookie", "")
        cookies = http.cookies.SimpleCookie()
        cookies.load(cookie_header)
        if name in cookies:
            return cookies[name].value
        return None

    def is_authenticated(self) -> bool:
        if not get_password_hash():
            return True
        token = self.get_cookie("sandboxer_session")
        return token and is_valid_session(token)

    def send_html(self, content: str, status: int = 200, headers: dict = None):
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(content.encode())

    def send_json(self, data, status: int = 200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def send_redirect(self, location: str, headers: dict = None):
        self.send_response(302)
        self.send_header("Location", location)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        path = parsed.path

        if path == "/login":
            if self.is_authenticated():
                self.send_redirect("/")
                return
            error = query.get("error", [""])[0]
            error_html = '<p class="error">Invalid password</p>' if error else ""
            html = render_template("login.html", error=error_html)
            self.send_html(html)
            return

        if path == "/logout":
            token = self.get_cookie("sandboxer_session")
            if token:
                destroy_session(token)
            self.send_redirect("/login", {"Set-Cookie": "sandboxer_session=; Path=/; Max-Age=0"})
            return

        # Tactical API - before auth check (fetched by JS)
        if path == "/api/tactical":
            states = tactical.get_all_states()
            self.send_json({"agents": states})
            return

        if not path.startswith("/static/") and not path.startswith("/tactical/static/") and not self.is_authenticated():
            self.send_redirect("/login")
            return

        if path.startswith("/static/"):
            filename = path[8:]
            filepath = os.path.join(STATIC_DIR, filename)
            if os.path.isfile(filepath) and ".." not in filename:
                ext = os.path.splitext(filename)[1]
                self.send_response(200)
                self.send_header("Content-Type", MIME_TYPES.get(ext, "application/octet-stream"))
                self.end_headers()
                with open(filepath, "rb") as f:
                    self.wfile.write(f.read())
                return
            self.send_response(404)
            self.end_headers()
            return

        if path.startswith("/tactical/static/"):
            filename = path[17:]
            filepath = os.path.join(TACTICAL_STATIC_DIR, filename)
            if os.path.isfile(filepath) and ".." not in filename:
                ext = os.path.splitext(filename)[1]
                self.send_response(200)
                self.send_header("Content-Type", MIME_TYPES.get(ext, "application/octet-stream"))
                self.end_headers()
                with open(filepath, "rb") as f:
                    self.wfile.write(f.read())
                return
            self.send_response(404)
            self.end_headers()
            return

        folder_from_url = None
        if path == "/":
            folder_from_url = "/"  # Root = show all sessions
        elif path.startswith("/") and "/" not in path[1:]:
            folder_name = path[1:]
            folder_from_url = folder_name_to_path(folder_name)

        if path == "/" or folder_from_url is not None:
            selected_folder = folder_from_url if folder_from_url else get_selected_folder()
            all_sessions = sessions.get_all_sessions()
            ordered = sessions.get_ordered_sessions(all_sessions)
            # Filter to selected folder server-side (no flash on load)
            visible = filter_sessions_by_folder(ordered, selected_folder)
            # Only start ttyd for visible sessions
            for s in visible:
                sessions.start_ttyd(s["name"])
            html = render_template(
                "index.html",
                cards=build_session_cards(visible),
                dir_options=build_dir_options(selected_folder),
                selected_folder=selected_folder,
                selected_folder_name=get_folder_display_name(selected_folder, include_count=True),
                system_prompt_path=sessions.SYSTEM_PROMPT_PATH,
            )
            self.send_html(html)
            return

        if path == "/terminal":
            session_name = query.get("session", [""])[0]
            if session_name:
                port = sessions.start_ttyd(session_name)
                title = sessions.get_pane_title(session_name) or session_name
                html = render_template(
                    "terminal.html",
                    session_name=escape(session_name),
                    session_title=escape(title),
                    ttyd_url=f"/t/{port}/",
                )
                self.send_html(html)
                return
            self.send_redirect("/")
            return

        if path == "/create":
            session_type = query.get("type", ["claude"])[0]
            workdir = query.get("dir", ["/home/sandboxer/git/sandboxer"])[0]
            resume_id = query.get("resume_id", [None])[0]
            name = sessions.generate_session_name(session_type, workdir)
            sessions.create_session(name, session_type, workdir, resume_id)
            self.send_redirect("/")
            return

        if path == "/rename":
            old = query.get("old", [""])[0]
            new = query.get("new", [""])[0]
            if old and new:
                sessions.rename_session(old, new)
            self.send_redirect("/")
            return

        if path == "/kill":
            name = query.get("session", [""])[0]
            if name:
                sessions.kill_session(name)
                # Also purge from database (messages and session)
                db.delete_session(name)
            self.send_redirect("/")
            return

        if path == "/restart":
            self.send_html(
                "<html><body style='background:#000;color:#0f0;font-family:monospace;padding:20px'>"
                "restarting...<script>setTimeout(function(){window.location='/'},2000)</script></body></html>"
            )
            subprocess.Popen(["systemctl", "restart", "sandboxer"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return

        if path == "/api/create":
            session_type = query.get("type", ["claude"])[0]
            workdir = query.get("dir", ["/home/sandboxer/git/sandboxer"])[0]
            resume_id = query.get("resume_id", [None])[0]
            name = sessions.generate_session_name(session_type, workdir)
            sessions.create_session(name, session_type, workdir, resume_id)
            sessions.start_ttyd(name)
            s = {"name": name, "title": name, "workdir": workdir}
            card_html = build_single_card(s)
            self.send_json({"ok": True, "name": name, "html": card_html})
            return

        if path == "/api/sessions":
            all_sessions = sessions.get_all_sessions()
            ordered = sessions.get_ordered_sessions(all_sessions)
            for s in ordered:
                s["port"] = sessions.get_ttyd_port(s["name"])
            self.send_json(ordered)
            return

        if path == "/api/resume-sessions":
            workdir = query.get("dir", ["/home/sandboxer/git/sandboxer"])[0]
            resumable = sessions.get_resumable_sessions(workdir)
            self.send_json(resumable)
            return

        if path == "/api/stats":
            try:
                with open("/proc/stat") as f:
                    cpu_line = f.readline()
                cpu_parts = cpu_line.split()[1:5]
                idle = int(cpu_parts[3])
                total = sum(int(x) for x in cpu_parts)
                cpu_pct = 100 - (idle * 100 // total) if total else 0
                with open("/proc/meminfo") as f:
                    lines = f.readlines()
                mem_total = int(lines[0].split()[1])
                mem_avail = int(lines[2].split()[1])
                mem_pct = 100 - (mem_avail * 100 // mem_total) if mem_total else 0
                stat = os.statvfs("/")
                disk_total = stat.f_blocks * stat.f_frsize
                disk_free = stat.f_bavail * stat.f_frsize
                disk_pct = 100 - (disk_free * 100 // disk_total) if disk_total else 0
                self.send_json({"cpu": cpu_pct, "mem": mem_pct, "disk": disk_pct})
            except Exception:
                self.send_json({"cpu": 0, "mem": 0, "disk": 0})
            return

        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/login":
            form = urllib.parse.parse_qs(body.decode())
            password = form.get("password", [""])[0]
            if verify_password(password):
                token = create_session()
                self.send_redirect("/", {"Set-Cookie": f"sandboxer_session={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={SESSION_DURATION}"})
            else:
                self.send_redirect("/login?error=1")
            return

        # Hook endpoint - no auth required (internal use from hook script)
        if path == "/api/hook":
            try:
                data = json.loads(body)
                result = tactical.process_hook_event(data)
                self.send_json(result)
            except Exception as e:
                self.send_json({"error": str(e)}, 500)
            return

        if not self.is_authenticated():
            self.send_json({"error": "unauthorized"}, 401)
            return

        if path == "/api/order":
            try:
                data = json.loads(body)
                order = data.get("order", [])
                if isinstance(order, list):
                    sessions.set_order(order)
                    self.send_json({"ok": True})
                else:
                    self.send_json({"error": "order must be a list"}, 400)
            except Exception as e:
                self.send_json({"error": str(e)}, 500)
            return

        if path == "/api/selected-folder":
            try:
                data = json.loads(body)
                folder = data.get("folder", "")
                if folder:
                    save_selected_folder(folder)
                    self.send_json({"ok": True})
                else:
                    self.send_json({"error": "folder required"}, 400)
            except Exception as e:
                self.send_json({"error": str(e)}, 500)
            return

        if path == "/api/upload":
            try:
                import uuid
                data = json.loads(body)
                file_b64 = data.get("image", "")  # kept as "image" for backwards compat
                orig_filename = data.get("filename", "")
                # Generate unique filename preserving original name
                name, ext = os.path.splitext(orig_filename) if orig_filename else ("file", "")
                if not ext:
                    ext = ".bin"
                # Sanitize filename (remove path components, limit length)
                name = os.path.basename(name)[:50]
                unique_name = f"{name}_{int(time.time())}_{uuid.uuid4().hex[:6]}{ext}"
                filepath = os.path.join(UPLOADS_DIR, unique_name)
                file_data = base64.b64decode(file_b64)
                with open(filepath, "wb") as f:
                    f.write(file_data)
                self.send_json({"ok": True, "path": filepath})
            except Exception as e:
                self.send_json({"error": str(e)}, 500)
            return

        if path == "/api/inject":
            try:
                data = json.loads(body)
                session_name = data.get("session", "")
                text = data.get("text", "")
                if not session_name or not text:
                    self.send_json({"error": "session and text required"}, 400)
                    return
                subprocess.run(["tmux", "send-keys", "-t", session_name, "-l", text], capture_output=True)
                self.send_json({"ok": True})
            except Exception as e:
                self.send_json({"error": str(e)}, 500)
            return

        if path == "/api/send-key":
            try:
                data = json.loads(body)
                session_name = data.get("session", "")
                key = data.get("key", "")
                if not session_name or not key:
                    self.send_json({"error": "session and key required"}, 400)
                    return
                subprocess.run(["tmux", "send-keys", "-t", session_name, key], capture_output=True)
                self.send_json({"ok": True})
            except Exception as e:
                self.send_json({"error": str(e)}, 500)
            return

        if path == "/api/tmux-scroll":
            try:
                data = json.loads(body)
                session_name = data.get("session", "")
                direction = data.get("direction", "up")
                if not session_name:
                    self.send_json({"error": "session required"}, 400)
                    return
                result = subprocess.run(
                    ["tmux", "display-message", "-t", session_name, "-p", "#{pane_in_mode}"],
                    capture_output=True, text=True
                )
                in_copy_mode = result.stdout.strip() == "1"
                if not in_copy_mode:
                    subprocess.run(["tmux", "copy-mode", "-t", session_name], capture_output=True)
                scroll_cmd = "scroll-up" if direction == "up" else "scroll-down"
                subprocess.run(["tmux", "send-keys", "-t", session_name, "-X", "-N", "3", scroll_cmd], capture_output=True)
                self.send_json({"ok": True})
            except Exception as e:
                self.send_json({"error": str(e)}, 500)
            return

        self.send_response(404)
        self.end_headers()


def cleanup(sig, frame):
    print("\nshutting down")
    exit(0)


class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


def sd_notify(state: str):
    addr = os.environ.get("NOTIFY_SOCKET")
    if not addr:
        return
    if addr[0] == "@":
        addr = "\0" + addr[1:]
    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        sock.connect(addr)
        sock.send(state.encode())
        sock.close()
    except Exception:
        pass


def watchdog_thread(interval: float):
    while True:
        time.sleep(interval)
        sd_notify("WATCHDOG=1")


def main():
    signal.signal(signal.SIGTERM, cleanup)
    signal.signal(signal.SIGINT, cleanup)
    _load_sessions()
    load_templates()
    restored = sessions.restore_sessions()
    if restored:
        print(f"restored {restored} session(s) from last run")
    watchdog_usec = os.environ.get("WATCHDOG_USEC")
    if watchdog_usec:
        interval = int(watchdog_usec) / 1_000_000 / 2
        t = threading.Thread(target=watchdog_thread, args=(interval,), daemon=True)
        t.start()
    sd_notify("READY=1")
    print(f"sandboxer http://127.0.0.1:{PORT}")
    server = ThreadedHTTPServer(("127.0.0.1", PORT), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
