import { google } from "googleapis";

export function getYoutubeClient(refreshToken: string) {
  const clientId = process.env.GOOGLE_CLIENT_ID!;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET!;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI!;

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  oauth2.setCredentials({
    refresh_token: refreshToken,
  });

  return google.youtube({ version: "v3", auth: oauth2 });
}