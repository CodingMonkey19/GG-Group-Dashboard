/**
 * Tiny HTTP client for the spend-dashboard API.
 *
 * - `fetchData()` GETs /api/data and runtime-validates the response with the
 *   shared zod schema. Any drift between backend and frontend surfaces here.
 * - `subscribeRefresh()` opens an SSE stream to /api/refresh; the caller
 *   passes handlers per event type from the discriminated union.
 *
 * The SSE consumer is hand-rolled rather than using EventSource so we can
 * issue a POST (the spec mandates POST /api/refresh, and EventSource only
 * supports GET).
 */

import { ApiDataResponse, type RefreshSseEvent } from './contracts';

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message);
  }
}

/**
 * Fetch and zod-parse the consolidated snapshot.
 * Returns null when the backend reports `never_refreshed` (HTTP 503 with
 * `error: 'never_refreshed'`) so the caller can render the empty state.
 */
export async function fetchData(baseUrl = ''): Promise<ApiDataResponse | null> {
  const res = await fetch(`${baseUrl}/api/data`, { headers: { Accept: 'application/json' } });

  if (res.status === 503) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    if (body?.error === 'never_refreshed') return null;
    throw new ApiError('backend reported 503 with unexpected body', res.status, body);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ApiError(`GET /api/data failed: ${res.status} ${res.statusText}`, res.status, body);
  }

  const json: unknown = await res.json();
  const parsed = ApiDataResponse.safeParse(json);
  if (!parsed.success) {
    throw new ApiError(
      `GET /api/data returned a payload that does not match ApiDataResponse: ${parsed.error.message}`,
      200,
      json,
    );
  }
  return parsed.data;
}

export interface RefreshHandlers {
  onStarted?: (e: Extract<RefreshSseEvent, { event: 'started' }>['data']) => void;
  onSourceProgress?: (
    e: Extract<RefreshSseEvent, { event: 'source_progress' }>['data'],
  ) => void;
  onPhase?: (e: Extract<RefreshSseEvent, { event: 'phase' }>['data']) => void;
  onCompleted?: (e: Extract<RefreshSseEvent, { event: 'completed' }>['data']) => void;
  onError?: (e: Extract<RefreshSseEvent, { event: 'error' }>['data']) => void;
  /** Network/transport error (timeout, parse failure, 409 conflict). */
  onTransportError?: (err: Error) => void;
}

/**
 * Open a refresh SSE stream by issuing POST /api/refresh.
 * Returns an AbortController so the caller can stop the stream early.
 */
export function subscribeRefresh(handlers: RefreshHandlers, baseUrl = ''): AbortController {
  const ctrl = new AbortController();

  void (async () => {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/api/refresh`, {
        method: 'POST',
        headers: { Accept: 'text/event-stream' },
        signal: ctrl.signal,
      });
    } catch (err) {
      handlers.onTransportError?.(err as Error);
      return;
    }

    if (res.status === 409) {
      const body = (await res.json().catch(() => null)) as
        | { error?: string; refresh_id?: number }
        | null;
      handlers.onTransportError?.(
        new ApiError(
          `refresh in progress (refresh_id=${body?.refresh_id ?? 'unknown'})`,
          409,
          body,
        ),
      );
      return;
    }

    if (!res.ok || res.body === null) {
      handlers.onTransportError?.(
        new ApiError(`POST /api/refresh failed: ${res.status} ${res.statusText}`, res.status),
      );
      return;
    }

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';

    try {
      // Read until the server closes the stream.
      // SSE frames are separated by "\n\n"; each frame may have multiple lines.
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;

        let separatorIdx = buffer.indexOf('\n\n');
        while (separatorIdx !== -1) {
          const frame = buffer.slice(0, separatorIdx);
          buffer = buffer.slice(separatorIdx + 2);
          dispatchSseFrame(frame, handlers);
          separatorIdx = buffer.indexOf('\n\n');
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      handlers.onTransportError?.(err as Error);
    }
  })();

  return ctrl;
}

function dispatchSseFrame(frame: string, handlers: RefreshHandlers): void {
  let eventName: string | null = null;
  let dataLines: string[] = [];

  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
  }

  if (eventName === null || dataLines.length === 0) return;
  let payload: unknown;
  try {
    payload = JSON.parse(dataLines.join('\n'));
  } catch {
    handlers.onTransportError?.(new ApiError(`malformed SSE data for event ${eventName}`, 0));
    return;
  }

  switch (eventName) {
    case 'started':
      handlers.onStarted?.(payload as Parameters<NonNullable<RefreshHandlers['onStarted']>>[0]);
      break;
    case 'source_progress':
      handlers.onSourceProgress?.(
        payload as Parameters<NonNullable<RefreshHandlers['onSourceProgress']>>[0],
      );
      break;
    case 'phase':
      handlers.onPhase?.(payload as Parameters<NonNullable<RefreshHandlers['onPhase']>>[0]);
      break;
    case 'completed':
      handlers.onCompleted?.(
        payload as Parameters<NonNullable<RefreshHandlers['onCompleted']>>[0],
      );
      break;
    case 'error':
      handlers.onError?.(payload as Parameters<NonNullable<RefreshHandlers['onError']>>[0]);
      break;
    default:
      // Unknown event names are ignored — forward-compatibility with v2 events.
      break;
  }
}
