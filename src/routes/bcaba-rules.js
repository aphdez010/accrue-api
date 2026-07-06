// BCaBA Supervised Fieldwork compliance logic
// Based on BCaBA Handbook (Updated 06/2026), current (pre-2027) eligibility requirements
// Covers both fieldwork types: Supervised (1,300 hrs) and Concentrated Supervised (1,000 hrs)

export const BCABA_REQUIREMENTS = {
  supervised: {
    totalHoursRequired: 1300,
    monthlyMin: 20,
    monthlyMax: 130,
    contactsPerMonth: 4,
    observationsPerMonth: 1,
    supervisionPct: 0.05,
  },
  concentrated: {
    totalHoursRequired: 1000,
    monthlyMin: 20,
    monthlyMax: 130,
    contactsPerMonth: 6,
    observationsPerMonth: 1,
    supervisionPct: 0.10,
  },
  individualSupervisionMinShare: 0.5, // group supervision may not exceed individual
  unrestrictedMinPct: 0.4,             // across TOTAL accumulated hours, not per-month
  concentratedToSupervisedMultiplier: 1.3, // for combining fieldwork types toward the 1,300 total
};

/**
 * Checks a single month's fieldwork entry against BCaBA monthly requirements.
 * entry: {
 *   fieldworkType: 'supervised' | 'concentrated',
 *   totalHours: number,
 *   contactsCount: number,
 *   observationCompleted: boolean,
 *   individualHours: number,
 *   groupHours: number,
 *   supervisedHours: number
 * }
 */
export function checkMonthlyCompliance(entry) {
  const req = BCABA_REQUIREMENTS[entry.fieldworkType];
  const issues = [];

  if (!entry.observationCompleted) issues.push('no_observation');
  if (entry.totalHours < req.monthlyMin) issues.push('under_min_hours');
  if (entry.totalHours > req.monthlyMax) issues.push('over_max_hours');
  if (entry.contactsCount < req.contactsPerMonth) issues.push('insufficient_contacts');
  if (entry.groupHours > entry.individualHours) issues.push('group_exceeds_individual');

  const supervisionPct = entry.totalHours > 0 ? entry.supervisedHours / entry.totalHours : 0;
  if (supervisionPct < req.supervisionPct) issues.push('supervision_pct_below_min');

  return { compliant: issues.length === 0, issues };
}

/**
 * Applies the Handbook's "Adjusting and Documenting Fieldwork Hours" table (p.20)
 * when a month doesn't meet requirements, to determine eligible hours for that month.
 */
export function adjustMonthlyHours(entry) {
  const req = BCABA_REQUIREMENTS[entry.fieldworkType];

  // No observation = zero eligible hours for the month
  if (!entry.observationCompleted) {
    return { adjustedHours: 0, reason: 'no_observation' };
  }

  // Cap at monthly max
  let hours = Math.min(entry.totalHours, req.monthlyMax);

  // Below minimum = zero eligible hours for the month
  if (hours < req.monthlyMin) {
    return { adjustedHours: 0, reason: 'under_min_hours' };
  }

  // Prorate based on contacts met, per Handbook example
  // (e.g., 2 of 4 required contacts = 50% of hours count)
  if (entry.contactsCount < req.contactsPerMonth) {
    hours *= entry.contactsCount / req.contactsPerMonth;
  }

  // Group supervision may not exceed individual supervision hours
  if (entry.groupHours > entry.individualHours) {
    // Reduce group hours down to match individual (handbook adjustment rule)
    const excessGroup = entry.groupHours - entry.individualHours;
    hours = Math.max(0, hours - excessGroup);
  }

  return { adjustedHours: Math.round(hours * 100) / 100, reason: null };
}

/**
 * Aggregates a trainee's overall progress across all monthly records.
 * trainee: { fieldworkType: 'supervised' | 'concentrated', targetHours: number }
 * monthlyRecords: array of { adjustedHours, unrestrictedHours }
 */
export function totalProgress(trainee, monthlyRecords) {
  const totalAdjusted = monthlyRecords.reduce((sum, m) => sum + (m.adjustedHours || 0), 0);
  const unrestrictedHours = monthlyRecords.reduce((sum, m) => sum + (m.unrestrictedHours || 0), 0);
  const unrestrictedPct = totalAdjusted > 0 ? unrestrictedHours / totalAdjusted : 0;

  return {
    totalHours: totalAdjusted,
    pctToGoal: Math.min(1, totalAdjusted / trainee.targetHours),
    unrestrictedPct,
    unrestrictedOnTrack: unrestrictedPct >= BCABA_REQUIREMENTS.unrestrictedMinPct,
  };
}

/**
 * Combines Supervised + Concentrated hours toward the 1,300-hour total,
 * per the Handbook's "Combining Fieldwork Types to Determine Total Hours" rule.
 * concentratedHours and supervisedHours are actual (unadjusted-by-multiplier) accrued hours.
 */
export function combinedTotal(concentratedHours, supervisedHours) {
  const adjustedConcentrated = concentratedHours * BCABA_REQUIREMENTS.concentratedToSupervisedMultiplier;
  const combined = adjustedConcentrated + supervisedHours;
  return {
    combinedTotal: Math.round(combined * 100) / 100,
    meetsRequirement: combined >= BCABA_REQUIREMENTS.supervised.totalHoursRequired,
  };
}