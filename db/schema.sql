-- Private project tables for the Neon database.
-- Review and apply this file before setting DATA_STORE or MEDIA_STORE on Vercel.
-- The application role owns these tables. This file grants nothing to other roles.
-- Production and preview must not write share_codes with different CODE_PEPPER values.

CREATE TABLE IF NOT EXISTS projects (
    id text PRIMARY KEY,
    presentation jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  );

CREATE TABLE IF NOT EXISTS share_codes (
    id text PRIMARY KEY,
    lookup_hash text NOT NULL UNIQUE,
    project_id text NOT NULL REFERENCES projects(id),
    label text,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  );

CREATE TABLE IF NOT EXISTS sessions (
    id_hash text PRIMARY KEY,
    project_id text NOT NULL,
    code_id text NOT NULL REFERENCES share_codes(id),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  );

CREATE TABLE IF NOT EXISTS rate_limits (
    bucket text PRIMARY KEY,
    window_start_ms bigint NOT NULL,
    count integer NOT NULL
  );

CREATE TABLE IF NOT EXISTS media_objects (
    project_id text NOT NULL,
    media_id text NOT NULL,
    pathname text NOT NULL,
    content_type text NOT NULL,
    filename text,
    byte_length integer,
    PRIMARY KEY (project_id, media_id)
  );

CREATE TABLE IF NOT EXISTS submission_snapshots (
    project_id text NOT NULL,
    submission_id text NOT NULL,
    digest text NOT NULL,
    presentation jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, submission_id)
  );

CREATE TABLE IF NOT EXISTS submission_files (
    project_id text NOT NULL,
    submission_id text NOT NULL,
    path text NOT NULL,
    sha256 text NOT NULL,
    size integer NOT NULL,
    media_id text,
    content_type text,
    filename text,
    PRIMARY KEY (project_id, submission_id, path)
  );

CREATE TABLE IF NOT EXISTS submission_approvals (
    project_id text NOT NULL,
    submission_id text NOT NULL,
    digest text NOT NULL,
    operation text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, submission_id, digest, operation)
  );

CREATE TABLE IF NOT EXISTS publications (
    project_id text PRIMARY KEY,
    submission_id text NOT NULL,
    digest text NOT NULL,
    version integer NOT NULL
  );
