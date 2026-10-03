import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashSecret } from "./crypto";
import { newId, type Db } from "./db";
import { placeholderPng } from "./demo-png";

/**
 * Datos de demostración: "Mariscos El Faro", un restaurante de mariscos con 4 áreas de servicio, 3 de producción,
 * menú de ~60 platillos, inventario con recetas, personal, clientes, reservaciones, promociones y 14 días de ventas.
 * Es determinista (misma semilla = mismos datos) y solo corre sobre una base vacía.
 */

// ───────────── utilidades ─────────────
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const pesos = (n: number) => Math.round(n * 100);

export interface DemoSummary {
  establishment: string;
  users: { name: string; role: string; pin?: string; username?: string }[];
  counts: Record<string, number>;
  salesLast14Days: { accounts: number; salesCents: number };
}

// ───────────── catálogo ─────────────
type Groups = ("picante" | "guarnicion" | "extras")[];
interface P {
  n: string;
  price: number;
  g?: Groups;
  st?: string;
  r?: [string, number][];
}
interface Sub {
  name: string;
  hue: number;
  items: P[];
}
interface Top {
  name: string;
  station: string;
  subs: Sub[];
}

const MENU: Top[] = [
  {
    name: "Entradas",
    station: "Cevichería",
    subs: [
      {
        name: "Ceviches y aguachiles",
        hue: 160,
        items: [
          {
            n: "Ceviche de pescado",
            price: 145,
            g: ["picante", "extras"],
            r: [
              ["Filete de pescado", 120],
              ["Limón", 4],
              ["Cebolla morada", 30],
              ["Pepino", 25],
            ],
          },
          {
            n: "Ceviche mixto",
            price: 175,
            g: ["picante", "extras"],
            r: [
              ["Camarón", 60],
              ["Filete de pescado", 60],
              ["Pulpo", 40],
              ["Limón", 4],
            ],
          },
          {
            n: "Aguachile verde",
            price: 185,
            g: ["picante"],
            r: [
              ["Camarón", 140],
              ["Limón", 5],
              ["Pepino", 40],
              ["Cebolla morada", 20],
            ],
          },
          {
            n: "Aguachile rojo",
            price: 185,
            g: ["picante"],
            r: [
              ["Camarón", 140],
              ["Limón", 5],
              ["Pepino", 40],
              ["Cebolla morada", 20],
            ],
          },
          {
            n: "Aguachile negro",
            price: 195,
            g: ["picante"],
            r: [
              ["Camarón", 140],
              ["Limón", 5],
            ],
          },
          {
            n: "Tiradito de pescado",
            price: 190,
            r: [
              ["Filete de pescado", 130],
              ["Limón", 3],
            ],
          },
        ],
      },
      {
        name: "Cocteles de mariscos",
        hue: 12,
        items: [
          {
            n: "Coctel de camarón",
            price: 165,
            g: ["picante"],
            r: [
              ["Camarón", 150],
              ["Limón", 2],
              ["Aguacate", 0.3],
            ],
          },
          {
            n: "Coctel campechano",
            price: 195,
            g: ["picante"],
            r: [
              ["Camarón", 90],
              ["Pulpo", 60],
              ["Ostión", 3],
              ["Limón", 2],
            ],
          },
          {
            n: "Coctel de pulpo",
            price: 185,
            g: ["picante"],
            r: [
              ["Pulpo", 150],
              ["Limón", 2],
            ],
          },
        ],
      },
      {
        name: "Tostadas y crudos",
        hue: 40,
        items: [
          {
            n: "Tostada de pescado",
            price: 85,
            r: [
              ["Filete de pescado", 70],
              ["Tostadas", 1],
              ["Aguacate", 0.2],
            ],
          },
          {
            n: "Tostada de camarón",
            price: 95,
            r: [
              ["Camarón", 60],
              ["Tostadas", 1],
              ["Aguacate", 0.2],
            ],
          },
          {
            n: "Ostiones (6 pzas)",
            price: 210,
            r: [
              ["Ostión", 6],
              ["Limón", 1],
            ],
          },
          {
            n: "Callo de hacha (2 pzas)",
            price: 220,
            r: [
              ["Callo de hacha", 2],
              ["Limón", 2],
            ],
          },
        ],
      },
    ],
  },
  {
    name: "Platos fuertes",
    station: "Parrilla",
    subs: [
      {
        name: "Pescados",
        hue: 205,
        items: [
          {
            n: "Filete empapelado",
            price: 235,
            g: ["guarnicion", "extras"],
            r: [["Filete de pescado", 220]],
          },
          {
            n: "Pescado zarandeado",
            price: 385,
            g: ["guarnicion", "extras"],
            r: [["Pescado entero", 1]],
          },
          {
            n: "Huachinango frito",
            price: 345,
            g: ["guarnicion", "extras"],
            st: "Freidora",
            r: [
              ["Pescado entero", 1],
              ["Papa", 120],
            ],
          },
          {
            n: "Filete a la plancha",
            price: 225,
            g: ["guarnicion", "extras"],
            r: [["Filete de pescado", 220]],
          },
          {
            n: "Mojarra frita",
            price: 195,
            g: ["guarnicion"],
            st: "Freidora",
            r: [["Pescado entero", 1]],
          },
        ],
      },
      {
        name: "Camarones",
        hue: 18,
        items: [
          {
            n: "Camarones al mojo de ajo",
            price: 245,
            g: ["guarnicion", "extras"],
            r: [
              ["Camarón", 200],
              ["Arroz", 120],
            ],
          },
          {
            n: "Camarones a la diabla",
            price: 255,
            g: ["picante", "guarnicion", "extras"],
            r: [
              ["Camarón", 200],
              ["Arroz", 120],
            ],
          },
          {
            n: "Camarones empanizados",
            price: 245,
            g: ["guarnicion"],
            st: "Freidora",
            r: [
              ["Camarón", 200],
              ["Papa", 150],
              ["Pan molido", 40],
              ["Huevo", 1],
              ["Aceite vegetal", 60],
            ],
          },
          {
            n: "Camarones al coco",
            price: 265,
            g: ["guarnicion"],
            st: "Freidora",
            r: [
              ["Camarón", 200],
              ["Papa", 120],
            ],
          },
          { n: "Brocheta de camarón", price: 255, g: ["guarnicion"], r: [["Camarón", 220]] },
        ],
      },
      {
        name: "Pulpo y calamar",
        hue: 285,
        items: [
          {
            n: "Pulpo a las brasas",
            price: 325,
            g: ["guarnicion", "extras"],
            r: [
              ["Pulpo", 250],
              ["Papa", 120],
            ],
          },
          {
            n: "Pulpo a la diabla",
            price: 335,
            g: ["picante", "guarnicion"],
            r: [
              ["Pulpo", 250],
              ["Arroz", 120],
            ],
          },
          {
            n: "Calamares fritos",
            price: 215,
            g: ["picante"],
            st: "Freidora",
            r: [
              ["Calamar", 220],
              ["Papa", 100],
            ],
          },
        ],
      },
      {
        name: "Mariscadas",
        hue: 350,
        items: [
          {
            n: "Mariscada para 2",
            price: 690,
            g: ["picante", "guarnicion"],
            r: [
              ["Camarón", 150],
              ["Pulpo", 120],
              ["Filete de pescado", 150],
              ["Calamar", 100],
            ],
          },
          {
            n: "Torre de mariscos",
            price: 890,
            r: [
              ["Camarón", 180],
              ["Ostión", 6],
              ["Pulpo", 100],
              ["Callo de hacha", 2],
            ],
          },
          {
            n: "Parrillada del mar",
            price: 1150,
            g: ["guarnicion"],
            r: [
              ["Camarón", 250],
              ["Pulpo", 200],
              ["Filete de pescado", 250],
              ["Calamar", 150],
            ],
          },
        ],
      },
    ],
  },
  {
    name: "Tacos",
    station: "Freidora",
    subs: [
      {
        name: "Tacos de pescado",
        hue: 50,
        items: [
          {
            n: "Taco de pescado",
            price: 55,
            g: ["picante", "extras"],
            r: [
              ["Filete de pescado", 70],
              ["Tortilla de maíz", 2],
            ],
          },
          {
            n: "Taco gobernador",
            price: 75,
            g: ["picante"],
            r: [
              ["Camarón", 50],
              ["Tortilla de maíz", 2],
            ],
          },
        ],
      },
      {
        name: "Tacos de camarón y pulpo",
        hue: 28,
        items: [
          {
            n: "Taco de camarón",
            price: 65,
            g: ["picante", "extras"],
            r: [
              ["Camarón", 50],
              ["Tortilla de maíz", 2],
            ],
          },
          {
            n: "Taco de pulpo",
            price: 85,
            g: ["picante"],
            r: [
              ["Pulpo", 50],
              ["Tortilla de maíz", 2],
            ],
          },
          {
            n: "Taco de marlín",
            price: 70,
            g: ["picante"],
            r: [
              ["Filete de pescado", 60],
              ["Tortilla de maíz", 2],
            ],
          },
        ],
      },
    ],
  },
  {
    name: "Caldos y sopas",
    station: "Parrilla",
    subs: [
      {
        name: "Caldos y sopas",
        hue: 30,
        items: [
          { n: "Caldo de camarón", price: 185, g: ["picante"], r: [["Camarón", 140]] },
          { n: "Caldo de pescado", price: 165, g: ["picante"], r: [["Filete de pescado", 160]] },
          {
            n: "Sopa de mariscos",
            price: 215,
            g: ["picante"],
            r: [
              ["Camarón", 70],
              ["Pulpo", 50],
              ["Calamar", 50],
            ],
          },
          {
            n: "Caldo largo",
            price: 195,
            g: ["picante"],
            r: [
              ["Pescado entero", 0.5],
              ["Camarón", 60],
            ],
          },
        ],
      },
    ],
  },
  {
    name: "Bebidas",
    station: "Barra",
    subs: [
      {
        name: "Refrescos y aguas",
        hue: 215,
        items: [
          { n: "Coca Cola", price: 38, r: [["Refresco", 1]] },
          { n: "Sprite", price: 38, r: [["Sprite", 1]] },
          { n: "Agua mineral", price: 35, r: [["Agua mineral (botella)", 1]] },
          { n: "Agua embotellada", price: 28, r: [["Agua embotellada (botella)", 1]] },
        ],
      },
      {
        name: "Cervezas",
        hue: 45,
        items: [
          { n: "Cerveza Corona", price: 50, r: [["Cerveza Corona", 1]] },
          { n: "Cerveza Victoria", price: 48, r: [["Cerveza Victoria", 1]] },
          { n: "Cerveza Modelo", price: 55, r: [["Cerveza Modelo", 1]] },
          { n: "Cerveza Pacífico", price: 52, r: [["Cerveza Pacífico", 1]] },
          { n: "Torre de cerveza (3 L)", price: 260 },
        ],
      },
      {
        name: "Preparados y cocteles",
        hue: 330,
        items: [
          {
            n: "Michelada",
            price: 85,
            r: [
              ["Cerveza Corona", 1],
              ["Limón", 1],
            ],
          },
          {
            n: "Clamato preparado",
            price: 95,
            r: [
              ["Cerveza Victoria", 1],
              ["Limón", 1],
              ["Clamato", 150],
            ],
          },
          {
            n: "Margarita",
            price: 110,
            r: [
              ["Tequila", 60],
              ["Limón", 2],
            ],
          },
          {
            n: "Mojito",
            price: 115,
            r: [
              ["Ron", 60],
              ["Limón", 2],
            ],
          },
          {
            n: "Piña colada",
            price: 120,
            r: [
              ["Ron", 60],
              ["Piña", 0.2],
              ["Leche de coco", 60],
            ],
          },
          { n: "Paloma", price: 105, r: [["Tequila", 60]] },
        ],
      },
      {
        name: "Aguas frescas",
        hue: 120,
        items: [
          {
            n: "Agua de jamaica",
            price: 45,
            r: [
              ["Jamaica", 25],
              ["Azúcar", 30],
            ],
          },
          { n: "Limonada", price: 45, r: [["Limón", 3]] },
          { n: "Agua de horchata", price: 45 },
          {
            n: "Naranjada",
            price: 48,
            r: [
              ["Naranja", 2],
              ["Azúcar", 20],
            ],
          },
        ],
      },
    ],
  },
  {
    name: "Postres",
    station: "Cevichería",
    subs: [
      {
        name: "Postres",
        hue: 300,
        items: [
          {
            n: "Flan napolitano",
            price: 70,
            r: [
              ["Huevo", 1],
              ["Leche entera", 150],
              ["Azúcar", 40],
            ],
          },
          { n: "Pay de limón", price: 85 },
          { n: "Helado de vainilla", price: 60, r: [["Helado de vainilla (bote)", 120]] },
          {
            n: "Plátano frito con helado",
            price: 95,
            r: [
              ["Plátano macho", 1],
              ["Helado de vainilla (bote)", 100],
              ["Aceite vegetal", 40],
            ],
          },
        ],
      },
    ],
  },
];

