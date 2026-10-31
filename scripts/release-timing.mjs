export const deploymentStages = ['read-check', 'stop', 'confirm-exit', 'install', 'start', 'health']

function timestamp(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new Error(`${label} must be a UTC ISO timestamp with milliseconds`)
  }
  const result = Date.parse(value)
  if (!Number.isFinite(result) || new Date(result).toISOString() !== value) throw new Error(`Invalid ${label}`)
  return result
}

// This consumes operator observations, never executes deployment commands or
// treats an observation as permission. Persist the raw log separately.
export function summarizeTiming(log) {
  if (!log || log.schema !== 'cosgallery-deployment-timing/v1') throw new Error('Unsupported timing log')
  if (typeof log.planDigest !== 'string' || !/^[0-9a-f]{64}$/.test(log.planDigest)) throw new Error('Timing planDigest must be a SHA256 digest')
  if (typeof log.runId !== 'string' || !log.runId.trim() || log.runId.length > 128 || /[\x00-\x1f]/.test(log.runId)) throw new Error('Timing runId is required')
  if (!Array.isArray(log.stages) || log.stages.length > deploymentStages.length) throw new Error('Invalid timing stages')

  const stages = []
  const clockWarnings = []
  let previousEnd = null
  for (const [index, item] of log.stages.entries()) {
    if (!item || item.stage !== deploymentStages[index]) throw new Error('Timing stages must be an ordered, non-duplicated prefix of the deployment stages')
    if (!['passed', 'failed', 'skipped'].includes(item.outcome)) throw new Error(`Invalid outcome for ${item.stage}`)
    if (item.outcome === 'failed' && index !== log.stages.length - 1) throw new Error('No stage may follow a failed stage')
    const start = timestamp(item.start, `${item.stage} start`)
    const end = timestamp(item.end, `${item.stage} end`)
    if (end < start || (previousEnd !== null && start < previousEnd)) throw new Error('Timing clock moved backwards or stages overlap')
    if (!Number.isFinite(item.elapsedMs) || item.elapsedMs < 0) throw new Error(`Invalid measured elapsedMs for ${item.stage}`)
    if (item.outcome === 'skipped' && (item.stage !== 'stop' || item.reason !== 'already-stopped' || item.elapsedMs !== 0 || start !== end)) {
      throw new Error('Only an already-stopped stop stage may be skipped, with zero duration')
    }
    const wallMs = end - start
    // Stopwatch time and wall time come from different clocks. A discrepancy
    // is reported, not silently assigned to command execution or agent delay.
    if (Math.abs(wallMs - item.elapsedMs) > 1000) {
      clockWarnings.push({ stage: item.stage, wallMs, elapsedMs: item.elapsedMs, message: 'Wall and monotonic durations differ by more than one second; inspect clock changes or measurement boundaries' })
    }
    stages.push({ stage: item.stage, outcome: item.outcome, start: item.start, end: item.end, commandElapsedMs: item.elapsedMs, wallMs, gapMs: previousEnd === null ? 0 : start - previousEnd })
    previousEnd = end
  }

  let downtimeMs = null
  let downtime = null
  if (log.downtime !== undefined) {
    if (!log.downtime || typeof log.downtime !== 'object' || Array.isArray(log.downtime)) throw new Error('Invalid downtime observations')
    const observations = {}
    for (const key of ['unavailableAt', 'healthyAt']) {
      if (log.downtime[key] === undefined) continue
      const observed = timestamp(log.downtime[key], `downtime ${key}`)
      if (!stages.length || observed < Date.parse(stages[0].start) || observed > previousEnd) throw new Error('Downtime observations must fall within the recorded run')
      observations[key] = observed
    }
    if (observations.unavailableAt !== undefined) {
      const stop = stages.find(item => item.stage === 'stop')
      const confirm = stages.find(item => item.stage === 'confirm-exit')
      if (!stop || observations.unavailableAt < Date.parse(stop.start) || observations.unavailableAt > Date.parse((confirm ?? stop).end)) {
        throw new Error('Unavailability must be observed during stop or exit confirmation')
      }
    }
    if (observations.healthyAt !== undefined) {
      const health = stages.find(item => item.stage === 'health')
      if (!health || health.outcome !== 'passed' || observations.healthyAt < Date.parse(health.start)) throw new Error('Health observation requires a successful health stage')
    }
    if (observations.unavailableAt !== undefined && observations.healthyAt !== undefined) {
      if (observations.healthyAt < observations.unavailableAt) throw new Error('Downtime observations are reversed')
      downtimeMs = observations.healthyAt - observations.unavailableAt
    }
    downtime = Object.fromEntries(Object.keys(observations).map(key => [key, log.downtime[key]]))
  }

  const failed = stages.at(-1)?.outcome === 'failed'
  const complete = stages.length === deploymentStages.length && !failed
  return {
    schema: 'cosgallery-deployment-timing-summary/v1',
    runId: log.runId,
    planDigest: log.planDigest,
    ok: complete && clockWarnings.length === 0,
    status: failed ? 'failed' : complete ? 'complete' : 'incomplete',
    stages,
    commandElapsedMs: stages.reduce((sum, item) => sum + item.commandElapsedMs, 0),
    interCallGapMs: stages.reduce((sum, item) => sum + item.gapMs, 0),
    totalWallMs: stages.length ? previousEnd - Date.parse(stages[0].start) : 0,
    downtime,
    downtimeMs,
    clockWarnings,
    measurement: 'Caller-recorded timestamps and monotonic durations; no commands executed or runtime state independently verified',
  }
}
