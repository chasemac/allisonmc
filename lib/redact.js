export function redact(value) {
  return String(value)
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "postgres://[redacted]")
    .replace(/BLOB_[A-Z0-9_]*TOKEN\s*[=:]\s*\S+/gi, "BLOB_TOKEN=[redacted]")
    .replace(/vercel_blob_rw_[A-Za-z0-9_]+/gi, "vercel_blob_rw_[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(/CODE_PEPPER\s*[=:]\s*\S+/gi, "CODE_PEPPER=[redacted]")
    .replace(/amc_session=[^;\s]+/g, "amc_session=[redacted]")
    .replace(/"code"\s*:\s*"[^"]*"/g, '"code":"[redacted]"');
}
