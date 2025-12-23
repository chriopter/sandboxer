"""SQLite database for session and message persistence."""

import json
import os
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime

DB_PATH = "/etc/sandboxer/sandboxer.db"

# Thread-local storage for connections
_local = threading.local()


def _get_connection():
    """Get thread-local database connection."""
    if not hasattr(_local, "conn"):
        os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
        _local.conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        _local.conn.row_factory = sqlite3.Row
    return _local.conn


@contextmanager
def get_db():
    """Context manager for database operations."""
    conn = _get_connection()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def init_db():
    """Initialize database schema."""
    with get_db() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS sessions (
                name TEXT PRIMARY KEY,
                workdir TEXT NOT NULL,
                type TEXT NOT NULL,
                mode TEXT DEFAULT 'cli',
                title TEXT,
                claude_session_id TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_name TEXT NOT NULL,
                role TEXT NOT NULL,  -- 'user', 'assistant', 'system'
                content TEXT NOT NULL,
                status TEXT DEFAULT 'complete',  -- 'complete', 'thinking', 'streaming'
                metadata TEXT,  -- JSON for extra data (tool_use, etc.)
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (session_name) REFERENCES sessions(name) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_name);
            CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(session_name, created_at);
        """)

        # Migration: add status column if missing
        try:
            conn.execute("ALTER TABLE messages ADD COLUMN status TEXT DEFAULT 'complete'")
        except:
            pass  # Column already exists


# ═══ Session Operations ═══

def get_session(name: str) -> dict | None:
    """Get a session by name."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM sessions WHERE name = ?", (name,)
        ).fetchone()
        return dict(row) if row else None


def get_all_sessions() -> list[dict]:
    """Get all sessions."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM sessions ORDER BY updated_at DESC"
        ).fetchall()
        return [dict(row) for row in rows]


def get_chat_sessions() -> list[dict]:
    """Get all chat-type sessions."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM sessions WHERE type = 'chat' ORDER BY updated_at DESC"
        ).fetchall()
        return [dict(row) for row in rows]


def upsert_session(name: str, workdir: str, session_type: str,
                   mode: str = "cli", title: str = None,
                   claude_session_id: str = None):
    """Insert or update a session."""
    with get_db() as conn:
        conn.execute("""
            INSERT INTO sessions (name, workdir, type, mode, title, claude_session_id, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(name) DO UPDATE SET
                workdir = excluded.workdir,
                type = excluded.type,
                mode = excluded.mode,
                title = COALESCE(excluded.title, sessions.title),
                claude_session_id = COALESCE(excluded.claude_session_id, sessions.claude_session_id),
                updated_at = CURRENT_TIMESTAMP
        """, (name, workdir, session_type, mode, title, claude_session_id))


def update_session_field(name: str, field: str, value):
    """Update a single field on a session."""
    allowed_fields = {'mode', 'title', 'claude_session_id', 'workdir', 'type'}
    if field not in allowed_fields:
        raise ValueError(f"Field {field} not allowed")

    with get_db() as conn:
        conn.execute(f"""
            UPDATE sessions SET {field} = ?, updated_at = CURRENT_TIMESTAMP
            WHERE name = ?
        """, (value, name))


def delete_session(name: str):
    """Delete a session and its messages."""
    with get_db() as conn:
        conn.execute("DELETE FROM messages WHERE session_name = ?", (name,))
        conn.execute("DELETE FROM sessions WHERE name = ?", (name,))


# ═══ Message Operations ═══

def add_message(session_name: str, role: str, content: str, status: str = 'complete', metadata: dict = None) -> int:
    """Add a message to a session. Returns the message ID."""
    with get_db() as conn:
        cursor = conn.execute("""
            INSERT INTO messages (session_name, role, content, status, metadata)
            VALUES (?, ?, ?, ?, ?)
        """, (session_name, role, content, status, json.dumps(metadata) if metadata else None))

        # Update session timestamp
        conn.execute("""
            UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE name = ?
        """, (session_name,))

        return cursor.lastrowid


def update_message(message_id: int, content: str = None, status: str = None):
    """Update a message's content and/or status."""
    with get_db() as conn:
        if content is not None and status is not None:
            conn.execute("UPDATE messages SET content = ?, status = ? WHERE id = ?",
                        (content, status, message_id))
        elif content is not None:
            conn.execute("UPDATE messages SET content = ? WHERE id = ?",
                        (content, message_id))
        elif status is not None:
            conn.execute("UPDATE messages SET status = ? WHERE id = ?",
                        (status, message_id))


def get_messages(session_name: str, limit: int = 100, offset: int = 0) -> list[dict]:
    """Get messages for a session, most recent first when using offset."""
    with get_db() as conn:
        rows = conn.execute("""
            SELECT * FROM messages
            WHERE session_name = ?
            ORDER BY created_at ASC
            LIMIT ? OFFSET ?
        """, (session_name, limit, offset)).fetchall()

        messages = []
        for row in rows:
            msg = dict(row)
            if msg.get('metadata'):
                msg['metadata'] = json.loads(msg['metadata'])
            messages.append(msg)
        return messages


def get_message_count(session_name: str) -> int:
    """Get total message count for a session."""
    with get_db() as conn:
        row = conn.execute("""
            SELECT COUNT(*) as count FROM messages WHERE session_name = ?
        """, (session_name,)).fetchone()
        return row['count'] if row else 0


def get_messages_since(session_name: str, since_id: int) -> list[dict]:
    """Get messages for polling - new messages OR active OR the last seen (for status updates)."""
    with get_db() as conn:
        # Return:
        # - New messages (id > since_id)
        # - Active messages (status != 'complete') for real-time updates
        # - The last seen message (id = since_id) so client sees when it becomes complete
        rows = conn.execute("""
            SELECT * FROM messages
            WHERE session_name = ? AND (id >= ? OR status != 'complete')
            ORDER BY id ASC
        """, (session_name, since_id)).fetchall()

        messages = []
        for row in rows:
            msg = dict(row)
            if msg.get('metadata'):
                msg['metadata'] = json.loads(msg['metadata'])
            messages.append(msg)
        return messages


def get_latest_message_id(session_name: str) -> int:
    """Get the latest message ID for a session."""
    with get_db() as conn:
        row = conn.execute("""
            SELECT MAX(id) as max_id FROM messages WHERE session_name = ?
        """, (session_name,)).fetchone()
        return row['max_id'] or 0


def clear_messages(session_name: str):
    """Clear all messages for a session."""
    with get_db() as conn:
        conn.execute("DELETE FROM messages WHERE session_name = ?", (session_name,))


# ═══ Migration from JSON files ═══

def migrate_from_json():
    """Migrate existing session_meta.json to SQLite."""
    meta_file = "/etc/sandboxer/session_meta.json"
    if not os.path.isfile(meta_file):
        return

    try:
        with open(meta_file) as f:
            meta = json.load(f)

        for name, data in meta.items():
            upsert_session(
                name=name,
                workdir=data.get('workdir', '/home/sandboxer'),
                session_type=data.get('type', 'bash'),
                mode=data.get('mode', 'cli'),
                title=data.get('title'),
                claude_session_id=data.get('claude_session_id')
            )

        # Rename old file to mark as migrated
        os.rename(meta_file, meta_file + ".migrated")
        print(f"[db] Migrated {len(meta)} sessions from JSON to SQLite")
    except Exception as e:
        print(f"[db] Migration failed: {e}")


# Initialize on import
init_db()
migrate_from_json()
