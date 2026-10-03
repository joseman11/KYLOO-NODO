/** Migraciones SQL ordenadas. Cada una se aplica una sola vez (tabla schema_migrations). */
export const MIGRATIONS: { id: number; name: string; sql: string; rebuild?: boolean }[] = [
  {
    id: 1,
    name: "init",
    sql: `
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT UNIQUE,
  role TEXT NOT NULL,
  pin_hash TEXT,
  password_hash TEXT,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE areas (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('servicio','produccion','despacho'))
);
CREATE TABLE subareas (
  id TEXT PRIMARY KEY,
  area_id TEXT NOT NULL REFERENCES areas(id),
  name TEXT NOT NULL
);

CREATE TABLE printers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('cocina','bar','caja','recepcion','admin')),
  host TEXT,
  port INTEGER NOT NULL DEFAULT 9100,
  paper_width INTEGER NOT NULL DEFAULT 80 CHECK (paper_width IN (58,80)),
  copies INTEGER NOT NULL DEFAULT 1,
  auto_cut INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE stations (
  id TEXT PRIMARY KEY,
  subarea_id TEXT NOT NULL REFERENCES subareas(id),
  name TEXT NOT NULL,
  primary_printer_id TEXT REFERENCES printers(id),
  secondary_printer_id TEXT REFERENCES printers(id),
  has_kds INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE zones (id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE tables_ (
  id TEXT PRIMARY KEY,
  zone_id TEXT REFERENCES zones(id),
  number TEXT NOT NULL UNIQUE,
  capacity INTEGER NOT NULL DEFAULT 4,
  status TEXT NOT NULL DEFAULT 'disponible'
    CHECK (status IN ('disponible','ocupada','reservada','esperando_pago','pagada','bloqueada','fuera_de_servicio')),
  vip INTEGER NOT NULL DEFAULT 0,
  pos_x REAL NOT NULL DEFAULT 0,
  pos_y REAL NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE categories (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES categories(id),
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  category_id TEXT REFERENCES categories(id),
  name TEXT NOT NULL,
  sku TEXT UNIQUE,
  description TEXT,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  tax_rate REAL NOT NULL DEFAULT 0.16,
  prep_minutes INTEGER,
  availability TEXT NOT NULL DEFAULT 'disponible' CHECK (availability IN ('disponible','agotado','temporal')),
  active INTEGER NOT NULL DEFAULT 1
);
-- Ruta de producción: un producto puede ir a una o varias estaciones (RN-003, RN-004)
CREATE TABLE product_routes (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  station_id TEXT NOT NULL REFERENCES stations(id),
  PRIMARY KEY (product_id, station_id)
);

CREATE TABLE modifier_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  required INTEGER NOT NULL DEFAULT 0,
  multiple INTEGER NOT NULL DEFAULT 0,
  max_select INTEGER
);
CREATE TABLE modifiers (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE product_modifier_groups (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
  PRIMARY KEY (product_id, group_id)
);

-- Bitácora append-only (sec. 54)
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  user_id TEXT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  detail TEXT
);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT,'audit_log es append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT,'audit_log es append-only'); END;
`,
  },
  {
    id: 2,
    name: "operacion",
    sql: `
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  table_id TEXT NOT NULL REFERENCES tables_(id),
  waiter_id TEXT NOT NULL REFERENCES users(id),
  opened_by TEXT NOT NULL REFERENCES users(id),
  guests INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'abierta' CHECK (status IN ('abierta','pago_solicitado','cerrada')),
  opened_at INTEGER NOT NULL,
  closed_at INTEGER
);
CREATE INDEX idx_accounts_table ON accounts(table_id, status);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  folio INTEGER NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  is_addition INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'enviada',
  created_by TEXT NOT NULL REFERENCES users(id),
  client_id TEXT UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_cents INTEGER NOT NULL,
  modifiers TEXT NOT NULL DEFAULT '[]',
  note TEXT,
  status TEXT NOT NULL DEFAULT 'activo' CHECK (status IN ('activo','cancelado')),
  cancel_reason TEXT,
  cancelled_by TEXT,
  authorized_by TEXT,
  cancelled_after_production INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_items_account ON order_items(account_id);

CREATE TABLE production_tickets (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  station_id TEXT NOT NULL REFERENCES stations(id),
  status TEXT NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente','recibido','preparando','listo','entregado','cancelado')),
  created_at INTEGER NOT NULL,
  received_at INTEGER,
  started_at INTEGER,
  ready_at INTEGER,
  delivered_at INTEGER
);
CREATE TABLE ticket_lines (
  ticket_id TEXT NOT NULL REFERENCES production_tickets(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES order_items(id),
  PRIMARY KEY (ticket_id, item_id)
);

CREATE TABLE print_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  ticket_id TEXT REFERENCES production_tickets(id),
  printer_id TEXT NOT NULL REFERENCES printers(id),
  fallback_printer_id TEXT REFERENCES printers(id),
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente','impreso','error')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  printed_at INTEGER
);
CREATE INDEX idx_print_pending ON print_jobs(status, next_attempt_at);

CREATE TABLE cash_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL DEFAULT 'Caja 1',
  opening_cents INTEGER NOT NULL,
  opened_at INTEGER NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'abierta' CHECK (status IN ('abierta','cerrada')),
  closed_at INTEGER,
  expected_cents INTEGER,
  counted_cents INTEGER,
  difference_cents INTEGER,
  difference_reason TEXT
);
CREATE TABLE cash_movements (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES cash_sessions(id),
  kind TEXT NOT NULL CHECK (kind IN ('retiro','ingreso')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  reason TEXT NOT NULL,
  user_id TEXT NOT NULL,
  authorized_by TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  session_id TEXT NOT NULL REFERENCES cash_sessions(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  tip_cents INTEGER NOT NULL DEFAULT 0,
  tip_method TEXT,
  change_cents INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE payment_lines (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL REFERENCES payments(id),
  method TEXT NOT NULL CHECK (method IN ('efectivo','tarjeta','transferencia','qr','credito','otro')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  reference TEXT
);
`,
  },
  {
    id: 3,
    name: "fase2",
    rebuild: true,
    sql: `
CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  rfc TEXT,
  address TEXT,
  uso_cfdi TEXT,
  notes TEXT,
  created_at INTEGER NOT NULL
);

-- accounts: table_id opcional (para llevar / delivery) + tipo, folio visible y cliente
CREATE TABLE accounts_new (
  id TEXT PRIMARY KEY,
  table_id TEXT REFERENCES tables_(id),
  kind TEXT NOT NULL DEFAULT 'mesa' CHECK (kind IN ('mesa','llevar','delivery')),
  label TEXT,
  customer_id TEXT REFERENCES customers(id),
  waiter_id TEXT NOT NULL REFERENCES users(id),
  opened_by TEXT NOT NULL REFERENCES users(id),
  guests INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'abierta' CHECK (status IN ('abierta','pago_solicitado','cerrada')),
  opened_at INTEGER NOT NULL,
  closed_at INTEGER
);
INSERT INTO accounts_new (id, table_id, waiter_id, opened_by, guests, status, opened_at, closed_at)
  SELECT id, table_id, waiter_id, opened_by, guests, status, opened_at, closed_at FROM accounts;
DROP TABLE accounts;
ALTER TABLE accounts_new RENAME TO accounts;
CREATE INDEX idx_accounts_table ON accounts(table_id, status);

ALTER TABLE orders ADD COLUMN source TEXT NOT NULL DEFAULT 'pos';

CREATE TABLE delivery_info (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  contact_name TEXT NOT NULL,
  phone TEXT,
  address TEXT,
  zone TEXT,
  fee_cents INTEGER NOT NULL DEFAULT 0,
  driver TEXT,
  status TEXT NOT NULL DEFAULT 'recibido' CHECK (status IN ('recibido','preparando','listo','en_camino','entregado','cancelado')),
  eta INTEGER,
  notes TEXT
);

CREATE TABLE reservations (
  id TEXT PRIMARY KEY,
  customer_id TEXT REFERENCES customers(id),
  name TEXT NOT NULL,
  phone TEXT,
  party_size INTEGER NOT NULL CHECK (party_size > 0),
  at INTEGER NOT NULL,
  table_id TEXT REFERENCES tables_(id),
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente','confirmada','llego','cancelada','no_se_presento')),
  created_by TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE promotions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('porcentaje','monto','2x1','precio_especial')),
  value INTEGER NOT NULL DEFAULT 0,
  product_id TEXT REFERENCES products(id),
  category_id TEXT REFERENCES categories(id),
  days TEXT,
  start_minute INTEGER,
  end_minute INTEGER,
  valid_from INTEGER,
  valid_to INTEGER,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE account_discounts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  kind TEXT NOT NULL,
  value INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  reason TEXT,
  promotion_id TEXT REFERENCES promotions(id),
  user_id TEXT NOT NULL,
  authorized_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_discount_promo ON account_discounts(account_id, promotion_id) WHERE promotion_id IS NOT NULL;

CREATE TABLE inventory_items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  unit TEXT NOT NULL,
  stock REAL NOT NULL DEFAULT 0,
  min_stock REAL NOT NULL DEFAULT 0,
  max_stock REAL,
  unit_cost_cents REAL NOT NULL DEFAULT 0,
  last_in INTEGER,
  last_out INTEGER,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE inventory_movements (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES inventory_items(id),
  kind TEXT NOT NULL CHECK (kind IN ('entrada','salida','ajuste','merma','venta','compra')),
  quantity REAL NOT NULL,
  unit_cost_cents REAL,
  reason TEXT,
  user_id TEXT,
  ref TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_inv_mov_ref ON inventory_movements(ref);
CREATE TABLE recipe_lines (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES inventory_items(id),
  quantity REAL NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (product_id, item_id)
);

CREATE TABLE suppliers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  rfc TEXT,
  contact TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE purchase_orders (
  id TEXT PRIMARY KEY,
  supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  status TEXT NOT NULL DEFAULT 'borrador' CHECK (status IN ('borrador','enviada','recibida','cancelada')),
  invoice_ref TEXT,
  notes TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  received_at INTEGER
);
CREATE TABLE purchase_lines (
  id TEXT PRIMARY KEY,
  po_id TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES inventory_items(id),
  quantity REAL NOT NULL CHECK (quantity > 0),
  unit_cost_cents REAL NOT NULL CHECK (unit_cost_cents >= 0)
);
`,
  },
  {
    id: 4,
    name: "fase3",
    sql: `
-- Integraciones: pedidos externos por API y webhooks salientes
CREATE TABLE integrations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('web','whatsapp','delivery_app','otro')),
  key_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
ALTER TABLE accounts ADD COLUMN integration_id TEXT REFERENCES integrations(id);
ALTER TABLE accounts ADD COLUMN external_ref TEXT;
CREATE UNIQUE INDEX idx_accounts_external ON accounts(integration_id, external_ref) WHERE external_ref IS NOT NULL;

CREATE TABLE webhook_endpoints (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT '*',
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente','enviado','error')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_webhook_pending ON webhook_deliveries(status, next_attempt_at);

-- Sincronización por lotes (operación idempotente por id)
CREATE TABLE sync_ops (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  created_at INTEGER NOT NULL
);
ALTER TABLE accounts ADD COLUMN client_id TEXT;
CREATE UNIQUE INDEX idx_accounts_client ON accounts(client_id) WHERE client_id IS NOT NULL;

-- Facturación electrónica
CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  customer_id TEXT REFERENCES customers(id),
  rfc TEXT NOT NULL,
  razon_social TEXT NOT NULL,
  regimen_fiscal TEXT NOT NULL,
  cp TEXT NOT NULL,
  uso_cfdi TEXT NOT NULL,
  forma_pago TEXT NOT NULL,
  metodo_pago TEXT NOT NULL DEFAULT 'PUE',
  subtotal_cents INTEGER NOT NULL,
  iva_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'emitida' CHECK (status IN ('emitida','cancelada')),
  provider TEXT NOT NULL,
  uuid TEXT,
  serie TEXT,
  folio INTEGER NOT NULL,
  xml TEXT NOT NULL,
  email TEXT,
  issued_at INTEGER NOT NULL,
  cancelled_at INTEGER,
  cancel_reason TEXT,
  created_by TEXT
);
CREATE UNIQUE INDEX idx_invoice_account ON invoices(account_id) WHERE status='emitida';

-- Modo HQ (nube): organizaciones, sucursales y datos consolidados
CREATE TABLE hq_orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'gratis',
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE hq_users (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES hq_orgs(id),
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','viewer'))
);
CREATE TABLE hq_branches (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES hq_orgs(id),
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  last_seen INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE hq_sales (
  branch_id TEXT NOT NULL REFERENCES hq_branches(id),
  day TEXT NOT NULL,
  tickets INTEGER NOT NULL,
  sales_cents INTEGER NOT NULL,
  tips_cents INTEGER NOT NULL DEFAULT 0,
  discounts_cents INTEGER NOT NULL DEFAULT 0,
  cancelled_items INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (branch_id, day)
);
CREATE TABLE hq_product_sales (
  branch_id TEXT NOT NULL REFERENCES hq_branches(id),
  day TEXT NOT NULL,
  product TEXT NOT NULL,
  units INTEGER NOT NULL,
  sales_cents INTEGER NOT NULL,
  PRIMARY KEY (branch_id, day, product)
);
CREATE TABLE hq_catalog (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES hq_orgs(id),
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  category TEXT,
  station_names TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (org_id, sku)
);
`,
  },
  {
    id: 5,
    name: "categorias_areas_tickets",
    sql: `
-- Destino por defecto de cada categoría: los productos nuevos la heredan
CREATE TABLE category_routes (
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  station_id TEXT NOT NULL REFERENCES stations(id),
  PRIMARY KEY (category_id, station_id)
);
-- Tiempo / separador de la comanda al que pertenece cada producto (Entradas, Plato fuerte, Postre…)
ALTER TABLE order_items ADD COLUMN course TEXT;
`,
  },
  {
    id: 6,
    name: "areas_de_servicio",
    sql: `
-- Áreas de servicio (Salón, Terraza, Barra…): el prefijo da nombre a sus mesas (T1, T2…)
ALTER TABLE zones ADD COLUMN prefix TEXT NOT NULL DEFAULT '';
ALTER TABLE zones ADD COLUMN sort INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    id: 7,
    name: "comandero_avanzado",
    rebuild: true,
    sql: `
-- Fotos de los platillos (archivo en la carpeta de fotos del servidor)
ALTER TABLE products ADD COLUMN photo TEXT;

-- Asiento de cada producto y tiempos retenidos (hold & fire)
ALTER TABLE order_items ADD COLUMN seat INTEGER;
ALTER TABLE order_items ADD COLUMN held INTEGER NOT NULL DEFAULT 0;

-- Cargo por servicio: una cuenta puede quedar exenta
ALTER TABLE accounts ADD COLUMN service_waived INTEGER NOT NULL DEFAULT 0;

-- Un pago puede cubrir solo una parte de la cuenta (partes iguales o un asiento)
ALTER TABLE payments ADD COLUMN seat INTEGER;

-- Favoritos por mesero (los más pedidos se fijan solos; también se pueden fijar a mano)
CREATE TABLE user_favorites (
  user_id TEXT NOT NULL REFERENCES users(id),
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  uses INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, product_id)
);

-- Checador de personal
CREATE TABLE time_entries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  clock_in INTEGER NOT NULL,
  clock_out INTEGER,
  note TEXT
);
CREATE INDEX idx_time_open ON time_entries(user_id, clock_out);

