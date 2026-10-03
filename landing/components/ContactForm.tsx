"use client";

import { useState } from "react";

const WHATSAPP = process.env.NEXT_PUBLIC_WHATSAPP ?? ""; // con lada, sin "+" ni espacios
const EMAIL = process.env.NEXT_PUBLIC_CONTACT_EMAIL ?? "";

export function ContactForm() {
  const [note, setNote] = useState("");

  return (
    <form
      className="contact"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const nombre = String(f.get("nombre") ?? "").trim();
        if (!nombre) return setNote("Escribe tu nombre para continuar.");
        const msg = `Hola, quiero ver una demo de Nodo.\nNombre: ${nombre}\nRestaurante: ${f.get("restaurante") || "-"}\nTeléfono: ${f.get("telefono") || "-"}`;
        if (WHATSAPP) {
          window.open(
            `https://wa.me/${WHATSAPP}?text=${encodeURIComponent(msg)}`,
            "_blank",
            "noopener",
          );
          setNote("Abriendo WhatsApp…");
        } else if (EMAIL) {
          window.location.href = `mailto:${EMAIL}?subject=${encodeURIComponent("Demo de Nodo")}&body=${encodeURIComponent(msg)}`;
          setNote("Abriendo tu correo…");
        } else {
          setNote(
            "Falta configurar NEXT_PUBLIC_WHATSAPP o NEXT_PUBLIC_CONTACT_EMAIL para recibir las solicitudes.",
          );
        }
      }}
    >
      <input name="nombre" placeholder="Tu nombre" autoComplete="name" required />
      <input name="restaurante" placeholder="Nombre del restaurante" autoComplete="organization" />
      <input name="telefono" placeholder="WhatsApp o teléfono" autoComplete="tel" inputMode="tel" />
      <button type="submit">Pedir mi demo →</button>
      <p className="contact-note" role="status">
        {note}
      </p>
    </form>
  );
}
