// BCBA Supervised Fieldwork track requirements
// Source: BACB Board Certified Behavior Analyst Handbook, Updated 06/2026
// (verified directly against the source PDF, "2027 Eligibility Requirements"
// section, pp. 25-28 — "Overview of Fieldwork Requirements" table).
//
// Two rule sets are maintained because the BACB's 2027 changes apply only to trainees
// whose fieldwork clock starts on/after Jan 1, 2027 — trainees already accruing hours
// stay on the current rules for the duration of that fieldwork experience. Do NOT collapse
// this into a single rule set or gate it on "today's date"; gate it on fieldworkStartDate.
//
// VERIFIED 07/2026 against the BCBA Handbook (06/2026) 2027 fieldwork requirements
// table: the "Number of contacts with supervisor per supervisory period" row present
// in the 2022 table is absent entirely from the 2027 table. It is replaced by an
// "Observations of trainee with client per supervisory period" row expressed in
// cumulative minutes (60 Supervised / 90 Concentrated) rather than a count. So under
// 2027, only percentage-of-hours-supervised and cumulative observation-minutes apply;
// there is no minimum number of monthly supervisor-trainee contacts. contactsPerMonth
// is therefore null for both 2027 tracks, and adjustMonthlyHours() must skip the
// contacts-proration step when it's null.
//
// NOTE — intentional BCBA/BCaBA asymmetry, not a copy-paste bug: the parallel BCaBA
// 2027 pathway (BCaBA Handbook, verified 06/2026) KEEPS its 4/6 contacts-per-month
// requirement unchanged in 2027 — only its observation requirement moves to cumulative
// minutes. Only the BCBA pathway drops contacts entirely. Do not "fix" bcaba-rules.js
// to match this file's contactsPerMonth: null; that would be incorrect for BCaBA.
export const BCBA_RULES_2022 = {
  supervised: {
    totalHoursRequired: 2000,
    supervisionPct: 0.05,
    contactsPerMonth: 4,
    hoursPerPeriod: { min: 20, max: 130 },
    observationRequirement: { type: 'count', value: 1, cumulative: false },
    individualSupervisionMinPct: 0.5,
    unrestrictedMinPct: 0.6,
  },
  concentrated: {
    totalHoursRequired: 1500,
    supervisionPct: 0.10,
    contactsPerMonth: 6,
    hoursPerPeriod: { min: 20, max: 130 },
    observationRequirement: { type: 'count', value: 1, cumulative: false },
    individualSupervisionMinPct: 0.5,
    unrestrictedMinPct: 0.6,
  },
};
export const BCBA_RULES_2027 = {
  supervised: {
    totalHoursRequired: 2000,
    supervisionPct: 0.05,
    contactsPerMonth: null, // eliminated under 2027 — see file header note
    hoursPerPeriod: { min: 20, max: 160 },
    observationRequirement: { type: 'minutes', value: 60, cumulative: true },
    individualSupervisionMinPct: 0.5,
    unrestrictedMinPct: 0.6,
  },
  concentrated: {
    totalHoursRequired: 1500,
    supervisionPct: 0.075,
    contactsPerMonth: null, // eliminated under 2027 — see file header note
    hoursPerPeriod: { min: 20, max: 160 },
    observationRequirement: { type: 'minutes', value: 90, cumulative: true },
    individualSupervisionMinPct: 0.5,
    unrestrictedMinPct: 0.6,
  },
};
const RULES_2027_CUTOVER = new Date('2027-01-01T00:00:00Z');
/**
 * Returns the correct rule set for a trainee based on when their fieldwork
 * clock started, NOT the current date. A trainee who started in 2026 stays
 * on 2022 rules for the life of that fieldwork experience even after
 * Jan 1, 2027 passes.
 *
 * @param {'supervised'|'concentrated'} track
 * @param {Date|string} fieldworkStartDate - date the trainee's fieldwork clock started
 */
export function getBcbaRules(track, fieldworkStartDate) {
  const startDate = fieldworkStartDate instanceof Date
    ? fieldworkStartDate
    : new Date(fieldworkStartDate);
  const ruleSet = startDate >= RULES_2027_CUTOVER ? BCBA_RULES_2027 : BCBA_RULES_2022;
  return ruleSet[track] || ruleSet.supervised;
}
// Kept for backward compatibility with existing callers that don't yet pass
// a fieldworkStartDate. TODO: migrate all callers to getBcbaRules() and remove this.
export function getBcbaTrackRequirements(track) {
  return BCBA_RULES_2022[track] || BCBA_RULES_2022.supervised;
}
/**
 * Combines mixed Supervised + Concentrated hours toward the 2,000-hour total,
 * per BACB Handbook p.15 "Combining Fieldwork Types to Determine Total Hours."
 * The 1.33 multiplier applies ONLY to Concentrated hours and ONLY for the
 * purpose of checking whether the combined minimum has been reached — it is
 * never written back to the trainee's actual hour totals or M-FVF.
 *
 * @param {number} supervisedHours - raw accrued Supervised Fieldwork hours
 * @param {number} concentratedHours - raw accrued Concentrated Supervised Fieldwork hours
 * @returns {{ adjustedTotal: number, meetsMinimum: boolean }}
 */
