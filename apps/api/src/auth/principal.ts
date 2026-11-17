import type { TenantRole } from '@app/shared';
import { createParamDecorator, ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/** Who is making the request, resolved once per request by AccessGuard. */
export interface Principal {
  userId: string;
  name: string;
  email: string;
  platformRole: 'admin' | null;
  tenantId: string | null;
  role: TenantRole | null;
}

/** A principal that belongs to a tenant. */
export interface MemberPrincipal extends Principal {
  tenantId: string;
  role: TenantRole;
}

export type RequestWithPrincipal = Request & { principal?: Principal };

export function isMember(principal: Principal): principal is MemberPrincipal {
  return principal.tenantId !== null && principal.role !== null;
}

export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Principal => {
    const principal = ctx.switchToHttp().getRequest<RequestWithPrincipal>().principal;
    if (!principal) {
      // Only reachable if a route is marked public but still asks for a principal.
      throw new ForbiddenException('No signed-in user for this request.');
    }
    return principal;
  },
);

/** Like CurrentPrincipal, for routes that require tenant membership. */
export const CurrentMember = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): MemberPrincipal => {
    const principal = ctx.switchToHttp().getRequest<RequestWithPrincipal>().principal;
    if (!principal || !isMember(principal)) {
      throw new ForbiddenException('This needs a member of a business account.');
    }
    return principal;
  },
);
