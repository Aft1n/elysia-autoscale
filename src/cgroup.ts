import { readFileSync } from "node:fs";

/**
 * What the container is allowed to use, read from the cgroup files Docker (and so Coolify's CPU and memory limits)
 * writes. Every reader returns null when there is no limit or no cgroup, as on a laptop, so callers fall back to the
 * machine's own numbers. The parsers are separate from the file reads so they can be tested with plain strings.
 */

/** cgroup v2 `cpu.max`: "max 100000" (no limit) or "200000 100000" (quota and period in microseconds). */
export function parseCpuMax(text: string): number | null {
  const [quota, period] = text.trim().split(/\s+/);
  if (quota === undefined || quota === "max") return null;
  const cpus = Number(quota) / Number(period ?? 100_000);
  return Number.isFinite(cpus) && cpus > 0 ? cpus : null;
}

/** cgroup v1 `cpu.cfs_quota_us` (-1 means no limit) and `cpu.cfs_period_us`. */
export function parseCfs(quota: string, period: string): number | null {
  const q = Number(quota);
  const p = Number(period);
  return q > 0 && p > 0 ? q / p : null;
}

/** cgroup v2 `memory.max` ("max" or bytes) or v1 `memory.limit_in_bytes` (a huge number means no limit). */
export function parseMemoryLimit(text: string): number | null {
  const value = text.trim();
  if (value === "max") return null;
  const bytes = Number(value);
  return Number.isFinite(bytes) && bytes > 0 && bytes < 2 ** 60 ? bytes : null;
}

function read(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** CPUs the container may use (a fraction is possible, e.g. 1.5), or null when unlimited. */
export function cpuLimit(): number | null {
  const v2 = read("/sys/fs/cgroup/cpu.max");
  if (v2 !== null) return parseCpuMax(v2);
  const quota = read("/sys/fs/cgroup/cpu/cpu.cfs_quota_us");
  const period = read("/sys/fs/cgroup/cpu/cpu.cfs_period_us");
  return quota !== null && period !== null ? parseCfs(quota, period) : null;
}

/** Memory limit in bytes, or null when unlimited. */
export function memoryLimit(): number | null {
  const text = read("/sys/fs/cgroup/memory.max") ?? read("/sys/fs/cgroup/memory/memory.limit_in_bytes");
  return text === null ? null : parseMemoryLimit(text);
}

/** Memory the container uses now, in bytes (includes file cache), or null without a cgroup. */
export function memoryUsed(): number | null {
  const text = read("/sys/fs/cgroup/memory.current") ?? read("/sys/fs/cgroup/memory/memory.usage_in_bytes");
  const bytes = Number(text);
  return text !== null && Number.isFinite(bytes) ? bytes : null;
}
