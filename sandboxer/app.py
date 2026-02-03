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
from . import crons

PORT = 8081
REPO_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Paths
APP_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(APP_DIR, "static")
TEMPLATES_DIR = os.path.join(APP_DIR, "templates")
UPLOADS_DIR = "/tmp/sandboxer_uploads"
PASSWORD_FILE = "/etc/sandboxer/password"
SESSIONS_FILE = "/etc/sandboxer/sessions.json"

# Session duration: 30 days in seconds
SESSION_DURATION = 30 * 24 * 60 * 60

# Ensure uploads directory exists
os.makedirs(UPLOADS_DIR, exist_ok=True)
os.makedirs(os.path.dirname(SESSIONS_FILE), exist_ok=True)

# Session storage: {token: expiry_timestamp}
_auth_sessions: dict[str, float] = {}

# Stats cache - avoid recalculating on every request (stale-while-revalidate)
_stats_cache = {"data": None, "expires": 0, "refreshing": False}
_stats_lock = threading.Lock()

# Version cache (computed once at startup)
_version = None


def get_version() -> str:
    """Get version from git describe."""
    global _version
    if _version is None:
        try:
            result = subprocess.run(
                ["git", "describe", "--tags", "--always"],
                cwd=REPO_DIR, capture_output=True, text=True
            )
            _version = result.stdout.strip() if result.returncode == 0 else "dev"
        except Exception:
            _version = "dev"
    return _version


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
    """Default folder when no URL path specified."""
    return "/home/sandboxer/git/sandboxer"


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
    is_chat = s.get("mode") == "chat" or s.get("type") == "chat"

    if is_chat:
        # Chat session card - show chat preview instead of terminal
        messages = db.get_messages(s["name"], limit=3)
        preview_html = ""
        if messages:
            for msg in messages[-3:]:
                role = msg.get("role", "user")
                content = escape(msg.get("content", "")[:100])
                if len(msg.get("content", "")) > 100:
                    content += "..."
                preview_html += f'<div class="chat-preview-msg {role}">{content}</div>'
        else:
            preview_html = '<div class="chat-preview-empty">Start a conversation</div>'

        return f"""<article class="card card-chat" draggable="true" data-session="{escape(s['name'])}" data-workdir="{escape(workdir)}" data-type="chat">
  <header>
    <span class="card-title" onclick="renameSession('{escape(s['name'])}')">{escape(display_name)}</span>
    <div class="card-actions">
      <button class="fullscreen-header-btn" onclick="event.stopPropagation(); openChat('{escape(s['name'])}')">&#9671;</button>
      <button class="btn-red kill-btn" onclick="event.stopPropagation(); killSession(this, '{escape(s['name'])}')">×</button>
    </div>
  </header>
  <div class="chat-preview" onclick="openChat('{escape(s['name'])}')">
    {preview_html}
  </div>
</article>"""
    else:
        # Terminal session card - start ttyd if not running
        port = sessions.start_ttyd(s["name"])
        terminal_url = f"/t/{port}/" if port else ""

        session_type = s.get("type", "")
        return f"""<article class="card" draggable="true" data-session="{escape(s['name'])}" data-workdir="{escape(workdir)}" data-type="{escape(session_type)}">
  <header>
    <span class="card-title" onclick="renameSession('{escape(s['name'])}')">{escape(display_name)}</span>
    <div class="card-actions">
      <button class="btn-teal ssh-btn" onclick="event.stopPropagation(); copySSH('{escape(s['name'])}')">ssh</button>
      <button class="img-btn" onclick="event.stopPropagation(); triggerImageUpload('{escape(s['name'])}')" ondblclick="event.stopPropagation(); triggerImageBrowse('{escape(s['name'])}')">↑</button>
      <input type="file" class="card-image-input" multiple style="display:none" data-session="{escape(s['name'])}">
      <button class="fullscreen-header-btn" onclick="event.stopPropagation(); openFullscreen('{escape(s['name'])}')">⧉</button>
      <button class="btn-red kill-btn" onclick="event.stopPropagation(); killSession(this, '{escape(s['name'])}')">×</button>
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


def folder_name_to_path(name: str) -> str | None:
    if name in ("/", "root"):
        return "/"
    dirs = sessions.get_directories()
    for d in dirs:
        if d.rstrip("/").split("/")[-1] == name:
            return d
    return None


def path_to_folder_name(path: str) -> str:
    if path == "/":
        return "root"
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

        if not path.startswith("/static/") and not self.is_authenticated():
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

        # Parse path: /{folder}/terminal/{session}, /{folder}/chat/{session}, /{folder}, /
        parts = [p for p in path.split("/") if p]

        # /{folder}/terminal/{session}
        if len(parts) == 3 and parts[1] == "terminal":
            session_name = urllib.parse.unquote(parts[2])
            session_info = db.get_session(session_name)
            if session_info and session_info.get("mode") == "chat":
                self.send_redirect(f"/{parts[0]}/chat/{parts[2]}")
                return
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

        # /{folder}/chat/{session}
        if len(parts) == 3 and parts[1] == "chat":
            session_name = urllib.parse.unquote(parts[2])
            session_info = db.get_session(session_name)
            title = session_info.get("title") if session_info else None
            workdir = session_info.get("workdir") if session_info else "/home/sandboxer"
            html = render_template(
                "chat.html",
                session_name=escape(session_name),
                session_title=escape(title or session_name),
                workdir=escape(workdir or "/home/sandboxer"),
            )
            self.send_html(html)
            return

        # /{folder}/cron/{cron_id} - cron viewer
        if len(parts) == 3 and parts[1] == "cron":
            cron_id = urllib.parse.unquote(parts[2])
            cron = db.get_cron(cron_id)
            if cron:
                html = render_template(
                    "cron.html",
                    cron_id=escape(cron_id),
                    cron_name=escape(cron['name']),
                    repo_path=escape(cron['repo_path']),
                )
                self.send_html(html)
                return
            self.send_response(404)
            self.end_headers()
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

            if session_type == "chat":
                # Chat session - no tmux/ttyd needed
                sessions.create_chat_session(name, workdir)
                s = {"name": name, "title": name, "workdir": workdir, "type": "chat", "mode": "chat"}
            else:
                # Terminal session - create tmux session and start ttyd
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
            # Use cached stats with stale-while-revalidate pattern
            now = time.time()
            should_refresh = False
            stale_data = None

            with _stats_lock:
                if _stats_cache["data"]:
                    if _stats_cache["expires"] > now:
                        # Fresh - return immediately
                        self.send_json(_stats_cache["data"])
                        return
                    elif _stats_cache["refreshing"]:
                        # Stale but another thread is refreshing - return stale
                        self.send_json(_stats_cache["data"])
                        return
                    else:
                        # Stale, we'll refresh
                        _stats_cache["refreshing"] = True
                        stale_data = _stats_cache["data"]
                        should_refresh = True
                else:
                    should_refresh = True

            if should_refresh:
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
                    stats = {"cpu": cpu_pct, "mem": mem_pct, "disk": disk_pct, "version": get_version()}

                    with _stats_lock:
                        _stats_cache["data"] = stats
                        _stats_cache["expires"] = now + 5  # 5 second TTL (single-user)
                        _stats_cache["refreshing"] = False

                    self.send_json(stats)
                except Exception:
                    with _stats_lock:
                        _stats_cache["refreshing"] = False
                    if stale_data:
                        self.send_json(stale_data)
                    else:
                        self.send_json({"cpu": 0, "mem": 0, "disk": 0})
            return

        if path == "/api/chat/messages":
            session_name = query.get("session", [""])[0]
            if not session_name:
                self.send_json({"error": "session required"}, 400)
                return
            messages = db.get_messages(session_name)
            self.send_json({"messages": messages})
            return

        if path == "/api/chat/poll":
            session_name = query.get("session", [""])[0]
            since = int(query.get("since", ["0"])[0])
            if not session_name:
                self.send_json({"error": "session required"}, 400)
                return
            messages = db.get_messages_since(session_name, since)
            self.send_json({"messages": messages})
            return

        if path == "/api/crons":
            cron_list = crons.get_crons_for_ui()
            self.send_json({"crons": cron_list})
            return

        # /api/crons/{id}/log - get cron log content
        if path.startswith("/api/crons/") and path.endswith("/log"):
            cron_id = urllib.parse.unquote(path[11:-4])  # Extract ID from /api/crons/{id}/log
            log_content = crons.get_cron_log(cron_id)
            self.send_json({"log": log_content})
            return

        # /api/crons/{id}/config - get cron config content
        if path.startswith("/api/crons/") and path.endswith("/config"):
            cron_id = urllib.parse.unquote(path[11:-7])  # Extract ID from /api/crons/{id}/config
            config_content = crons.get_cron_config(cron_id)
            self.send_json({"config": config_content})
            return

        # /api/crons/{id}/edit - open config in nano
        if path.startswith("/api/crons/") and path.endswith("/edit"):
            cron_id = urllib.parse.unquote(path[11:-5])  # Extract ID from /api/crons/{id}/edit
            config_path = crons.get_cron_config_path(cron_id)
            if config_path:
                cron = db.get_cron(cron_id)
                repo_path = cron['repo_path'] if cron else "/home/sandboxer"
                # Create bash session with nano
                name = sessions.generate_session_name("bash", repo_path)
                sessions.create_session(name, "bash", repo_path)
                # Send nano command
                import subprocess
                subprocess.run(["tmux", "send-keys", "-t", name, f"nano {config_path}", "Enter"], capture_output=True)
                sessions.start_ttyd(name)
                # Redirect to terminal
                folder = repo_path.split("/")[-1] if repo_path != "/" else "root"
                self.send_redirect(f"/{folder}/terminal/{urllib.parse.quote(name)}")
            else:
                self.send_json({"error": "Cron not found"}, 404)
            return

        if path == "/api/directories":
            dirs = sessions.get_directories()
            self.send_json({"directories": dirs})
            return

        # / or /{folder} - dashboard (must be last to not catch /kill, /create, etc.)
        if len(parts) <= 1:
            folder = folder_name_to_path(parts[0]) if parts else None
            all_sessions = sessions.get_all_sessions()
            ordered = sessions.get_ordered_sessions(all_sessions)
            selected = folder or get_selected_folder()
            dirs = sessions.get_directories()
            cards_html = build_session_cards(ordered)
            html = render_template(
                "index.html",
                cards=cards_html,
                directories="\n".join(
                    f'<option value="{escape(d)}"{"selected" if d == selected else ""}>'
                    f'{escape(d.split("/")[-1] or "/")}</option>'
                    for d in dirs
                ),
                version=get_version(),
            )
            self.send_html(html)
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

        if path == "/api/chat/send":
            try:
                data = json.loads(body)
                session_name = data.get("session", "")
                message = data.get("message", "")
                if not session_name or not message:
                    self.send_json({"error": "session and message required"}, 400)
                    return

                # Get session info
                session_info = db.get_session(session_name)
                if not session_info:
                    self.send_json({"error": "session not found"}, 404)
                    return

                workdir = session_info.get("workdir", "/home/sandboxer")
                claude_session_id = session_info.get("claude_session_id")

                # Add user message to database
                db.add_message(session_name, "user", message)

                # Create assistant message placeholder
                assistant_msg_id = db.add_message(session_name, "assistant", "", status="thinking")

                # Start background thread to run claude CLI
                def run_claude():
                    try:
                        # Build command - use full path since systemd doesn't have user PATH
                        claude_path = "/root/.local/bin/claude"
                        cmd = [
                            claude_path,
                            "-p",  # Print mode (non-interactive)
                            "--output-format", "json",
                            "--dangerously-skip-permissions",
                        ]

                        # Resume existing session if we have one
                        if claude_session_id:
                            cmd.extend(["--resume", claude_session_id])

                        # Add system prompt
                        system_prompt_path = sessions.SYSTEM_PROMPT_PATH
                        if os.path.isfile(system_prompt_path):
                            cmd.extend(["--system-prompt", system_prompt_path])

                        # Add the message as argument
                        cmd.append(message)

                        # Run claude
                        result = subprocess.run(
                            cmd,
                            capture_output=True,
                            text=True,
                            cwd=workdir,
                            timeout=300,  # 5 minute timeout
                            env={**os.environ, "IS_SANDBOX": "1"}
                        )

                        # Parse JSON response
                        response_text = ""
                        new_session_id = claude_session_id

                        if result.stdout:
                            try:
                                # Claude outputs one JSON object per line
                                for line in result.stdout.strip().split("\n"):
                                    if not line.strip():
                                        continue
                                    try:
                                        data = json.loads(line)
                                        # Extract session_id
                                        if "session_id" in data:
                                            new_session_id = data["session_id"]
                                        elif "sessionId" in data:
                                            new_session_id = data["sessionId"]
                                        # Extract text content
                                        if data.get("type") == "assistant":
                                            msg_content = data.get("message", {}).get("content", [])
                                            for item in msg_content:
                                                if item.get("type") == "text":
                                                    response_text += item.get("text", "")
                                        elif data.get("type") == "result":
                                            if "result" in data:
                                                response_text = data["result"]
                                    except json.JSONDecodeError:
                                        continue
                            except Exception as e:
                                response_text = f"Error parsing response: {e}\n\nRaw output:\n{result.stdout[:1000]}"

                        if not response_text and result.stderr:
                            response_text = f"Error: {result.stderr[:1000]}"

                        if not response_text:
                            response_text = "(No response from Claude)"

                        # Update assistant message
                        db.update_message(assistant_msg_id, content=response_text, status="complete")

                        # Save session_id if changed
                        if new_session_id and new_session_id != claude_session_id:
                            db.update_session_field(session_name, "claude_session_id", new_session_id)

                    except subprocess.TimeoutExpired:
                        db.update_message(assistant_msg_id, content="Error: Request timed out (5 minutes)", status="complete")
                    except Exception as e:
                        db.update_message(assistant_msg_id, content=f"Error: {str(e)}", status="complete")

                # Start claude in background
                thread = threading.Thread(target=run_claude, daemon=True)
                thread.start()

                self.send_json({"ok": True, "message_id": assistant_msg_id})
            except Exception as e:
                self.send_json({"error": str(e)}, 500)
            return

        if path == "/api/chat/clear":
            try:
                data = json.loads(body)
                session_name = data.get("session", "")
                if not session_name:
                    self.send_json({"error": "session required"}, 400)
                    return
                db.clear_messages(session_name)
                # Also clear the claude session ID to start fresh
                db.update_session_field(session_name, "claude_session_id", None)
                self.send_json({"ok": True})
            except Exception as e:
                self.send_json({"error": str(e)}, 500)
            return

        if path.startswith("/api/crons/") and path.endswith("/trigger"):
            cron_id = path[11:-8]  # Extract ID from /api/crons/{id}/trigger
            cron_id = urllib.parse.unquote(cron_id)
            success, message = crons.trigger_cron(cron_id)
            if success:
                self.send_json({"ok": True, "message": message})
            else:
                self.send_json({"error": message}, 404)
            return

        if path.startswith("/api/crons/") and path.endswith("/toggle"):
            cron_id = path[11:-7]  # Extract ID from /api/crons/{id}/toggle
            cron_id = urllib.parse.unquote(cron_id)
            success, message, new_state = crons.toggle_cron(cron_id)
            if success:
                self.send_json({"ok": True, "message": message, "enabled": new_state})
            else:
                self.send_json({"error": message}, 404)
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

    # Start cron scheduler
    crons.start_scheduler()

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
