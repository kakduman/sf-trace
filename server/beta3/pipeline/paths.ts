import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '../../..');
/** downloads (gitignored) */
export const RAW = process.env.BETA3_RAW ?? path.join(ROOT, 'data/beta3/raw');
/** intermediate products (gitignored) */
export const WORK = process.env.BETA3_WORK ?? path.join(ROOT, 'data/beta3/work');
/** observed data and published parameters, kept in git with their sources */
export const REFERENCE = path.join(ROOT, 'server/beta3/reference');
/** the model bundle the browser loads */
export const BUNDLE = path.join(ROOT, 'client/beta3/model');

/**
 * A network variant for backcasts (e.g. BETA3_VARIANT=2024 builds the June 2024 Muni schedule):
 * its transit, skims and bundle go to separate work files and never touch the app's bundle.
 */
export const VARIANT = process.env.BETA3_VARIANT ?? '';
export const variantFile = (name: string) => (VARIANT ? name.replace(/(\.[a-z.]+)$/, `-${VARIANT}$1`) : name);
