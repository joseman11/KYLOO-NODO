"use client";

import { useEffect, useState } from "react";

/** Hora local de Cuernavaca (como en el pie de Kyloo). Se actualiza cada segundo, sin desajuste de hidratación. */
export function LiveClock() {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const tz = "America/Mexico_City";
  const time = now
    ? new Intl.DateTimeFormat("es-MX", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: tz }).format(now).replace(/\s/g, " ").replace("a. m.", "a.m.").replace("p. m.", "p.m.")
    : "--:--";
  const date = now
    ? new Intl.DateTimeFormat("es-MX", { weekday: "short", day: "2-digit", month: "short", year: "2-digit", timeZone: tz }).format(now).replace(/\./g, "").replace(/,/g, "")
    : "";

  return (
    <p className="clock" suppressHydrationWarning>
      Cuernavaca {time}
      <br />
      {date} (GMT −06)
    </p>
  );
}
