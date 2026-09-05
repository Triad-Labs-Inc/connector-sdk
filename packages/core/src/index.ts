/** A document extracted and normalized by a source connector. */
export interface ConnectorDocument {
  providerDocId: string;
  name: string;
  mimeType: string;
  webViewLink?: string;
  url?: string;
  modifiedAt: string;
  contentHash: string;
  markdown: string;
}

/** Consumer-provided binary-to-Markdown parser socket. */
export type ParserFn = (
  bytes: Uint8Array,
  mimeType: string,
) => Promise<string>;

/** Minimal source-agnostic connector contract. */
export interface Connector<
  Cursor = unknown,
  Result = unknown,
  Document extends ConnectorDocument = ConnectorDocument,
> {
  listChanges(cursor?: Cursor): Promise<Result>;
  fetchContent(doc: Document): Promise<Document>;
}

/** Authentication configuration is invalid or cannot be parsed. */
export class ConnectorAuthError extends Error {
  override readonly name = "ConnectorAuthError";
}

/** An item cannot be extracted through the configured connector. */
export class ConnectorExtractionError extends Error {
  override readonly name = "ConnectorExtractionError";
}

/** Source scope configuration is invalid. */
export class ConnectorScopeError extends Error {
  override readonly name = "ConnectorScopeError";
}

/** A persisted provider cursor can no longer be used for incremental sync. */
export class ConnectorCursorExpiredError extends Error {
  override readonly name: string = "ConnectorCursorExpiredError";

  constructor(message = "The sync cursor expired; a full backfill is required") {
    super(message);
  }
}

/** Persisted state is invalid, incompatible, or belongs to another scope. */
export class ConnectorResumeError extends ConnectorCursorExpiredError {
  override readonly name = "ConnectorResumeError";
}
