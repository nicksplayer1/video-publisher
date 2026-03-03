 // --- token exchange (mais compatível com open-api.tiktok.com) ---
const tokenUrl =
  "https://open-api.tiktok.com/oauth/access_token/?" +
  new URLSearchParams({
    client_key: clientKey,
    client_secret: clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  }).toString();

console.log("[tiktok/callback] tokenUrl", {
  tokenUrlPreview: tokenUrl.slice(0, 120) + "...",
});

const tokenRes = await fetch(tokenUrl, { method: "GET" });

const rawText = await tokenRes.text();
let tokenJson: any = null;

try {
  tokenJson = JSON.parse(rawText);
} catch {}

console.log("[tiktok/callback] token response", {
  ok: tokenRes.ok,
  status: tokenRes.status,
  bodyPreview: rawText?.slice(0, 400),
});

if (!tokenRes.ok || tokenJson?.data?.error_code || tokenJson?.error) {
  return NextResponse.json(
    {
      ok: false,
      where: "token_exchange",
      status: tokenRes.status,
      response: tokenJson ?? rawText,
    },
    { status: 502 }
  );
}