-- Tarjetas de regalo
CREATE TABLE gift_cards (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  initial_cents INTEGER NOT NULL CHECK (initial_cents > 0),
  balance_cents INTEGER NOT NULL CHECK (balance_cents >= 0),
  status TEXT NOT NULL DEFAULT 'activa' CHECK (status IN ('activa','agotada','cancelada')),
  sold_method TEXT,
  sold_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE gift_card_movements (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES gift_cards(id),
  kind TEXT NOT NULL CHECK (kind IN ('venta','canje','cancelacion')),
  amount_cents INTEGER NOT NULL,
  ref TEXT,
  user_id TEXT,
  created_at INTEGER NOT NULL
);

-- payment_lines acepta el método "regalo" (se reconstruye porque SQLite no altera un CHECK)
CREATE TABLE payment_lines_new (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL REFERENCES payments(id),
  method TEXT NOT NULL CHECK (method IN ('efectivo','tarjeta','transferencia','qr','credito','regalo','otro')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  reference TEXT
);
INSERT INTO payment_lines_new (id, payment_id, method, amount_cents, reference) SELECT id, payment_id, method, amount_cents, reference FROM payment_lines;
DROP TABLE payment_lines;
ALTER TABLE payment_lines_new RENAME TO payment_lines;
`,
  },
  {
    id: 8,
    name: "mesas_unidas",
    sql: `
-- Una mesa unida comparte la cuenta de otra mesa (grupos grandes que juntan mesas)
CREATE TABLE table_links (
  table_id TEXT PRIMARY KEY REFERENCES tables_(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at INTEGER NOT NULL
);
`,
  },
  {
    id: 9,
    name: "foto_personal",
    sql: `
ALTER TABLE users ADD COLUMN photo TEXT;
`,
  },
  {
    id: 10,
    name: "inventario_areas_listas_recetario",
    sql: `
-- Inventario separado en áreas (Cocina, Barra…) y categorías que crea el usuario (Perecederos, Mariscos, Enlatados…)
CREATE TABLE inventory_areas (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE inventory_categories (
  id TEXT PRIMARY KEY,
  area_id TEXT NOT NULL REFERENCES inventory_areas(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  UNIQUE (area_id, name)
);
ALTER TABLE inventory_items ADD COLUMN area_id TEXT REFERENCES inventory_areas(id);
ALTER TABLE inventory_items ADD COLUMN category_id TEXT REFERENCES inventory_categories(id);
ALTER TABLE inventory_items ADD COLUMN supplier_id TEXT REFERENCES suppliers(id);
CREATE INDEX idx_inv_items_area ON inventory_items(area_id, category_id);

-- Listas de compras (armadas con lo que llegó al mínimo o a mano) que se pueden compartir por enlace
CREATE TABLE shopping_lists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'manual' CHECK (kind IN ('auto','manual')),
  status TEXT NOT NULL DEFAULT 'abierta' CHECK (status IN ('abierta','compartida','comprada','archivada')),
  share_token TEXT UNIQUE,
  notes TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  closed_at INTEGER
);
CREATE TABLE shopping_list_items (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL REFERENCES shopping_lists(id) ON DELETE CASCADE,
  item_id TEXT REFERENCES inventory_items(id),
  name TEXT NOT NULL,
  unit TEXT,
  quantity REAL NOT NULL CHECK (quantity > 0),
  checked INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_sli_list ON shopping_list_items(list_id);

-- Recetario: recetas con sus categorías (comida, tragos, salsas…), ingredientes y preparación
CREATE TABLE recipe_categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE recipe_book (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category_id TEXT REFERENCES recipe_categories(id) ON DELETE SET NULL,
  description TEXT,
  instructions TEXT,
  yield REAL NOT NULL DEFAULT 1 CHECK (yield > 0),
  yield_unit TEXT NOT NULL DEFAULT 'porciones',
  prep_minutes INTEGER,
  photo TEXT,
  product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_recipe_book_cat ON recipe_book(category_id);
CREATE TABLE recipe_book_items (
  id TEXT PRIMARY KEY,
  recipe_id TEXT NOT NULL REFERENCES recipe_book(id) ON DELETE CASCADE,
  item_id TEXT REFERENCES inventory_items(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  quantity REAL NOT NULL CHECK (quantity > 0),
  unit TEXT,
  note TEXT,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_recipe_items_recipe ON recipe_book_items(recipe_id);

-- Punto de partida editable: el usuario puede renombrar, borrar o agregar las suyas
INSERT INTO inventory_areas (id, name, sort) VALUES
  (lower(hex(randomblob(12))), 'Cocina', 0),
  (lower(hex(randomblob(12))), 'Barra', 1),
  (lower(hex(randomblob(12))), 'Limpieza y desechables', 2);
INSERT INTO recipe_categories (id, name, sort) VALUES
  (lower(hex(randomblob(12))), 'Comida', 0),
  (lower(hex(randomblob(12))), 'Bebidas y tragos', 1),
  (lower(hex(randomblob(12))), 'Salsas y preparaciones', 2),
  (lower(hex(randomblob(12))), 'Postres', 3);
`,
  },
  {
    id: 11,
    name: "licencias_activacion",
    sql: `
-- Licencias atadas al equipo: la sucursal se activa con un código de un solo uso y queda ligada a la huella de su equipo
ALTER TABLE hq_branches ADD COLUMN fingerprint TEXT;
ALTER TABLE hq_branches ADD COLUMN activated_at INTEGER;
CREATE TABLE hq_activation_codes (
  id TEXT PRIMARY KEY,
  branch_id TEXT NOT NULL REFERENCES hq_branches(id),
  code_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_hq_codes_branch ON hq_activation_codes(branch_id);
-- Bitácora de activaciones (quién, cuándo y con qué huella): sirve para atender un cambio de equipo
CREATE TABLE hq_activations (
  id TEXT PRIMARY KEY,
  branch_id TEXT NOT NULL REFERENCES hq_branches(id),
  fingerprint TEXT NOT NULL,
  device TEXT,
  ip TEXT,
  created_at INTEGER NOT NULL
);
`,
  },
  {
    id: 12,
    name: "respaldos_nube",
    sql: `
-- Respaldos cifrados de las sucursales (el HQ solo guarda texto cifrado; el archivo vive en el volumen)
CREATE TABLE hq_backups (
  id TEXT PRIMARY KEY,
  branch_id TEXT NOT NULL REFERENCES hq_branches(id),
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (branch_id, name)
);
CREATE INDEX idx_hq_backups_branch ON hq_backups(branch_id, created_at);
`,
  },
  {
    id: 13,
    name: "cajon_de_dinero",
    sql: `
-- Cajón de dinero conectado a la impresora de caja (pulso ESC/POS): se abre con los cobros en efectivo
ALTER TABLE printers ADD COLUMN has_drawer INTEGER NOT NULL DEFAULT 0;
-- Pin del conector RJ11 al que está cableado el cajón: 0 = pin 2 (lo habitual), 1 = pin 5
ALTER TABLE printers ADD COLUMN drawer_pin INTEGER NOT NULL DEFAULT 0 CHECK (drawer_pin IN (0,1));
`,
  },
  {
    id: 14,
    name: "suscripcion_anual",
    sql: `
-- Suscripción anual: hasta cuándo está pagada la organización (la licencia de sus sucursales vence ese día)
ALTER TABLE hq_orgs ADD COLUMN paid_until INTEGER;
`,
  },
];
