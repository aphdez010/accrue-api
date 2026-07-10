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

/**
 * Builds the aggregated totals for a Final Fieldwork Verification Form (F-FVF)
 * from a set of already-fetched Monthly Fieldwork Verification (M-FVF) records.
 *
 * This is a PURE function — it does not query the database. The route layer is
 * responsible for fetching the relevant bcaba_monthly_verification rows (filtered
 * by trainee_id, supervisor_id, and date range) and mapping each row into the
 * shape expected here before calling this function.
 *
 * Expected shape of each item in monthlyRecords (map your DB columns to this):
 * {
 *   id: number,                          // bcaba_monthly_verification.id — used to populate the join table
 *   independentHours: number,
 *   supervisedHours: number,
 *   individualSupervisionHours: number,
 *   groupSupervisionHours: number,
 *   complianceMet: boolean               // whether this month passed checkMonthlyCompliance() when signed
 * }
 *
 * Returns the fields needed to populate a bcaba_final_verifications row, plus
 * the list of monthly_verification ids to insert into bcaba_final_verification_months.
 */
export function buildFinalVerification(monthlyRecords) {
  if (!monthlyRecords || monthlyRecords.length === 0) {
    return { error: 'No monthly verifications provided for this trainee/supervisor/date range' };
  }

  const totals = monthlyRecords.reduce(
    (acc, m) => {
      acc.independent += Number(m.independentHours || 0);
      acc.supervised += Number(m.supervisedHours || 0);
      acc.individual += Number(m.individualSupervisionHours || 0);
      acc.group += Number(m.groupSupervisionHours || 0);
      return acc;
    },
    { independent: 0, supervised: 0, individual: 0, group: 0 }
  );

  const totalFieldworkHours = totals.independent + totals.supervised;
  const percentSupervised = totalFieldworkHours > 0
    ? Number(((totals.supervised / totalFieldworkHours) * 100).toFixed(2))
    : 0;

  const allMonthlyRequirementsMet = monthlyRecords.every((m) => m.complianceMet === true);
  const monthlyVerificationIds = monthlyRecords.map((m) => m.id);

  return {
    total_independent_hours: Math.round(totals.independent * 100) / 100,
    total_supervised_hours: Math.round(totals.supervised * 100) / 100,
    total_individual_supervision_hours: Math.round(totals.individual * 100) / 100,
    total_group_supervision_hours: Math.round(totals.group * 100) / 100,
    total_fieldwork_hours: Math.round(totalFieldworkHours * 100) / 100,
    percent_supervised: percentSupervised,
    all_monthly_requirements_met: allMonthlyRequirementsMet,
    monthly_verification_ids: monthlyVerificationIds,
    months_included: monthlyRecords.length,
  };
}