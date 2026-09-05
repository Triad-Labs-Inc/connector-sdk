import { ConnectorProviderError, ConnectorCursorExpiredError } from "@triadlabs/connectors-core";

export function providerStatus(error: unknown): number | undefined {
  const value = error as { response?: { status?: unknown }; code?: unknown } | undefined;
  const status = value?.response?.status ?? value?.code;
  return typeof status === "number" ? status : undefined;
}

export function providerError(error: unknown, operation: string): Error {
  if (error instanceof ConnectorProviderError || error instanceof ConnectorCursorExpiredError ||
      (error instanceof Error && error.name === "AbortError")) return error;
  const status = providerStatus(error);
  const response = (error as { response?: { headers?: { get?: (key: string) => string | null; [key: string]: unknown }; data?: { error?: { errors?: Array<{ reason?: string }> } } } })?.response;
  const reasons = response?.data?.error?.errors?.map(item => item.reason) ?? [];
  const retryable = status === undefined || status === 408 || status === 429 || status >= 500 ||
    (status === 403 && reasons.some(reason => reason === "rateLimitExceeded" || reason === "userRateLimitExceeded"));
  const header = response?.headers?.get?.("retry-after") ?? response?.headers?.["retry-after"];
  let retryAfterMs: number | undefined;
  if (typeof header === "string") {
    const seconds = Number(header);
    const parsed = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
    if (Number.isFinite(parsed)) retryAfterMs = Math.max(0, parsed);
  }
  return new ConnectorProviderError(`${operation} failed${status ? ` (HTTP ${status})` : ""}`, status, retryable, retryAfterMs);
}
