// /app/api/worker/run/route.ts
export async function GET() {
  return runWorker();
}

export async function POST() {
  return runWorker();
}

async function runWorker() {
  // ... sua lógica atual do worker ...
  return Response.json({ ok: true });
}