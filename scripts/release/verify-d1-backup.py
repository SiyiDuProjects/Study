"""Restore a full user-table JSON export in memory without logging user data."""
import hashlib
import json
import pathlib
import sqlite3
import sys

backup = pathlib.Path(sys.argv[1])
migrations = pathlib.Path(sys.argv[2])
tables = json.loads(backup.read_text(encoding="utf-8"))["tables"]
expected = ["app_metadata", "courses", "sessions", "transcript_segments"]
assert sorted(tables) == sorted(expected), "Unexpected table set"
db = sqlite3.connect(":memory:")
db.execute("PRAGMA foreign_keys=ON")
for migration in sorted(migrations.glob("*.sql")):
    db.executescript(migration.read_text(encoding="utf-8"))
counts = {}
for name in expected:
    columns = tables[name]["columns"]
    actual = [row[1] for row in db.execute(f'PRAGMA table_info("{name}")')]
    assert set(columns) == set(actual), "Incomplete schema export"
    quoted = ",".join('"' + col.replace('"', '""') + '"' for col in columns)
    rows = tables[name]["rows"]
    assert all(set(row) == set(columns) for row in rows), "Incomplete row export"
    db.executemany(f'INSERT INTO "{name}" ({quoted}) VALUES ({",".join("?" for _ in columns)})',
                   [[row[col] for col in columns] for row in rows])
    restored = [dict(zip(columns, row)) for row in db.execute(f'SELECT {quoted} FROM "{name}"')]
    normalize = lambda values: sorted(json.dumps(row, sort_keys=True, ensure_ascii=False) for row in values)
    assert normalize(restored) == normalize(rows), "Restored rows differ"
    counts[name] = len(restored)
assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
assert not db.execute("PRAGMA foreign_key_check").fetchall()
print(json.dumps({"integrity": "ok", "counts": counts, "sha256": hashlib.sha256(backup.read_bytes()).hexdigest()}))
