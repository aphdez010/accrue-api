export function calcCompliance(entries) {
  const now = new Date();
  const currentMonth = now.toISOString().slice(0, 7);

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

  // Supervision contacts count this month
  const supervisionContacts = entries.filter(e =>
    e.supervised && String(e.entry_date || '').slice(0, 7) === currentMonth
  ).length;

  // Monthly observation met this month
  const monthlyObservationMet = entries.some(e =>
    e.monthly_observation && String(e.entry_date || '').slice(0, 7) === currentMonth
  );

  // Hours logged this supervisory period (calendar month), checked against 20-130 hour range
  const currentPeriodHours = entries.filter(e =>
    String(e.entry_date || '').slice(0, 7) === currentMonth
  ).reduce((sum, e) => sum + Number(e.hours || 0), 0);
  const periodHoursMet = currentPeriodHours >= 20 && currentPeriodHours <= 130;

  // Contacts requirement: 4 per supervisory period (Supervised Fieldwork)
  const REQUIRED_CONTACTS = 4;
  const contactsMet = supervisionContacts >= REQUIRED_CONTACTS;

  // Task list area coverage
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

  // Hours pace — projected completion date
  let projectedCompletionDate = null;
  if (entries.length > 0 && totalHours > 0) {
    const dates = entries.map(e => new Date(e.entry_date)).filter(d => !isNaN(d.getTime()));
    const earliest = new Date(Math.min(...dates.map(d => d.getTime())));
    const monthsElapsed = Math.max(
      (now.getFullYear() - earliest.getFullYear()) * 12 + (now.getMonth() - earliest.getMonth()),
      1
    );
    const hoursPerMonth = totalHours / monthsElapsed;
    const hoursRemaining = Math.max(2000 - totalHours, 0);
    if (hoursPerMonth > 0 && hoursRemaining > 0) {
      const monthsRemaining = hoursRemaining / hoursPerMonth;
      const projected = new Date(now);
      projected.setMonth(projected.getMonth() + Math.ceil(monthsRemaining));
      projectedCompletionDate = projected.toISOString().slice(0, 7);
    } else if (totalHours >= 2000) {
      projectedCompletionDate = 'complete';
    }
  }

  return {
    totalHours: round(totalHours),
    supervisedHours: round(supervisedHours),
    independentHours: round(independentHours),
    unrestricted: round(unrestricted),
    restricted: round(restricted),
    supervisionPct: round(supervisionPct),
    restrictedPct: round(restrictedPct),
    individualHours: round(individualHours),
    groupHours: round(groupHours),
    individualPct: round(individualPct),
    supervisionMet: supervisionPct >= 5,
    restrictedMet: restrictedPct <= 40,
    individualMet: individualPct >= 50,
    contactsMet,
    currentPeriodHours: round(currentPeriodHours),
    periodHoursMet,
    supervisionContacts,
    monthlyObservationMet,
    taskListCoverage,
    taskListCoverageCount,
    projectedCompletionDate,
  };
}

function round(n) {
  return Math.round(n * 100) / 100;
}
