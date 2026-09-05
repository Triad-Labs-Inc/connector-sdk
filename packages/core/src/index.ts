/** A document extracted and normalized by a source connector. */
export interface ConnectorDocument {
  providerDocId: string;
  name: string;
  mimeType: string;
  webViewLink?: string;
  url?: string;
  modifiedAt: string;
  sizeBytes?: number;
  providerVersion?: string;
  contentHash: string;
  markdown: string;
}

export interface FetchContentOptions {
  signal?: AbortSignal;
  maxBytes?: number;
  maxOutputCharacters?: number;
}

export interface ParserContext {
  providerDocId: string;
  name: string;
  mimeType: string;
  sizeBytes?: number;
  signal?: AbortSignal;
}

/** Consumer-provided binary-to-Markdown parser socket. */
export type ParserFn = (
  bytes: Uint8Array,
  mimeType: string,
  context?: ParserContext,
) => Promise<string>;

/** Minimal source-agnostic connector contract. */
export interface Connector<
  Cursor = unknown,
  Result = unknown,
  Document extends ConnectorDocument = ConnectorDocument,
> {
  listChanges(cursor?: Cursor): Promise<Result>;
  fetchContent(doc: Document, options?: FetchContentOptions): Promise<Document>;
}

/** Authentication configuration is invalid or cannot be parsed. */
export class ConnectorAuthError extends Error {
  override readonly name = "ConnectorAuthError";
}

/** An item cannot be extracted through the configured connector. */
export class ConnectorExtractionError extends Error {
  override readonly name = "ConnectorExtractionError";
  constructor(
    message: string,
    readonly reason: "unsupported" | "encrypted" | "malformed" | "resourceLimit" | "needsOcr" | "parserFailed" = "parserFailed",
    readonly providerDocId?: string,
  ) { super(message); }
}

/** Content changed while it was being fetched. Retry discovery/fetch. */
export class ConnectorContentChangedError extends Error {
  override readonly name = "ConnectorContentChangedError";
  readonly retryable = true;
  constructor(readonly providerDocId: string) {
    super(`Document ${providerDocId} changed during content fetch`);
  }
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

/** Provider topology changed; rebuild this source's inventory before advancing. */
export class ConnectorRescanRequiredError extends ConnectorCursorExpiredError {
  override readonly name = "ConnectorRescanRequiredError";
}

/** Provider failure with safe retry metadata; contains no credential or response body. */
export class ConnectorProviderError extends Error {
  override readonly name = "ConnectorProviderError";
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) { super(message); }
}
