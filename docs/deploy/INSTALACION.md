# Instalación de Nodo en el local

> Procedimiento vigente al 2026-10-03 (plan 02). Lo ejecuta hoy el dueño en los primeros locales; está pensado para que un cliente pueda hacerlo solo.
>
> ⚠️ **Probado:** el paquete de macOS (arranca, atiende, se apaga y reinicia sin perder datos) y la sintaxis de los scripts de Windows (analizador de PowerShell 7.4). **Sin probar en Windows:** el instalador `.exe`, el servicio y el firewall. Hasta hacer una instalación real en una PC con Windows, tómalo como no verificado. Ver «Qué falta».

## Qué es lo que se instala

Un solo paquete, sin herramientas de desarrollo ni conexión a Internet:

| Pieza | Para qué |
|---|---|
| `node.exe` | El Node oficial (la versión exacta con la que se prueba Nodo), verificado contra la suma publicada por nodejs.org al construir |
| `app/server.mjs` | El servidor completo en un archivo |
| `app/web/` | La aplicación que abren las tablets, la caja y la cocina |
| `nodo-service.exe` + `.xml` | WinSW: convierte el servidor en un **servicio de Windows** que arranca con el equipo y se reinicia solo si se cae |
| `install.ps1` / `uninstall.ps1` | Instalan, actualizan y desinstalan |

Los **datos** (base de datos, fotos, respaldos y registros) viven aparte, en `C:\ProgramData\Nodo`. Instalar, actualizar o desinstalar **no los toca** (invariante I2.1 del plan 02).

## Requisitos del equipo del local

- Windows 10 u 11 de 64 bits (también corre en macOS y Linux, sin servicio automático por ahora).
- Memoria: el servidor usa ~100 MB en reposo; con 4 GB de RAM en el equipo sobra.
- Disco **SSD** (la base de datos escribe en cada venta) y 2 GB libres.
- **IP fija** para el equipo, asignada en el router o en Windows: las tablets y las impresoras se encuentran por IP.
- Recomendado: **UPS** (no-break). Un corte de luz no daña la base (SQLite en modo WAL), pero el no-break evita cortes a mitad de una venta.
- Impresoras térmicas de red (Ethernet o WiFi), puerto 9100, con IP fija.

## Instalar

1. Copia `Nodo-Setup-<versión>.exe` al equipo (o el `.zip` y descomprímelo).
2. Ejecuta el instalador como administrador. Con el `.zip`: clic derecho en PowerShell → *Ejecutar como administrador* y
   `powershell -ExecutionPolicy Bypass -File install.ps1`.
3. El instalador copia el programa a `C:\Program Files\Nodo`, crea `C:\ProgramData\Nodo`, registra el servicio **NodoServer**, abre el puerto 3003 **solo a la red local** y espera a que el servidor responda. Si no responde en 30 s, falla con un mensaje y la ruta de los registros.
4. Al terminar muestra las direcciones: `http://localhost:3003` en el equipo y `http://<IP>:3003` desde las tablets.

Opciones de `install.ps1`: `-Port 3003`, `-InstallDir`, `-NoBrowser`.

## Primer arranque

Una instalación nueva **no trae usuarios ni claves**. Al abrir Nodo aparece el asistente: nombre del local, nombre del administrador, usuario y contraseña (mínimo 8 caracteres; no admite las más comunes). Después se configura el resto en *Configuración*: áreas y estaciones, mesas, menú, impresoras (IP y puerto 9100) y personal con su PIN.

En cada tablet: abrir la dirección del servidor en el navegador. *(La distribución del cliente como app queda por decidir: D11 del plan 00.)*

## Actualizar

Se ejecuta el instalador de la versión nueva encima: detiene el servicio, reemplaza el programa, conserva el puerto y los datos, y arranca. Si hay migraciones de base pendientes, **el servidor copia la base** a `C:\ProgramData\Nodo\backups\pre-migracion-<desde>-a-<hasta>.sqlite` antes de aplicarlas (se conservan las 5 más recientes). Si una migración falla, la copia y los datos quedan intactos.

## Desinstalar

`uninstall.ps1` (o *Aplicaciones* de Windows) detiene y quita el servicio, la regla de firewall y el programa. **Los datos se conservan.** Con `-PurgeData` los borra, pidiendo escribir `BORRAR`.

## Dónde está cada cosa

| Qué | Dónde |
|---|---|
| Programa | `C:\Program Files\Nodo` |
| Base de datos | `C:\ProgramData\Nodo\nodo.sqlite` |
| Respaldos automáticos (diarios, 14) y previos a migración (5) | `C:\ProgramData\Nodo\backups` |
| Fotos de platillos | `C:\ProgramData\Nodo\photos` |
| Registros de la aplicación (rotan a 5 MB, 5 archivos) | `C:\ProgramData\Nodo\logs\nodo.log` |
| Registro del servicio | `C:\ProgramData\Nodo\logs\nodo-service.*.log` |

El registro no guarda cada petición: solo arranque y apagado, respaldos, migraciones y errores, y sin parámetros de URL ni tokens.

## Variables de entorno (avanzado)

`NODO_DATA_DIR` (carpeta de datos) · `PORT` (3003) · `HOST` (0.0.0.0) · `NODO_LOG_LEVEL` (`warn` por defecto para el servidor web; `debug` para diagnosticar) · `DB_FILE`, `BACKUP_DIR`, `PHOTOS_DIR`, `LOG_DIR`, `WEB_DIR` (rutas sueltas, mandan sobre `NODO_DATA_DIR`).

## Construir el paquete (equipo de desarrollo)

Desde `003/` y con Node 24 (ver `.nvmrc`); el paquete de Windows **se construye desde macOS o Linux** porque no hay módulos nativos:

```bash
npx -y pnpm@11.21.0 install
npx -y pnpm@11.21.0 --filter @003/packaging build -- --platform win32 --arch x64   # ZIP + Nodo-Setup-<v>.exe
npx -y pnpm@11.21.0 --filter @003/packaging build                                  # plataforma actual
npx -y pnpm@11.21.0 --filter @003/packaging smoke                                  # prueba de humo del paquete de esta máquina
```

Salida en `003/packaging/dist/` (ignorada por git) con la suma SHA-256 de cada archivo. El `.exe` se genera con NSIS (`brew install makensis`); sin él se omite y se avisa. WinSW y el Node empaquetado se descargan y se verifican por SHA-256 (la suma de WinSW está fijada en `build.mjs`).

## Qué falta

- 🔴 **Probar en una PC con Windows real** el instalador, el servicio (arranque con el equipo, reinicio tras caída, parada) y el firewall.
- 🟠 **Firmar el instalador** (certificado de firma de código): sin firma, Windows SmartScreen muestra una advertencia al ejecutarlo. Es una compra del dueño.
- 🟠 **Activación de licencia y nube** dentro de la instalación: plan 03 y plan 04.
- 🟡 **Apagado ordenado en Windows:** WinSW detiene el servidor terminando el proceso. Es seguro (SQLite en WAL se recupera solo) pero no registra «apagado completo»; en macOS/Linux la señal SIGTERM sí lo hace (comprobado).
- 🟡 **Asignación de IP fija y descubrimiento de la dirección** (mDNS/QR): plan 05.
