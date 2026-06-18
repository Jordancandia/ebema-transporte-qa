# PLAN DE IMPLEMENTACIÓN — SIT EBEMA MEJORAS

## Archivos a modificar

| Archivo | Cambios |
|---|---|
| `js/routes.js` | Factor Ruta en CSV + vista |
| `js/tarifas-transporte.js` | Peajes, Tarifas Camión, Participación, Motor Costo, ZAP/SAP |
| `js/tarifas-engine.js` | (sin cambios, ZCAP se mantiene) |
| `js/data.js` | (sin cambios), costosBase se deja en default |
| `js/tarifas-clientes.js` | Referencia "Motor ZCAP" → "Motor de Costo" |
| `js/rates.js` | Referencia "Motor ZCAP" → "Motor de Costo" |

---

## FASE 1 — Factor Ruta en Rutas

**Archivo:** `routes.js` (~línea 753, función `handleCsvRouteFile`)

### CSV — columna opcional `factor_ruta`
- `1` → `caracteristica: 'NORMAL'` (default si no se envía)
- `2` → `caracteristica: 'ISLA'`
- `3` → `caracteristica: 'EXTREMA'`
- Sobrescribe el hardcodeo actual `caracteristica: 'NORMAL'` (línea ~884)

### Vista tabla de rutas (~línea 1070)
- Agregar badge con número + color junto al label de Característica
- `1` azul / `2` ámbar / `3` rojo

### Formulario edición (~línea 1040)
- Dropdown `caracteristica` muestra `1 - NORMAL / 2 - ISLA / 3 - EXTREMA`

---

## FASE 2 — Route Tolls como Cache API

**Archivo:** `tarifas-transporte.js`

### Exportar cache
- Nueva función `exportRouteTollsCSV(db)` en sección de peajes
- Descargar todo `db.routeTolls` como CSV
- Columnas: `route_id;ejes;peaje_ida;peaje_vuelta;km_ida;km_vuelta;needs_review;calculado_en`
- Botón en UI de peajes: "Exportar Cache API"

### Importar cache
- Función `importRouteTollsCSV(file, db)` que parsea CSV y upserta en `db.routeTolls`
- Al importar, NO recalcular nada, solo insertar datos
- Botón "Importar Cache API" con input file

### Al calcular KM vía Google Distance
- Actualmente guarda en `r.km` (route record). Ahora también guardar en `route_tolls` con `km_ida`, ejes correspondientes.
- Crear `pjUpsertKmCache(db, routeId, km)` que upserta en route_tolls

### Flujo
1. Antes de llamar a Google Distance o Tollguru, verificar si existe en `route_tolls`
2. Si existe (km_ida no null para KM, peaje_ida no null para peajes), usar cache
3. Si no, llamar API y guardar

---

## FASE 3 — Peajes Locales + Interregionales

**Archivo:** `tarifas-transporte.js`

### 3a. Peajes Locales (modificar `renderPeajesAuto`, línea ~182)
- Filtro inicial: `clasificRuta === 'Regional'` AND `tipo === 'Comuna'`
- Excluir `tipo === 'Sector'`
- Ajustar filtros dropdown existentes para que por defecto muestren solo Comuna y Regional

### 3b. Peajes Interregionales (nueva vista)
- Agregar sub-tab: `subTabButton('peajes-inter', 'alt_route', 'Peajes Interregionales')`
- Nueva función `renderPeajesInter(content, db, cfg)`:
  - Filtra rutas con `clasificRuta === 'Interregional'` AND `tipo === 'Comuna'`
  - Misma estructura de tabla que Peajes Locales
  - Columnas: Centro, Ruta, Destino, KM (ida), Ejes, Peaje Ida, Peaje Vuelta, Estado
  - Botones: "Calcular KM" y "Calcular Peajes" (ida)
  - Soporte para carga masiva por comuna (adaptar `findRutasParaComuna`)
- Agregar `case 'peajes-inter': renderPeajesInter(...)` al switch

### 3c. Eficiencia API Tollguru
- Botón "Procesar Lote" en ambas vistas (Locales e Interregionales)
- Toma rutas sin peaje calculado (`!toll || needs_review`)
- Procesa secuencial con sleep(400ms)
- Barra de progreso: `X de Y procesadas`
- Botón "Cancelar"
- Mantener botón individual por ruta

### 3d. KM solo IDA
- En cálculos de peajes: KM base = ida solamente (no round trip)
- Combustible: separa ida (cargado) y vuelta (vacío), pero usa mismo km base
- En `pjUpsertToll`: el km guardado es el de ida

---

## FASE 4 — Variables Generales (eliminar sección)

**Archivo:** `tarifas-transporte.js` (~línea 1776)

- En `renderVariables`, eliminar el último card "Estructura de Costos Base y Tramos KM Adicionales"
- No eliminar `costosBase` de `data.js` (para no perder datos existentes)

---

## FASE 5 — Participación Rutas (nueva vista)

**Archivo:** `tarifas-transporte.js`

### Sub-tab nueva (después de Seguros)
```js
subTabButton('participacion', 'donut_large', 'Participación Rutas')
```

### Función `renderParticipacion(content, db, cfg)`
- Obtener `histData = getClientTariffConfig(db).historico || []`
- Si está vacío: mostrar mensaje "Cargar histórico desde Tarifas Clientes primero"
- Obtener centros desde `getOrigenGroups(db)`
- Filtro por centro

