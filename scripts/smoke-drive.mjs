// Read-only live test. Load credentials through your shell or Node's --env-file.
// Logs counts and outcomes only; never document text, URLs, IDs, or credentials.
import assert from "node:assert/strict";
import { createGDriveConnector } from "../packages/gdrive/dist/index.js";

async function main() {
  if (!process.env.GOOGLE_FOLDER_ID) throw new Error("GOOGLE_FOLDER_ID is required");
  const connector = createGDriveConnector({
    auth: {
      type: "oauth", clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET, refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
    },
    scope: { folder: process.env.GOOGLE_FOLDER_ID },
  });
  const signal = AbortSignal.timeout(120_000);
  const documents = new Map();
  let saved;
  for await (const event of connector.iterateChanges(undefined, { signal })) {
    if (event.kind === "document") documents.set(event.document.providerDocId, event.document);
    if (event.kind === "checkpoint") { saved = JSON.parse(JSON.stringify(event.resume)); break; }
  }
  assert(saved, "no checkpoint returned");
  let completed;
  // Recreate the authenticated connector to test resume without instance state.
  const resumed = createGDriveConnector({
    auth: { type: "oauth", clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET, refreshToken: process.env.GOOGLE_REFRESH_TOKEN },
    scope: { folder: process.env.GOOGLE_FOLDER_ID },
  });
  for await (const event of resumed.iterateChanges(saved, { signal })) {
    if (event.kind === "document") documents.set(event.document.providerDocId, event.document);
    if (event.kind === "complete") completed = event;
  }
  assert(completed, "resume did not complete");
  console.log(`Checkpoint/restart: ${documents.size} documents; coverage ${completed.coverage}`);
  const accumulated = await connector.listChanges();
  assert.deepEqual([...documents.keys()].sort(), accumulated.documents.map(d => d.providerDocId).sort(), "source inventory changed between scans or APIs disagree");
  console.log("Streaming/accumulated inventory parity: passed");
  const candidate = [...documents.values()].find(d =>
    ["text/plain", "text/markdown", "text/csv", "application/vnd.google-apps.document", "application/vnd.google-apps.spreadsheet", "application/vnd.google-apps.presentation"].includes(d.mimeType));
  if (candidate) {
    const content = await connector.fetchContent(candidate, { signal, maxBytes: 5 * 1024 * 1024, maxOutputCharacters: 2_000_000 });
    assert.equal(typeof content.markdown, "string");
    assert.match(content.contentHash, /^[a-f0-9]{64}$/);
    assert(content.modifiedAt || content.providerVersion);
    console.log(`Bounded real content fetch: passed (${Buffer.byteLength(content.markdown)} normalized bytes)`);
  } else console.log("Content fetch: skipped (no supported text/native file in this folder)");
  let deltaCount = 0;
  for await (const event of connector.iterateChanges(completed.resume, { signal })) {
    if (event.kind === "document" || event.kind === "removed") deltaCount++;
  }
  console.log(`Incremental scan: passed (${deltaCount} events)`);
}
main().catch(error => {
  console.error(`Live smoke failed: ${error.name}${error.status ? ` (HTTP ${error.status})` : ""}`);
  process.exitCode = 1;
});
