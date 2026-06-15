// PANTALLA 1: Administrador de Tarifas Transporte — SIT EBEMA
// Sub-módulos: Peajes, Combustibles y Rendimientos, Seguros y Permisos,
// Variables Generales y Motor Actuarial (ZCAP) con exportación CSV.
import { getDatabase, saveDatabase, getCentreName, getTariffConfig, truckCapKg } from './data.js';
import { CAP_LIST, truckTypesWithCap, calcularMatrizCostos } from './tarifas-engine.js';
import { formatCLP, parseCSV, showAlert, toCSV, downloadFile, escapeHtml } from './utils.js';
import { supabase } from './supabase-client.js';
import { getField } from './zonas-transporte.js';

let activeSub = 'peajes';

// Estado de filtros de la vista "Peajes por Ruta — Cálculo Automático"
let pjFiltroTexto = '';
let pjFiltroComuna = '';
let pjFiltroCentro = '';
let pjFiltroClasificacion = '';
let pjFiltroPendientes = false;

// ---------- Helpers genéricos ----------
function setPath(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function getPath(obj, path, fallback) {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur === undefined || cur === null) return fallback;
    cur = cur[p];
  }
  return cur === undefined ? fallback : cur;
}

const inputCls = 'w-full border border-[#CED4DA] p-xs font-data-mono text-data-mono text-right focus:border-primary focus:ring-0 transition-all bg-white rounded';

function numInput(path, value, extra = '') {
  return `<input type="number" step="any" class="${inputCls}" data-path="${path}" value="${value ?? 0}" ${extra}>`;
}
function dateInput(path, value) {
  return `<input type="date" class="${inputCls} text-left" data-path="${path}" value="${value || ''}">`;
}
function textInput(path, value, extra = '') {
  return `<input type="text" class="${inputCls} text-left" data-path="${path}" value="${value || ''}" ${extra}>`;
}

function readCSVFile(file, cb) {
  const reader = new FileReader();
  reader.onload = (e) => cb(parseCSV(e.target.result));
  reader.readAsText(file, 'UTF-8');
}

// Normaliza un valor de "Tipo de camión" leído desde CSV a capacidad en KG (5000/10000/15000/28000)
function parseCapKgFromCSV(val) {
  let n = Number(String(val).replace(/[^\d.]/g, ''));
  if (!n) return 0;
  if (n <= 28) n = n * 1000;
  return n;
}

// ---------- Vista principal ----------
export function renderTariffTransportView(container) {
  const db = getDatabase();
  const cfg = getTariffConfig(db);

  container.innerHTML = `
    <div class="mb-xl">
      <h1 class="font-headline-lg text-headline-lg text-on-surface">Administrador de Tarifas Transporte</h1>
      <p class="font-body-lg text-body-lg text-secondary">Gestione las variables operacionales y monetarias que alimentan el motor actuarial de costos (ZCAP) por ruta y tipo de camión.</p>
    </div>

    <div class="flex gap-sm mb-lg border-b border-outline-variant pb-sm overflow-x-auto" id="tt-subtabs">
      ${subTabButton('peajes', 'toll', 'Peajes')}
      ${subTabButton('camiones', 'local_shipping', 'Tarifas por Camión')}
      ${subTabButton('combustibles', 'local_gas_station', 'Combustibles y Rendimientos')}
      ${subTabButton('seguros', 'shield', 'Seguros y Permisos')}
      ${subTabButton('variables', 'tune', 'Variables Generales')}
      ${subTabButton('resultados', 'calculate', 'Motor ZCAP')}
    </div>

    <div id="tt-content"></div>
  `;

  document.querySelectorAll('.tt-subtab').forEach(btn => {
    btn.addEventListener('click', () => {
      activeSub = btn.dataset.sub;
      renderSub();
    });
  });

  renderSub();

  function renderSub() {
    document.querySelectorAll('.tt-subtab').forEach(btn => {
      btn.className = btn.dataset.sub === activeSub
        ? 'tt-subtab flex items-center gap-xs px-md py-sm rounded-lg font-bold text-[12px] uppercase tracking-wide bg-primary text-white cursor-pointer whitespace-nowrap'
        : 'tt-subtab flex items-center gap-xs px-md py-sm rounded-lg font-bold text-[12px] uppercase tracking-wide bg-surface-container-high text-secondary hover:text-primary cursor-pointer whitespace-nowrap';
    });

    const content = document.getElementById('tt-content');
    switch (activeSub) {
      case 'peajes': renderPeajes(content, db, cfg); break;
      case 'camiones': renderTarifasCamion(content, db, cfg); break;
      case 'combustibles': renderCombustibles(content, db, cfg); break;
      case 'seguros': renderSeguros(content, db, cfg); break;
      case 'variables': renderVariables(content, db, cfg); break;
      case 'resultados': renderResultados(content, db, cfg); break;
    }

    // Listener delegado para todas las celdas editables con data-path
    content.addEventListener('change', (e) => {
      const path = e.target.dataset.path;
      if (!path) return;
      let val = e.target.value;
      if (e.target.type === 'number') val = val === '' ? 0 : Number(val);
      setPath(cfg, path, val);
      saveDatabase(db);
    });
  }
}

function subTabButton(key, icon, label) {
  return `<button class="tt-subtab flex items-center gap-xs px-md py-sm rounded-lg font-bold text-[12px] uppercase tracking-wide bg-surface-container-high text-secondary cursor-pointer whitespace-nowrap" data-sub="${key}">
    <span class="material-symbols-outlined text-[16px]">${icon}</span> ${label}
  </button>`;
}

// ============================================================
// SUB-MÓDULO 1: PEAJES
// ============================================================
const EJES_LABELS = { 2: '2 Ejes (5 y 10 Ton)', 3: '3 Ejes (15 y 28 Ton)' };
const PJ_DISPLAY_LIMIT = 500;

function pjGetTollRow(db, routeId, ejes) {
  return (db.routeTolls || []).find(rt => rt.route_id === routeId && Number(rt.ejes) === ejes);
}

function tollNumInput(routeId, ejes, field, value) {
  return `<input type="number" step="any" class="${inputCls}" data-toll-route="${routeId}" data-toll-ejes="${ejes}" data-toll-field="${field}" value="${value ?? 0}">`;
}

// Vista combinada: cálculo automático (route_tolls) + registro manual (cfg.peajes)
function renderPeajes(content, db, cfg) {
  content.innerHTML = `<div id="pj-auto"></div><div id="pj-manual" class="mt-xl"></div>`;
  renderPeajesAuto(document.getElementById('pj-auto'), db, cfg);
  renderPeajesManual(document.getElementById('pj-manual'), db, cfg);
}

