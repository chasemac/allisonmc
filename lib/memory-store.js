import { FailClosed } from "./errors.js";
import { validatePresentation } from "./schema.js";
import { isStoredMediaPath } from "./codes.js";

export function createMemoryStore() {
  const projects = new Map();
  const media = new Map();
  const codes = new Map();
  const sessions = new Map();
  const rates = new Map();
  const snapshots = new Map();
  const approvals = new Set();
  const publications = new Map();

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
      if (!isStoredMediaPath(record.pathname)) throw new FailClosed("media path refused");
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
    async updateCode(id, fields) {
      for (const row of codes.values()) {
        if (row.id !== id) continue;
        if (fields.label !== undefined) row.label = fields.label;
        if (fields.expiresAt !== undefined) row.expiresAt = fields.expiresAt;
      }
    },
    async getSnapshot(projectId, submissionId) {
      const row = snapshots.get(`${projectId}\0${submissionId}`);
      return row ? { ...row, files: row.files.map((file) => ({ ...file })) } : null;
    },
    async sealSnapshot(record) {
      const key = `${record.projectId}\0${record.submissionId}`;
      const existing = snapshots.get(key);
      if (existing && existing.digest !== record.digest) throw new FailClosed("submission digest conflict");
      if (!existing) snapshots.set(key, { ...record, files: record.files.map((file) => ({ ...file })) });
    },
    async putApproval(record) {
      approvals.add(`${record.projectId}\0${record.submissionId}\0${record.digest}\0${record.operation}`);
    },
    async hasApproval(record) {
      return approvals.has(`${record.projectId}\0${record.submissionId}\0${record.digest}\0${record.operation}`);
    },
    async getPublication(projectId) {
      return publications.get(projectId) || null;
    },
    async importSnapshot(record) {
      snapshots.set(`${record.projectId}\0${record.submissionId}`, {
        ...record,
        files: (record.files || []).map((file) => ({ ...file })),
      });
    },
    async importPublication(record) {
      publications.set(record.projectId, { ...record });
    },
    async compareAndSetPublication({ projectId, submissionId, digest, expectedVersion }) {
      const current = publications.get(projectId) || null;
      const version = current ? current.version : 0;
      if (current && current.digest === digest && current.submissionId === submissionId) {
        return { version: current.version, idempotent: true };
      }
      if (version !== expectedVersion) throw new FailClosed("publish conflict");
      const next = version + 1;
      publications.set(projectId, { projectId, submissionId, digest, version: next });
      return { version: next, idempotent: false };
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
        snapshots: [...snapshots.values()].map((row) => ({
          ...row,
          files: row.files.map((file) => ({ ...file })),
        })),
        approvals: [...approvals].map((key) => {
          const [projectId, submissionId, digest, operation] = key.split("\0");
          return { projectId, submissionId, digest, operation };
        }),
        publications: [...publications.values()],
      };
    },
  };
}

export function createMemoryMedia() {
  const files = new Map();
  return {
    async probe() {
      // Local tests only. The hosted runtime refuses this adapter and requires a private Blob canary.
    },
    async put(pathname, bytes, contentType) {
      if (!isStoredMediaPath(pathname)) throw new FailClosed("media path refused");
      files.set(pathname, { bytes: Buffer.from(bytes), contentType });
    },
    async get(pathname) {
      if (!isStoredMediaPath(pathname)) throw new FailClosed("media path refused");
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
