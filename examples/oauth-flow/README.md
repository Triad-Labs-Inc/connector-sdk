# Google Drive localhost OAuth flow

This example opens a real user-facing Google OAuth flow, catches the redirect on
localhost, saves the refresh token locally, and proves authentication by listing
the account's visible Drive folders.

## One-time Google Cloud setup

1. Open the [Google Cloud console](https://console.cloud.google.com/), create or
   select a project, then go to **APIs & Services → Library**. Search for
   **Google Drive API**, open it, and click **Enable**.
2. Open **Google Auth Platform → Branding**, click **Get started** if prompted,
   enter an app name and support/contact email, and choose **External**.
3. Open **Google Auth Platform → Data Access**, click **Add or remove scopes**,
   add `https://www.googleapis.com/auth/drive.readonly`, and save.
4. Open **Google Auth Platform → Audience**. Leave the publishing status as
   **Testing**, then add the Google account you will sign in with under
   **Test users**.
5. Open **Google Auth Platform → Clients**, click **Create client**, choose
   **Web application**, and add this exact **Authorized redirect URI**:
   `http://localhost:3000/oauth2callback`.
6. Create `examples/oauth-flow/.env.local` with the generated values:

   ```dotenv
   GOOGLE_CLIENT_ID=your-client-id
   GOOGLE_CLIENT_SECRET=your-client-secret
   ```

The local file is gitignored. The script writes the refresh token into it and
restricts its permissions to the current user (`0600`). If you set a different
`PORT`, add its matching localhost callback URI to the Google OAuth client too.

## Run

From this directory:

```bash
pnpm install
pnpm oauth
```

On the first run, click the printed link and approve access. Every run after
that is simply `pnpm oauth`; the saved refresh token skips the consent dance and
the script lists folders immediately.

An empty folder list means auth succeeded but the account currently has no
visible folders. HTTP 403 usually means the Drive API is not enabled for the
project. Revoke access at <https://myaccount.google.com/permissions>.
