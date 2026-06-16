// MÓDULO: Administrador de Tarifas Clientes — SIT EBEMA v2
// Vistas: Histórico (6M) | Consolidación | Densidad Logística | Frecuencia y Especiales | Cluster | Resultados
import { getDatabase, saveDatabase, getTariffConfig, getClientTariffConfig, truckCapKg } from './data.js';
import { CAP_LIST, truckTypesWithCap, calcularCostoRuta } from './tarifas-engine.js';
import { formatCLP, showAlert, toCSV, downloadFile, formatDateDDMMYYYY } from './utils.js';

// ─────────────────────────────────────────────────────────────
// ESTADO DE MÓDULO (en memoria; se re-carga con el CSV cada sesión)
// ─────────────────────────────────────────────────────────────
let histData  = [];   // [{fecha,oficina,documento,gasto,hes,idCliente,idObra,transportista,capTons,entrega,idRuta,idTransportista,ton}]
let histPage  = 0;
let histFilterGrupo = 'all';
let histFilterEstado = 'all';
let activeSubC = 'historico';

// ─────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────
const CENTRO_GROUPS = {
  '1000': 'SANTIAGO', '1001': 'SANTIAGO', '1002': 'SANTIAGO', '1003': 'SANTIAGO',
  '1080': 'CONCEPCIÓN', '1081': 'CONCEPCIÓN'
};
const CAP_BUCKETS = [5, 10, 15, 28];       // toneladas nominales
const CAP_LABELS  = { 5: '≤5T', 10: '10T', 15: '15T', 28: '28T' };
const PAGE_SIZE   = 200;
const VALIDEZ_A   = '31-12-2026';

const DEFAULT_CLUSTER_NAMES  = { '1': 'Cluster 1 — Alta densidad', '2': 'Cluster 2 — Media densidad', '3': 'Cluster 3 — Baja densidad', spot: 'SPOT / Interregional' };
const DEFAULT_CLUSTER_COLORS = { '1': '#b5000b', '2': '#d97706', '3': '#16a34a', spot: '#6b7280' };
const DEFAULT_CLUSTER_NV     = { '1': 98, '2': 96, '3': 95, spot: 90 };
const DEFAULT_CLUSTER_FREQ   = { '1': 'Diario', '2': 'Bi-semanal', '3': 'Semanal', spot: 'Según demanda' };
const CLUSTER_KEYS = ['1', '2', '3', 'spot'];
// NEXT_CAP para cálculo ZFMP
const NEXT_CAP = { 5000: 10000, 10000: 15000, 15000: 28000, 28000: 28000 };

// ─────────────────────────────────────────────────────────────
// HELPERS DATOS
// ─────────────────────────────────────────────────────────────
function getCentroGroup(oficina) {
  return CENTRO_GROUPS[String(oficina)] || String(oficina);
}

function getCapBucket(capTons) {
  const n = Number(capTons);
  if (n <= 5)  return 5;
  if (n <= 10) return 10;
  if (n <= 15) return 15;
  return 28;
}

function parseTon(val) {
  return parseFloat(String(val).replace(',', '.')) || 0;
}

function allGroups() {
  if (!histData.length) return [];
  const s = new Set(histData.map(r => getCentroGroup(r.oficina)));
  return [...s].sort();
}

// Buscar ruta en db por código
function findRoute(db, idRuta) {
  return (db.routes || []).find(r =>
    r.codigo && r.codigo.toLowerCase() === String(idRuta).toLowerCase()
  );
}

// Determinar si ruta es interregional: si el centro SAP del CSV
// no empieza con el prefijo que podría inferirse del código de ruta.
// Fallback: usar db.routes si está disponible.
function isInterregional(db, idRuta, oficina) {
  const r = findRoute(db, idRuta);
  if (r) {
    // Rutas de tipo 'Sector' con km > 80 se consideran interregionales
    if (r.interregional !== undefined) return r.interregional;
    if (r.tipo === 'Sector' && (r.km || 0) > 80) return true;
    return false;
  }
  // Heurística por prefijo de ruta vs grupo centro
  const prefix = String(idRuta).substring(0, 3).toUpperCase();
  const grupo  = getCentroGroup(oficina);
  const SGO_PREFIXES = ['SGO', 'SCL', 'SBN'];
  const PMO_PREFIXES = ['PMO', 'OSO'];
  const ANT_PREFIXES = ['ANT'];
  const CCP_PREFIXES = ['CCP', 'CCO'];
  if (grupo === 'SANTIAGO'   && SGO_PREFIXES.includes(prefix)) return false;
  if (grupo === 'CONCEPCIÓN' && CCP_PREFIXES.includes(prefix)) return false;
  // Si el prefijo no coincide con el grupo → probablemente interregional
  const knownLocal = [...SGO_PREFIXES, ...PMO_PREFIXES, ...ANT_PREFIXES, ...CCP_PREFIXES];
  return knownLocal.includes(prefix) && !([...SGO_PREFIXES].includes(prefix) && grupo === 'SANTIAGO')
       && !([...CCP_PREFIXES].includes(prefix) && grupo === 'CONCEPCIÓN');
}

// ─────────────────────────────────────────────────────────────
// PARSER CSV (punto y coma, latin-1/windows-1252)
// ─────────────────────────────────────────────────────────────
function parseHistCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(';').map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split(';');
    const col = (h) => (parts[headers.indexOf(h)] || '').trim();
    rows.push({
      fecha:           col('Fecha Transporte'),
      oficina:         col('Oficina Entrega'),
      documento:       col('Documento Transporte'),
      gasto:           Number(col('Gasto Transporte')) || 0,
      hes:             col('HES'),           // '' = pendiente pago
      idCliente:       col('ID Cliente'),
      idObra:          col('ID Obra'),
      transportista:   col('Transportista'),
      capTons:         Number(col('Cap. Camión')) || 0,
      entrega:         col('Entrega'),
      idRuta:          col('ID Ruta'),
      idTransportista: col('ID Transportista'),
      ton:             parseTon(col('Ton'))
    });
  }
  return rows.filter(r => r.documento && r.idRuta && r.idRuta !== '(en blanco)');
}

// ─────────────────────────────────────────────────────────────
// HELPERS UI
// ─────────────────────────────────────────────────────────────
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
  return path.split('.').reduce((c, p) => (c == null ? fallback : c[p]), obj) ?? fallback;
}

const inputCls  = 'w-full border border-[#CED4DA] p-xs font-data-mono text-data-mono text-right focus:border-primary focus:ring-0 bg-white rounded';
const selectCls = 'border border-[#CED4DA] px-sm py-xs font-body-md text-body-md focus:border-primary focus:ring-0 bg-white rounded';

function numInput(path, val, extra = '') {
  return `<input type="number" step="any" class="${inputCls}" data-path="${path}" value="${val ?? 0}" ${extra}>`;
}
function textInput(path, val, extra = '') {
  return `<input type="text" class="${inputCls} text-left" data-path="${path}" value="${val || ''}" ${extra}>`;
}
function colorInput(path, val) {
  return `<input type="color" class="w-10 h-8 rounded cursor-pointer border border-outline-variant" data-path="${path}" data-refresh="true" value="${val || '#6b7280'}">`;
}

