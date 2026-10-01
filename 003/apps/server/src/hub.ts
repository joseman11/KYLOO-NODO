export interface HubEvent {
  type: string;
  [k: string]: unknown;
}

type Listener = (e: HubEvent) => void;

/** Bus de eventos en memoria; el WebSocket lo reenvía a todos los dispositivos conectados. */
export class Hub {
  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(e: HubEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        /* un cliente roto no debe afectar a los demás */
      }
    }
  }

  get size(): number {
    return this.listeners.size;
  }
}
