# `@triadlabs/connectors-core`

Shared contracts for Triad Labs connectors. Plumbing, not a silo.

This package holds the source-agnostic types every connector implements and
every consumer codes against: the normalized document shape, the parser
socket, the generic connector interface, and typed errors. It has no runtime
dependencies.

You normally do not install this directly — source packages like
[`@triadlabs/connectors-gdrive`](https://www.npmjs.com/package/@triadlabs/connectors-gdrive)
re-export everything here. Install it when you are building your own
connector or writing consumer code that should work across sources.

Requires Node.js >= 20. ESM only.

## Install

```sh
npm install @triadlabs/connectors-core
```

## What's inside

```ts
import {
  type Connector,
  type ConnectorDocument,
  type ParserFn,
  type ParserContext,
  type FetchContentOptions,
  ConnectorAuthError,
  ConnectorCursorExpiredError,
  ConnectorExtractionError,
  ConnectorScopeError,
} from "@triadlabs/connectors-core";
```

**`ConnectorDocument`** — the normalized unit every connector returns:

```ts
interface ConnectorDocument {
  providerDocId: string;   // stable ID in the source system
  name: string;
  mimeType: string;
  webViewLink?: string;
  url?: string;
  modifiedAt: string;
  sizeBytes?: number;
  providerVersion?: string;
  contentHash: string;     // SHA-256 of markdown, filled by fetchContent
  markdown: string;        // empty until fetchContent
}
```

**`ParserFn`** — the consumer-injected socket for binary formats. Connectors
never bundle a parser; you bring your own pipeline (local parser, paid API,
LLM, whatever):

```ts
type ParserFn = (bytes: Uint8Array, mimeType: string, context?: ParserContext) => Promise<string>;
```

**`Connector<Cursor, Result, Document>`** — the minimal source-agnostic
contract:

```ts
interface Connector<Cursor, Result, Document extends ConnectorDocument> {
  listChanges(cursor?: Cursor): Promise<Result>;
  fetchContent(doc: Document, options?: FetchContentOptions): Promise<Document>;
}
```

**Typed errors** — all catchable with `instanceof`:

- `ConnectorAuthError` — credentials malformed or unparseable
- `ConnectorScopeError` — scope configuration invalid
- `ConnectorExtractionError` — item cannot be extracted (e.g. no parser for
  its type)
- `ConnectorCursorExpiredError` — a persisted cursor can no longer be used;
  catch it and run a full backfill
- `ConnectorResumeError` — malformed or incompatible state; cursor-error subtype
- `ConnectorRescanRequiredError` — source topology needs a new inventory; cursor-error subtype
- `ConnectorProviderError` — safe `status`, `retryable`, and optional `retryAfterMs`
- `ConnectorContentChangedError` — content changed during download; retry the file

`FetchContentOptions` carries an optional `signal`, `maxBytes`, and
`maxOutputCharacters`. `ParserContext` carries the document ID, name, MIME type,
optional size, and signal. Parsers remain consumer-owned; a signal requires
cooperative cancellation or an external worker/process supervisor.

`ConnectorExtractionError` has a `reason` and optional `providerDocId`. Its reasons
are `unsupported`, `encrypted`, `malformed`, `resourceLimit`, `needsOcr`, and
`parserFailed`. Existing message-only constructors remain valid.

## Building a connector

Implement the interface, keep all source-specific types in your own package,
and own no consumer state — resume data goes in as an argument and comes out
in the result:

```ts
import type {
  Connector,
  ConnectorDocument,
  ParserFn,
} from "@triadlabs/connectors-core";

interface HubSpotResume { cursor?: string; }
interface HubSpotResult {
  documents: ConnectorDocument[];
  removed: string[];
  cursor: string;
}

export function createHubSpotConnector(options: {
  apiKey: string;
  parser?: ParserFn;
}): Connector<HubSpotResume, HubSpotResult> {
  // auth, change detection, normalization — your code
  // storage, indexing, scheduling — the consumer's code
}
```

See the [connector-sdk design doc](https://github.com/Triad-Labs-Inc/connector-sdk/blob/main/docs/DESIGN.md)
for the architecture these contracts come from.

## License

MIT
