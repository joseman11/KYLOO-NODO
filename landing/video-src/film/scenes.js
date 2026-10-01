/* Guiones de las películas. Se elige con ?scene=pedido|cocina|cobro|hero */
(() => {
  const q = new URLSearchParams(location.search).get("scene") || "pedido";
  const { E, clamp, lerp } = Film;

  /** Ticket térmico que se imprime (crece desde la ranura). */
  const ticket = ({ x, y, w = 200, name, lines, key, at = 0.12, dur = 1.5, layer }) => ({
    layer,
    create(parent, h, marks) {
      const el = h.$(`<div class="pq" style="left:${x}px;top:${y}px;width:${w}px;opacity:0">
        <div class="name">${name}</div><div class="slot"></div><div class="paper"><div class="in" style="position:absolute;left:0;right:0;top:0">${lines}</div></div></div>`);
      parent.appendChild(el);
      const paper = el.querySelector(".paper");
      const inn = el.querySelector(".in");
      const t0 = () => marks[key].tap + at;
      return {
        update(t) {
          const u = clamp((t - t0()) / dur);
          el.style.opacity = clamp((t - (t0() - 0.35)) / 0.35);
          const full = inn.offsetHeight;
          const hh = Film.E.soft(u) * full;
          paper.style.height = hh + "px";
          inn.style.top = "0px";
        },
      };
    },
  });

  /** Etiqueta que viaja de un dispositivo a otro (la comanda). */
  const flyer = ({ from, to, key, text, dur = 0.9 }) => ({
    layer: "world",
    create(parent, h, marks) {
      const el = h.$(`<div style="position:absolute;left:0;top:0;padding:14px 20px;border-radius:12px;background:#fffdf8;border:2px solid #14110f;box-shadow:0 14px 30px rgba(40,28,10,.3);font:600 22px 'Plex Mono',monospace;color:#14110f;opacity:0;white-space:nowrap">${text}</div>`);
      parent.appendChild(el);
      return {
        update(t) {
          const a = marks[key].tap + 0.05;
          const u = clamp((t - a) / dur);
          if (u <= 0 || u >= 1.0) { el.style.opacity = u >= 1 ? 0 : 0; return; }
          const e = E.inout(u);
          const x = lerp(from[0], to[0], e), y = lerp(from[1], to[1], e) - Math.sin(Math.PI * e) * 90;
          el.style.opacity = Math.min(1, u * 6) * (1 - clamp((u - 0.85) / 0.15));
          el.style.transform = `translate(${x}px,${y}px) rotate(${lerp(-6, 4, e)}deg) scale(${lerp(1, 0.9, e)})`;
        },
      };
    },
  });

  const D = 1.04; // escala del dispositivo único

  /* ───────────────────────── 1 · El pedido ───────────────────────── */
  const pedido = () => {
    const cap = (n, t, s) => ({ n, t, s });
    return Film.define({
      id: "pedido",
      clip: [500, 0, 1420, 1080], camCenter: [1210, 540],
      capX: 70, capY: 190, capW: 400,
      devices: { a: { x: 1210 - 640 * D, y: 540 - 400 * D, scale: D } },
      steps: [
        { dev: "a", state: "w_map", dwell: 2.4, zoom: 1.22, caption: cap("01", "Toca una mesa libre", "El mapa muestra el estado de cada mesa en tiempo real.") },
        { dev: "a", state: "w_t3", dwell: 1.8, zoom: 1.22, caption: cap("02", "Abre la mesa", "Indicas cuántas personas son y listo.") },
        { dev: "a", state: "w_order0", dwell: 1.7, zoom: 1.2, caption: cap("03", "Elige y toca", "Categorías a la izquierda, cada platillo con su foto y su precio.") },
        { dev: "a", state: "w_cat", dwell: 1.8, zoom: 1.2 },
        { dev: "a", state: "w_mod1a", dwell: 1.3, zoom: 1.28, caption: cap("04", "Personaliza sin teclear", "Extras y picante en un toque.") },
        { dev: "a", state: "w_mod1b", dwell: 1.1, zoom: 1.28 },
        { dev: "a", state: "w_mod1c", dwell: 1.3, zoom: 1.28 },
        { dev: "a", state: "w_order1", dwell: 1.6, zoom: 1.15 },
        { dev: "a", state: "w_mod2a", dwell: 1.1, zoom: 1.28 },
        { dev: "a", state: "w_mod2b", dwell: 1.2, zoom: 1.28 },
        { dev: "a", state: "w_order2", dwell: 1.4, zoom: 1.2, key: "search" },
        { dev: "a", state: "w_order2", dwell: 1.0, tap: false, zoom: 1.2, key: "typing" },
        { dev: "a", state: "w_search", dwell: 1.5, zoom: 1.15 },
        { dev: "a", state: "w_order3", dwell: 2.2, zoom: 1.22, key: "send", caption: cap("05", "Envía la comanda", "Una sola comanda; cada estación recibe solo lo suyo.") },
        { dev: "a", state: "w_sent", dwell: 4.4, tap: false, zoom: 1, caption: cap("06", "Se imprime donde toca", "Si una impresora falla, la comanda pasa a la de respaldo.") },
      ],
      typing(t, devs, m) {
        const input = devs.a.app.querySelector('input[placeholder^="Buscar"]');
        if (!input) return;
        const k = m.typing;
        if (t >= k.start && t < k.end) {
          const n = Math.min(6, Math.floor((t - k.start) / 0.14) + 1);
          input.value = "Michel".slice(0, n);
          input.setAttribute("value", input.value);
        }
      },
      extras: [
        ticket({ x: 70, y: 700, w: 190, name: "COCINA", key: "send", dur: 1.6, lines: "\n <b>T3 · JUAN</b>\n --------------\n <b>1 Ceviche mixto</b>\n   Aguacate\n   Poco picante\n <b>1 Aguachile verde</b>\n   Normal\n --------------\n #794  03:12\n" }),
        ticket({ x: 276, y: 700, w: 190, name: "BARRA", key: "send", at: 0.55, dur: 1.2, lines: "\n <b>T3 · JUAN</b>\n --------------\n <b>1 Michelada</b>\n --------------\n #794  03:12\n" }),
      ],
    });
  };

  /* ───────────────────────── 2 · Cocina y entrega ───────────────────────── */
  const KS_C = 0.64, KS_H = 0.68;
  const cocinaLayout = (withCaptions) => {
    const cap = (n, t, s) => (withCaptions ? { n, t, s } : undefined);
    const KS = withCaptions ? KS_C : KS_H;
    const wx = withCaptions ? 70 : 50, wy = withCaptions ? 380 : 290, kx = 1920 - wx - 1280 * KS, ky = wy;
    const wc = [wx + 640 * KS, wy + 400 * KS], kc = [kx + 640 * KS, ky + 400 * KS];
    const W0 = [wx + 1280 * KS * 0.92, wy + 120], K0 = [kx + 40, ky + 90];
    return Film.define({
      id: withCaptions ? "cocina" : "hero",
      camCenter: [960, 540],
      capX: 70, capY: 60, capW: 1100,
      devices: {
        w: { x: wx, y: wy, scale: KS, label: "Mesero · tablet" },
        k: { x: kx, y: ky, scale: KS, label: "Cocina · pantalla" },
      },
      steps: [
        { dev: "w", state: "w_order3", at: 0.4, dwell: withCaptions ? 2.2 : 1.4, key: "send", nocam: true, caption: cap("01", "El mesero envía", "Un toque y la comanda sale.") },
        { dev: "k", state: "kds_before", at: 0.4, dwell: withCaptions ? 3.1 : 2.3, tap: false, nocam: true },
        { dev: "w", state: "w_sent", at: withCaptions ? 2.6 : 1.8, dwell: withCaptions ? 4.6 : 3.0, tap: false, nocam: true },
        { dev: "k", state: "kds_arrive", at: withCaptions ? 3.5 : 2.7, dwell: withCaptions ? 2.4 : 1.7, key: "arrive", nocam: true, caption: cap("02", "La cocina la ve al instante", "Aparece sola en la pantalla de la estación.") },
        { dev: "k", state: "kds_prep", at: withCaptions ? 5.9 : 4.4, dwell: withCaptions ? 2.2 : 1.6, nocam: true, caption: cap("03", "Preparar. Listo.", "Cada paso queda registrado con su tiempo.") },
        { dev: "k", state: "kds_ready", at: withCaptions ? 8.1 : 6.0, dwell: withCaptions ? 6.0 : 4.6, tap: false, nocam: true },
        { dev: "w", state: "w_back", at: withCaptions ? 7.2 : 5.1, dwell: withCaptions ? 1.4 : 1.0, nocam: true, caption: cap("04", "El mesero recibe el aviso", "“Listos para entregar”, sin preguntar en cocina.") },
        { dev: "w", state: "w_ready", at: withCaptions ? 8.6 : 6.1, dwell: withCaptions ? 2.0 : 1.5, nocam: true },
        { dev: "w", state: "w_delivered", at: withCaptions ? 10.6 : 7.6, dwell: withCaptions ? 3.6 : 3.2, tap: false, nocam: true, caption: cap("05", "Entregado", "Tiempos de cada paso, listos para tus reportes.") },
      ],
      duration: withCaptions ? 14.2 : 10.8,
      extras: [flyer({ from: W0, to: K0, key: "send", text: "Comanda #794 · T3", dur: 0.95 })],
    });
  };

  /* ───────────────────────── 3 · El cobro ───────────────────────── */
  const cobro = () => {
    const cap = (n, t, s) => ({ n, t, s });
    return Film.define({
      id: "cobro",
      clip: [500, 0, 1420, 1080], camCenter: [1210, 540],
      capX: 70, capY: 190, capW: 400,
      devices: { a: { x: 1210 - 640 * D, y: 540 - 400 * D, scale: D } },
      steps: [
        { dev: "a", state: "c_map", dwell: 2.4, zoom: 1.2, caption: cap("01", "La mesa pidió la cuenta", "La tarjeta cambia de color: ya sabes cuál cobrar.") },
        { dev: "a", state: "c_t4", dwell: 1.7, zoom: 1.2, caption: cap("02", "Cobra desde el mapa", "Sin cambiar de pantalla ni abrir menús.") },
        { dev: "a", state: "c_sheet", dwell: 1.9, zoom: 1.22, caption: cap("03", "Completa o dividida", "Cuenta completa, partes iguales o por asiento.") },
        { dev: "a", state: "c_split", dwell: 1.5, zoom: 1.2 },
        { dev: "a", state: "c_full", dwell: 1.3, zoom: 1.3, key: "monto", caption: cap("04", "Escribe lo que recibes", "El cambio se calcula solo.") },
        { dev: "a", state: "c_full", dwell: 1.1, tap: false, zoom: 1.3, key: "typing" },
        { dev: "a", state: "c_typed", dwell: 2.0, zoom: 1.2, key: "pay" },
        { dev: "a", state: "c_done", dwell: 4.6, tap: false, zoom: 1, caption: cap("05", "Cobrado. Mesa libre.", "Imprime el ticket y la venta entra al corte de caja.") },
      ],
      typing(t, devs, m) {
        const input = devs.a.app.querySelector(".sheet input[placeholder=Monto]");
        if (!input) return;
        const k = m.typing;
        if (t >= k.start && t < k.end) {
          const n = Math.min(4, Math.floor((t - k.start) / 0.2) + 1);
          input.value = "1100".slice(0, n);
          input.setAttribute("value", input.value);
        } else if (t < k.start) { input.value = ""; input.setAttribute("value", ""); }
      },
      extras: [
        ticket({ x: 70, y: 660, w: 330, name: "CAJA", key: "pay", at: 0.1, dur: 2.0, lines: "\n <b> MARISCOS EL FARO</b>\n <b> MESA T4 · MARCO</b>\n --------------------------\n 1 Torre de cerveza   260.00\n 1 Mariscada p/2      690.00\n 1 Pay de limón        85.00\n --------------------------\n <b>TOTAL            1,035.00</b>\n EFECTIVO          1,100.00\n CAMBIO               65.00\n\n     ¡GRACIAS POR SU VISITA!\n" }),
      ],
    });
  };

  ({ pedido, cobro, cocina: () => cocinaLayout(true), hero: () => cocinaLayout(false) })[q]();
})();
