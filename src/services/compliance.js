export function calcCompliance(entries) {
  const totalHours = entries.reduce((sum, e) => sum + Number(e.hours), 0);
  const supervisedHours = entries
    .filter(e => e.supervised)
    .reduce((sum, e) => sum + Number(e.hours), 0);

  const unrestricted = entries
    .filter(e => e.experience_type === 'Unrestricted Hours')
    .reduce((sum, e) => sum + Number(e.hours), 0);

  const restricted = entries
    .filter(e => e.experience_type === 'Restricted Hours')
    .reduce((sum, e) => sum + Number(e.hours), 0);

  const supervisionPct = totalHours > 0
    ? (supervisedHours / totalHours) * 100
    : 0;

  const restrictedPct = totalHours > 0
    ? (restricted / totalHours) * 100
    : 0;

  return {
    totalHours: round(totalHours),
    supervisedHours: round(supervisedHours),
    unrestricted: round(unrestricted),
    restricted: round(restricted),
    supervisionPct: round(supervisionPct),
    restrictedPct: round(restrictedPct),
    supervisionMet: supervisionPct >= 5,
    restrictedMet: restrictedPct <= 50,
  };
}

function round(n) {
  return Math.round(n * 100) / 100;
}
