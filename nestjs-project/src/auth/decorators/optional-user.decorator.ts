import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { JwtPayload } from '../auth.types';

/**
 * The authenticated user, or `null` on an anonymous call.
 *
 * Use on routes marked `@Public()` that are open to everyone but behave differently
 * for the resource's owner. `CurrentUser` declares a non-nullable `JwtPayload` and
 * would lie about the type on those routes, where `request.user` is legitimately
 * absent (see `JwtAuthGuard.tryAttachUser`).
 */
export const OptionalUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): JwtPayload | null => {
    const request = ctx.switchToHttp().getRequest<{ user?: JwtPayload }>();
    return request.user ?? null;
  },
);