function ensureCcfg(ccfg) {
  if (!ccfg.clusterNames)      ccfg.clusterNames      = { ...DEFAULT_CLUSTER_NAMES };
  if (!ccfg.clusterColors)     ccfg.clusterColors     = { ...DEFAULT_CLUSTER_COLORS };
  if (!ccfg.clusterNV)         ccfg.clusterNV         = { ...DEFAULT_CLUSTER_NV };
  if (!ccfg.clusterFrecuencia) ccfg.clusterFrecuencia = { ...DEFAULT_CLUSTER_FREQ };
  if (!ccfg.comunaCluster)     ccfg.comunaCluster     = {};
  if (!ccfg.especiales)        ccfg.especiales        = { tipo0000: {}, recargoExclusividad: {} };
  if (!ccfg.especiales.tipo0000)            ccfg.especiales.tipo0000            = {};
  if (!ccfg.especiales.recargoExclusividad) ccfg.especiales.recargoExclusividad = {};
  if (!ccfg.consolidacionObjetivo)          ccfg.consolidacionObjetivo          = {};
  if (!ccfg.histMeta) ccfg.histMeta = { uploadDate: null, rowCount: 0, fileName: '' };
  // Compatibilidad hacia atrás: campos del módulo viejo que aún usa renderResultados
  if (!ccfg.consolidacion)     ccfg.consolidacion     = {};
}

function noDataBanner(msg = 'Cargue un CSV en la pestaña Histórico para habilitar esta vista.') {
  return `<div class="flex flex-col items-center justify-center py-xl text-secondary gap-sm">
    <span class="material-symbols-outlined text-[40px] text-outline-variant">upload_file</span>
    <p class="font-body-md text-body-md">${msg}</p>
  </div>`;
}

function subTabButton(key, icon, label) {
  return `<button class="ct-subtab flex items-center gap-xs px-md py-sm rounded-lg font-bold text-[12px] uppercase tracking-wide bg-surface-container-high text-secondary cursor-pointer whitespace-nowrap" data-sub="${key}">
    <span class="material-symbols-outlined text-[16px]">${icon}</span> ${label}
  </button>`;
}

