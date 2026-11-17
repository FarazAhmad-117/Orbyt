import { Inject, Injectable } from "@nestjs/common";
import { activities } from "@orbyt/db";
import { DbService } from "./db.service";
import type { Scope } from "./scope";

export interface DomainEvent {
  type: string; // e.g. "contact.created", "deal.moved"
  contactId?: string | null;
  dealId?: string | null;
  data?: Record<string, unknown>;
  /** Set when a workflow action caused this event; `depth` counts workflow->event hops (loop guard). */
  origin?: { depth: number };
}

/**
 * The single choke point for "everything is an event" (plan §4.2): records the activity
 * timeline entry and fans out to subscribers (webhooks, workflows) registered via subscribe().
 */
@Injectable()
export class EventsService {
  private readonly subscribers: Array<
    (scope: Scope, event: DomainEvent) => Promise<void>
  > = [];
  private readonly pending = new Set<Promise<unknown>>();

  constructor(@Inject(DbService) private readonly dbs: DbService) {}

  subscribe(fn: (scope: Scope, event: DomainEvent) => Promise<void>) {
    this.subscribers.push(fn);
  }

  async emit(scope: Scope, event: DomainEvent): Promise<void> {
    await this.dbs.inWorkspace(scope, (tx) =>
      tx.insert(activities).values({
        workspaceId: scope.workspaceId,
        type: event.type,
        contactId: event.contactId ?? null,
        dealId: event.dealId ?? null,
        data: event.data ?? {},
        actorId: scope.userId,
      }),
    );
    for (const fn of this.subscribers) {
      // Subscribers run in the background and must not break the request that caused the event.
      const task = fn(scope, event)
        .catch((err: unknown) => console.error(`[events] ${event.type}:`, err))
        .finally(() => this.pending.delete(task));
      this.pending.add(task);
    }
  }

  /** Resolves when all background subscriber work has finished (tests, graceful shutdown). */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}
