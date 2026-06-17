export function calcCompliance(entries) {
  const now = new Date();
  const currentMonth = now.toISOString().slice(0, 7);

  const totalHours = entries.reduce((sum, e) => sum + Number(e.hours || 0), 0);
  const supervisedHours = entries.filter(e => e.supervised).reduce((sum, e) => sum + Number(e.hours || 0), 0);
  const independentHours = entries.filter(e => !e.supervised).reduce((sum, e) => sum + Number(e.hours || 0), 0);
  const unrestricted = entries.filter(e => e.experience_type === 'Unrestricted Hours').reduce((sum, e) => sum + Number(e.hours || 0), 0);
  const restricted = entries.filter(e => e.experience_type === 'Restricted Hours').reduce((sum, e) => sum + Number(e.hours || 0), 0);

  const supervisionPct = totalHours > 0 ? (supervisedHours / totalHours) * 100 : 0;
  const restrictedPct = totalHours > 0 ? (restricted / totalHours) * 100 : 0;

  // Supervision contacts count this month
  const supervisionContacts = entries.filter(e =>
    e.supervised && String(e.entry_date || '').slice(0, 7) === currentMonth
  ).length;

  // Monthly observation met this month
  const monthlyObservationMet = entries.some(e =>
    e.monthly_observation && String(e.entry_date || '').slice(0, 7) === currentMonth
  );

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
    supervisionMet: supervisionPct >= 5,
    restrictedMet: restrictedPct <= 50,
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
