// Shared logic for the BACB Handbook's Supervisor Qualifications rule:
// a supervisor must be either (a) an active BCBA certified for at least one
// year, meeting the ongoing supervision CEU requirement, or (b) certified for
// less than one year AND receiving monthly consultation from a qualified
// consulting supervisor. This computes which case applies and whether the
// consulting-supervisor requirement is currently being met, from whatever
// dates are on file for a given supervisor row.
//
// Expects a row with: supervisor_certification_date, consulting_supervisor_name,
// consulting_supervisor_last_consultation_date (present on both the BCBA
// `supervisors` table and the BCaBA `bcaba_supervisors` table).
export function computeSupervisorQualification(row, asOf = new Date()) {
  if (!row?.supervisor_certification_date) {
    return {
      isFirstYear: null,
      needsConsultingSupervisor: false,
      consultingSupervisorMet: null,
      reason: 'no_certification_date_on_file',
    };
  }

  const certDate = new Date(row.supervisor_certification_date);
  const oneYearAfterCert = new Date(certDate);
  oneYearAfterCert.setFullYear(oneYearAfterCert.getFullYear() + 1);
  const isFirstYear = asOf < oneYearAfterCert;

  if (!isFirstYear) {
    return { isFirstYear: false, needsConsultingSupervisor: false, consultingSupervisorMet: null, reason: null };
  }

  const hasConsultingSupervisor = !!row.consulting_supervisor_name;
  let consultationIsCurrent = false;
  if (row.consulting_supervisor_last_consultation_date) {
    const lastConsult = new Date(row.consulting_supervisor_last_consultation_date);
    const daysSinceConsult = (asOf - lastConsult) / (1000 * 60 * 60 * 24);
    // Handbook requires MONTHLY consultation; treat "current" as within the
    // last ~31 days rather than requiring exact calendar-month tracking here.
    consultationIsCurrent = daysSinceConsult >= 0 && daysSinceConsult <= 31;
  }

  const consultingSupervisorMet = hasConsultingSupervisor && consultationIsCurrent;
  let reason = null;
  if (!hasConsultingSupervisor) reason = 'no_consulting_supervisor_on_file';
  else if (!consultationIsCurrent) reason = 'consultation_not_current';

  return { isFirstYear: true, needsConsultingSupervisor: true, consultingSupervisorMet, reason };
}
