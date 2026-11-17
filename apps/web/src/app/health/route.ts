export const dynamic = 'force-dynamic';

/** Liveness probe for the container. */
export function GET(): Response {
  return Response.json({ status: 'ok' });
}
