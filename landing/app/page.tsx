import Image from "next/image";
import { ContactForm } from "@/components/ContactForm";
import { Kyloo } from "@/components/Kyloo";
import { LoopVideo } from "@/components/LoopVideo";
import { HalftoneWaves } from "@/components/HalftoneWaves";
import { LiveClock } from "@/components/LiveClock";

/* ───────── Contenido ───────── */
const CAPITULOS = [
  {
    n: "01",
    video: "pedido",
    etiqueta: "MESA T3 · JUAN",
    titulo: "El mesero toma el pedido en un par de toques.",
    texto: "Abre la mesa, elige el platillo por su foto, personaliza con picante y extras, y envía. Las bebidas se van a la barra y la comida a su cocina.",
    lineas: [
      ["Abrir mesa", "1 toque"],
      ["Platillo con foto", "1 toque"],
      ["Picante y extras", "sin teclear"],
      ["Mandar a cocina y barra", "1 toque"],
    ],
  },
  {
    n: "02",
    video: "cocina",
    etiqueta: "COCINA · CEVICHERÍA",
    titulo: "La cocina lo ve al instante, sin gritarle al pase.",
    texto: "Cada estación tiene su pantalla y solo ve lo suyo. Marca Preparar y Listo, y el mesero recibe el aviso para llevarlo a la mesa.",
    lineas: [
      ["Comanda en pantalla", "al instante"],
      ["Preparar → Listo", "con tiempos"],
      ["Aviso al mesero", "automático"],
      ["Impresora de respaldo", "incluida"],
    ],
  },
  {
    n: "03",
    video: "cobro",
    etiqueta: "CAJA · MESA T4",
    titulo: "El cobro se hace donde está la mesa.",
    texto: "El mapa avisa qué mesa pidió la cuenta. Cobras completa o dividida, registras la propina, el sistema calcula el cambio e imprime el ticket.",
    lineas: [
      ["Cuenta completa", "✓"],
      ["Partes iguales o por asiento", "✓"],
      ["Efectivo, tarjeta, regalo", "mixto"],
      ["Corte de caja", "con diferencias"],
    ],
  },
] as const;

const CARTA: [string, string][] = [
  ["Áreas y mesas a tu medida", "Crea tus áreas, genera sus mesas con numeración y júntalas cuando llega un grupo."],
  ["Menú con fotos", "Categorías y subcategorías propias; cada platillo con su foto, tomada desde la tablet."],
  ["Rutas de producción", "El taco a cocina, la bebida a barra. Tú decides qué va a dónde."],
  ["Tickets a tu gusto", "Separadores, agrupado por categoría y pie con tu WiFi y redes."],
  ["Tiempos y retención", "Retén el plato fuerte y dispáralo cuando la entrada ya salió."],
  ["Cobro en partes", "Cuenta completa, partes iguales o por asiento, con tarjetas de regalo."],
  ["Propinas y checador", "Reparto por política, horas por trabajador y reporte del periodo."],
  ["Inventario por áreas", "Cocina, barra, limpieza… con tus propias categorías (perecederos, mariscos, enlatados), mínimos, máximos y aviso de cuándo pedir."],
  ["Listas de compras", "Se arman solas con lo que falta o a mano, y las compartes por enlace o WhatsApp para que quien compra las vaya marcando."],
  ["Recetario", "Guarda recetas de comida, tragos o salsas con tus categorías, escala las porciones y ve el costo por porción."],
  ["Comanda con mesa en grande", "El número de mesa sale enorme en el ticket de cocina: se lee de lejos, sin entrecerrar los ojos."],
  ["Reservaciones", "Agenda con mesa asignada y aviso en el mapa."],
  ["Para llevar y a domicilio", "Pedidos fuera de mesa con contacto, repartidor y cargo de envío."],
  ["Menú por QR", "El comensal ve el menú con fotos desde su teléfono."],
  ["Tu equipo con foto", "Cada trabajador entra con su PIN y su foto en la pantalla de inicio."],
];

