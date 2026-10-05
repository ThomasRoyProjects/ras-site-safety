PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('framer', 'admin')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1))
) STRICT;

CREATE TABLE IF NOT EXISTS sites (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(trim(name)) > 0)
) STRICT;

CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY,
    worker_id INTEGER NOT NULL REFERENCES users(id),
    site_id INTEGER NOT NULL REFERENCES sites(id),
    work_date TEXT NOT NULL CHECK (work_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    hard_hat INTEGER NOT NULL CHECK (hard_hat IN (0, 1)),
    high_visibility_vest INTEGER NOT NULL CHECK (high_visibility_vest IN (0, 1)),
    safety_boots INTEGER NOT NULL CHECK (safety_boots IN (0, 1)),
    eye_protection INTEGER NOT NULL CHECK (eye_protection IN (0, 1)),
    fall_protection INTEGER NOT NULL CHECK (fall_protection IN (0, 1)),
    ladders_scaffolds_inspected INTEGER NOT NULL CHECK (ladders_scaffolds_inspected IN (0, 1)),
    tools_cords_checked INTEGER NOT NULL CHECK (tools_cords_checked IN (0, 1)),
    hazards_identified INTEGER NOT NULL CHECK (hazards_identified IN (0, 1)),
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (worker_id, site_id, work_date)
) STRICT;

CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY,
    submission_id INTEGER NOT NULL REFERENCES submissions(id),
    mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
    size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760)
) STRICT;

CREATE TABLE IF NOT EXISTS photo_chunks (
    photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
    bytes BLOB NOT NULL CHECK (length(bytes) BETWEEN 1 AND 1048576),
    PRIMARY KEY (photo_id, chunk_index)
) STRICT;

CREATE TABLE IF NOT EXISTS photo_thumbnails (
    photo_id INTEGER PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
    bytes BLOB NOT NULL CHECK (length(bytes) BETWEEN 1 AND 1048576)
) STRICT;

CREATE INDEX IF NOT EXISTS photos_submission_id_idx ON photos(submission_id);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT NOT NULL PRIMARY KEY CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
    user_id INTEGER NOT NULL REFERENCES users(id),
    expires_at INTEGER NOT NULL CHECK (expires_at > 0)
) STRICT;

CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS app_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS upload_staging_chunks (
    upload_id TEXT NOT NULL CHECK (length(upload_id) = 43),
    photo_index INTEGER NOT NULL CHECK (photo_index BETWEEN 0 AND 4),
    chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
    bytes BLOB NOT NULL CHECK (length(bytes) BETWEEN 1 AND 1048576),
    PRIMARY KEY (upload_id, photo_index, chunk_index)
) STRICT;