// ---------- Cálculo Automático de Peajes (Google Routes API) ----------
function renderPeajesAuto(content, db, cfg) {
  const routes = (db.routes || []).filter(r => r.activo);
  const comunas = [...new Set(routes.map(r => r.comuna).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const centrosOrigen = [...new Set(routes.map(r => r.origenId).filter(Boolean))]
    .map(id => ({ id, nombre: getCentreName(db, id) || id }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre));

  // Construir filas (ruta x tipo de eje)
  let rows = [];
  routes.forEach(ruta => {
    [2, 3].forEach(ejes => {
      rows.push({ ruta, ejes, toll: pjGetTollRow(db, ruta.id, ejes) });
    });
  });

  // Aplicar filtros de pantalla
  if (pjFiltroTexto.trim()) {
    const q = pjFiltroTexto.trim().toLowerCase();
    rows = rows.filter(r => (r.ruta.codigo || '').toLowerCase().includes(q) || (r.ruta.destino || '').toLowerCase().includes(q));
  }
  if (pjFiltroComuna) {
    rows = rows.filter(r => r.ruta.comuna === pjFiltroComuna);
  }
  if (pjFiltroCentro) {
    rows = rows.filter(r => r.ruta.origenId === pjFiltroCentro);
  }
  if (pjFiltroClasificacion) {
    rows = rows.filter(r => r.ruta.clasificRuta === pjFiltroClasificacion);
  }
  if (pjFiltroPendientes) {
    rows = rows.filter(r => !r.toll || !r.toll.calculado_en || r.toll.needs_review);
  }

  const totalRows = rows.length;
  const displayRows = rows.slice(0, PJ_DISPLAY_LIMIT);

  let pendientesCount = 0;
  routes.forEach(ruta => {
    [2, 3].forEach(ejes => {
      const t = pjGetTollRow(db, ruta.id, ejes);
      if (!t || !t.calculado_en) pendientesCount++;
    });
  });
  const revisionCount = (db.routeTolls || []).filter(t => t.needs_review).length;

  content.innerHTML = `
    <div class="bg-surface-container-lowest border border-outline-variant p-lg shadow-sm mb-lg">
      <div class="flex items-center gap-sm mb-md border-b border-outline-variant pb-sm">
        <span class="material-symbols-outlined text-primary">toll</span>
        <h2 class="font-headline-sm text-headline-sm font-bold text-on-surface">Peajes por Ruta — Cálculo Automático</h2>
      </div>
      <p class="text-[12px] text-secondary mb-md">
        Calcula el costo de peaje de Ida y Vuelta de cada ruta vía Google Routes API, según el tipo de camión
        (2 ejes: 5 y 10 Ton · 3 ejes: 15 y 28 Ton). El cálculo se ejecuta a demanda y queda registrado para no
        repetirse. Las rutas sin peaje quedan en $0; las rutas donde se detectó un peaje sin valor disponible
        quedan marcadas <b>Para revisión</b> y todos los valores son editables manualmente.
      </p>

      <div class="grid grid-cols-1 md:grid-cols-4 gap-md mb-md">
        <div class="bg-surface-container-low p-md rounded">
          <p class="font-label-caps text-label-caps text-secondary">Rutas Activas</p>
          <p class="font-headline-sm text-headline-sm font-bold text-on-surface">${routes.length}</p>
        </div>
        <div class="bg-surface-container-low p-md rounded">
          <p class="font-label-caps text-label-caps text-secondary">Combinaciones (Ruta × Tipo Camión)</p>
          <p class="font-headline-sm text-headline-sm font-bold text-on-surface">${routes.length * 2}</p>
        </div>
        <button id="pj-kpi-pendientes" class="bg-surface-container-low p-md rounded text-left hover:bg-secondary-container transition-colors">
          <p class="font-label-caps text-label-caps text-secondary">Sin Calcular</p>
          <p class="font-headline-sm text-headline-sm font-bold text-on-surface">${pendientesCount}</p>
        </button>
        <button id="pj-kpi-revision" class="bg-surface-container-low p-md rounded text-left hover:bg-secondary-container transition-colors">
          <p class="font-label-caps text-label-caps text-secondary">Para Revisión</p>
          <p class="font-headline-sm text-headline-sm font-bold ${revisionCount > 0 ? 'text-primary' : 'text-on-surface'}">${revisionCount}</p>
        </button>
      </div>

      <div class="flex flex-wrap gap-sm items-end mb-md">
        <div class="space-y-xs">
          <label class="font-label-caps text-label-caps text-secondary block">BUSCAR RUTA</label>
          <input id="pj-f-texto" type="text" placeholder="Código o destino..." value="${escapeHtml(pjFiltroTexto)}" class="border border-[#CED4DA] p-sm font-body-md text-body-md bg-white w-56">
        </div>
        <div class="space-y-xs">
          <label class="font-label-caps text-label-caps text-secondary block">COMUNA</label>
          <select id="pj-f-comuna" class="border border-[#CED4DA] p-sm font-body-md text-body-md bg-white w-48">
            <option value="">Todas</option>
            ${comunas.map(c => `<option value="${escapeHtml(c)}" ${c === pjFiltroComuna ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}
          </select>
        </div>
        <div class="space-y-xs">
          <label class="font-label-caps text-label-caps text-secondary block">CENTRO ORIGEN</label>
          <select id="pj-f-origen" class="border border-[#CED4DA] p-sm font-body-md text-body-md bg-white w-48">
            <option value="">Todos</option>
            ${centrosOrigen.map(c => `<option value="${escapeHtml(c.id)}" ${c.id === pjFiltroCentro ? 'selected' : ''}>${escapeHtml(c.nombre)}</option>`).join('')}
          </select>
        </div>
        <div class="space-y-xs">
          <label class="font-label-caps text-label-caps text-secondary block">CLASIFICACIÓN</label>
          <select id="pj-f-clasif" class="border border-[#CED4DA] p-sm font-body-md text-body-md bg-white w-40">
            <option value="">Todas</option>
            <option value="Regional" ${pjFiltroClasificacion === 'Regional' ? 'selected' : ''}>Regional</option>
            <option value="Interregional" ${pjFiltroClasificacion === 'Interregional' ? 'selected' : ''}>Interregional</option>
          </select>
        </div>
        <div class="space-y-xs">
          <label class="font-label-caps text-label-caps text-secondary flex items-center gap-xs cursor-pointer">
            <input type="checkbox" id="pj-f-pend" ${pjFiltroPendientes ? 'checked' : ''}> SOLO PENDIENTES / REVISIÓN
          </label>
        </div>
        <div class="flex-1"></div>
        <button id="pj-carga-comuna" class="bg-surface-container-high hover:bg-surface-container text-on-surface font-bold px-md py-sm rounded flex items-center gap-xs text-[12px] uppercase">
          <span class="material-symbols-outlined text-[18px]">upload_file</span> Carga Masiva por Comuna
        </button>
        <button id="pj-export" class="bg-surface-container-high hover:bg-surface-container text-on-surface font-bold px-md py-sm rounded flex items-center gap-xs text-[12px] uppercase">
          <span class="material-symbols-outlined text-[18px]">download</span> Exportar CSV
        </button>
        <button id="pj-calcular" class="bg-primary hover:bg-[#930007] text-white font-bold px-md py-sm rounded flex items-center gap-xs text-[12px] uppercase">
          <span class="material-symbols-outlined text-[18px]">calculate</span> Calcular Peajes
        </button>
      </div>

      <div class="bg-surface border border-outline-variant overflow-hidden rounded overflow-x-auto">
        <table class="w-full zebra-table border-collapse">
          <thead>
            <tr class="bg-surface-container-high text-left border-b border-outline-variant">
              <th class="p-md font-label-caps text-label-caps text-secondary uppercase">Ruta</th>
              <th class="p-md font-label-caps text-label-caps text-secondary uppercase">Origen</th>
              <th class="p-md font-label-caps text-label-caps text-secondary uppercase">Destino</th>
              <th class="p-md font-label-caps text-label-caps text-secondary uppercase">Tipo de Camión</th>
              <th class="p-md font-label-caps text-label-caps text-secondary uppercase text-right">Peaje Ida</th>
              <th class="p-md font-label-caps text-label-caps text-secondary uppercase text-right">Peaje Vuelta</th>
              <th class="p-md font-label-caps text-label-caps text-secondary uppercase text-right">KM Ida</th>
              <th class="p-md font-label-caps text-label-caps text-secondary uppercase text-right">KM Vuelta</th>
              <th class="p-md font-label-caps text-label-caps text-secondary uppercase text-center">Estado</th>
              <th class="p-md font-label-caps text-label-caps text-secondary uppercase text-center">Acciones</th>
            </tr>
          </thead>
          <tbody class="font-body-md text-body-md">
            ${displayRows.length === 0 ? `<tr><td colspan="10" class="p-md text-center text-secondary">No hay rutas que coincidan con los filtros.</td></tr>` :
              displayRows.map(({ ruta, ejes, toll }) => {
                const origenNombre = getCentreName(db, ruta.origenId);
                let estado;
                if (!toll || !toll.calculado_en) {
                  estado = `<span class="inline-flex items-center px-2 py-1 rounded bg-secondary-container text-on-secondary-container font-label-caps text-[10px]">SIN CALCULAR</span>`;
                } else if (toll.needs_review) {
                  estado = `<span class="inline-flex items-center gap-1 px-2 py-1 rounded bg-red-100 text-red-800 font-label-caps text-[10px]"><span class="material-symbols-outlined text-[14px]">warning</span> REVISIÓN</span>`;
                } else {
                  estado = `<span class="inline-flex items-center px-2 py-1 rounded bg-green-100 text-green-800 font-label-caps text-[10px]">OK</span>`;
                }
                const trCls = toll && toll.needs_review ? 'border-b border-outline-variant bg-red-50' : 'border-b border-outline-variant';
                return `<tr class="${trCls}">
                  <td class="p-md font-bold">${escapeHtml(ruta.codigo || '')}</td>
                  <td class="p-md">${escapeHtml(origenNombre || '')}</td>
                  <td class="p-md">${escapeHtml(ruta.destino || '')}</td>
                  <td class="p-md">${EJES_LABELS[ejes]}</td>
                  <td class="p-md w-32">${tollNumInput(ruta.id, ejes, 'peaje_ida', toll ? toll.peaje_ida : 0)}</td>
                  <td class="p-md w-32">${tollNumInput(ruta.id, ejes, 'peaje_vuelta', toll ? toll.peaje_vuelta : 0)}</td>
                  <td class="p-md text-right font-data-mono text-data-mono">${toll && toll.km_ida != null ? toll.km_ida : '—'}</td>
                  <td class="p-md text-right font-data-mono text-data-mono">${toll && toll.km_vuelta != null ? toll.km_vuelta : '—'}</td>
                  <td class="p-md text-center">${estado}</td>
                  <td class="p-md text-center">
                    <button class="pj-calc-row text-secondary hover:text-primary" data-calc-route="${escapeHtml(ruta.id)}" title="Calcular peaje de esta ruta">
                      <span class="material-symbols-outlined text-[18px]">calculate</span>
                    </button>
                  </td>
                </tr>`;
              }).join('')}
          </tbody>
        </table>
      </div>
      ${totalRows > PJ_DISPLAY_LIMIT ? `<p class="text-[11px] text-secondary mt-sm">Mostrando ${PJ_DISPLAY_LIMIT} de ${totalRows} resultados. Use los filtros para acotar la búsqueda.</p>` : ''}
    </div>
  `;

  content.querySelectorAll('[data-toll-route]').forEach(inp => {
    inp.addEventListener('change', (e) => {
      const routeId = e.target.dataset.tollRoute;
      const ejes = Number(e.target.dataset.tollEjes);
      const field = e.target.dataset.tollField;
      const val = e.target.value === '' ? 0 : Number(e.target.value);
      let row = pjGetTollRow(db, routeId, ejes);
      if (!row) {
        row = { id: `tj_${routeId}_${ejes}`, route_id: routeId, ejes, peaje_ida: 0, peaje_vuelta: 0, needs_review: false, calculado_en: new Date().toISOString() };
        db.routeTolls = db.routeTolls || [];
        db.routeTolls.push(row);
      }
      row[field] = val;
      row.needs_review = false; // edición manual = revisado
      row.updated_at = new Date().toISOString();
      saveDatabase(db);
    });
  });

  document.getElementById('pj-f-texto').addEventListener('change', (e) => { pjFiltroTexto = e.target.value; renderPeajesAuto(content, db, cfg); });
  document.getElementById('pj-f-comuna').addEventListener('change', (e) => { pjFiltroComuna = e.target.value; renderPeajesAuto(content, db, cfg); });
  document.getElementById('pj-f-origen').addEventListener('change', (e) => { pjFiltroCentro = e.target.value; renderPeajesAuto(content, db, cfg); });
  document.getElementById('pj-f-clasif').addEventListener('change', (e) => { pjFiltroClasificacion = e.target.value; renderPeajesAuto(content, db, cfg); });
  document.getElementById('pj-f-pend').addEventListener('change', (e) => { pjFiltroPendientes = e.target.checked; renderPeajesAuto(content, db, cfg); });
  document.getElementById('pj-kpi-pendientes').addEventListener('click', () => { pjFiltroPendientes = true; pjFiltroTexto = ''; pjFiltroComuna = ''; pjFiltroCentro = ''; pjFiltroClasificacion = ''; renderPeajesAuto(content, db, cfg); });
  document.getElementById('pj-kpi-revision').addEventListener('click', () => { pjFiltroPendientes = true; pjFiltroTexto = ''; pjFiltroComuna = ''; pjFiltroCentro = ''; pjFiltroClasificacion = ''; renderPeajesAuto(content, db, cfg); });
  document.getElementById('pj-export').addEventListener('click', () => exportPeajesCSV(db, rows));
  document.getElementById('pj-carga-comuna').addEventListener('click', () => abrirModalCargaPeajesComuna(content, db, cfg));
  document.getElementById('pj-calcular').addEventListener('click', () => {
    const rutasUnicas = [...new Set(rows.map(r => r.ruta))];
    calcularPeajes(content, db, cfg, rutasUnicas);
  });
  content.querySelectorAll('[data-calc-route]').forEach(btn => {
    btn.addEventListener('click', () => {
      const ruta = routes.find(r => r.id === btn.dataset.calcRoute);
      if (ruta) calcularPeajes(content, db, cfg, [ruta]);
    });
  });
}

function exportPeajesCSV(db, rows) {
  const headers = ['RUTA', 'ORIGEN', 'DESTINO', 'TIPO_DE_CAMION', 'PEAJE_IDA', 'PEAJE_VUELTA'];
  const data = rows.map(({ ruta, ejes, toll }) => [
    ruta.codigo,
    getCentreName(db, ruta.origenId) || '',
    ruta.destino || '',
    EJES_LABELS[ejes],
    toll ? Math.round(toll.peaje_ida || 0) : 0,
    toll ? Math.round(toll.peaje_vuelta || 0) : 0
  ]);
  downloadFile(`peajes_rutas_${Date.now()}.csv`, toCSV(headers, data));
  showAlert('Archivo CSV de peajes exportado');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Invoca la Edge Function 'route-tolls' (proxy seguro hacia Google Routes API)
async function callRouteTolls(origin, destination) {
  const { data, error } = await supabase.functions.invoke('route-tolls', { body: { origin, destination } });
  if (error) throw error;
  if (data && data.error) throw new Error(data.error);
  return data;
}

// Crea o actualiza la fila route_tolls para (routeId, ejes) con los resultados
// de ida/vuelta. Si opts.error, marca la fila para revisión sin tocar valores.
function pjUpsertToll(db, routeId, ejes, ida, vuelta, opts = {}) {
  db.routeTolls = db.routeTolls || [];
  let row = db.routeTolls.find(rt => rt.route_id === routeId && Number(rt.ejes) === ejes);
  if (!row) {
    row = { id: `tj_${routeId}_${ejes}`, route_id: routeId, ejes, peaje_ida: 0, peaje_vuelta: 0, needs_review: false };
    db.routeTolls.push(row);
  }
  const now = new Date().toISOString();
  if (opts.error) {
    row.needs_review = true;
    row.calculado_en = now;
    row.updated_at = now;
    return row;
  }
  row.peaje_ida = ida ? Math.round(ida.tollCLP || 0) : 0;
  row.peaje_vuelta = vuelta ? Math.round(vuelta.tollCLP || 0) : 0;
  row.km_ida = ida && ida.distanceMeters != null ? Math.round(ida.distanceMeters / 100) / 10 : null;
  row.km_vuelta = vuelta && vuelta.distanceMeters != null ? Math.round(vuelta.distanceMeters / 100) / 10 : null;
  const idaReview = !ida || (ida.hasToll && !ida.tollCLP);
  const vueltaReview = !vuelta || (vuelta.hasToll && !vuelta.tollCLP);
  row.needs_review = !!(idaReview || vueltaReview);
  row.calculado_en = now;
  row.updated_at = now;
  return row;
}

// Crea o actualiza la fila route_tolls para (routeId, ejes) con valores
// fijados manualmente (carga masiva por comuna). Marca como revisado.
function pjSetTollManual(db, routeId, ejes, peajeIda, peajeVuelta) {
  db.routeTolls = db.routeTolls || [];
  let row = db.routeTolls.find(rt => rt.route_id === routeId && Number(rt.ejes) === ejes);
  if (!row) {
    row = { id: `tj_${routeId}_${ejes}`, route_id: routeId, ejes, peaje_ida: 0, peaje_vuelta: 0, needs_review: false };
    db.routeTolls.push(row);
  }
  const now = new Date().toISOString();
  row.peaje_ida = Math.round(peajeIda || 0);
  row.peaje_vuelta = Math.round(peajeVuelta || 0);
  row.needs_review = false;
  row.calculado_en = now;
  row.updated_at = now;
  return row;
}

// Dado un centro de origen y una zona de transporte (comuna), retorna las
// rutas activas afectadas: las que pertenecen directamente a esa zona, más
// las rutas de tipo "Sector" que correspondan a la misma comuna (heredan el
// valor del peaje de la comuna).
function findRutasParaComuna(db, centroId, zonaId) {
  const zona = (db.transportZones || []).find(z => z.zona === zonaId);
  const routes = db.routes || [];

  const directas = routes.filter(r => r.activo && r.origenId === centroId && r.id_zona_transporte === zonaId);

  let sectores = [];
  if (zona && zona.comuna) {
    const zonasSector = (db.transportZones || [])
      .filter(z => z.tipo === 'Sector' && z.comuna === zona.comuna && z.zona !== zonaId)
      .map(z => z.zona);
    if (zonasSector.length) {
      sectores = routes.filter(r => r.activo && r.origenId === centroId && zonasSector.includes(r.id_zona_transporte));
    }
  }

  const all = [...directas, ...sectores];
  const seen = new Set();
  return all.filter(r => { if (seen.has(r.id)) return false; seen.add(r.id); return true; });
}

// Interpreta una fila del CSV de carga masiva de peajes por comuna.
function parsePeajesComunaRow(row) {
  const centroId = (getField(row, 'id_centro_origen', 'centro_origen', 'id_centro', 'centro') || '').toString().trim();
  const zonaId = (getField(row, 'id_zona_transporte', 'zona_transporte', 'id_zona', 'zona') || '').toString().trim();
  const ejes = Number((getField(row, 'eje', 'ejes') || '').toString().trim());
  const peajeIda = Number(getField(row, 'peaje_ida', 'valor_peaje_ida', 'peajeida')) || 0;
  const peajeVuelta = Number(getField(row, 'peaje_vuelta', 'valor_peaje_vuelta', 'peajevuelta')) || 0;
  return { centroId, zonaId, ejes, peajeIda, peajeVuelta };
}

// Genera y descarga una plantilla CSV con una fila por cada combinación
// (Centro Origen, Zona de Transporte = Comuna) × eje, lista para completar
// con los valores de peaje y volver a subir.
function descargarPlantillaPeajesComuna(db) {
  const headers = ['id_centro_origen', 'centro_origen', 'id_zona_transporte', 'comuna', 'eje', 'peaje_ida', 'peaje_vuelta'];
  const combos = new Map();
  (db.routes || []).filter(r => r.activo && r.origenId && r.id_zona_transporte).forEach(r => {
    const zona = (db.transportZones || []).find(z => z.zona === r.id_zona_transporte);
    if (zona && zona.tipo === 'Sector') return; // las rutas Sector heredan el valor de su comuna
    const key = `${r.origenId}__${r.id_zona_transporte}`;
    if (!combos.has(key)) {
      combos.set(key, { centroId: r.origenId, zonaId: r.id_zona_transporte, comuna: r.comuna || (zona ? zona.comuna : '') || '' });
    }
  });
  const data = [];
  combos.forEach(c => {
    [2, 3].forEach(ejes => {
      data.push([c.centroId, getCentreName(db, c.centroId) || '', c.zonaId, c.comuna, ejes, 0, 0]);
    });
  });
  downloadFile(`plantilla_peajes_por_comuna_${Date.now()}.csv`, toCSV(headers, data));
  showAlert('Plantilla de carga masiva de peajes por comuna descargada');
}

// Modal de Carga Masiva de Peajes por Comuna: permite subir un CSV con
// id_centro_origen, id_zona_transporte, eje, peaje_ida y peaje_vuelta. El
// valor se aplica a todas las rutas activas de ese centro+comuna, incluyendo
// las rutas "Sector" que pertenezcan a la misma comuna.
function abrirModalCargaPeajesComuna(content, db, cfg) {
  const el = document.createElement('div');
  el.className = 'fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-md';
  el.innerHTML = `
    <div class="bg-white rounded-lg shadow-xl p-lg w-full max-w-3xl max-h-[90vh] overflow-y-auto">
      <div class="flex items-center gap-sm mb-md">
        <span class="material-symbols-outlined text-primary">upload_file</span>
        <h3 class="font-headline-sm text-headline-sm font-bold text-on-surface">Carga Masiva de Peajes por Comuna</h3>
      </div>
      <p class="text-[12px] text-secondary mb-sm">
        Suba un CSV con el valor de peaje por <b>Centro de Origen + Zona de Transporte (comuna)</b> y tipo de eje.
        El valor se aplicará a todas las rutas activas de ese centro y comuna, incluyendo las rutas de tipo
        <b>Sector</b> que pertenezcan a la misma comuna.
      </p>
      <p class="text-[12px] text-secondary mb-md">
        Columnas requeridas: <code>id_centro_origen</code>, <code>id_zona_transporte</code>, <code>eje</code> (2 o 3),
        <code>peaje_ida</code>, <code>peaje_vuelta</code>.
      </p>
      <div class="flex flex-wrap gap-sm mb-md">
        <button id="pjc-plantilla" class="bg-surface-container-high hover:bg-surface-container text-on-surface font-bold px-md py-sm rounded flex items-center gap-xs text-[12px] uppercase">
          <span class="material-symbols-outlined text-[18px]">download</span> Descargar Plantilla
        </button>
        <label class="bg-primary hover:bg-[#930007] text-white font-bold px-md py-sm rounded flex items-center gap-xs text-[12px] uppercase cursor-pointer">
          <span class="material-symbols-outlined text-[18px]">attach_file</span> Elegir Archivo CSV
          <input id="pjc-file" type="file" accept=".csv" class="hidden">
        </label>
      </div>
      <div id="pjc-preview"></div>
      <div class="flex justify-end gap-sm mt-md">
        <button id="pjc-cancel" class="bg-surface-container-high hover:bg-surface-container text-on-surface font-bold px-md py-sm rounded text-[12px] uppercase">Cerrar</button>
        <button id="pjc-importar" class="bg-primary hover:bg-[#930007] text-white font-bold px-md py-sm rounded text-[12px] uppercase opacity-50 cursor-not-allowed" disabled>Importar</button>
      </div>
    </div>`;
  document.body.appendChild(el);

  let parsedRows = [];

  el.querySelector('#pjc-cancel').addEventListener('click', () => el.remove());
  el.querySelector('#pjc-plantilla').addEventListener('click', () => descargarPlantillaPeajesComuna(db));

  function renderPreview() {
    const validRows = parsedRows.filter(r => !r.error);
    const totalRutas = validRows.reduce((acc, r) => acc + r.rutas.length, 0);
    el.querySelector('#pjc-preview').innerHTML = `
      <div class="border border-outline-variant rounded overflow-hidden overflow-x-auto max-h-64">
        <table class="w-full text-[12px] zebra-table border-collapse">
          <thead>
            <tr class="bg-surface-container-high text-left">
              <th class="p-sm">Centro</th>
              <th class="p-sm">Zona / Comuna</th>
              <th class="p-sm text-center">Eje</th>
              <th class="p-sm text-right">Peaje Ida</th>
              <th class="p-sm text-right">Peaje Vuelta</th>
              <th class="p-sm text-center">Rutas Afectadas</th>
              <th class="p-sm">Estado</th>
            </tr>
          </thead>
          <tbody>
            ${parsedRows.map(r => `<tr class="${r.error ? 'bg-red-50' : ''}">
              <td class="p-sm">${escapeHtml(r.centroNombre)}</td>
              <td class="p-sm">${escapeHtml(r.zonaNombre)} <span class="text-secondary">(${escapeHtml(r.zonaId)})</span></td>
              <td class="p-sm text-center">${r.ejes || '—'}</td>
              <td class="p-sm text-right">${formatCLP(r.peajeIda)}</td>
              <td class="p-sm text-right">${formatCLP(r.peajeVuelta)}</td>
              <td class="p-sm text-center">${r.error ? '—' : r.rutas.length}</td>
              <td class="p-sm">${r.error ? `<span class="text-red-700">${escapeHtml(r.error)}</span>` : '<span class="text-green-700">OK</span>'}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <p class="text-[11px] text-secondary mt-sm">${validRows.length} de ${parsedRows.length} fila(s) válida(s) · ${totalRutas} registro(s) (ruta × eje) serán actualizados.</p>
    `;
    const btn = el.querySelector('#pjc-importar');
    if (validRows.length > 0) {
      btn.disabled = false;
      btn.classList.remove('opacity-50', 'cursor-not-allowed');
    } else {
      btn.disabled = true;
      btn.classList.add('opacity-50', 'cursor-not-allowed');
    }
  }

  el.querySelector('#pjc-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const buffer = ev.target.result;
      let text = new TextDecoder('utf-8').decode(buffer);
      if (text.includes('�')) text = new TextDecoder('windows-1252').decode(buffer);
      const csvRows = parseCSV(text);
      parsedRows = csvRows.map(row => {
        const { centroId, zonaId, ejes, peajeIda, peajeVuelta } = parsePeajesComunaRow(row);
        const centro = (db.logisticsCentres || []).find(c => c.id === centroId);
        const zona = (db.transportZones || []).find(z => z.zona === zonaId);
        let error = '';
        if (!centroId || !centro) error = 'Centro origen no encontrado';
        else if (!zonaId || !zona) error = 'Zona de transporte no encontrada';
        else if (ejes !== 2 && ejes !== 3) error = 'Eje inválido (debe ser 2 o 3)';
        const rutas = !error ? findRutasParaComuna(db, centroId, zonaId) : [];
        if (!error && rutas.length === 0) error = 'Sin rutas activas para este centro y comuna';
        return {
          centroId, zonaId, ejes, peajeIda, peajeVuelta, rutas, error,
          centroNombre: centro ? centro.nombre : (centroId || '—'),
          zonaNombre: zona ? (zona.comuna || zona.denominacion || zonaId) : (zonaId || '—')
        };
      });
      renderPreview();
    };
    reader.readAsArrayBuffer(file);
  });

  el.querySelector('#pjc-importar').addEventListener('click', () => {
    const validRows = parsedRows.filter(r => !r.error);
    if (validRows.length === 0) return;
    let totalRutas = 0;
    validRows.forEach(r => {
      r.rutas.forEach(ruta => {
        pjSetTollManual(db, ruta.id, r.ejes, r.peajeIda, r.peajeVuelta);
        totalRutas++;
      });
    });
    saveDatabase(db);
    el.remove();
    showAlert(`Carga masiva de peajes por comuna aplicada: ${totalRutas} registro(s) actualizado(s) en ${validRows.length} fila(s).`);
    renderPeajesAuto(content, db, cfg);
  });
}

// Modal de progreso para el cálculo masivo de peajes
function createProgressModal(total) {
  const el = document.createElement('div');
  el.className = 'fixed inset-0 bg-black/50 z-50 flex items-center justify-center';
  el.innerHTML = `
    <div class="bg-white rounded-lg shadow-xl p-lg w-full max-w-md">
      <div class="flex items-center gap-sm mb-md">
        <span class="material-symbols-outlined text-primary">toll</span>
        <h3 class="font-headline-sm text-headline-sm font-bold text-on-surface">Calculando Peajes…</h3>
      </div>
      <p id="ptj-status" class="text-[12px] text-secondary mb-sm break-all">Iniciando…</p>
      <div class="w-full bg-surface-container-high rounded-full h-3 overflow-hidden mb-sm">
        <div id="ptj-bar" class="bg-primary h-3 rounded-full transition-all" style="width:0%"></div>
      </div>
      <p id="ptj-count" class="text-[11px] text-secondary text-right mb-md">0 / ${total}</p>
      <button id="ptj-cancel" class="w-full bg-surface-container-high hover:bg-surface-container text-on-surface font-bold px-md py-sm rounded text-[12px] uppercase">Cancelar</button>
    </div>`;
  document.body.appendChild(el);
  return {
    cancelBtn: el.querySelector('#ptj-cancel'),
    update(i, total, label) {
      el.querySelector('#ptj-status').textContent = label;
      el.querySelector('#ptj-count').textContent = `${i} / ${total}`;
      el.querySelector('#ptj-bar').style.width = `${total > 0 ? Math.round((i / total) * 100) : 0}%`;
    },
    close() { el.remove(); }
  };
}

// Orquesta el cálculo (a demanda) de peajes para las rutas indicadas: para
// cada ruta consulta la Edge Function 'route-tolls' Ida y Vuelta (0.5s de
// espera entre consultas) y guarda el resultado para 2 y 3 ejes.
async function calcularPeajes(content, db, cfg, rutas) {
  if (!rutas || rutas.length === 0) {
    showAlert('No hay rutas para calcular con los filtros actuales', 'error');
    return;
  }
  const targets = rutas.filter(r => r.lat != null && r.lon != null);
  const sinCoords = rutas.length - targets.length;
  const estMin = Math.max(1, Math.ceil((targets.length * 2 * 0.5) / 60));
  const aviso = sinCoords > 0 ? `\n${sinCoords} ruta(s) sin coordenadas quedarán marcadas para revisión.` : '';
  if (!confirm(`Se calcularán peajes para ${targets.length} ruta(s) (Ida + Vuelta, 2 y 3 ejes).\nTiempo estimado: ~${estMin} min.${aviso}\n¿Continuar?`)) {
    return;
  }

  // Rutas sin coordenadas: marcar directamente para revisión
  rutas.filter(r => r.lat == null || r.lon == null).forEach(ruta => {
    [2, 3].forEach(ejes => pjUpsertToll(db, ruta.id, ejes, null, null, { error: true }));
  });

  const modal = createProgressModal(targets.length);
  let cancelado = false;
  modal.cancelBtn.addEventListener('click', () => { cancelado = true; });

  for (let i = 0; i < targets.length; i++) {
    if (cancelado) break;
    const ruta = targets[i];
    const cd = (db.logisticsCentres || []).find(c => c.id === ruta.origenId);
    modal.update(i, targets.length, `${ruta.codigo} — ${ruta.destino || ''}`);

    if (!cd || cd.lat == null || cd.lon == null) {
      [2, 3].forEach(ejes => pjUpsertToll(db, ruta.id, ejes, null, null, { error: true }));
      continue;
    }

    const origenPt = { lat: cd.lat, lng: cd.lon };
    const destinoPt = { lat: ruta.lat, lng: ruta.lon };

    let ida = null, vuelta = null, errored = false;
    try {
      ida = await callRouteTolls(origenPt, destinoPt);
      await sleep(500);
      vuelta = await callRouteTolls(destinoPt, origenPt);
      await sleep(500);
    } catch (err) {
      console.error('Error calculando peajes para', ruta.codigo, err);
      errored = true;
    }

    [2, 3].forEach(ejes => pjUpsertToll(db, ruta.id, ejes, ida, vuelta, { error: errored }));

    if ((i + 1) % 10 === 0) saveDatabase(db);
  }

  modal.update(targets.length, targets.length, cancelado ? 'Cancelado' : 'Finalizado');
  saveDatabase(db);
  modal.close();
  showAlert(cancelado ? 'Cálculo de peajes cancelado (avance guardado)' : 'Cálculo de peajes finalizado');
  renderPeajesAuto(content, db, cfg);
}

// ---------- Registro Manual de Plazas de Peaje (legado / respaldo) ----------
function renderPeajesManual(content, db, cfg) {
  const routes = db.routes;

  content.innerHTML = `
    <div class="bg-surface-container-lowest border border-outline-variant p-lg shadow-sm mb-lg">
      <div class="flex items-center gap-sm mb-md border-b border-outline-variant pb-sm">
        <span class="material-symbols-outlined text-primary">edit_road</span>
        <h2 class="font-headline-sm text-headline-sm font-bold text-on-surface">Registro Manual de Plazas de Peaje (Respaldo)</h2>
      </div>
      <p class="text-[12px] text-secondary mb-md">Este registro detallado por plaza de peaje se usa como respaldo del Motor ZCAP solo cuando una ruta no tiene un cálculo automático (sección anterior). Los cobros aquí son simétricos (Ida y Vuelta procesan el mismo valor). Mapeo fijo de ejes: 5.000 y 10.000 kg = 2 ejes · 15.000 y 28.000 kg = 3 ejes.</p>

      <form id="pj-form" class="grid grid-cols-1 md:grid-cols-6 gap-sm items-end mb-md">
        <div class="md:col-span-2 space-y-xs">
          <label class="font-label-caps text-label-caps text-secondary block">RUTA</label>
          <select id="pj-ruta" class="w-full border border-[#CED4DA] p-sm font-body-md text-body-md bg-white" required>
            ${routes.map(r => `<option value="${r.id}">${r.codigo} — ${r.destino}</option>`).join('')}
          </select>
        </div>
        <div class="space-y-xs">
          <label class="font-label-caps text-label-caps text-secondary block">EJES</label>
          <select id="pj-ejes" class="w-full border border-[#CED4DA] p-sm font-body-md text-body-md bg-white">
            <option value="2">2 Ejes</option>
            <option value="3">3 Ejes</option>
          </select>
        </div>
        <div class="space-y-xs">
          <label class="font-label-caps text-label-caps text-secondary block">CONCESIONARIA</label>
          <input id="pj-conc" type="text" class="w-full border border-[#CED4DA] p-sm font-body-md text-body-md bg-white" placeholder="Ej: Autopista Central" required>
        </div>
        <div class="space-y-xs">
          <label class="font-label-caps text-label-caps text-secondary block">PLAZA DE PEAJE</label>
          <input id="pj-plaza" type="text" class="w-full border border-[#CED4DA] p-sm font-body-md text-body-md bg-white" placeholder="Ej: Pórtico Lampa" required>
        </div>
        <div class="space-y-xs">
          <label class="font-label-caps text-label-caps text-secondary block">VALOR PEAJE (CLP)</label>
          <div class="flex gap-xs">
            <input id="pj-valor" type="number" min="0" class="w-full border border-[#CED4DA] p-sm font-body-md text-body-md bg-white" placeholder="0" required>
            <button type="submit" class="bg-primary hover:bg-[#930007] text-white font-bold px-md py-sm rounded shrink-0">
              <span class="material-symbols-outlined text-[18px]">add</span>
            </button>
          </div>
        </div>
      </form>

      <div class="flex items-center gap-md bg-surface-container-low p-md rounded mb-md">
        <span class="material-symbols-outlined text-secondary">upload_file</span>
        <div class="flex-1">
          <p class="font-body-md text-body-md font-bold text-on-surface">Carga masiva CSV</p>
          <p class="text-[11px] text-secondary">Columnas: Centro_Origen, Comuna_Destino, Id_Ruta, Ejes, Concesionaria, Plaza_Peaje, Valor_Peaje</p>
        </div>
        <input type="file" id="pj-csv" accept=".csv" class="text-[12px]">
      </div>
    </div>

    <div class="bg-surface border border-outline-variant overflow-hidden rounded">
      <table class="w-full zebra-table border-collapse">
        <thead>
          <tr class="bg-surface-container-high text-left border-b border-outline-variant">
            <th class="p-md font-label-caps text-label-caps text-secondary uppercase">Ruta</th>
            <th class="p-md font-label-caps text-label-caps text-secondary uppercase">Ejes</th>
            <th class="p-md font-label-caps text-label-caps text-secondary uppercase">Concesionaria</th>
            <th class="p-md font-label-caps text-label-caps text-secondary uppercase">Plaza de Peaje</th>
            <th class="p-md font-label-caps text-label-caps text-secondary uppercase text-right">Valor Ida</th>
            <th class="p-md font-label-caps text-label-caps text-secondary uppercase text-right">Valor Vuelta</th>
            <th class="p-md font-label-caps text-label-caps text-secondary uppercase text-center">Acciones</th>
          </tr>
        </thead>
        <tbody class="font-body-md text-body-md">
          ${(cfg.peajes || []).length === 0 ? `<tr><td colspan="7" class="p-md text-center text-secondary">No hay peajes registrados.</td></tr>` :
            cfg.peajes.map(p => {
              const r = routes.find(x => x.id === p.rutaId);
              return `<tr class="border-b border-outline-variant">
                <td class="p-md">${r ? `${r.codigo} — ${r.destino}` : '(ruta eliminada)'}</td>
                <td class="p-md font-data-mono text-data-mono">${p.ejes}</td>
                <td class="p-md">${p.concesionaria}</td>
                <td class="p-md">${p.plazaPeaje}</td>
                <td class="p-md text-right font-data-mono text-data-mono">${formatCLP(p.valorPeaje)}</td>
                <td class="p-md text-right font-data-mono text-data-mono">${formatCLP(p.valorPeaje)}</td>
                <td class="p-md text-center">
                  <button class="pj-del text-secondary hover:text-primary" data-id="${p.id}" title="Eliminar">
                    <span class="material-symbols-outlined text-[18px]">delete</span>
                  </button>
                </td>
              </tr>`;
            }).join('')}
        </tbody>
      </table>
    </div>
  `;

  document.getElementById('pj-form').addEventListener('submit', (e) => {
    e.preventDefault();
    cfg.peajes = cfg.peajes || [];
    cfg.peajes.push({
      id: 'pj' + Date.now(),
      rutaId: document.getElementById('pj-ruta').value,
      ejes: Number(document.getElementById('pj-ejes').value),
      concesionaria: document.getElementById('pj-conc').value.trim(),
      plazaPeaje: document.getElementById('pj-plaza').value.trim(),
      valorPeaje: Number(document.getElementById('pj-valor').value) || 0
    });
    saveDatabase(db);
    showAlert('Peaje agregado correctamente');
    renderPeajesManual(content, db, cfg);
  });

  document.querySelectorAll('.pj-del').forEach(btn => {
    btn.addEventListener('click', () => {
      cfg.peajes = cfg.peajes.filter(p => p.id !== btn.dataset.id);
      saveDatabase(db);
      renderPeajesManual(content, db, cfg);
    });
  });

  document.getElementById('pj-csv').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    readCSVFile(file, (rows) => {
      let count = 0;
      cfg.peajes = cfg.peajes || [];
      rows.forEach(row => {
        const idRuta = (row.Id_Ruta || '').trim();
        const route = db.routes.find(r => r.codigo.toLowerCase() === idRuta.toLowerCase() || r.id === idRuta);
        if (!route) return;
        cfg.peajes.push({
          id: 'pj' + Date.now() + Math.random().toString(16).slice(2),
          rutaId: route.id,
          ejes: Number(row.Ejes) || 2,
          concesionaria: row.Concesionaria || '',
          plazaPeaje: row.Plaza_Peaje || '',
          valorPeaje: Number(row.Valor_Peaje) || 0
        });
        count++;
      });
      saveDatabase(db);
      showAlert(`${count} peajes cargados desde CSV`);
      renderPeajesManual(content, db, cfg);
    });
  });
}

