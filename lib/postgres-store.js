import { FailClosed } from "./errors.js";
import { validatePresentation } from "./schema.js";
import { MEDIA_PATH } from "./codes.js";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS projects (
    id text PRIMARY KEY,
    presentation jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS share_codes (
    id text PRIMARY KEY,
    lookup_hash text NOT NULL UNIQUE,
    project_id text NOT NULL REFERENCES projects(id),
    label text,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id_hash text PRIMARY KEY,
    project_id text NOT NULL,
    code_id text NOT NULL REFERENCES share_codes(id),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS rate_limits (
    bucket text PRIMARY KEY,
    window_start_ms bigint NOT NULL,
    count integer NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS media_objects (
    project_id text NOT NULL,
    media_id text NOT NULL,
    pathname text NOT NULL,
    content_type text NOT NULL,
    filename text,
    byte_length integer,
    PRIMARY KEY (project_id, media_id)
  )`,
];

function stamp(value) {
  if (value === null || value === undefined) return null;
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

export function createPostgresStore(sql) {
  async function query(run) {
    try {
      return await run();
    } catch (err) {
      if (err instanceof FailClosed) throw err;
      throw new FailClosed("project store unavailable");
    }
  }

  return {
    async migrate() {
      await query(async () => {
        for (const statement of SCHEMA) await sql.query(statement);
      });
    },
    async upsertProject(presentation) {
      const clean = validatePresentation(presentation);
      const payload = JSON.stringify(clean);
      await query(() => sql`
        INSERT INTO projects (id, presentation, updated_at)
        VALUES (${clean.id}, ${payload}::jsonb, now())
        ON CONFLICT (id) DO UPDATE SET presentation = EXCLUDED.presentation, updated_at = now()
      `);
      return clean;
    },
    async getProject(id) {
      const rows = await query(() => sql`SELECT presentation FROM projects WHERE id = ${id}`);
      if (!rows.length) return null;
      const value = rows[0].presentation;
      const parsed = typeof value === "string" ? JSON.parse(value) : value;
      try {
        return validatePresentation(parsed);
      } catch {
        throw new FailClosed("stored project refused");
      }
    },
    async listProjects() {
      const rows = await query(() => sql`SELECT id, presentation FROM projects ORDER BY id`);
      return rows.map((row) => {
        const value = typeof row.presentation === "string" ? JSON.parse(row.presentation) : row.presentation;
        return { id: row.id, title: value.title, fictional: value.fictional };
      });
    },
    async putMedia(record) {
      if (!MEDIA_PATH.test(record.pathname)) throw new FailClosed("media path refused");
      await query(() => sql`
        INSERT INTO media_objects (project_id, media_id, pathname, content_type, filename, byte_length)
        VALUES (${record.projectId}, ${record.mediaId}, ${record.pathname}, ${record.contentType}, ${record.filename}, ${record.byteLength})
        ON CONFLICT (project_id, media_id) DO UPDATE SET
          pathname = EXCLUDED.pathname,
          content_type = EXCLUDED.content_type,
          filename = EXCLUDED.filename,
          byte_length = EXCLUDED.byte_length
      `);
    },
    async getMedia(projectId, mediaId) {
      const rows = await query(
        () => sql`SELECT project_id, media_id, pathname, content_type, filename, byte_length FROM media_objects WHERE project_id = ${projectId} AND media_id = ${mediaId}`,
      );
      if (!rows.length) return null;
      const row = rows[0];
      return {
        projectId: row.project_id,
        mediaId: row.media_id,
        pathname: row.pathname,
        contentType: row.content_type,
        filename: row.filename,
        byteLength: row.byte_length,
      };
    },
    async insertCode(record) {
      await query(() => sql`
        INSERT INTO share_codes (id, lookup_hash, project_id, label, expires_at)
        VALUES (${record.id}, ${record.lookupHash}, ${record.projectId}, ${record.label || ""}, ${iso(record.expiresAt)})
      `);
    },
    async getCodeByHash(lookupHash) {
      const rows = await query(
        () => sql`SELECT id, lookup_hash, project_id, label, expires_at, revoked_at FROM share_codes WHERE lookup_hash = ${lookupHash}`,
      );
      if (!rows.length) return null;
      const row = rows[0];
      return {
        id: row.id,
        lookupHash: row.lookup_hash,
        projectId: row.project_id,
        label: row.label,
        expiresAt: stamp(row.expires_at),
        revokedAt: stamp(row.revoked_at),
      };
    },
    async getCodeById(id) {
      const rows = await query(
        () => sql`SELECT id, lookup_hash, project_id, label, expires_at, revoked_at FROM share_codes WHERE id = ${id}`,
      );
      if (!rows.length) return null;
      const row = rows[0];
      return {
        id: row.id,
        lookupHash: row.lookup_hash,
        projectId: row.project_id,
        label: row.label,
        expiresAt: stamp(row.expires_at),
        revokedAt: stamp(row.revoked_at),
      };
    },
    async revokeCode(id) {
      await query(() => sql`UPDATE share_codes SET revoked_at = now() WHERE id = ${id} AND revoked_at IS NULL`);
    },
    async revokeProjectCodes(projectId) {
      await query(() => sql`UPDATE share_codes SET revoked_at = now() WHERE project_id = ${projectId} AND revoked_at IS NULL`);
    },
    async listCodes(projectId) {
      const rows = await query(
        () => sql`SELECT id, project_id, label, expires_at, revoked_at FROM share_codes WHERE project_id = ${projectId} ORDER BY created_at`,
      );
      return rows.map((row) => ({
        id: row.id,
        projectId: row.project_id,
        label: row.label,
        expiresAt: stamp(row.expires_at),
        revokedAt: stamp(row.revoked_at),
      }));
    },
    async insertSession(record) {
      await query(() => sql`
        INSERT INTO sessions (id_hash, project_id, code_id, expires_at)
        VALUES (${record.idHash}, ${record.projectId}, ${record.codeId}, ${iso(record.expiresAt)})
      `);
    },
    async getSession(idHash) {
      const rows = await query(
        () => sql`SELECT id_hash, project_id, code_id, expires_at, revoked_at FROM sessions WHERE id_hash = ${idHash}`,
      );
      if (!rows.length) return null;
      const row = rows[0];
      return {
        idHash: row.id_hash,
        projectId: row.project_id,
        codeId: row.code_id,
        expiresAt: stamp(row.expires_at),
        revokedAt: stamp(row.revoked_at),
      };
    },
    async revokeSession(idHash) {
      await query(() => sql`UPDATE sessions SET revoked_at = now() WHERE id_hash = ${idHash} AND revoked_at IS NULL`);
    },
    async consumeRateLimit(bucket, { max, windowMs, now }) {
      const windowStart = Math.floor(now / windowMs) * windowMs;
      const rows = await query(() => sql`
        INSERT INTO rate_limits (bucket, window_start_ms, count)
        VALUES (${bucket}, ${windowStart}, 1)
        ON CONFLICT (bucket) DO UPDATE SET
          count = CASE
            WHEN rate_limits.window_start_ms = ${windowStart} THEN rate_limits.count + 1
            ELSE 1
          END,
          window_start_ms = ${windowStart}
        RETURNING count
      `);
      const count = Number(rows[0]?.count);
      if (!Number.isInteger(count)) throw new FailClosed("rate limit store unavailable");
      return { allowed: count <= max, count };
    },
  };
}