const PLANES = [
  { id: "INICIO", sub: "Para probarlo", lineas: ["1 sucursal", "3 usuarios", "1 impresora", "Mesas, comandero, cocina y caja"], cta: "Empezar" },
  { id: "BÁSICO", sub: "Un restaurante", lineas: ["1 sucursal", "10 usuarios", "3 impresoras", "+ Inventario y a domicilio"], cta: "Cotizar" },
  { id: "PROFESIONAL", sub: "Para crecer", lineas: ["Hasta 3 sucursales", "30 usuarios", "10 impresoras", "+ Menú QR, analítica, facturación e integraciones"], cta: "Pedir demo", destacado: true },
  { id: "EMPRESARIAL", sub: "Cadenas", lineas: ["Sucursales ilimitadas", "Usuarios e impresoras sin límite", "Todas las funciones", "Consola en la nube"], cta: "Hablar con ventas" },
];

const FAQ: [string, string][] = [
  ["¿Funciona sin internet?", "Sí. Nodo corre en un equipo de tu local y los dispositivos se conectan por la red local. Vender, mandar a cocina, imprimir y cobrar no dependen del internet. Solo la sincronización en la nube (opcional) lo necesita, y se pone al corriente cuando regresa la conexión."],
  ["¿Qué dispositivos necesito?", "Una PC con Windows para el servidor, tablets o celulares para meseros, una pantalla para cocina y la caja táctil que ya tengas. Todos usan el navegador: no hay nada que instalar en ellos."],
  ["¿Con qué impresoras funciona?", "Con impresoras térmicas compatibles con ESC/POS por red (puerto 9100), de 58 u 80 mm. Puedes asignar una impresora de respaldo por estación."],
  ["¿Qué pasa si falla una impresora?", "La comanda se queda en cola, se reintenta y, si hay una de respaldo, pasa a ella. También puedes reimprimirla manualmente. Nunca se pierde un pedido."],
  ["¿Mis datos están seguros?", "La información vive en tu local, en una base de datos propia con respaldos automáticos. Cada trabajador entra con su PIN y ve solo lo que su puesto permite; las operaciones sensibles quedan en una bitácora."],
  ["¿Puedo ver una demo con mi menú?", "Sí. Cargamos tus categorías y platillos con fotos para que veas tu restaurante dentro de Nodo antes de decidir."],
];

const OTRAS = [
  ["analitica", "Analítica", "Ventas por hora, platillo y mesero."],
  ["inventario", "Inventario por áreas", "Categorías propias, mínimos y máximos."],
  ["listas", "Listas de compras", "Automáticas o manuales, compartibles."],
  ["recetas", "Recetario", "Por categorías, con costo por porción."],
  ["config-equipo", "Tu equipo", "Cada trabajador con su foto y PIN."],
  ["config-tickets", "Tickets", "Vista previa del ticket antes de imprimir."],
] as const;

/** Subrayado dibujado a mano bajo la palabra clave del titular */
function Garabato() {
  return (
    <svg className="garabato" viewBox="0 0 400 24" preserveAspectRatio="none" aria-hidden="true">
      <path d="M4 14 C 40 4, 70 22, 110 12 S 190 4, 230 14 S 320 22, 396 8" pathLength={1} />
    </svg>
  );
}

