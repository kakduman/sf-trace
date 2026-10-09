/**
 * Quick's measured error against Precise on the test scenarios (server/beta3/pipeline/runmodes.ts
 * writes server/beta3/reference/runmodes.json), for the page's note on Quick results.
 */
const files = import.meta.glob('../../server/beta3/reference/runmodes.json', { eager: true, import: 'default' }) as Record<string, { summary?: RunModeError & { streets?: RunModeError } }>;
/** Quick's largest error on a group of test scenarios (percent of Precise's change) */
export interface RunModeError {
  scenarios: number;
  transitTripsPct: number;
  muniBoardingsPct: number;
  timeSavingsPct?: number;
}
export const RUNMODE_ERROR = Object.values(files)[0]?.summary ?? null;
