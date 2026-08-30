import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import fs from "fs";

export function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function summarizeLatencies(samples) {
  const times = samples.map((s) => s.ms).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const sum = times.reduce((a, b) => a + b, 0);
  return {
    n: times.length,
    min: Number((times[0] ?? 0).toFixed(1)),
    mean: Number(((sum / (times.length || 1)) || 0).toFixed(1)),
    p50: Number(percentile(times, 50).toFixed(1)),
    p95: Number(percentile(times, 95).toFixed(1)),
    p99: Number(percentile(times, 99).toFixed(1)),
    max: Number((times.at(-1) ?? 0).toFixed(1)),
  };
}

export function aggregateSamples(samples) {
  const success = samples.filter((s) => s.status >= 200 && s.status < 400);
  const failed = samples.filter((s) => s.status >= 400 || s.status === 0);
  const http4 = samples.filter((s) => s.status >= 400 && s.status < 500);
  const http5 = samples.filter((s) => s.status >= 500);
  const timeouts = samples.filter((s) => s.timeout);
  const byCode = {};
  for (const s of samples) {
    const key = s.code || String(s.status);
    byCode[key] = (byCode[key] || 0) + 1;
  }
  const byOp = {};
  for (const s of samples) {
    if (!byOp[s.op]) byOp[s.op] = [];
    byOp[s.op].push(s);
  }
  const ops = {};
  for (const [op, list] of Object.entries(byOp)) {
    ops[op] = {
      ...summarizeLatencies(list),
      success: list.filter((x) => x.status >= 200 && x.status < 400).length,
      failed: list.filter((x) => x.status >= 400 || x.status === 0).length,
      queries_avg: Number(
        (
          list.reduce((a, b) => a + (Number(b.queryCount) || 0), 0) / (list.length || 1)
        ).toFixed(1)
      ),
    };
  }
  return {
    total: samples.length,
    successful: success.length,
    failed: failed.length,
    http4xx: http4.length,
    http5xx: http5.length,
    timeouts: timeouts.length,
    byCode,
    latency: summarizeLatencies(samples),
    ops,
  };
}

export function startResourceSampler({ dbPath, intervalMs = 250 } = {}) {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  const samples = [];
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  const timer = setInterval(() => {
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage(cpu0);
    const elapsedSec = (performance.now() - t0) / 1000;
    let dbBytes = 0;
    let walBytes = 0;
    try {
      if (dbPath && fs.existsSync(dbPath)) dbBytes = fs.statSync(dbPath).size;
      if (dbPath && fs.existsSync(`${dbPath}-wal`)) walBytes = fs.statSync(`${dbPath}-wal`).size;
    } catch {
      /* ignore */
    }
    samples.push({
      t: Date.now(),
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      cpuUserMs: cpu.user / 1000,
      cpuSystemMs: cpu.system / 1000,
      cpuPct: elapsedSec > 0 ? ((cpu.user + cpu.system) / 1e6 / elapsedSec) * 100 : 0,
      dbBytes,
      walBytes,
    });
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();

  return {
    stop() {
      clearInterval(timer);
      histogram.disable();
      const nsToMs = (ns) => Number(ns) / 1e6;
      const last = samples.at(-1) || {};
      return {
        eventLoopMs: {
          p50: Number(nsToMs(histogram.percentile(50)).toFixed(2)),
          p99: Number(nsToMs(histogram.percentile(99)).toFixed(2)),
          max: Number(nsToMs(histogram.max).toFixed(2)),
        },
        memory: { rss: last.rss || 0, heapUsed: last.heapUsed || 0 },
        cpu: { userMs: last.cpuUserMs || 0, systemMs: last.cpuSystemMs || 0, pct: last.cpuPct || 0 },
        dbBytes: last.dbBytes || 0,
        walBytes: last.walBytes || 0,
        samples: samples.length,
      };
    },
  };
}

export function nowMs() {
  return performance.now();
}
