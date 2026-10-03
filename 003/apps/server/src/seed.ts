import { audit, newId, type Db } from "./db";
import { hashSecret } from "./crypto";

/** Datos de ejemplo del modelo operativo de la idea 001. Idempotente: no hace nada si ya hay usuarios. */
export async function seed(db: Db, adminPassword = "admin1234"): Promise<void> {
  if (((await db.prepare("SELECT COUNT(*) c FROM users").get()) as { c: number }).c > 0) return;

  await db.transaction(async () => {
    const user = (
      name: string,
      role: string,
      o: { username?: string; password?: string; pin?: string },
    ) =>
      db
        .prepare(
          "INSERT INTO users (id,name,username,role,pin_hash,password_hash,created_at) VALUES (?,?,?,?,?,?,?)",
        )
        .run(
          newId(),
          name,
          o.username ?? null,
          role,
          o.pin ? hashSecret(o.pin) : null,
          o.password ? hashSecret(o.password) : null,
          Date.now(),
        );
    await user("Administrador", "admin", { username: "admin", password: adminPassword });
    await user("Juan", "mesero", { pin: "1111" });
    await user("Pedro", "mesero", { pin: "2222" });
    await user("Caja", "cajero", { pin: "3333" });

    const printer = async (name: string, kind: string, host: string) => {
      const id = newId();
      await db
        .prepare("INSERT INTO printers (id,name,kind,host) VALUES (?,?,?,?)")
        .run(id, name, kind, host);
      return id;
    };
    const pCocina = await printer("Cocina Calientes", "cocina", "192.168.1.50");
    const pFrios = await printer("Cocina Fríos", "cocina", "192.168.1.51");
    const pBar = await printer("Bar", "bar", "192.168.1.52");
    await printer("Caja", "caja", "192.168.1.53");

    const area = async (name: string, kind: string) => {
      const id = newId();
      await db.prepare("INSERT INTO areas (id,name,kind) VALUES (?,?,?)").run(id, name, kind);
      return id;
    };
    const sub = async (areaId: string, name: string) => {
      const id = newId();
      await db
        .prepare("INSERT INTO subareas (id,area_id,name) VALUES (?,?,?)")
        .run(id, areaId, name);
      return id;
    };
    const station = async (subId: string, name: string, printerId: string) => {
      const id = newId();
      await db
        .prepare("INSERT INTO stations (id,subarea_id,name,primary_printer_id) VALUES (?,?,?,?)")
        .run(id, subId, name, printerId);
      return id;
    };
    const cocina = await area("Cocina", "produccion");
    const barArea = await area("Bar", "produccion");
    const stCal = await station(await sub(cocina, "Calientes"), "Plancha", pCocina);
    const stFri = await station(await sub(cocina, "Fríos"), "Fríos", pFrios);
    const stBar = await station(await sub(barArea, "Coctelería"), "Barra", pBar);

    const zone = newId();
    await db.prepare("INSERT INTO zones (id,name) VALUES (?,?)").run(zone, "Salón");
    for (let n = 1; n <= 8; n++) {
      await db
        .prepare("INSERT INTO tables_ (id,zone_id,number,pos_x,pos_y) VALUES (?,?,?,?,?)")
        .run(newId(), zone, String(n), ((n - 1) % 4) * 140, Math.floor((n - 1) / 4) * 140);
    }

    const cat = async (name: string) => {
      const id = newId();
      await db.prepare("INSERT INTO categories (id,name) VALUES (?,?)").run(id, name);
      return id;
    };
    const alimentos = await cat("Alimentos");
    const bebidas = await cat("Bebidas");
    const product = async (category: string, name: string, price: number, st: string) => {
      const id = newId();
      await db
        .prepare("INSERT INTO products (id,category_id,name,price_cents) VALUES (?,?,?,?)")
        .run(id, category, name, price);
      await db
        .prepare("INSERT INTO product_routes (product_id,station_id) VALUES (?,?)")
        .run(id, st);
      return id;
    };
    await product(alimentos, "Hamburguesa clásica", 14900, stCal);
    await product(alimentos, "Ensalada", 9900, stFri);
    await product(bebidas, "Margarita", 8900, stBar);

    await audit(db, null, "seed", "sistema");
  })();
}
