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
import subprocess
import time
import urllib.parse
from html import escape

from . import sessions

PORT = 8081

# Paths
APP_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(APP_DIR, "static")
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
            # Filter out expired sessions
            now = time.time()
            _auth_sessions = {k: v for k, v in data.items() if v > now}
            _save_sessions()  # Save back without expired ones
        except (json.JSONDecodeError, IOError):
            _auth_sessions = {}


def _save_sessions():
    """Save sessions to disk."""
    try:
        with open(SESSIONS_FILE, "w") as f:
            json.dump(_auth_sessions, f)
    except IOError:
        pass  # Silent fail - sessions will work in-memory


def get_password_hash() -> str | None:
    """Get stored password hash, or None if no password set."""
    if os.path.isfile(PASSWORD_FILE):
        with open(PASSWORD_FILE) as f:
            return f.read().strip()
    return None


def verify_password(password: str) -> bool:
    """Verify password against stored hash."""
    stored = get_password_hash()
    if not stored:
        return True  # No password = always valid
    # Hash format: sha256:<hash>
    if stored.startswith("sha256:"):
        expected = stored[7:]
        actual = hashlib.sha256(password.encode()).hexdigest()
        return hmac.compare_digest(expected, actual)
    return False


def create_session() -> str:
    """Create a new auth session token valid for 30 days."""
    token = secrets.token_urlsafe(32)
    expiry = time.time() + SESSION_DURATION
    _auth_sessions[token] = expiry
    _save_sessions()
    return token


def is_valid_session(token: str) -> bool:
    """Check if session token is valid and not expired."""
    if token not in _auth_sessions:
        return False
    if _auth_sessions[token] < time.time():
        # Expired - clean up
        del _auth_sessions[token]
        _save_sessions()
        return False
    return True


def destroy_session(token: str):
    """Destroy an auth session."""
    if token in _auth_sessions:
        del _auth_sessions[token]
        _save_sessions()


def get_selected_folder() -> str:
    """Get the saved selected folder, or default."""
    if os.path.isfile(SELECTED_FOLDER_FILE):
        try:
            with open(SELECTED_FOLDER_FILE) as f:
                return f.read().strip() or "/home/sandboxer/git/sandboxer"
        except IOError:
            pass
    return "/home/sandboxer/git/sandboxer"


def save_selected_folder(folder: str):
    """Save the selected folder."""
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

# Template cache
_templates: dict[str, str] = {}


def load_templates():
    """Load all HTML templates into memory."""
    for filename in os.listdir(TEMPLATES_DIR):
        if filename.endswith(".html"):
            path = os.path.join(TEMPLATES_DIR, filename)
            with open(path, "r") as f:
                _templates[filename] = f.read()


def render_template(name: str, **context) -> str:
    """Render a template with variable substitution."""
    template = _templates.get(name, "")
    for key, value in context.items():
        template = template.replace("{{" + key + "}}", str(value))
    return template


def build_session_cards(sessions_list: list[dict]) -> str:
    """Build HTML for session cards."""
    if not sessions_list:
        return """
<div class="empty">
  <div class="empty-icon">&#9671;</div>
  <p>no active sessions</p>
  <p class="hint">create one below</p>
</div>"""

    cards = ""
    for s in sessions_list:
        port = sessions.get_ttyd_port(s["name"])
        terminal_url = f"/t/{port}/" if port else ""
        status = "active" if s.get("attached") else "idle"
        status_color = "var(--green)" if s.get("attached") else "var(--overlay0)"

        display_name = s.get("title") or s["name"]

        workdir = s.get("workdir") or ""
        cards += f"""
<article class="card" draggable="true" data-session="{escape(s['name'])}" data-workdir="{escape(workdir)}">
  <header>
    <span class="card-title" onclick="renameSession('{escape(s['name'])}')">{escape(display_name)}</span>
    <div class="card-actions">
      <button size-="small" onclick="event.stopPropagation(); window.open('/terminal?session=' + encodeURIComponent('{escape(s['name'])}'), '_blank')">↗</button>
      <button size-="small" variant-="teal" onclick="event.stopPropagation(); copySSH('{escape(s['name'])}')">ssh</button>
      <button size-="small" variant-="red" class="kill-btn" onclick="event.stopPropagation(); killSession(this, '{escape(s['name'])}')">×</button>
    </div>
  </header>
  <div class="terminal">
    <iframe src="{terminal_url}" scrolling="no" sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock"></iframe>
    <button class="fullscreen-btn" size-="small" onclick="window.open('/terminal?session=' + encodeURIComponent('{escape(s['name'])}'), '_blank')">⛶</button>
  </div>
</article>"""

    return cards


