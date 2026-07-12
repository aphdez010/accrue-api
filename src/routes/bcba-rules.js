// BCBA Supervised Fieldwork track requirements
// Source: BACB Supervised Fieldwork Requirements FAQ (bacb.com/faqs-supervised-fieldwork-requirements)
//
// Only totalHoursRequired and supervisionPct are currently differentiated by track here.
// Monthly contact count (4/period) and the 20-130hr monthly range in compliance.js are
// NOT yet split by track for BCBA (unlike bcaba-rules.js, which does split these for BCaBA).
// Verify against the BACB Handbook (rev 260130) before encoding track-specific monthly
// contact/observation requirements — the current values are a deliberately conservative MVP.

export const BCBA_REQUIREMENTS = {
  supervised: {
    totalHoursRequired: 2000,
    supervisionPct: 0.05,
  },
  concentrated: {
    totalHoursRequired: 1500,
    supervisionPct: 0.10,
  },
};

export function getBcbaTrackRequirements(track) {
  return BCBA_REQUIREMENTS[track] || BCBA_REQUIREMENTS.supervised;
}