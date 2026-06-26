import type { EkoEventMap, EkoEventName, EkoEventListener } from "../types";

/** Whether an event's payload type is `void` — used to make `emit` variadic. */
type EmitArgs<E extends EkoEventName> = EkoEventMap[E] extends void
  ? [payload?: undefined]
  : [payload: EkoEventMap[E]];

/** Minimal typed event emitter — no dependencies. */
export class Emitter {
  private listeners = new Map<EkoEventName, Set<(payload: never) => void>>();

  /** Subscribe. Returns an unsubscribe function. */
  on<E extends EkoEventName>(event: E, fn: EkoEventListener<E>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn as (payload: never) => void);
    return () => this.off(event, fn);
  }

  off<E extends EkoEventName>(event: E, fn: EkoEventListener<E>): void {
    this.listeners.get(event)?.delete(fn as (payload: never) => void);
  }

  emit<E extends EkoEventName>(event: E, ...args: EmitArgs<E>): void {
    const set = this.listeners.get(event);
    if (!set) return;
    const payload = args[0] as never;
    // Copy to a snapshot so a listener that unsubscribes mid-emit doesn't skip others.
    for (const fn of [...set]) fn(payload);
  }

  clear(): void {
    this.listeners.clear();
  }
}