// ============================================================
// SUB-MÓDULO: TARIFAS DE TRANSPORTE POR CENTRO Y TIPO DE CAMIÓN
// ============================================================
function truckNumInput(id, field, value) {
  return `<input type="number" step="any" class="${inputCls}" data-truck-id="${id}" data-truck-field="${field}" value="${value ?? 0}">`;
}

function renderTarifasCamion(content, db, cfg) {
  const centres = db.logisticsCentres;

  content.innerHTML = `
    <div class="bg-surface-container-lowest border border-outline-variant p-lg shadow-sm">
      <div class="flex items-center gap-sm mb-md border-b border-outline-variant pb-sm">
        <span class="material-symbols-outlined text-primary">local_shipping</span>
        <h2 class="font-headline-sm text-headline-sm font-bold text-on-surface">Tarifas de Transporte por Centro y Tipo de Camión</h2>
      </div>
      <p class="text-[12px] text-secondary mb-md">Tarifa Base y Tarifa/KM alimentan el Cotizador de Tarifas (servicio Exclusivo y Consolidado). Km Base y Costo Base son el tramo de referencia usado para fijar dichas tarifas. Use "Aplicar Motor ZCAP" para recalcular Tarifa Base y Tarifa/KM desde el costeo actuarial (promedio de rutas activas del centro, con margen de ganancia).</p>

      ${centres.map(cd => {
        const rows = (db.truckTypes || []).filter(t => t.Id_centro === cd.id);
        return `
        <div class="mb-lg">
          <div class="flex items-center justify-between mb-xs">
            <h3 class="font-body-lg text-body-lg font-bold text-on-surface">${cd.nombre} <span class="text-secondary font-data-mono text-[12px]">(${cd.id})</span></h3>
            ${rows.length > 0 ? `<button class="tt-apply-zcap bg-primary hover:bg-[#930007] text-white font-bold px-md py-xs rounded flex items-center gap-xs text-[11px] uppercase" data-centro="${cd.id}">
              <span class="material-symbols-outlined text-[16px]">calculate</span> Aplicar Motor ZCAP
            </button>` : ''}
          </div>
          <div class="bg-surface border border-outline-variant overflow-hidden rounded">
            <table class="w-full zebra-table border-collapse">
              <thead>
                <tr class="bg-surface-container-high text-left border-b border-outline-variant">
                  <th class="p-md font-label-caps text-label-caps text-secondary uppercase">Tipo de Camión</th>
                  <th class="p-md font-label-caps text-label-caps text-secondary uppercase">Capacidad</th>
                  <th class="p-md font-label-caps text-label-caps text-secondary uppercase text-right">Km Base</th>
                  <th class="p-md font-label-caps text-label-caps text-secondary uppercase text-right">Costo Base</th>
                  <th class="p-md font-label-caps text-label-caps text-secondary uppercase text-right">Tarifa Base</th>
                  <th class="p-md font-label-caps text-label-caps text-secondary uppercase text-right">Tarifa / KM</th>
                </tr>
              </thead>
              <tbody class="font-body-md text-body-md">
                ${rows.length === 0 ? `<tr><td colspan="6" class="p-md text-center text-secondary">Sin tarifas configuradas para este centro.</td></tr>` :
                  rows.map(t => `
                  <tr class="border-b border-outline-variant">
                    <td class="p-md font-bold">${t.type}</td>
                    <td class="p-md">${t.capacityTons}</td>
                    <td class="p-md w-28">${truckNumInput(t.id, 'Kmbase', t.Kmbase)}</td>
                    <td class="p-md w-32">${truckNumInput(t.id, 'baseKM', t.baseKM)}</td>
                    <td class="p-md w-32">${truckNumInput(t.id, 'baseRate', t.baseRate)}</td>
                    <td class="p-md w-28">${truckNumInput(t.id, 'ratePerKm', t.ratePerKm)}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>`;
      }).join('')}
    </div>
  `;

  content.querySelectorAll('[data-truck-id]').forEach(inp => {
    inp.addEventListener('change', (e) => {
      const id = e.target.dataset.truckId;
      const field = e.target.dataset.truckField;
      const val = e.target.value === '' ? 0 : Number(e.target.value);
      const row = (db.truckTypes || []).find(t => t.id === id);
      if (row) row[field] = val;
      saveDatabase(db);
    });
  });

  // ---------- Aplicar Motor ZCAP: recalcula Tarifa Base y Tarifa/KM ----------
  // desde el costeo actuarial (promedio de rutas activas del centro por tipo de
  // camión, costo/km final con margen de ganancia). Km Base define el tramo de
  // referencia usado para derivar la Tarifa Base (Costo Base = Tarifa Base).
  content.querySelectorAll('.tt-apply-zcap').forEach(btn => {
    btn.addEventListener('click', () => {
      const centroId = btn.dataset.centro;
      const matriz = calcularMatrizCostos(db, cfg).filter(m => m.centroId === centroId);
      const rows = (db.truckTypes || []).filter(t => t.Id_centro === centroId);
      const margenPct = Number(cfg.variables.margenGanancia) || 0;

      let actualizados = 0;
      rows.forEach(t => {
        const items = matriz.filter(m => m.capKg === truckCapKg(t.type));
        if (items.length === 0) return;
        const avgCostoKmFinal = items.reduce((s, m) => s + m.item11_costoKmFinal, 0) / items.length;
        const ratePerKmConMargen = avgCostoKmFinal * (1 + margenPct / 100);
        const kmBase = Number(t.Kmbase) || 0;
        t.ratePerKm = Math.round(ratePerKmConMargen);
        t.baseRate = Math.round(ratePerKmConMargen * kmBase);
        t.baseKM = t.baseRate;
        actualizados++;
      });

      if (actualizados === 0) {
        showAlert('No hay rutas activas para este centro; no se pudo calcular el Motor ZCAP.', 'error');
        return;
      }
      saveDatabase(db);
      showAlert(`Tarifas actualizadas desde el Motor ZCAP para ${actualizados} tipo(s) de camión`);
      renderTarifasCamion(content, db, cfg);
    });
  });
}

// ============================================================
// SUB-MÓDULO 2: COMBUSTIBLES Y RENDIMIENTOS
// ============================================================
function renderCombustibles(content, db, cfg) {
  const centres = db.logisticsCentres;
  const hoy = new Date();

  content.innerHTML = `
    <div class="bg-surface-container-lowest border border-outline-variant p-lg shadow-sm mb-lg">
      <div class="flex items-center gap-sm mb-md border-b border-outline-variant pb-sm">
        <span class="material-symbols-outlined text-primary">local_gas_station</span>
        <h2 class="font-headline-sm text-headline-sm font-bold text-on-surface">Precio de Combustible por Centro Logístico</h2>
      </div>
      <p class="text-[12px] text-secondary mb-md">Alerta crítica si un centro pasa más de 3 semanas sin confirmar/actualizar su precio.</p>
      <div class="bg-surface border border-outline-variant overflow-hidden rounded">
        <table class="w-full zebra-table border-collapse">
          <thead>
            <tr class="bg-surface-container-high text-left border-b border-outline-variant">
              <th class="p-md font-label-caps text-label-caps text-secondary uppercase">Centro Logístico</th>
              <th class="p-md font-label-caps text-label-caps text-secondary uppercase text-right">Precio Litro (CLP)</th>
              <th class="p-md font-label-caps text-label-caps text-secondary uppercase">Última Actualización</th>
              <th class="p-md font-label-caps text-label-caps text-secondary uppercase text-center">Estado</th>
            </tr>
          </thead>
          <tbody class="font-body-md text-body-md">
            ${centres.map(cd => {
              const fuel = cfg.combustibles[cd.id] || {};
              let estado = `<span class="inline-flex items-center px-2 py-1 rounded bg-secondary-container text-on-secondary-container font-label-caps text-[10px]">SIN DATOS</span>`;
              if (fuel.fecha) {
                const dias = Math.floor((hoy - new Date(fuel.fecha)) / 86400000);
                estado = dias > 21
                  ? `<span class="inline-flex items-center gap-1 px-2 py-1 rounded bg-red-100 text-red-800 font-label-caps text-[10px]"><span class="material-symbols-outlined text-[14px]">warning</span> ${dias} DÍAS SIN ACTUALIZAR</span>`
                  : `<span class="inline-flex items-center px-2 py-1 rounded bg-green-100 text-green-800 font-label-caps text-[10px]">VIGENTE (${dias}D)</span>`;
              }
              return `<tr class="border-b border-outline-variant">
                <td class="p-md font-bold">${cd.nombre}</td>
                <td class="p-md w-40">${numInput(`combustibles.${cd.id}.precioLitro`, fuel.precioLitro)}</td>
                <td class="p-md w-44">${dateInput(`combustibles.${cd.id}.fecha`, fuel.fecha)}</td>
                <td class="p-md text-center">${estado}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <div class="bg-surface-container-lowest border border-outline-variant p-lg shadow-sm">
      <div class="flex items-center gap-sm mb-md border-b border-outline-variant pb-sm">
        <span class="material-symbols-outlined text-primary">speed</span>
        <h2 class="font-headline-sm text-headline-sm font-bold text-on-surface">Matriz de Rendimiento Estructural (KM/Litro)</h2>
      </div>
      <div class="bg-surface border border-outline-variant overflow-hidden rounded">
        <table class="w-full zebra-table border-collapse">
          <thead>
            <tr class="bg-surface-container-high text-left border-b border-outline-variant">
              <th class="p-md font-label-caps text-label-caps text-secondary uppercase">Capacidad Camión</th>
              <th class="p-md font-label-caps text-label-caps text-secondary uppercase text-right">Rendimiento Cargado (Ida)</th>
              <th class="p-md font-label-caps text-label-caps text-secondary uppercase text-right">Rendimiento Vacío (Vuelta)</th>
              <th class="p-md font-label-caps text-label-caps text-secondary uppercase text-center">Ejes (fijo)</th>
            </tr>
          </thead>
          <tbody class="font-body-md text-body-md">
            ${CAP_LIST.map(cap => {
              const r = cfg.rendimientos[cap] || {};
              return `<tr class="border-b border-outline-variant">
                <td class="p-md font-bold">${(cap / 1000).toLocaleString('es-CL')}.000 kg</td>
                <td class="p-md w-32">${numInput(`rendimientos.${cap}.cargado`, r.cargado)}</td>
                <td class="p-md w-32">${numInput(`rendimientos.${cap}.vacio`, r.vacio)}</td>
                <td class="p-md text-center font-data-mono text-data-mono">${cfg.ejes[cap]}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

// ============================================================
// SUB-MÓDULO 3: SEGUROS Y PERMISOS
// ============================================================
function renderSeguros(content, db, cfg) {
  const centres = db.logisticsCentres;
  const ufVal = Number(cfg.variables.valorUF) || 0;

  content.innerHTML = `
    <div class="bg-surface-container-lowest border border-outline-variant p-lg shadow-sm mb-lg">
      <div class="flex items-center gap-sm mb-md border-b border-outline-variant pb-sm">
        <span class="material-symbols-outlined text-primary">shield</span>
        <h2 class="font-headline-sm text-headline-sm font-bold text-on-surface">Seguro de Carga (Colectivo Corporativo)</h2>
      </div>
      <p class="text-[12px] text-secondary mb-md">Valor base mensual en UF por centro. Se convierte a CLP usando el Valor UF indexado (Variables Generales). UF actual: <b>${formatCLP(ufVal)}</b></p>
      <div class="bg-surface border border-outline-variant overflow-hidden rounded">
        <table class="w-full zebra-table border-collapse">
          <thead>
            <tr class="bg-surface-container-high text-left border-b border-outline-variant">
              <th class="p-md font-label-caps text-label-caps text-secondary uppercase">Centro Logístico</th>
              <th class="p-md font-label-caps text-label-caps text-secondary uppercase text-right">Seguro Carga (UF/mes)</th>
              <th class="p-md font-label-caps text-label-caps text-secondary uppercase text-right">Equivalente CLP/mes</th>
            </tr>
          </thead>
          <tbody class="font-body-md text-body-md">
            ${centres.map(cd => {
              const uf = Number(cfg.seguros[cd.id]) || 0;
              return `<tr class="border-b border-outline-variant">
                <td class="p-md font-bold">${cd.nombre}</td>
                <td class="p-md w-32">${numInput(`seguros.${cd.id}`, uf)}</td>
                <td class="p-md text-right font-data-mono text-data-mono">${formatCLP(uf * ufVal)}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <div class="bg-surface-container-lowest border border-outline-variant p-lg shadow-sm">
      <div class="flex items-center gap-sm mb-md border-b border-outline-variant pb-sm">
        <span class="material-symbols-outlined text-primary">badge</span>
        <h2 class="font-headline-sm text-headline-sm font-bold text-on-surface">Permiso de Circulación y SOAP (Anual Promediado)</h2>
      </div>
      <p class="text-[12px] text-secondary mb-md">Tabla relacional indexada por Centro Logístico y Tipo de Camión. Edición inline o carga masiva CSV (columnas: Centro_SAP, Tipo_Camion_Kg, Permiso_Circulacion, SOAP).</p>

      <div class="flex items-center gap-md bg-surface-container-low p-md rounded mb-md">
        <span class="material-symbols-outlined text-secondary">upload_file</span>
        <div class="flex-1">
          <p class="font-body-md text-body-md font-bold text-on-surface">Carga masiva CSV — Permiso y SOAP</p>
          <p class="text-[11px] text-secondary">Columnas: Centro_SAP, Tipo_Camion_Kg, Permiso_Circulacion, SOAP</p>
        </div>
        <input type="file" id="ps-csv" accept=".csv" class="text-[12px]">
      </div>

      <div class="bg-surface border border-outline-variant overflow-hidden rounded">
        <table class="w-full zebra-table border-collapse">
          <thead>
            <tr class="bg-surface-container-high text-left border-b border-outline-variant">
              <th class="p-md font-label-caps text-label-caps text-secondary uppercase">Centro</th>
              <th class="p-md font-label-caps text-label-caps text-secondary uppercase">Tipo Camión</th>
              <th class="p-md font-label-caps text-label-caps text-secondary uppercase text-right">Permiso Circulación (anual)</th>
              <th class="p-md font-label-caps text-label-caps text-secondary uppercase text-right">SOAP (anual)</th>
            </tr>
          </thead>
          <tbody class="font-body-md text-body-md">
            ${centres.map(cd => CAP_LIST.map(cap => {
              const key = `${cd.id}|${cap}`;
              const row = cfg.permisosSoap[key] || {};
              return `<tr class="border-b border-outline-variant">
                <td class="p-md font-bold">${cd.nombre}</td>
                <td class="p-md font-data-mono text-data-mono">${(cap / 1000)}.000 kg</td>
                <td class="p-md w-36">${numInput(`permisosSoap.${key}.permiso`, row.permiso)}</td>
                <td class="p-md w-36">${numInput(`permisosSoap.${key}.soap`, row.soap)}</td>
              </tr>`;
            }).join('')).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  document.getElementById('ps-csv').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    readCSVFile(file, (rows) => {
      let count = 0;
      rows.forEach(row => {
        const cd = centres.find(c => c.id === (row.Centro_SAP || '').trim());
        const cap = parseCapKgFromCSV(row.Tipo_Camion_Kg);
        if (!cd || !CAP_LIST.includes(cap)) return;
        const key = `${cd.id}|${cap}`;
        cfg.permisosSoap[key] = {
          permiso: Number(row.Permiso_Circulacion) || 0,
          soap: Number(row.SOAP) || 0
        };
        count++;
      });
      saveDatabase(db);
      showAlert(`${count} registros de Permiso/SOAP actualizados`);
      renderSeguros(content, db, cfg);
    });
  });
}

// ============================================================
// SUB-MÓDULO 4: VARIABLES GENERALES
// ============================================================
function renderVariables(content, db, cfg) {
  const centres = db.logisticsCentres;
  const v = cfg.variables;
  const hoy = new Date();
  let alertaUF = '';
  if (v.fechaUF) {
    const dias = Math.floor((hoy - new Date(v.fechaUF)) / 86400000);
    if (dias > 30) {
      alertaUF = `<span class="inline-flex items-center gap-1 px-2 py-1 rounded bg-red-100 text-red-800 font-label-caps text-[10px] ml-sm"><span class="material-symbols-outlined text-[14px]">warning</span> ${dias} DÍAS SIN ACTUALIZAR</span>`;
    }
  } else {
    alertaUF = `<span class="inline-flex items-center gap-1 px-2 py-1 rounded bg-red-100 text-red-800 font-label-caps text-[10px] ml-sm"><span class="material-symbols-outlined text-[14px]">warning</span> SIN FECHA</span>`;
  }

  content.innerHTML = `
    <div class="grid grid-cols-1 md:grid-cols-2 gap-lg mb-lg">
      <!-- Valor UF y Margen -->
      <div class="bg-surface-container-lowest border border-outline-variant p-lg shadow-sm">
        <h3 class="font-headline-sm text-headline-sm font-bold text-on-surface mb-md">Valor UF y Margen de Ganancia</h3>
        <div class="grid grid-cols-2 gap-md">
          <div class="space-y-xs">
            <label class="font-label-caps text-label-caps text-secondary block">VALOR UF (CLP) ${alertaUF}</label>
            ${numInput('variables.valorUF', v.valorUF)}
          </div>
          <div class="space-y-xs">
            <label class="font-label-caps text-label-caps text-secondary block">FECHA ACTUALIZACIÓN UF</label>
            ${dateInput('variables.fechaUF', v.fechaUF)}
          </div>
          <div class="space-y-xs">
            <label class="font-label-caps text-label-caps text-secondary block">MARGEN DE GANANCIA (%)</label>
            ${numInput('variables.margenGanancia', v.margenGanancia)}
          </div>
          <div class="space-y-xs">
            <label class="font-label-caps text-label-caps text-secondary block">GPS / CELULAR (UF MENSUAL)</label>
            ${numInput('variables.gps.costoUF', v.gps.costoUF)}
          </div>
        </div>
        <p class="text-[11px] text-secondary mt-md">El costo GPS se prorratea dividiendo por los KM Mensuales Ofrecidos de cada centro/camión.</p>
      </div>

      <!-- Chofer -->
      <div class="bg-surface-container-lowest border border-outline-variant p-lg shadow-sm">
        <h3 class="font-headline-sm text-headline-sm font-bold text-on-surface mb-md">Chofer — Remuneración y Comisión</h3>
        <div class="grid grid-cols-2 gap-md mb-md">
          <div class="space-y-xs">
            <label class="font-label-caps text-label-caps text-secondary block">DÍAS HÁBILES MENSUALES</label>
            ${numInput('variables.chofer.diasHabiles', v.chofer.diasHabiles)}
          </div>
          <div class="space-y-xs">
            <label class="font-label-caps text-label-caps text-secondary block">COMISIÓN POR SERVICIO (%)</label>
            ${numInput('variables.chofer.comisionPct', v.chofer.comisionPct)}
          </div>
        </div>
        <p class="font-label-caps text-label-caps text-secondary mb-xs">SUELDO MÍNIMO POR CENTRO LOGÍSTICO (CLP)</p>
        <div class="space-y-xs">
          ${centres.map(cd => `
            <div class="grid grid-cols-2 gap-md items-center">
              <span class="text-[12px] text-secondary">${cd.nombre}</span>
              ${numInput(`variables.chofer.sueldoMinimo.${cd.id}`, v.chofer.sueldoMinimo[cd.id])}
            </div>`).join('')}
        </div>
      </div>
    </div>

    <div class="grid grid-cols-1 md:grid-cols-2 gap-lg mb-lg">
      <!-- Neumáticos -->
      <div class="bg-surface-container-lowest border border-outline-variant p-lg shadow-sm">
        <h3 class="font-headline-sm text-headline-sm font-bold text-on-surface mb-md">Desgaste de Neumáticos</h3>
        <div class="space-y-xs mb-md">
          <label class="font-label-caps text-label-caps text-secondary block">CICLO BASE (KM)</label>
          ${numInput('variables.neumaticos.ciclo', v.neumaticos.ciclo)}
        </div>
        <p class="font-label-caps text-label-caps text-secondary mb-xs">COSTO DE CAMBIO COMPLETO POR TIPO DE CAMIÓN</p>
        <div class="space-y-xs">
          ${CAP_LIST.map(cap => `
            <div class="grid grid-cols-2 gap-md items-center">
              <span class="text-[12px] text-secondary">${(cap / 1000)}.000 kg</span>
              ${numInput(`variables.neumaticos.costos.${cap}`, v.neumaticos.costos[cap])}
            </div>`).join('')}
        </div>
      </div>

      <!-- Factor Ruta -->
      <div class="bg-surface-container-lowest border border-outline-variant p-lg shadow-sm">
        <h3 class="font-headline-sm text-headline-sm font-bold text-on-surface mb-md">Factor Ruta (Geográfico)</h3>
        <p class="text-[12px] text-secondary mb-md">Multiplicador aplicado al Costo Ruta Total según la característica de la ruta (ver Administración de Rutas).</p>
        <div class="space-y-xs">
          ${['NORMAL', 'ISLA', 'EXTREMA'].map(k => `
            <div class="grid grid-cols-2 gap-md items-center">
              <span class="text-[12px] text-secondary font-bold">${k}</span>
              ${numInput(`variables.factorRuta.${k}`, v.factorRuta[k])}
            </div>`).join('')}
        </div>
      </div>
    </div>

    <!-- Mantención -->
    <div class="bg-surface-container-lowest border border-outline-variant p-lg shadow-sm mb-lg">
      <h3 class="font-headline-sm text-headline-sm font-bold text-on-surface mb-md">Mantención Vehicular</h3>
      <div class="space-y-xs mb-md max-w-xs">
        <label class="font-label-caps text-label-caps text-secondary block">CICLO BASE AJUSTABLE (KM)</label>
        ${numInput('variables.mantencion.ciclo', v.mantencion.ciclo)}
      </div>
      <p class="font-label-caps text-label-caps text-secondary mb-xs">COSTO DE MANTENCIÓN POR CENTRO Y TIPO DE CAMIÓN</p>
      <div class="bg-surface border border-outline-variant overflow-hidden rounded">
        <table class="w-full zebra-table border-collapse">
          <thead>
            <tr class="bg-surface-container-high text-left border-b border-outline-variant">
              <th class="p-md font-label-caps text-label-caps text-secondary uppercase">Centro</th>
              <th class="p-md font-label-caps text-label-caps text-secondary uppercase">Tipo Camión</th>
              <th class="p-md font-label-caps text-label-caps text-secondary uppercase text-right">Costo Mantención</th>
            </tr>
          </thead>
          <tbody class="font-body-md text-body-md">
            ${centres.map(cd => CAP_LIST.map(cap => {
              const key = `${cd.id}|${cap}`;
              return `<tr class="border-b border-outline-variant">
                <td class="p-md font-bold">${cd.nombre}</td>
                <td class="p-md font-data-mono text-data-mono">${(cap / 1000)}.000 kg</td>
                <td class="p-md w-36">${numInput(`variables.mantencion.costos.${key}`, (v.mantencion.costos || {})[key])}</td>
              </tr>`;
            }).join('')).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <!-- KM Mensuales Ofrecidos -->
    <div class="bg-surface-container-lowest border border-outline-variant p-lg shadow-sm mb-lg">
      <h3 class="font-headline-sm text-headline-sm font-bold text-on-surface mb-md">KM Mensuales Ofrecidos</h3>
      <p class="text-[12px] text-secondary mb-md">Determina los denominadores de los prorrateos fijos (SOAP, Seguro, Mantención, Neumáticos, GPS). Carga masiva CSV: columnas Centro_SAP, Tipo_Camion_Kg, KM_Mensual.</p>
      <div class="flex items-center gap-md bg-surface-container-low p-md rounded mb-md">
        <span class="material-symbols-outlined text-secondary">upload_file</span>
        <div class="flex-1">
          <p class="font-body-md text-body-md font-bold text-on-surface">Carga masiva CSV — KM Mensuales Ofrecidos</p>
          <p class="text-[11px] text-secondary">Columnas: Centro_SAP, Tipo_Camion_Kg, KM_Mensual</p>
        </div>
        <input type="file" id="km-csv" accept=".csv" class="text-[12px]">
      </div>
      <div class="bg-surface border border-outline-variant overflow-hidden rounded">
        <table class="w-full zebra-table border-collapse">
          <thead>
            <tr class="bg-surface-container-high text-left border-b border-outline-variant">
              <th class="p-md font-label-caps text-label-caps text-secondary uppercase">Centro</th>
              <th class="p-md font-label-caps text-label-caps text-secondary uppercase">Tipo Camión</th>
              <th class="p-md font-label-caps text-label-caps text-secondary uppercase text-right">KM Mensuales Ofrecidos</th>
            </tr>
          </thead>
          <tbody class="font-body-md text-body-md">
            ${centres.map(cd => CAP_LIST.map(cap => {
              const key = `${cd.id}|${cap}`;
              return `<tr class="border-b border-outline-variant">
                <td class="p-md font-bold">${cd.nombre}</td>
                <td class="p-md font-data-mono text-data-mono">${(cap / 1000)}.000 kg</td>
                <td class="p-md w-36">${numInput(`kmOfrecidos.${key}`, cfg.kmOfrecidos[key])}</td>
              </tr>`;
            }).join('')).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Costos Base (Referencia) -->
    <div class="bg-surface-container-lowest border border-outline-variant p-lg shadow-sm">
      <h3 class="font-headline-sm text-headline-sm font-bold text-on-surface mb-md">Estructura de Costos Base y Tramos KM Adicionales (Referencia)</h3>
      <div class="bg-surface border border-outline-variant overflow-hidden rounded">
        <table class="w-full zebra-table border-collapse">
          <thead>
            <tr class="bg-surface-container-high text-left border-b border-outline-variant">
              <th class="p-md font-label-caps text-label-caps text-secondary uppercase">Ítem</th>
              ${CAP_LIST.map(cap => `<th class="p-md font-label-caps text-label-caps text-secondary uppercase text-right">${(cap / 1000)}.000 kg</th>`).join('')}
            </tr>
          </thead>
          <tbody class="font-body-md text-body-md">
            <tr class="border-b border-outline-variant">
              <td class="p-md font-bold">Costo Base Fijo</td>
              ${CAP_LIST.map(cap => `<td class="p-md w-32">${numInput(`variables.costosBase.${cap}.fijo`, v.costosBase[cap].fijo)}</td>`).join('')}
            </tr>
            <tr class="border-b border-outline-variant">
              <td class="p-md font-bold">KM Base Adicional (Hasta 50KM)</td>
              ${CAP_LIST.map(cap => `<td class="p-md w-32">${numInput(`variables.costosBase.${cap}.kmAdicional`, v.costosBase[cap].kmAdicional)}</td>`).join('')}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  `;

  document.getElementById('km-csv').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    readCSVFile(file, (rows) => {
      let count = 0;
      rows.forEach(row => {
        const cd = centres.find(c => c.id === (row.Centro_SAP || '').trim());
        const cap = parseCapKgFromCSV(row.Tipo_Camion_Kg);
        if (!cd || !CAP_LIST.includes(cap)) return;
        cfg.kmOfrecidos[`${cd.id}|${cap}`] = Number(row.KM_Mensual) || 0;
        count++;
      });
      saveDatabase(db);
      showAlert(`${count} registros de KM Mensuales actualizados`);
      renderVariables(content, db, cfg);
    });
  });
}

