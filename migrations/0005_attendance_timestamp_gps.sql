ALTER TABLE attendance_events ADD COLUMN photo_datetime TEXT;
ALTER TABLE attendance_events ADD COLUMN gps_lat REAL;
ALTER TABLE attendance_events ADD COLUMN gps_lng REAL;
ALTER TABLE attendance_events ADD COLUMN distance_m REAL;
ALTER TABLE attendance_events ADD COLUMN attendance_source TEXT NOT NULL DEFAULT 'LEGACY_CLOCK';
ALTER TABLE attendance_events ADD COLUMN clock_evidence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attendance_events ADD COLUMN clock_confidence REAL NOT NULL DEFAULT 0;
ALTER TABLE attendance_events ADD COLUMN overlay_raw_text TEXT NOT NULL DEFAULT '';
ALTER TABLE attendance_events ADD COLUMN image_sha256 TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_image_sha256
ON attendance_events(image_sha256)
WHERE image_sha256 IS NOT NULL AND image_sha256 <> '';
