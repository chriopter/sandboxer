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
from . import chat
from . import db

# Restore chat sessions from database
chat.restore_chat_sessions()

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


def build_single_card(s: dict, mode: str = "cli") -> str:
    display_name = s.get("title") or s["name"]
    workdir = s.get("workdir") or ""
    port = sessions.get_ttyd_port(s["name"])
    terminal_url = f"/t/{port}/" if port else ""
    session_mode = sessions.get_session_mode(s["name"]) or mode
    terminal_display = "none" if session_mode == "chat" else "block"
    chat_display = "flex" if session_mode == "chat" else "none"
    toggle_label = "cli" if session_mode == "chat" else "chat"

    ssh_display = "none" if session_mode == "chat" else "inline-block"
    return f"""<article class="card" draggable="true" data-session="{escape(s['name'])}" data-workdir="{escape(workdir)}" data-mode="{session_mode}">
  <header>
    <span class="card-title" onclick="renameSession('{escape(s['name'])}')">{escape(display_name)}</span>
    <div class="card-actions">
      <button size-="small" variant-="mauve" class="toggle-mode-btn" onclick="event.stopPropagation(); toggleMode('{escape(s['name'])}')">{toggle_label}</button>
      <button size-="small" variant-="teal" class="ssh-btn" style="display: {ssh_display}" onclick="event.stopPropagation(); copySSH('{escape(s['name'])}')">ssh</button>
      <button size-="small" class="img-btn" onclick="event.stopPropagation(); triggerImageUpload('{escape(s['name'])}')" ondblclick="event.stopPropagation(); triggerImageBrowse('{escape(s['name'])}')">↑</button>
      <input type="file" class="card-image-input" accept="image/*" style="display:none" data-session="{escape(s['name'])}">
      <button size-="small" class="fullscreen-header-btn" onclick="event.stopPropagation(); openFullscreen('{escape(s['name'])}')">⧉</button>
      <button size-="small" variant-="red" class="kill-btn" onclick="event.stopPropagation(); killSession(this, '{escape(s['name'])}')">×</button>
    </div>
  </header>
  <div class="terminal" style="display: {terminal_display}">
    <iframe src="{terminal_url}" scrolling="no" sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock"></iframe>
  </div>
  <div class="chat" style="display: {chat_display}">
    <div class="chat-messages"></div>
    <div class="chat-status paused"><span is-="spinner" variant-="dots"></span><span class="status-text">idle</span></div>
    <div class="chat-input">
      <input type="text" placeholder="Message..." onkeydown="if(event.key==='Enter'){{sendChat('{escape(s['name'])}')}}">
      <button size-="small" variant-="green" onclick="sendChat('{escape(s['name'])}')">send</button>
    </div>
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


def build_dir_options(selected_folder: str | None = None) -> str:
    """Build HTML buttons for directory dropdown."""
    dirs = sessions.get_directories()
    selected = selected_folder or get_selected_folder()
    buttons = []
    for d in dirs:
        name = d.split("/")[-1] if d != "/" else "/"
        aria = "true" if d == selected else "false"
        buttons.append(f'<button data-value="{escape(d)}" size-="small" aria-selected="{aria}">{escape(name)}</button>')
    return "\n          ".join(buttons)


def get_folder_display_name(folder: str, max_len: int = 10) -> str:
    """Get display name for a folder path, truncated if needed."""
    if folder == "/":
        return "/"
    name = folder.split("/")[-1] or folder
    if len(name) > max_len:
        return name[:max_len-1] + "…"
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

        folder_from_url = None
        if path == "/":
            folder_from_url = None
        elif path.startswith("/") and "/" not in path[1:]:
            folder_name = path[1:]
            folder_from_url = folder_name_to_path(folder_name)

        if path == "/" or folder_from_url is not None:
            selected_folder = folder_from_url or get_selected_folder()
            all_sessions = sessions.get_all_sessions()
            ordered = sessions.get_ordered_sessions(all_sessions)
            for s in ordered:
                if sessions.get_session_mode(s["name"]) != "chat":
                    sessions.start_ttyd(s["name"])
            html = render_template(
                "index.html",
                cards=build_session_cards(ordered),
                dir_options=build_dir_options(selected_folder),
                selected_folder=selected_folder,
                selected_folder_name=get_folder_display_name(selected_folder),
                system_prompt_path=sessions.SYSTEM_PROMPT_PATH,
            )
            self.send_html(html)
            return

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

        if path == "/chat":
            session_name = query.get("session", [""])[0]
            if session_name:
                # Initialize chat session if needed
                meta = sessions.session_meta.get(session_name, {})
                if not chat.is_chat_session(session_name):
                    workdir = meta.get("workdir", "/home/sandboxer")
                    session_id = meta.get("claude_session_id", "")
                    chat.init_chat_session(session_name, workdir, session_id)
                    sessions.set_session_mode(session_name, "chat")
                # Use title from metadata if available
                display_title = meta.get("title") or session_name
                html = render_template(
                    "chat.html",
                    session_name=escape(session_name),
                    session_title=escape(display_title),
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
            if session_type == "chat":
                chat.init_chat_session(name, workdir, resume_id)
                s = {"name": name, "title": name, "workdir": workdir, "type": "chat"}
                card_html = build_single_card(s, mode="chat")
            else:
                sessions.start_ttyd(name)
                s = {"name": name, "title": name, "workdir": workdir}
                card_html = build_single_card(s, mode="cli")
            self.send_json({"ok": True, "name": name, "html": card_html, "mode": "chat" if session_type == "chat" else "cli"})
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

        # /api/chat-stream is deprecated - use /api/chat-send POST which returns SSE
        if path == "/api/chat-stream":
            self.send_json({"error": "Deprecated. Use POST /api/chat-send instead."}, 410)
            return

        # GET /api/chat-history - Get message history from database
        if path == "/api/chat-history":
            session_name = query.get("session", [""])[0]
            limit = int(query.get("limit", ["100"])[0])
            offset = int(query.get("offset", ["0"])[0])

            if not session_name:
                self.send_json({"error": "session required"}, 400)
                return

            messages = chat.get_history(session_name, limit=limit, offset=offset)
            self.send_json({"messages": messages, "count": len(messages)})
            return

        # GET /api/chat-poll - Poll for new messages (simple sync)
        if path == "/api/chat-poll":
            session_name = query.get("session", [""])[0]
            since_id = int(query.get("since", ["0"])[0])

            if not session_name:
                self.send_json({"error": "session required"}, 400)
                return

            messages = db.get_messages_since(session_name, since_id)
            latest_id = db.get_latest_message_id(session_name)
            # Status (thinking/streaming/complete) is now in each message
            self.send_json({
                "messages": messages,
                "latest_id": latest_id
            })
            return

        # SSE endpoint for syncing chat across tabs
        if path == "/api/chat-sync":
            session_name = query.get("session", [""])[0]
            if not session_name:
                self.send_json({"error": "session required"}, 400)
                return

            # Send SSE headers
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()

            # Send history first on connection
            try:
                history = chat.get_history(session_name, limit=100)
                for msg in history:
                    event = {
                        "type": f"{msg['role']}_message",
                        "content": msg['content'],
                        "timestamp": msg.get('created_at')
                    }
                    self.wfile.write(f"data: {json.dumps(event)}\n\n".encode())
                self.wfile.flush()
            except Exception as e:
                print(f"[chat-sync] History error: {e}")

            # Subscribe to live updates
            q = chat.add_subscriber(session_name)
            try:
                while True:
                    try:
                        msg = q.get(timeout=30)  # 30s heartbeat
                        self.wfile.write(f"data: {json.dumps(msg)}\n\n".encode())
                        self.wfile.flush()
                    except Exception:
                        # Send heartbeat
                        self.wfile.write(b": heartbeat\n\n")
                        self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                chat.remove_subscriber(session_name, q)
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
                image_b64 = data.get("image", "")
                orig_filename = data.get("filename", "")
                # Always generate unique filename with timestamp + uuid
                ext = ".png"
                if orig_filename:
                    _, ext = os.path.splitext(orig_filename)
                    if not ext:
                        ext = ".png"
                unique_name = f"img_{int(time.time())}_{uuid.uuid4().hex[:6]}{ext}"
                filepath = os.path.join(UPLOADS_DIR, unique_name)
                image_data = base64.b64decode(image_b64)
                with open(filepath, "wb") as f:
                    f.write(image_data)
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

        if path == "/api/chat-send":
            try:
                data = json.loads(body)
                session_name = data.get("session", "")
                message = data.get("message", "")
                if not session_name or not message:
                    self.send_json({"error": "session and message required"}, 400)
                    return

                # Get session metadata from database
                session_data = db.get_session(session_name)
                if session_data:
                    workdir = session_data.get("workdir", "/home/sandboxer")
                    session_id = session_data.get("claude_session_id") or ""
                else:
                    # Fallback to legacy session_meta
                    meta = sessions.session_meta.get(session_name, {})
                    workdir = meta.get("workdir", "/home/sandboxer")
                    session_id = meta.get("claude_session_id", "")

                # Initialize chat session if needed
                if not chat.is_chat_session(session_name):
                    chat.init_chat_session(session_name, workdir, session_id)

                # Store first message as title (KISS solution for chat titles)
                title_update = None
                current_title = session_data.get("title") if session_data else None
                if not current_title:
                    title = message[:40].strip()
                    if len(message) > 40:
                        title += "..."
                    db.update_session_field(session_name, 'title', title)
                    title_update = title

                # Get response generator (also creates thinking message in DB)
                response_gen, get_session_id = chat.send_message(
                    session_name, message, workdir, session_id
                )

                # Stream response as SSE
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "keep-alive")
                self.send_header("X-Accel-Buffering", "no")
                self.end_headers()

                try:
                    # Send title update if this was the first message
                    if title_update:
                        title_event = {"type": "title_update", "title": title_update}
                        self.wfile.write(f"data: {json.dumps(title_event)}\n\n".encode())
                        self.wfile.flush()
                        chat.broadcast_message(session_name, title_event)

                    # Broadcast user message to all subscribers
                    chat.broadcast_message(session_name, {
                        "type": "user_message",
                        "content": message
                    })

                    # Stream ALL events to sender AND broadcast to other subscribers
                    for line in response_gen:
                        if line:
                            # Send to the client making the request
                            self.wfile.write(f"data: {line}\n\n".encode())
                            self.wfile.flush()

                            # Broadcast same event to all other subscribers (live sync)
                            try:
                                event = json.loads(line)
                                chat.broadcast_message(session_name, event)
                            except json.JSONDecodeError:
                                pass

                    self.wfile.write(b"event: end\ndata: {}\n\n")
                    self.wfile.flush()

                    # Update session metadata with new session_id
                    new_session_id = get_session_id()
                    if new_session_id and session_name in sessions.session_meta:
                        sessions.session_meta[session_name]["claude_session_id"] = new_session_id
                        sessions._save_session_meta()
                except (BrokenPipeError, ConnectionResetError):
                    pass
            except Exception as e:
                self.send_json({"error": str(e)}, 500)
            return

        if path == "/api/chat-toggle":
            try:
                data = json.loads(body)
                session_name = data.get("session", "")
                target_mode = data.get("target_mode", "")
                if not session_name or target_mode not in ("cli", "chat"):
                    self.send_json({"error": "session and target_mode (cli/chat) required"}, 400)
                    return
                meta = sessions.session_meta.get(session_name, {})
                workdir = meta.get("workdir", "/home/sandboxer")
                claude_session_id = meta.get("claude_session_id", "")

                if target_mode == "cli":
                    # Stop chat session if active
                    session_id = chat.stop_chat_session(session_name) or claude_session_id

                    # Kill existing tmux session and create fresh one (clean slate)
                    subprocess.run(["tmux", "kill-session", "-t", session_name], capture_output=True)
                    subprocess.run(["tmux", "new-session", "-d", "-s", session_name, "-c", workdir], capture_output=True)
                    subprocess.run(["tmux", "set", "-t", session_name, "mouse", "on"], capture_output=True)

                    # Resume Claude in terminal if we have a session_id
                    if session_id:
                        cmd = f"IS_SANDBOX=1 claude --dangerously-skip-permissions --resume {session_id} --system-prompt {sessions.SYSTEM_PROMPT_PATH}"
                        subprocess.run(["tmux", "send-keys", "-t", session_name, cmd, "Enter"], capture_output=True)

                    port = sessions.start_ttyd(session_name)
                    sessions.set_session_mode(session_name, "cli")
                    self.send_json({"ok": True, "mode": "cli", "port": port, "terminal_url": f"/t/{port}/"})
                else:
                    # Switch to chat mode - capture CLI context first
                    sessions.stop_ttyd(session_name)
                    subprocess.run(["tmux", "send-keys", "-t", session_name, "C-c"], capture_output=True)
                    time.sleep(0.3)

                    # Capture recent tmux scrollback for context (last 50 lines)
                    capture_result = subprocess.run(
                        ["tmux", "capture-pane", "-t", session_name, "-p", "-S", "-50"],
                        capture_output=True, text=True
                    )
                    cli_context = capture_result.stdout.strip() if capture_result.returncode == 0 else ""

                    # Initialize chat session
                    chat.init_chat_session(session_name, workdir, claude_session_id)
                    sessions.set_session_mode(session_name, "chat")

                    # Add CLI context as a message so user sees what was happening
                    if cli_context and len(cli_context.strip()) > 10:
                        # Truncate if too long, keep last part (most recent)
                        if len(cli_context) > 2000:
                            cli_context = "...\n" + cli_context[-2000:]
                        db.add_message(session_name, 'system', f'[Switched from CLI - terminal context below]\n{cli_context}', 'complete')
                    else:
                        db.add_message(session_name, 'system', '[Switched from CLI mode - conversation history preserved via session]', 'complete')

                    self.send_json({"ok": True, "mode": "chat"})
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
