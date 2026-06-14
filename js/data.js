// Capa de datos de SIT EBEMA
// Fuente principal: Supabase (PostgreSQL compartido, protegido con RLS).
// localStorage se mantiene como copia local de respaldo (modo sin conexión).
import { supabase } from './supabase-client.js';

const STORAGE_KEY = 'ebema_transporte_db';

// Mapeo colección local ↔ tabla Supabase (con su clave primaria)
const TABLE_MAP = [
  { local: 'logisticsCentres',  table: 'logistics_centres',  pk: 'id' },
  { local: 'routes',            table: 'routes',             pk: 'id' },
  { local: 'truckTypes',        table: 'truck_types',        pk: 'id' },
  { local: 'transports',        table: 'transports',         pk: 'id' },
  { local: 'transportsCamiones',  table: 'transports_camiones',  pk: 'id_camion' },
  { local: 'transportsChoferes',  table: 'transports_choferes',  pk: 'rut' },
  { local: 'quotesHistory',     table: 'quotes_history',     pk: 'id' },
  { local: 'users',             table: 'app_users',          pk: 'email' },
  { local: 'providers',         table: 'providers',          pk: 'email' },
  { local: 'tariffConfig',       table: 'tariff_config',        pk: 'id' },
  { local: 'clientTariffConfig', table: 'client_tariff_config', pk: 'id' }
];

// Capacidad nominal en KG a partir del nombre del tipo de camión (ej: "Camión 28 Ton" -> 28000)
export function truckCapKg(type) {
  const m = String(type).match(/(\d+)/);
  return m ? Number(m[1]) * 1000 : 0;
}

// Tipo de eje según capacidad del camión (Tons): 5 a 10 Ton -> 2 ejes · 15 a 28 Ton -> 3 ejes
export function calcEjes(capacidad) {
  return Number(capacidad) >= 15 ? 3 : 2;
}

// Tarifas de transporte por centro (truck_types): 4 tipos de camión base,
// duplicados para cada centro logístico (Id_centro). Kmbase/baseKM definen
// el tramo y costo base referencial; baseRate/ratePerKm son la tarifa vigente.
const TRUCK_BASE_TYPES = [
  { type: 'Camión 5 Ton',  capacityTons: 'Hasta 5 Tons',  baseRate: 45000,  ratePerKm: 1200 },
  { type: 'Camión 10 Ton', capacityTons: 'Hasta 10 Tons', baseRate: 60000,  ratePerKm: 1500 },
  { type: 'Camión 15 Ton', capacityTons: 'Hasta 15 Tons', baseRate: 75000,  ratePerKm: 1800 },
  { type: 'Camión 28 Ton', capacityTons: 'Hasta 28 Tons', baseRate: 120000, ratePerKm: 2500 }
];

// Genera las filas de truck_types (una por centro x tipo de camión) a partir
// de una lista de centros logísticos y una lista base de tipos de camión.
function buildTruckTypes(centres, baseTypes = TRUCK_BASE_TYPES) {
  const out = [];
  (centres || []).forEach(cd => {
    baseTypes.forEach(b => {
      const cap = String(truckCapKg(b.type) / 1000);
      out.push({
        id: `${cd.id}-${cap}`,
        Id_centro: cd.id,
        type: b.type,
        capacityTons: b.capacityTons,
        baseRate: Number(b.baseRate) || 0,
        ratePerKm: Number(b.ratePerKm) || 0,
        Kmbase: 50,
        baseKM: Number(b.baseRate) || 0
      });
    });
  });
  return out;
}

// Derivar las tablas normalizadas transports_camiones / transports_choferes
// a partir de los arrays JSON transports[].camiones / transports[].choferes.
// El JSON sigue siendo la fuente de verdad (sin reescritura de la pantalla Transportistas);
// estas tablas planas se regeneran completas en cada guardado para mantenerse sincronizadas.
function deriveCamionesChoferes(db) {
  const camiones = [];
  const choferes = [];
  (db.transports || []).forEach(t => {
    (t.camiones || []).forEach(c => {
      if (!c.patente) return;
      camiones.push({
        id_camion: c.patente,
        id_transporte: t.id,
        modelo: c.modelo || '',
        anio: c.anio || null,
        capacidad_ton: c.capacidad || 0,
        ejes: c.ejes !== undefined ? c.ejes : calcEjes(c.capacidad),
        alto_carroceria: (c.dimensiones && c.dimensiones.alto) || null,
        ancho_carroceria: (c.dimensiones && c.dimensiones.ancho) || null,
        largo_carroceria: (c.dimensiones && c.dimensiones.largo) || null,
        chofer_rut: c.choferRut || null,
        documentos: c.documentos || {}
      });
    });
    (t.choferes || []).forEach(ch => {
      if (!ch.rut) return;
      const nombreCompleto = (ch.nombre || '').trim();
      const partes = nombreCompleto.split(/\s+/);
      const idCamion = (t.camiones || []).find(c => c.choferRut === ch.rut);
      choferes.push({
        rut: ch.rut,
        nombre: partes[0] || '',
        apellido: partes.slice(1).join(' '),
        licencia: ch.licencia || '',
        celula_identidad: ch.archivoCarne || null,
        telefono: ch.telefono || '',
        id_transporte: t.id,
        id_camion: idCamion ? idCamion.patente : null
      });
    });
  });
  db.transportsCamiones = camiones;
  db.transportsChoferes = choferes;
}

