import type { DbHandle } from '@app/db';
import type { TenantRole } from '@app/shared';
import {
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { fromNodeHeaders } from 'better-auth/node';
import { sql } from 'drizzle-orm';
import type { Response } from 'express';
import {
  GENERAL_LIMIT,
  RATE_LIMIT_KEY,
  RateLimiter,
  type RouteLimit,
} from '../common/rate-limit.js';
import { API_CONFIG, trustedOrigin, type ApiConfig } from '../config.js';
import { AUTH, DB } from '../infra/tokens.js';
import type { Auth } from './auth.js';
import type { Principal, RequestWithPrincipal } from './principal.js';

/**
 * Who may call a route. Routes without an annotation default to `member`,
 * so forgetting the decorator fails closed.
 */
export type AccessLevel =
  'public' | 'webhook' | 'signed-in' | 'member' | 'owner' | 'platform-admin';

const ACCESS_KEY = 'access-level';
export const Access = (level: AccessLevel) => SetMetadata(ACCESS_KEY, level);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * One guard, in a fixed order:
 * 1. CSRF: state-changing requests must carry an Origin header equal to the
 *    web app's origin. Session cookies are SameSite=Lax as a second layer.
 * 2. Session: resolved through Better Auth from the httpOnly cookie.
 * 3. Membership: looked up through `auth_membership()`, the only cross-tenant
 *    read app_user is allowed.
 * 4. Per-user rate limits.
 * 5. The route's access level.
 */
@Injectable()
export class AccessGuard implements CanActivate {
  private readonly origin: string;

  constructor(
    private readonly reflector: Reflector,
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(DB) private readonly db: DbHandle,
    private readonly rateLimiter: RateLimiter,
    @Inject(API_CONFIG) config: ApiConfig,
  ) {
    this.origin = trustedOrigin(config);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithPrincipal>();
    const level =
      this.reflector.getAllAndOverride<AccessLevel | undefined>(ACCESS_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'member';

    if (level === 'webhook') return true;

    if (!SAFE_METHODS.has(request.method) && request.header('origin') !== this.origin) {
      throw new ForbiddenException(
        'Request blocked: it did not come from this app. Reload the page and try again.',
      );
    }

    if (level === 'public') {
      // No user yet: a route's own limit counts by address (behind the web
      // proxy that is one address, so it acts as a ceiling for the route).
      const publicLimit = this.reflector.getAllAndOverride<RouteLimit | undefined>(RATE_LIMIT_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (publicLimit) {
        await this.rateLimiter.consume(
          `ip:${request.ip ?? 'unknown'}`,
          publicLimit,
          context.switchToHttp().getResponse<Response>(),
        );
      }
      return true;
    }

    const session = await this.auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    if (!session) {
      throw new UnauthorizedException('Your session has ended. Sign in to continue.');
    }

    const membership = await this.db.db.execute<{ tenant_id: string; role: TenantRole }>(
      sql`select tenant_id, role from auth_membership(${session.user.id})`,
    );
    const row = membership.rows[0];
    const principal: Principal = {
      userId: session.user.id,
      name: session.user.name,
      email: session.user.email,
      platformRole: session.user.platformRole === 'admin' ? 'admin' : null,
      tenantId: row?.tenant_id ?? null,
      role: row?.role ?? null,
    };
    request.principal = principal;

    // Per-user limits (brief §7): one for everything, tighter ones on routes that write.
    const response = context.switchToHttp().getResponse<Response>();
    await this.rateLimiter.consume(principal.userId, GENERAL_LIMIT, response);
    const routeLimit = this.reflector.getAllAndOverride<RouteLimit | undefined>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (routeLimit) await this.rateLimiter.consume(principal.userId, routeLimit, response);

    switch (level) {
      case 'signed-in':
        return true;
      case 'platform-admin':
        if (principal.platformRole === 'admin') return true;
        throw new ForbiddenException('Only platform admins can do this.');
      case 'member':
        if (principal.tenantId) return true;
        throw new ForbiddenException('Your account is not part of a business yet.');
      case 'owner':
        if (principal.role === 'owner') return true;
        throw new ForbiddenException('Only the business owner can do this.');
    }
  }
}