def build_dir_options() -> str:
    """Build HTML options for directory select."""
    dirs = sessions.get_directories()
    selected = get_selected_folder()
    options = []
    for d in dirs:
        sel = ' selected' if d == selected else ''
        options.append(f'<option value="{d}"{sel}>{d}</option>')
    return "\n".join(options)


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # Suppress logging

    def get_cookie(self, name: str) -> str | None:
        """Get a cookie value."""
        cookie_header = self.headers.get("Cookie", "")
        cookies = http.cookies.SimpleCookie()
        cookies.load(cookie_header)
        if name in cookies:
            return cookies[name].value
        return None

    def is_authenticated(self) -> bool:
        """Check if request is authenticated."""
        # No password set = no auth required
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

        # ─── Login Page (always accessible) ───
        if path == "/login":
            if self.is_authenticated():
                self.send_redirect("/")
                return
            error = query.get("error", [""])[0]
            error_html = '<p class="error">Invalid password</p>' if error else ""
            html = render_template("login.html", error=error_html)
            self.send_html(html)
            return

        # ─── Logout ───
        if path == "/logout":
            token = self.get_cookie("sandboxer_session")
            if token:
                destroy_session(token)
            self.send_redirect("/login", {"Set-Cookie": "sandboxer_session=; Path=/; Max-Age=0"})
            return

        # ─── Auth Check (except static files) ───
        if not path.startswith("/static/") and not self.is_authenticated():
            self.send_redirect("/login")
            return

        # ─── Static Files ───
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

        # ─── Main Page ───
        if path == "/":
            tmux_sessions = sessions.get_tmux_sessions()
            ordered = sessions.get_ordered_sessions(tmux_sessions)

            # Start ttyd for each session
            for s in ordered:
                sessions.start_ttyd(s["name"])

            html = render_template(
                "index.html",
                cards=build_session_cards(ordered),
                dir_options=build_dir_options(),
                system_prompt_path=sessions.SYSTEM_PROMPT_PATH,
            )
            self.send_html(html)
            return

        # ─── Terminal Page ───
        if path == "/terminal":
            session_name = query.get("session", [""])[0]
            if session_name:
                port = sessions.start_ttyd(session_name)
                html = render_template(
                    "terminal.html",
                    session_name=escape(session_name),
                    ttyd_url=f"/t/{port}/",
                )
                self.send_html(html)
                return
            self.send_redirect("/")
            return

        # ─── Create Session ───
        if path == "/create":
            session_type = query.get("type", ["claude"])[0]
            workdir = query.get("dir", ["/home/sandboxer/git/sandboxer"])[0]
            resume_id = query.get("resume_id", [None])[0]
            name = sessions.generate_session_name(session_type, workdir)
            sessions.create_session(name, session_type, workdir, resume_id)
            self.send_redirect("/")
            return

        # ─── Rename Session ───
        if path == "/rename":
            old = query.get("old", [""])[0]
            new = query.get("new", [""])[0]
            if old and new:
                sessions.rename_session(old, new)
            self.send_redirect("/")
            return

        # ─── Kill Session ───
        if path == "/kill":
            name = query.get("session", [""])[0]
            if name:
                sessions.kill_session(name)
            self.send_redirect("/")
            return

        # ─── Restart Service ───
        if path == "/restart":
            self.send_html(
                "<html><body style='background:#000;color:#0f0;font-family:monospace;padding:20px'>"
                "restarting...<script>setTimeout(function(){window.location='/'},2000)</script></body></html>"
            )
            subprocess.Popen(["systemctl", "restart", "sandboxer"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return

        # ─── API: Sessions ───
        if path == "/api/sessions":
            tmux_sessions = sessions.get_tmux_sessions()
            ordered = sessions.get_ordered_sessions(tmux_sessions)
            for s in ordered:
                s["port"] = sessions.get_ttyd_port(s["name"])
            self.send_json(ordered)
            return

        # ─── API: Resume Sessions ───
        if path == "/api/resume-sessions":
            workdir = query.get("dir", ["/home/sandboxer/git/sandboxer"])[0]
            resumable = sessions.get_resumable_sessions(workdir)
            self.send_json(resumable)
            return

        # ─── API: System Stats ───
        if path == "/api/stats":
            try:
                # CPU usage
                with open("/proc/stat") as f:
                    cpu_line = f.readline()
                cpu_parts = cpu_line.split()[1:5]
                idle = int(cpu_parts[3])
                total = sum(int(x) for x in cpu_parts)
                cpu_pct = 100 - (idle * 100 // total) if total else 0

                # Memory usage
                with open("/proc/meminfo") as f:
                    lines = f.readlines()
                mem_total = int(lines[0].split()[1])
                mem_avail = int(lines[2].split()[1])
                mem_pct = 100 - (mem_avail * 100 // mem_total) if mem_total else 0

                # Disk usage
                stat = os.statvfs("/")
                disk_total = stat.f_blocks * stat.f_frsize
                disk_free = stat.f_bavail * stat.f_frsize
                disk_pct = 100 - (disk_free * 100 // disk_total) if disk_total else 0

                self.send_json({"cpu": cpu_pct, "mem": mem_pct, "disk": disk_pct})
            except Exception:
                self.send_json({"cpu": 0, "mem": 0, "disk": 0})
            return

        # ─── 404 ───
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        # ─── Login ───
        if path == "/login":
            form = urllib.parse.parse_qs(body.decode())
            password = form.get("password", [""])[0]
            if verify_password(password):
                token = create_session()
                # Cookie expires in 30 days (matches session duration)
                self.send_redirect("/", {"Set-Cookie": f"sandboxer_session={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={SESSION_DURATION}"})
            else:
                self.send_redirect("/login?error=1")
            return

        # ─── Auth Check for all other POST endpoints ───
        if not self.is_authenticated():
            self.send_json({"error": "unauthorized"}, 401)
            return

        # ─── API: Set Order ───
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

        # ─── API: Set Selected Folder ───
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

        # ─── API: Upload Image ───
        if path == "/api/upload":
            try:
                data = json.loads(body)
                image_b64 = data.get("image", "")
                filename = data.get("filename", f"clipboard_{int(time.time())}.png")

                # Sanitize filename
                filename = os.path.basename(filename)
                if not filename:
                    filename = f"clipboard_{int(time.time())}.png"

                filepath = os.path.join(UPLOADS_DIR, filename)

                # Decode and save
                image_data = base64.b64decode(image_b64)
                with open(filepath, "wb") as f:
                    f.write(image_data)

                self.send_json({"ok": True, "path": filepath})
            except Exception as e:
                self.send_json({"error": str(e)}, 500)
            return

        # ─── API: Inject Text to Session ───
        if path == "/api/inject":
            try:
                data = json.loads(body)
                session_name = data.get("session", "")
                text = data.get("text", "")

                if not session_name or not text:
                    self.send_json({"error": "session and text required"}, 400)
                    return

                # Send text to tmux session
                subprocess.run(
                    ["tmux", "send-keys", "-t", session_name, "-l", text],
                    capture_output=True
                )
                self.send_json({"ok": True})
            except Exception as e:
                self.send_json({"error": str(e)}, 500)
            return

        # ─── API: Send Key to Session (for special keys) ───
        if path == "/api/send-key":
            try:
                data = json.loads(body)
                session_name = data.get("session", "")
                key = data.get("key", "")

                if not session_name or not key:
                    self.send_json({"error": "session and key required"}, 400)
                    return

                # Send key to tmux session (without -l, interprets key names)
                subprocess.run(
                    ["tmux", "send-keys", "-t", session_name, key],
                    capture_output=True
                )
                self.send_json({"ok": True})
            except Exception as e:
                self.send_json({"error": str(e)}, 500)
            return

        # ─── 404 ───
        self.send_response(404)
        self.end_headers()


def cleanup(sig, frame):
    print("\nshutting down")
    exit(0)


def main():
    signal.signal(signal.SIGTERM, cleanup)
    signal.signal(signal.SIGINT, cleanup)

    _load_sessions()  # Load persisted auth sessions from disk
    load_templates()

    # Restore tmux sessions after reboot
    restored = sessions.restore_sessions()
    if restored:
        print(f"restored {restored} session(s) from last run")

    print(f"sandboxer http://127.0.0.1:{PORT}")
    server = http.server.HTTPServer(("127.0.0.1", PORT), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