const INVENTORY: [string, string, number, number, number][] = [
  // nombre, unidad, existencia, mínimo, costo por unidad en centavos
  ["Camarón", "g", 18000, 5000, 28],
  ["Filete de pescado", "g", 22000, 6000, 16],
  ["Pescado entero", "pza", 40, 12, 14000],
  ["Pulpo", "g", 2400, 3000, 38],
  ["Calamar", "g", 7000, 2500, 20],
  ["Ostión", "pza", 0, 60, 700],
  ["Callo de hacha", "pza", 60, 20, 2400],
  ["Limón", "pza", 420, 300, 120],
  ["Aguacate", "pza", 70, 25, 1800],
  ["Cebolla morada", "g", 8000, 2000, 3],
  ["Pepino", "g", 6000, 1500, 2],
  ["Tostadas", "pza", 180, 250, 120],
  ["Tortilla de maíz", "pza", 1500, 400, 80],
  ["Arroz", "g", 12000, 3000, 3],
  ["Papa", "g", 20000, 5000, 3],
  ["Cerveza Corona", "pza", 220, 96, 2300],
  ["Cerveza Victoria", "pza", 140, 72, 2100],
  ["Cerveza Modelo", "pza", 120, 72, 2300],
  ["Refresco", "pza", 300, 96, 1300],
  ["Tequila", "ml", 6000, 1500, 55],
  ["Ron", "ml", 5000, 1500, 40],
  // Mariscos y pescados adicionales
  ["Jaiba", "g", 3500, 1500, 22],
  ["Almeja", "pza", 90, 40, 450],
  ["Mejillón", "g", 2500, 1000, 14],
  ["Atún (lomo)", "g", 4200, 1500, 38],
  ["Marlín ahumado", "g", 2200, 800, 30],
  ["Camarón jumbo", "g", 5200, 2000, 42],
  ["Langostino", "g", 1800, 1000, 55],
  ["Huachinango entero", "pza", 14, 8, 17000],
  ["Tilapia", "pza", 25, 10, 9000],
  ["Sierra (filete)", "g", 3800, 1500, 15],
  // Verduras y fruta
  ["Jitomate", "g", 9000, 3000, 2],
  ["Cebolla blanca", "g", 7500, 2500, 2],
  ["Cilantro", "g", 1200, 600, 6],
  ["Chile serrano", "g", 1800, 800, 5],
  ["Chile jalapeño", "g", 2200, 800, 4],
  ["Chile de árbol", "g", 600, 300, 18],
  ["Ajo", "g", 1500, 500, 8],
  ["Lechuga", "pza", 30, 12, 1800],
  ["Zanahoria", "g", 4000, 1500, 2],
  ["Col morada", "g", 3000, 1000, 2],
  ["Naranja", "pza", 90, 40, 250],
  ["Piña", "pza", 12, 6, 3500],
  ["Mango", "pza", 28, 10, 1200],
  ["Coco rallado", "g", 1500, 500, 9],
  ["Hierbabuena", "g", 400, 200, 12],
  // Abarrotes y lácteos
  ["Aceite vegetal", "ml", 45000, 15000, 4],
  ["Mantequilla", "g", 4000, 1500, 11],
  ["Crema", "ml", 6000, 2000, 3],
  ["Queso Oaxaca", "g", 3500, 1200, 17],
  ["Queso panela", "g", 2500, 800, 15],
  ["Huevo", "pza", 180, 60, 300],
  ["Harina", "g", 12000, 4000, 2],
  ["Pan molido", "g", 4000, 1500, 3],
  ["Sal", "g", 8000, 2000, 1],
  ["Pimienta", "g", 500, 200, 40],
  ["Mayonesa", "g", 5000, 1500, 4],
  ["Salsa Valentina", "ml", 9000, 3000, 2],
  ["Salsa Maggi", "ml", 2500, 1000, 5],
  ["Salsa inglesa", "ml", 2000, 800, 6],
  ["Catsup", "g", 5000, 1500, 3],
  ["Clamato", "ml", 18000, 6000, 2],
  ["Jugo de naranja", "ml", 6000, 2000, 2],
  ["Leche de coco", "ml", 3000, 1000, 6],
  ["Leche entera", "ml", 8000, 3000, 2],
  ["Helado de vainilla (bote)", "ml", 12000, 4000, 3],
  ["Azúcar", "g", 10000, 3000, 2],
  ["Jamaica", "g", 1800, 600, 12],
  ["Horchata (base)", "g", 3000, 1000, 5],
  ["Hielo", "g", 150000, 50000, 1],
  ["Plátano macho", "pza", 40, 15, 600],
  // Bebidas y licores
  ["Cerveza Pacífico", "pza", 130, 72, 2200],
  ["Cerveza Modelo Negra", "pza", 48, 36, 2400],
  ["Sprite", "pza", 150, 48, 1300],
  ["Agua mineral (botella)", "pza", 110, 48, 900],
  ["Agua embotellada (botella)", "pza", 160, 72, 700],
  ["Mezcal", "ml", 3500, 1000, 90],
  ["Vodka", "ml", 3000, 1000, 50],
  ["Whisky", "ml", 3500, 1000, 70],
  ["Triple sec", "ml", 2500, 800, 45],
  ["Vino blanco", "ml", 7500, 3000, 35],
  // Desechables y limpieza
  ["Servilletas (paquete)", "pza", 40, 15, 3500],
  ["Bolsas para llevar", "pza", 300, 100, 80],
  ["Contenedores desechables", "pza", 400, 150, 280],
  ["Popotes", "pza", 600, 200, 15],
  ["Rollo térmico 80 mm", "pza", 18, 8, 3200],
  ["Gas LP (kg)", "pza", 70, 30, 2200],
  ["Jabón para trastes", "ml", 9000, 3000, 2],
  ["Cloro", "ml", 12000, 4000, 1],
  ["Guantes (caja)", "pza", 6, 4, 14500],
  ["Carbón (saco)", "pza", 10, 6, 28000],
];

const MOD_GROUPS = {
  picante: {
    name: "Picante",
    required: 0,
    multiple: 0,
    max: null as number | null,
    opts: [
      ["Sin picante", 0],
      ["Poco picante", 0],
      ["Normal", 0],
      ["Extra picante", 0],
    ] as [string, number][],
  },
  guarnicion: {
    name: "Guarnición",
    required: 1,
    multiple: 0,
    max: null,
    opts: [
      ["Papas fritas", 0],
      ["Arroz", 0],
      ["Ensalada", 0],
      ["Verduras al vapor", 0],
    ] as [string, number][],
  },
  extras: {
    name: "Extras",
    required: 0,
    multiple: 1,
    max: 3,
    opts: [
      ["Aguacate", 2500],
      ["Queso", 2000],
      ["Extra camarón", 6000],
      ["Chiles toreados", 1500],
    ] as [string, number][],
  },
};

