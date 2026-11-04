import { describe, expect, it } from 'vitest'
import {
  metaTextMeasurer,
  sprintTrack,
  SPRINT_TRACK_CEILING,
  SPRINT_TRACK_FLOOR,
  type Measure,
} from '../../src/renderer/lanes/idWidth.js'

/**
 * The width of the sprint column (0.9.0). It was a fixed 88px and cut off
 * nearly every real sprint name; it now fits the widest one in the lane.
 */

/** Eight pixels a character: crude, and enough to test the clamping. */
const perChar: Measure = (text) => text.length * 8

describe('the sprint column', () => {
  it('fits the widest sprint in the lane, never narrower', () => {
    const width = sprintTrack(['Sprint 12', 'MERC Sprint 2026-11 Platform'], perChar)
    expect(width).toBeGreaterThanOrEqual('MERC Sprint 2026-11 Platform'.length * 8)
  })

  it('keeps the old width as a floor, so the heading still fits', () => {
    expect(sprintTrack(['S1'], perChar)).toBe(SPRINT_TRACK_FLOOR)
  })

  it('stops one absurd name from eating the summary', () => {
    expect(sprintTrack(['x'.repeat(200)], perChar)).toBe(SPRINT_TRACK_CEILING)
  })

  it('falls back to the floor with no sprints or no reading', () => {
    expect(sprintTrack([], perChar)).toBe(SPRINT_TRACK_FLOOR)
    expect(sprintTrack(['Sprint 12'], () => 0)).toBe(SPRINT_TRACK_FLOOR)
    expect(sprintTrack(['Sprint 12'], () => Number.NaN)).toBe(SPRINT_TRACK_FLOOR)
  })

  it('declines to measure where there is no document', () => {
    expect(metaTextMeasurer()).toBeNull()
  })
})
