// Deprecated — replaced by /query route
export async function POST() {
  return Response.json({ error: "Use /query endpoint instead" }, { status: 410 });
}
