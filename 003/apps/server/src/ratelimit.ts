/**
 * Limitador de intentos por clave (normalmente la IP) en una ventana deslizante, en memoria. Complementa el bloqueo por
 * usuario del acceso: ese frena probar PIN contra una persona; este frena a un mismo equipo probando contra todas.
 */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private max: number,
    private windowMs: number,
    private now: () => number = Date.now,
  ) {}

  /** Registra un intento. `ok` es falso cuando se rebasó el máximo en la ventana. */
  hit(key: string): { ok: boolean; retryAfterSec: number } {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    recent.push(t);
    this.hits.set(key, recent);
    // Evita que el mapa crezca sin límite con IP que ya no vuelven
    if (this.hits.size > 10_000)
      for (const [k, v] of this.hits)
        if (t - (v[v.length - 1] ?? 0) >= this.windowMs) this.hits.delete(k);
    const over = recent.length > this.max;
    return {
      ok: !over,
      retryAfterSec: over ? Math.max(1, Math.ceil((this.windowMs - (t - recent[0]!)) / 1000)) : 0,
    };
  }
}
