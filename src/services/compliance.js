import { getBcbaRules, getBcbaTrackRequirements, getFieldworkDeadline, adjustMonthlyHours, combineTrackHours } from '../routes/bcba-rules.js';

export function calcCompliance(entries, track = 'supervised', fieldworkStartDate = null) {
  const now = new Date();
  const currentMonth = now.toISOString().slice(0, 7);

  // Fallback: derive start date from earliest logged entry if the caller
  // doesn't have an explicit fieldwork_start_date on file yet. This is an
  // approximation — the real BACB clock starts when the supervision
  // contract is signed + qualifying coursework begins, which can predate
  // the first logged hour. Once professionals.fieldwork_start_date is set
  // for a trainee, pass it in explicitly and this fallback stops being used
  // for them.
  let startDate = fieldworkStartDate;
  if (!startDate && entries.length > 0) {
    const dates = entries.map(e => new Date(e.entry_date)).filter(d => !isNaN(d.getTime()));
    if (dates.length > 0) startDate = new Date(Math.min(...dates.map(d => d.getTime())));
  }

  const rules = startDate ? getBcbaRules(track, startDate) : getBcbaTrackRequirements(track);

  // --- Lifetime raw totals (unadjusted, for transparency/audit trail) ---
  const totalHours = entries.reduce((sum, e) => sum + Number(e.hours || 0), 0);
  const supervisedHours = entries.filter(e => e.supervised).reduce((sum, e) => sum + Number(e.hours || 0), 0);
  const independentHours = entries.filter(e => !e.supervised).reduce((sum, e) => sum + Number(e.hours || 0), 0);
  const unrestricted = entries.filter(e => e.experience_type === 'Unrestricted Hours').reduce((sum, e) => sum + Number(e.hours || 0), 0);
  const restricted = entries.filter(e => e.experience_type === 'Restricted Hours').reduce((sum, e) => sum + Number(e.hours || 0), 0);
  const individualHours = entries.filter(e => e.supervised && e.supervision_format === 'Individual').reduce((sum, e) => sum + Number(e.hours || 0), 0);
  const groupHours = entries.filter(e => e.supervised && e.supervision_format === 'Group').reduce((sum, e) => sum + Number(e.hours || 0), 0);

  const supervisionPct = totalHours > 0 ? (supervisedHours / totalHours) * 100 : 0;
  const restrictedPct = totalHours > 0 ? (restricted / totalHours) * 100 : 0;
  const individualPct = supervisedHours > 0 ? (individualHours / supervisedHours) * 100 : 0;

  // --- Per-month breakdown + BACB adjustment engine (p.23) ---
  // Concentrated hours may not be prorated or adjusted per the handbook —
  // a non-compliant concentrated month simply contributes 0 eligible hours.
  const monthKeys = [...new Set(entries.map(e => toMonthKey(e.entry_date)).filter(Boolean))];

  const monthlyBreakdown = monthKeys.map(monthKey => {
    const monthEntries = entries.filter(e => toMonthKey(e.entry_date) === monthKey);

    const monthIndependent = monthEntries.filter(e => !e.supervised).reduce((sum, e) => sum + Number(e.hours || 0), 0);
    const monthIndividual = monthEntries.filter(e => e.supervised && e.supervision_format === 'Individual').reduce((sum, e) => sum + Number(e.hours || 0), 0);
    const monthGroup = monthEntries.filter(e => e.supervised && e.supervision_format === 'Group').reduce((sum, e) => sum + Number(e.hours || 0), 0);

    // Contact count is currently inferred as "number of supervised entries
    // logged this month" — same proxy the old code used. This is only as
    // accurate as trainees logging one entry per actual contact. If contacts
    // and hours end up logged as separate concepts later, swap this out.
    const contactsOccurred = monthEntries.filter(e => e.supervised).length;
    const observationOccurred = monthEntries.some(e => e.monthly_observation);
    // Cumulative minutes across the month's entries — only meaningful under
    // 2027 rules (rules.observationRequirement.type === 'minutes'), but
    // computed unconditionally since it's cheap and adjustMonthlyHours()
    // decides which field to use based on the active rule set.
    const observationMinutes = monthEntries.reduce((sum, e) => sum + Number(e.observation_minutes || 0), 0);
    const obsReq = rules.observationRequirement;
    const observationMet = obsReq.type === 'minutes'
      ? observationMinutes >= obsReq.value
      : observationOccurred;

    if (track === 'concentrated') {
      const raw = monthIndependent + monthIndividual + monthGroup;
      const compliant = observationMet
        && raw >= rules.hoursPerPeriod.min
        && raw <= rules.hoursPerPeriod.max
        && contactsOccurred >= rules.contactsPerMonth
        && monthGroup <= monthIndividual
        && (monthIndividual + monthGroup) / raw >= rules.supervisionPct;

      return {
        month: monthKey,
        rawHours: round(raw),
        eligibleHours: compliant ? round(raw) : 0,
        reasons: compliant ? [] : ['concentrated_hours_not_prorated_see_handbook_p23'],
      };
    }

    const { eligibleHours, reasons } = adjustMonthlyHours({
      independentHours: monthIndependent,
      supervisedIndividualHours: monthIndividual,
      supervisedGroupHours: monthGroup,
      contactsOccurred,
      observationOccurred,
      observationMinutes,
    }, rules);

    return {
      month: monthKey,
      rawHours: round(monthIndependent + monthIndividual + monthGroup),
      eligibleHours,
      reasons,
    };
  });

  const totalEligibleHours = round(monthlyBreakdown.reduce((sum, m) => sum + m.eligibleHours, 0));
  const currentMonthData = monthlyBreakdown.find(m => m.month === currentMonth);
  const currentPeriodHours = currentMonthData?.rawHours ?? 0;
  const periodHoursMet = currentPeriodHours >= rules.hoursPerPeriod.min && currentPeriodHours <= rules.hoursPerPeriod.max;

  const supervisionContacts = entries.filter(e =>
    e.supervised && toMonthKey(e.entry_date) === currentMonth
  ).length;
  const contactsMet = supervisionContacts >= rules.contactsPerMonth;

  const currentMonthObservationMinutes = entries
    .filter(e => toMonthKey(e.entry_date) === currentMonth)
    .reduce((sum, e) => sum + Number(e.observation_minutes || 0), 0);
  const monthlyObservationMet = rules.observationRequirement.type === 'minutes'
    ? currentMonthObservationMinutes >= rules.observationRequirement.value
    : entries.some(e =>
        e.monthly_observation && toMonthKey(e.entry_date) === currentMonth
      );

  // Task list area coverage (unrelated to BACB fieldwork compliance —
  // this maps to a custom activity taxonomy, not the BCBA Test Content
  // Outline's 9 content areas. Left as-is; flag if this needs realigning
  // to the actual TCO letters A-I from the exam blueprint.)
  const TASK_AREAS = [
    'A. Measurement', 'B. Skill Acquisition', 'C. Behavior Reduction',
    'D. Documentation & Reporting', 'E. Professional Conduct',
    'F. Behavior Assessment', 'G. Behavior-Change Procedures',
    'H. Selecting & Implementing Interventions', 'I. Personnel Supervision',
  ];
  const coveredAreas = new Set(entries.map(e => e.task_list_area).filter(Boolean));
  const taskListCoverage = TASK_AREAS.map(area => ({
    area,
    covered: coveredAreas.has(area),
  }));
  const taskListCoverageCount = coveredAreas.size;

  // Projected completion now uses ELIGIBLE hours, not raw — a trainee
  // logging plenty of raw hours but missing contacts/observations
  // shouldn't see an optimistic completion date.
  let projectedCompletionDate = null;
  if (startDate && totalEligibleHours > 0) {
    const monthsElapsed = Math.max(
      (now.getFullYear() - startDate.getFullYear()) * 12 + (now.getMonth() - startDate.getMonth()),
      1
    );
    const hoursPerMonth = totalEligibleHours / monthsElapsed;
    const hoursRemaining = Math.max(rules.totalHoursRequired - totalEligibleHours, 0);
    if (hoursPerMonth > 0 && hoursRemaining > 0) {
      const monthsRemaining = hoursRemaining / hoursPerMonth;
      const projected = new Date(now);
      projected.setMonth(projected.getMonth() + Math.ceil(monthsRemaining));
      projectedCompletionDate = projected.toISOString().slice(0, 7);
    } else if (totalEligibleHours >= rules.totalHoursRequired) {
      projectedCompletionDate = 'complete';
    }
  }

  const fieldworkDeadline = startDate ? getFieldworkDeadline(startDate) : null;

  // Combined track progress — only relevant if a trainee has logged hours
  // under both Supervised and Concentrated fieldwork_type at some point
  // (e.g. switched tracks mid-fieldwork). Per BACB Handbook p.15, the 1.33
  // multiplier is informational only: it tells the trainee whether their
  // MIXED hours clear the 2,000-hour combined minimum, and must never be
  // written back to totalHours/totalEligibleHours or the M-FVF.
  const supervisedTrackHours = entries.filter(e => e.fieldwork_type === 'supervised').reduce((sum, e) => sum + Number(e.hours || 0), 0);
  const concentratedTrackHours = entries.filter(e => e.fieldwork_type === 'concentrated').reduce((sum, e) => sum + Number(e.hours || 0), 0);
  const combinedTrackProgress = (supervisedTrackHours > 0 && concentratedTrackHours > 0)
    ? {
        supervisedHours: round(supervisedTrackHours),
        concentratedHours: round(concentratedTrackHours),
        ...combineTrackHours(supervisedTrackHours, concentratedTrackHours),
      }
    : null;

  return {
    track,
    totalHoursRequired: rules.totalHoursRequired,
    totalHours: round(totalHours),
    totalEligibleHours,
    hoursAdjustmentApplied: totalEligibleHours !== round(totalHours),
    supervisedHours: round(supervisedHours),
    independentHours: round(independentHours),
    unrestricted: round(unrestricted),
    restricted: round(restricted),
    supervisionPct: round(supervisionPct),
    restrictedPct: round(restrictedPct),
    individualHours: round(individualHours),
    groupHours: round(groupHours),
    individualPct: round(individualPct),
    supervisionMet: supervisionPct >= (rules.supervisionPct * 100),
    restrictedMet: restrictedPct <= ((1 - rules.unrestrictedMinPct) * 100),
    individualMet: individualPct >= (rules.individualSupervisionMinPct * 100),
    contactsMet,
    contactsRequired: rules.contactsPerMonth,
    currentPeriodHours: round(currentPeriodHours),
    periodHoursMet,
    supervisionContacts,
    monthlyObservationMet,
    monthlyBreakdown,
    fieldworkDeadline: fieldworkDeadline ? fieldworkDeadline.toISOString().slice(0, 10) : null,
    fieldworkStartDateSource: fieldworkStartDate ? 'explicit' : 'inferred_from_earliest_entry',
    taskListCoverage,
    taskListCoverageCount,
    projectedCompletionDate,
    combinedTrackProgress,
  };
}

function toMonthKey(entryDate) {
  const d = entryDate instanceof Date ? entryDate : new Date(entryDate);
  if (isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 7);
}

function round(n) {
  return Math.round(n * 100) / 100;
}