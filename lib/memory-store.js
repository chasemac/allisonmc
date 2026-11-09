import { FailClosed } from "./errors.js";
import { validatePresentation } from "./schema.js";
import { MEDIA_PATH } from "./codes.js";

export function createMemoryStore() {
  const projects = new Map();
  const media = new Map();
  const codes = new Map();
  const sessions = new Map();
  const rates = new Map();

  return {
    projects,
    async migrate() {},
    async upsertProject(presentation) {
      const clean = validatePresentation(presentation);
      projects.set(clean.id, clean);
      return clean;
    },
    async getProject(id) {
      const row = projects.get(id);
      if (!row) return null;
      try {
        return validatePresentation(row);
      } catch {
        throw new FailClosed("stored project refused");
      }
    },
    async listProjects() {
      return [...projects.values()].map((project) => ({
        id: project.id,
        title: project.title,
        fictional: project.fictional,
      }));
    },
    async putMedia(record) {
      if (!MEDIA_PATH.test(record.pathname)) throw new FailClosed("media path refused");
      media.set(`${record.projectId}\0${record.mediaId}`, { ...record });
    },
    async getMedia(projectId, mediaId) {
      return media.get(`${projectId}\0${mediaId}`) || null;
    },
    async insertCode(record) {
      if (codes.has(record.lookupHash)) throw new FailClosed("code already exists");
      codes.set(record.lookupHash, { ...record, revokedAt: record.revokedAt || null });
    },
    async getCodeByHash(lookupHash) {
      const row = codes.get(lookupHash);
      return row ? { ...row } : null;
    },
    async getCodeById(id) {
      for (const row of codes.values()) {
        if (row.id === id) return { ...row };
      }
      return null;
    },
    async revokeCode(id) {
      for (const row of codes.values()) {
        if (row.id === id) row.revokedAt = Date.now();
      }
    },
    async revokeProjectCodes(projectId) {
      for (const row of codes.values()) {
        if (row.projectId === projectId) row.revokedAt = Date.now();
      }
    },
    async listCodes(projectId) {
      return [...codes.values()]
        .filter((row) => row.projectId === projectId)
        .map((row) => ({
          id: row.id,
          projectId: row.projectId,
          label: row.label,
          expiresAt: row.expiresAt,
          revokedAt: row.revokedAt,
        }));
    },
    async insertSession(record) {
      sessions.set(record.idHash, { ...record, revokedAt: null });
    },
    async getSession(idHash) {
      const row = sessions.get(idHash);
      return row ? { ...row } : null;
    },
    async revokeSession(idHash) {
      const row = sessions.get(idHash);
      if (row) row.revokedAt = Date.now();
    },
    async expireSession(idHash, at) {
      const row = sessions.get(idHash);
      if (row) row.expiresAt = at;
    },
    async expireCode(id, at) {
      for (const row of codes.values()) {
        if (row.id === id) row.expiresAt = at;
      }
    },
    async consumeRateLimit(bucket, { max, windowMs, now }) {
      const windowStart = Math.floor(now / windowMs) * windowMs;
      const current = rates.get(bucket);
      const count = current && current.windowStart === windowStart ? current.count + 1 : 1;
      rates.set(bucket, { windowStart, count });
      return { allowed: count <= max, count };
    },
    dump() {
      return {
        projects: [...projects.values()],
        media: [...media.values()].map(({ pathname, projectId, mediaId, contentType, filename, byteLength }) => ({
          pathname,
          projectId,
          mediaId,
          contentType,
          filename,
          byteLength,
        })),
        codes: [...codes.values()].map(({ id, lookupHash, projectId, label, expiresAt, revokedAt }) => ({
          id,
          lookupHash,
          projectId,
          label,
          expiresAt,
          revokedAt,
        })),
        sessions: [...sessions.values()],
      };
    },
  };
}

export function createMemoryMedia() {
  const files = new Map();
  return {
    async put(pathname, bytes, contentType) {
      if (!MEDIA_PATH.test(pathname)) throw new FailClosed("media path refused");
      files.set(pathname, { bytes: Buffer.from(bytes), contentType });
    },
    async get(pathname) {
      if (!MEDIA_PATH.test(pathname)) throw new FailClosed("media path refused");
      const item = files.get(pathname);
      if (!item) return null;
      return {
        stream: new Blob([item.bytes]).stream(),
        contentType: item.contentType,
      };
    },
    dump() {
      return [...files.entries()].map(([pathname, item]) => ({
        pathname,
        contentType: item.contentType,
        bytes: item.bytes.toString("base64"),
      }));
    },
  };
}
