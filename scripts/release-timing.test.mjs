import assert from 'node:assert/strict'
import test from 'node:test'
import { deploymentStages, summarizeTiming } from './release-timing.mjs'

const at = ms => new Date(Date.UTC(2026, 9, 31) + ms).toISOString()
function fixture() {
  return {
    schema: 'cosgallery-deployment-timing/v1',
    planDigest: 'a'.repeat(64),
    runId: 'synthetic-switch',
    stages: deploymentStages.map((stage, index) => ({ stage, start: at(index * 10000), end: at(index * 10000 + 2000), elapsedMs: 1999.5, outcome: 'passed' })),
    downtime: { unavailableAt: at(11000), healthyAt: at(51000) },
  }
}

test('separates measured command time, call gaps, wall duration and observed downtime', () => {
  const log = fixture()
  const original = structuredClone(log)
  const result = summarizeTiming(log)
  assert.equal(result.ok, true)
  assert.equal(result.status, 'complete')
  assert.equal(result.commandElapsedMs, 11997)
  assert.equal(result.interCallGapMs, 40000)
  assert.equal(result.totalWallMs, 52000)
  assert.equal(result.downtimeMs, 40000)
  assert.deepEqual(result.stages.map(item => item.gapMs), [0, 8000, 8000, 8000, 8000, 8000])
  assert.deepEqual(log, original)
})

test('no downtime is inferred from command timestamps; a partial observation remains unknown', () => {
  const log = fixture()
  delete log.downtime
  assert.equal(summarizeTiming(log).downtimeMs, null)
  log.downtime = { unavailableAt: at(11000) }
  assert.equal(summarizeTiming(log).downtimeMs, null)
  log.downtime = { healthyAt: at(51000) }
  assert.equal(summarizeTiming(log).downtimeMs, null)
})

test('already stopped service records a zero-duration skip without pretending it was stopped again', () => {
  const log = fixture()
  Object.assign(log.stages[1], { outcome: 'skipped', reason: 'already-stopped', end: log.stages[1].start, elapsedMs: 0 })
  log.downtime.unavailableAt = at(21000)
  const result = summarizeTiming(log)
  assert.equal(result.ok, true)
  assert.equal(result.commandElapsedMs, 9997.5)
  assert.equal(result.downtimeMs, 30000)
  for (const change of [{ elapsedMs: 1 }, { end: at(10001) }, { reason: 'unnecessary' }]) {
    const invalid = structuredClone(log)
    Object.assign(invalid.stages[1], change)
    assert.throws(() => summarizeTiming(invalid), /Only an already-stopped/)
  }
  log.stages[5].outcome = 'skipped'
  assert.throws(() => summarizeTiming(log), /Only an already-stopped/)
})

test('partial and failed logs cannot report completion, and no stage may follow failure', () => {
  const log = fixture()
  delete log.downtime
  log.stages = log.stages.slice(0, 3)
  assert.equal(summarizeTiming(log).status, 'incomplete')
  assert.equal(summarizeTiming(log).ok, false)
  log.stages[2].outcome = 'failed'
  assert.equal(summarizeTiming(log).status, 'failed')
  log.stages.push(fixture().stages[3])
  assert.throws(() => summarizeTiming(log), /No stage may follow/)
  log.stages = []
  assert.equal(summarizeTiming(log).totalWallMs, 0)
  assert.equal(summarizeTiming(log).status, 'incomplete')
})

test('rejects malformed timestamps, backwards clocks, overlap and non-finite elapsed measurements', () => {
  for (const start of ['2026-02-30T00:00:00.000Z', '2026-10-31T00:00:00Z', '2026-10-31T08:00:00.000+08:00', 123, null]) {
    const log = fixture()
    log.stages[0].start = start
    assert.throws(() => summarizeTiming(log), /timestamp|Invalid/)
  }
  for (const end of [at(-1), at(20000)]) {
    const log = fixture()
    log.stages[0].end = end
    assert.throws(() => summarizeTiming(log), /backwards|overlap/)
  }
  for (const elapsedMs of [-1, NaN, Infinity, '2000']) {
    const log = fixture()
    log.stages[0].elapsedMs = elapsedMs
    assert.throws(() => summarizeTiming(log), /elapsedMs/)
  }
})

test('clock or measurement-boundary discrepancies remain visible and prevent an unqualified success', () => {
  const log = fixture()
  log.stages[0].elapsedMs = 6000
  const result = summarizeTiming(log)
  assert.equal(result.status, 'complete')
  assert.equal(result.ok, false)
  assert.equal(result.clockWarnings.length, 1)
  assert.equal(result.clockWarnings[0].stage, 'read-check')
  assert.equal(result.commandElapsedMs, 15997.5)
  assert.equal(result.interCallGapMs, 40000)
})

test('rejects omissions, duplicates, reorder, unknown outcomes and wrong log identity', () => {
  for (const mutate of [
    log => { log.stages.splice(1, 1) },
    log => { log.stages[2].stage = 'stop' },
    log => { log.stages[0].stage = 'health' },
    log => { log.stages[0].outcome = 'success' },
    log => { log.schema = 'other' },
    log => { log.planDigest = 'a'.repeat(40) },
    log => { log.runId = '' },
    log => { log.stages = null },
  ]) {
    const log = fixture()
    mutate(log)
    assert.throws(() => summarizeTiming(log))
  }
})

test('downtime must be explicitly observed within the corresponding recorded stages', () => {
  for (const downtime of [
    { unavailableAt: at(-1000), healthyAt: at(51000) },
    { unavailableAt: at(31000), healthyAt: at(51000) },
    { unavailableAt: at(11000), healthyAt: at(41000) },
    { unavailableAt: at(11000), healthyAt: at(53000) },
    null,
  ]) {
    const log = fixture()
    log.downtime = downtime
    assert.throws(() => summarizeTiming(log), /Downtime|Unavailability|Health|downtime/)
  }
  const log = fixture()
  log.stages[5].outcome = 'failed'
  assert.throws(() => summarizeTiming(log), /Health observation requires/)
})
