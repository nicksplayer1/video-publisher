function unauthorized() {
  return new Response("Unauthorized", { status: 401 });
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const key = searchParams.get("key");

  if (!process.env.WORKER_SECRET || key !== process.env.WORKER_SECRET) {
    return unauthorized();
  }

  return runWorker(); // sua função existente
}

export async function POST(req: Request) {
  const { searchParams } = new URL(req.url);
  const key = searchParams.get("key");

  if (!process.env.WORKER_SECRET || key !== process.env.WORKER_SECRET) {
    return unauthorized();
  }

  return runWorker();
}