// Configuración por defecto: Administrador de Tarifas Transporte (Pantalla 1)
export function defaultTariffConfig() {
  return {
    // Sub-módulo 1: Peajes — [{ id, rutaId, ejes, concesionaria, plazaPeaje, valorPeaje }]
    peajes: [],
    // Sub-módulo 2: Combustibles — { [centroId]: { precioLitro, fecha } }
    combustibles: {},
    // Matriz de rendimiento estructural (km/L), por capacidad en kg
    rendimientos: {
      '5000':  { cargado: 7.5, vacio: 9.5 },
      '10000': { cargado: 5.0, vacio: 7.0 },
      '15000': { cargado: 4.2, vacio: 5.8 },
      '28000': { cargado: 2.8, vacio: 4.0 }
    },
    // Mapeo fijo de ejes por capacidad (kg)
    ejes: { '5000': 2, '10000': 2, '15000': 3, '28000': 3 },
    // Sub-módulo 3: Seguro de carga — { [centroId]: ufMensual }
    seguros: {},
    // Permiso de circulación + SOAP anual — { 'centroId|capKg': { permiso, soap } }
    permisosSoap: {},
    // KM Mensuales Ofrecidos — { 'centroId|capKg': km }
    kmOfrecidos: {},
    // Sub-módulo 4: Variables generales
    variables: {
      valorUF: 38000,
      fechaUF: '',
      margenGanancia: 15,
      neumaticos: {
        ciclo: 50000,
        costos: { '5000': 400000, '10000': 600000, '15000': 800000, '28000': 1200000 }
      },
      gps: { costoUF: 0.45 },
      mantencion: { ciclo: 20000, costos: {} }, // { 'centroId|capKg': costo }
      chofer: { sueldoMinimo: {}, diasHabiles: 22, comisionPct: 5 }, // sueldoMinimo: { centroId: monto }
      factorRuta: { NORMAL: 1.00, ISLA: 1.35, EXTREMA: 1.50 },
      costosBase: {
        '5000':  { fijo: 30000,  kmAdicional: 46000 },
        '10000': { fijo: 30000,  kmAdicional: 76000 },
        '15000': { fijo: 30000,  kmAdicional: 83000 },
        '28000': { fijo: 100000, kmAdicional: 100000 }
      }
    }
  };
}

// Configuración por defecto: Administrador de Tarifas Clientes (Pantalla 2)
export function defaultClientTariffConfig() {
  return {
    // Sub-módulo A: histórico 6M ingresado vía CSV
    historico: [], // [{ centroId, rutaId, tipoCamionKg, toneladas, clientes, obras, interregional }]
    // Sub-módulo B/C: resultados de consolidación y complejidad por ruta
    consolidacion: {}, // { rutaId: { factorFinal, indicador, cluster } }
    clusterColors:    { '1': '#16a34a', '2': '#f59e0b', '3': '#3b82f6', spot: '#6b7280' },
    clusterNV:        { '1': 3.5, '2': 2.0, '3': 2.0, spot: 1.0 },
    clusterFrecuencia:{ '1': 'Lunes a Viernes', '2': '2 a 3 días/semana', '3': '2 días/semana', spot: '48 horas' },
    // Sub-módulo: Tarifas especiales
    especiales: {
      tipo0000: { tarifaPlana: 0 },
      recargoExclusividad: {} // { centroId: { activo: false, pct: 0 } }
    }
  };
}

let memoryDb = null;

// Cargar TODO desde Supabase a memoria (llamar tras iniciar sesión)
export async function initDatabase() {
  try {
    const results = await Promise.all(
      TABLE_MAP.map(t => supabase.from(t.table).select('*'))
    );
    const failed = results.find(r => r.error);
    if (failed) throw failed.error;

    memoryDb = {};
    TABLE_MAP.forEach((t, i) => { memoryDb[t.local] = results[i].data || []; });

    localStorage.setItem(STORAGE_KEY, JSON.stringify(memoryDb));
    return memoryDb;
  } catch (err) {
    console.error('Supabase no disponible, usando copia local:', err.message || err);
    memoryDb = null; // getDatabase usará el respaldo de localStorage
    return getDatabase();
  }
}

// Sincronizar una colección completa hacia Supabase (upsert + borrar faltantes)
async function syncTable(table, pk, rows) {
  if (rows.length > 0) {
    const { error } = await supabase.from(table).upsert(rows);
    if (error) throw error;
  }
  const keys = rows.map(r => String(r[pk]).replace(/"/g, ''));
  let q = supabase.from(table).delete();
  q = keys.length > 0
    ? q.not(pk, 'in', `(${keys.map(k => `"${k}"`).join(',')})`)
    : q.neq(pk, '___nunca___');
  const { error } = await q;
  if (error) throw error;
}

// Enviar el estado completo a Supabase (en segundo plano)
// Importante: cada tabla se sincroniza de forma independiente (try/catch propio).
// Con RLS, un rol no-OWNER no tiene permiso para tocar ciertas tablas (p. ej.
// truck_types, tariff_config); si esa tabla fallara y abortara el for...of,
// el resto de las tablas (incluida la que el usuario realmente editó) 