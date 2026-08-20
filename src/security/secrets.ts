const sensitiveKey =
  /(^|_)(password|passwd|passphrase|secret|token|api_?key|private_?key|credential|authorization|cookie)($|_)/i;

function isSensitiveKey(key: string): boolean {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-z0-9]+/gi, "_")
    .toLowerCase();
  return sensitiveKey.test(normalized);
}

export function redactSecrets(value: unknown, allowValues = false): unknown {
  if (allowValues) return value;
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        isSensitiveKey(key) ? "[REDACTED]" : redactSecrets(child),
      ]),
    );
  }
  return value;
}

export function secretKeyNames(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value).sort();
}