// ============================================================
// MOTOR ACTUARIAL: RESULTADOS Y EXPORTACIÓN
// ============================================================
function renderResultados(content, db, cfg) {
  const matriz = calcularMatrizCostos(db, cfg);

  content.innerHTML = `
    <div class="bg-surface-container-lowest border border-outline-variant p-lg shadow-sm mb-lg">
      <div class="flex items-center justify-between mb-md border-b border-outline-variant pb-sm">
        <div class="flex items-center gap-sm">
          <span class="material-symbols-outlined text-primary">calculate</span>
          <h2 class="font-headline-sm text-headline-sm font-bold text-on-surface">Motor Actuarial — Resultados ZCAP</h2>
        </div>
        <button id="zcap-export" class="bg-primary hover:bg-[#930007] text-white font-bold px-md py-sm rounded flex items-center gap-sm text-xs uppercase">
          <span class="material-symbols-outlined text-[18px]">download</span> Exportar CSV
        </button>
      </div>
      <p class="text-[12px] text-secondary mb-md">Calculado para todas las rutas activas y los 4 tipos de camión, según las variables configuradas en los sub-módulos anteriores.</p>

      <div class="bg-surface border border-outline-variant overflow-hidden rounded overflow-x-auto">
        <table class="w-full zebra-table border-collapse">
          <thead>
            <tr class="bg-surface-container-high text-left border-b border-outline-variant">
              <th class="p-md font-label-caps text-label-caps text-secondary uppercase">Centro</th>
              <th class="p-md font-label-caps text-label-caps text-secondary uppercase">Ruta</th>
              <th class="p-md font-label-caps text-label-caps text-secondary uppercase text-right">KM</th>
              <th class="p-md font-label-caps text-label-caps text-secondary uppercase">Camión</th>
              <th class="p-md font-label-caps text-label-caps text-secondary uppercase text-center">Ejes</th>
              <th class="p-md font-label-caps text-label-caps text-secondary uppercase text-right">Peajes</th>
              <th class="p-md font-label-caps text-label-caps text-secondary uppercase text-right">Combustible</th>
              <th class="p-md font-label-caps text-label-caps text-secondary uppercase text-right">Costo Ruta Total</th>
              <th class="p-md font-label-caps text-label-caps text-secondary uppercase text-right">Costo/KM Final</th>
              <th class="p-md font-label-caps text-label-caps text-secondary uppercase text-right bg-primary/5">ZCAP</th>
            </tr>
          </thead>
          <tbody class="font-body-md text-body-md">
            ${matriz.map(m => `
              <tr class="border-b border-outline-variant">
                <td class="p-md">${getCentreName(db, m.centroId)}</td>
                <td class="p-md font-bold">${m.ruta.codigo} — ${m.ruta.destino}</td>
                <td class="p-md text-right font-data-mono text-data-mono">${m.km}</td>
                <td class="p-md">${m.truckType.type}</td>
                <td class="p-md text-center font-data-mono text-data-mono">${m.ejes}</td>
                <td class="p-md text-right font-data-mono text-data-mono">${formatCLP(m.item1_peajes)}</td>
                <td class="p-md text-right font-data-mono text-data-mono">${formatCLP(m.item2_combustible)}</td>
                <td class="p-md text-right font-data-mono text-data-mono">${formatCLP(m.item10_costoRutaTotal)}</td>
                <td class="p-md text-right font-data-mono text-data-mono">${formatCLP(m.item11_costoKmFinal)}</td>
                <td class="p-md text-right font-data-mono text-data-mono font-bold bg-primary/5">${formatCLP(m.zcap)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  document.getElementById('zcap-export').addEventListener('click', () => {
    const headers = ['Codigo_Centro', 'Ruta_ID', 'Destino_Comuna', 'Tipo_Camion_Kg', 'Ejes', 'Valor_ZCAP_KM'];
    const rows = matriz.map(m => {
      const cd = db.logisticsCentres.find(c => c.id === m.centroId);
      return [
        cd ? cd.id : m.centroId,
        m.ruta.codigo,
        m.ruta.destino,
        m.truckType.capKg,
        m.ejes,
        Math.round(m.item11_costoKmFinal)
      ];
    });
    downloadFile(`zcap_transporte_${Date.now()}.csv`, toCSV(headers, rows));
    showAlert('Archivo CSV de costos de transporte exportado');
  });
}