export default function Home() {
  return (
    <>
      <header className="top">
        <div className="wrap top-in">
          <a href="#inicio" className="logo" aria-label="Nodo">
            <img src="/brand/nodo.svg" alt="Nodo" height={34} />
          </a>
          <nav aria-label="Principal">
            <a href="#como">Cómo se ve</a>
            <a href="#carta">La carta</a>
            <a href="#planes">Planes</a>
            <a href="#preguntas">Preguntas</a>
          </nav>
          <a className="stub" href="#contacto">Pedir demo →</a>
        </div>
      </header>

      <main id="inicio">
        {/* ───────── Portada ───────── */}
        <section className="hero wrap">
          <p className="kicker">Comandero para restaurantes · funciona en tu red local</p>
          <h1>
            Se cae el internet.
            <br />
            El servicio <span className="sigue">sigue.<Garabato /></span>
          </h1>
          <div className="hero-sub">
            <p>
              Nodo conecta tablets, cocina, barra, caja e impresoras de tickets por tu propia red. Los meseros toman pedidos, la cocina los ve al instante y la caja cobra, aunque el WiFi ande mal.
            </p>
            <div className="hero-cta">
              <a className="btn-ink" href="#contacto">Pedir una demo</a>
              <a className="btn-text" href="#como">Ver cómo funciona ↓</a>
            </div>
          </div>

          <figure className="hero-vid">
            <LoopVideo src="/videos/hero.mp4" poster="/videos/hero.jpg" label="Mesero envía una comanda y la cocina la recibe al instante" />
            <div className="mini-tk" aria-hidden="true">
              <p className="mt-h">COMANDA #794</p>
              <p className="mt-s">T3 · JUAN · 03:12</p>
              <ul>
                <li>1 Ceviche mixto</li>
                <li>1 Aguachile verde</li>
                <li>1 Michelada</li>
              </ul>
              <p className="mt-f"><span>COCINA ✓</span><span>BARRA ✓</span></p>
            </div>
            <span className="sello" aria-hidden="true">
              <b>SIN INTERNET</b>
              <i>también se vende</i>
            </span>
            <figcaption>Fig. 1 — Del mesero a la cocina en un mismo flujo. Es el software real, no una maqueta.</figcaption>
          </figure>
        </section>

        <div className="perf" aria-hidden="true" />

        {/* ───────── Capítulos ───────── */}
        <section id="como" className="caps wrap">
          <header className="sec">
            <p className="kicker">Un servicio, de punta a punta</p>
            <h2>Tres momentos que hacen o deshacen una noche.</h2>
          </header>
          {CAPITULOS.map((c, i) => (
            <article key={c.n} className={`cap ${i % 2 ? "flip" : ""}`}>
              <div className="ticket">
                <p className="tk-head">{c.etiqueta}</p>
                <p className="tk-n">{c.n}</p>
                <h3>{c.titulo}</h3>
                <p className="tk-text">{c.texto}</p>
                <ul className="leaders">
                  {c.lineas.map(([a, b]) => (
                    <li key={a}><span>{a}</span><i /><b>{b}</b></li>
                  ))}
                </ul>
              </div>
              <LoopVideo
                className="cap-vid"
                src={`/videos/${c.video}.mp4`}
                poster={`/videos/${c.video}.jpg`}
                label={c.titulo}
              />
            </article>
          ))}
        </section>

        {/* ───────── La carta ───────── */}
        <section id="carta" className="carta">
          <div className="wrap">
            <header className="sec">
              <p className="kicker">Lo que incluye</p>
              <h2>La carta de Nodo.</h2>
            </header>
            <ol className="menu">
              {CARTA.map(([n, d], i) => (
                <li key={n}>
                  <span className="mn">{String(i + 1).padStart(2, "0")}</span>
                  <div>
                    <h3>{n}</h3>
                    <p>{d}</p>
                  </div>
                </li>
              ))}
            </ol>
            <div className="otras">
              {OTRAS.map(([f, t, d]) => (
                <figure key={f}>
                  <Image src={`/shots/${f}.jpg`} alt={`Pantalla de ${t} en Nodo`} width={960} height={600} sizes="(max-width: 800px) 90vw, 280px" />
                  <figcaption><b>{t}</b> {d}</figcaption>
                </figure>
              ))}
            </div>
          </div>
        </section>

        {/* ───────── Red local ───────── */}
        <section className="red wrap">
          <header className="sec">
            <p className="kicker">Cómo se conecta</p>
            <h2>Un servidor en tu local. Todo lo demás se conecta a él.</h2>
            <p className="sub">Instalas Nodo en una PC o mini-PC. Tablets y pantallas lo abren desde el navegador. Las impresoras se alcanzan por la misma red.</p>
          </header>
          <div className="diag">
            <ul className="nodes">
              <li><b>Tablets de meseros</b><span>WiFi</span></li>
              <li><b>Pantalla de cocina</b><span>Cable o WiFi</span></li>
              <li><b>Caja táctil</b><span>Cable</span></li>
            </ul>
            <div className="hilos" aria-hidden="true"><i /><i /><i /></div>
            <div className="core">
              <img src="/brand/icon.svg" alt="" width={72} height={72} />
              <b>Servidor Nodo</b>
              <span>PC del local · base propia · respaldos automáticos</span>
            </div>
            <div className="hilos" aria-hidden="true"><i /><i /><i /></div>
            <ul className="nodes">
              <li><b>Impresora de cocina</b><span>ESC/POS · red</span></li>
              <li><b>Impresora de barra</b><span>ESC/POS · red</span></li>
              <li><b>Impresora de caja</b><span>ESC/POS · red</span></li>
            </ul>
          </div>
          <p className="fine">Opcional: sincronización en la nube para varias sucursales, catálogo maestro y reportes de toda la cadena.</p>
        </section>

        {/* ───────── Planes ───────── */}
        <section id="planes" className="planes">
          <div className="wrap">
            <header className="sec light">
              <p className="kicker">Planes</p>
              <h2>Una comanda por plan, colgada en el riel.</h2>
              <p className="sub">Los precios se cotizan según tu operación. Pide una demo y te armamos una propuesta.</p>
            </header>
            <div className="riel">
              <div className="barra" aria-hidden="true" />
              <div className="colgados">
                {PLANES.map((p, i) => (
                  <article key={p.id} className={`pt ${p.destacado ? "hot" : ""}`} style={{ ["--r" as string]: `${[-1.4, 1.1, -0.6, 1.5][i]}deg`, ["--y" as string]: `${[0, 18, 6, 24][i]}px` }}>
                    <i className="clip" aria-hidden="true" />
                    <p className="pt-id">{p.id}</p>
                    <p className="pt-sub">{p.sub}</p>
                    <ul>
                      {p.lineas.map((l) => <li key={l}>{l}</li>)}
                    </ul>
                    <a href="#contacto">{p.cta} →</a>
                  </article>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* ───────── Preguntas ───────── */}
        <section id="preguntas" className="faq wrap">
          <header className="sec">
            <p className="kicker">Antes de empezar</p>
            <h2>Lo que nos preguntan los dueños.</h2>
          </header>
          <div className="qs">
            {FAQ.map(([q, a], i) => (
              <details key={q} open={i === 0}>
                <summary><span>P.{String(i + 1).padStart(2, "0")}</span>{q}</summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </section>
      </main>

      {/* ───────── Contacto ───────── */}
      <section id="contacto" className="cta">
        <div className="wrap cta-in">
          <p className="kicker">Demo gratuita</p>
          <h2>Veamos Nodo en tu restaurante.</h2>
          <p className="cta-sub">Cuéntanos de tu operación y te mostramos una demo con tu propio menú.</p>
          <ContactForm />
        </div>
      </section>

      {/* ───────── Pie (estilo kyloo.com.mx) ───────── */}
      <footer className="kfoot">
        <div className="kf-top kf-wrap">
          <nav className="kf-links" aria-label="Pie">
            {[["#como", "Cómo se ve"], ["#carta", "La carta"], ["#planes", "Planes"], ["#preguntas", "Preguntas"], ["#contacto", "Contacto"]].map(([h, t]) => (
              <a key={h} href={h}><span>{t}</span><i>→</i></a>
            ))}
          </nav>
          <div className="kf-side">
            <div>
              <p className="mono-lab">(DATOS DE CONTACTO)</p>
              <a className="kf-link" href="#contacto">↳ Pide tu demo</a>
              <p className="kf-muted">Instalación y capacitación en tu local.</p>
            </div>
            <div>
              <p className="mono-lab">(UN PRODUCTO DE)</p>
              <a className="by" href="https://kyloo.com.mx/" target="_blank" rel="noreferrer" aria-label="Kyloo">
                <span>by</span>
                <Kyloo width={96} />
              </a>
              <p className="kf-muted">Desde Cuernavaca, Morelos, México.</p>
            </div>
          </div>
        </div>
        <div className="kf-meta kf-wrap">
          <LiveClock />
          <a className="kf-up" href="#inicio">Volver arriba ↑</a>
          <p className="kf-copy">© {new Date().getFullYear()} Nodo · by Kyloo</p>
        </div>
        <div className="kf-wave" aria-label="Nodo">
          <HalftoneWaves className="kf-canvas" />
          <img className="kf-logo" src="/brand/nodo-light.svg" alt="Nodo" />
          <p className="kf-quote">『El servicio no se detiene.』</p>
        </div>
      </footer>
    </>
  );
}