// ─────────────────────────────────────────────────────────────
// VISTA PRINCIPAL
// ─────────────────────────────────────────────────────────────
export function renderClientTariffView(container) {
  const db   = getDatabase();
  const cfg  = getTariffConfig(db);
  const ccfg = getClientTariffConfig(db);
  ensureCcfg(ccfg);

  container.innerHTML = `
    <div class="mb-xl">
      <h1 class="font-headline-lg text-headline-lg text-on-surface">Administrador de Tarifas Clientes</h1>
      <p class="font-body-lg text-body-lg text-secondary">Análisis histórico, consolidación de flota, densidad logística y estructuración de tarifas por cluster.</p>
    </div>
    <div class="flex gap-sm mb-lg border-b border-outline-variant pb-sm overflow-x-auto" id="ct-subtabs">
      ${subTabButton('historico',     'history',        'Histórico (6M)')}
      ${subTabButton('consolidacion', 'inventory',      'Consolidación')}
      ${subTabButton('densidad',      'location_on',    'Densidad Logística')}
      ${subTabButton('especiales',    'star',           'Frecuencia y Especiales')}
      ${subTabButton('cluster',       'map',            'Cluster')}
      ${subTabButton('resultados',    'request_quote',  'Resultados ZFMI/ZFMP')}
    </div>
    <div id="ct-content"></div>
  `;

  document.querySelectorAll('.ct-subtab').forEach(btn => {
    btn.addEventListener('click', () => { activeSubC = btn.dataset.sub; renderSub(); });
  });

  renderSub();

  function renderSub() {
    document.querySelectorAll('.ct-subtab').forEach(btn => {
      btn.className = btn.dataset.sub === activeSubC
        ? 'ct-subtab flex items-center gap-xs px-md py-sm rounded-lg font-bold text-[12px] uppercase tracking-wide bg-primary text-white cursor-pointer whitespace-nowrap'
        : 'ct-subtab flex items-center gap-xs px-md py-sm rounded-lg font-bold text-[12px] uppercase tracking-wide bg-surface-container-high text-secondary hover:text-primary cursor-pointer whitespace-nowrap';
    });
    const content = document.getElementById('ct-content');
    switch (activeSubC) {
      case 'historico':     renderHistorico(content, db, ccfg);    break;
      case 'consolidacion': renderConsolidacion(content, db, ccfg); break;
      case 'densidad':      renderDensidad(content, db, ccfg);     break;
      case 'especiales':    renderEspeciales(content, db, ccfg);   break;
      case 'cluster':       renderCluster(content, db, ccfg);      break;
      case 'resultados':    renderResultados(content, db, cfg, ccfg); break;
    }
    // Listener delegado para inputs con data-path
    content.addEventListener('change', (e) => {
      const path = e.target.dataset.path;
      if (!path) return;
      let val;
      if (e.target.type === 'checkbox') val = e.target.checked;
      else if (e.target.type === 'number') val = e.target.value === '' ? 0 : Number(e.target.value);
      else val = e.target.value;
      setPath(ccfg, path, val);
      saveDatabase(db);
      if (e.target.dataset.refresh === 'true') renderSub();
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// VISTA 1: HISTÓRICO (6M)
// ═══════════════════════════════════════════════════════════════
function renderHistorico(content, db, ccfg) {
  const hasData = histData.length > 0;

  // ── Calcular resumen ──────────────────────────────────────
  let summary = null;
  if (hasData) {
    const docsMap = new Map();
    histData.forEach(r => {
      if (!docsMap.has(r.documento)) docsMap.set(r.documento, { gasto: r.gasto, pagado: r.hes !== '' });
    });
    const totalDocs     = docsMap.size;
    const totalGasto    = [...docsMap.values()].reduce((s, d) => s + d.gasto, 0);
    const pendDocs      = [...docsMap.values()].filter(d => !d.pagado).length;
    const totalTon      = histData.reduce((s, r) => s + r.ton, 0);
    const totalEntreg   = histData.length;
    summary = { totalDocs, totalGasto, pendDocs, totalTon, totalEntreg };
  }

  // ── Filtrar filas ──────────────────────────────────────────
  const grupos = allGroups();
  let rows = histData;
  if (histFilterGrupo !== 'all') rows = rows.filter(r => getCentroGroup(r.oficina) === histFilterGrupo);
  if (histFilterEstado === 'pagado')    rows = rows.filter(r => r.hes !== '');
  if (histFilterEstado === 'pendiente') rows = rows.filter(r => r.hes === '');
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  histPage = Math.min(histPage, totalPages - 1);
  const pageRows = rows.slice(histPage * PAGE_SIZE, (histPage + 1) * PAGE_SIZE);

  content.innerHTML = `
    <div class="bg-surface-container-lowest border border-outline-variant p-lg shadow-sm mb-lg">
      <div class="flex items-center justify-between mb-md border-b border-outline-variant pb-sm flex-wrap gap-sm">
        <div class="flex items-center gap-sm">
          <span class="material-symbols-outlined text-primary">history</span>
          <h2 class="font-headline-sm text-headline-sm font-bold text-on-surface">Histórico Operacional — 6 Meses</h2>
        </div>
        ${hasData ? `<button id="hist-clear" class="border border-red-200 hover:bg-red-50 text-red-700 px-md py-sm rounded text-xs font-bold uppercase flex items-center gap-xs"><span class="material-symbols-outlined text-[16px]">delete</span> Vaciar</button>` : ''}
      </div>

      <!-- Upload -->
      <div class="flex items-center gap-md bg-surface-container-low border border-outline-variant p-md rounded mb-md">
        <span class="material-symbols-outlined text-secondary">upload_file</span>
        <div class="flex-1">
          <p class="font-body-md text-body-md font-bold text-on-surface">Cargar CSV de despachos históricos</p>
          <p class="text-[11px] text-secondary">Columnas: Fecha Transporte; Oficina Entrega; Documento Transporte; Gasto Transporte; HES; ID Cliente; ID Obra; Transportista; Cap. Camión; Entrega; ID Ruta; ID Transportista; Ton</p>
          ${ccfg.histMeta.uploadDate ? `<p class="text-[11px] text-primary mt-xs">Último cargado: <b>${ccfg.histMeta.fileName}</b> — ${ccfg.histMeta.rowCount.toLocaleString()} filas el ${ccfg.histMeta.uploadDate} (sólo en memoria)</p>` : ''}
        </div>
        <input type="file" id="hist-csv" accept=".csv" class="text-[12px]">
      </div>

      ${hasData && summary ? `
      <!-- Resumen estadístico -->
      <div class="grid grid-cols-2 md:grid-cols-5 gap-sm mb-md">
        ${statCard('Despachos', summary.totalDocs.toLocaleString(), 'local_shipping')}
        ${statCard('Entregas', summary.totalEntreg.toLocaleString(), 'package_2')}
        ${statCard('Toneladas', summary.totalTon.toFixed(1) + ' T', 'scale')}
        ${statCard('Gasto Total', formatCLP(summary.totalGasto), 'payments')}
        ${statCard('HES Pendiente', summary.pendDocs.toLocaleString() + ' desp.', 'pending', summary.pendDocs > 0 ? 'text-amber-600' : 'text-green-600')}
      </div>

      <!-- Filtros -->
      <div class="flex items-center gap-sm flex-wrap mb-md">
        <span class="font-label-caps text-label-caps text-secondary uppercase">Filtros:</span>
        <select id="hist-fg" class="${selectCls}">
          <option value="all">Todos los centros</option>
          ${grupos.map(g => `<option value="${g}" ${histFilterGrupo === g ? 'selected' : ''}>${g}</option>`).join('')}
        </select>
        <select id="hist-fe" class="${selectCls}">
          <option value="all"   ${histFilterEstado === 'all'      ? 'selected' : ''}>HES: Todos</option>
          <option value="pagado"    ${histFilterEstado === 'pagado'    ? 'selected' : ''}>Pagados</option>
          <option value="pendiente" ${histFilterEstado === 'pendiente' ? 'selected' : ''}>Pendientes</option>
        </select>
        <span class="font-body-md text-secondary text-[12px]">${rows.length.toLocaleString()} filas · Pág ${histPage + 1}/${totalPages}</span>
        ${histPage > 0          ? `<button id="hist-prev" class="border border-outline-variant px-sm py-xs rounded text-[12px] font-bold">‹ Anterior</button>` : ''}
        ${histPage < totalPages-1 ? `<button id="hist-next" class="border border-outline-variant px-sm py-xs rounded text-[12px] font-bold">Siguiente ›</button>` : ''}
      </div>

      <!-- Tabla -->
      <div class="bg-surface border border-outline-variant rounded overflow-x-auto max-h-[480px] overflow-y-auto">
        <table class="w-full border-collapse text-[12px]">
          <thead class="sticky top-0">
            <tr class="bg-surface-container-high border-b border-outline-variant text-left">
              <th class="p-sm font-label-caps text-secondary uppercase">Fecha</th>
              <th class="p-sm font-label-caps text-secondary uppercase">Centro</th>
              <th class="p-sm font-label-caps text-secondary uppercase">Ruta</th>
              <th class="p-sm font-label-caps text-secondary uppercase">Transportista</th>
              <th class="p-sm font-label-caps text-secondary uppercase text-right">Cap.</th>
              <th class="p-sm font-label-caps text-secondary uppercase text-right">Ton</th>
              <th class="p-sm font-label-caps text-secondary uppercase text-right">Gasto</th>
              <th class="p-sm font-label-caps text-secondary uppercase text-center">HES</th>
            </tr>
          </thead>
          <tbody class="font-body-md text-body-md divide-y divide-outline-variant">
            ${pageRows.map(r => `
              <tr class="hover:bg-surface-container-low">
                <td class="p-sm font-data-mono text-[11px]">${r.fecha}</td>
                <td class="p-sm">${getCentroGroup(r.oficina)}</td>
                <td class="p-sm font-bold">${r.idRuta}</td>
                <td class="p-sm text-secondary truncate max-w-[160px]" title="${r.transportista}">${r.transportista.split(' ').slice(0, 2).join(' ')}</td>
                <td class="p-sm text-right font-data-mono">${CAP_LABELS[getCapBucket(r.capTons)] || r.capTons + 'T'}</td>
                <td class="p-sm text-right font-data-mono">${r.ton.toFixed(2)}</td>
                <td class="p-sm text-right font-data-mono">${formatCLP(r.gasto)}</td>
                <td class="p-sm text-center">${r.hes
                  ? `<span class="text-[10px] bg-green-100 text-green-700 px-xs py-px rounded font-bold">OK</span>`
                  : `<span class="text-[10px] bg-amber-100 text-amber-700 px-xs py-px rounded font-bold">PEND</span>`}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      ` : noDataBanner()}
    </div>
  `;

  // ── Listeners ──────────────────────────────────────────────
  document.getElementById('hist-csv')?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const parsed = parseHistCSV(ev.target.result);
      if (!parsed.length) { showAlert('No se encontraron filas válidas en el CSV.', 'error'); return; }
      histData = parsed;
      histPage = 0;
      histFilterGrupo  = 'all';
      histFilterEstado = 'all';
      ccfg.histMeta = {
        uploadDate: formatDateDDMMYYYY(new Date()),
        rowCount:   parsed.length,
        fileName:   file.name
      };
      saveDatabase(getDatabase());
      showAlert(`${parsed.length.toLocaleString()} filas cargadas correctamente.`);
      renderHistorico(content, db, ccfg);
    };
    reader.readAsText(file, 'windows-1252');
  });

  document.getElementById('hist-clear')?.addEventListener('click', () => {
    if (!confirm('¿Vaciar datos en memoria? (deberá cargar el CSV nuevamente)')) return;
    histData = [];
    histPage = 0;
    ccfg.histMeta = { uploadDate: null, rowCount: 0, fileName: '' };
    saveDatabase(getDatabase());
    renderHistorico(content, db, ccfg);
  });

  document.getElementById('hist-fg')?.addEventListener('change', (e) => {
    histFilterGrupo = e.target.value; histPage = 0;
    renderHistorico(content, db, ccfg);
  });
  document.getElementById('hist-fe')?.addEventListener('change', (e) => {
    histFilterEstado = e.target.value; histPage = 0;
    renderHistorico(content, db, ccfg);
  });
  document.getElementById('hist-prev')?.addEventListener('click', () => {
    histPage--; renderHistorico(content, db, ccfg);
  });
  document.getElementById('hist-next')?.addEventListener('click', () => {
    histPage++; renderHistorico(content, db, ccfg);
  });
}

function statCard(label, value, icon, valueClass = 'text-primary') {
  return `<div class="bg-surface border border-outline-variant rounded p-sm flex items-center gap-sm">
    <span class="material-symbols-outlined text-[24px] text-outline-variant">${icon}</span>
    <div>
      <div class="font-label-caps text-label-caps text-secondary uppercase">${label}</div>
      <div class="font-bold font-data-mono text-data-mono ${valueClass}">${value}</div>
    </div>
  </div>`;
}

// ═══════════════════════════════════════════════════════════════
// VISTA 2: CONSOLIDACIÓN
// ═══════════════════════════════════════════════════════════════
function renderConsolidacion(content, db, ccfg) {
  if (!histData.length) {
    content.innerHTML = `<div class="bg-surface-container-lowest border border-outline-variant p-lg shadow-sm">${noDataBanner()}</div>`;
    return;
  }

  const grupos = allGroups();

  // ── Calcular consolidación por grupo × bucket ─────────────
  // Para cada grupo+bucket: por cada Documento único → fill = Σton / capBucket (max 1)
  // Consolidación media = media de fills de todos los documentos
  const stats = {}; // { grupo: { bucket: { docs, avgFill, totalTon, totalGasto } } }

  grupos.forEach(g => {
    stats[g] = {};
    CAP_BUCKETS.forEach(bkt => {
      const rows = histData.filter(r => getCentroGroup(r.oficina) === g && getCapBucket(r.capTons) === bkt);
      if (!rows.length) { stats[g][bkt] = null; return; }
      // Agrupar por documento
      const docMap = new Map();
      rows.forEach(r => {
        if (!docMap.has(r.documento)) docMap.set(r.documento, { tons: 0, gasto: r.gasto });
        docMap.get(r.documento).tons += r.ton;
      });
      const fills     = [...docMap.values()].map(d => Math.min(d.tons / bkt, 1));
      const avgFill   = fills.reduce((s, f) => s + f, 0) / fills.length;
      const totalTon  = rows.reduce((s, r) => s + r.ton, 0);
      const totalGasto= [...docMap.values()].reduce((s, d) => s + d.gasto, 0);
      stats[g][bkt] = { docs: docMap.size, avgFill, totalTon, totalGasto };
    });
  });

  content.innerHTML = `
    <div class="bg-surface-container-lowest border border-outline-variant p-lg shadow-sm">
      <div class="flex items-center gap-sm mb-md border-b border-outline-variant pb-sm">
        <span class="material-symbols-outlined text-primary">inventory</span>
        <h2 class="font-headline-sm text-headline-sm font-bold text-on-surface">Consolidación de Flota por Centro y Tipo de Camión</h2>
      </div>
      <p class="text-[12px] text-secondary mb-md">Consolidación = promedio del factor de carga por despacho (Ton_despachadas / Cap_camión, máx 100%). El campo <b>Objetivo (%)</b> permite definir una meta editable por centro.</p>

      ${grupos.map(g => `
        <div class="mb-lg">
          <h3 class="font-headline-sm text-headline-sm font-bold text-on-surface mb-sm">${g}</h3>
          <div class="bg-surface border border-outline-variant rounded overflow-x-auto">
            <table class="w-full border-collapse text-[13px]">
              <thead>
                <tr class="bg-surface-container-high border-b border-outline-variant text-left">
                  <th class="p-md font-label-caps text-secondary uppercase">Camión</th>
                  <th class="p-md font-label-caps text-secondary uppercase text-right">Despachos</th>
                  <th class="p-md font-label-caps text-secondary uppercase text-right">Consolidación</th>
                  <th class="p-md font-label-caps text-secondary uppercase">Barra</th>
                  <th class="p-md font-label-caps text-secondary uppercase text-right">Objetivo (%)</th>
                  <th class="p-md font-label-caps text-secondary uppercase text-right">Ton Total</th>
                  <th class="p-md font-label-caps text-secondary uppercase text-right">Gasto Total</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-outline-variant">
                ${CAP_BUCKETS.map(bkt => {
                  const s = stats[g][bkt];
                  if (!s) return `<tr><td class="p-md text-secondary" colspan="7">${CAP_LABELS[bkt]} — sin movimiento</td></tr>`;
                  const pct = (s.avgFill * 100).toFixed(1);
                  const objetivoKey = `consolidacionObjetivo.${g}.${bkt}`;
                  const objetivo   = getPath(ccfg, objetivoKey, 80);
                  const barColor   = s.avgFill >= 0.85 ? '#16a34a' : s.avgFill >= 0.65 ? '#d97706' : '#b5000b';
                  return `<tr class="hover:bg-surface-container-low">
                    <td class="p-md font-bold">${CAP_LABELS[bkt]}</td>
                    <td class="p-md text-right font-data-mono">${s.docs.toLocaleString()}</td>
                    <td class="p-md text-right font-data-mono font-bold" style="color:${barColor}">${pct}%</td>
                    <td class="p-md w-40">
                      <div class="h-2 bg-surface-container-high rounded overflow-hidden">
                        <div class="h-2 rounded" style="width:${Math.min(s.avgFill*100,100)}%;background:${barColor}"></div>
                      </div>
                    </td>
                    <td class="p-md w-28">${numInput(objetivoKey, objetivo)}</td>
                    <td class="p-md text-right font-data-mono">${s.totalTon.toFixed(1)} T</td>
                    <td class="p-md text-right font-data-mono">${formatCLP(s.totalGasto)}</td>
                  </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════
// VISTA 3: DENSIDAD LOGÍSTICA
// ═══════════════════════════════════════════════════════════════
function renderDensidad(content, db, ccfg) {
  if (!histData.length) {
    content.innerHTML = `<div class="bg-surface-container-lowest border border-outline-variant p-lg shadow-sm">${noDataBanner()}</div>`;
    return;
  }

  const grupos = allGroups();
  const filtro = ccfg.densidadFiltro || grupos[0] || 'all';

  // Filas del grupo seleccionado
  const rowsGrupo = histData.filter(r =>
    filtro === 'all' || getCentroGroup(r.oficina) === filtro
  );

  // Totales del centro (base para porcentajes)
  const centroClientes = new Set(rowsGrupo.map(r => r.idCliente).filter(x => x && x !== '-')).size;
  const centroObras    = new Set(rowsGrupo.map(r => r.idObra).filter(x => x && x !== '-')).size;
  const centroTon      = rowsGrupo.reduce((s, r) => s + r.ton, 0);

  // Agrupar por ID Ruta, sólo REGIONALES
  // Consideramos regional si no es interregional (heurística + db.routes)
  const rutaMap = new Map();
  rowsGrupo.forEach(r => {
    const interreg = isInterregional(db, r.idRuta, r.oficina);
    if (interreg) return; // excluir interregionales
    if (!rutaMap.has(r.idRuta)) rutaMap.set(r.idRuta, { clientes: new Set(), obras: new Set(), ton: 0, tipo: 'Desconocido' });
    const entry = rutaMap.get(r.idRuta);
    if (r.idCliente && r.idCliente !== '-') entry.clientes.add(r.idCliente);
    if (r.idObra    && r.idObra    !== '-') entry.obras.add(r.idObra);
    entry.ton += r.ton;
    const dbRoute = findRoute(db, r.idRuta);
    if (dbRoute) entry.tipo = dbRoute.tipo || 'Desconocido';
  });

  // Calcular indicador de densidad por ruta
  const rutaDensidad = [...rutaMap.entries()].map(([idRuta, d]) => {
    const pctCli  = centroClientes > 0 ? (d.clientes.size / centroClientes) * 100 : 0;
    const pctObra = centroObras    > 0 ? (d.obras.size    / centroObras)    * 100 : 0;
    const pctTon  = centroTon      > 0 ? (d.ton           / centroTon)      * 100 : 0;
    const densidad = (pctCli + pctObra + pctTon) / 3;
    const dbRoute = findRoute(db, idRuta);
    return { idRuta, destino: dbRoute?.destino || idRuta, tipo: d.tipo, clientes: d.clientes.size, obras: d.obras.size, ton: d.ton, pctCli, pctObra, pctTon, densidad };
  }).sort((a, b) => b.densidad - a.densidad);

  content.innerHTML = `
    <div class="bg-surface-container-lowest border border-outline-variant p-lg shadow-sm">
      <div class="flex items-center justify-between mb-md border-b border-outline-variant pb-sm flex-wrap gap-sm">
        <div class="flex items-center gap-sm">
          <span class="material-symbols-outlined text-primary">location_on</span>
          <h2 class="font-headline-sm text-headline-sm font-bold text-on-surface">Densidad Logística — Rutas Regionales</h2>
        </div>
        <div class="flex items-center gap-sm">
          <label class="font-label-caps text-label-caps text-secondary uppercase text-[11px]">Centro:</label>
          <select id="den-filtro" class="${selectCls}">
            <option value="all" ${filtro === 'all' ? 'selected' : ''}>Todos</option>
            ${grupos.map(g => `<option value="${g}" ${filtro === g ? 'selected' : ''}>${g}</option>`).join('')}
          </select>
        </div>
      </div>
      <p class="text-[12px] text-secondary mb-md">Indicador = promedio de (% clientes únicos + % obras únicas + % toneladas) respecto al total del centro. Sólo rutas regionales. Rutas interregionales se muestran como SPOT en Cluster.</p>

      <div class="grid grid-cols-3 gap-sm mb-md">
        ${statCard('Clientes únicos', centroClientes.toLocaleString(), 'person')}
        ${statCard('Obras únicas', centroObras.toLocaleString(), 'construction')}
        ${statCard('Ton. Regional', centroTon.toFixed(1) + ' T', 'scale')}
      </div>

      <div class="bg-surface border border-outline-variant rounded overflow-x-auto">
        <table class="w-full border-collapse text-[12px]">
          <thead>
            <tr class="bg-surface-container-high border-b border-outline-variant text-left">
              <th class="p-md font-label-caps text-secondary uppercase">#</th>
              <th class="p-md font-label-caps text-secondary uppercase">Ruta</th>
              <th class="p-md font-label-caps text-secondary uppercase">Tipo</th>
              <th class="p-md font-label-caps text-secondary uppercase text-right">Clientes</th>
              <th class="p-md font-label-caps text-secondary uppercase text-right">Obras</th>
              <th class="p-md font-label-caps text-secondary uppercase text-right">Ton</th>
              <th class="p-md font-label-caps text-secondary uppercase text-right">Densidad</th>
              <th class="p-md font-label-caps text-secondary uppercase w-36">Barra</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-outline-variant">
            ${rutaDensidad.length === 0
              ? `<tr><td colspan="8" class="p-md text-center text-secondary">No hay rutas regionales con movimiento para este filtro.</td></tr>`
              : rutaDensidad.map((r, i) => {
                const barColor = r.densidad >= 15 ? '#b5000b' : r.densidad >= 5 ? '#d97706' : '#6b7280';
                const barW = Math.min(r.densidad / (rutaDensidad[0]?.densidad || 1) * 100, 100);
                return `<tr class="hover:bg-surface-container-low">
                  <td class="p-md text-secondary">${i + 1}</td>
                  <td class="p-md font-bold">${r.idRuta}${r.destino !== r.idRuta ? ` <span class="text-secondary font-normal">— ${r.destino}</span>` : ''}</td>
                  <td class="p-md"><span class="text-[10px] px-xs py-px rounded border border-outline-variant">${r.tipo}</span></td>
                  <td class="p-md text-right font-data-mono">${r.clientes} <span class="text-secondary text-[10px]">(${r.pctCli.toFixed(1)}%)</span></td>
                  <td class="p-md text-right font-data-mono">${r.obras} <span class="text-secondary text-[10px]">(${r.pctObra.toFixed(1)}%)</span></td>
                  <td class="p-md text-right font-data-mono">${r.ton.toFixed(1)} <span class="text-secondary text-[10px]">(${r.pctTon.toFixed(1)}%)</span></td>
                  <td class="p-md text-right font-data-mono font-bold" style="color:${barColor}">${r.densidad.toFixed(2)}%</td>
                  <td class="p-md">
                    <div class="h-2 bg-surface-container-high rounded overflow-hidden">
                      <div class="h-2 rounded" style="width:${barW}%;background:${barColor}"></div>
                    </div>
                  </td>
                </tr>`;
              }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  document.getElementById('den-filtro')?.addEventListener('change', (e) => {
    ccfg.densidadFiltro = e.target.value;
    saveDatabase(getDatabase());
    renderDensidad(content, db, ccfg);
  });
}

// ═══════════════════════════════════════════════════════════════
// VISTA 4: FRECUENCIA Y ESPECIALES
// ═══════════════════════════════════════════════════════════════
function renderEspeciales(content, db, ccfg) {
  const centres = db.logisticsCentres || [];

  content.innerHTML = `
    <div class="space-y-lg">

      <!-- Definición de Clusters -->
      <div class="bg-surface-container-lowest border border-outline-variant p-lg shadow-sm">
        <div class="flex items-center gap-sm mb-md border-b border-outline-variant pb-sm">
          <span class="material-symbols-outlined text-primary">category</span>
          <h2 class="font-headline-sm text-headline-sm font-bold text-on-surface">Definición de Clusters</h2>
        </div>
        <div class="bg-surface border border-outline-variant rounded overflow-x-auto">
          <table class="w-full border-collapse text-[13px]">
            <thead>
              <tr class="bg-surface-container-high border-b border-outline-variant text-left">
                <th class="p-md font-label-caps text-secondary uppercase">Cluster</th>
                <th class="p-md font-label-caps text-secondary uppercase">Nombre</th>
                <th class="p-md font-label-caps text-secondary uppercase">Color</th>
                <th class="p-md font-label-caps text-secondary uppercase text-right">NV (%)</th>
                <th class="p-md font-label-caps text-secondary uppercase">Frecuencia Operativa</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-outline-variant">
              ${CLUSTER_KEYS.map(k => `
                <tr>
                  <td class="p-md">
                    <span class="inline-block w-3 h-3 rounded-full mr-xs" style="background:${ccfg.clusterColors[k] || DEFAULT_CLUSTER_COLORS[k]}"></span>
                    <span class="font-bold">${k === 'spot' ? 'SPOT' : `Cluster ${k}`}</span>
                  </td>
                  <td class="p-md w-48">${textInput(`clusterNames.${k}`, ccfg.clusterNames[k])}</td>
                  <td class="p-md">${colorInput(`clusterColors.${k}`, ccfg.clusterColors[k])}</td>
                  <td class="p-md w-28">${numInput(`clusterNV.${k}`, ccfg.clusterNV[k])}</td>
                  <td class="p-md">${textInput(`clusterFrecuencia.${k}`, ccfg.clusterFrecuencia[k])}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <!-- Tarifa Especial Tipo 0000 por Cluster -->
      <div class="bg-surface-container-lowest border border-outline-variant p-lg shadow-sm">
        <div class="flex items-center gap-sm mb-md border-b border-outline-variant pb-sm">
          <span class="material-symbols-outlined text-primary">star</span>
          <h2 class="font-headline-sm text-headline-sm font-bold text-on-surface">Tarifa Especial Tipo "0000" por Cluster</h2>
        </div>
        <p class="text-[12px] text-secondary mb-md">Tarifa plana CLP por cluster. Se aplica cuando el tipo de tarifa es 0000 en la exportación ERP (ZFMI = ZFMP = ZFMX).</p>
        <div class="bg-surface border border-outline-variant rounded overflow-x-auto">
          <table class="w-full border-collapse text-[13px]">
            <thead>
              <tr class="bg-surface-container-high border-b border-outline-variant text-left">
                <th class="p-md font-label-caps text-secondary uppercase">Cluster</th>
                <th class="p-md font-label-caps text-secondary uppercase text-right">Tarifa Plana (CLP)</th>
                <th class="p-md font-label-caps text-secondary uppercase text-right">Preview</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-outline-variant">
              ${CLUSTER_KEYS.map(k => {
                const val = getPath(ccfg, `especiales.tipo0000.${k}`, 0);
                return `<tr>
                  <td class="p-md font-bold">${ccfg.clusterNames[k] || (k === 'spot' ? 'SPOT' : `Cluster ${k}`)}</td>
                  <td class="p-md w-48">${numInput(`especiales.tipo0000.${k}`, val)}</td>
                  <td class="p-md text-right font-data-mono text-secondary">${formatCLP(val)}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <!-- Recargo Exclusividad -->
      ${centres.length ? `
      <div class="bg-surface-container-lowest border border-outline-variant p-lg shadow-sm">
        <div class="flex items-center gap-sm mb-md border-b border-outline-variant pb-sm">
          <span class="material-symbols-outlined text-primary">lock</span>
          <h2 class="font-headline-sm text-headline-sm font-bold text-on-surface">Recargo por Exclusividad</h2>
        </div>
        <p class="text-[12px] text-secondary mb-md">Porcentaje adicional sobre ZFMI y ZFMP para filas con "Transporte Exclusivo = 1" en la exportación ERP.</p>
        <div class="bg-surface border border-outline-variant rounded overflow-x-auto">
          <table class="w-full border-collapse text-[13px]">
            <thead>
              <tr class="bg-surface-container-high border-b border-outline-variant text-left">
                <th class="p-md font-label-caps text-secondary uppercase">Centro Logístico</th>
                <th class="p-md font-label-caps text-secondary uppercase text-center">Activo</th>
                <th class="p-md font-label-caps text-secondary uppercase text-right">Recargo (%)</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-outline-variant">
              ${centres.map(cd => {
                const r = (ccfg.especiales.recargoExclusividad || {})[cd.id] || { activo: false, pct: 0 };
                return `<tr>
                  <td class="p-md font-bold">${cd.nombre}</td>
                  <td class="p-md text-center"><input type="checkbox" class="w-4 h-4 accent-primary" data-path="especiales.recargoExclusividad.${cd.id}.activo" data-refresh="true" ${r.activo ? 'checked' : ''}></td>
                  <td class="p-md w-32">${numInput(`especiales.recargoExclusividad.${cd.id}.pct`, r.pct)}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
      ` : ''}
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════
// VISTA 5: CLUSTER (mapa simplificado con marcadores)
// ═══════════════════════════════════════════════════════════════
function renderCluster(content, db, ccfg) {
  const routes = (db.routes || []).filter(r => r.activo !== false);

  // Enriquecer rutas con stats de histData
  const routeStats = {};
  if (histData.length) {
    histData.forEach(r => {
      const key = r.idRuta;
      if (!routeStats[key]) routeStats[key] = { ton: 0, docs: new Set(), interreg: isInterregional(db, r.idRuta, r.oficina) };
      routeStats[key].ton += r.ton;
      routeStats[key].docs.add(r.documento);
    });
  }

  // Cluster por ruta: usa ccfg.comunaCluster[ruta.id] o auto por interregional
  function getCluster(r) {
    if (ccfg.comunaCluster[r.id]) return ccfg.comunaCluster[r.id];
    const stats = routeStats[r.codigo];
    if (!stats) return '3';
    if (stats.interreg) return 'spot';
    return '3'; // default: Cluster 3 hasta que el usuario asigne
  }

  content.innerHTML = `
    <div class="bg-surface-container-lowest border border-outline-variant p-lg shadow-sm mb-lg">
      <div class="flex items-center gap-sm mb-md border-b border-outline-variant pb-sm">
        <span class="material-symbols-outlined text-primary">map</span>
        <h2 class="font-headline-sm text-headline-sm font-bold text-on-surface">Asignación de Clusters por Ruta</h2>
      </div>
      <p class="text-[12px] text-secondary mb-md">El mapa muestra las rutas con coordenadas configuradas. Las rutas interregionales (SPOT) se marcan automáticamente. Puede sobrescribir la asignación en la tabla.</p>

      <!-- Leyenda -->
      <div class="flex flex-wrap gap-sm mb-md">
        ${CLUSTER_KEYS.map(k => `
          <div class="flex items-center gap-xs bg-surface border border-outline-variant rounded px-sm py-xs">
            <span class="w-3 h-3 rounded-full inline-block" style="background:${ccfg.clusterColors[k] || DEFAULT_CLUSTER_COLORS[k]}"></span>
            <span class="text-[11px] font-bold text-on-surface">${ccfg.clusterNames[k] || (k === 'spot' ? 'SPOT' : `Cluster ${k}`)}</span>
          </div>`).join('')}
      </div>

      <!-- Mapa Leaflet -->
      <div id="ct-cluster-map" class="h-[380px] rounded-xl border border-outline-variant overflow-hidden mb-lg" style="z-index:1;"></div>

      <!-- Tabla de asignación -->
      <div class="bg-surface border border-outline-variant rounded overflow-x-auto max-h-[420px] overflow-y-auto">
        <table class="w-full border-collapse text-[12px]">
          <thead class="sticky top-0">
            <tr class="bg-surface-container-high border-b border-outline-variant text-left">
              <th class="p-md font-label-caps text-secondary uppercase">Ruta</th>
              <th class="p-md font-label-caps text-secondary uppercase">Destino</th>
              <th class="p-md font-label-caps text-secondary uppercase">Tipo</th>
              <th class="p-md font-label-caps text-secondary uppercase text-right">Ton (CSV)</th>
              <th class="p-md font-label-caps text-secondary uppercase">Cluster</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-outline-variant">
            ${routes.map(r => {
              const cluster = getCluster(r);
              const stats   = routeStats[r.codigo];
              const color   = ccfg.clusterColors[cluster] || DEFAULT_CLUSTER_COLORS[cluster];
              return `<tr class="hover:bg-surface-container-low">
                <td class="p-md font-bold font-data-mono">${r.codigo}</td>
                <td class="p-md">${r.destino || '—'}</td>
                <td class="p-md"><span class="text-[10px] px-xs py-px rounded border border-outline-variant">${r.tipo || '—'}</span></td>
                <td class="p-md text-right font-data-mono">${stats ? stats.ton.toFixed(1) + ' T' : '—'}</td>
                <td class="p-md">
                  <select class="${selectCls} text-[11px]" data-path="comunaCluster.${r.id}" data-refresh="true" style="border-left:4px solid ${color}">
                    ${CLUSTER_KEYS.map(k => `<option value="${k}" ${cluster === k ? 'selected' : ''}>${ccfg.clusterNames[k] || (k === 'spot' ? 'SPOT' : `Cluster ${k}`)}</option>`).join('')}
                  </select>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  // ── Mapa Leaflet ──────────────────────────────────────────
  try {
    const mapEl = document.getElementById('ct-cluster-map');
    if (!mapEl) return;
    // Destruir instancia anterior si existe
    if (mapEl._leaflet_id) mapEl.innerHTML = '';

    const mapObj = L.map('ct-cluster-map').setView([-37.5, -72], 5);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap &copy; CARTO'
    }).addTo(mapObj);

    const bounds = [];
    routes.forEach(r => {
      if (!r.lat || !r.lon) return;
      const cluster = getCluster(r);
      const color   = ccfg.clusterColors[cluster] || DEFAULT_CLUSTER_COLORS[cluster];
      const stats   = routeStats[r.codigo];
      // Radio proporcional a tonelaje (min 8, max 22)
      const ton     = stats ? stats.ton : 0;
      const maxTon  = Math.max(...routes.map(x => (routeStats[x.codigo]?.ton || 0)), 1);
      const radius  = 8 + (ton / maxTon) * 14;

      const marker = L.circleMarker([r.lat, r.lon], {
        radius, color, fillColor: color, fillOpacity: 0.75, weight: 2
      }).addTo(mapObj);
      marker.bindPopup(`
        <strong>${r.codigo} — ${r.destino}</strong><br>
        Cluster: <b>${ccfg.clusterNames[cluster] || cluster}</b><br>
        ${stats ? `Ton: ${stats.ton.toFixed(1)} T · Despachos: ${stats.docs.size}` : 'Sin datos CSV'}
      `);
      bounds.push([r.lat, r.lon]);
    });

    if (bounds.length > 0) mapObj.fitBounds(bounds, { padding: [30, 30] });
    else mapObj.setView([-33.4, -70.6], 6); // centrar en Santiago si no hay datos
  } catch (err) {
    console.error('Error mapa cluster:', err);
    const el = document.getElementById('ct-cluster-map');
    if (el) el.innerHTML = `<div class="flex items-center justify-center h-full text-secondary">Error al cargar el mapa.</div>`;
  }
}

// ═══════════════════════════════════════════════════════════════
// VISTA 6: RESULTADOS ZFMI / ZFMP / ZFMX (exportación ERP)
// ═══════════════════════════════════════════════════════════════
function calcularMatrizClientes(db, cfg, ccfg) {
  const rutas = (db.routes || []).filter(r => r.activo !== false);
  const out = [];

  rutas.forEach(ruta => {
    const tipos  = truckTypesWithCap(db, ruta.origenId);
    const clKey  = ccfg.comunaCluster[ruta.id];
    const cluster= clKey || 'spot';
    const factor = getPath(ccfg, `consolidacionObjetivo.${getCentroGroup('all')}.5`, 80) / 100; // fallback razonable
    const cd     = (db.logisticsCentres || []).find(c => c.id === ruta.origenId);
    const recargo= ((ccfg.especiales || {}).recargoExclusividad || {})[ruta.origenId] || { activo: false, pct: 0 };

    const m5  = calcularCostoRuta(db, cfg, ruta, 5000);
    const m28 = calcularCostoRuta(db, cfg, ruta, 28000);

    tipos.forEach(t => {
      const m     = calcularCostoRuta(db, cfg, ruta, t.capKg);
      const mNext = calcularCostoRuta(db, cfg, ruta, NEXT_CAP[t.capKg]);
      const zfmx  = Math.round(m.zcapConMargen);
      const zfmi  = Math.round(m5.zcapConMargen * Math.min(factor, 1));
      const zfmp  = NEXT_CAP[t.capKg] > 0 ? Math.round((mNext.zcapConMargen / NEXT_CAP[t.capKg]) * Math.min(factor, 1)) : 0;
      out.push({ ruta, truckType: t, centro: cd, cluster, zfmi, zfmp, zfmx, recargo, tipoEspecial: null });
    });

    // Tarifa 0000: según cluster
    const plana = Math.round(Number(getPath(ccfg, `especiales.tipo0000.${cluster}`, 0)) || 0);
    out.push({
      ruta, truckType: { type: 'Tarifa Especial 0000', capKg: 0 }, centro: cd, cluster,
      zfmi: plana, zfmp: plana, zfmx: plana, recargo, tipoEspecial: '0000'
    });

    // Tarifa 9999
    out.push({
      ruta, truckType: { type: 'Tarifa Especial 9999', capKg: 28000 }, centro: cd, cluster,
      zfmi: Math.round(m28.zcapConMargen),
      zfmp: Math.round(m28.zcapConMargen / 28000),
      zfmx: 10000000, recargo, tipoEspecial: '9999'
    });
  });
  return out;
}

function renderResultados(content, db, cfg, ccfg) {
  const matriz = calcularMatrizClientes(db, cfg, ccfg);
  const validoDe = formatDateDDMMYYYY(new Date());

  content.innerHTML = `
    <div class="bg-surface-container-lowest border border-outline-variant p-lg shadow-sm">
      <div class="flex items-center justify-between mb-md border-b border-outline-variant pb-sm flex-wrap gap-sm">
        <div class="flex items-center gap-sm">
          <span class="material-symbols-outlined text-primary">request_quote</span>
          <h2 class="font-headline-sm text-headline-sm font-bold text-on-surface">Resultados — ZFMI / ZFMP / ZFMX</h2>
        </div>
        <div class="flex gap-sm flex-wrap">
          <button id="exp-zfmi" class="bg-primary hover:bg-[#930007] text-white font-bold px-md py-sm rounded flex items-center gap-xs text-xs uppercase">
            <span class="material-symbols-outlined text-[18px]">download</span> ZFMI
          </button>
          <button id="exp-zfmx" class="bg-primary hover:bg-[#930007] text-white font-bold px-md py-sm rounded flex items-center gap-xs text-xs uppercase">
            <span class="material-symbols-outlined text-[18px]">download</span> ZFMX
          </button>
          <button id="exp-zfmp" class="bg-primary hover:bg-[#930007] text-white font-bold px-md py-sm rounded flex items-center gap-xs text-xs uppercase">
            <span class="material-symbols-outlined text-[18px]">download</span> ZFMP
          </button>
        </div>
      </div>
      <p class="text-[12px] text-secondary mb-md">ZFMI = tarifa mínima · ZFMP = precio por kg (tramo superior) · ZFMX = tarifa máxima (ZCAP + margen). Válido de: hoy · Validez a: ${VALIDEZ_A}.</p>

      <div class="bg-surface border border-outline-variant rounded overflow-x-auto">
        <table class="w-full border-collapse text-[12px]">
          <thead>
            <tr class="bg-surface-container-high border-b border-outline-variant text-left">
              <th class="p-md font-label-caps text-secondary uppercase">Centro</th>
              <th class="p-md font-label-caps text-secondary uppercase">Ruta</th>
              <th class="p-md font-label-caps text-secondary uppercase">Camión</th>
              <th class="p-md font-label-caps text-secondary uppercase text-center">Cluster</th>
              <th class="p-md font-label-caps text-secondary uppercase text-right">ZFMI</th>
              <th class="p-md font-label-caps text-secondary uppercase text-right">ZFMP ($/kg)</th>
              <th class="p-md font-label-caps text-secondary uppercase text-right bg-primary/5">ZFMX</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-outline-variant">
            ${matriz.map(m => {
              const color = ccfg.clusterColors[m.cluster] || DEFAULT_CLUSTER_COLORS[m.cluster];
              return `<tr class="hover:bg-surface-container-low">
                <td class="p-md">${m.centro?.nombre || '—'}</td>
                <td class="p-md font-bold">${m.ruta.codigo} — ${m.ruta.destino}</td>
                <td class="p-md">${m.truckType.type}</td>
                <td class="p-md text-center">
                  <span class="inline-flex items-center px-2 py-px rounded font-label-caps text-[10px] text-white" style="background:${color}">${m.cluster.toUpperCase()}</span>
                </td>
                <td class="p-md text-right font-data-mono">${formatCLP(m.zfmi)}</td>
                <td class="p-md text-right font-data-mono">${formatCLP(m.zfmp)}</td>
                <td class="p-md text-right font-data-mono font-bold bg-primary/5">${formatCLP(m.zfmx)}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  function expandExclusividad(m, base) {
    const pct = m.recargo.activo ? (Number(m.recargo.pct) || 0) : 0;
    return [{ ex: 0, val: base }, { ex: 1, val: Math.round(base * (1 + pct / 100)) }];
  }
  function rutaIdExp(m)  { return m.tipoEspecial || m.ruta.codigo; }
  function capKgExp(m)   { return m.tipoEspecial === '0000' ? 0 : m.truckType.capKg; }

  document.getElementById('exp-zfmi')?.addEventListener('click', () => {
    const headers = ['Codigo_Centro','Ruta_ID','Destino_Comuna','Tipo_Camion_Kg','Tipo_Tarifa','Valor','Transporte_Exclusivo','Valido_de','Validez_a'];
    const rows = [];
    matriz.forEach(m => expandExclusividad(m, m.zfmi).forEach(e =>
      rows.push([m.centro?.id || '', rutaIdExp(m), m.ruta.destino, capKgExp(m), 'ZFMI', e.val, e.ex, validoDe, VALIDEZ_A])
    ));
    downloadFile(`zfmi_${Date.now()}.csv`, toCSV(headers, rows));
    showAlert('ZFMI exportado para ERP');
  });
  document.getElementById('exp-zfmx')?.addEventListener('click', () => {
    const headers = ['Codigo_Centro','Ruta_ID','Destino_Comuna','Tipo_Camion_Kg','Tipo_Tarifa','Valor','Transporte_Exclusivo','Valido_de','Validez_a'];
    const rows = [];
    matriz.forEach(m => expandExclusividad(m, m.zfmx).forEach(e =>
      rows.push([m.centro?.id || '', rutaIdExp(m), m.ruta.destino, capKgExp(m), 'ZFMX', e.val, e.ex, validoDe, VALIDEZ_A])
    ));
    downloadFile(`zfmx_${Date.now()}.csv`, toCSV(headers, rows));
    showAlert('ZFMX exportado para ERP');
  });
  document.getElementById('exp-zfmp')?.addEventListener('click', () => {
    const headers = ['Codigo_Centro','Ruta_ID','Destino_Comuna','Tipo_Camion_Kg','UM','Valor_KG','Transporte_Exclusivo','Valido_de','Validez_a'];
    const rows = [];
    matriz.forEach(m => expandExclusividad(m, m.zfmp).forEach(e =>
      rows.push([m.centro?.id || '', rutaIdExp(m), m.ruta.destino, capKgExp(m), 'KG', e.val, e.ex, validoDe, VALIDEZ_A])
    ));
    downloadFile(`zfmp_${Date.now()}.csv`, toCSV(headers, rows));
    showAlert('ZFMP exportado para ERP');
  });
}
