# Keyless service-account impersonation

Live check for the `access-token` credential type. Your own Google login mints
short-lived Drive tokens for a service account, so no key file is ever
downloaded. This is the pattern a server uses to hold per-customer service
accounts without storing their keys.

## One-time setup

```bash
PROJECT=<your-gcp-project>
gcloud services enable drive.googleapis.com iamcredentials.googleapis.com --project $PROJECT
gcloud iam service-accounts create brain-test --project $PROJECT
SA=brain-test@$PROJECT.iam.gserviceaccount.com

# Let your own account mint tokens for it (no key needed)
gcloud iam service-accounts add-iam-policy-binding $SA --project $PROJECT \
  --member="user:$(gcloud config get-value account)" \
  --role=roles/iam.serviceAccountTokenCreator

# Source credentials for the script
gcloud auth application-default login
```

In Google Drive, share a test folder with `$SA` as **Viewer**. IAM changes can
take a minute or two to apply.

## Run

```bash
cd examples/impersonation
pnpm install
SERVICE_ACCOUNT=$SA pnpm start --folder <folder-id-or-url>
SERVICE_ACCOUNT=$SA pnpm start --folder <folder-id-or-url> --force-refresh
```

Expected: the folder's files are listed, one file's content is fetched, and
`--force-refresh` mints more than one token. A folder that is not shared with
the service account fails with a not-found error.
