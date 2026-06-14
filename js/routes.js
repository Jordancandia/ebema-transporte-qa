import { getDatabase, saveDatabase, getCentreName } from './data.js';
import { generateSapCode, parseCSV, showAlert, geocodeAddress, escapeHtml } from './utils.js';
import { renderLogisticsView } from './logistics.js';
import { renderZonasView } from './zonas-transporte.js';
import { REGIONES, COMUNAS_POR_REGION, TIPOS_ZONA, GRUPOS_ORIGEN, findRegionByComuna } from './chile-geo.js';

// Estilos de la característica especial de la ruta (usada por el motor de tarifas)
const CARACT_STYLES = {
  'NORMAL':  'bg-surface-container-high text-secondary border border-outline-variant',
  'EXTREMA': 'bg-amber-100 text-amber-800 border border-amber-300',
  'ISLA':    'bg-blue-100 text-blue-800 border border-blue-300'
};

// Calcular distancia por carretera entre el CD de origen y el destino (OSRM + Nominatim)
async function calcularDistanciaAuto(cdOrigen, destinoTexto) {
  const coordsDestino = await geocodeAddress(destinoTexto);
  if (!coordsDestino || !coordsDestino.lat) throw new Error('No se pudo geolocalizar el destino');
  const url = `https://router.project-osrm.org/route/v1/driving/${cdOrigen.lon},${cdOrigen.lat};${coordsDestino.lon},${coordsDestino.lat}?overview=false`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('Servicio de rutas no disponible');
  const data = await resp.json();
  if (!data.routes || !data.routes[0]) throw new Error('No se encontró ruta por carretera');
  return { km: Math.round(data.routes[0].distance / 1000), lat: coordsDestino.lat, lon: coordsDestino.lon };
}

// Resolver el ID de un Centro Logístico a partir de su Grupo de Origen (despacho compartido)
function resolveOrigenIdFromGrupo(db, grupo) {
  if (!grupo) return (db.logisticsCentres[0] && db.logisticsCentres[0].id) || null;
  const cd = (db.logisticsCentres || []).find(c => String(c.origen_grupo || '').toUpperCase() === String(grupo).toUpperCase());
  return cd ? cd.id : ((db.logisticsCentres[0] && db.logisticsCentres[0].id) || null);
}

// Indica si a una ruta le falta completar campos clave (Zona, Comuna, Región, KM o Georreferencia)
function rutaIncompleta(r) {
  return !r.id_zona_transporte || !r.comuna || !r.region || !r.km || !r.georef_estado;
}

function fillRegionSelectRoutes(selectEl, selected) {
  selectEl.innerHTML = '<option value="">— Sin definir —</option>' +
    REGIONES.map(reg => `<option value="${escapeHtml(reg)}" ${reg === selected ? 'selected' : ''}>${escapeHtml(reg)}</option>`).join('');
}

