"""
database.py

SQLite storage layer for the indoor mapping hackathon project.

Stores one row per "walk" (a single walkthrough session), with the raw
sensor readings and the processed dead-reckoning path both saved as JSON
blobs. Keeping raw readings lets you re-run your step-detection /
dead-reckoning logic later without re-collecting data.

Usage:
    from database import Database

    db = Database()  # creates indoor_map.db in the current directory
    db.init_schema()

    walk_id = db.create_walk(floor=1, raw_readings=[...])
    db.set_processed_path(walk_id, [{"x": 0.0, "y": 0.0}, {"x": 0.7, "y": 0.1}])

    walk = db.get_walk(walk_id)
    all_walks = db.get_all_walks()
    floor1_walks = db.get_walks_by_floor(1)
"""

import sqlite3
import json
import time
from contextlib import contextmanager


DB_PATH = "indoor_map.db"


class Database:
    def __init__(self, db_path: str = DB_PATH):
        self.db_path = db_path

    @contextmanager
    def _connect(self):
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    def init_schema(self):
        """Create tables if they don't exist yet. Safe to call every startup."""
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS walks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    floor INTEGER NOT NULL,
                    start_time REAL NOT NULL,
                    end_time REAL,
                    raw_readings TEXT NOT NULL,      -- JSON array of sensor readings
                    processed_path TEXT,             -- JSON array of {x, y} points, filled in later
                    created_at REAL NOT NULL
                )
                """
            )
            # Speeds up "give me all walks on floor N" queries as data grows
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_walks_floor ON walks(floor)"
            )

    # ---------- writes ----------

    def create_walk(self, floor: int, raw_readings: list, start_time: float = None) -> int:
        """
        Insert a new walk. raw_readings is a list of dicts, e.g.:
            {"t": 1699999999123, "type": "gps", "lat": 40.44, "lon": -79.99}
            {"t": 1699999999500, "type": "accel", "x": 0.1, "y": 9.8, "z": 0.3}
        Returns the new walk's id.
        """
        start_time = start_time if start_time is not None else time.time()
        with self._connect() as conn:
            cur = conn.execute(
                """
                INSERT INTO walks (floor, start_time, raw_readings, created_at)
                VALUES (?, ?, ?, ?)
                """,
                (floor, start_time, json.dumps(raw_readings), time.time()),
            )
            return cur.lastrowid

    def set_processed_path(self, walk_id: int, path: list, end_time: float = None):
        """
        Attach the dead-reckoning output to a walk once you've computed it.
        path is a list of dicts like {"x": 0.0, "y": 0.0}.
        """
        end_time = end_time if end_time is not None else time.time()
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE walks
                SET processed_path = ?, end_time = ?
                WHERE id = ?
                """,
                (json.dumps(path), end_time, walk_id),
            )

    def append_readings(self, walk_id: int, new_readings: list):
        """
        Append more raw readings to an in-progress walk (useful if you're
        streaming sensor data live rather than uploading it all at once).
        """
        with self._connect() as conn:
            row = conn.execute(
                "SELECT raw_readings FROM walks WHERE id = ?", (walk_id,)
            ).fetchone()
            if row is None:
                raise ValueError(f"No walk with id {walk_id}")
            existing = json.loads(row["raw_readings"])
            existing.extend(new_readings)
            conn.execute(
                "UPDATE walks SET raw_readings = ? WHERE id = ?",
                (json.dumps(existing), walk_id),
            )

    # ---------- reads ----------

    def get_walk(self, walk_id: int) -> dict:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM walks WHERE id = ?", (walk_id,)
            ).fetchone()
            return self._row_to_dict(row) if row else None

    def get_all_walks(self) -> list:
        with self._connect() as conn:
            rows = conn.execute("SELECT * FROM walks ORDER BY id").fetchall()
            return [self._row_to_dict(r) for r in rows]

    def get_walks_by_floor(self, floor: int) -> list:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM walks WHERE floor = ? ORDER BY id", (floor,)
            ).fetchall()
            return [self._row_to_dict(r) for r in rows]

    def get_all_processed_paths_by_floor(self, floor: int) -> list:
        """
        Convenience method for the heatmap step: returns just the processed
        (x, y) paths for a floor, skipping walks that haven't been processed yet.
        """
        walks = self.get_walks_by_floor(floor)
        return [w["processed_path"] for w in walks if w["processed_path"]]

    # ---------- helpers ----------

    @staticmethod
    def _row_to_dict(row: sqlite3.Row) -> dict:
        d = dict(row)
        d["raw_readings"] = json.loads(d["raw_readings"])
        d["processed_path"] = json.loads(d["processed_path"]) if d["processed_path"] else None
        return d


if __name__ == "__main__":
    # Quick smoke test — run `python database.py` to sanity-check the schema.
    db = Database()
    db.init_schema()

    walk_id = db.create_walk(
        floor=1,
        raw_readings=[
            {"t": 1699999999123, "type": "gps", "lat": 40.44, "lon": -79.99},
            {"t": 1699999999500, "type": "accel", "x": 0.1, "y": 9.8, "z": 0.3},
        ],
    )
    print(f"Created walk {walk_id}")

    db.set_processed_path(walk_id, [{"x": 0.0, "y": 0.0}, {"x": 0.7, "y": 0.1}])

    print(db.get_walk(walk_id))
    print(f"Total walks: {len(db.get_all_walks())}")