### Lógica de participación
```js
// Agrupar histórico por centroId
// Para cada centro:
//   Obtener rutas Regional + Comuna
//   Separar en dos grupos: NORMAL vs ISLA+EXTREMA
//   Para cada ruta:
//     Si caracteristica === 'NORMAL':
//       pct = (metric / totalMetricNormal) * 100
//     Si caracteristica === 'ISLA' o 'EXTREMA':
//       pct = (metric / totalMetricIslaExtrema) * 100
//   metric = (promClientes + promObras + promToneladas) / 3
```
- **Promedio**: `(promClientes + promObras + promToneladas) / 3`
- **%Participación**: `promedioRuta / sumaPromedios * 100`

### Tabla
| Centro | Ruta | Destino | Característica | Clientes | Obras | Ton | %Part | Barra |

### Guardar en `cfg.participacionRutas`
```js
cfg.participacionRutas[rutaId] = { pct, cluster, caracteristica }
```

### Botón "Calcular Participación"
- Ejecuta el cálculo y guarda en cfg

---

## FASE 6 — Tarifa por Camión (vista actualizada)

**Archivo:** `tarifas-transporte.js` (~línea 1184)

### Nuevos campos en `truckTypes`
```js
ratePerKmExtrema  // tarifa extra para rutas ISLA/EXTREMA (opcional)
```

### Vista modificada
- Header: "Tarifas de Transporte por Centro y Tipo de Camión"
- Subtítulo: "Define cómo se paga al transportista por centro y tipo de camión"
- Filtro por centro (`origen_grupo`)

### Tabla por centro + tipo de camión
| Columna | Tipo | Campo |
|---|---|---|
| Tipo Camión | texto | — |
| Capacidad | texto | — |
| KM Base | input editable | `Kmbase` |
| Costo Base | input editable | `baseKM` |
| Tarifa Base KM | input editable | `baseRate` |
| Tarifa KM Extrema/Isla | input editable | `ratePerKmExtrema` (solo si centro tiene rutas ISLA o EXTREMA) |

### Botón "Calcular desde Motor de Costo"
- Toma promedios de `costoRuta / km` del Motor de Costo
- Sugiere valores para `baseRate` (normal) y `ratePerKmExtrema`
- Muestra alerta con sugerencias, no sobreescribe automáticamente

### Guardado
- Al editar, se guarda en `truckTypes[repId][capKg]`

---

## FASE 7 — Motor de Costo (ex ZCAP)

**Archivo:** `tarifas-transporte.js` (~línea 1823)

### Renombrar
- Sub-tab: `subTabButton('resultados', 'calculate', 'Motor de Costo')`
- Título: "Motor de Costo — Resultados por Ruta"
- Botón: "Actualizar Tarifas"
- Textos de ayuda: reemplazar "Motor ZCAP" por "Motor de Costo"

### ZCAP mantiene cálculo actual (línea ~1896, `m.zcap`)

### Agregar columnas al final de la tabla de resultados
| Columna | Fórmula |
|---|---|
| PARTICIPACIÓN | `cfg.participacionRutas[r.id]?.pct \|\| 0` (% con barra) |
| TARIFA PONDERADA | `(costoKmFinal \|\| 0) * (pct \|\| 0) / 100` |

### Filtros
- Por centro (`zcapFiltroCentro`, mantener existente)
- Solo rutas activas, Regional + Comuna

---

## FASE 8 — ZAP/SAP (nueva vista exportable)

**Archivo:** `tarifas-transporte.js`

### Sub-tab nueva
```js
subTabButton('zapsap', 'table', 'ZAP/SAP')
```

### Función `renderZapSap(content, db, cfg)`
- Obtener centros desde `getOrigenGroups(db)`
- Para cada centro:
  - Rutas activas del centro
  - Para cada ruta + tipo de camión:
    - `tarifaKm` desde `truckTypes` (Tarifa por Camión)
    - Si ruta NORMAL: `tarifaKm = baseRate`
    - Si ISLA/EXTREMA: `tarifaKm = ratePerKmExtrema`
    - `costoBase` desde Tarifa por Camión
    - Costo = `km_ida * tarifaKm + costoBase`
    - Redondear a entero (sin decimales)

### Tabla
| ID Centro | ID Ruta | Denominación | Tipo Camión | KM Ida | Tarifa KM | Costo Base | Costo Total |

### Botón "Exportar CSV"
```csv
ID_CENTRO;ID_RUTA;DENOMINACION;TIPO_CAMION;COSTO
```
- Valores enteros, sin decimales
- UTF-8 BOM
- Nombre: `zap_sap_export_YYYYMMDD.csv`

---

## Resumen de Sub-Tabs

| Orden | Key | Label |
|---|---|---|
| 1 | `peajes` | Peajes |
| 2 | `peajes-inter` | Peajes Interregionales |
| 3 | `camiones` | Tarifas por Camión |
| 4 | `combustibles` | Combustibles y Rendimientos |
| 5 | `seguros` | Seguros y Permisos |
| 6 | `participacion` | Participación Rutas |
| 7 | `variables` | Variables Generales |
| 8 | `resultados` | Motor de Costo |
| 9 | `zapsap` | ZAP/SAP |

---

## Referencias a renombrar en otros archivos

| Archivo | Línea ~ | Texto actual | Nuevo texto |
|---|---|---|---|
| `tarifas-clientes.js` | 452 | "Motor ZCAP" | "Motor de Costo" |
| `rates.js` | 233 | "Motor ZCAP" | "Motor de Costo" |
| `rates.js` | 625 | "Motor ZCAP" | "Motor de Costo" |

---

## Orden de Implementación

```
1. Factor Ruta (routes.js)
2. Route Tolls Cache (tarifas-transporte.js)
3. Peajes Locales + Interregionales (tarifas-transporte.js)
4. Variables Generales (tarifas-transporte.js)
5. Participación Rutas (tarifas-transporte.js)
6. Tarifa por Camión (tarifas-transporte.js)
7. Motor de Costo (tarifas-transporte.js)
8. ZAP/SAP (tarifas-transporte.js)
```