function fillComunaSelectRoutes(selectEl, region, selected) {
  const comunas = COMUNAS_POR_REGION[region] || [];
  let opciones = '<option value="">— Sin definir —</option>';
  if (selected && !comunas.includes(selected)) {
    opciones += `<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)} (no estándar)</option>`;
  }
  opciones += comunas.map(c => `<option value="${escapeHtml(c)}" ${c === selected ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('');
  selectEl.innerHTML = opciones;
}

let editingRouteId = null;
let currentRoutesSubTab = 'rutas';

// Página unificada "Rutas de Transporte": combina Rutas, Zonas de Transporte y Centros Logísticos en sub-pestañas
export function renderRoutesView(container) {
  container.innerHTML = `
    <!-- Page Header -->
    <div class="mb-lg">
      <h1 class="font-headline-lg text-headline-lg text-on-surface">Rutas de Transporte</h1>
      <p class="font-body-lg text-body-lg text-secondary">Administre las zonas de transporte (destinos), las rutas de despacho y los centros logísticos (CD) de origen.</p>
    </div>

    <!-- Sub-pestañas -->
    <div class="flex gap-sm mb-lg border-b border-outline-variant">
      <button class="rutas-subtab-btn px-md py-sm font-bold text-xs uppercase tracking-wider cursor-pointer border-b-2 transition-all flex items-center gap-xs ${currentRoutesSubTab === 'rutas' ? 'border-primary text-primary' : 'border-transparent text-secondary hover:text-primary'}" data-subtab="rutas">
        <span class="material-symbols-outlined text-[18px]">route</span> Rutas
      </button>
      <button class="rutas-subtab-btn px-md py-sm font-bold text-xs uppercase tracking-wider cursor-pointer border-b-2 transition-all flex items-center gap-xs ${currentRoutesSubTab === 'zonas' ? 'border-primary text-primary' : 'border-transparent text-secondary hover:text-primary'}" data-subtab="zonas">
        <span class="material-symbols-outlined text-[18px]">map</span> Zonas de Transporte
      </button>
      <button class="rutas-subtab-btn px-md py-sm font-bold text-xs uppercase tracking-wider cursor-pointer border-b-2 transition-all flex items-center gap-xs ${currentRoutesSubTab === 'centros' ? 'border-primary text-primary' : 'border-transparent text-secondary hover:text-primary'}" data-subtab="centros">
        <span class="material-symbols-outlined text-[18px]">location_on</span> Centros Logísticos
      </button>
    </div>

    <div id="rutas-subview-content"></div>
  `;

  container.querySelectorAll('.rutas-subtab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      currentRoutesSubTab = btn.getAttribute('data-subtab');
      renderRoutesView(container);
    });
  });

  const subContent = document.getElementById('rutas-subview-content');
  if (currentRoutesSubTab === 'centros') {
    renderLogisticsView(subContent);
  } else if (currentRoutesSubTab === 'zonas') {
    renderZonasView(subContent);
  } else {
    renderRutasSubview(subContent);
  }
}

function renderRutasSubview(container) {
  const db = getDatabase();
  const routes = db.routes;
  const zonas = db.transportZones || [];

  // Calcular KPIs
  const totalRoutes = routes.length;
  const activeRoutes = routes.filter(r => r.activo).length;
  const enErp = routes.filter(r => r.estado_erp).length;
  const sinGeoref = routes.filter(r => !r.georef_estado).length;

  container.innerHTML = `
    <!-- Tarjetas de Estadísticas KPI -->
    <div class="grid grid-cols-1 md:grid-cols-4 gap-lg mb-xl">
      <div class="bg-surface border border-outline-variant p-md shadow-sm rounded flex items-center justify-between">
        <div>
          <h4 class="font-label-caps text-label-caps text-secondary uppercase">Total Rutas</h4>
          <div class="font-headline-md text-headline-md font-bold text-on-surface mt-1">${totalRoutes}</div>
        </div>
        <span class="material-symbols-outlined text-[32px] text-secondary">route</span>
      </div>
      <div class="bg-surface border border-outline-variant p-md shadow-sm rounded flex items-center justify-between">
        <div>
          <h4 class="font-label-caps text-label-caps text-secondary uppercase">Rutas Activas</h4>
          <div class="font-headline-md text-headline-md font-bold text-green-700 mt-1">${activeRoutes}</div>
        </div>
        <span class="material-symbols-outlined text-[32px] text-green-600">check_circle</span>
      </div>
      <div class="bg-surface border border-outline-variant p-md shadow-sm rounded flex items-center justify-between">
        <div>
          <h4 class="font-label-caps text-label-caps text-secondary uppercase">Creadas en ERP</h4>
          <div class="font-headline-md text-headline-md font-bold text-primary mt-1">${enErp}</div>
        </div>
        <span class="material-symbols-outlined text-[32px] text-primary">inventory</span>
      </div>
      <div class="bg-surface border border-outline-variant p-md shadow-sm rounded border-l-4 border-amber-400 flex items-center justify-between">
        <div>
          <h4 class="font-label-caps text-label-caps text-secondary uppercase">Sin Georreferenciar</h4>
          <div class="font-headline-md text-headline-md font-bold text-amber-600 mt-1">${sinGeoref}</div>
        </div>
        <span class="material-symbols-outlined text-[32px] text-amber-500">my_location</span>
      </div>
    </div>

    <!-- Tabla de Rutas -->
    <div class="bg-surface border border-outline-variant rounded shadow-sm overflow-hidden">
      <!-- Barra superior de filtros -->
      <div class="p-md border-b border-outline-variant flex flex-col md:flex-row justify-between items-center gap-md bg-white">
        <div class="relative w-full md:w-96 focus-within:ring-2 focus-within:ring-primary rounded overflow-hidden">
          <span class="material-symbols-outlined absolute left-sm top-1/2 -translate-y-1/2 text-secondary">search</span>
          <input type="text" id="route-search" class="w-full bg-surface-container-low border-none pl-10 pr-md py-xs font-body-md text-body-md focus:outline-none" placeholder="Buscar por ID Ruta, Origen, Destino, Comuna, Región...">
        </div>

        <div class="flex gap-sm w-full md:w-auto">
          <button id="btn-bulk-upload-routes" class="flex-1 md:flex-none border border-secondary text-secondary hover:bg-surface-container-high font-bold px-md py-sm rounded active:scale-[0.98] transition-all flex items-center justify-center gap-sm cursor-pointer text-xs uppercase tracking-wider">
            <span class="material-symbols-outlined text-[18px]">upload_file</span>
            Carga Masiva (CSV)
          </button>
          <button id="btn-create-route" class="flex-1 md:flex-none bg-primary hover:bg-[#930007] text-white font-bold px-md py-sm rounded active:scale-[0.98] transition-all flex items-center justify-center gap-sm cursor-pointer text-xs uppercase tracking-wider shadow">
            <span class="material-symbols-outlined text-[18px]">add</span>
            Nueva Ruta
          </button>
        </div>
      </div>

      <!-- Tabla Responsiva -->
      <div class="overflow-x-auto">
        <table class="w-full text-left border-collapse">
          <thead>
            <tr class="bg-surface-container-high border-b border-outline-variant text-[11px] font-bold text-secondary uppercase tracking-wider">
              <th class="p-md">ID Ruta</th>
              <th class="p-md">Denominación</th>
              <th class="p-md">Origen</th>
              <th class="p-md">ID Zona</th>
              <th class="p-md">Destino</th>
              <th class="p-md">Comuna</th>
              <th class="p-md">Región</th>
              <th class="p-md">Tipo</th>
              <th class="p-md">Clasificación</th>
              <th class="p-md">KM</th>
              <th class="p-md">Estado ERP</th>
              <th class="p-md">Georreferencia</th>
              <th class="p-md">Estado Georref.</th>
              <th class="p-md">Vigencia</th>
              <th class="p-md text-center">Acciones</th>
            </tr>
          </thead>
          <tbody id="routes-table-body" class="font-body-md text-body-md">
            <!-- Cargado dinámicamente -->
          </tbody>
        </table>
      </div>
    </div>

    <!-- Modal Formulario (Crear/Editar) -->
    <div class="modal-overlay fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center opacity-0 pointer-events-none transition-opacity duration-300" id="route-modal">
      <div class="modal-window w-[640px] max-w-[90vw] bg-white border border-outline-variant shadow-lg rounded-xl overflow-hidden transform scale-95 transition-transform duration-300 max-h-[90vh] overflow-y-auto">
        <div class="p-md border-b border-outline-variant flex justify-between items-center bg-surface-container-low sticky top-0 z-10">
          <h4 id="route-modal-title" class="font-headline-sm text-headline-sm font-bold text-on-surface">Nueva Ruta</h4>
          <button class="text-secondary hover:text-primary cursor-pointer" id="btn-close-route-modal">
            <span class="material-symbols-outlined text-[24px]">close</span>
          </button>
        </div>
        <form id="route-form">
          <div class="p-lg space-y-md">

            ${zonas.length === 0 ? `
            <div class="p-sm bg-amber-50 border border-amber-300 rounded text-xs text-amber-800 flex items-center gap-xs">
              <span class="material-symbols-outlined text-[18px]">warning</span>
              Aún no hay Zonas de Transporte registradas. Vaya a la pestaña "Zonas de Transporte" para crear al menos una antes de registrar rutas.
            </div>` : ''}

            <div class="grid grid-cols-1 md:grid-cols-2 gap-md">
              <div class="space-y-xs">
                <label for="r-codigo" class="font-label-caps text-label-caps text-secondary block">ID RUTA</label>
                <input type="text" id="r-codigo" class="w-full border border-[#CED4DA] p-sm font-body-md text-body-md focus:border-primary focus:ring-0 transition-all rounded bg-white" required placeholder="Ej: RUT-SAP-001">
              </div>
              <div class="space-y-xs">
                <label for="r-origen" class="font-label-caps text-label-caps text-secondary block">ORIGEN</label>
                <select id="r-origen" class="w-full border border-[#CED4DA] p-sm font-body-md text-body-md focus:border-primary focus:ring-0 transition-all rounded bg-white" required>
                  <option value="">— Seleccione —</option>
                  ${GRUPOS_ORIGEN.map(g => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join('')}
                </select>
              </div>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-md">
              <div class="space-y-xs">
                <label for="r-zona" class="font-label-caps text-label-caps text-secondary block">ID ZONA DE TRANSPORTE</label>
                <select id="r-zona" class="w-full border border-[#CED4DA] p-sm font-body-md text-body-md focus:border-primary focus:ring-0 transition-all rounded bg-white" required>
                  <option value="">— Seleccione —</option>
                  ${zonas.map(z => `<option value="${escapeHtml(z.zona)}">${escapeHtml(z.zona)} — ${escapeHtml(z.denominacion)}</option>`).join('')}
                </select>
              </div>
              <div class="space-y-xs">
                <label for="r-destino" class="font-label-caps text-label-caps text-secondary block">DESTINO</label>
                <input type="text" id="r-destino" class="w-full border border-[#CED4DA] p-sm font-body-md text-body-md bg-surface-container-low" readonly placeholder="Se completa según la Zona seleccionada">
              </div>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-md">
              <div class="space-y-xs">
                <label for="r-region" class="font-label-caps text-label-caps text-secondary block">REGIÓN</label>
                <select id="r-region" class="w-full border border-[#CED4DA] p-sm font-body-md text-body-md focus:border-primary focus:ring-0 transition-all rounded bg-white" required>
                  <!-- Cargado dinámicamente -->
                </select>
              </div>
              <div class="space-y-xs">
                <label for="r-comuna" class="font-label-caps text-label-caps text-secondary block">COMUNA</label>
                <select id="r-comuna" class="w-full border border-[#CED4DA] p-sm font-body-md text-body-md focus:border-primary focus:ring-0 transition-all rounded bg-white" required>
                  <!-- Cargado dinámicamente según región -->
                </select>
              </div>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-md">
              <div class="space-y-xs">
                <label for="r-tipo-ruta" class="font-label-caps text-label-caps text-secondary block">TIPO</label>
                <select id="r-tipo-ruta" class="w-full border border-[#CED4DA] p-sm font-body-md text-body-md focus:border-primary focus:ring-0 transition-all rounded bg-white" required>
                  <option value="Regional">Regional</option>
                  <option value="Interregional">Interregional</option>
                </select>
              </div>
              <div class="space-y-xs">
                <label for="r-clasificacion" class="font-label-caps text-label-caps text-secondary block">CLASIFICACIÓN</label>
                <select id="r-clasificacion" class="w-full border border-[#CED4DA] p-sm font-body-md text-body-md focus:border-primary focus:ring-0 transition-all rounded bg-white" required>
                  ${TIPOS_ZONA.map(t => `<option value="${t}">${t}</option>`).join('')}
                </select>
              </div>
            </div>

            <div class="space-y-xs">
              <label for="r-denominacion" class="font-label-caps text-label-caps text-secondary block">DENOMINACIÓN (ORIGEN - DESTINO)</label>
              <input type="text" id="r-denominacion" class="w-full border border-[#CED4DA] p-sm font-body-md text-body-md focus:border-primary focus:ring-0 transition-all rounded bg-white" placeholder="Se genera automáticamente desde el origen y destino" required>
            </div>

            <div class="space-y-xs">
              <label for="r-km" class="font-label-caps text-label-caps text-secondary block">KM (DISTANCIA ORIGEN-DESTINO)</label>
              <div class="flex gap-sm">
                <input type="number" id="r-km" class="flex-1 border border-[#CED4DA] p-sm font-body-md text-body-md focus:border-primary focus:ring-0 transition-all rounded bg-white" min="0" placeholder="Ej: 45">
                <button type="button" id="btn-auto-km" class="bg-surface-container-high hover:bg-primary hover:text-white border border-outline-variant text-secondary font-bold px-md py-sm rounded cursor-pointer text-xs flex items-center gap-xs transition-all whitespace-nowrap">
                  <span class="material-symbols-outlined text-[16px]">travel_explore</span>
                  Calcular KM automático
                </button>
              </div>
              <p class="text-[11px] text-secondary" id="auto-km-status">Calcula la distancia real por carretera y las coordenadas del destino (Georreferencia).</p>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-md">
              <div class="space-y-xs">
                <label for="r-estado-erp" class="font-label-caps text-label-caps text-secondary block">ESTADO (ERP)</label>
                <select id="r-estado-erp" class="w-full border border-[#CED4DA] p-sm font-body-md text-body-md focus:border-primary focus:ring-0 transition-all rounded bg-white">
                  <option value="false">Pendiente de creación en ERP</option>
                  <option value="true">Creada en ERP</option>
                </select>
              </div>
              <div class="space-y-xs">
                <label for="r-caracteristica" class="font-label-caps text-label-caps text-secondary block">CARACTERÍSTICA ESPECIAL (TARIFAS)</label>
                <select id="r-caracteristica" class="w-full border border-[#CED4DA] p-sm font-body-md text-body-md focus:border-primary focus:ring-0 transition-all rounded bg-white" required>
                  <option value="NORMAL">NORMAL</option>
                  <option value="EXTREMA">EXTREMA</option>
                  <option value="ISLA">ISLA</option>
                </select>
              </div>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-md">
              <div class="space-y-xs">
                <label for="r-lat" class="font-label-caps text-label-caps text-secondary block">GEORREFERENCIA — LATITUD</label>
                <input type="number" step="any" id="r-lat" class="w-full border border-[#CED4DA] p-sm font-body-md text-body-md focus:border-primary focus:ring-0 transition-all rounded bg-white" placeholder="Se completa con 'Calcular KM automático'">
              </div>
              <div class="space-y-xs">
                <label for="r-lon" class="font-label-caps text-label-caps text-secondary block">GEORREFERENCIA — LONGITUD</label>
                <input type="number" step="any" id="r-lon" class="w-full border border-[#CED4DA] p-sm font-body-md text-body-md focus:border-primary focus:ring-0 transition-all rounded bg-white" placeholder="Se completa con 'Calcular KM automático'">
              </div>
            </div>
            <p class="text-[11px] text-secondary" id="georef-status">Estado de Georreferencia: <span class="font-bold">Pendiente</span></p>
          </div>
          <div class="p-md border-t border-outline-variant bg-surface-container-low flex justify-end gap-sm sticky bottom-0">
            <button type="button" class="border border-secondary text-secondary hover:bg-surface-container-high font-bold px-md py-sm rounded cursor-pointer" id="btn-cancel-route-modal">Cancelar</button>
            <button type="submit" class="bg-primary hover:bg-[#930007] text-white font-bold px-md py-sm rounded cursor-pointer">Guardar Ruta</button>
          </div>
        </form>
      </div>
    </div>

    <!-- Modal Carga Masiva (CSV) -->
    <div class="modal-overlay fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center opacity-0 pointer-events-none transition-opacity duration-300" id="bulk-upload-routes-modal">
      <div class="modal-window w-[760px] max-w-[90vw] bg-white border border-outline-variant shadow-lg rounded-xl overflow-hidden transform scale-95 transition-transform duration-300">
        <div class="p-md border-b border-outline-variant flex justify-between items-center bg-surface-container-low">
          <h4 class="font-headline-sm text-headline-sm font-bold text-on-surface">Carga Masiva de Rutas</h4>
          <button class="text-secondary hover:text-primary cursor-pointer" id="btn-close-route-bulk-modal">
            <span class="material-symbols-outlined text-[24px]">close</span>
          </button>
        </div>
        <div class="p-lg space-y-md">
          <p class="font-body-md text-secondary leading-relaxed">
            Sube un archivo delimitado por punto y coma (<code>;</code>) o comas (<code>,</code>). Los encabezados exactos deben ser, en este orden:
            <code class="block p-sm bg-background border border-outline-variant rounded font-data-mono text-primary text-xs mt-xs">
              id_ruta;denominacion;origen;id_zona_transporte;destino;comuna;region;tipo;clasificacion;km;estado;georreferencia;estado_georreferencia
            </code>
            Son obligatorias las columnas: <code class="font-data-mono text-xs">id_ruta, denominacion, origen, id_zona_transporte, destino, comuna, region, tipo, clasificacion, estado</code>.
            Las columnas <code class="font-data-mono text-xs">km, georreferencia, estado_georreferencia</code> son opcionales; si faltan, la ruta quedará marcada como "Completar Datos".
            <br>El campo <code class="font-data-mono text-xs">origen</code> debe ser uno de: ${GRUPOS_ORIGEN.join(', ')}.
            <br>El campo <code class="font-data-mono text-xs">georreferencia</code> debe tener el formato <code class="font-data-mono text-xs">latitud,longitud</code> (ej: -33.4489,-70.6693).
            <br>Si el <code class="font-data-mono text-xs">id_zona_transporte</code> no existe aún, se creará automáticamente una nueva Zona de Transporte con los datos de destino/comuna/región/clasificación indicados.
          </p>

          <div class="border-2 border-dashed border-outline-variant hover:border-primary hover:bg-primary-container/[0.03] rounded-lg p-xl text-center cursor-pointer transition-all flex flex-col items-center justify-center gap-sm" id="csv-route-dropzone">
            <span class="material-symbols-outlined text-[48px] text-secondary">cloud_upload</span>
            <span class="font-body-md text-secondary font-bold">Arrastra tu archivo CSV de rutas aquí o haz clic para buscar</span>
            <input type="file" id="csv-route-input" accept=".csv" class="hidden">
          </div>

          <div id="csv-route-preview-container" class="hidden space-y-sm">
            <h5 class="font-label-caps text-label-caps text-on-surface">Vista Previa de Rutas Detectadas (<span id="csv-route-count">0</span>):</h5>
            <div class="max-h-48 overflow-y-auto border border-outline-variant rounded">
              <table class="w-full text-xs text-left border-collapse">
                <thead>
                  <tr class="bg-surface-container-high border-b border-outline-variant font-bold text-secondary uppercase">
                    <th class="p-sm">ID Ruta</th>
                    <th class="p-sm">Origen</th>
                    <th class="p-sm">Zona / Destino</th>
                    <th class="p-sm">KM</th>
                    <th class="p-sm">Estado</th>
                  </tr>
                </thead>
                <tbody id="csv-route-preview-body">
                  <!-- Dinámico -->
                </tbody>
              </table>
            </div>
          </div>
        </div>
        <div class="p-md border-t border-outline-variant bg-surface-container-low flex justify-end gap-sm">
          <button class="border border-secondary text-secondary hover:bg-surface-container-high font-bold px-md py-sm rounded cursor-pointer" id="btn-cancel-route-bulk">Cancelar</button>
          <button class="bg-primary hover:bg-[#930007] text-white font-bold px-md py-sm rounded cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed" id="btn-confirm-route-bulk" disabled>Importar registros</button>
        </div>
      </div>
    </div>
  `;

  // Renderizar tabla
  renderRoutesTable(routes);

  // --- Lógica de selects dependientes y autocompletado del formulario ---
  const origenSelectEl = document.getElementById('r-origen');
  const zonaSelectEl = document.getElementById('r-zona');
  const destinoInputEl = document.getElementById('r-destino');
  const regionSelectEl = document.getElementById('r-region');
  const comunaSelectEl = document.getElementById('r-comuna');
  const clasificacionEl = document.getElementById('r-clasificacion');
  const denominacionEl = document.getElementById('r-denominacion');
  const latEl = document.getElementById('r-lat');
  const lonEl = document.getElementById('r-lon');
  const georefStatusEl = document.getElementById('georef-status');

  fillRegionSelectRoutes(regionSelectEl, '');
  fillComunaSelectRoutes(comunaSelectEl, '', '');

  const actualizarDenominacion = () => {
    const origen = origenSelectEl.value || '';
    const destino = destinoInputEl.value.trim();
    denominacionEl.value = `${origen}${destino ? ' - ' + destino : ''}`;
  };

  const actualizarGeorefStatus = () => {
    const tieneGeoref = latEl.value !== '' && lonEl.value !== '';
    georefStatusEl.innerHTML = `Estado de Georreferencia: <span class="font-bold ${tieneGeoref ? 'text-green-700' : 'text-amber-600'}">${tieneGeoref ? 'Georreferenciado' : 'Pendiente'}</span>`;
  };

  // Al elegir la Zona de Transporte: autocompletar Destino, Región, Comuna y Clasificación
  zonaSelectEl.addEventListener('change', () => {
    const z = zonas.find(item => item.zona === zonaSelectEl.value);
    if (z) {
      destinoInputEl.value = z.denominacion || '';
      fillRegionSelectRoutes(regionSelectEl, z.region || '');
      fillComunaSelectRoutes(comunaSelectEl, z.region || '', z.comuna || '');
      if (z.tipo) clasificacionEl.value = z.tipo;
    } else {
      destinoInputEl.value = '';
    }
    actualizarDenominacion();
  });

  origenSelectEl.addEventListener('change', actualizarDenominacion);

  regionSelectEl.addEventListener('change', () => {
    fillComunaSelectRoutes(comunaSelectEl, regionSelectEl.value, '');
  });

  comunaSelectEl.addEventListener('change', () => {
    if (!regionSelectEl.value && comunaSelectEl.value) {
      const region = findRegionByComuna(comunaSelectEl.value);
      if (region) {
        fillRegionSelectRoutes(regionSelectEl, region);
        fillComunaSelectRoutes(comunaSelectEl, region, comunaSelectEl.value);
      }
    }
  });

  latEl.addEventListener('input', actualizarGeorefStatus);
  lonEl.addEventListener('input', actualizarGeorefStatus);

  // Buscador
  const searchInput = document.getElementById('route-search');
  searchInput.addEventListener('input', (e) => {
    const term = e.target.value.toLowerCase();
    const filtered = routes.filter(r =>
      (r.codigo || '').toLowerCase().includes(term) ||
      (r.origen_grupo || '').toLowerCase().includes(term) ||
      (r.destino || '').toLowerCase().includes(term) ||
      (r.comuna || '').toLowerCase().includes(term) ||
      (r.region || '').toLowerCase().includes(term) ||
      (r.id_zona_transporte || '').toLowerCase().includes(term)
    );
    renderRoutesTable(filtered);
  });

  // Modales
  const routeModal = document.getElementById('route-modal');
  const btnCreateRoute = document.getElementById('btn-create-route');
  const btnCloseModal = document.getElementById('btn-close-route-modal');
  const btnCancelModal = document.getElementById('btn-cancel-route-modal');
  const routeForm = document.getElementById('route-form');

  btnCreateRoute.addEventListener('click', () => {
    editingRouteId = null;
    routeForm.reset();
    document.getElementById('route-modal-title').innerText = 'Nueva Ruta';

    const activeDb = getDatabase();
    document.getElementById('r-codigo').value = generateSapCode('RUT-SAP-', activeDb.routes, 'codigo');
    fillRegionSelectRoutes(regionSelectEl, '');
    fillComunaSelectRoutes(comunaSelectEl, '', '');
    document.getElementById('r-estado-erp').value = 'false';
    document.getElementById('r-caracteristica').value = 'NORMAL';
    destinoInputEl.value = '';
    actualizarDenominacion();
    actualizarGeorefStatus();

    routeModal.classList.remove('pointer-events-none', 'opacity-0');
    routeModal.querySelector('.modal-window').classList.remove('scale-95');
  });

  const closeFormModal = () => {
    routeModal.classList.add('pointer-events-none', 'opacity-0');
    routeModal.querySelector('.modal-window').classList.add('scale-95');
  };
  btnCloseModal.addEventListener('click', closeFormModal);
  btnCancelModal.addEventListener('click', closeFormModal);

  // Cálculo automático de distancia por carretera (origen CD → destino)
  document.getElementById('btn-auto-km').addEventListener('click', async () => {
    const btn = document.getElementById('btn-auto-km');
    const status = document.getElementById('auto-km-status');
    const grupo = origenSelectEl.value;
    const destino = destinoInputEl.value.trim();
    const region = regionSelectEl.value;

    if (!grupo) return showAlert('Seleccione primero el Origen.', 'error');
    if (!destino) return showAlert('Seleccione primero la Zona de Transporte (Destino).', 'error');

    const activeDb = getDatabase();
    const origenId = resolveOrigenIdFromGrupo(activeDb, grupo);
    const cd = activeDb.logisticsCentres.find(c => c.id === origenId);
    if (!cd || !cd.lat || !cd.lon) return showAlert('El centro de origen no tiene coordenadas GPS.', 'error');

    btn.disabled = true;
    btn.innerHTML = '<span class="material-symbols-outlined text-[16px] animate-spin">progress_activity</span> Calculando...';
    status.textContent = 'Geolocalizando destino y calculando ruta por carretera...';

    try {
      const { km, lat, lon } = await calcularDistanciaAuto(cd, `${destino}, ${region}`);
      document.getElementById('r-km').value = km;
      latEl.value = lat;
      lonEl.value = lon;
      actualizarGeorefStatus();
      status.textContent = `✓ Distancia calculada: ${km} km por carretera desde ${cd.nombre}.`;
      status.style.color = '#16a34a';
    } catch (err) {
      status.textContent = '✗ ' + (err.message || 'No se pudo calcular la distancia. Ingrésela manualmente.');
      status.style.color = '#b5000b';
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<span class="material-symbols-outlined text-[16px]">travel_explore</span> Calcular KM automático';
    }
  });

  routeForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const activeDb = getDatabase();

    const latVal = latEl.value;
    const lonVal = lonEl.value;
    const hasGeoref = latVal !== '' && lonVal !== '';

    const origenGrupo = origenSelectEl.value;
    const origenId = resolveOrigenIdFromGrupo(activeDb, origenGrupo);

    const routeData = {
      codigo: document.getElementById('r-codigo').value.toUpperCase().replace(/\s+/g, ''),
      denominacion: denominacionEl.value.trim(),
      origenId,
      origen_grupo: origenGrupo,
      id_zona_transporte: zonaSelectEl.value || null,
      destino: destinoInputEl.value.trim(),
      comuna: comunaSelectEl.value || '',
      region: regionSelectEl.value || '',
      clasificRuta: document.getElementById('r-tipo-ruta').value,
      tipo: clasificacionEl.value,
      km: document.getElementById('r-km').value !== '' ? Number(document.getElementById('r-km').value) : 0,
      estado_erp: document.getElementById('r-estado-erp').value === 'true',
      caracteristica: document.getElementById('r-caracteristica').value,
      lat: hasGeoref ? Number(latVal) : null,
      lon: hasGeoref ? Number(lonVal) : null,
      georef_estado: hasGeoref,
      activo: editingRouteId ? activeDb.routes.find(r => r.id === editingRouteId).activo : true
    };

    if (!routeData.id_zona_transporte) {
      showAlert('Debe seleccionar la Zona de Transporte (Destino).', 'error');
      return;
    }

    if (editingRouteId) {
      const index = activeDb.routes.findIndex(r => r.id === editingRouteId);
      if (index !== -1) {
        activeDb.routes[index] = { ...activeDb.routes[index], ...routeData };
        saveDatabase(activeDb);
        showAlert('Ruta actualizada correctamente');
      }
    } else {
      if (activeDb.routes.some(r => r.codigo === routeData.codigo)) {
        showAlert('El ID de Ruta ingresado ya está registrado.', 'error');
        return;
      }

      routeData.id = 'r' + (new Date().getTime());
      routeData.idZonaTrans = routeData.id_zona_transporte || '';
      activeDb.routes.push(routeData);
      saveDatabase(activeDb);
      showAlert('Ruta registrada con éxito');
    }

    closeFormModal();
    renderRutasSubview(container);
  });

  // --- CARGA MASIVA DE RUTAS ---
  const bulkModal = document.getElementById('bulk-upload-routes-modal');
  const btnBulkUpload = document.getElementById('btn-bulk-upload-routes');
  const btnCloseBulk = document.getElementById('btn-close-route-bulk-modal');
  const btnCancelBulk = document.getElementById('btn-cancel-route-bulk');
  const btnConfirmBulk = document.getElementById('btn-confirm-route-bulk');
  const csvDropzone = document.getElementById('csv-route-dropzone');
  const csvFileInput = document.getElementById('csv-route-input');

  let parsedRoutes = [];
  let parsedNewZonas = [];

  btnBulkUpload.addEventListener('click', () => {
    parsedRoutes = [];
    parsedNewZonas = [];
    btnConfirmBulk.disabled = true;
    document.getElementById('csv-route-preview-container').classList.add('hidden');
    document.getElementById('csv-route-preview-body').innerHTML = '';

    bulkModal.classList.remove('pointer-events-none', 'opacity-0');
    bulkModal.querySelector('.modal-window').classList.remove('scale-95');
  });

  const closeBulkModal = () => {
    bulkModal.classList.add('pointer-events-none', 'opacity-0');
    bulkModal.querySelector('.modal-window').classList.add('scale-95');
  };
  btnCloseBulk.addEventListener('click', closeBulkModal);
  btnCancelBulk.addEventListener('click', closeBulkModal);

  csvDropzone.addEventListener('click', () => csvFileInput.click());

  csvDropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    csvDropzone.classList.add('border-primary', 'bg-primary-container/[0.04]');
  });
  csvDropzone.addEventListener('dragleave', () => {
    csvDropzone.classList.remove('border-primary', 'bg-primary-container/[0.04]');
  });
  csvDropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    csvDropzone.classList.remove('border-primary', 'bg-primary-container/[0.04]');
    if (e.dataTransfer.files.length > 0) {
      handleCsvRouteFile(e.dataTransfer.files[0]);
    }
  });

  csvFileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleCsvRouteFile(e.target.files[0]);
    }
  });

  // Interpreta "lat,lon" / "lat;lon" / "lat lon" -> { lat, lon } o null
  function parseGeorref(value) {
    if (!value) return null;
    const parts = String(value).trim().split(/[,;|\s]+/).filter(Boolean);
    if (parts.length < 2) return null;
    const lat = Number(parts[0]);
    const lon = Number(parts[1]);
    if (isNaN(lat) || isNaN(lon)) return null;
    return { lat, lon };
  }

  function handleCsvRouteFile(file) {
    const reader = new FileReader();
    reader.onload = function(e) {
      const text = e.target.result;
      const rows = parseCSV(text);
      if (rows.length === 0) {
        showAlert('El archivo CSV está vacío o no tiene el formato correcto.', 'error');
        return;
      }

      const activeDb = getDatabase();
      parsedRoutes = [];
      parsedNewZonas = [];
      const previewBody = document.getElementById('csv-route-preview-body');
      previewBody.innerHTML = '';
      const codigosVistos = new Set();
      const zonasExistentes = new Map((activeDb.transportZones || []).map(z => [z.zona.toUpperCase(), z]));
      const zonasNuevasMap = new Map();

      rows.forEach(row => {
        const idRuta = (row.id_ruta || row.codigo || '').toUpperCase().replace(/\s+/g, '');
        const denominacionCsv = (row.denominacion || row['denominación'] || '').trim();
        const origenCsv = (row.origen || '').trim().toUpperCase();
        const idZona = (row.id_zona_transporte || '').trim().toUpperCase();
        const destinoCsv = (row.destino || '').trim();
        const comunaCsv = (row.comuna || '').trim();
        let regionCsv = (row.region || row['región'] || '').trim();
        const tipoCsv = (row.tipo || '').trim();
        const clasifCsv = (row.clasificacion || row['clasificación'] || '').trim();
        const kmCsv = row.km !== undefined && row.km !== '' ? Number(row.km) : null;
        const estadoRaw = (row.estado || '').trim().toLowerCase();
        const estado_erp = ['si', 'sí', 'true', '1', 'creada', 'erp'].includes(estadoRaw);
        const georefCsv = parseGeorref(row.georreferencia);
        const estadoGeorefRaw = (row.estado_georreferencia || '').trim().toLowerCase();

        if (!regionCsv && comunaCsv) regionCsv = findRegionByComuna(comunaCsv);

        const tipoNorm = ['Regional', 'Interregional'].find(t => t.toLowerCase() === tipoCsv.toLowerCase()) || '';
        const clasifNorm = TIPOS_ZONA.find(t => t.toLowerCase() === clasifCsv.toLowerCase()) || '';
        const regionValida = REGIONES.find(r => r.toLowerCase() === regionCsv.toLowerCase()) || regionCsv;
        const origenValido = GRUPOS_ORIGEN.find(g => g === origenCsv) || '';

        let error = '';
        if (!idRuta) error = 'Falta ID Ruta';
        else if (!denominacionCsv) error = 'Falta Denominación';
        else if (!origenValido) error = 'Origen inválido';
        else if (!idZona) error = 'Falta ID Zona';
        else if (!destinoCsv) error = 'Falta Destino';
        else if (!comunaCsv) error = 'Falta Comuna';
        else if (!regionCsv) error = 'Falta Región';
        else if (!tipoNorm) error = 'Tipo inválido (Regional/Interregional)';
        else if (!clasifNorm) error = 'Clasificación inválida (Comuna/Sector)';
        else if (!estadoRaw) error = 'Falta Estado (ERP)';
        else if (codigosVistos.has(idRuta) || activeDb.routes.some(r => r.codigo === idRuta)) error = 'ID Ruta Duplicado';

        const incompleto = !error && (kmCsv === null || isNaN(kmCsv) || !georefCsv);

        const tr = document.createElement('tr');
        tr.className = "border-b border-outline-variant";
        tr.innerHTML = `
          <td class="p-sm font-data-mono">${escapeHtml(idRuta)}</td>
          <td class="p-sm">${escapeHtml(origenValido || origenCsv)}</td>
          <td class="p-sm">${escapeHtml(idZona)} / ${escapeHtml(destinoCsv)}</td>
          <td class="p-sm font-bold">${kmCsv !== null && !isNaN(kmCsv) ? kmCsv + ' KM' : '—'}</td>
          <td class="p-sm">
            <span class="inline-block px-2 py-0.5 rounded text-[10px] font-bold ${error ? 'bg-red-100 text-red-800' : (incompleto ? 'bg-amber-100 text-amber-800' : 'bg-green-100 text-green-800')}">
              ${error ? error : (incompleto ? 'Completar Datos' : 'Listo')}
            </span>
          </td>
        `;
        previewBody.appendChild(tr);

        if (!error) {
          codigosVistos.add(idRuta);
          const origenId = resolveOrigenIdFromGrupo(activeDb, origenValido);

          // Si la zona no existe aún, se crea automáticamente con los datos del destino
          if (!zonasExistentes.has(idZona) && !zonasNuevasMap.has(idZona)) {
            const nuevaZona = {
              zona: idZona,
              pais: 'CL',
              denominacion: destinoCsv,
              comuna: comunaCsv || null,
              region: regionCsv || null,
              tipo: clasifNorm || null,
              estado_erp: false
            };
            zonasNuevasMap.set(idZona, nuevaZona);
            parsedNewZonas.push(nuevaZona);
          }

          const georefEstado = !estadoGeorefRaw
            ? !!georefCsv
            : ['si', 'sí', 'true', '1', 'georreferenciado'].includes(estadoGeorefRaw);

          parsedRoutes.push({
            codigo: idRuta,
            denominacion: denominacionCsv,
            origenId,
            origen_grupo: origenValido,
            id_zona_transporte: idZona,
            idZonaTrans: idZona,
            destino: destinoCsv,
            comuna: comunaCsv,
            region: regionValida,
            clasificRuta: tipoNorm,
            tipo: clasifNorm,
            km: (kmCsv !== null && !isNaN(kmCsv)) ? kmCsv : 0,
            estado_erp,
            caracteristica: 'NORMAL',
            lat: georefCsv ? georefCsv.lat : null,
            lon: georefCsv ? georefCsv.lon : null,
            georef_estado: georefEstado,
            activo: true
          });
        }
      });

      document.getElementById('csv-route-count').innerText = rows.length;
      document.getElementById('csv-route-preview-container').classList.remove('hidden');

      if (parsedRoutes.length > 0) {
        btnConfirmBulk.disabled = false;
      } else {
        showAlert('No se encontraron registros de rutas válidos.', 'error');
      }
    };
    reader.readAsText(file);
  }

  btnConfirmBulk.addEventListener('click', () => {
    const activeDb = getDatabase();
    if (!activeDb.transportZones) activeDb.transportZones = [];

    parsedNewZonas.forEach(z => activeDb.transportZones.push(z));

    parsedRoutes.forEach(r => {
      r.id = 'r' + (new Date().getTime() + Math.random().toString(36).substr(2, 5));
      activeDb.routes.push(r);
    });

    saveDatabase(activeDb);
    let mensaje = `Se importaron ${parsedRoutes.length} rutas correctamente.`;
    if (parsedNewZonas.length > 0) mensaje += ` Se crearon ${parsedNewZonas.length} nuevas Zonas de Transporte.`;
    showAlert(mensaje);
    closeBulkModal();
    renderRutasSubview(container);
  });

  // Función auxiliar para abrir el modal en modo edición (usada por la tabla)
  window.__openRouteEditModal = (routeId) => {
    const activeDb = getDatabase();
    const r = activeDb.routes.find(item => item.id === routeId);
    if (!r) return;

    editingRouteId = routeId;
    document.getElementById('r-codigo').value = r.codigo;
    origenSelectEl.value = r.origen_grupo || '';
    zonaSelectEl.value = r.id_zona_transporte || '';
    destinoInputEl.value = r.destino || '';
    fillRegionSelectRoutes(regionSelectEl, r.region || '');
    fillComunaSelectRoutes(comunaSelectEl, r.region || '', r.comuna || '');
    document.getElementById('r-tipo-ruta').value = r.clasificRuta || 'Regional';
    clasificacionEl.value = r.tipo || 'Comuna';
    denominacionEl.value = r.denominacion || '';
    document.getElementById('r-km').value = (r.km !== null && r.km !== undefined) ? r.km : '';
    document.getElementById('r-estado-erp').value = r.estado_erp ? 'true' : 'false';
    document.getElementById('r-caracteristica').value = r.caracteristica || 'NORMAL';
    latEl.value = (r.lat !== null && r.lat !== undefined) ? r.lat : '';
    lonEl.value = (r.lon !== null && r.lon !== undefined) ? r.lon : '';
    actualizarGeorefStatus();

    document.getElementById('route-modal-title').innerText = 'Editar Ruta';

    const modal = document.getElementById('route-modal');
    modal.classList.remove('pointer-events-none', 'opacity-0');
    modal.querySelector('.modal-window').classList.remove('scale-95');
  };
}

function renderRoutesTable(routesList) {
  const tbody = document.getElementById('routes-table-body');
  if (!tbody) return;

  if (routesList.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="15" class="p-xl text-center text-secondary">
          No se encontraron rutas registradas.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = '';
  routesList.forEach(r => {
    const tr = document.createElement('tr');
    const incompleto = rutaIncompleta(r);
    tr.className = `border-b border-outline-variant hover:bg-surface-container-low transition-colors ${incompleto ? 'bg-amber-50/60' : ''}`;

    const statusVigencia = r.activo ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800';
    const statusErp = r.estado_erp ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800';
    const statusGeoref = r.georef_estado ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800';

    const campoPendiente = (valor) => valor
      ? escapeHtml(valor)
      : `<span class="inline-flex items-center gap-1 text-amber-700 font-bold text-[10px] uppercase whitespace-nowrap"><span class="material-symbols-outlined text-[14px]">warning</span> Completar</span>`;

    tr.innerHTML = `
      <td class="p-md font-bold text-primary font-data-mono">${escapeHtml(r.codigo)}</td>
      <td class="p-md text-xs">${escapeHtml(r.denominacion)}</td>
      <td class="p-md font-bold text-xs">${escapeHtml(r.origen_grupo) || '—'}</td>
      <td class="p-md text-xs font-data-mono">${campoPendiente(r.id_zona_transporte)}</td>
      <td class="p-md text-xs">${escapeHtml(r.destino)}</td>
      <td class="p-md text-xs">${campoPendiente(r.comuna)}</td>
      <td class="p-md text-xs">${campoPendiente(r.region)}</td>
      <td class="p-md text-xs"><span class="bg-surface-container-high px-sm py-1 border border-outline-variant rounded text-xs">${escapeHtml(r.clasificRuta) || '—'}</span></td>
      <td class="p-md text-xs"><span class="bg-surface-container-high px-sm py-1 border border-outline-variant rounded text-xs">${escapeHtml(r.tipo) || '—'}</span></td>
      <td class="p-md font-bold font-data-mono text-xs">${r.km ? r.km + ' KM' : campoPendiente('')}</td>
      <td class="p-md">
        <span class="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold ${statusErp}">
          ${r.estado_erp ? 'EN ERP' : 'PENDIENTE'}
        </span>
      </td>
      <td class="p-md text-xs font-data-mono">${(r.lat !== null && r.lat !== undefined && r.lon !== null && r.lon !== undefined) ? `${r.lat}, ${r.lon}` : campoPendiente('')}</td>
      <td class="p-md">
        <span class="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold ${statusGeoref}">
          ${r.georef_estado ? 'SÍ' : 'NO'}
        </span>
      </td>
      <td class="p-md">
        <span class="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold ${statusVigencia}">
          ${r.activo ? 'ACTIVO' : 'DE BAJA'}
        </span>
      </td>
      <td class="p-md text-center">
        <div class="flex items-center justify-center gap-xs">
          <button class="btn-edit text-secondary hover:text-primary p-xs cursor-pointer" data-id="${r.id}" title="Editar ruta">
            <span class="material-symbols-outlined text-[20px]">edit</span>
          </button>
          <button class="btn-toggle text-secondary hover:text-primary p-xs cursor-pointer" data-id="${r.id}" title="${r.activo ? 'Dar de baja' : 'Activar'}">
            <span class="material-symbols-outlined text-[20px] ${r.activo ? 'text-red-600 hover:text-red-800' : 'text-green-600 hover:text-green-800'}">
              ${r.activo ? 'block' : 'check_circle'}
            </span>
          </button>
          <button class="btn-delete-route text-secondary hover:text-red-700 p-xs cursor-pointer" data-id="${r.id}" title="Eliminar ruta">
            <span class="material-symbols-outlined text-[20px]">delete</span>
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.btn-edit').forEach(btn => {
    btn.addEventListener('click', (e) => window.__openRouteEditModal(e.currentTarget.getAttribute('data-id')));
  });

  tbody.querySelectorAll('.btn-toggle').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = e.currentTarget.getAttribute('data-id');
      const db = getDatabase();
      const idx = db.routes.findIndex(item => item.id === id);

      if (idx !== -1) {
        const r = db.routes[idx];
        r.activo = !r.activo;
        saveDatabase(db);
        showAlert(`La ruta ${r.codigo} ha sido ${r.activo ? 'activada' : 'dada de baja'}.`);
        renderRoutesView(document.getElementById('stage-area'));
      }
    });
  });

  tbody.querySelectorAll('.btn-delete-route').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = e.currentTarget.getAttribute('data-id');
      const db = getDatabase();
      const idx = db.routes.findIndex(item => item.id === id);

      if (idx !== -1) {
        const r = db.routes[idx];
        if (!confirm(`¿Eliminar la ruta ${r.codigo} (${r.denominacion || r.destino})? Esta acción no se puede deshacer.`)) return;
        db.routes.splice(idx, 1);
        saveDatabase(db);
        showAlert(`La ruta ${r.codigo} ha sido eliminada.`);
        renderRoutesView(document.getElementById('stage-area'));
      }
    });
  });
}
