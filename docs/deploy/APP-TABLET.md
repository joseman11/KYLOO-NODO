# App de tablet (Android)

> Vigente al 2026-10-03 (plan 06). Diseño y razones: [`PLAN-06`](../PLAN-06-APP-ENVOLTORIO.md). **Probada en emuladores Android** (Pixel Tablet de 10 pulgadas) con el servidor real; **sin probar en una tableta física** (ver «Qué falta»).

## Qué es

Una app que **lleva la interfaz de Nodo dentro** y habla con el servidor del local por la red local. Por eso abre siempre, incluso sin red: lo que se ve viene de la propia app, no del servidor. Lo que no viene del servidor (cola de comandas pendientes, menú y mesas en memoria) vive en el dispositivo.

La web que sirve el propio servidor (`http://<ip>:3003`) sigue funcionando igual para la PC de caja o un celular prestado.

## Instalar en una tablet

1. Copia `nodo-<versión>-debug.apk` a la tablet (o `adb install -r …`) y ábrelo (permitir «orígenes desconocidos» si lo pide). *El APK de entrega firmado queda pendiente de la llave de firma; ver «Qué falta».*
2. La primera vez pide **la dirección del servidor**: la que se ve en el equipo del local en *Configuración → Conectar* (por ejemplo `192.168.1.20`). La app comprueba que ahí hay un Nodo y que habla su mismo contrato.
3. Entrar por PIN como siempre. **Cambiar servidor** está en la pantalla de acceso.

## Construir el APK (equipo de desarrollo)

Necesita Android Studio/SDK y un **JDK 17 a 21** (Gradle aún no soporta el JDK 25 que trae Android Studio).

```bash
cd 003/apps/mobile
JAVA_HOME=<JDK 21> ANDROID_HOME=~/Library/Android/sdk node scripts/build-apk.mjs      # → dist/nodo-<v>-debug.apk
```

Compila la interfaz, la copia al proyecto Android (`cap sync`) y corre Gradle. Para entregar: `--release` con las variables `NODO_KEYSTORE`, `NODO_KEYSTORE_PASSWORD`, `NODO_KEY_ALIAS`, `NODO_KEY_PASSWORD`.

## Probar en un emulador o tablet por USB

```bash
adb install -r dist/nodo-0.1.0-debug.apk && adb shell am start -n mx.com.kyloo.nodo/.MainActivity
adb forward tcp:9222 localabstract:webview_devtools_remote_$(adb shell pidof mx.com.kyloo.nodo)
NODO_SERVER=10.0.2.2:3005 node scripts/emulator-test.mjs      # 10.0.2.2 = la PC anfitriona vista desde el emulador
```

La prueba maneja el WebView de la app: primera conexión, acceso por PIN, mapa de mesas, **recarga sin red** (abre con lo último conocido y el aviso) y reconexión. Resultado del 2026-10-03 en *Pixel Tablet* (2560×1600, Android 17): **todo en verde**.

## Rendimiento medido (2026-10-03)

En el emulador **«7in WSVGA (Tablet)»** (1024×600, 2 núcleos y 2 GB de RAM; GPU del anfitrión, así que lo gráfico es optimista) con la demo de la marisquería: **61 cuadros por segundo** en reposo y tras recorrer las secciones, **7 MB de memoria de JavaScript**, 1 902 nodos de página y **254 ms** hasta cargar la interfaz. La prueba de punta a punta (conexión, PIN, mapa, recarga sin red, reconexión) pasa en el Pixel Tablet de 10 pulgadas y en esta económica. **Falta medirlo en una tableta física** (su GPU y su WiFi pueden ser peores).

## Cómo está hecho

- **Capacitor** (Android). La interfaz se empaqueta (`apps/web/dist`) y se sirve desde `http://localhost` dentro de la app (un origen «seguro», sin avisos de contenido mixto). La API se llama a `http://<servidor>:3003` (tráfico en claro permitido en la app: solo habla con el servidor elegido).
- El servidor acepta ese origen por **CORS con lista cerrada** (`http://localhost`, `https://localhost`, `capacitor://localhost`; más los de `NODO_CORS_ORIGINS`). Cualquier otro origen no recibe permiso.
- **Contrato:** `/api/health` publica `contract`; si no coincide con el de la interfaz de la app, la app dice «actualiza la app o el servidor». Se sube `API_CONTRACT` (`packages/shared/src/contract.ts`) solo cuando un cambio de API rompe a una interfaz anterior.
- Pantalla siempre encendida; sin *service worker* dentro de la app (no hace falta).

## Qué falta

- 🔴 **Probar en una tableta física económica** (táctil real, WiFi del local, rendimiento).
- 🟠 **APK firmado** para entregar (llave de firma de la app) y, más adelante, publicación en Play Store si se quiere.
- 🟠 **Icono y pantalla de inicio** propios (hoy son los de Capacitor).
- 🟡 **Escaneo del QR** de *Conectar* desde la app (hoy se escribe la dirección). Requiere el servicio de Google en la tablet o una biblioteca propia.
- 🟡 **iOS:** necesita Xcode y cuenta de Apple Developer; se hace cuando un cliente lo pida.
- 🟡 **Modo quiosco** (que la tablet no salga de la app): se configura con el «anclaje de pantalla» de Android o un gestor de dispositivos; no lo hace la app.
