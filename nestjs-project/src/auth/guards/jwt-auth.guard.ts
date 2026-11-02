import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { BEARER_PREFIX } from '../auth.constants';
import { JwtPayload } from '../auth.types';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string>; user: unknown }>();
    const authHeader = request.headers?.authorization;

    if (isPublic) {
      // A public route still populates `request.user` when a valid token happens to
      // be present, and never rejects. Some routes are open to anonymous callers yet
      // must behave differently for the resource's OWNER — `GET /videos/{slug}`
      // serves a `ready` video to anyone but only shows a non-`ready` one to its
      // owner (see phase-03-videos § Authorization Matrix). Returning early here
      // would leave `request.user` undefined even for a correctly authenticated
      // owner, making that rule impossible to express.
      await this.tryAttachUser(request, authHeader);
      return true;
    }

    if (!authHeader || !authHeader.startsWith(BEARER_PREFIX)) {
      throw new UnauthorizedException();
    }

    const token = authHeader.slice(BEARER_PREFIX.length);

    try {
      const payload = await this.jwtService.verifyAsync<JwtPayload>(token);
      request.user = payload;
      return true;
    } catch {
      throw new UnauthorizedException();
    }
  }

  /**
   * Best-effort authentication for public routes. An absent, malformed, expired or
   * forged token simply leaves `request.user` unset — it is never an error here,
   * because the route is open to anonymous callers by definition.
   */
  private async tryAttachUser(
    request: { user: unknown },
    authHeader: string | undefined,
  ): Promise<void> {
    if (!authHeader?.startsWith(BEARER_PREFIX)) return;

    try {
      request.user = await this.jwtService.verifyAsync<JwtPayload>(
        authHeader.slice(BEARER_PREFIX.length),
      );
    } catch {
      // Intentionally swallowed: see the doc comment above.
    }
  }
}
