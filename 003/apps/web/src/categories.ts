export interface Category { id: string; parent_id: string | null; name: string; sort: number; }

export interface CategoryNode extends Category { depth: number; path: string; }

/** Aplana el árbol de categorías en orden (cada categoría seguida de sus subcategorías) con su nivel y su ruta "Tacos › De calamar". */
export function flattenCategories(list: Category[]): CategoryNode[] {
  const byParent = new Map<string | null, Category[]>();
  for (const c of list) {
    const key = c.parent_id && list.some((x) => x.id === c.parent_id) ? c.parent_id : null;
    byParent.set(key, [...(byParent.get(key) ?? []), c]);
  }
  const out: CategoryNode[] = [];
  const walk = (parent: string | null, depth: number, prefix: string) => {
    const kids = (byParent.get(parent) ?? []).slice().sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, "es"));
    for (const k of kids) {
      const path = prefix ? `${prefix} › ${k.name}` : k.name;
      out.push({ ...k, depth, path });
      if (depth < 5) walk(k.id, depth + 1, path);
    }
  };
  walk(null, 0, "");
  return out;
}

/** La categoría y todas sus subcategorías. */
export function withDescendants(list: Category[], id: string): Set<string> {
  const ids = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of list) if (c.parent_id && ids.has(c.parent_id) && !ids.has(c.id)) { ids.add(c.id); grew = true; }
  }
  return ids;
}
