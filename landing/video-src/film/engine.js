/**
 * Motor de películas HTML.
 * Cada fotograma es una función PURA del tiempo: render(t) compone la interfaz real de la app (DOM capturado),
 * el cursor, los toques, la cámara, los subtítulos y los tickets. Así el renderizado a .mp4 es exacto y repetible.
 */
(() => {
  const W = 1920,
    H = 1080;
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const E = {
    lin: (t) => t,
    out: (t) => 1 - Math.pow(1 - t, 3),
    inout: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    soft: (t) => t * t * (3 - 2 * t),
    back: (t) => {
      const c = 1.7;
      return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
    },
  };

  const $ = (h) => {
    const d = document.createElement("div");
    d.innerHTML = h.trim();
    return d.firstElementChild;
  };
  const world = document.getElementById("world");
  const hud = document.getElementById("hud");
  const veil = document.getElementById("veil");

  // Fondo de papel con grano (determinista)
  document.getElementById("bg").style.cssText = `background:
    radial-gradient(1200px 700px at 78% 12%, rgba(255,89,0,.07), transparent 60%),
    radial-gradient(900px 600px at 5% 95%, rgba(20,17,15,.06), transparent 60%),
    url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.8' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 .2  0 0 0 0 .15  0 0 0 0 .1  0 0 0 .07 0'/></filter><rect width='240' height='240' filter='url(%23n)'/></svg>");`;

  const CURSOR =
    '<svg viewBox="0 0 24 24" width="38" height="38"><path d="M4 2.5v17l4.7-4.2 3 6.8 2.8-1.2-3-6.6H19L4 2.5z" fill="#fff" stroke="#14110f" stroke-width="1.5" stroke-linejoin="round"/></svg>';

  /** Interpola un valor a lo largo de claves [{t, v, e}] */
  function track(keys, t) {
    if (!keys.length) return 0;
    if (t <= keys[0].t) return keys[0].v;
    for (let i = 1; i < keys.length; i++) {
      if (t <= keys[i].t) {
        const a = keys[i - 1],
          b = keys[i];
        const u = (E[b.e || "inout"] || E.inout)(clamp((t - a.t) / (b.t - a.t || 1)));
        return Array.isArray(a.v) ? a.v.map((x, k) => lerp(x, b.v[k], u)) : lerp(a.v, b.v, u);
      }
    }
    return keys[keys.length - 1].v;
  }

  function define(scene) {
    const S = scene;
    const devs = {};
    // ───────── Dispositivos ─────────
    for (const [id, d] of Object.entries(S.devices)) {
      const el =
        $(`<div class="dev" style="left:${d.x}px;top:${d.y}px;width:${1280 * d.scale}px;height:${800 * d.scale}px">
        <div class="bezel"></div>
        ${d.label ? `<div class="label">${d.label}</div>` : ""}
        <div class="scr" style="transform:scale(${d.scale})">
          <div class="app" id="root"></div>
          <div class="fx"><div class="focus"></div><div class="rip"></div><div class="cur">${CURSOR}</div></div>
        </div>
      </div>`);
      world.appendChild(el);
      devs[id] = {
        ...d,
        el,
        app: el.querySelector(".app"),
        focus: el.querySelector(".focus"),
        rip: el.querySelector(".rip"),
        cur: el.querySelector(".cur"),
        state: null,
        cursorKeys: [],
        taps: [],
        focuses: [],
      };
    }

    // ───────── Compilación de la línea de tiempo ─────────
    const CC = S.camCenter ?? [W / 2, H / 2];
    if (S.clip)
      document.getElementById("vp").style.clipPath =
        `inset(${S.clip[1]}px ${W - S.clip[0] - S.clip[2]}px ${H - S.clip[1] - S.clip[3]}px ${S.clip[0]}px)`;
    const marks = {};
    let clock = S.start ?? 0.4;
    const prevCursor = {};
    const stateRuns = Object.fromEntries(Object.keys(devs).map((k) => [k, []]));
    const camKeys = [];
    const caps = [];
    S.steps.forEach((st, i) => {
      const d = devs[st.dev];
      const start = st.at ?? clock;
      const dwell = st.dwell ?? 1.6;
      const end = start + dwell;
      stateRuns[st.dev].push({ from: start, to: end, state: st.state, i });
      const tgt = STATES[st.state].target;
      let center = null;
      if (st.tap !== false && tgt) {
        center = [tgt.x + tgt.w / 2 + (st.dx ?? 0), tgt.y + tgt.h / 2 + (st.dy ?? 0)];
        const tapAt = end - 0.07;
        const leave = start + 0.1;
        const arrive = Math.min(leave + (st.travel ?? 0.85), tapAt - 0.18);
        const from = prevCursor[st.dev] ?? [center[0] + 260, center[1] + 200];
        d.cursorKeys.push(
          { t: leave, v: from, e: "lin" },
          { t: arrive, v: center, e: "inout", from, arc: true },
        );
        d.cursorKeys.push({ t: tapAt, v: center, e: "lin" });
        d.taps.push({ t: tapAt, x: center[0], y: center[1] });
        d.focuses.push({ a: leave + 0.1, b: tapAt + 0.12, rect: tgt });
        prevCursor[st.dev] = center;
      }
      if (st.key) marks[st.key] = { start, end, tap: end - 0.07 };
      if (st.caption) caps.push({ from: start, ...st.caption, i });
      // cámara: acerca al objetivo
      const z = st.zoom ?? 1;
      let fx, fy;
      if (z > 1 && center) {
        fx = d.x + center[0] * d.scale;
        fy = d.y + center[1] * d.scale;
      } else if (st.focusDev || z === 1) {
        fx = d.x + 640 * d.scale;
        fy = d.y + 400 * d.scale;
      }
      if (st.cam) {
        fx = st.cam[0];
        fy = st.cam[1];
      }
      if (st.nocam) {
        clock = end;
        return;
      }
      const nv = [z, fx ?? CC[0], fy ?? CC[1]];
      const prev = camKeys.length
        ? camKeys[camKeys.length - 1].v
        : (S.camStart ?? [1, CC[0], CC[1]]);
      camKeys.push(
        { t: start + 0.05, v: prev, e: "lin" },
        { t: start + 0.05 + (st.camTime ?? 0.95), v: nv, e: "inout" },
      );
      clock = end;
    });
    // cierra los subtítulos
    caps.forEach((c, k) => {
      c.to = caps[k + 1] ? caps[k + 1].from : clock;
    });
    const total = S.duration ?? clock + 0.8;
    // la cámara base (zoom 1, centro del escenario) antes del primer paso
    camKeys.unshift({ t: 0, v: S.camStart ?? [1, CC[0], CC[1]], e: "inout" });
    // estados por dispositivo: se mantienen hasta el siguiente
    for (const id of Object.keys(devs)) stateRuns[id].sort((a, b) => a.from - b.from);

    // subtítulos en el HUD
    const capEls = caps.map((c) => {
      const el =
        $(`<div class="cap" style="top:${S.capY ?? 250}px;left:${S.capX ?? 70}px;width:${S.capW ?? 440}px">
        <div class="n">${c.n}</div><div class="t">${c.t}</div>${c.s ? `<div class="s">${c.s}</div>` : ""}</div>`);
      hud.appendChild(el);
      return el;
    });

    // extras (tickets, rótulos…)
    const extras = (S.extras || []).map((x) =>
      x.create(x.layer === "world" ? world : hud, { $, E, clamp, lerp, track }, marks),
    );

    const arc = (a, b, u, mag = 0.12) => {
      const dx = b[0] - a[0],
        dy = b[1] - a[1];
      const len = Math.hypot(dx, dy);
      const off = Math.sin(Math.PI * u) * len * mag;
      return [
        lerp(a[0], b[0], u) - (dy / (len || 1)) * off,
        lerp(a[1], b[1], u) + (dx / (len || 1)) * off,
      ];
    };

    let lastHtml = {};
    async function render(t) {
      // 1) estados
      const loading = [];
      for (const [id, d] of Object.entries(devs)) {
        const runs = stateRuns[id];
        let cur = null;
        for (const r of runs) if (t >= r.from) cur = r;
        const name = cur ? cur.state : runs[0]?.state;
        if (name && lastHtml[id] !== name) {
          d.app.innerHTML = STATES[name].html.replace(/>-[0-9]+ min</g, ">0 min<");
          lastHtml[id] = name;
          d.app.querySelectorAll("img").forEach((im) => {
            if (!im.complete) loading.push(im.decode().catch(() => {}));
          });
        }
        // 2) cursor, foco y toques
        const keys = d.cursorKeys;
        if (keys.length) {
          let pos = keys[0].v;
          for (let i = 1; i < keys.length; i++) {
            if (t <= keys[i].t) {
              const a = keys[i - 1],
                b = keys[i];
              const u = (E[b.e] || E.inout)(clamp((t - a.t) / (b.t - a.t || 1)));
              pos = b.arc
                ? arc(b.from, b.v, u)
                : [lerp(a.v[0], b.v[0], u), lerp(a.v[1], b.v[1], u)];
              break;
            }
            pos = keys[i].v;
          }
          const lastT = keys[keys.length - 1].t;
          const vis =
            clamp((t - (keys[0].t - 0.05)) / 0.3) * (1 - clamp((t - (lastT + 0.7)) / 0.4));
          d.cur.style.left = pos[0] + "px";
          d.cur.style.top = pos[1] + "px";
          d.cur.style.opacity = vis;
          const press = d.taps.find((x) => t >= x.t - 0.05 && t <= x.t + 0.14);
          d.cur.style.transform = press ? "scale(.84)" : "scale(1)";
        }
        // anillo de foco sobre el objetivo
        const f = d.focuses.find((x) => t >= x.a && t <= x.b);
        if (f) {
          const u = clamp((t - f.a) / 0.25);
          const out = clamp((t - (f.b - 0.2)) / 0.2);
          d.focus.style.cssText = `left:${f.rect.x - 5}px;top:${f.rect.y - 5}px;width:${f.rect.w + 4}px;height:${f.rect.h + 4}px;opacity:${E.out(u) * (1 - out)};transform:scale(${lerp(1.08, 1, E.out(u))})`;
        } else d.focus.style.opacity = 0;
        // ondas del toque
        const tap = d.taps.find((x) => t >= x.t && t <= x.t + 0.6);
        if (tap) {
          const u = (t - tap.t) / 0.6;
          d.rip.style.left = tap.x + "px";
          d.rip.style.top = tap.y + "px";
          d.rip.style.opacity = 1 - u;
          d.rip.style.transform = `scale(${lerp(0.4, 2.6, E.out(u))})`;
        } else d.rip.style.opacity = 0;
      }
      // texto que se escribe (lo define cada escena)
      if (S.typing) S.typing(t, devs, marks);
      // 3) cámara
      const [z, fx, fy] = track(camKeys, t);
      const tx = CC[0] - fx * z,
        ty = CC[1] - fy * z;
      world.style.transform = `translate(${tx}px,${ty}px) scale(${z})`;
      // 4) subtítulos
      caps.forEach((c, k) => {
        const el = capEls[k];
        const inn = clamp((t - c.from) / 0.55);
        const out = clamp((t - (c.to - 0.3)) / 0.3);
        const show = t >= c.from && t <= c.to + 0.05;
        el.style.opacity = show ? E.out(inn) * (1 - out) : 0;
        el.style.transform = `translateY(${lerp(28, 0, E.out(inn)) - lerp(0, 18, out)}px)`;
      });
      // 5) extras
      extras.forEach((x) => x.update(t));
      // 6) velo de entrada/salida
      veil.style.opacity = Math.max(1 - clamp(t / 0.5), clamp((t - (total - 0.5)) / 0.5));
      if (loading.length) await Promise.all(loading);
      await document.fonts.ready;
    }
    window.FILM = { render, duration: total, id: S.id, w: W, h: H };
    return window.FILM;
  }

  window.Film = { define, E, clamp, lerp, track };
})();
