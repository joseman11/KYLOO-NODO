import { useState } from "react";
import { api, photoSrc, useLive } from "../api";
import { PagedRows } from "../fit";
import { resizeImage } from "../image";
import { Icon } from "../icons";
import { ROLE_LABEL, UserAvatar } from "../Avatar";

interface UserRow {
  id: string;
  name: string;
  username: string | null;
  role: string;
  active: number;
  photo: string | null;
  has_pin: number;
}
interface Form {
  id: string | null;
  name: string;
  role: string;
  pin: string;
  active: boolean;
  photo: string | null;
  pending: string | null;
  remove: boolean;
}

const ROLES = ["mesero", "cajero", "cocina", "bar", "gerente", "encargado_caja", "supervisor"];
const EMPTY: Form = {
  id: null,
  name: "",
  role: "mesero",
  pin: "",
  active: true,
  photo: null,
  pending: null,
  remove: false,
};

/** Equipo: alta de trabajadores con su foto, que aparece en la pantalla de acceso. */
export function Users() {
  const users = useLive(() => api<UserRow[]>("/api/users"), ["staff.updated"]);
  const [form, setForm] = useState<Form | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pickPhoto = (file?: File) => {
    if (!file || !form) return;
    resizeImage(file, 480, 0.85, true).then(
      (data) => setForm((f) => (f ? { ...f, pending: data, remove: false } : f)),
      (e) => setErr((e as Error).message),
    );
  };

  const save = async () => {
    if (!form) return;
    setBusy(true);
    setErr(null);
    try {
      let id = form.id;
      if (id) {
        await api(`/api/users/${id}`, {
          method: "PATCH",
          body: {
            name: form.name.trim(),
            role: form.role,
            active: form.active,
            ...(form.pin ? { pin: form.pin } : {}),
          },
        });
      } else {
        if (!/^\d{4,8}$/.test(form.pin)) throw new Error("Escribe un PIN de 4 a 8 dígitos");
        id = (
          await api<{ id: string }>("/api/users", {
            body: { name: form.name.trim(), role: form.role, pin: form.pin },
          })
        ).id;
      }
      if (form.pending) await api(`/api/users/${id}/photo`, { body: { data: form.pending } });
      else if (form.remove && form.photo) await api(`/api/users/${id}/photo`, { method: "DELETE" });
      setForm(null);
      users.reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const preview = form ? (form.pending ?? (form.remove ? null : photoSrc(form.photo))) : null;
  const isAdmin = form?.role === "admin";

  return (
    <div className="view">
      <div className="row spread" style={{ flex: "none" }}>
        <span className="small">
          Su foto aparece en la pantalla de acceso. Cada persona entra con su PIN.
        </span>
        <button
          className="btn primary"
          onClick={() => {
            setForm(EMPTY);
            setErr(null);
          }}
        >
          + Nuevo trabajador
        </button>
      </div>
      {users.error && (
        <p className="err" style={{ flex: "none" }}>
          {users.error}
        </p>
      )}
      <PagedRows
        items={users.data ?? []}
        rowH={60}
        head={
          <tr>
            <th>Trabajador</th>
            <th>Puesto</th>
            <th>Acceso</th>
            <th>Estado</th>
            <th />
          </tr>
        }
        row={(u) => (
          <>
            <td>
              <span className="row" style={{ gap: 10 }}>
                <UserAvatar name={u.name} photo={u.photo} size={40} />
                <strong className="ellipsis">{u.name}</strong>
              </span>
            </td>
            <td>{ROLE_LABEL[u.role] ?? u.role}</td>
            <td>{u.username ? `Usuario ${u.username}` : u.has_pin ? "PIN" : "—"}</td>
            <td>
              {u.active ? (
                <span className="tag">Activo</span>
              ) : (
                <span className="small">Dado de baja</span>
              )}
            </td>
            <td className="r">
              <button
                className="btn sm"
                onClick={() => {
                  setForm({
                    id: u.id,
                    name: u.name,
                    role: u.role,
                    pin: "",
                    active: !!u.active,
                    photo: u.photo,
                    pending: null,
                    remove: false,
                  });
                  setErr(null);
                }}
              >
                Editar
              </button>
            </td>
          </>
        )}
      />

      {form && (
        <div className="sheet-bg" onClick={() => !busy && setForm(null)}>
          <div className="sheet center" onClick={(e) => e.stopPropagation()}>
            <h3>{form.id ? "Editar trabajador" : "Nuevo trabajador"}</h3>
            <div className="row" style={{ gap: 14 }}>
              <div className="portrait">
                {preview ? <img src={preview} alt="Foto" /> : <Icon name="camara" size={34} />}
              </div>
              <div className="col" style={{ gap: 6 }}>
                <label
                  className="btn sm"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                  }}
                >
                  Tomar foto
                  <input
                    type="file"
                    accept="image/*"
                    capture="user"
                    hidden
                    onChange={(e) => {
                      pickPhoto(e.target.files?.[0]);
                      e.target.value = "";
                    }}
                  />
                </label>
                <label
                  className="btn sm"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                  }}
                >
                  Elegir de la galería
                  <input
                    type="file"
                    accept="image/*"
                    hidden
                    onChange={(e) => {
                      pickPhoto(e.target.files?.[0]);
                      e.target.value = "";
                    }}
                  />
                </label>
                {preview && (
                  <button
                    className="btn ghost sm"
                    onClick={() => setForm({ ...form, pending: null, remove: true })}
                  >
                    Quitar foto
                  </button>
                )}
              </div>
            </div>
            <input
              placeholder="Nombre"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            {!isAdmin && (
              <select
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value })}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
            )}
            <input
              inputMode="numeric"
              placeholder={
                form.id ? "Nuevo PIN (déjalo vacío para no cambiarlo)" : "PIN de 4 a 8 dígitos"
              }
              value={form.pin}
              onChange={(e) =>
                setForm({ ...form, pin: e.target.value.replace(/\D/g, "").slice(0, 8) })
              }
            />
            {form.id && !isAdmin && (
              <label className="row" style={{ gap: 8 }}>
                <input
                  type="checkbox"
                  style={{ minHeight: 0, width: 20, height: 20 }}
                  checked={form.active}
                  onChange={(e) => setForm({ ...form, active: e.target.checked })}
                />
                Activo (si lo desmarcas, ya no aparece al iniciar sesión)
              </label>
            )}
            {err && <p className="err">{err}</p>}
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button className="btn" disabled={busy} onClick={() => setForm(null)}>
                Cancelar
              </button>
              <button className="btn primary" disabled={busy || !form.name.trim()} onClick={save}>
                Guardar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
