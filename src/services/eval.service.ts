import fs from 'fs';
import { DATA_DIR, QUALITY_METRICS_FILE } from '../config';
import { CycleResult, QualityCycleMetric, QualitySummary } from '../types';

const MAX_QUALITY_METRICS = 1000;

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadQualityMetrics(): QualityCycleMetric[] {
  ensureDataDir();
  if (!fs.existsSync(QUALITY_METRICS_FILE)) {
    return [];
  }
  const raw = fs.readFileSync(QUALITY_METRICS_FILE, 'utf-8');
  return JSON.parse(raw) as QualityCycleMetric[];
}

function saveQualityMetrics(metrics: QualityCycleMetric[]): void {
  ensureDataDir();
  fs.writeFileSync(QUALITY_METRICS_FILE, JSON.stringify(metrics, null, 2));
}

function buildCycleMetric(result: CycleResult, cycleDurationMs: number): QualityCycleMetric {
  const rejectionCount = result.errors.filter((e) => e.startsWith('REJECTED ')).length;
  const errorCount = result.errors.filter((e) => e.startsWith('ERROR ')).length;
  const decisionsReceived = result.decisionsReceived;
  const decisionsApproved = result.decisionsApproved;
  const tradesExecuted = result.tradesExecuted;
  const invalidDecisionRate = decisionsReceived > 0 ? rejectionCount / decisionsReceived : 0;
  const executionSuccessRate = decisionsApproved > 0 ? tradesExecuted / decisionsApproved : 1;
  const approvalRate = decisionsReceived > 0 ? decisionsApproved / decisionsReceived : 0;

  return {
    timestamp: result.timestamp,
    cycleDurationMs,
    decisionsReceived,
    decisionsApproved,
    tradesExecuted,
    rejectionCount,
    errorCount,
    invalidDecisionRate,
    executionSuccessRate,
    approvalRate,
    failureCode: result.failureCode,
  };
}

export function recordCycleQuality(result: CycleResult, cycleDurationMs: number): QualityCycleMetric {
  const metric = buildCycleMetric(result, cycleDurationMs);
  const metrics = loadQualityMetrics();
  metrics.push(metric);
  if (metrics.length > MAX_QUALITY_METRICS) {
    metrics.splice(0, metrics.length - MAX_QUALITY_METRICS);
  }
  saveQualityMetrics(metrics);
  return metric;
}

export function getQualitySummary(windowSize = 20): QualitySummary {
  const metrics = loadQualityMetrics();
  const recent = metrics.slice(-windowSize);
  if (recent.length === 0) {
    return {
      recentCycles: 0,
      invalidDecisionRate: 0,
      executionErrorRate: 0,
      approvalRate: 0,
    };
  }

  const sumInvalidRate = recent.reduce((sum, m) => sum + m.invalidDecisionRate, 0);
  const sumExecutionErrorRate = recent.reduce((sum, m) => sum + (1 - m.executionSuccessRate), 0);
  const sumApprovalRate = recent.reduce((sum, m) => sum + m.approvalRate, 0);

  return {
    recentCycles: recent.length,
    invalidDecisionRate: sumInvalidRate / recent.length,
    executionErrorRate: sumExecutionErrorRate / recent.length,
    approvalRate: sumApprovalRate / recent.length,
    lastFailureCode: recent[recent.length - 1].failureCode,
  };
}
