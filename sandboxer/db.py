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

            -- Cronjob tables
            CREATE TABLE IF NOT EXISTS cron_jobs (
                id TEXT PRIMARY KEY,        -- repo_name:cron_name
                repo_path TEXT NOT NULL,
                name TEXT NOT NULL,
                schedule TEXT NOT NULL,
                type TEXT NOT NULL,         -- claude | bash | loop
                prompt TEXT,
                command TEXT,
                condition TEXT,             -- Optional: script that must exit 0 for job to run
                enabled INTEGER DEFAULT 1,
                last_run TEXT,
                next_run TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS cron_executions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                cron_id TEXT NOT NULL,
                session_name TEXT,
                status TEXT,                -- started | completed | failed
                started_at TEXT,
                ended_at TEXT,
                FOREIGN KEY (cron_id) REFERENCES cron_jobs(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_cron_executions_cron ON cron_executions(cron_id);
            CREATE INDEX IF NOT EXISTS idx_cron_jobs_next_run ON cron_jobs(next_run);
        """)

        # Migration: add status column if missing
        try:
            conn.execute("ALTER TABLE messages ADD COLUMN status TEXT DEFAULT 'complete'")
        except:
            pass  # Column already exists

        # Migration: add condition column to cron_jobs if missing
        try:
            conn.execute("ALTER TABLE cron_jobs ADD COLUMN condition TEXT")
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


# ═══ Cron Operations ═══

def get_cron(cron_id: str) -> dict | None:
    """Get a cron job by ID."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM cron_jobs WHERE id = ?", (cron_id,)
        ).fetchone()
        return dict(row) if row else None


def get_all_crons() -> list[dict]:
    """Get all cron jobs."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM cron_jobs ORDER BY repo_path, name"
        ).fetchall()
        return [dict(row) for row in rows]


def get_enabled_crons() -> list[dict]:
    """Get all enabled cron jobs."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM cron_jobs WHERE enabled = 1 ORDER BY next_run"
        ).fetchall()
        return [dict(row) for row in rows]


def get_due_crons(now: str) -> list[dict]:
    """Get cron jobs that are due to run (next_run <= now and enabled)."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM cron_jobs WHERE enabled = 1 AND next_run IS NOT NULL AND next_run <= ?",
            (now,)
        ).fetchall()
        return [dict(row) for row in rows]


def upsert_cron(cron_id: str, repo_path: str, name: str, schedule: str,
                cron_type: str, prompt: str = None, command: str = None,
                condition: str = None, enabled: bool = True, next_run: str = None):
    """Insert or update a cron job."""
    with get_db() as conn:
        conn.execute("""
            INSERT INTO cron_jobs (id, repo_path, name, schedule, type, prompt, command, condition, enabled, next_run, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET
                repo_path = excluded.repo_path,
                name = excluded.name,
                schedule = excluded.schedule,
                type = excluded.type,
                prompt = COALESCE(excluded.prompt, cron_jobs.prompt),
                command = COALESCE(excluded.command, cron_jobs.command),
                condition = excluded.condition,
                enabled = excluded.enabled,
                next_run = excluded.next_run,
                updated_at = CURRENT_TIMESTAMP
        """, (cron_id, repo_path, name, schedule, cron_type, prompt, command, condition, 1 if enabled else 0, next_run))


def update_cron_field(cron_id: str, field: str, value):
    """Update a single field on a cron job."""
    allowed_fields = {'enabled', 'last_run', 'next_run', 'schedule', 'prompt', 'command'}
    if field not in allowed_fields:
        raise ValueError(f"Field {field} not allowed")

    with get_db() as conn:
        conn.execute(f"""
            UPDATE cron_jobs SET {field} = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        """, (value, cron_id))


def delete_cron(cron_id: str):
    """Delete a cron job and its executions."""
    with get_db() as conn:
        conn.execute("DELETE FROM cron_executions WHERE cron_id = ?", (cron_id,))
        conn.execute("DELETE FROM cron_jobs WHERE id = ?", (cron_id,))


def delete_crons_for_repo(repo_path: str):
    """Delete all cron jobs for a repo."""
    with get_db() as conn:
        conn.execute("DELETE FROM cron_executions WHERE cron_id IN (SELECT id FROM cron_jobs WHERE repo_path = ?)", (repo_path,))
        conn.execute("DELETE FROM cron_jobs WHERE repo_path = ?", (repo_path,))


def add_cron_execution(cron_id: str, session_name: str = None, status: str = "started") -> int:
    """Add a cron execution record. Returns the execution ID."""
    with get_db() as conn:
        cursor = conn.execute("""
            INSERT INTO cron_executions (cron_id, session_name, status, started_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        """, (cron_id, session_name, status))
        return cursor.lastrowid


def update_cron_execution(execution_id: int, status: str, ended_at: str = None):
    """Update a cron execution status."""
    with get_db() as conn:
        if ended_at:
            conn.execute(
                "UPDATE cron_executions SET status = ?, ended_at = ? WHERE id = ?",
                (status, ended_at, execution_id)
            )
        else:
            conn.execute(
                "UPDATE cron_executions SET status = ?, ended_at = CURRENT_TIMESTAMP WHERE id = ?",
                (status, execution_id)
            )


def get_cron_executions(cron_id: str, limit: int = 10) -> list[dict]:
    """Get recent executions for a cron job."""
    with get_db() as conn:
        rows = conn.execute("""
            SELECT * FROM cron_executions
            WHERE cron_id = ?
            ORDER BY started_at DESC
            LIMIT ?
        """, (cron_id, limit)).fetchall()
        return [dict(row) for row in rows]


def get_cron_ids_for_repo(repo_path: str) -> set[str]:
    """Get all cron IDs for a repo."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id FROM cron_jobs WHERE repo_path = ?", (repo_path,)
        ).fetchall()
        return {row['id'] for row in rows}


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