export function combineTrackHours(supervisedHours, concentratedHours) {
  const adjustedTotal = supervisedHours + (concentratedHours * 1.33);
  return {
    adjustedTotal: Math.round(adjustedTotal * 100) / 100,
    meetsMinimum: adjustedTotal >= BCBA_RULES_2022.supervised.totalHoursRequired,
  };
}
/**
 * Fieldwork must complete within 5 continuous years, calculated by calendar
 * month (not date-to-date). Per BACB Handbook p.16.
 *
 * @param {Date|string} fieldworkStartDate
 * @returns {Date} the last calendar month in which fieldwork hours may be accrued
 */
export function getFieldworkDeadline(fieldworkStartDate) {
  const startDate = fieldworkStartDate instanceof Date
    ? fieldworkStartDate
    : new Date(fieldworkStartDate);
  const deadline = new Date(startDate);
  deadline.setFullYear(deadline.getFullYear() + 5);
  deadline.setDate(0); // roll back to end of the prior month → last day of the 5-year window's final month
  return deadline;
}
/**
 * Implements the "Adjusting and Documenting Fieldwork Hours When Monthly
 * Requirements Are Not Met" table, BACB Handbook p.23. Given a month's raw
 * logged activity, returns the ELIGIBLE hours after applying BACB's
 * adjustment rules — this is what should be shown on the M-FVF before
 * signing, not the raw total.
 *
 * Concentrated hours may NOT be prorated or adjusted per the handbook note;
 * callers must not invoke this for concentrated-track months.
 *
 * @param {Object} month
 * @param {number} month.independentHours
 * @param {number} month.supervisedIndividualHours
 * @param {number} month.supervisedGroupHours
 * @param {number} month.contactsOccurred
 * @param {boolean} month.observationOccurred - used when rules.observationRequirement.type === 'count'
 * @param {number} [month.observationMinutes] - cumulative minutes; used when rules.observationRequirement.type === 'minutes'
 * @param {Object} rules - result of getBcbaRules(track, fieldworkStartDate)
 * @returns {{ eligibleHours: number, eligiblePct: number, reasons: string[] }}
 */
export function adjustMonthlyHours(month, rules) {
  const reasons = [];
  let {
    independentHours,
    supervisedIndividualHours,
    supervisedGroupHours,
  } = month;
  // 1. Observation requirement not met → whole month is ineligible.
  // Under 2022 rules this is a simple count (did an observation happen).
  // Under 2027 rules it's cumulative minutes (60 Supervised / 90 Concentrated)
  // per BACB Handbook p.25-28 — see observationRequirement on the rule set.
  const obsReq = rules.observationRequirement;
  const observationMet = obsReq.type === 'minutes'
    ? (month.observationMinutes || 0) >= obsReq.value
    : !!month.observationOccurred;
  if (!observationMet) {
    reasons.push(obsReq.type === 'minutes' ? 'observation_minutes_below_minimum' : 'no_observation');
    return { eligibleHours: 0, eligiblePct: 0, reasons };
  }
  let totalHours = independentHours + supervisedIndividualHours + supervisedGroupHours;
  // 2. Fewer than min hours → whole month is ineligible.
  if (totalHours < rules.hoursPerPeriod.min) {
    reasons.push('below_minimum_hours');
    return { eligibleHours: 0, eligiblePct: 0, reasons };
  }
  // 3. More than max hours → trim independent hours down to the max.
  if (totalHours > rules.hoursPerPeriod.max) {
    const excess = totalHours - rules.hoursPerPeriod.max;
    independentHours = Math.max(0, independentHours - excess);
    totalHours = independentHours + supervisedIndividualHours + supervisedGroupHours;
    reasons.push('trimmed_to_max_hours');
  }
  // 4. Group supervision may not exceed individual supervision.
  if (supervisedGroupHours > supervisedIndividualHours) {
    supervisedGroupHours = supervisedIndividualHours;
    totalHours = independentHours + supervisedIndividualHours + supervisedGroupHours;
    reasons.push('group_trimmed_to_individual');
  }
  // 5. Not enough supervisor-trainee contacts → prorate total hours by the
  //    fraction of required contacts that actually occurred. Skipped entirely
  //    when rules.contactsPerMonth is null — the 2027 rule set has no contacts
  //    requirement at all (see file header note).
  if (rules.contactsPerMonth != null && month.contactsOccurred < rules.contactsPerMonth) {
    const contactRatio = month.contactsOccurred / rules.contactsPerMonth;
    totalHours = Math.floor(totalHours * contactRatio);
    reasons.push('prorated_for_contacts');
  }
  // 6. Supervision % below the monthly minimum → reduce independent hours
  //    until the % is met (recompute total after step 5's proration).
  const supervisedTotal = supervisedIndividualHours + supervisedGroupHours;
  let eligibleTotal = totalHours;
  const currentPct = supervisedTotal / eligibleTotal;
  if (currentPct < rules.supervisionPct) {
    // supervisedTotal / (supervisedTotal + independentAllowed) = supervisionPct
    const maxIndependentAllowed = (supervisedTotal / rules.supervisionPct) - supervisedTotal;
    eligibleTotal = supervisedTotal + Math.max(0, maxIndependentAllowed);
    reasons.push('independent_hours_reduced_for_supervision_pct');
  }
  return {
    eligibleHours: Math.round(eligibleTotal * 100) / 100,
    eligiblePct: Math.round((eligibleTotal / (independentHours + supervisedIndividualHours + supervisedGroupHours || 1)) * 10000) / 100,
    reasons,
  };
}