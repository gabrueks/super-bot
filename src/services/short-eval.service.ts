import fs from 'fs';
import { DATA_DIR, SHORT_QUALITY_METRICS_FILE } from '../config';
import { ShortCycleResult, ShortQualityCycleMetric, ShortQualitySummary } from '../types';

const MAX_SHORT_QUALITY_METRICS = 1000;

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadShortQualityMetrics(): ShortQualityCycleMetric[] {
  ensureDataDir();
  if (!fs.existsSync(SHORT_QUALITY_METRICS_FILE)) {
    return [];
  }
  const raw = fs.readFileSync(SHORT_QUALITY_METRICS_FILE, 'utf-8');
  return JSON.parse(raw) as ShortQualityCycleMetric[];
}

function saveShortQualityMetrics(metrics: ShortQualityCycleMetric[]): void {
  ensureDataDir();
  fs.writeFileSync(SHORT_QUALITY_METRICS_FILE, JSON.stringify(metrics, null, 2));
}

function sumTradeMetric(
  result: ShortCycleResult,
  field: 'estimatedFeesUsdt' | 'estimatedFundingUsdt' | 'estimatedGrossPnlUsdt' | 'estimatedNetPnlUsdt',
): number {
  return result.trades.reduce((sum, trade) => {
    const value = trade[field];
    if (Number.isFinite(value)) {
      return sum + (value ?? 0);
    }
    return sum;
  }, 0);
}

function buildShortCycleMetric(result: ShortCycleResult, cycleDurationMs: number): ShortQualityCycleMetric {
  const rejectionCount = result.errors.filter((error) => error.startsWith('REJECTED ')).length;
  const errorCount = result.errors.filter((error) => error.startsWith('ERROR ')).length;
  const invalidDecisionRate = result.decisionsReceived > 0 ? rejectionCount / result.decisionsReceived : 0;
  const executionSuccessRate = result.decisionsApproved > 0 ? result.tradesExecuted / result.decisionsApproved : 1;
  const approvalRate = result.decisionsReceived > 0 ? result.decisionsApproved / result.decisionsReceived : 0;
  const estimatedFeesUsdt = sumTradeMetric(result, 'estimatedFeesUsdt');
  const estimatedFundingUsdt = sumTradeMetric(result, 'estimatedFundingUsdt');
  const estimatedGrossPnlUsdt = sumTradeMetric(result, 'estimatedGrossPnlUsdt');
  const estimatedNetPnlUsdt = sumTradeMetric(result, 'estimatedNetPnlUsdt');

  return {
    timestamp: result.timestamp,
    cycleDurationMs,
    decisionsReceived: result.decisionsReceived,
    decisionsApproved: result.decisionsApproved,
    tradesExecuted: result.tradesExecuted,
    rejectionCount,
    errorCount,
    invalidDecisionRate,
    executionSuccessRate,
    approvalRate,
    estimatedFeesUsdt,
    estimatedFundingUsdt,
    estimatedGrossPnlUsdt,
    estimatedNetPnlUsdt,
    failureCode: result.failureCode,
  };
}

export function recordShortCycleQuality(
  result: ShortCycleResult,
  cycleDurationMs: number,
): ShortQualityCycleMetric {
  const metric = buildShortCycleMetric(result, cycleDurationMs);
  const metrics = loadShortQualityMetrics();
  metrics.push(metric);
  if (metrics.length > MAX_SHORT_QUALITY_METRICS) {
    metrics.splice(0, metrics.length - MAX_SHORT_QUALITY_METRICS);
  }
  saveShortQualityMetrics(metrics);
  return metric;
}

export function getShortQualitySummary(windowSize = 20): ShortQualitySummary {
  const metrics = loadShortQualityMetrics();
  const recent = metrics.slice(-windowSize);
  if (recent.length === 0) {
    return {
      recentCycles: 0,
      invalidDecisionRate: 0,
      executionErrorRate: 0,
      approvalRate: 0,
      avgEstimatedFeesUsdt: 0,
      avgEstimatedFundingUsdt: 0,
      avgEstimatedGrossPnlUsdt: 0,
      avgEstimatedNetPnlUsdt: 0,
    };
  }

  const totals = recent.reduce((acc, metric) => {
    acc.invalidDecisionRate += metric.invalidDecisionRate;
    acc.executionErrorRate += 1 - metric.executionSuccessRate;
    acc.approvalRate += metric.approvalRate;
    acc.avgEstimatedFeesUsdt += metric.estimatedFeesUsdt;
    acc.avgEstimatedFundingUsdt += metric.estimatedFundingUsdt;
    acc.avgEstimatedGrossPnlUsdt += metric.estimatedGrossPnlUsdt;
    acc.avgEstimatedNetPnlUsdt += metric.estimatedNetPnlUsdt;
    return acc;
  }, {
    invalidDecisionRate: 0,
    executionErrorRate: 0,
    approvalRate: 0,
    avgEstimatedFeesUsdt: 0,
    avgEstimatedFundingUsdt: 0,
    avgEstimatedGrossPnlUsdt: 0,
    avgEstimatedNetPnlUsdt: 0,
  });

  return {
    recentCycles: recent.length,
    invalidDecisionRate: totals.invalidDecisionRate / recent.length,
    executionErrorRate: totals.executionErrorRate / recent.length,
    approvalRate: totals.approvalRate / recent.length,
    avgEstimatedFeesUsdt: totals.avgEstimatedFeesUsdt / recent.length,
    avgEstimatedFundingUsdt: totals.avgEstimatedFundingUsdt / recent.length,
    avgEstimatedGrossPnlUsdt: totals.avgEstimatedGrossPnlUsdt / recent.length,
    avgEstimatedNetPnlUsdt: totals.avgEstimatedNetPnlUsdt / recent.length,
    lastFailureCode: recent[recent.length - 1].failureCode,
  };
}
