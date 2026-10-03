/**
 * Versión del contrato entre la interfaz y el servidor. La app envoltorio de las tablets lleva la interfaz dentro, así que
 * puede ser de otra versión que el servidor del local: si el contrato mayor no coincide, la app pide actualizarse en vez de
 * fallar a medias. Se sube cuando un cambio de la API rompe a una interfaz anterior (no con cada versión).
 */
export const API_CONTRACT = 1;
