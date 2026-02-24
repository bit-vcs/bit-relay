import type { IncomingRefRelayEvent } from './contracts.ts';

export interface TriggerDispatchResult {
  ok: boolean;
  dispatched: boolean;
  status: number;
  error?: string;
}

export interface TriggerDispatcher {
  dispatchIncomingRef(event: IncomingRefRelayEvent): Promise<TriggerDispatchResult>;
}

export interface WebhookTriggerDispatcherOptions {
  webhookUrl: string | null;
  webhookToken?: string | null;
  eventType?: string;
  fetchFn?: typeof globalThis.fetch;
}

const INCOMING_REF_PREFIX = 'refs/relay/incoming/';

export function isIncomingRelayRef(ref: string): boolean {
  return ref.startsWith(INCOMING_REF_PREFIX);
}

export function createWebhookTriggerDispatcher(
  options: WebhookTriggerDispatcherOptions,
): TriggerDispatcher {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const webhookUrl = (options.webhookUrl ?? '').trim();
  const webhookToken = (options.webhookToken ?? '').trim();
  const eventType = (options.eventType ?? 'relay.incoming_ref').trim() || 'relay.incoming_ref';

  return {
    async dispatchIncomingRef(event: IncomingRefRelayEvent): Promise<TriggerDispatchResult> {
      if (!isIncomingRelayRef(event.ref) || webhookUrl.length === 0) {
        return { ok: true, dispatched: false, status: 0 };
      }

      const headers = new Headers({ 'content-type': 'application/json' });
      if (webhookToken.length > 0) {
        headers.set('authorization', `Bearer ${webhookToken}`);
      }

      const body = {
        event_type: eventType,
        event_id: event.eventId,
        occurred_at: event.occurredAt,
        room: event.room,
        source: event.source,
        target: event.target,
        ref: event.ref,
      } satisfies Record<string, unknown>;

      let response: Response;
      try {
        response = await fetchFn(webhookUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        });
      } catch {
        return {
          ok: false,
          dispatched: true,
          status: 0,
          error: 'trigger dispatch failed: network error',
        };
      }

      if (response.ok) {
        return {
          ok: true,
          dispatched: true,
          status: response.status,
        };
      }

      return {
        ok: false,
        dispatched: true,
        status: response.status,
        error: `trigger dispatch failed: status=${response.status}`,
      };
    },
  };
}
