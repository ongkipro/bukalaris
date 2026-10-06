// Liveness only: does not touch the database so a DB outage does not restart-loop the container.
export function GET() {
  return Response.json({ ok: true });
}
