/**
 * Selectors for evaluating and rendering Preflight Validation & Safety Status.
 */

/**
 * Returns the aggregated preflight validation status, including whether the vehicle
 * is ready to arm, and the severity of any ongoing checks.
 *
 * @param {Object} state - The Zustand telemetry store state
 * @returns {Object} Normalized preflight status
 */
export const selectPreflightStatus = (state) => {
  const raw = state.preflightStatus || { ready_to_arm: false, checks: [], score: 0, status_texts: [] };
  
  const allChecks = Array.isArray(raw.checks) ? raw.checks : [];
  
  const blockingChecks = allChecks.filter(c => c.status === 'ERROR');
  const warningChecks = allChecks.filter(c => c.status === 'WARN');
  const infoChecks = allChecks.filter(c => c.status === 'INFO');
  
  const hasErrors = blockingChecks.length > 0;
  const hasWarnings = warningChecks.length > 0;
  
  const statusTexts = Array.isArray(raw.status_texts) ? raw.status_texts : [];
  
  return {
    isReadyToArm: !!raw.ready_to_arm,
    score: raw.score || 0,
    checks: allChecks,
    blockingChecks,
    warningChecks,
    infoChecks,
    statusTexts,
    hasErrors,
    hasWarnings,
    timestamp: raw.timestamp || 0,
  };
};
