# docs — memoria escrita del proyecto

Aquí vive **toda la documentación persistente** de KYLOO-NODO. Lo que no está aquí, o en `CLAUDE.md`, no existe para la siguiente sesión.

## Índice

| Documento | Qué es | Estado |
|---|---|---|
| [`REPORTE-SESION-2026-10-03.md`](REPORTE-SESION-2026-10-03.md) | Resumen de la sesión autónoma: qué se hizo, qué decidí, qué falta de ti | Vivo (léelo primero) |
| [`PLAN-00-ESTRUCTURA-DE-TRABAJO.md`](PLAN-00-ESTRUCTURA-DE-TRABAJO.md) | Cómo trabajamos y qué haremos: la estructura del proyecto, el rumbo y el orden de las etapas | **Abierto** (2026-10-03) |
| [`ESTADO-ACTUAL.md`](ESTADO-ACTUAL.md) | Qué hay hoy: arquitectura, módulos, medidas, deuda, ramas | Vivo |
| [`AUDITORIA-SEGURIDAD-2026-10-03.md`](AUDITORIA-SEGURIDAD-2026-10-03.md) | Auditoría de seguridad: hallazgos, arreglos y lo abierto | **Cerrada** (2026-10-03) |
| [`PLAN-01-LINEA-BASE-Y-CALIDAD.md`](PLAN-01-LINEA-BASE-Y-CALIDAD.md) | Línea base verde, `nube-web` integrada, herramientas de calidad | **Cerrado** (2026-10-03) |
| [`PLAN-02-EMPAQUETADO-E-INSTALACION.md`](PLAN-02-EMPAQUETADO-E-INSTALACION.md) | Empaquetado, instalación y primer arranque | **Cerrado** (2026-10-03) |
| [`PLAN-03-LICENCIAS-Y-ACTIVACION.md`](PLAN-03-LICENCIAS-Y-ACTIVACION.md) | Licencias atadas al equipo y activación por código | **Cerrado** (2026-10-03) |
| [`PLAN-04-RESPALDO-EN-NUBE.md`](PLAN-04-RESPALDO-EN-NUBE.md) | Respaldo cifrado en la nube, restauración y HQ en Railway | **Cerrado** (2026-10-03) |
| [`PLAN-06-APP-ENVOLTORIO.md`](PLAN-06-APP-ENVOLTORIO.md) | App envoltorio para tablets Android | **Cerrado** (2026-10-03) |
| [`PLAN-05-IMPRESION-Y-RED-LOCAL.md`](PLAN-05-IMPRESION-Y-RED-LOCAL.md) | Impresión (cajón, descubrimiento), conexión de tablets y cliente sin conexión | **Cerrado** (2026-10-03) |
| [`deploy/INSTALACION.md`](deploy/INSTALACION.md) | Cómo se instala, actualiza y desinstala Nodo en un local | Vivo |
| [`deploy/LICENCIAS.md`](deploy/LICENCIAS.md) | Cómo se emiten, activan y protegen las licencias | Vivo |
| [`deploy/RESPALDOS.md`](deploy/RESPALDOS.md) | Respaldos cifrados en la nube y recuperación de un local | Vivo |
| [`deploy/APP-TABLET.md`](deploy/APP-TABLET.md) | App de tablet Android: instalar, construir y probar en emulador | Vivo |
| [`deploy/RED-LOCAL.md`](deploy/RED-LOCAL.md) | Red del local, impresoras, cajón y qué pasa sin conexión | Vivo |
| [`deploy/HQ-RAILWAY.md`](deploy/HQ-RAILWAY.md) | Cómo crear y operar el servidor de Nodo (HQ) en Railway | Vivo |
| [`DESIGN.md`](DESIGN.md) | Sistema visual de Nodo | Vigente |
| [`DESIGN-reference-brex.md`](DESIGN-reference-brex.md) | Referencia visual externa de la que parte `DESIGN.md` | Referencia |
| [`INVESTIGACION-COMANDEROS.md`](INVESTIGACION-COMANDEROS.md) | Investigación de la competencia (2026-10-01) | Referencia |
| [`PLAN-FASE1.md`](PLAN-FASE1.md), [`PLAN-FASE2.md`](PLAN-FASE2.md), [`PLAN-FASE3.md`](PLAN-FASE3.md) | Planes originales de las tres fases | **Cerrados**, históricos |

## Reglas de uso

1. **Se versiona todo**, salvo documentos con secretos (esos van a `.gitignore` con comentario).
2. **Nombres:** `PLAN-<NN>-<TEMA>.md` (los planes de iteración se numeran: 00, 01, 02…), `AUDITORIA-`, `GUION-`, `DECISION-`, en mayúsculas con guiones. Fechas absolutas dentro del texto.
3. **Un plan por etapa**, con la plantilla de la skill `kyle-from-kyloo` (sección 5): encargo literal, lo que hay hoy, decisiones, invariantes, orden con casillas, registro.
4. **El plan y su registro se actualizan en el mismo commit que el código.** Las casillas se marcan al cerrar, con su commit.
5. **No se reescribe la historia:** un plan cerrado se corrige con entradas fechadas; un documento sustituido se marca 🚫 y se conserva, diciendo qué lo reemplaza.
6. **Si un documento discrepa del código, gana el código** y el documento se corrige.
7. Al crear o cambiar el estado de un documento, se actualiza este índice y la tabla de `CLAUDE.md`.
