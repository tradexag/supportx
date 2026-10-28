-- Look of a workspace, read from an uploaded DESIGN.md (validated values only).
ALTER TABLE workspaces ADD COLUMN theme jsonb;
