/**
 * The whole article as one HTML string, in reading order. Rendering it once fixes the numbers of
 * citations, figures, tables, and equations (each numbered at first mention), so this is the only
 * place that decides the order.
 */
import { front } from './sections/front';
import { model } from './sections/model';
import { calibration } from './sections/calibration';
import { validation } from './sections/validation';
import { scenarios } from './sections/scenarios';
import { howToCite, limitations, references, reproducibility } from './sections/closing';

export function article(): string {
  return front() + model() + calibration() + validation() + scenarios() + limitations() + reproducibility() + howToCite() + references();
}
