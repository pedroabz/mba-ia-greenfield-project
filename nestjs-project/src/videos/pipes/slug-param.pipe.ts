import {
  BadRequestException,
  Injectable,
  type PipeTransform,
} from '@nestjs/common';
import { SLUG_LENGTH } from '../videos.constants';

/**
 * Validates the `slug` route parameter: exactly 11 characters from nanoid's URL-safe
 * alphabet (per phase-03-videos § Validation Rules).
 *
 * A route parameter is not covered by the global `ValidationPipe` + DTO combination,
 * so without this an arbitrary string reaches the repository query.
 */
const SLUG_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${SLUG_LENGTH}}$`);

@Injectable()
export class SlugParamPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!SLUG_PATTERN.test(value)) {
      throw new BadRequestException(
        `slug must be ${SLUG_LENGTH} URL-safe characters`,
      );
    }
    return value;
  }
}