// ───────────── generador ─────────────
export async function seedDemo(
  db: Db,
  opts: { photosDir: string; now?: number; days?: number; seed?: number },
): Promise<DemoSummary> {
  if (((await db.prepare("SELECT COUNT(*) c FROM users").get()) as { c: number }).c > 0) {
    throw new Error("La base ya tiene datos: la demo solo se carga en una base vacía.");
  }
  const NOW = opts.now ?? Date.now();
  const DAYS = opts.days ?? 14;
  const rand = rng(opts.seed ?? 20261001);
  const pick = <T>(a: readonly T[]) => a[Math.floor(rand() * a.length)]!;
  const int = (a: number, b: number) => a + Math.floor(rand() * (b - a + 1));
  const chance = (p: number) => rand() < p;
  const weighted = <T>(items: readonly T[], w: (t: T) => number): T => {
    const total = items.reduce((s, i) => s + w(i), 0);
    let r = rand() * total;
    for (const i of items) {
      r -= w(i);
      if (r <= 0) return i;
    }
    return items[items.length - 1]!;
  };
  const run = (sql: string, ...args: unknown[]) => db.prepare(sql).run(...args);
  const one = async <T>(sql: string, ...args: unknown[]) =>
    (await db.prepare(sql).get(...args)) as T | undefined;
  const dayStart = (offset: number) => {
    const d = new Date(NOW);
    d.setHours(0, 0, 0, 0);
    return d.getTime() + offset * DAY;
  };

  const counts: Record<string, number> = {};
  const bump = (k: string, n = 1) => (counts[k] = (counts[k] ?? 0) + n);

  let summary: DemoSummary | null = null;

  await db.transaction(async () => {
    // ── Personal ──
    const users: DemoSummary["users"] = [];
    const staff: Record<string, { id: string; role: string }> = {};
    const addUser = async (
      name: string,
      role: string,
      o: { pin?: string; username?: string; password?: string },
    ) => {
      const id = newId();
      await run(
        "INSERT INTO users (id,name,username,role,pin_hash,password_hash,created_at) VALUES (?,?,?,?,?,?,?)",
        id,
        name,
        o.username ?? null,
        role,
        o.pin ? hashSecret(o.pin) : null,
        o.password ? hashSecret(o.password) : null,
        NOW - 90 * DAY,
      );
      staff[name] = { id, role };
      users.push({ name, role, pin: o.pin, username: o.username });
      bump("usuarios");
      return id;
    };
    await addUser("Administrador", "admin", { username: "admin", password: "admin1234" });
    await addUser("Sofía Ramírez", "gerente", { pin: "6666" });
    await addUser("Juan", "mesero", { pin: "1111" });
    await addUser("Pedro", "mesero", { pin: "2222" });
    await addUser("Lucía", "mesero", { pin: "4444" });
    await addUser("Marco", "mesero", { pin: "5555" });
    await addUser("Caja", "cajero", { pin: "3333" });
    await addUser("Chef Ramón", "cocina", { pin: "7777" });
    await addUser("Barman Toño", "bar", { pin: "8888" });
    const meseros = ["Juan", "Pedro", "Lucía", "Marco"].map((n) => staff[n]!.id);
    const cajero = staff["Caja"]!.id;

    // ── Ajustes del negocio ──
    const setting = (k: string, v: string) =>
      run(
        "INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        k,
        v,
      );
    await setting("establishment_name", "Mariscos El Faro");
    await setting("discount_limit_pct", "10");
    await setting("service_charge_pct", "10");
    await setting("service_charge_min_guests", "8");
    await setting("tip_policy", "individual");
    await setting("tip_support_pct", "20");
    await setting("tip_roles", JSON.stringify({ mesero: 60, cocina: 25, bar: 15 }));
    await setting("ticket_separator", "=");
    await setting("ticket_group_categories", "1");
    await setting(
      "ticket_footer",
      "WiFi: elfaro2026\nSíguenos @mariscoselfaro\nGracias por su visita",
    );
    await setting("fiscal_rfc", "EKU9003173C9");
    await setting("fiscal_name", "Mariscos El Faro SA de CV");
    await setting("fiscal_regimen", "601");
    await setting("fiscal_cp", "82000");

    // ── Impresoras, áreas de producción y estaciones ──
    const printer = async (name: string, kind: string, host: string) => {
      const id = newId();
      await run("INSERT INTO printers (id,name,kind,host) VALUES (?,?,?,?)", id, name, kind, host);
      bump("impresoras");
      return id;
    };
    const pCocina = await printer("Cocina", "cocina", "192.168.1.50");
    const pCev = await printer("Cevichería", "cocina", "192.168.1.51");
    const pBar = await printer("Barra", "bar", "192.168.1.52");
    await printer("Caja", "caja", "192.168.1.53");

    const stationIds: Record<string, string> = {};
    const area = async (name: string) => {
      const id = newId();
      await run("INSERT INTO areas (id,name,kind) VALUES (?,?,'produccion')", id, name);
      return id;
    };
    const station = async (areaId: string, name: string, printerId: string, secondary?: string) => {
      const sub = newId();
      await run("INSERT INTO subareas (id,area_id,name) VALUES (?,?,?)", sub, areaId, name);
      const id = newId();
      await run(
        "INSERT INTO stations (id,subarea_id,name,primary_printer_id,secondary_printer_id) VALUES (?,?,?,?,?)",
        id,
        sub,
        name,
        printerId,
        secondary ?? null,
      );
      stationIds[name] = id;
      bump("estaciones");
    };
    const aCocina = await area("Cocina");
    await station(aCocina, "Parrilla", pCocina, pCev); // si falla la impresora de parrilla, sale por la de cevichería
    await station(aCocina, "Freidora", pCocina);
    await station(await area("Cevichería"), "Cevichería", pCev);
    await station(await area("Bar"), "Barra", pBar);
    bump("areas", 3);

    // ── Áreas de servicio y mesas ──
    const tableIds: string[] = [];
    const tablesByNumber: Record<string, string> = {};
    const zone = async (
      name: string,
      prefix: string,
      count: number,
      capacity: number,
      vipFrom = 99,
    ) => {
      const id = newId();
      await run(
        "INSERT INTO zones (id,name,prefix,sort) VALUES (?,?,?,?)",
        id,
        name,
        prefix,
        bump("zonas"),
      );
      for (let i = 1; i <= count; i++) {
        const tid = newId();
        await run(
          "INSERT INTO tables_ (id,zone_id,number,capacity,vip,pos_x,pos_y) VALUES (?,?,?,?,?,?,?)",
          tid,
          id,
          `${prefix}${i}`,
          capacity,
          i >= vipFrom ? 1 : 0,
          ((i - 1) % 5) * 140,
          Math.floor((i - 1) / 5) * 140,
        );
        tableIds.push(tid);
        tablesByNumber[`${prefix}${i}`] = tid;
        bump("mesas");
      }
    };
    await zone("Salón", "S", 10, 4);
    await zone("Terraza", "T", 8, 4);
    await zone("Barra", "B", 6, 2);
    await zone("Privado", "P", 2, 10, 1);

    // ── Modificadores ──
    const groupIds: Record<string, string> = {};
    for (const [key, g] of Object.entries(MOD_GROUPS)) {
      const gid = newId();
      groupIds[key] = gid;
      await run(
        "INSERT INTO modifier_groups (id,name,required,multiple,max_select) VALUES (?,?,?,?,?)",
        gid,
        g.name,
        g.required,
        g.multiple,
        g.max,
      );
      for (const [name, price] of g.opts)
        await run(
          "INSERT INTO modifiers (id,group_id,name,price_cents) VALUES (?,?,?,?)",
          newId(),
          gid,
          name,
          price,
        );
      bump("grupos de modificadores");
    }

    // ── Categorías y productos (con foto de relleno y destino por categoría) ──
    mkdirSync(opts.photosDir, { recursive: true });
    const inv: Record<string, string> = {};
    for (const [name, unit, stock, min, cost] of INVENTORY) {
      const id = newId();
      inv[name] = id;
      await run(
        "INSERT INTO inventory_items (id,name,unit,stock,min_stock,unit_cost_cents) VALUES (?,?,?,?,?,?)",
        id,
        name,
        unit,
        stock,
        min,
        cost,
      );
      if (stock > 0)
        await run(
          "INSERT INTO inventory_movements (id,item_id,kind,quantity,unit_cost_cents,reason,user_id,created_at) VALUES (?,?,'entrada',?,?,?,?,?)",
          newId(),
          id,
          stock,
          cost,
          "Inventario inicial",
          staff["Sofía Ramírez"]!.id,
          NOW - 15 * DAY,
        );
      bump("insumos");
    }

    interface Prod {
      id: string;
      name: string;
      price: number;
      top: string;
      sub: string;
      stations: string[];
    }
    const products: Prod[] = [];
    let sort = 0;
    let pIndex = 0;
    for (const top of MENU) {
      const topId = newId();
      await run("INSERT INTO categories (id,name,sort) VALUES (?,?,?)", topId, top.name, sort++);
      await run(
        "INSERT INTO category_routes (category_id,station_id) VALUES (?,?)",
        topId,
        stationIds[top.station],
      );
      const multiSub = top.subs.length > 1 || top.subs[0]!.name !== top.name;
      for (const sub of top.subs) {
        let catId = topId;
        if (multiSub) {
          catId = newId();
          await run(
            "INSERT INTO categories (id,parent_id,name,sort) VALUES (?,?,?,?)",
            catId,
            topId,
            sub.name,
            sort++,
          );
        }
        bump("categorías", multiSub ? 1 : 0);
        for (const p of sub.items) {
          const id = newId();
          const png = `${id}-${Math.floor(rand() * 0xffffffff)
            .toString(16)
            .padStart(8, "0")
            .slice(0, 8)}.png`;
          writeFileSync(join(opts.photosDir, png), placeholderPng((sub.hue + pIndex * 9) % 360));
          await run(
            "INSERT INTO products (id,category_id,name,price_cents,photo,prep_minutes) VALUES (?,?,?,?,?,?)",
            id,
            catId,
            p.n,
            pesos(p.price),
            png,
            top.name === "Bebidas" ? 3 : int(8, 22),
          );
          const st = stationIds[p.st ?? top.station]!;
          await run("INSERT INTO product_routes (product_id,station_id) VALUES (?,?)", id, st);
          for (const g of p.g ?? [])
            await run(
              "INSERT INTO product_modifier_groups (product_id,group_id) VALUES (?,?)",
              id,
              groupIds[g],
            );
          for (const [item, qty] of p.r ?? [])
            await run(
              "INSERT INTO recipe_lines (product_id,item_id,quantity) VALUES (?,?,?)",
              id,
              inv[item],
              qty,
            );
          products.push({
            id,
            name: p.n,
            price: pesos(p.price),
            top: top.name,
            sub: sub.name,
            stations: [st],
          });
          bump("productos");
          pIndex++;
        }
      }
    }
    bump("categorías", MENU.length);
    await run(
      "UPDATE products SET availability='agotado' WHERE name IN ('Ostiones (6 pzas)', 'Torre de mariscos')",
    ); // 86: se acabaron

    // ── Proveedores y compras ──
    const supplier = async (name: string, contact: string, phone: string, rfc: string) => {
      const id = newId();
      await run(
        "INSERT INTO suppliers (id,name,contact,phone,rfc,email) VALUES (?,?,?,?,?,?)",
        id,
        name,
        contact,
        phone,
        rfc,
        `${name.split(" ")[0]!.toLowerCase()}@proveedor.mx`,
      );
      bump("proveedores");
      return id;
    };
    const sPesca = await supplier(
      "Pescadería del Puerto",
      "Don Chuy",
      "669 123 4567",
      "PPU010101AB1",
    );
    const sBeto = await supplier(
      "Mariscos Don Beto",
      "Beto Salazar",
      "669 987 6543",
      "MDB020202CD2",
    );
    const sBebidas = await supplier(
      "Distribuidora de Bebidas del Golfo",
      "Karla",
      "669 555 0101",
      "DBG030303EF3",
    );
    await supplier("Abarrotes La Estrella", "Doña Mary", "669 444 0202", "ALE040404GH4");
    const po = async (
      supplierId: string,
      status: string,
      lines: [string, number, number][],
      daysAgo: number,
    ) => {
      const id = newId();
      const at = NOW - daysAgo * DAY;
      await run(
        "INSERT INTO purchase_orders (id,supplier_id,status,invoice_ref,created_by,created_at,received_at) VALUES (?,?,?,?,?,?,?)",
        id,
        supplierId,
        status,
        status === "recibida" ? `F-${int(1000, 9999)}` : null,
        staff["Sofía Ramírez"]!.id,
        at,
        status === "recibida" ? at + 4 * HOUR : null,
      );
      for (const [item, qty, cost] of lines) {
        await run(
          "INSERT INTO purchase_lines (id,po_id,item_id,quantity,unit_cost_cents) VALUES (?,?,?,?,?)",
          newId(),
          id,
          inv[item],
          qty,
          cost,
        );
        if (status === "recibida")
          await run(
            "INSERT INTO inventory_movements (id,item_id,kind,quantity,unit_cost_cents,reason,user_id,ref,created_at) VALUES (?,?,'compra',?,?,?,?,?,?)",
            newId(),
            inv[item],
            qty,
            cost,
            "Recepción de compra",
            staff["Sofía Ramírez"]!.id,
            id,
            at + 4 * HOUR,
          );
      }
      bump("órdenes de compra");
    };
    await po(
      sPesca,
      "recibida",
      [
        ["Camarón", 10000, 28],
        ["Filete de pescado", 12000, 16],
        ["Calamar", 4000, 20],
      ],
      5,
    );
    await po(
      sBebidas,
      "recibida",
      [
        ["Cerveza Corona", 120, 2300],
        ["Refresco", 144, 1300],
      ],
      3,
    );
    await po(
      sBeto,
      "enviada",
      [
        ["Pulpo", 6000, 38],
        ["Ostión", 120, 700],
        ["Callo de hacha", 40, 2400],
      ],
      0,
    );
    await po(sPesca, "borrador", [["Pescado entero", 30, 14000]], 0);
    // mermas
    for (const [item, qty, why] of [
      ["Camarón", 800, "Se descongeló de más"],
      ["Filete de pescado", 500, "Pescado en mal estado"],
      ["Aguacate", 6, "Madurez excesiva"],
    ] as const) {
      await run(
        "INSERT INTO inventory_movements (id,item_id,kind,quantity,reason,user_id,created_at) VALUES (?,?,'merma',?,?,?,?)",
        newId(),
        inv[item],
        -qty,
        why,
        staff["Chef Ramón"]!.id,
        NOW - int(1, 6) * DAY,
      );
    }

    // ── Inventario por áreas y categorías, con límites, proveedor habitual y lista de compras ──
    {
      const areaId = async (name: string) =>
        (
          (await one<{ id: string }>("SELECT id FROM inventory_areas WHERE name=?", name)) ??
          (await (async () => {
            const id = newId();
            await run("INSERT INTO inventory_areas (id,name,sort) VALUES (?,?,?)", id, name, 9);
            return { id };
          })())
        ).id;
      const catIds = new Map<string, string>();
      const catId = async (area: string, name: string) => {
        const k = `${area}|${name}`;
        if (!catIds.has(k)) {
          const id = newId();
          await run(
            "INSERT INTO inventory_categories (id,area_id,name,sort) VALUES (?,?,?,?)",
            id,
            await areaId(area),
            name,
            catIds.size,
          );
          catIds.set(k, id);
        }
        return catIds.get(k)!;
      };
      const supplierId = async (name: string) =>
        (await one<{ id: string }>("SELECT id FROM suppliers WHERE name=?", name))?.id ?? null;
      const GROUPS: [string, string, string | null, string[]][] = [
        [
          "Cocina",
          "Mariscos y pescados",
          "Pescadería del Puerto",
          [
            "Camarón",
            "Filete de pescado",
            "Pescado entero",
            "Calamar",
            "Jaiba",
            "Atún (lomo)",
            "Marlín ahumado",
            "Camarón jumbo",
            "Langostino",
            "Huachinango entero",
            "Tilapia",
            "Sierra (filete)",
          ],
        ],
        [
          "Cocina",
          "Mariscos y pescados",
          "Mariscos Don Beto",
          ["Pulpo", "Ostión", "Callo de hacha", "Almeja", "Mejillón"],
        ],
        [
          "Cocina",
          "Perecederos",
          "Abarrotes La Estrella",
          [
            "Limón",
            "Aguacate",
            "Cebolla morada",
            "Pepino",
            "Jitomate",
            "Cebolla blanca",
            "Cilantro",
            "Chile serrano",
            "Chile jalapeño",
            "Ajo",
            "Lechuga",
            "Zanahoria",
            "Col morada",
            "Naranja",
            "Piña",
            "Mango",
            "Hierbabuena",
            "Plátano macho",
            "Papa",
          ],
        ],
        [
          "Cocina",
          "Lácteos y huevo",
          "Abarrotes La Estrella",
          [
            "Mantequilla",
            "Crema",
            "Queso Oaxaca",
            "Queso panela",
            "Huevo",
            "Leche entera",
            "Leche de coco",
            "Helado de vainilla (bote)",
          ],
        ],
        [
          "Cocina",
          "Secos y abarrotes",
          "Abarrotes La Estrella",
          [
            "Tostadas",
            "Tortilla de maíz",
            "Arroz",
            "Harina",
            "Pan molido",
            "Sal",
            "Pimienta",
            "Azúcar",
            "Aceite vegetal",
            "Coco rallado",
            "Chile de árbol",
            "Jamaica",
            "Horchata (base)",
          ],
        ],
        [
          "Cocina",
          "Enlatados y salsas",
          "Abarrotes La Estrella",
          ["Mayonesa", "Salsa Valentina", "Salsa Maggi", "Salsa inglesa", "Catsup"],
        ],
        [
          "Barra",
          "Cervezas",
          "Distribuidora de Bebidas del Golfo",
          [
            "Cerveza Corona",
            "Cerveza Victoria",
            "Cerveza Modelo",
            "Cerveza Pacífico",
            "Cerveza Modelo Negra",
          ],
        ],
        [
          "Barra",
          "Refrescos, aguas y jugos",
          "Distribuidora de Bebidas del Golfo",
          [
            "Refresco",
            "Sprite",
            "Agua mineral (botella)",
            "Agua embotellada (botella)",
            "Jugo de naranja",
            "Clamato",
          ],
        ],
        [
          "Barra",
          "Licores y vinos",
          "Distribuidora de Bebidas del Golfo",
          ["Tequila", "Ron", "Mezcal", "Vodka", "Whisky", "Triple sec", "Vino blanco"],
        ],
        ["Barra", "Hielo", null, ["Hielo"]],
        [
          "Limpieza y desechables",
          "Desechables",
          null,
          [
            "Servilletas (paquete)",
            "Bolsas para llevar",
            "Contenedores desechables",
            "Popotes",
            "Rollo térmico 80 mm",
            "Guantes (caja)",
          ],
        ],
        ["Limpieza y desechables", "Limpieza", null, ["Jabón para trastes", "Cloro"]],
        ["Limpieza y desechables", "Combustible", null, ["Gas LP (kg)", "Carbón (saco)"]],
      ];
      for (const [area, category, supplier, names] of GROUPS) {
        for (const n of names) {
          if (!inv[n]) continue;
          await run(
            "UPDATE inventory_items SET area_id=?, category_id=?, supplier_id=? WHERE id=?",
            await areaId(area),
            await catId(area, category),
            supplier ? await supplierId(supplier) : null,
            inv[n],
          );
        }
      }
      // máximo = triple del mínimo (hasta ahí se sugiere pedir); los insumos de piezas se redondean
      await run("UPDATE inventory_items SET max_stock = ROUND(min_stock * 3) WHERE min_stock > 0");
      // algunos más bajos para que «Por pedir» tenga qué mostrar
      for (const [n, qty] of [
        ["Aceite vegetal", 12000],
        ["Aguacate", 20],
        ["Jitomate", 2600],
        ["Cerveza Modelo Negra", 30],
        ["Servilletas (paquete)", 9],
      ] as const)
        await run("UPDATE inventory_items SET stock=? WHERE id=?", qty, inv[n]);
      bump("categorías de inventario", catIds.size);

      const lowRows = (await db
        .prepare(
          "SELECT id, name, unit, stock, min_stock, max_stock FROM inventory_items WHERE active=1 AND min_stock>0 AND stock<=min_stock ORDER BY name",
        )
        .all()) as {
        id: string;
        name: string;
        unit: string;
        stock: number;
        min_stock: number;
        max_stock: number | null;
      }[];
      const listId = newId();
      await run(
        "INSERT INTO shopping_lists (id,name,kind,status,created_by,created_at) VALUES (?,?,'auto','abierta',?,?)",
        listId,
        "Por pedir · hoy",
        staff["Sofía Ramírez"]!.id,
        NOW - 20 * MIN,
      );
      for (const [i, r] of lowRows.entries()) {
        const target = r.max_stock && r.max_stock > r.min_stock ? r.max_stock : r.min_stock * 2;
        let qty = Math.max(target - Math.max(r.stock, 0), r.min_stock - r.stock, 0);
        qty = r.unit === "pza" ? Math.ceil(qty) : Math.round(qty * 100) / 100;
        await run(
          "INSERT INTO shopping_list_items (id,list_id,item_id,name,unit,quantity,sort) VALUES (?,?,?,?,?,?,?)",
          newId(),
          listId,
          r.id,
          r.name,
          r.unit,
          qty || 1,
          i,
        );
      }
      const mkt = newId();
      await run(
        "INSERT INTO shopping_lists (id,name,kind,status,share_token,notes,created_by,created_at) VALUES (?,?,'manual','compartida',?,?,?,?)",
        mkt,
        "Mercado del sábado",
        "a1b2c3d4e5f60718293a4b5c",
        "Pagar en efectivo, pedir factura",
        staff["Sofía Ramírez"]!.id,
        NOW - 3 * HOUR,
      );
      for (const [i, [n, u, q, ck]] of (
        [
          ["Limones", "kg", 10, 1],
          ["Cilantro", "manojo", 12, 1],
          ["Cebolla morada", "kg", 6, 0],
          ["Hielo en bolsa", "pza", 20, 0],
          ["Servilletas de papel", "paq", 8, 0],
        ] as [string, string, number, number][]
      ).entries())
        await run(
          "INSERT INTO shopping_list_items (id,list_id,name,unit,quantity,checked,sort) VALUES (?,?,?,?,?,?,?)",
          newId(),
          mkt,
          n,
          u,
          q,
          ck,
          i,
        );
      const old = newId();
      await run(
        "INSERT INTO shopping_lists (id,name,kind,status,created_by,created_at,closed_at) VALUES (?,?,'auto','comprada',?,?,?)",
        old,
        "Pedido de la semana pasada",
        staff["Sofía Ramírez"]!.id,
        NOW - 6 * DAY,
        NOW - 5 * DAY,
      );
      for (const [i, n] of ["Camarón", "Filete de pescado", "Cerveza Corona"].entries()) {
        const it = (await one<{ id: string; unit: string }>(
          "SELECT id, unit FROM inventory_items WHERE name=?",
          n,
        ))!;
        await run(
          "INSERT INTO shopping_list_items (id,list_id,item_id,name,unit,quantity,checked,sort) VALUES (?,?,?,?,?,?,1,?)",
          newId(),
          old,
          it.id,
          n,
          it.unit,
          n === "Cerveza Corona" ? 120 : 8000,
          i,
        );
      }
      bump("listas de compras", 3);
    }

    // ── Recetario: comida, tragos, salsas y postres, con ingredientes ligados al inventario ──
    {
      const rcat = async (name: string) =>
        (await one<{ id: string }>("SELECT id FROM recipe_categories WHERE name=?", name))?.id ??
        (await (async () => {
          const id = newId();
          await run("INSERT INTO recipe_categories (id,name,sort) VALUES (?,?,?)", id, name, 9);
          return id;
        })());
      const prodId = (n: string) => products.find((p) => p.name === n)?.id ?? null;
      type R = {
        name: string;
        cat: string;
        desc: string;
        yield: number;
        unit: string;
        mins: number;
        product?: string;
        steps: string[];
        ing: [string | null, string, number, string, string?][];
      };
      const RECIPES: R[] = [
        {
          name: "Ceviche de pescado",
          cat: "Comida",
          desc: "Pescado curado en limón con cebolla morada y pepino.",
          yield: 1,
          unit: "porción",
          mins: 20,
          product: "Ceviche de pescado",
          steps: [
            "Cortar el pescado en cubos de 1 cm y mantenerlo frío",
            "Exprimir el limón y cubrir el pescado; reposar 10 minutos",
            "Agregar cebolla morada y pepino en cubos",
            "Sazonar con sal y servir con tostadas",
          ],
          ing: [
            ["Filete de pescado", "Filete de pescado", 120, "g"],
            ["Limón", "Limón", 4, "pza"],
            ["Cebolla morada", "Cebolla morada", 30, "g"],
            ["Pepino", "Pepino", 25, "g"],
            [null, "Sal", 2, "g"],
          ],
        },
        {
          name: "Aguachile verde",
          cat: "Comida",
          desc: "Camarón en salsa verde de chile serrano, limón y pepino.",
          yield: 1,
          unit: "porción",
          mins: 15,
          product: "Aguachile verde",
          steps: [
            "Mariposar el camarón y reposar 5 minutos con sal",
            "Licuar chile serrano, cilantro, limón y pepino",
            "Bañar el camarón con la salsa",
            "Servir con cebolla morada en pluma y aguacate",
          ],
          ing: [
            ["Camarón", "Camarón", 140, "g"],
            ["Limón", "Limón", 5, "pza"],
            ["Pepino", "Pepino", 40, "g"],
            ["Cebolla morada", "Cebolla morada", 20, "g"],
            ["Chile serrano", "Chile serrano", 10, "g"],
            ["Cilantro", "Cilantro", 5, "g"],
          ],
        },
        {
          name: "Camarones al mojo de ajo",
          cat: "Comida",
          desc: "Camarón salteado en mantequilla y ajo.",
          yield: 1,
          unit: "porción",
          mins: 12,
          product: "Camarones al mojo de ajo",
          steps: [
            "Calentar mantequilla con el ajo picado sin dorarlo",
            "Saltear el camarón 3 minutos por lado",
            "Terminar con limón y perejil",
            "Servir con arroz",
          ],
          ing: [
            ["Camarón", "Camarón", 200, "g"],
            ["Mantequilla", "Mantequilla", 30, "g"],
            ["Ajo", "Ajo", 15, "g"],
            ["Arroz", "Arroz", 120, "g"],
            ["Limón", "Limón", 1, "pza"],
          ],
        },
        {
          name: "Pulpo a las brasas",
          cat: "Comida",
          desc: "Pulpo cocido y sellado a las brasas.",
          yield: 4,
          unit: "porciones",
          mins: 75,
          product: "Pulpo a las brasas",
          steps: [
            "Cocer el pulpo con cebolla, ajo y sal 50 minutos",
            "Enfriar y cortar los tentáculos",
            "Sellar a las brasas con aceite",
            "Servir con papas y salsa",
          ],
          ing: [
            ["Pulpo", "Pulpo", 1000, "g"],
            ["Cebolla blanca", "Cebolla blanca", 150, "g"],
            ["Ajo", "Ajo", 20, "g"],
            ["Papa", "Papa", 480, "g"],
            ["Aceite vegetal", "Aceite vegetal", 60, "ml"],
          ],
        },
        {
          name: "Caldo de camarón",
          cat: "Comida",
          desc: "Caldo picoso de camarón con verduras.",
          yield: 1,
          unit: "porción",
          mins: 25,
          product: "Caldo de camarón",
          steps: [
            "Hacer un caldo con las cabezas de camarón",
            "Agregar jitomate, cebolla y chile",
            "Hervir el camarón 3 minutos",
            "Servir con limón y cilantro",
          ],
          ing: [
            ["Camarón", "Camarón", 140, "g"],
            ["Jitomate", "Jitomate", 60, "g"],
            ["Cebolla blanca", "Cebolla blanca", 30, "g"],
            ["Cilantro", "Cilantro", 5, "g"],
            ["Limón", "Limón", 2, "pza"],
          ],
        },
        {
          name: "Salsa macha",
          cat: "Salsas y preparaciones",
          desc: "Salsa de chile de árbol tostado en aceite.",
          yield: 20,
          unit: "cucharadas",
          mins: 30,
          steps: [
            "Tostar el chile de árbol y el ajo",
            "Calentar el aceite sin que humee",
            "Moler todo con sal y azúcar",
            "Reposar un día antes de usar",
          ],
          ing: [
            ["Chile de árbol", "Chile de árbol", 100, "g"],
            ["Aceite vegetal", "Aceite vegetal", 250, "ml", "caliente"],
            ["Ajo", "Ajo", 30, "g"],
            [null, "Cacahuate", 80, "g"],
            ["Azúcar", "Azúcar", 10, "g"],
          ],
        },
        {
          name: "Aderezo de chipotle",
          cat: "Salsas y preparaciones",
          desc: "Mayonesa ahumada para tostadas y tacos.",
          yield: 30,
          unit: "cucharadas",
          mins: 10,
          steps: [
            "Licuar el chipotle con un poco de adobo",
            "Mezclar con la mayonesa",
            "Ajustar sal y limón",
            "Refrigerar en recipiente tapado",
          ],
          ing: [
            ["Mayonesa", "Mayonesa", 400, "g"],
            [null, "Chiles chipotles en adobo", 4, "pza"],
            ["Limón", "Limón", 2, "pza"],
          ],
        },
        {
          name: "Michelada",
          cat: "Bebidas y tragos",
          desc: "Cerveza preparada con clamato y limón.",
          yield: 1,
          unit: "vaso",
          mins: 3,
          product: "Michelada",
          steps: [
            "Escarchar el vaso con sal y chile",
            "Agregar hielo, limón y salsas",
            "Rellenar con cerveza fría",
            "Servir con rodaja de limón",
          ],
          ing: [
            ["Cerveza Corona", "Cerveza Corona", 1, "pza"],
            ["Limón", "Limón", 1, "pza"],
            ["Clamato", "Clamato", 120, "ml"],
            ["Salsa Maggi", "Salsa Maggi", 5, "ml"],
            ["Hielo", "Hielo", 150, "g"],
          ],
        },
        {
          name: "Margarita",
          cat: "Bebidas y tragos",
          desc: "Clásica con borde de sal.",
          yield: 1,
          unit: "copa",
          mins: 4,
          product: "Margarita",
          steps: [
            "Escarchar la copa con sal",
            "Agitar tequila, triple sec y limón con hielo",
            "Colar sobre hielo fresco",
            "Decorar con rodaja de limón",
          ],
          ing: [
            ["Tequila", "Tequila", 60, "ml"],
            ["Triple sec", "Triple sec", 20, "ml"],
            ["Limón", "Limón", 2, "pza"],
            ["Hielo", "Hielo", 150, "g"],
          ],
        },
        {
          name: "Mojito",
          cat: "Bebidas y tragos",
          desc: "Ron, hierbabuena y limón.",
          yield: 1,
          unit: "vaso",
          mins: 4,
          product: "Mojito",
          steps: [
            "Machacar la hierbabuena con azúcar y limón",
            "Agregar hielo y ron",
            "Completar con agua mineral",
            "Mezclar suavemente y decorar",
          ],
          ing: [
            ["Ron", "Ron", 60, "ml"],
            ["Hierbabuena", "Hierbabuena", 8, "g"],
            ["Limón", "Limón", 2, "pza"],
            ["Azúcar", "Azúcar", 15, "g"],
            ["Hielo", "Hielo", 150, "g"],
          ],
        },
        {
          name: "Piña colada",
          cat: "Bebidas y tragos",
          desc: "Cremosa, con piña y coco.",
          yield: 1,
          unit: "vaso",
          mins: 5,
          product: "Piña colada",
          steps: [
            "Licuar ron, piña, leche de coco y hielo",
            "Servir en copa fría",
            "Decorar con piña",
          ],
          ing: [
            ["Ron", "Ron", 60, "ml"],
            ["Piña", "Piña", 0.2, "pza"],
            ["Leche de coco", "Leche de coco", 60, "ml"],
            ["Hielo", "Hielo", 120, "g"],
          ],
        },
        {
          name: "Flan napolitano",
          cat: "Postres",
          desc: "Flan de huevo y leche con caramelo.",
          yield: 8,
          unit: "porciones",
          mins: 80,
          product: "Flan napolitano",
          steps: [
            "Hacer caramelo y cubrir el molde",
            "Licuar huevos, leche y azúcar",
            "Hornear a baño maría 50 minutos",
            "Enfriar toda la noche y desmoldar",
          ],
          ing: [
            ["Huevo", "Huevo", 8, "pza"],
            ["Leche entera", "Leche entera", 1200, "ml"],
            ["Azúcar", "Azúcar", 250, "g"],
          ],
        },
      ];
      for (const r of RECIPES) {
        const rid = newId();
        await run(
          "INSERT INTO recipe_book (id,name,category_id,description,instructions,yield,yield_unit,prep_minutes,product_id,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
          rid,
          r.name,
          await rcat(r.cat),
          r.desc,
          r.steps.join("\n"),
          r.yield,
          r.unit,
          r.mins,
          r.product ? prodId(r.product) : null,
          staff["Chef Ramón"]!.id,
          NOW - 20 * DAY,
          NOW - 20 * DAY,
        );
        for (const [i, [item, name, qty, unit, note]] of r.ing.entries())
          await run(
            "INSERT INTO recipe_book_items (id,recipe_id,item_id,name,quantity,unit,note,sort) VALUES (?,?,?,?,?,?,?,?)",
            newId(),
            rid,
            item ? (inv[item] ?? null) : null,
            name,
            qty,
            unit,
            note ?? null,
            i,
          );
        bump("recetas");
      }
    }

    // ── Clientes ──
    const customers: string[] = [];
    for (const [n, ph, rfc] of [
      ["Ana López", "669 100 2001", "LOPA800101AB1"],
      ["Carlos Medina", "669 100 2002", null],
      ["Restaurante Casa Blanca (eventos)", "669 100 2003", "CBL100101XY9"],
      ["Fernanda Ruiz", "669 100 2004", null],
      ["Luis Ortega", "669 100 2005", null],
      ["Dra. Paola Núñez", "669 100 2006", "NUPP850505LM2"],
      ["Familia Gómez", "669 100 2007", null],
      ["Hugo Beltrán", "669 100 2008", null],
      ["Mónica Salas", "669 100 2009", null],
      ["Empresa Pesquera del Pacífico", "669 100 2010", "EPP990909QR5"],
    ] as const) {
      const id = newId();
      await run(
        "INSERT INTO customers (id,name,phone,rfc,uso_cfdi,created_at) VALUES (?,?,?,?,?,?)",
        id,
        n,
        ph,
        rfc,
        rfc ? "G03" : null,
        NOW - int(5, 80) * DAY,
      );
      customers.push(id);
      bump("clientes");
    }

    // ── Promociones ──
    const promo = (
      name: string,
      kind: string,
      value: number,
      productName: string | null,
      days: string | null,
      from: number | null,
      to: number | null,
    ) =>
      run(
        "INSERT INTO promotions (id,name,kind,value,product_id,days,start_minute,end_minute) VALUES (?,?,?,?,?,?,?,?)",
        newId(),
        name,
        kind,
        value,
        productName ? products.find((p) => p.name === productName)!.id : null,
        days,
        from,
        to,
      );
    await promo(
      "2x1 en cerveza Corona (lunes a viernes 5–7 pm)",
      "2x1",
      0,
      "Cerveza Corona",
      "1,2,3,4,5",
      17 * 60,
      19 * 60,
    );
    await promo(
      "Martes de camarón: 20 % de descuento",
      "porcentaje",
      20,
      "Camarones empanizados",
      "2",
      null,
      null,
    );
    await promo(
      "Aguachile verde a precio especial $149",
      "precio_especial",
      pesos(149),
      "Aguachile verde",
      "5,6",
      14 * 60,
      17 * 60,
    );
    bump("promociones", 3);

    // ── Catálogos de apoyo para la simulación ──
    const food = products.filter((p) => !["Bebidas"].includes(p.top) && p.top !== "Postres");
    const drinks = products.filter((p) => p.top === "Bebidas");
    const desserts = products.filter((p) => p.top === "Postres");
    const foodWeight = (p: Prod) =>
      (
        ({
          "Ceviches y aguachiles": 3.5,
          "Cocteles de mariscos": 2,
          "Tostadas y crudos": 1.5,
          Pescados: 2.6,
          Camarones: 3.6,
          "Pulpo y calamar": 1.8,
          Mariscadas: 0.9,
          "Tacos de pescado": 3.2,
          "Tacos de camarón y pulpo": 2.8,
          "Caldos y sopas": 1.5,
        }) as Record<string, number>
      )[p.sub] ?? 1;
    const drinkWeight = (p: Prod) =>
      (
        ({
          Cervezas: 5,
          "Refrescos y aguas": 3,
          "Preparados y cocteles": 2.6,
          "Aguas frescas": 2,
        }) as Record<string, number>
      )[p.sub] ?? 1;
    const modsByGroup: Record<string, string[]> = {};
    for (const [k, g] of Object.entries(MOD_GROUPS)) modsByGroup[k] = g.opts.map((o) => o[0]);
    const menuByName = new Map<string, P>();
    for (const t of MENU) for (const s of t.subs) for (const p of s.items) menuByName.set(p.n, p);

    // Favoritos por mesero (se cuentan al simular)
    const favs = new Map<string, number>();
    const fav = (user: string, product: string, qty: number) =>
      favs.set(`${user}|${product}`, (favs.get(`${user}|${product}`) ?? 0) + qty);

    // ── Generación de cuentas ──
    let folio = 0;
    let takeoutN = 0;
    let deliveryN = 0;
    let invoiceSeq = 0;
    void invoiceSeq;

    interface Line {
      p: Prod;
      qty: number;
      mods: string[];
      seat?: number;
      course?: string;
      hold?: boolean;
      cancelled?: boolean;
    }
    interface Spec {
      openedAt: number;
      waiter: string;
      table: string | null;
      guests: number;
      kind?: "mesa" | "llevar" | "delivery";
      customer?: string | null;
      orders: {
        at: number;
        lines: Line[];
        ticket?:
          | "entregado"
          | "listo"
          | "preparando"
          | "pendiente"
          | Record<string, "entregado" | "listo" | "preparando" | "pendiente">;
        source?: string;
      }[];
      status?: "abierta" | "pago_solicitado" | "cerrada";
      discountPct?: number;
      delivery?: {
        name: string;
        phone: string;
        address: string;
        fee: number;
        status: string;
        driver?: string;
      };
    }

    const buildMods = (p: Prod): string[] => {
      const def = menuByName.get(p.name);
      const out: string[] = [];
      for (const g of def?.g ?? []) {
        const opts = modsByGroup[g]!;
        if (g === "extras") {
          if (chance(0.25)) out.push(pick(opts));
        } else if (g === "picante") {
          if (chance(0.7)) out.push(pick(opts));
        } else out.push(pick(opts));
      }
      return out;
    };
    const modPrice = (mods: string[]) =>
      mods.reduce(
        (s, m) =>
          s +
          (Object.values(MOD_GROUPS)
            .flatMap((g) => g.opts)
            .find((o) => o[0] === m)?.[1] ?? 0),
        0,
      );

    /** Inserta una cuenta completa (comandas, productos, tickets de producción, descuento, cargo y, si está cerrada, pago). */
    const createAccount = async (
      spec: Spec,
      session: { id: string; cashUser: string } | null,
      tally?: { cashSales: number; cashTips: number },
    ) => {
      const accountId = newId();
      const kind = spec.kind ?? "mesa";
      const label =
        kind === "llevar" ? `L${++takeoutN}` : kind === "delivery" ? `D${++deliveryN}` : null;
      const waiterId = staff[spec.waiter]?.id ?? spec.waiter;
      const status = spec.status ?? "cerrada";
      await run(
        "INSERT INTO accounts (id,table_id,kind,label,customer_id,waiter_id,opened_by,guests,status,opened_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        accountId,
        spec.table ? tablesByNumber[spec.table] : null,
        kind,
        label,
        spec.customer ?? null,
        waiterId,
        waiterId,
        spec.guests,
        status === "cerrada" ? "abierta" : status,
        spec.openedAt,
      );

      let subtotal = 0;
      let lastAt = spec.openedAt;
      for (const [idx, o] of spec.orders.entries()) {
        const orderId = newId();
        lastAt = Math.max(lastAt, o.at);
        await run(
          "INSERT INTO orders (id,folio,account_id,is_addition,created_by,created_at,source) VALUES (?,?,?,?,?,?,?)",
          orderId,
          ++folio,
          accountId,
          idx > 0 ? 1 : 0,
          waiterId,
          o.at,
          o.source ?? "pos",
        );
        const byStation = new Map<string, string[]>();
        for (const l of o.lines) {
          const itemId = newId();
          const unit = l.p.price + modPrice(l.mods);
          if (!l.cancelled) subtotal += unit * l.qty;
          await run(
            "INSERT INTO order_items (id,order_id,account_id,product_id,name,quantity,unit_price_cents,modifiers,course,seat,held,status,cancel_reason,cancelled_by,cancelled_after_production) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            itemId,
            orderId,
            accountId,
            l.p.id,
            l.p.name,
            l.qty,
            unit,
            JSON.stringify(l.mods),
            l.course ?? null,
            l.seat ?? null,
            l.hold ? 1 : 0,
            l.cancelled ? "cancelado" : "activo",
            l.cancelled ? pick(["Cliente canceló", "Error de captura", "Error de cocina"]) : null,
            l.cancelled ? waiterId : null,
            l.cancelled && chance(0.4) ? 1 : 0,
          );
          fav(waiterId, l.p.id, l.qty);
          bump("renglones de comanda");
          if (l.hold) continue;
          for (const st of l.p.stations) byStation.set(st, [...(byStation.get(st) ?? []), itemId]);
        }
        for (const [stationId, itemIds] of byStation) {
          const stName = Object.entries(stationIds).find(([, v]) => v === stationId)![0];
          const state =
            typeof o.ticket === "string" ? o.ticket : (o.ticket?.[stName] ?? "entregado");
          const prep = (stName === "Barra" ? int(2, 6) : int(8, 24)) * MIN;
          const t0 = o.at;
          const ready = state === "listo" || state === "entregado" ? t0 + prep : null;
          const delivered = state === "entregado" && ready ? ready + int(1, 5) * MIN : null;
          const started = state !== "pendiente" ? t0 + 2 * MIN : null;
          const tid = newId();
          await run(
            "INSERT INTO production_tickets (id,order_id,station_id,status,created_at,received_at,started_at,ready_at,delivered_at) VALUES (?,?,?,?,?,?,?,?,?)",
            tid,
            orderId,
            stationId,
            state,
            t0,
            started,
            started,
            ready,
            delivered,
          );
          for (const it of itemIds)
            await run("INSERT INTO ticket_lines (ticket_id,item_id) VALUES (?,?)", tid, it);
          bump("tickets de producción");
        }
        await run(
          "UPDATE orders SET status=? WHERE id=?",
          typeof o.ticket === "string" && o.ticket !== "entregado"
            ? o.ticket === "listo"
              ? "preparada"
              : o.ticket === "preparando"
                ? "en_preparacion"
                : "enviada"
            : "entregada",
          orderId,
        );
      }

      if (spec.discountPct) {
        const amount = Math.round((subtotal * spec.discountPct) / 100);
        await run(
          "INSERT INTO account_discounts (id,account_id,kind,value,amount_cents,reason,user_id,authorized_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
          newId(),
          accountId,
          "porcentaje",
          spec.discountPct,
          amount,
          pick(["Cliente frecuente", "Cortesía de la casa", "Cumpleaños"]),
          waiterId,
          spec.discountPct > 10 ? staff["Sofía Ramírez"]!.id : null,
          lastAt + 20 * MIN,
        );
        subtotal -= amount;
      }
      const service = spec.guests >= 8 ? Math.round(subtotal * 0.1) : 0;
      let fee = 0;
      if (spec.delivery) {
        fee = spec.delivery.fee;
        await run(
          "INSERT INTO delivery_info (account_id,contact_name,phone,address,zone,fee_cents,driver,status,eta) VALUES (?,?,?,?,?,?,?,?,?)",
          accountId,
          spec.delivery.name,
          spec.delivery.phone,
          spec.delivery.address,
          "Centro",
          fee,
          spec.delivery.driver ?? null,
          spec.delivery.status,
          null,
        );
      } else if (kind === "llevar") {
        await run(
          "INSERT INTO delivery_info (account_id,contact_name,phone,status) VALUES (?,?,?,?)",
          accountId,
          pick(["Sra. Martínez", "Joel", "Tere", "Beto"]),
          "669 000 0000",
          status === "cerrada" ? "entregado" : "listo",
        );
      }
      const total = subtotal + service + fee;

      if (status === "cerrada" && session && total > 0) {
        const paidAt = lastAt + int(35, 75) * MIN;
        await run(
          "UPDATE accounts SET status='cerrada', closed_at=? WHERE id=?",
          paidAt,
          accountId,
        );
        const payId = newId();
        const tip = chance(0.72) ? Math.round((total * (int(8, 15) / 100)) / 500) * 500 : 0;
        const tipMethod = chance(0.55) ? "tarjeta" : "efectivo";
        const r = rand();
        const lines: { method: string; amount: number }[] = [];
        let change = 0;
        if (r < 0.4) {
          const given = Math.ceil(total / 5000) * 5000 + (chance(0.3) ? 5000 : 0);
          change = given - total;
          lines.push({ method: "efectivo", amount: total });
        } else if (r < 0.85) lines.push({ method: "tarjeta", amount: total });
        else if (r < 0.93) lines.push({ method: "transferencia", amount: total });
        else {
          const part = Math.round((total * 0.4) / 100) * 100;
          lines.push(
            { method: "efectivo", amount: part },
            { method: "tarjeta", amount: total - part },
          );
        }
        await run(
          "INSERT INTO payments (id,account_id,session_id,idempotency_key,user_id,total_cents,tip_cents,tip_method,change_cents,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
          payId,
          accountId,
          session.id,
          `demo-${payId}`,
          session.cashUser,
          total,
          tip,
          tip ? tipMethod : null,
          change,
          paidAt,
        );
        for (const l of lines) {
          await run(
            "INSERT INTO payment_lines (id,payment_id,method,amount_cents,reference) VALUES (?,?,?,?,?)",
            newId(),
            payId,
            l.method,
            l.amount,
            l.method === "tarjeta" ? `AUT${int(100000, 999999)}` : null,
          );
          if (l.method === "efectivo" && tally) tally.cashSales += l.amount;
        }
        if (tally && tip && tipMethod === "efectivo") tally.cashTips += tip;
        bump("cobros");
      } else if (status !== "cerrada") {
        // cuenta abierta: se reajusta el estado de la mesa más abajo
      }
      bump("cuentas");
      return { accountId, total, lastAt };
    };

    // Genera las comandas de una cuenta de mesa "realista"
    const randomSpec = (openedAt: number): Spec => {
      const guests = weighted(
        [1, 2, 3, 4, 5, 6, 8, 10],
        (g) =>
          (({ 1: 1, 2: 4, 3: 2, 4: 4, 5: 1.2, 6: 1.5, 8: 0.5, 10: 0.2 }) as Record<number, number>)[
            g
          ]!,
      );
      const waiter = weighted(
        ["Juan", "Pedro", "Lucía", "Marco"],
        (w) => (({ Juan: 3, Pedro: 2.6, Lucía: 2.2, Marco: 1.6 }) as Record<string, number>)[w]!,
      );
      const nFood = Math.max(1, Math.round(guests * (0.9 + rand() * 0.5)));
      const nDrinks = Math.max(1, Math.round(guests * (0.8 + rand() * 0.9)));
      const mk = (p: Prod, qty = 1): Line => ({
        p,
        qty,
        mods: buildMods(p),
        seat: guests > 1 ? int(1, Math.min(guests, 8)) : undefined,
        cancelled: chance(0.025),
      });
      const foodLines = Array.from({ length: nFood }, () =>
        mk(weighted(food, foodWeight), chance(0.2) ? 2 : 1),
      );
      const drinkLines = Array.from({ length: nDrinks }, () =>
        mk(weighted(drinks, drinkWeight), chance(0.3) ? int(2, 3) : 1),
      );
      const first: Line[] = [...drinkLines.slice(0, Math.ceil(nDrinks * 0.7)), ...foodLines];
      const second: Line[] = [
        ...drinkLines.slice(Math.ceil(nDrinks * 0.7)),
        ...(chance(0.35) ? [mk(pick(desserts))] : []),
      ];
      const orders: Spec["orders"] = [
        { at: openedAt + 2 * MIN, lines: first, source: chance(0.06) ? "qr" : "pos" },
      ];
      if (second.length > 0 && chance(0.55))
        orders.push({ at: openedAt + int(28, 45) * MIN, lines: second });
      else orders[0]!.lines.push(...second);
      const kind: Spec["kind"] = chance(0.07) ? "llevar" : chance(0.05) ? "delivery" : "mesa";
      const spec: Spec = {
        openedAt,
        waiter,
        table:
          kind === "mesa"
            ? pick(Object.keys(tablesByNumber).filter((t) => !t.startsWith("P") || guests > 5))
            : null,
        guests,
        kind,
        orders,
        customer: chance(0.12) ? pick(customers) : null,
        discountPct: chance(0.06) ? pick([10, 10, 15, 20]) : 0,
      };
      if (kind === "delivery")
        spec.delivery = {
          name: pick(["Rosa Beltrán", "Ismael", "Oficina Sur", "Dra. Núñez"]),
          phone: "669 200 3000",
          address: pick(["Av. del Mar 120", "Calle Pesca 45", "Blvd. Marina 800", "Los Pinos 12"]),
          fee: pick([3500, 4500, 5500]),
          status: "entregado",
          driver: pick(["Carlos", "Memo"]),
        };
      return spec;
    };
    const hourWeights = [
      [13, 1],
      [14, 3],
      [15, 3.2],
      [16, 1.6],
      [17, 1],
      [18, 1.5],
      [19, 3],
      [20, 4],
      [21, 3.2],
      [22, 1.4],
    ] as const;

    // ── Historial: de hace DAYS días hasta ayer ──
    const history = { accounts: 0, sales: 0 };
    const sessionIds: { id: string; day: number }[] = [];
    for (let d = DAYS; d >= 1; d--) {
      const start = dayStart(-d);
      const dow = new Date(start).getDay();
      const base = { 0: 52, 1: 26, 2: 24, 3: 28, 4: 34, 5: 46, 6: 60 }[dow]!;
      const n = Math.max(12, Math.round(base * (0.85 + rand() * 0.3)));
      const sessionId = newId();
      const opening = pesos(2000);
      await run(
        "INSERT INTO cash_sessions (id,user_id,name,opening_cents,opened_at,status) VALUES (?,?,?,?,?,'abierta')",
        sessionId,
        cajero,
        "Caja 1",
        opening,
        start + 12 * HOUR + 30 * MIN,
      );
      sessionIds.push({ id: sessionId, day: d });
      const tally = { cashSales: 0, cashTips: 0 };
      let daySales = 0;
      for (let i = 0; i < n; i++) {
        const hour = weighted(hourWeights, (h) => h[1])[0];
        const spec = randomSpec(start + hour * HOUR + int(0, 59) * MIN);
        const r = await createAccount(spec, { id: sessionId, cashUser: cajero }, tally);
        daySales += r.total;
        history.accounts++;
      }
      history.sales += daySales;
      // retiro y cierre de caja
      const withdrawal = pesos(pick([500, 800, 1000, 1500]));
      await run(
        "INSERT INTO cash_movements (id,session_id,kind,amount_cents,reason,user_id,authorized_by,created_at) VALUES (?,?,'retiro',?,?,?,?,?)",
        newId(),
        sessionId,
        withdrawal,
        pick([
          "Pago a proveedor de pescado",
          "Pago de hielo",
          "Compra de gas",
          "Pago a repartidor",
        ]),
        cajero,
        staff["Sofía Ramírez"]!.id,
        start + 17 * HOUR,
      );
      const expected = opening + tally.cashSales + tally.cashTips - withdrawal;
      const diff = chance(0.7) ? 0 : pick([-5000, -2000, -1000, 2000, 5000]);
      await run(
        "UPDATE cash_sessions SET status='cerrada', closed_at=?, expected_cents=?, counted_cents=?, difference_cents=?, difference_reason=? WHERE id=?",
        start + 23 * HOUR + 50 * MIN,
        expected,
        expected + diff,
        diff,
        diff ? pick(["Cambio mal dado", "Billete dañado", "Propina mal registrada"]) : null,
        sessionId,
      );
      // checador del día
      for (const [name, inH, outH] of [
        ["Juan", 12.5, 22.5],
        ["Pedro", 13, 23],
        ["Lucía", 17, 23.5],
        ["Marco", 13, 20],
        ["Caja", 12.5, 23.5],
        ["Chef Ramón", 11.5, 22.5],
        ["Barman Toño", 13, 23],
      ] as const) {
        if (dow === 1 && (name === "Lucía" || name === "Marco")) continue;
        await run(
          "INSERT INTO time_entries (id,user_id,clock_in,clock_out) VALUES (?,?,?,?)",
          newId(),
          staff[name]!.id,
          start + inH * HOUR + int(-10, 10) * MIN,
          start + outH * HOUR + int(-10, 25) * MIN,
        );
        bump("turnos checados");
      }
    }

    // ── Hoy: ventas ya cobradas, caja abierta y cuentas en servicio ──
    const sessionToday = newId();
    const openedToday = Math.min(NOW - 6 * HOUR, dayStart(0) + 12 * HOUR);
    await run(
      "INSERT INTO cash_sessions (id,user_id,name,opening_cents,opened_at,status) VALUES (?,?,?,?,?,'abierta')",
      sessionToday,
      cajero,
      "Caja 1",
      pesos(2000),
      Math.min(openedToday, NOW - 30 * MIN),
    );
    const winStart = Math.max(dayStart(0), NOW - 5 * HOUR);
    const winEnd = NOW - 70 * MIN;
    if (winEnd - winStart > 40 * MIN) {
      const cnt = Math.min(12, Math.floor((winEnd - winStart) / (25 * MIN)));
      for (let i = 0; i < cnt; i++) {
        const at = winStart + Math.floor((winEnd - winStart) * (i / cnt)) + int(0, 8) * MIN;
        const spec = randomSpec(at);
        spec.kind = "mesa";
        spec.table = pick(Object.keys(tablesByNumber).filter((t) => !t.startsWith("P")));
        spec.delivery = undefined;
        await createAccount(spec, { id: sessionToday, cashUser: cajero });
      }
    }
    const L = (name: string, qty = 1, extra: Partial<Line> = {}): Line => {
      const p = products.find((x) => x.name === name)!;
      return { p, qty, mods: [], ...extra };
    };
    const ago = (m: number) => NOW - m * MIN;
    const live: { spec: Spec; paid?: "partes" }[] = [
      // S3: ya comieron; piden postre y la cuenta está por pedirse
      {
        spec: {
          openedAt: ago(70),
          waiter: "Juan",
          table: "S3",
          guests: 4,
          orders: [
            {
              at: ago(66),
              lines: [
                L("Cerveza Corona", 3),
                L("Margarita"),
                L("Aguachile verde", 1, { mods: ["Normal"] }),
                L("Camarones al mojo de ajo", 1, { mods: ["Arroz"] }),
                L("Pulpo a las brasas", 1, { mods: ["Papas fritas"] }),
                L("Taco de pescado", 2),
              ],
              ticket: "entregado",
            },
            {
              at: ago(22),
              lines: [L("Cerveza Corona", 2), L("Flan napolitano", 2)],
              ticket: { Barra: "entregado", Cevichería: "listo" },
            },
          ],
        },
      },
      // S5: recién ordenó: cocina preparando, cevichería lista (el pase muestra "casi")
      {
        spec: {
          openedAt: ago(14),
          waiter: "Pedro",
          table: "S5",
          guests: 3,
          orders: [
            {
              at: ago(11),
              lines: [
                L("Michelada", 2),
                L("Ceviche mixto", 1, { mods: ["Poco picante"] }),
                L("Filete empapelado", 1, { mods: ["Ensalada"] }),
                L("Camarones a la diabla", 1, { mods: ["Extra picante", "Arroz"] }),
              ],
              ticket: { Barra: "entregado", Cevichería: "listo", Parrilla: "preparando" },
            },
          ],
        },
      },
      // T2: tiempo retenido ("Plato fuerte" no sale hasta mandarlo)
      {
        spec: {
          openedAt: ago(32),
          waiter: "Lucía",
          table: "T2",
          guests: 2,
          orders: [
            {
              at: ago(28),
              lines: [
                L("Coctel de camarón", 1, { course: "Entradas", mods: ["Normal"] }),
                L("Margarita", 2, { course: "Entradas" }),
                L("Pescado zarandeado", 1, {
                  course: "Plato fuerte",
                  hold: true,
                  mods: ["Papas fritas"],
                }),
                L("Pulpo a la diabla", 1, {
                  course: "Plato fuerte",
                  hold: true,
                  mods: ["Normal", "Arroz"],
                }),
              ],
              ticket: "entregado",
            },
          ],
        },
      },
      // T4: ya pidió la cuenta
      {
        spec: {
          openedAt: ago(95),
          waiter: "Marco",
          table: "T4",
          guests: 2,
          status: "pago_solicitado",
          orders: [
            {
              at: ago(90),
              lines: [
                L("Torre de cerveza (3 L)"),
                L("Mariscada para 2", 1, { mods: ["Normal", "Papas fritas"] }),
                L("Pay de limón"),
              ],
              ticket: "entregado",
            },
          ],
        },
      },
      // B2: barra, solo bebidas
      {
        spec: {
          openedAt: ago(40),
          waiter: "Juan",
          table: "B2",
          guests: 2,
          orders: [
            {
              at: ago(38),
              lines: [L("Cerveza Victoria", 2), L("Tostada de pescado", 2)],
              ticket: "entregado",
            },
            { at: ago(9), lines: [L("Cerveza Victoria", 2)], ticket: { Barra: "listo" } },
          ],
        },
      },
      // S8: todo listo para llevar a la mesa
      {
        spec: {
          openedAt: ago(26),
          waiter: "Pedro",
          table: "S8",
          guests: 4,
          orders: [
            {
              at: ago(20),
              lines: [
                L("Coca Cola", 2),
                L("Agua de jamaica", 2),
                L("Taco gobernador", 3, { mods: ["Normal"] }),
                L("Taco de camarón", 3, { mods: ["Poco picante"] }),
                L("Calamares fritos", 1, { mods: ["Sin picante"] }),
              ],
              ticket: "listo",
            },
          ],
        },
      },
      // P1: grupo grande con cargo por servicio y dos partes ya pagadas
      {
        paid: "partes",
        spec: {
          openedAt: ago(110),
          waiter: "Juan",
          table: "P1",
          guests: 10,
          orders: [
            {
              at: ago(105),
              lines: [
                L("Cerveza Corona", 8),
                L("Michelada", 3),
                L("Coca Cola", 3),
                L("Parrillada del mar", 1, { mods: ["Papas fritas"] }),
                L("Mariscada para 2", 2, { mods: ["Normal", "Arroz"] }),
                L("Ceviche de pescado", 3, { mods: ["Normal"] }),
                L("Tostada de camarón", 4),
              ],
              ticket: "entregado",
            },
          ],
        },
      },
      // T6: recién abierta, aún sin comandas
      { spec: { openedAt: ago(2), waiter: "Lucía", table: "T6", guests: 5, orders: [] } },
      // Para llevar y delivery en curso
      {
        spec: {
          openedAt: ago(12),
          waiter: "Marco",
          table: null,
          kind: "llevar",
          guests: 1,
          orders: [
            {
              at: ago(11),
              lines: [L("Taco de pescado", 6), L("Cerveza Corona", 2)],
              ticket: { Freidora: "listo", Barra: "listo" },
            },
          ],
        },
      },
      {
        spec: {
          openedAt: ago(35),
          waiter: "Marco",
          table: null,
          kind: "delivery",
          guests: 1,
          delivery: {
            name: "Rosa Beltrán",
            phone: "669 200 1111",
            address: "Av. del Mar 120, Col. Centro",
            fee: 4500,
            status: "en_camino",
            driver: "Carlos",
          },
          orders: [
            {
              at: ago(33),
              lines: [
                L("Caldo de camarón", 2, { mods: ["Normal"] }),
                L("Camarones empanizados", 1, { mods: ["Papas fritas"] }),
              ],
              ticket: "entregado",
            },
          ],
        },
      },
      {
        spec: {
          openedAt: ago(8),
          waiter: "Pedro",
          table: null,
          kind: "delivery",
          guests: 1,
          delivery: {
            name: "Oficina Sur",
            phone: "669 200 2222",
            address: "Blvd. Marina 800, Piso 3",
            fee: 5500,
            status: "preparando",
          },
          orders: [
            {
              at: ago(6),
              lines: [
                L("Ceviche mixto", 3, { mods: ["Normal"] }),
                L("Coca Cola", 3),
                L("Filete a la plancha", 2, { mods: ["Arroz"] }),
              ],
              ticket: { Cevichería: "listo", Parrilla: "preparando", Barra: "listo" },
            },
          ],
        },
      },
    ];
    const tableByAccount: { accountId: string; table: string | null; status: string }[] = [];
    for (const { spec, paid } of live) {
      const r = await createAccount({ ...spec, status: spec.status ?? "abierta" }, null);
      tableByAccount.push({
        accountId: r.accountId,
        table: spec.table,
        status: spec.status ?? "abierta",
      });
      if (paid === "partes") {
        // dos de diez partes ya pagadas (cobro en partes iguales)
        const cover = Math.round(r.total / 10);
        for (let i = 0; i < 2; i++) {
          const payId = newId();
          await run(
            "INSERT INTO payments (id,account_id,session_id,idempotency_key,user_id,total_cents,tip_cents,tip_method,change_cents,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            payId,
            r.accountId,
            sessionToday,
            `demo-${payId}`,
            cajero,
            cover,
            i === 0 ? 5000 : 0,
            i === 0 ? "efectivo" : null,
            0,
            ago(20 - i * 4),
          );
          await run(
            "INSERT INTO payment_lines (id,payment_id,method,amount_cents) VALUES (?,?,?,?)",
            newId(),
            payId,
            i === 0 ? "efectivo" : "tarjeta",
            cover,
          );
        }
      }
    }
    // estado de las mesas ocupadas
    for (const a of tableByAccount) {
      if (!a.table) continue;
      await run(
        "UPDATE tables_ SET status=?, version=version+1 WHERE id=?",
        a.status === "pago_solicitado" ? "esperando_pago" : "ocupada",
        tablesByNumber[a.table],
      );
    }
    await run("UPDATE tables_ SET status='fuera_de_servicio' WHERE number='T8'"); // mesa descompuesta
    await run("UPDATE tables_ SET status='reservada' WHERE number IN ('P2','S10')");

    // ── Reservaciones ──
    const resv = async (
      name: string,
      phone: string,
      size: number,
      inHours: number,
      table: string,
      status: string,
      notes?: string,
    ) => {
      await run(
        "INSERT INTO reservations (id,customer_id,name,phone,party_size,at,table_id,notes,status,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        newId(),
        null,
        name,
        phone,
        size,
        NOW + inHours * HOUR,
        tablesByNumber[table],
        notes ?? null,
        status,
        staff["Sofía Ramírez"]!.id,
        NOW - 20 * HOUR,
      );
      bump("reservaciones");
    };
    await resv(
      "Familia Gómez",
      "669 100 2007",
      8,
      1.5,
      "P2",
      "confirmada",
      "Cumpleaños, llevan pastel",
    );
    await resv("Carlos Medina", "669 100 2002", 4, 2, "S10", "pendiente");
    await resv(
      "Empresa Pesquera del Pacífico",
      "669 100 2010",
      10,
      26,
      "P1",
      "confirmada",
      "Comida de negocios, factura",
    );
    await resv("Mónica Salas", "669 100 2009", 2, 27, "T3", "pendiente");
    await resv("Hugo Beltrán", "669 100 2008", 6, 50, "S4", "confirmada");

    // ── Tarjetas de regalo ──
    for (const [code, amount, left, method] of [
      ["GC-FARO-2026", 100000, 100000, "tarjeta"],
      ["GC-MAR2-3K9X", 50000, 18000, "efectivo"],
      ["GC-PLAY-7H4T", 30000, 0, "transferencia"],
    ] as const) {
      const id = newId();
      await run(
        "INSERT INTO gift_cards (id,code,initial_cents,balance_cents,status,sold_method,sold_by,created_at) VALUES (?,?,?,?,?,?,?,?)",
        id,
        code,
        amount,
        left,
        left === 0 ? "agotada" : "activa",
        method,
        cajero,
        NOW - 6 * DAY,
      );
      await run(
        "INSERT INTO gift_card_movements (id,card_id,kind,amount_cents,user_id,created_at) VALUES (?,?,'venta',?,?,?)",
        newId(),
        id,
        amount,
        cajero,
        NOW - 6 * DAY,
      );
      if (left < amount)
        await run(
          "INSERT INTO gift_card_movements (id,card_id,kind,amount_cents,user_id,created_at) VALUES (?,?,'canje',?,?,?)",
          newId(),
          id,
          -(amount - left),
          cajero,
          NOW - 2 * DAY,
        );
      bump("tarjetas de regalo");
    }

    // ── Checador de hoy (algunos siguen en turno) ──
    for (const [name, hoursAgo] of [
      ["Juan", 5.5],
      ["Pedro", 5],
      ["Lucía", 4],
      ["Marco", 4.5],
      ["Caja", 6],
      ["Chef Ramón", 6.5],
      ["Barman Toño", 5.2],
      ["Sofía Ramírez", 6],
    ] as const) {
      await run(
        "INSERT INTO time_entries (id,user_id,clock_in) VALUES (?,?,?)",
        newId(),
        staff[name]!.id,
        NOW - hoursAgo * HOUR,
      );
      bump("turnos checados");
    }

    // ── Favoritos de cada mesero (más pedidos) y algunos fijados ──
    for (const [key, uses] of favs) {
      const [user, product] = key.split("|") as [string, string];
      if (meseros.includes(user))
        await run(
          "INSERT INTO user_favorites (user_id,product_id,uses,pinned) VALUES (?,?,?,0) ON CONFLICT(user_id,product_id) DO UPDATE SET uses=user_favorites.uses+excluded.uses",
          user,
          product,
          uses,
        );
    }
    for (const n of ["Cerveza Corona", "Aguachile verde", "Taco de camarón"]) {
      await run(
        "UPDATE user_favorites SET pinned=1 WHERE user_id=? AND product_id=?",
        staff["Juan"]!.id,
        products.find((p) => p.name === n)!.id,
      );
    }

    // ── Bitácora de arranque ──
    for (const [action, entity, detail] of [
      ["seed_demo", "sistema", { negocio: "Mariscos El Faro" }],
      ["abrir_caja", "cash_session", { opening_cents: pesos(2000) }],
    ] as const) {
      await run(
        "INSERT INTO audit_log (ts,user_id,action,entity,detail) VALUES (?,?,?,?,?)",
        NOW - 6 * HOUR,
        cajero,
        action,
        entity,
        JSON.stringify(detail),
      );
    }
    for (const a of tableByAccount)
      await run(
        "INSERT INTO audit_log (ts,user_id,action,entity,entity_id,detail) VALUES (?,?,?,?,?,?)",
        NOW - 20 * MIN,
        meseros[0]!,
        "abrir_mesa",
        "account",
        a.accountId,
        JSON.stringify({ mesa: a.table }),
      );

    summary = {
      establishment: "Mariscos El Faro",
      users,
      counts,
      salesLast14Days: { accounts: history.accounts, salesCents: history.sales },
    };
  })();

  return summary!;
}
