import { getDatabase, saveDatabase } from './data.js';
import { showAlert, geocodeAddress } from './utils.js';

// Renderizar la vista de Centros Logísticos con Mapa Interactivo Leaflet y Tailwind CSS
export function renderLogisticsView(container) {
  const db = getDatabase();
  const centres = db.logisticsCentres;

  container.innerHTML = `
    <p class="font-body-md text-body-md text-secondary mb-md">Administre los centros de distribución (CD) y puntos de salida. Seleccione un centro para geolocalizarlo en el mapa interactivo.</p>

    <div style="display: flex; justify-content: flex-end; margin-bottom: 16px;">
      <button id="btn-create-cd" class="bg-primary hover:bg-[#930007] text-white font-bold px-md py-sm rounded active:scale-[0.98] transition-all flex items-center gap-sm cursor-pointer text-xs uppercase tracking-wider shadow">
        <span class="material-symbols-outlined text-[18px]">add</span>
        Registrar Centro SAP
      </button>
    </div>

    <!-- Layout Side-by-Side: Tarjetas a la izquierda, Mapa a la derecha -->
    <div class="grid grid-cols-12 gap-lg">
      <!-- Columna Izquierda: Listado de Centros -->
      <div class="col-span-12 lg:col-span-6 flex flex-col gap-md max-h-[550px] overflow-y-auto pr-xs" id="cd-cards-container">
        <!-- Tarjetas cargadas dinámicamente -->
      </div>

      <!-- Columna Derecha: Mapa Leaflet -->
      <div class="col-span-12 lg:col-span-6">
        <div id="logistics-map" class="h-[550px] rounded-xl border border-outline-variant shadow-md overflow-hidden relative" style="z-index: 1;">
          <!-- Cargador de Mapa -->
        </div>
      </div>
    </div>

    <!-- Modal Formulario Centro Logístico -->
    <div class="modal-overlay fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center opacity-0 pointer-events-none transition-opacity duration-300" id="cd-modal">
      <div class="modal-window w-[600px] max-w-[90vw] bg-white border border-outline-variant shadow-lg rounded-xl overflow-hidden transform scale-95 transition-transform duration-300">
        <div class="p-md border-b border-outline-variant flex justify-between items-center bg-surface-container-low">
          <h4 class="font-headline-sm text-headline-sm font-bold text-on-surface">Nuevo Centro Logístico (CD)</h4>
          <button class="text-secondary hover:text-primary cursor-pointer" id="btn-close-cd-modal">
            <span class="material-symbols-outlined text-[24px]">close</span>
          </button>
        </div>
        <form id="cd-form">
          <div class="p-lg space-y-md">
            <div class="space-y-xs">
              <label for="cd-nombre" class="font-label-caps text-label-caps text-secondary block">NOMBRE DE PLANTA / CENTRO</label>
              <input type="text" id="cd-nombre" class="w-full border border-[#CED4DA] p-sm font-body-md text-body-md focus:border-primary focus:ring-0 transition-all rounded bg-white" required placeholder="Ej: CD Santiago Sur">
            </div>
            
            <div class="grid grid-cols-1 md:grid-cols-2 gap-md">
              <div class="space-y-xs">
                <label for="cd-sap" class="font-label-caps text-label-caps text-secondary block">ID CENTRO SAP</label>
                <input type="text" id="cd-sap" class="w-full border border-[#CED4DA] p-sm font-body-md text-body-md focus:border-primary focus:ring-0 transition-all rounded bg-white disabled:bg-surface-container-low disabled:text-secondary" required placeholder="Ej: 1003">
                <p class="text-[10px] text-secondary" id="cd-sap-hint"></p>
              </div>
              <div class="space-y-xs">
                <label for="cd-comuna" class="font-label-caps text-label-caps text-secondary block">REGIÓN/COMUNA</label>
                <input type="text" id="cd-comuna" class="w-full border border-[#CED4DA] p-sm font-body-md text-body-md focus:border-primary focus:ring-0 transition-all rounded bg-white" required placeholder="Ej: San Bernardo, Metropolitana">
              </div>
            </div>

            <div class="space-y-xs">
              <label for="cd-direccion" class="font-label-caps text-label-caps text-secondary block">DIRECCIÓN GEOGRÁFICA (CALLE Y NÚMERO)</label>
              <input type="text" id="cd-direccion" class="w-full border border-[#CED4DA] p-sm font-body-md text-body-md focus:border-primary focus:ring-0 transition-all rounded bg-white" required placeholder="Ej: Av. Las Industrias 890">
            </div>

            <div class="space-y-xs" id="cd-map-adjust-wrap" style="display:none;">
              <label class="font-label-caps text-label-caps text-secondary block">UBICACIÓN EN EL MAPA (arrastre el pin para ajustar)</label>
              <p class="text-[11px] mb-1" id="cd-geo-status"></p>
              <div id="cd-map-adjust" class="rounded border border-outline-variant" style="height: 220px; z-index:1;"></div>
            </div>
          </div>
          <div class="p-md border-t border-outline-variant bg-surface-container-low flex justify-end gap-sm">
            <button type="button" class="border border-secondary text-secondary hover:bg-surface-container-high font-bold px-md py-sm rounded cursor-pointer" id="btn-cancel-cd-modal">Cancelar</button>
            <button type="submit" class="bg-primary hover:bg-[#930007] text-white font-bold px-md py-sm rounded cursor-pointer" id="btn-submit-cd">Geolocalizar y Registrar</button>
          </div>
        </form>
      </div>
    </div>
  `;

  // Estado del paso de geolocalización/ajuste de pin (paso 2 del formulario)
  let pendingCoords = null;
  let pendingData = null;
  let adjustMap = null;
  let adjustMarker = null;

  const resetGeoStep = (defaultLabel) => {
    pendingCoords = null;
    pendingData = null;
    if (adjustMap) { adjustMap.remove(); adjustMap = null; }
    adjustMarker = null;
    document.getElementById('cd-map-adjust-wrap').style.display = 'none';
    document.getElementById('cd-geo-status').textContent = '';
    const btnSubmit = document.getElementById('btn-submit-cd');
    btnSubmit.disabled = false;
    btnSubmit.innerText = defaultLabel;
  };

  const showAdjustMap = (coords) => {
    const wrap = document.getElementById('cd-map-adjust-wrap');
    const statusEl = document.getElementById('cd-geo-status');
    wrap.style.display = '';
    statusEl.textContent = coords.found
      ? `Ubicación encontrada: ${coords.displayName}`
      : `⚠ ${coords.displayName}`;
    statusEl.className = `text-[11px] mb-1 ${coords.found ? 'text-secondary' : 'text-red-700 font-bold'}`;

    if (adjustMap) { adjustMap.remove(); adjustMap = null; }
    adjustMap = L.map('cd-map-adjust').setView([coords.lat, coords.lon], coords.found ? 15 : 11);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
    }).addTo(adjustMap);
    adjustMarker = L.marker([coords.lat, coords.lon], { draggable: true }).addTo(adjustMap)
      .bindTooltip('Arrastre para ajustar la ubicación exacta', { permanent: false });
    setTimeout(() => adjustMap.invalidateSize(), 150);
  };

  // Renderizar CD Cards
  renderCdCards(centres, container, resetGeoStep);

  // Inicializar Mapa Leaflet
  let map;
  let markers = [];
  try {
    map = L.map('logistics-map').setView([-34.5, -71.5], 6);
    
    // Capa de Mapa estilo Premium Dark (CartoDB Dark Matter)
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
    }).addTo(map);

    const bounds = [];
    centres.forEach((cd, index) => {
      if (cd.lat && cd.lon) {
        const marker = L.marker([cd.lat, cd.lon]).addTo(map)
          .bindPopup(`
            <div class="text-on-surface font-body-md" style="font-family: 'Hanken Grotesk', sans-serif;">
              <strong class="text-primary font-bold text-sm">${cd.nombre}</strong><br>
              <span class="text-xs text-secondary">${cd.direccion}</span><br>
              <span class="text-[10px] font-bold text-primary block mt-1">Código SAP: ${cd.id}</span>
            </div>
          `);
        markers.push(marker);
        bounds.push([cd.lat, cd.lon]);
        
        // Asignar click a la tarjeta para enfocar en el mapa
        const cardElement = document.getElementById(`cd-card-${cd.id}`);
        if (cardElement) {
          cardElement.addEventListener('click', () => {
            // Quitar clase activa previa y agregarla a este
            document.querySelectorAll('.cd-card').forEach(c => c.classList.remove('border-primary', 'bg-primary-container/[0.02]'));
            cardElement.classList.add('border-primary', 'bg-primary-container/[0.02]');
            
            map.flyTo([cd.lat, cd.lon], 14, { duration: 1.5 });
            marker.openPopup();
          });
        }
      }
    });

    if (bounds.length > 0) {
      map.fitBounds(bounds, { padding: [50, 50] });
    }

  } catch (err) {
    console.error("Error al cargar Leaflet:", err);
    document.getElementById('logistics-map').innerHTML = `
      <div class="flex justify-center items-center h-full text-secondary font-body-md bg-surface-container-low border border-outline-variant">
        Error al cargar los servicios de mapa interactivo.
      </div>
    `;
  }

  // Modales y Formulario
  const cdModal = document.getElementById('cd-modal');
  const btnCreateCd = document.getElementById('btn-create-cd');
  const btnCloseModal = document.getElementById('btn-close-cd-modal');
  const btnCancelModal = document.getElementById('btn-cancel-cd-modal');
  const cdForm = document.getElementById('cd-form');

  btnCreateCd.addEventListener('click', () => {
    cdForm.reset();
    window.__editingCdId = null;
    document.querySelector('#cd-modal h4').textContent = 'Nuevo Centro Logístico (CD)';
    const sapInput = document.getElementById('cd-sap');
    sapInput.value = '';
    sapInput.disabled = false;
    document.getElementById('cd-sap-hint').textContent = 'Ingrese el código de centro SAP (será el identificador único del centro).';
    resetGeoStep('Geolocalizar y Registrar');

    cdModal.classList.remove('pointer-events-none', 'opacity-0');
    cdModal.querySelector('.modal-window').classList.remove('scale-95');
  });

  const closeModal = () => {
    cdModal.classList.add('pointer-events-none', 'opacity-0');
    cdModal.querySelector('.modal-window').classList.add('scale-95');
    resetGeoStep('Geolocalizar y Registrar');
  };
  btnCloseModal.addEventListener('click', closeModal);
  btnCancelModal.addEventListener('click', closeModal);

  cdForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const db = getDatabase();
    const btnSubmit = document.getElementById('btn-submit-cd');
    const editingId = window.__editingCdId || null;

    // Paso 2: la dirección ya fue geolocalizada y se muestra el mapa de ajuste.
    // Al confirmar, se guarda con la posición final del pin (ajustada o no).
    if (pendingCoords && pendingData) {
      const finalLatLng = adjustMarker ? adjustMar