/**
 * Reparto de propinas (sec. 32 y 76). Función pura: recibe lo cobrado y quién trabajó, devuelve cuánto le toca a cada quien.
 * La suma de los pagos siempre es exactamente igual a lo repartido (se reparten centavos enteros).
 */

export type TipPolicy = "individual" | "pool";

export interface TipStaff {
  id: string;
  role: string /** Horas trabajadas en el periodo (del checador). */;
  hours: number;
}

export interface TipInput {
  policy: TipPolicy;
  /** Peso de cada rol en el reparto: { mesero: 60, cocina: 25, bar: 15 }. */
  roles: Record<string, number>;
  /** Con política "individual": porcentaje de cada propina que el mesero aporta a los demás roles. */
  supportPct: number;
  /** Propinas cobradas en las cuentas de cada mesero (centavos). */
  tipsByWaiter: Record<string, number>;
  staff: TipStaff[];
}

export interface TipResult {
  payouts: Record<string, number>;
  totalCents: number;
  unassignedCents: number;
}

/** Reparte `amount` centavos según pesos, sin perder ni inventar centavos (mayor residuo). */
export function splitByWeight(
  amount: number,
  weights: Record<string, number>,
): Record<string, number> {
  const ids = Object.keys(weights).filter((k) => weights[k]! > 0);
  const sum = ids.reduce((s, k) => s + weights[k]!, 0);
  const out: Record<string, number> = {};
  if (amount <= 0 || sum <= 0) return out;
  let assigned = 0;
  const rem: { id: string; frac: number }[] = [];
  for (const id of ids) {
    const exact = (amount * weights[id]!) / sum;
    out[id] = Math.floor(exact);
    assigned += out[id]!;
    rem.push({ id, frac: exact - out[id]! });
  }
  rem.sort((a, b) => b.frac - a.frac);
  for (let i = 0; assigned < amount; i++, assigned++) out[rem[i % rem.length]!.id]! += 1;
  return out;
}

/** Reparte el monto de un rol entre su personal, por horas (o por partes iguales si nadie checó). */
function splitInRole(amount: number, members: TipStaff[]): Record<string, number> {
  const byHours = Object.fromEntries(members.map((m) => [m.id, m.hours]));
  const hasHours = members.some((m) => m.hours > 0);
  return splitByWeight(
    amount,
    hasHours ? byHours : Object.fromEntries(members.map((m) => [m.id, 1])),
  );
}

/** Reparte `pool` entre los roles que tienen personal elegible, según el peso de cada rol. */
function splitPoolByRoles(
  pool: number,
  roles: Record<string, number>,
  staff: TipStaff[],
): Record<string, number> {
  const eligibleRoles = Object.keys(roles).filter(
    (r) => roles[r]! > 0 && staff.some((s) => s.role === r),
  );
  const perRole = splitByWeight(pool, Object.fromEntries(eligibleRoles.map((r) => [r, roles[r]!])));
  const out: Record<string, number> = {};
  for (const r of eligibleRoles) {
    for (const [id, v] of Object.entries(
      splitInRole(
        perRole[r] ?? 0,
        staff.filter((s) => s.role === r),
      ),
    ))
      out[id] = (out[id] ?? 0) + v;
  }
  return out;
}

const add = (into: Record<string, number>, from: Record<string, number>) => {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
};

export function distributeTips(input: TipInput): TipResult {
  const totalCents = Object.values(input.tipsByWaiter).reduce((s, v) => s + v, 0);
  const payouts: Record<string, number> = {};

  if (input.policy === "pool") {
    // Todo va al fondo común. Quien tuvo propinas cuenta como personal aunque no haya checado.
    const staff = [...input.staff];
    for (const id of Object.keys(input.tipsByWaiter))
      if (!staff.some((s) => s.id === id)) staff.push({ id, role: "mesero", hours: 0 });
    add(payouts, splitPoolByRoles(totalCents, input.roles, staff));
  } else {
    // Cada mesero conserva lo suyo, menos el porcentaje que aporta al personal de apoyo
    let support = 0;
    for (const [waiter, tip] of Object.entries(input.tipsByWaiter)) {
      const give = Math.round((tip * Math.min(100, Math.max(0, input.supportPct))) / 100);
      payouts[waiter] = (payouts[waiter] ?? 0) + tip - give;
      support += give;
    }
    if (support > 0) {
      const rolesWithoutWaiters = Object.fromEntries(
        Object.entries(input.roles).filter(([r]) => r !== "mesero"),
      );
      const given = splitPoolByRoles(
        support,
        rolesWithoutWaiters,
        input.staff.filter((s) => s.role !== "mesero"),
      );
      const placed = Object.values(given).reduce((s, v) => s + v, 0);
      add(payouts, given);
      // Si no hay personal de apoyo elegible, el aporte regresa a los meseros en proporción a lo que generaron
      if (placed < support) add(payouts, splitByWeight(support - placed, input.tipsByWaiter));
    }
  }

  const assigned = Object.values(payouts).reduce((s, v) => s + v, 0);
  return { payouts, totalCents, unassignedCents: totalCents - assigned };
}
