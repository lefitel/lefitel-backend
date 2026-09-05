# Migración de Leaflet a MapLibre GL + OpenFreeMap

> **Para quien ejecute esto:** usar `superpowers:subagent-driven-development` o
> `superpowers:executing-plans` para ir tarea por tarea. Los pasos llevan casilla (`- [ ]`).

**Objetivo:** sustituir Leaflet por MapLibre GL en los 7 mapas del front, sirviendo las teselas
desde OpenFreeMap, para quitar la marca de agua «API KEY REQUIRED» que CARTO estampa desde
septiembre de 2026 y para que el mapa de operaciones deje de dibujar sus marcadores uno a uno en
SVG.

**Arquitectura:** las pantallas no hablan con MapLibre directamente. Se crea una capa fina de
componentes propios en `web/src/components/map/` (`BaseMap`, `MapPoint`, `MapPointsLayer`,
`MapLine`, `SonarMarker`, `MapSearch`) con la misma forma de props que tienen hoy los de
react-leaflet, más un módulo de geometría (`mapGeo.ts`) que es el **único** sitio del código donde
se invierte el orden de las coordenadas. Las pantallas siguen recibiendo y pasando `{ lat, lng }`.

**Stack:** `maplibre-gl` (motor, WebGL) + `@vis.gl/react-maplibre` v8.1.3 (envoltorio React que da
`<Map>`, `<Marker>`, `<Popup>`, `<Source>`, `<Layer>` y `useMap`) + estilos de OpenFreeMap.

**Especificación:** este mismo documento, sección «Por qué se hace esto». La decisión la tomó
Isaias el 2026-09-04 tras descartar tres alternativas (seguir en CARTO con clave, OSM raster,
auto-hospedar teselas).

---

## Por qué se hace esto

**El síntoma.** Todos los mapas muestran «API KEY REQUIRED / carto.com/basemaps/apikey» escrito en
diagonal sobre las teselas.

**La causa, verificada el 2026-09-04.** No es un fallo del código: `ThemedTileLayer.tsx` no se toca
desde marzo. CARTO ha empezado a exigir clave para `basemaps.cartocdn.com` y sirve las teselas sin
clave con la marca **dibujada dentro del PNG**. Comprobado con `curl` sobre `light_all` y sobre
`rastertiles/voyager`: HTTP 200, imagen válida, marca incluida. Da igual el `Referer` (probado sin
cabecera, con `localhost` y con `osefi.net`): la misma marca. No hay CSS que la quite.

**Por qué MapLibre y no solo cambiar de proveedor de teselas.** La alternativa mínima era servir las
mismas imágenes desde OpenFreeMap a través del puente `maplibre-gl-leaflet`. Ese puente **carga
maplibre-gl igualmente** (257 KB comprimidos, medidos en bundlephobia el 2026-09-04, frente a los
44 KB de leaflet + react-leaflet) y deja las limitaciones de Leaflet intactas: se paga el peso y no
se cobra el beneficio.

**El argumento de fondo.** `getDashboard` ([api/src/controllers/dashboard.controller.ts:19]) hace
`findAll` sobre eventos y sobre postes **sin límite ni paginación**, y
[web/src/pages/menu/inicio/useInicioData.ts:352] pinta un marcador por cada uno que pase el filtro
de fechas. El número de marcadores no tiene techo: crece con la base de datos del cliente. Leaflet
los dibuja como elementos SVG individuales y se degrada a partir de unos cientos; MapLibre los pinta
en una sola capa WebGL.

**Fuera de alcance, pero anotado:** que el dashboard se traiga la tabla entera de eventos con sus
revisiones, soluciones y observaciones anidadas es un problema por sí solo y no lo arregla esta
migración. Tarea aparte.

---

## Restricciones globales

Se aplican a **todas** las tareas.

1. **Orden de coordenadas.** Leaflet usa `[lat, lng]`; MapLibre usa `[lng, lat]`. Es la fuente de
   error número uno de esta migración: un punto invertido no falla, simplemente aparece en otro
   continente. **Solo `mapGeo.ts` puede escribir un par crudo.** Todo componente nuevo acepta
   `{ lat, lng }` o `[lat, lng]` y convierte dentro. Ninguna pantalla escribe `[lng, lat]`.
2. **Estilos, sin clave:** `https://tiles.openfreemap.org/styles/positron` (claro) y
   `https://tiles.openfreemap.org/styles/dark` (oscuro). Verificados el 2026-09-04: HTTP 200 sin
   registro ni cabeceras.
3. **Atribución.** Los datos son de OpenStreetMap bajo ODbL: la atribución que MapLibre pinta abajo
   a la derecha **no se oculta**. Se puede estilar (ver Tarea 16), no borrar.
4. **Dependencias.** Se añaden exactamente dos: `maplibre-gl` y `@vis.gl/react-maplibre`. Ninguna
   más de mapas.
5. **Idioma.** Código, nombres de variables y comentarios en inglés. Este documento, en español.
6. **Commits.** **Un único commit al terminar todo el arco**, no uno por tarea (norma de Isaias).
   Los pasos «Commit» que el formato habitual pondría en cada tarea aquí no existen. Nunca commitear
   en `main` ni en `development`: solo en la rama de Isaias. Añadir ficheros **por nombre**, nunca
   `git add -A`, porque hay otras sesiones trabajando en el mismo árbol.
7. **Verificación por tarea.** Cada tarea termina con `npm run lint` y `npm run test` en verde. La
   comprobación visual en navegador se acumula y se hace en la Tarea 16, salvo donde la tarea diga
   otra cosa.
8. **Órdenes** (desde `web/`): `npm run test` (vitest), `npm run lint` (eslint),
   `npm run typecheck` (TypeScript 7), `npm run dev` (Vite), `npm run build` (lint + test +
   typecheck + build).

---

## Mapa de ficheros

### Se crean

| Fichero | Responsabilidad |
|---|---|
| `web/src/components/map/mapGeo.ts` | Único punto de conversión `{lat,lng}` ↔ `[lng,lat]`. Cálculo de bounds y construcción de GeoJSON. Sin React. |
| `web/src/components/map/mapStyle.ts` | URLs de los estilos de OpenFreeMap y elección según el tema. |
| `web/src/components/map/BaseMap.tsx` | Sustituye a `MapContainer` + `ThemedTileLayer`. Crea el mapa, aplica el estilo del tema, gestiona el clic sobre el mapa. |
| `web/src/components/map/MapPoint.tsx` | Sustituye a `CircleMarker` + `Popup` anidado: un punto con su ficha. Para mapas de pocos puntos. |
| `web/src/components/map/MapPointsLayer.tsx` | Muchos puntos en una sola capa WebGL, con una única ficha gobernada por estado. Solo para el mapa de operaciones. |
| `web/src/components/map/MapLine.tsx` | Sustituye a `Polyline`. |
| `web/src/components/map/useFitCoords.ts` | Sustituye a los tres componentes `MapView`/`FitBounds` repetidos hoy en tres pantallas. |

### Se modifican

| Fichero | Qué cambia |
|---|---|
| `web/src/components/map/SonarMarker.tsx` | Pasa a `<Marker>` de MapLibre con JSX real en vez de un `string` de HTML. |
| `web/src/components/map/MapSearch.tsx` | `useMap` de vis.gl; `stopPropagation` nativo en lugar de `L.DomEvent`. |
| `web/src/main.tsx:11` | `leaflet/dist/leaflet.css` → `maplibre-gl/dist/maplibre-gl.css`. |
| `web/src/index.css:215-256` | Reglas `.leaflet-*` → `.maplibregl-*`. |
| `web/src/pages/menu/inicio/OperationsMap.tsx` | Marcadores a capa WebGL. |
| `web/src/pages/menu/poste/PosteDetalle/PosteDetalleMap.tsx` | Puntos, línea y sonar a los componentes nuevos. |
| `web/src/pages/menu/ciudad/CiudadDetallePage.tsx` | Ídem. |
| `web/src/pages/menu/evento/EventoDetallePage.tsx` | Ídem. |
| `web/src/pages/menu/reportes/ReportRecorrido.tsx` | Ídem. |
| `web/src/components/dialogs/upsert/CiudadSheet.tsx` | Clic para fijar coordenadas. |
| `web/src/components/dialogs/upsert/PosteSheet.tsx` | Ídem, más puntos y línea. |
| `web/src/components/dialogs/upsert/PosteSheet.test.tsx:79-81` | Mocks. |
| `web/src/pages/menu/reportes/ReportRecorrido.test.tsx:55` | Mocks. |
| `web/package.json` | Dependencias. |

### Se borran

- `web/src/components/map/ThemedTileLayer.tsx` — su trabajo se lo queda `BaseMap`.
- `web/src/components/map/PulsingCircleMarker.tsx` — el pulso pasa a `MapPoint`. **Comprobar antes
  de borrar** que ninguna pantalla lo importa: hoy solo lo importa él mismo.

---

## Tarea 1: Geometría y conversión de coordenadas

El corazón de la seguridad de esta migración. Sin React, todo puro, todo testeable.

**Ficheros:**
- Crear: `web/src/components/map/mapGeo.ts`
- Test: `web/src/components/map/mapGeo.test.ts`

**Interfaces que produce** (las usan casi todas las tareas siguientes):
- `type LatLng = { lat: number; lng: number }`
- `toLngLat(p: LatLng): [number, number]`
- `toLngLatList(ps: LatLng[]): [number, number][]`
- `fromLatLngTuple(t: [number, number]): LatLng`
- `boundsOf(ps: LatLng[]): [[number, number], [number, number]] | null`
- `hasCoords(p: Partial<LatLng> | null | undefined): boolean`
- `pointsToFeatureCollection<T>(points: MapPointData<T>[]): GeoJSON.FeatureCollection`
- `type MapPointData<T> = { lat: number; lng: number; color: string; id: string | number; item: T }`

- [ ] **Paso 1: escribir los tests que fallan**

```ts
// web/src/components/map/mapGeo.test.ts
import { describe, it, expect } from "vitest";
import {
  toLngLat, toLngLatList, fromLatLngTuple, boundsOf, hasCoords, pointsToFeatureCollection,
} from "./mapGeo";

describe("toLngLat", () => {
  it("puts longitude first, which is the opposite of Leaflet", () => {
    expect(toLngLat({ lat: -19.03, lng: -65.26 })).toEqual([-65.26, -19.03]);
  });

  it("does not confuse equal-looking values", () => {
    // A point where lat and lng differ in sign catches a silent swap.
    expect(toLngLat({ lat: 10, lng: -20 })).toEqual([-20, 10]);
  });
});

describe("toLngLatList", () => {
  it("keeps the order of the list and flips every pair", () => {
    expect(toLngLatList([
      { lat: 1, lng: 2 },
      { lat: 3, lng: 4 },
    ])).toEqual([[2, 1], [4, 3]]);
  });
});

describe("fromLatLngTuple", () => {
  it("reads a Leaflet-shaped tuple as lat first", () => {
    expect(fromLatLngTuple([-19.03, -65.26])).toEqual({ lat: -19.03, lng: -65.26 });
  });
});

describe("boundsOf", () => {
  it("returns southwest then northeast, each as [lng, lat]", () => {
    const b = boundsOf([
      { lat: -19, lng: -65 },
      { lat: -17, lng: -63 },
      { lat: -18, lng: -64 },
    ]);
    expect(b).toEqual([[-65, -19], [-63, -17]]);
  });

  it("returns null when there are fewer than two points, because a box needs two", () => {
    expect(boundsOf([])).toBeNull();
    expect(boundsOf([{ lat: 1, lng: 1 }])).toBeNull();
  });

  it("ignores points at 0,0, which is how this codebase marks 'no coordinates'", () => {
    const b = boundsOf([
      { lat: -19, lng: -65 },
      { lat: 0, lng: 0 },
      { lat: -17, lng: -63 },
    ]);
    expect(b).toEqual([[-65, -19], [-63, -17]]);
  });
});

describe("hasCoords", () => {
  it("rejects 0,0, null and undefined", () => {
    expect(hasCoords({ lat: 0, lng: 0 })).toBe(false);
    expect(hasCoords(null)).toBe(false);
    expect(hasCoords(undefined)).toBe(false);
    expect(hasCoords({ lat: 0, lng: -65 })).toBe(false);
  });

  it("accepts a real pair", () => {
    expect(hasCoords({ lat: -19.03, lng: -65.26 })).toBe(true);
  });
});

describe("pointsToFeatureCollection", () => {
  it("writes each point as [lng, lat] and carries its colour and id", () => {
    const fc = pointsToFeatureCollection([
      { id: 7, lat: -19, lng: -65, color: "#DD0031", item: { name: "P7" } },
    ]);
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].geometry).toEqual({ type: "Point", coordinates: [-65, -19] });
    expect(fc.features[0].properties).toMatchObject({ id: 7, color: "#DD0031" });
  });

  it("drops points with no coordinates instead of drawing them off the coast of Africa", () => {
    const fc = pointsToFeatureCollection([
      { id: 1, lat: 0, lng: 0, color: "#000", item: null },
      { id: 2, lat: -19, lng: -65, color: "#000", item: null },
    ]);
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].properties?.id).toBe(2);
  });
});
```

- [ ] **Paso 2: ejecutar y comprobar que falla**

Orden: `npm run test -- mapGeo`
Esperado: FAIL, «Failed to resolve import "./mapGeo"».

- [ ] **Paso 3: implementar**

```ts
// web/src/components/map/mapGeo.ts

/** A point as the rest of this codebase writes it: latitude first, by name. */
export type LatLng = { lat: number; lng: number };

/** A point to be drawn on a map, with the data behind it. */
export type MapPointData<T> = LatLng & {
  id: string | number;
  color: string;
  item: T;
};

/**
 * MapLibre takes coordinates as [longitude, latitude]; Leaflet took them the
 * other way round. This module is the only place allowed to write a raw pair,
 * so a swap can only ever happen here — and the tests above watch this spot.
 */
export function toLngLat(p: LatLng): [number, number] {
  return [p.lng, p.lat];
}

export function toLngLatList(ps: LatLng[]): [number, number][] {
  return ps.map(toLngLat);
}

/** Reads a Leaflet-shaped [lat, lng] tuple back into a named pair. */
export function fromLatLngTuple(t: [number, number]): LatLng {
  return { lat: t[0], lng: t[1] };
}

/** 0,0 is how the database marks "this row has no coordinates yet". */
export function hasCoords(p: Partial<LatLng> | null | undefined): boolean {
  if (!p) return false;
  return (p.lat ?? 0) !== 0 && (p.lng ?? 0) !== 0;
}

/** Southwest and northeast corners, as MapLibre's fitBounds expects them. */
export function boundsOf(ps: LatLng[]): [[number, number], [number, number]] | null {
  const valid = ps.filter(hasCoords);
  if (valid.length < 2) return null;

  const lats = valid.map((p) => p.lat);
  const lngs = valid.map((p) => p.lng);

  return [
    [Math.min(...lngs), Math.min(...lats)],
    [Math.max(...lngs), Math.max(...lats)],
  ];
}

export function pointsToFeatureCollection<T>(
  points: MapPointData<T>[],
): GeoJSON.FeatureCollection<GeoJSON.Point> {
  return {
    type: "FeatureCollection",
    features: points.filter(hasCoords).map((p) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: toLngLat(p) },
      properties: { id: p.id, color: p.color },
    })),
  };
}
```

- [ ] **Paso 4: ejecutar y comprobar que pasa**

Orden: `npm run test -- mapGeo`
Esperado: PASS, 11 tests.

Si `GeoJSON.FeatureCollection` no resuelve, el tipo viene de `@types/geojson`, que ya llega como
dependencia transitiva de `maplibre-gl`. Si TypeScript se queja tras la Tarea 2, volver aquí y
comprobar; **no** añadir `@types/geojson` a mano sin verificar antes que falta de verdad.

---

## Tarea 2: Estilo del mapa según el tema

**Ficheros:**
- Crear: `web/src/components/map/mapStyle.ts`, `web/src/components/map/mapStyle.test.ts`

**Interfaces que produce:**
- `MAP_STYLE_LIGHT: string`, `MAP_STYLE_DARK: string`
- `styleForTheme(resolvedTheme: string): string`

- [ ] **Paso 1: escribir el test que falla**

```ts
// web/src/components/map/mapStyle.test.ts
import { describe, it, expect } from "vitest";
import { styleForTheme, MAP_STYLE_LIGHT, MAP_STYLE_DARK } from "./mapStyle";

describe("styleForTheme", () => {
  it("uses the dark style only for the dark theme", () => {
    expect(styleForTheme("dark")).toBe(MAP_STYLE_DARK);
    expect(styleForTheme("light")).toBe(MAP_STYLE_LIGHT);
  });

  it("falls back to light for anything it does not know", () => {
    expect(styleForTheme("")).toBe(MAP_STYLE_LIGHT);
    expect(styleForTheme("system")).toBe(MAP_STYLE_LIGHT);
  });

  it("points at OpenFreeMap and carries no API key", () => {
    for (const url of [MAP_STYLE_LIGHT, MAP_STYLE_DARK]) {
      expect(url).toMatch(/^https:\/\/tiles\.openfreemap\.org\/styles\//);
      expect(url).not.toMatch(/key|token|api/i);
    }
  });
});
```

- [ ] **Paso 2: ejecutar y comprobar que falla**

Orden: `npm run test -- mapStyle`
Esperado: FAIL por import no resuelto.

- [ ] **Paso 3: implementar**

```ts
// web/src/components/map/mapStyle.ts

/**
 * OpenFreeMap serves OpenStreetMap data with no API key and no registration.
 * "positron" and "dark" are the same two looks the CARTO basemaps gave us
 * before CARTO started stamping "API KEY REQUIRED" on unkeyed tiles.
 */
export const MAP_STYLE_LIGHT = "https://tiles.openfreemap.org/styles/positron";
export const MAP_STYLE_DARK = "https://tiles.openfreemap.org/styles/dark";

export function styleForTheme(resolvedTheme: string): string {
  return resolvedTheme === "dark" ? MAP_STYLE_DARK : MAP_STYLE_LIGHT;
}
```

- [ ] **Paso 4: ejecutar y comprobar que pasa**

Orden: `npm run test -- mapStyle`
Esperado: PASS, 3 tests.

---

## Tarea 3: Instalar las dependencias y crear `BaseMap`

`BaseMap` es el sustituto de `MapContainer` + `ThemedTileLayer`. Toda pantalla lo usa.

**Ficheros:**
- Modificar: `web/package.json` (vía `npm install`), `web/src/main.tsx:11`
- Crear: `web/src/components/map/BaseMap.tsx`, `web/src/components/map/BaseMap.test.tsx`

**Interfaces que consume:** `styleForTheme` (Tarea 2), `LatLng`, `toLngLat` (Tarea 1).

**Interfaces que produce:**

```tsx
type BaseMapProps = {
  center: LatLng;
  zoom: number;
  className?: string;
  style?: React.CSSProperties;
  /** Fired with the geographic point the user clicked. */
  onMapClick?: (p: LatLng) => void;
  children?: React.ReactNode;
};
```

- [ ] **Paso 1: instalar**

```bash
cd web
npm install maplibre-gl@^6 @vis.gl/react-maplibre@^8
```

Comprobar que `package.json` queda con las dos y que **no** ha entrado ninguna otra dependencia de
mapas. No tocar todavía `leaflet`: sigue en uso hasta la Tarea 16.

- [ ] **Paso 2: cambiar el CSS global**

En `web/src/main.tsx:11`, sustituir:

```ts
import 'leaflet/dist/leaflet.css'
```

por:

```ts
import 'leaflet/dist/leaflet.css'
import 'maplibre-gl/dist/maplibre-gl.css'
```

Los dos conviven durante la migración; el de Leaflet se va en la Tarea 16.

- [ ] **Paso 3: escribir el test que falla**

jsdom no tiene WebGL, así que el mapa real nunca arranca en los tests: se comprueba que `BaseMap`
pasa las props correctas al `<Map>` de vis.gl, que es donde puede colarse el error de coordenadas.

```tsx
// web/src/components/map/BaseMap.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import BaseMap from "./BaseMap";
import { MAP_STYLE_DARK, MAP_STYLE_LIGHT } from "./mapStyle";

const mapProps = vi.fn();

vi.mock("@vis.gl/react-maplibre", () => ({
  Map: (props: Record<string, unknown>) => {
    mapProps(props);
    return <div data-testid="gl-map">{props.children as React.ReactNode}</div>;
  },
  NavigationControl: () => null,
}));

const theme = { resolvedTheme: "light" };
vi.mock("../theme-provider", () => ({ useTheme: () => theme }));

describe("BaseMap", () => {
  it("hands MapLibre the centre as longitude and latitude, not the other way round", () => {
    mapProps.mockClear();
    render(<BaseMap center={{ lat: -19.03, lng: -65.26 }} zoom={5} />);

    const props = mapProps.mock.calls[0][0];
    expect(props.initialViewState).toMatchObject({
      longitude: -65.26,
      latitude: -19.03,
      zoom: 5,
    });
  });

  it("follows the theme", () => {
    mapProps.mockClear();
    theme.resolvedTheme = "light";
    render(<BaseMap center={{ lat: 0.1, lng: 0.2 }} zoom={5} />);
    expect(mapProps.mock.calls[0][0].mapStyle).toBe(MAP_STYLE_LIGHT);

    mapProps.mockClear();
    theme.resolvedTheme = "dark";
    render(<BaseMap center={{ lat: 0.1, lng: 0.2 }} zoom={5} />);
    expect(mapProps.mock.calls[0][0].mapStyle).toBe(MAP_STYLE_DARK);
  });

  it("reports clicks as a named lat/lng pair", () => {
    mapProps.mockClear();
    const onMapClick = vi.fn();
    render(<BaseMap center={{ lat: 0.1, lng: 0.2 }} zoom={5} onMapClick={onMapClick} />);

    const props = mapProps.mock.calls[0][0] as { onClick: (e: unknown) => void };
    props.onClick({ lngLat: { lng: -65.26, lat: -19.03 } });

    expect(onMapClick).toHaveBeenCalledWith({ lat: -19.03, lng: -65.26 });
  });

  it("renders what it is given inside the map", () => {
    const { getByText } = render(
      <BaseMap center={{ lat: 0.1, lng: 0.2 }} zoom={5}><span>hijo</span></BaseMap>,
    );
    expect(getByText("hijo")).toBeTruthy();
  });
});
```

- [ ] **Paso 4: ejecutar y comprobar que falla**

Orden: `npm run test -- BaseMap`
Esperado: FAIL por import no resuelto.

- [ ] **Paso 5: implementar**

```tsx
// web/src/components/map/BaseMap.tsx
import { Map, type MapLayerMouseEvent } from "@vis.gl/react-maplibre";
import { useTheme } from "../theme-provider";
import { styleForTheme } from "./mapStyle";
import type { LatLng } from "./mapGeo";

interface BaseMapProps {
  center: LatLng;
  zoom: number;
  className?: string;
  style?: React.CSSProperties;
  /** Fired with the geographic point the user clicked. */
  onMapClick?: (p: LatLng) => void;
  children?: React.ReactNode;
}

/**
 * Every map on the site starts here. It owns the two things no screen should
 * have to think about: which OpenFreeMap style the current theme wants, and
 * the fact that MapLibre speaks [lng, lat] while the rest of the app speaks
 * { lat, lng }.
 */
export default function BaseMap({
  center, zoom, className, style, onMapClick, children,
}: BaseMapProps) {
  const { resolvedTheme } = useTheme();

  return (
    <div className={className} style={style ?? { height: "100%", width: "100%" }}>
      <Map
        initialViewState={{ longitude: center.lng, latitude: center.lat, zoom }}
        mapStyle={styleForTheme(resolvedTheme)}
        style={{ width: "100%", height: "100%" }}
        onClick={onMapClick
          ? (e: MapLayerMouseEvent) => onMapClick({ lat: e.lngLat.lat, lng: e.lngLat.lng })
          : undefined}
        attributionControl={{ compact: true }}
      >
        {children}
      </Map>
    </div>
  );
}
```

**Sin control de zoom, a propósito.** Las siete pantallas pasaban `zoomControl={false}` a su
`MapContainer`: ninguna quería los botones. Pintarlos aquí habría metido un cambio visible en las
siete por la puerta de atrás de un cambio de motor. La rueda y el pellizco siguen funcionando igual.
Tampoco se añade una prop para reactivarlos: cuando alguien los quiera, se añaden entonces.

**Por qué el `<div>` envolvente y no `className` directo en el `<Map>`:** el componente `Map` de
`@vis.gl/react-maplibre` 8.1.3 **no acepta `className`** — ni lo tipa ni lo reenvía en tiempo de
ejecución, así que pasárselo es un no-op silencioso y además rompe el `typecheck`. Comprobado en su
`.d.ts` y en su `map.js`. Dar tamaño al mapa desde un contenedor es la forma estándar con los mapas
GL, y mantiene funcionando las dos maneras en que las pantallas piden tamaño hoy: `className="h-full"`
en el mapa de operaciones y `style={{ height: "100%", minHeight: "420px" }}` en las de detalle.

Añadir al test un caso que fije esto, para que nadie reintroduzca el no-op:

```tsx
  it("puts className on the wrapper, not on the map, which silently ignores it", () => {
    mapProps.mockClear();
    const { container } = render(
      <BaseMap center={{ lat: 0.1, lng: 0.2 }} zoom={5} className="h-full" />,
    );

    expect((container.firstChild as HTMLElement).className).toBe("h-full");
    expect(mapProps.mock.calls[0][0].className).toBeUndefined();
  });
```

Nota sobre `initialViewState`: como su nombre dice, solo se lee al montar. Las pantallas que hoy
recentran el mapa cuando llegan los datos usan el hook de la Tarea 6, no esta prop.

- [ ] **Paso 6: ejecutar y comprobar que pasa**

Orden: `npm run test -- BaseMap`
Esperado: PASS, 4 tests.

- [ ] **Paso 7: lint y tipos**

Orden: `npm run lint && npm run typecheck`
Esperado: sin errores.

---

## Tarea 4: `MapPoint` — un punto con su ficha

Sustituye al par `<CircleMarker><Popup>…</Popup></CircleMarker>`. En vis.gl el popup es **hermano**
del marcador, no hijo, así que este componente se guarda su propio estado de abierto/cerrado y las
pantallas siguen escribiendo el mismo JSX anidado que hoy.

**Ficheros:**
- Crear: `web/src/components/map/MapPoint.tsx`, `web/src/components/map/MapPoint.test.tsx`

**Interfaces que consume:** `LatLng` (Tarea 1).

**Interfaces que produce:**

```tsx
type MapPointProps = {
  center: LatLng;
  /** Radius in pixels, as Leaflet's CircleMarker took it. */
  radius?: number;
  fillColor: string;
  strokeColor?: string;
  strokeWidth?: number;
  fillOpacity?: number;
  /** Adds the same breathing animation the old PulsingCircleMarker had. */
  pulse?: boolean;
  popupMinWidth?: number;
  children?: React.ReactNode;
};
```

- [ ] **Paso 1: escribir el test que falla**

```tsx
// web/src/components/map/MapPoint.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import MapPoint from "./MapPoint";

const markerProps = vi.fn();
const popupProps = vi.fn();

vi.mock("@vis.gl/react-maplibre", () => ({
  Marker: (props: Record<string, unknown>) => {
    markerProps(props);
    return (
      <div
        data-testid="marker"
        onClick={() => (props.onClick as (e: unknown) => void)?.({ originalEvent: { stopPropagation() {} } })}
      >
        {props.children as React.ReactNode}
      </div>
    );
  },
  Popup: (props: Record<string, unknown>) => {
    popupProps(props);
    return <div data-testid="popup">{props.children as React.ReactNode}</div>;
  },
}));

describe("MapPoint", () => {
  it("places the marker with longitude and latitude the right way round", () => {
    markerProps.mockClear();
    render(<MapPoint center={{ lat: -19.03, lng: -65.26 }} fillColor="#000" />);
    expect(markerProps.mock.calls[0][0]).toMatchObject({ longitude: -65.26, latitude: -19.03 });
  });

  it("keeps the popup closed until the point is clicked", () => {
    const { queryByTestId, getByTestId } = render(
      <MapPoint center={{ lat: 1, lng: 2 }} fillColor="#000"><span>ficha</span></MapPoint>,
    );
    expect(queryByTestId("popup")).toBeNull();

    fireEvent.click(getByTestId("marker"));
    expect(queryByTestId("popup")).not.toBeNull();
  });

  it("renders no popup at all when it was given no children", () => {
    const { getByTestId, queryByTestId } = render(
      <MapPoint center={{ lat: 1, lng: 2 }} fillColor="#000" />,
    );
    fireEvent.click(getByTestId("marker"));
    expect(queryByTestId("popup")).toBeNull();
  });

  it("adds the pulsing class only when asked", () => {
    const { container, rerender } = render(
      <MapPoint center={{ lat: 1, lng: 2 }} fillColor="#000" pulse />,
    );
    expect(container.querySelector(".circle-pulse-marker")).not.toBeNull();

    rerender(<MapPoint center={{ lat: 1, lng: 2 }} fillColor="#000" />);
    expect(container.querySelector(".circle-pulse-marker")).toBeNull();
  });
});
```

- [ ] **Paso 2: ejecutar y comprobar que falla**

Orden: `npm run test -- MapPoint`
Esperado: FAIL por import no resuelto.

- [ ] **Paso 3: implementar**

```tsx
// web/src/components/map/MapPoint.tsx
import { useState } from "react";
import { Marker, Popup } from "@vis.gl/react-maplibre";
import type { LatLng } from "./mapGeo";

interface MapPointProps {
  center: LatLng;
  /** Radius in pixels, as Leaflet's CircleMarker took it. */
  radius?: number;
  fillColor: string;
  strokeColor?: string;
  strokeWidth?: number;
  fillOpacity?: number;
  /** Adds the same breathing animation the old PulsingCircleMarker had. */
  pulse?: boolean;
  popupMinWidth?: number;
  children?: React.ReactNode;
}

/**
 * A single dot with an optional card. Screens that draw a handful of points
 * use this; the operations map, whose count has no ceiling, uses
 * MapPointsLayer instead, which draws them all in one WebGL layer.
 *
 * In vis.gl a Popup is a sibling of its Marker, not a child, so the open
 * state lives here and screens keep writing the nested JSX they wrote with
 * react-leaflet.
 */
export default function MapPoint({
  center,
  radius = 7,
  fillColor,
  strokeColor = "#fff",
  strokeWidth = 1.5,
  fillOpacity = 0.95,
  pulse = false,
  popupMinWidth = 200,
  children,
}: MapPointProps) {
  const [open, setOpen] = useState(false);
  const size = radius * 2;

  return (
    <>
      <Marker
        longitude={center.lng}
        latitude={center.lat}
        anchor="center"
        onClick={(e) => {
          // Without this the click also reaches the map underneath, which on
          // the two upsert sheets would move the pin the user just clicked.
          e.originalEvent?.stopPropagation();
          if (children) setOpen(true);
        }}
      >
        <span
          className={pulse ? "circle-pulse-marker" : undefined}
          style={{
            display: "block",
            width: size,
            height: size,
            borderRadius: "50%",
            background: fillColor,
            opacity: fillOpacity,
            border: `${strokeWidth}px solid ${strokeColor}`,
            boxSizing: "content-box",
            cursor: children ? "pointer" : "default",
          }}
        />
      </Marker>

      {open && children && (
        <Popup
          longitude={center.lng}
          latitude={center.lat}
          anchor="bottom"
          offset={size}
          closeOnClick={false}
          onClose={() => setOpen(false)}
          maxWidth={`${Math.max(popupMinWidth, 260)}px`}
        >
          <div style={{ minWidth: popupMinWidth }}>{children}</div>
        </Popup>
      )}
    </>
  );
}
```

- [ ] **Paso 4: ejecutar y comprobar que pasa**

Orden: `npm run test -- MapPoint`
Esperado: PASS, 4 tests.

---

## Tarea 5: `MapLine` — el sustituto de `Polyline`

**Ficheros:**
- Crear: `web/src/components/map/MapLine.tsx`, `web/src/components/map/MapLine.test.tsx`

**Interfaces que consume:** `LatLng`, `toLngLatList` (Tarea 1).

**Interfaces que produce:**

```tsx
type MapLineProps = {
  id: string;
  positions: LatLng[];
  color?: string;
  width?: number;
  opacity?: number;
};
```

`id` es obligatorio: MapLibre identifica sus fuentes y capas por nombre, y dos líneas con el mismo
`id` en un mapa se pisan. Cada pantalla pasa uno propio (`"route"`, `"tramo"`…).

- [ ] **Paso 1: escribir el test que falla**

```tsx
// web/src/components/map/MapLine.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import MapLine from "./MapLine";

const sourceProps = vi.fn();
const layerProps = vi.fn();

vi.mock("@vis.gl/react-maplibre", () => ({
  Source: (props: Record<string, unknown>) => {
    sourceProps(props);
    return <div>{props.children as React.ReactNode}</div>;
  },
  Layer: (props: Record<string, unknown>) => {
    layerProps(props);
    return null;
  },
}));

describe("MapLine", () => {
  it("writes every vertex as [lng, lat]", () => {
    sourceProps.mockClear();
    render(<MapLine id="route" positions={[{ lat: 1, lng: 2 }, { lat: 3, lng: 4 }]} />);

    const data = sourceProps.mock.calls[0][0].data;
    expect(data.geometry.coordinates).toEqual([[2, 1], [4, 3]]);
  });

  it("draws nothing when there are fewer than two vertices", () => {
    sourceProps.mockClear();
    const { container } = render(<MapLine id="route" positions={[{ lat: 1, lng: 2 }]} />);
    expect(sourceProps).not.toHaveBeenCalled();
    expect(container.firstChild).toBeNull();
  });

  it("names its source and layer after the id it was given", () => {
    sourceProps.mockClear();
    layerProps.mockClear();
    render(<MapLine id="tramo" positions={[{ lat: 1, lng: 2 }, { lat: 3, lng: 4 }]} />);

    expect(sourceProps.mock.calls[0][0].id).toBe("tramo");
    expect(layerProps.mock.calls[0][0].id).toBe("tramo-line");
    expect(layerProps.mock.calls[0][0].type).toBe("line");
  });
});
```

- [ ] **Paso 2: ejecutar y comprobar que falla**

Orden: `npm run test -- MapLine`
Esperado: FAIL por import no resuelto.

- [ ] **Paso 3: implementar**

```tsx
// web/src/components/map/MapLine.tsx
import { Source, Layer } from "@vis.gl/react-maplibre";
import { toLngLatList, type LatLng } from "./mapGeo";

interface MapLineProps {
  /** MapLibre names its sources and layers; two lines sharing an id collide. */
  id: string;
  positions: LatLng[];
  color?: string;
  width?: number;
  opacity?: number;
}

export default function MapLine({
  id, positions, color = "#596BAB", width = 3, opacity = 0.7,
}: MapLineProps) {
  if (positions.length < 2) return null;

  const data: GeoJSON.Feature<GeoJSON.LineString> = {
    type: "Feature",
    properties: {},
    geometry: { type: "LineString", coordinates: toLngLatList(positions) },
  };

  return (
    <Source id={id} type="geojson" data={data}>
      <Layer
        id={`${id}-line`}
        type="line"
        layout={{ "line-cap": "round", "line-join": "round" }}
        paint={{ "line-color": color, "line-width": width, "line-opacity": opacity }}
      />
    </Source>
  );
}
```

- [ ] **Paso 4: ejecutar y comprobar que pasa**

Orden: `npm run test -- MapLine`
Esperado: PASS, 3 tests.

---

## Tarea 6: `useFitCoords` — encuadrar el mapa sobre unos puntos

Hoy hay tres copias del mismo componente auxiliar, con nombres distintos y el mismo cuerpo:
`MapView` en [PosteDetalleMap.tsx:96], `MapView` en [CiudadDetallePage.tsx:447] y `MapView` en
[EventoDetallePage.tsx:975], más `FitBounds` en [ReportRecorrido.tsx:416]. Se unifican en un hook.

**Ficheros:**
- Crear: `web/src/components/map/useFitCoords.ts`, `web/src/components/map/useFitCoords.test.tsx`

**Interfaces que consume:** `boundsOf`, `hasCoords`, `LatLng` (Tarea 1).

**Interfaces que produce:**

```ts
function useFitCoords(opts: {
  coords: LatLng[];
  /** When false, the map centres on `center` at `zoom` instead of fitting. */
  fit: boolean;
  center: LatLng;
  zoom: number;
}): void;

/** The hook needs to live inside the map; this is that wrapper, shared. */
function FitView(props: {
  coords: LatLng[];
  fit: boolean;
  center: LatLng;
  zoom: number;
}): null;
```

`FitView` se exporta **desde aquí**, no se redefine en cada pantalla: las tres pantallas de detalle
lo importan tal cual. Es la deuda que se viene arrastrando hoy, con tres copias del mismo auxiliar
en tres ficheros distintos; no se repite en la versión nueva.

- [ ] **Paso 1: escribir el test que falla**

```tsx
// web/src/components/map/useFitCoords.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { useFitCoords } from "./useFitCoords";

const fitBounds = vi.fn();
const flyTo = vi.fn();

vi.mock("@vis.gl/react-maplibre", () => ({
  useMap: () => ({ current: { fitBounds, flyTo } }),
}));

function Probe(props: Parameters<typeof useFitCoords>[0]) {
  useFitCoords(props);
  return null;
}

describe("useFitCoords", () => {
  beforeEach(() => { fitBounds.mockClear(); flyTo.mockClear(); });

  it("fits the box when asked and there are at least two points", () => {
    render(<Probe
      coords={[{ lat: -19, lng: -65 }, { lat: -17, lng: -63 }]}
      fit
      center={{ lat: -18, lng: -64 }}
      zoom={13}
    />);

    expect(fitBounds).toHaveBeenCalledWith([[-65, -19], [-63, -17]], { padding: 40, duration: 0 });
    expect(flyTo).not.toHaveBeenCalled();
  });

  it("centres instead of fitting when fit is off", () => {
    render(<Probe
      coords={[{ lat: -19, lng: -65 }, { lat: -17, lng: -63 }]}
      fit={false}
      center={{ lat: -18, lng: -64 }}
      zoom={13}
    />);

    expect(flyTo).toHaveBeenCalledWith({ center: [-64, -18], zoom: 13, duration: 0 });
    expect(fitBounds).not.toHaveBeenCalled();
  });

  it("does nothing at all when the centre has no coordinates and there is no box", () => {
    render(<Probe coords={[]} fit={false} center={{ lat: 0, lng: 0 }} zoom={13} />);
    expect(flyTo).not.toHaveBeenCalled();
    expect(fitBounds).not.toHaveBeenCalled();
  });
});
```

- [ ] **Paso 2: ejecutar y comprobar que falla**

Orden: `npm run test -- useFitCoords`
Esperado: FAIL por import no resuelto.

- [ ] **Paso 3: implementar**

```ts
// web/src/components/map/useFitCoords.ts
import { useEffect } from "react";
import { useMap } from "@vis.gl/react-maplibre";
import { boundsOf, hasCoords, toLngLat, type LatLng } from "./mapGeo";

interface FitOptions {
  coords: LatLng[];
  /** When false, the map centres on `center` at `zoom` instead of fitting. */
  fit: boolean;
  center: LatLng;
  zoom: number;
}

/**
 * Replaces the four near-identical helper components the screens each had for
 * this: fit the view to a set of points, or fall back to centring on one.
 */
export function useFitCoords({ coords, fit, center, zoom }: FitOptions): void {
  const { current: map } = useMap();

  const bounds = boundsOf(coords);
  // The screens rebuild this array on every render, so depending on it would
  // refit the map continuously. The box it produces is four numbers and only
  // changes when the area to show actually changes, which is the real trigger.
  const boundsKey = bounds ? bounds.flat().join(",") : "";

  useEffect(() => {
    if (!map) return;

    if (fit && bounds) {
      map.fitBounds(bounds, { padding: 40, duration: 0 });
      return;
    }
    if (hasCoords(center)) {
      map.flyTo({ center: toLngLat(center), zoom, duration: 0 });
    }
  // `bounds` is derived from `boundsKey` on the same render, so the key covers it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, fit, boundsKey, center.lat, center.lng, zoom]);
}

/**
 * The hook has to run inside the map to reach it, so it needs a component to
 * live in. Every detail screen used to carry its own copy of this — three
 * files, three names, one body. Now there is one.
 */
export function FitView(props: {
  coords: LatLng[];
  fit: boolean;
  center: LatLng;
  zoom: number;
}): null {
  useFitCoords(props);
  return null;
}
```

Añadir al test del paso 1 una comprobación de que `FitView` no pinta nada y encarga el trabajo al
hook:

```tsx
import { FitView } from "./useFitCoords";

it("FitView renders nothing and just runs the hook", () => {
  const { container } = render(
    <FitView coords={[{ lat: -19, lng: -65 }, { lat: -17, lng: -63 }]} fit center={{ lat: -18, lng: -64 }} zoom={13} />,
  );
  expect(container.firstChild).toBeNull();
  expect(fitBounds).toHaveBeenCalled();
});
```

- [ ] **Paso 4: ejecutar y comprobar que pasa**

Orden: `npm run test -- useFitCoords`
Esperado: PASS, 3 tests.

---

## Tarea 7: `SonarMarker` sobre MapLibre

Hoy construye su HTML como un `string` dentro de `L.divIcon`. Con vis.gl pasa a ser JSX de verdad,
que es más seguro y más legible. **El CSS de `index.css:109-141` no se toca**: las clases siguen
siendo las mismas.

**Ficheros:**
- Modificar: `web/src/components/map/SonarMarker.tsx`
- Crear: `web/src/components/map/SonarMarker.test.tsx`

**Interfaces:** las props se mantienen **idénticas** a las de hoy (`center`, `fillColor`,
`strokeColor`, `rgb`, `dotRadius`, `weight`, `children`) salvo `pane`, que desaparece porque
MapLibre no tiene panes. `center` sigue aceptando la tupla `[lat, lng]` que hoy le pasan las cinco
pantallas, para no tocarlas en esta tarea.

- [ ] **Paso 1: escribir el test que falla**

```tsx
// web/src/components/map/SonarMarker.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { SonarMarker } from "./SonarMarker";

const markerProps = vi.fn();

vi.mock("@vis.gl/react-maplibre", () => ({
  Marker: (props: Record<string, unknown>) => {
    markerProps(props);
    return (
      <div
        data-testid="marker"
        onClick={() => (props.onClick as (e: unknown) => void)?.({ originalEvent: { stopPropagation() {} } })}
      >
        {props.children as React.ReactNode}
      </div>
    );
  },
  Popup: (props: Record<string, unknown>) => <div data-testid="popup">{props.children as React.ReactNode}</div>,
}));

describe("SonarMarker", () => {
  it("takes the Leaflet-shaped [lat, lng] tuple and hands MapLibre the flipped pair", () => {
    markerProps.mockClear();
    render(<SonarMarker center={[-19.03, -65.26]} fillColor="#000" strokeColor="#fff" rgb="0, 0, 0" />);
    expect(markerProps.mock.calls[0][0]).toMatchObject({ longitude: -65.26, latitude: -19.03 });
  });

  it("keeps the ripple markup the stylesheet expects", () => {
    const { container } = render(
      <SonarMarker center={[1, 2]} fillColor="#000" strokeColor="#fff" rgb="0, 0, 0" />,
    );
    expect(container.querySelector(".sonar-root")).not.toBeNull();
    expect(container.querySelectorAll(".sonar-ring")).toHaveLength(4);
    expect(container.querySelector(".sonar-dot")).not.toBeNull();
  });

  it("opens its card on click, like the old popup did", () => {
    const { getByTestId, queryByTestId } = render(
      <SonarMarker center={[1, 2]} fillColor="#000" strokeColor="#fff" rgb="0, 0, 0">
        <span>ficha</span>
      </SonarMarker>,
    );
    expect(queryByTestId("popup")).toBeNull();
    fireEvent.click(getByTestId("marker"));
    expect(queryByTestId("popup")).not.toBeNull();
  });
});
```

- [ ] **Paso 2: ejecutar y comprobar que falla**

Orden: `npm run test -- SonarMarker`
Esperado: FAIL — el componente actual monta `Marker` de react-leaflet, que el mock no cubre.

- [ ] **Paso 3: reescribir el componente**

```tsx
// web/src/components/map/SonarMarker.tsx
import { useState } from "react";
import { Marker, Popup } from "@vis.gl/react-maplibre";

interface SonarMarkerProps {
  /** Latitude first, the way the screens already write it. */
  center: [number, number];
  fillColor: string;
  strokeColor: string;
  /** RGB values as "r, g, b" for the ripple color */
  rgb: string;
  dotRadius?: number;
  weight?: number;
  children?: React.ReactNode;
}

/**
 * The highlighted subject of a map: the pole, the city or the event the screen
 * is about. One per map, so it stays a DOM marker — the CSS ripple in
 * index.css is what makes it read as "this is the one you came to see", and
 * CSS cannot reach a shape painted into the WebGL canvas.
 */
export function SonarMarker({
  center,
  fillColor,
  strokeColor,
  rgb,
  dotRadius = 8,
  weight = 1.5,
  children,
}: SonarMarkerProps) {
  const [open, setOpen] = useState(false);
  const dotPx = dotRadius * 2;
  const areaPx = dotPx + 80;

  return (
    <>
      <Marker
        longitude={center[1]}
        latitude={center[0]}
        anchor="center"
        onClick={(e) => {
          e.originalEvent?.stopPropagation();
          if (children) setOpen(true);
        }}
      >
        <div
          className="sonar-root"
          style={{
            width: areaPx,
            height: areaPx,
            ["--dot" as string]: `${dotPx}px`,
            ["--rgb" as string]: rgb,
            cursor: children ? "pointer" : "default",
          }}
        >
          <span className="sonar-ring sonar-ring-1" />
          <span className="sonar-ring sonar-ring-2" />
          <span className="sonar-ring sonar-ring-1 sonar-b" />
          <span className="sonar-ring sonar-ring-2 sonar-b" />
          <span
            className="sonar-dot"
            style={{
              width: dotPx,
              height: dotPx,
              background: fillColor,
              border: `${weight}px solid ${strokeColor}`,
            }}
          />
        </div>
      </Marker>

      {open && children && (
        <Popup
          longitude={center[1]}
          latitude={center[0]}
          anchor="bottom"
          offset={dotPx}
          closeOnClick={false}
          onClose={() => setOpen(false)}
          maxWidth="280px"
        >
          <div style={{ minWidth: 240 }}>{children}</div>
        </Popup>
      )}
    </>
  );
}
```

Ojo: la clase `sonar-marker`, que hoy da la transición de `transform` al icono de Leaflet
([index.css:141]), ya no se usa: MapLibre coloca el marcador él mismo. Se retira en la Tarea 16.

- [ ] **Paso 4: ejecutar y comprobar que pasa**

Orden: `npm run test -- SonarMarker`
Esperado: PASS, 3 tests.

---

## Tarea 8: `MapSearch` sobre MapLibre

Cambian dos cosas y nada más: de dónde sale el mapa y cómo se evita que el clic en el buscador
llegue al mapa. Toda la parte de Nominatim y la interfaz se quedan igual.

**Ficheros:**
- Modificar: `web/src/components/map/MapSearch.tsx` (líneas 2-3, 14, 24-29, 71)
- Crear: `web/src/components/map/MapSearch.test.tsx`

- [ ] **Paso 1: escribir el test que falla**

```tsx
// web/src/components/map/MapSearch.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import MapSearch from "./MapSearch";

const flyTo = vi.fn();
vi.mock("@vis.gl/react-maplibre", () => ({ useMap: () => ({ current: { flyTo } }) }));

describe("MapSearch", () => {
  beforeEach(() => {
    flyTo.mockClear();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: async () => [
        { place_id: 1, display_name: "Sucre, Bolivia", lat: "-19.03", lon: "-65.26" },
      ],
    }));
  });

  it("flies to the chosen place with longitude first", async () => {
    const { getByPlaceholderText, findByText } = render(<MapSearch />);

    fireEvent.change(getByPlaceholderText("Buscar lugar..."), { target: { value: "Sucre" } });
    const option = await findByText("Sucre");
    fireEvent.click(option);

    await waitFor(() => {
      expect(flyTo).toHaveBeenCalledWith({ center: [-65.26, -19.03], zoom: 14 });
    });
  });
});
```

Este test depende del retardo de 400 ms del buscador. Si vitest no está configurado con temporizador
falso para este fichero, añadir `vi.useFakeTimers()` y avanzar el reloj tras el `change`; comprobar
antes cómo lo resuelven los tests ya existentes del repo.

- [ ] **Paso 2: ejecutar y comprobar que falla**

Orden: `npm run test -- MapSearch`
Esperado: FAIL — el componente aún importa `react-leaflet`, que el mock no cubre.

- [ ] **Paso 3: modificar el componente**

Sustituir las líneas 2-3:

```tsx
import { useMap } from "react-leaflet";
import * as L from "leaflet";
```

por:

```tsx
import { useMap } from "@vis.gl/react-maplibre";
```

Sustituir la línea 14 (`const map = useMap();`) por:

```tsx
const { current: map } = useMap();
```

Sustituir el efecto de las líneas 24-29 (el que llamaba a `L.DomEvent`) por:

```tsx
  // vis.gl mounts plain children of <Map> in a div that sits beside MapLibre's
  // canvas container, and MapLibre binds its interaction handlers on that
  // container — so these events never reach the map by bubbling anyway. The
  // listeners stay as a guard in case a future version mounts children inside
  // it, which is how the Leaflet version of this component was wired.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;

    const stop = (e: Event) => e.stopPropagation();
    const events = ["mousedown", "dblclick", "wheel", "touchstart", "contextmenu"] as const;
    events.forEach((name) => el.addEventListener(name, stop));
    return () => events.forEach((name) => el.removeEventListener(name, stop));
  }, []);
```

**Por qué la lista es más larga que la del plan original:** `L.DomEvent.disableClickPropagation` de
Leaflet también cubría `touchstart` y `contextmenu`. Hoy da igual — los eventos no llegan al mapa por
la disposición del DOM, no por este guardián—, pero dejar el guardián con menos cobertura que el que
sustituye es una trampa para el día en que esa disposición cambie.

**Y una diferencia que importa entender:** en `SonarMarker` el `stopPropagation` **sí** es
imprescindible, porque los hijos de un `Marker` se montan **dentro** del contenedor del lienzo, que
es justo donde MapLibre escucha. Mismo idioma, dos situaciones distintas.

Sustituir la línea 71 del `handleSelect`:

```tsx
    map.flyTo([parseFloat(r.lat), parseFloat(r.lon)], 14);
```

por:

```tsx
    map?.flyTo({ center: [parseFloat(r.lon), parseFloat(r.lat)], zoom: 14 });
```

- [ ] **Paso 4: ejecutar y comprobar que pasa**

Orden: `npm run test -- MapSearch`
Esperado: PASS.

---

## Tarea 9: Migrar `CiudadSheet` — la primera pantalla entera

La más simple de las siete y la que ejercita todo lo construido: mapa, buscador, clic para fijar
coordenadas y marcador destacado. Si esta va bien en el navegador, el resto es repetición.

**Ficheros:**
- Modificar: `web/src/components/dialogs/upsert/CiudadSheet.tsx` (líneas 3-6, 25-29, 132-155)

- [ ] **Paso 1: cambiar los imports** (líneas 3-6)

```tsx
import { MapContainer, useMapEvent } from "react-leaflet";
import { SonarMarker } from "../../map/SonarMarker";
import ThemedTileLayer from "../../map/ThemedTileLayer";
import MapSearch from "../../map/MapSearch";
```

por:

```tsx
import BaseMap from "../../map/BaseMap";
import { SonarMarker } from "../../map/SonarMarker";
import MapSearch from "../../map/MapSearch";
```

- [ ] **Paso 2: borrar el componente `LocationPicker`** (líneas 25-29)

Ya no hace falta: el clic sobre el mapa lo sirve `BaseMap` por prop.

- [ ] **Paso 3: sustituir el bloque del mapa** (líneas 132-155)

```tsx
              <BaseMap
                key={`${ciudad?.id ?? "new"}-${open}`}
                center={lat !== 0 && lng !== 0
                  ? { lat, lng }
                  : { lat: latExample, lng: lngExample }}
                zoom={lat !== 0 ? 13 : 5}
                style={{ height: "100%" }}
                onMapClick={(p) => {
                  setLat(p.lat);
                  setLng(p.lng);
                  if (errors.location) setErrors((prev) => ({ ...prev, location: "" }));
                }}
              >
                <MapSearch />
                {lat !== 0 && lng !== 0 && (
                  <SonarMarker
                    center={[lat, lng]}
                    fillColor="#596BAB"
                    strokeColor="#ffffff"
                    rgb="89, 107, 171"
                    dotRadius={8}
                    weight={1.5}
                  />
                )}
              </BaseMap>
```

- [ ] **Paso 4: comprobar en el navegador**

Orden: `npm run dev`, abrir el diálogo de crear ciudad.
Comprobar, una por una: (a) el mapa carga sin marca de agua; (b) el buscador encuentra un sitio y
vuela hasta él; (c) al hacer clic en el mapa, los campos Lat y Lng se rellenan **con los valores del
sitio donde se hizo clic** — este es el punto donde aparecería un cambio de coordenadas invertido;
(d) el marcador con ondas aparece donde toca y late; (e) el mismo repaso con el tema oscuro.

- [ ] **Paso 5: lint, tipos y suite**

Orden: `npm run lint && npm run typecheck && npm run test`
Esperado: todo en verde.

---

## Tarea 10: Migrar `PosteSheet`

Mismo patrón que la anterior, más una línea y unos cuantos puntos.

**Ficheros:**
- Modificar: `web/src/components/dialogs/upsert/PosteSheet.tsx` (líneas 3, 27-30, 395-450, 505-520)
- Modificar: `web/src/components/dialogs/upsert/PosteSheet.test.tsx` (líneas 79-81)

- [ ] **Paso 1: cambiar los imports**

Quitar `react-leaflet` de la línea 3 y `ThemedTileLayer` de la 27. Añadir:

```tsx
import BaseMap from "../../map/BaseMap";
import MapPoint from "../../map/MapPoint";
import MapLine from "../../map/MapLine";
```

- [ ] **Paso 2: sustituir `MapContainer` por `BaseMap`**

`center={[a, b]}` pasa a `center={{ lat: a, lng: b }}`; se borra `<ThemedTileLayer />`; se quitan
`scrollWheelZoom` y `zoomControl` (BaseMap ya decide eso).

- [ ] **Paso 3: sustituir el `useMapEvent` de la línea 512**

El componente auxiliar que lo envolvía desaparece; su cuerpo pasa a la prop `onMapClick` de
`BaseMap`:

```tsx
                onMapClick={(p) => {
                  setData((d) => ({ ...d, lat: p.lat, lng: p.lng }));
                  onPlace?.();
                }}
```

- [ ] **Paso 4: sustituir cada `CircleMarker`**

Patrón, para cada uno:

```tsx
<CircleMarker center={[x.lat, x.lng]} radius={R} pathOptions={{ color: C, fillColor: F, fillOpacity: O, weight: W }}>
  <Popup minWidth={M}>…</Popup>
</CircleMarker>
```

pasa a:

```tsx
<MapPoint center={{ lat: x.lat, lng: x.lng }} radius={R} strokeColor={C} fillColor={F} fillOpacity={O} strokeWidth={W} popupMinWidth={M}>
  …
</MapPoint>
```

El contenido del popup **no se toca**: es JSX y sigue siendo JSX.

- [ ] **Paso 5: sustituir cada `Polyline`**

```tsx
<Polyline positions={routePath} pathOptions={{ color: "#596BAB", weight: 3, opacity: 0.7 }} />
```

pasa a:

```tsx
<MapLine id="poste-route" positions={routePath.map(([lat, lng]) => ({ lat, lng }))} color="#596BAB" width={3} opacity={0.7} />
```

Comprobar de qué forma llega `routePath` (`fetchOrsRoute` en [web/src/lib/orsRoute.ts]) antes de
escribir el `.map`: si ya viene como objetos, sobra la conversión.

- [ ] **Paso 6: actualizar los mocks del test** (líneas 79-81)

`vi.mock("../../map/ThemedTileLayer", …)` deja de tener sentido porque el fichero desaparece. Se
sustituyen los tres por uno solo del envoltorio:

```tsx
vi.mock("@vis.gl/react-maplibre", () => ({
  Map: ({ children }: { children?: React.ReactNode }) => <div data-testid="map">{children}</div>,
  Marker: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Popup: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Source: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Layer: () => null,
  NavigationControl: () => null,
  useMap: () => ({ current: null }),
}));
vi.mock("../../map/MapSearch", () => ({ default: () => null }));
```

- [ ] **Paso 7: verificar**

Orden: `npm run test -- PosteSheet && npm run lint && npm run typecheck`
Esperado: verde. Después, en `npm run dev`: abrir el diálogo de poste, comprobar el clic para fijar
coordenadas, la línea del tramo y las fichas de los puntos.

---

## Tarea 11: Migrar `PosteDetalleMap`

**Ficheros:**
- Modificar: `web/src/pages/menu/poste/PosteDetalle/PosteDetalleMap.tsx` (líneas 6-10, 91-196)

- [ ] **Paso 1: imports y renombrado**

Cambiar la línea 6 y la 7 por `BaseMap`, `MapPoint`, `MapLine` y el hook `useFitCoords`. **Atención
al nombre:** este fichero ya tiene un componente propio llamado `MapView` (línea 96) que es el
encuadre; se borra y su trabajo lo hace el hook, así que no hay colisión de nombres.

- [ ] **Paso 2: sustituir `MapContainer` por `BaseMap`** y borrar `<ThemedTileLayer />`.

- [ ] **Paso 3: sustituir el `MapView` local por el hook**

`FitView` viene ya hecho de la Tarea 6: **no se redefine aquí**. Se importa y se pone dentro del
mapa, que es donde puede alcanzarlo:

```tsx
import { FitView } from "../../../../components/map/useFitCoords";
import { fromLatLngTuple, type LatLng } from "../../../../components/map/mapGeo";
```

y en el JSX, dentro de `<BaseMap>`:

```tsx
<FitView
  coords={boundsCoords}
  fit={fitTramo}
  center={hasCoords ? center : { lat: 0, lng: 0 }}
  zoom={15}
/>
```

El `{ lat: 0, lng: 0 }` no es un valor mágico: es como esta base de datos marca «sin coordenadas», y
`useFitCoords` lo reconoce y no mueve el mapa.

**Ojo con el zoom, que aquí son dos y distintos:** el mapa se abre a 13 (`BaseMap`), pero el botón
«Centrar» acerca a 15 — así lo hacía el `map.setView(center, 15)` del ayudante original. Poner 13 en
los dos sitios deja al usuario más lejos de lo que estaba cada vez que pulsa ese botón.


Comprobar la forma de `boundsCoords` y `center` en este fichero: si son tuplas `[lat, lng]`,
convertirlas con `fromLatLngTuple` de `mapGeo` — **no** a mano.

- [ ] **Paso 4: sustituir los `CircleMarker` y el `Polyline`** con el patrón de la Tarea 10.
Son: Ciudad A, Ciudad B, los otros postes del tramo (`.map`), y la ruta. `id` de la línea:
`"poste-detalle-route"`.

- [ ] **Paso 5: el `SonarMarker` no cambia** — sus props son las mismas; solo pierde `pane` si lo
tuviera.

- [ ] **Paso 6: verificar**

Orden: `npm run lint && npm run typecheck && npm run test`
Después, en el navegador: abrir el detalle de un poste, comprobar el botón «Ver tramo» / «Centrar»
(es el que ejercita `useFitCoords`), las fichas de las ciudades y la ruta.

---

## Tarea 12: Migrar `CiudadDetallePage`

**Ficheros:**
- Modificar: `web/src/pages/menu/ciudad/CiudadDetallePage.tsx` (líneas 5-8, 194-244, 443-457)

- [ ] **Paso 1: imports** — igual que en la Tarea 11.
- [ ] **Paso 2:** `MapContainer` → `BaseMap`, sin `ThemedTileLayer`.
- [ ] **Paso 3:** el `MapView` local de la línea 447 se borra y en su lugar va el `FitView` **importado** de `useFitCoords` (Tarea 6), con zoom 13. No redefinirlo.
- [ ] **Paso 4:** cada `CircleMarker` con su `Popup` → `MapPoint`, con el contenido intacto.
- [ ] **Paso 5:** verificar con `npm run lint && npm run typecheck && npm run test`, y en el
  navegador el detalle de una ciudad con y sin postes asociados.

---

## Tarea 13: Migrar `EventoDetallePage`

Es el fichero más largo (985 líneas), pero el mapa ocupa solo las líneas 352-452.

**Ficheros:**
- Modificar: `web/src/pages/menu/evento/EventoDetallePage.tsx` (líneas 4-7, 352-452, 971-985)

- [ ] **Paso 1 a 4:** mismo procedimiento que la Tarea 12, con zoom 15 en `FitView` y `id`
  `"evento-route"` para la línea.
- [ ] **Paso 5:** verificar con `npm run lint && npm run typecheck && npm run test`, y en el
  navegador un evento con tramo y otro sin coordenadas.

---

## Tarea 14: Migrar `ReportRecorrido`

**Ficheros:**
- Modificar: `web/src/pages/menu/reportes/ReportRecorrido.tsx` (líneas 5, 412-470)
- Modificar: `web/src/pages/menu/reportes/ReportRecorrido.test.tsx` (línea 55)

- [ ] **Paso 1 a 4:** mismo procedimiento. El `FitBounds` de la línea 416 → `FitView`; `id` de la
  línea: `"recorrido-route"`.
- [ ] **Paso 5:** el mock de la línea 55 (`vi.mock("…/ThemedTileLayer")`) se sustituye por el mock de
  `@vis.gl/react-maplibre` de la Tarea 10, paso 6.
- [ ] **Paso 6:** verificar con `npm run test -- ReportRecorrido && npm run lint && npm run typecheck`,
  y en el navegador generar un recorrido con los dos filtros (Eventos / Postes).

---

## Tarea 15: `MapPointsLayer` y el mapa de operaciones

La tarea que justifica la migración. Los marcadores dejan de ser elementos del DOM y pasan a una
sola capa WebGL; la ficha es una sola, y se abre sobre el punto que se pulse.

**Ficheros:**
- Crear: `web/src/components/map/MapPointsLayer.tsx`, `web/src/components/map/MapPointsLayer.test.tsx`
- Modificar: `web/src/pages/menu/inicio/OperationsMap.tsx` (líneas 6-7, 110-245)

**Interfaces que consume:** `MapPointData`, `pointsToFeatureCollection` (Tarea 1).

**Interfaces que produce:**

```tsx
type MapPointsLayerProps<T> = {
  id: string;
  points: MapPointData<T>[];
  radius?: number;
  strokeColor?: string;
  strokeWidth?: number;
  /** Renders the card for whichever point was clicked. */
  renderPopup: (item: T) => React.ReactNode;
  popupMinWidth?: number;
};
```

- [ ] **Paso 1: escribir el test que falla**

```tsx
// web/src/components/map/MapPointsLayer.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import MapPointsLayer from "./MapPointsLayer";

const sourceProps = vi.fn();
const layerProps = vi.fn();

vi.mock("@vis.gl/react-maplibre", () => ({
  Source: (props: Record<string, unknown>) => {
    sourceProps(props);
    return <div>{props.children as React.ReactNode}</div>;
  },
  Layer: (props: Record<string, unknown>) => { layerProps(props); return null; },
  Popup: (props: Record<string, unknown>) => <div data-testid="popup">{props.children as React.ReactNode}</div>,
  useMap: () => ({ current: null }),
}));

const points = [
  { id: 1, lat: -19, lng: -65, color: "#DD0031", item: { name: "uno" } },
  { id: 2, lat: -17, lng: -63, color: "#249243", item: { name: "dos" } },
];

describe("MapPointsLayer", () => {
  it("sends every point to one source, flipped to [lng, lat]", () => {
    sourceProps.mockClear();
    render(<MapPointsLayer id="ops" points={points} renderPopup={() => null} />);

    const fc = sourceProps.mock.calls[0][0].data;
    expect(fc.features).toHaveLength(2);
    expect(fc.features[0].geometry.coordinates).toEqual([-65, -19]);
  });

  it("colours each dot from its own property instead of one colour for all", () => {
    layerProps.mockClear();
    render(<MapPointsLayer id="ops" points={points} renderPopup={() => null} />);

    expect(layerProps.mock.calls[0][0].paint["circle-color"]).toEqual(["get", "color"]);
  });

  it("draws a single layer no matter how many points there are", () => {
    layerProps.mockClear();
    const many = Array.from({ length: 500 }, (_, i) => ({
      id: i, lat: -19 + i / 1000, lng: -65, color: "#000", item: { name: `p${i}` },
    }));
    render(<MapPointsLayer id="ops" points={many} renderPopup={() => null} />);

    expect(layerProps).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Paso 2: ejecutar y comprobar que falla**

Orden: `npm run test -- MapPointsLayer`
Esperado: FAIL por import no resuelto.

- [ ] **Paso 3: implementar**

```tsx
// web/src/components/map/MapPointsLayer.tsx
import { useEffect, useMemo, useState } from "react";
import { Source, Layer, Popup, useMap } from "@vis.gl/react-maplibre";
import type { MapMouseEvent } from "maplibre-gl";
import { pointsToFeatureCollection, type MapPointData } from "./mapGeo";

interface MapPointsLayerProps<T> {
  id: string;
  points: MapPointData<T>[];
  radius?: number;
  strokeColor?: string;
  strokeWidth?: number;
  /** Renders the card for whichever point was clicked. */
  renderPopup: (item: T) => React.ReactNode;
  popupMinWidth?: number;
}

/**
 * Draws any number of points in one WebGL layer instead of one DOM element
 * each. This is the whole reason for the MapLibre migration: the dashboard
 * asks the server for every pole and every event with no limit, so this count
 * has no ceiling and grows with the customer's database.
 *
 * Only one card exists at a time — the one for the point that was clicked.
 */
export default function MapPointsLayer<T>({
  id,
  points,
  radius = 7,
  strokeColor = "#fff",
  strokeWidth = 1.5,
  renderPopup,
  popupMinWidth = 205,
}: MapPointsLayerProps<T>) {
  const { current: map } = useMap();
  const [selected, setSelected] = useState<MapPointData<T> | null>(null);

  const data = useMemo(() => pointsToFeatureCollection(points), [points]);
  const layerId = `${id}-circles`;

  // The click has to be registered on the map, not on the layer: a WebGL shape
  // is not an element and cannot carry its own handler.
  useEffect(() => {
    if (!map) return;

    const onClick = (e: MapMouseEvent) => {
      const hit = map.queryRenderedFeatures(e.point, { layers: [layerId] })[0];
      if (!hit) return;
      const clicked = points.find((p) => p.id === hit.properties?.id);
      if (clicked) setSelected(clicked);
    };
    const onEnter = () => { map.getCanvas().style.cursor = "pointer"; };
    const onLeave = () => { map.getCanvas().style.cursor = ""; };

    map.on("click", layerId, onClick);
    map.on("mouseenter", layerId, onEnter);
    map.on("mouseleave", layerId, onLeave);

    return () => {
      map.off("click", layerId, onClick);
      map.off("mouseenter", layerId, onEnter);
      map.off("mouseleave", layerId, onLeave);
    };
  }, [map, layerId, points]);

  return (
    <>
      <Source id={id} type="geojson" data={data}>
        <Layer
          id={layerId}
          type="circle"
          paint={{
            "circle-radius": radius,
            "circle-color": ["get", "color"],
            "circle-opacity": 0.95,
            "circle-stroke-color": strokeColor,
            "circle-stroke-width": strokeWidth,
          }}
        />
      </Source>

      {selected && (
        <Popup
          longitude={selected.lng}
          latitude={selected.lat}
          anchor="bottom"
          offset={radius + 4}
          closeOnClick={false}
          onClose={() => setSelected(null)}
          maxWidth="280px"
        >
          <div style={{ minWidth: popupMinWidth }}>{renderPopup(selected.item)}</div>
        </Popup>
      )}
    </>
  );
}
```

- [ ] **Paso 4: ejecutar y comprobar que pasa**

Orden: `npm run test -- MapPointsLayer`
Esperado: PASS, 3 tests.

- [ ] **Paso 5: migrar `OperationsMap`**

Los dos bloques de ficha (poste y evento, líneas 133-241) son JSX y **se conservan tal cual**; solo
cambian de sitio: pasan a dos funciones, `PostePopup(item)` y `EventoPopup(item)`, dentro del mismo
fichero. El bucle `mapMarkers.map(...)` desaparece y en su lugar:

```tsx
<BaseMap center={{ lat: latExample, lng: lngExample }} zoom={5} className="h-full">
  <MapPointsLayer
    id="operations"
    points={mapMarkers.map((m, i) => ({
      id: m.item.id ?? i,
      lat: m.lat,
      lng: m.lng,
      color: m.isPoste
        ? "#596BAB"
        : mapTab === "pendientes"
          ? (m.item.priority ? "#DD0031" : "#FF5500")
          : "#249243",
      item: m,
    }))}
    radius={MAP_RADIUS.main}
    strokeWidth={MAP_WEIGHT.main}
    renderPopup={(m) => (m.isPoste ? PostePopup(m) : EventoPopup(m))}
  />
</BaseMap>
```

- [ ] **Paso 6: verificar el rendimiento, que es el motivo de todo esto**

Orden: `npm run dev`, abrir `/app/home`.
Comprobar: (a) los marcadores aparecen con los colores de siempre en las tres pestañas; (b) al pulsar
uno se abre su ficha y los botones «Ver detalle», «Editar», «Resolver» y «Agregar revisión» siguen
funcionando; (c) arrastrar y hacer zoom con todos los marcadores en pantalla va fluido.

---

## Tarea 16: Limpieza, estilos y cierre

**Ficheros:**
- Borrar: `web/src/components/map/ThemedTileLayer.tsx`, `web/src/components/map/PulsingCircleMarker.tsx`
- Modificar: `web/src/index.css` (líneas 141 y 215-256), `web/src/main.tsx:11`, `web/package.json`

- [ ] **Paso 1: comprobar que Leaflet ya no se usa en ninguna parte**

Orden: `grep -rn "leaflet" web/src --include="*.ts" --include="*.tsx"`
Esperado: ninguna coincidencia salvo, quizá, comentarios. Si aparece código, esa pantalla se quedó a
medias: volver a su tarea. **No continuar hasta que salga limpio.**

- [ ] **Paso 2: borrar los dos componentes muertos**

Antes de borrar `PulsingCircleMarker.tsx`, comprobar con `grep -rn "PulsingCircleMarker" web/src`
que nadie lo importa.

- [ ] **Paso 3: pasar el CSS de Leaflet a MapLibre**

En `web/src/index.css`, sustituir el bloque de las líneas 215-256. Los nombres cambian así:
`.leaflet-container` → `.maplibregl-map`; `.leaflet-control-attribution` → `.maplibregl-ctrl-attrib`;
`.leaflet-popup-content-wrapper` → `.maplibregl-popup-content`; `.leaflet-popup-tip` →
`.maplibregl-popup-tip`; `.leaflet-popup-close-button` → `.maplibregl-popup-close-button`. Las
declaraciones de dentro no cambian.

Borrar también la regla `.sonar-marker` de la línea 141, que estilaba el icono de Leaflet y ya no
tiene destinatario.

**La atribución se estila, no se oculta**: los datos son de OpenStreetMap bajo ODbL y la licencia
obliga a mostrarla.

- [ ] **Paso 4: quitar el CSS y las dependencias de Leaflet**

En `web/src/main.tsx:11`, borrar `import 'leaflet/dist/leaflet.css'` y dejar solo el de MapLibre.

```bash
cd web
npm uninstall leaflet react-leaflet @types/leaflet
```

- [ ] **Paso 5: medir el bundle**

Orden: `npm run build`
Anotar el tamaño de los ficheros que Vite lista al final. Se espera un aumento de unos 250 KB
comprimidos frente a la versión con Leaflet: es el precio ya asumido en la decisión. Si `maplibre-gl`
acaba dentro del bloque principal y no en uno propio, valorar cargar los mapas con `React.lazy` para
que solo lo descargue quien abre una pantalla con mapa. **Anotar el número, no dejarlo a ojo.**

- [ ] **Paso 6: repaso completo en el navegador, tema claro y tema oscuro**

Las siete pantallas, una por una: inicio, detalle de poste, detalle de ciudad, detalle de evento,
informe de recorrido, diálogo de ciudad y diálogo de poste. En cada una: que el mapa cargue sin marca
de agua, que los puntos estén **donde deben** (un punto en otro continente es el síntoma de las
coordenadas invertidas) y que las fichas abran y sus botones funcionen.

Prueba específica del cambio de tema: con un mapa abierto, cambiar de claro a oscuro y comprobar que
los puntos y las líneas **siguen ahí** después del cambio. MapLibre recarga el estilo entero al
cambiarlo, y las capas propias se pierden si el envoltorio no las vuelve a montar. Si desaparecen,
la solución es dar `key={resolvedTheme}` al `<Map>` de `BaseMap` para forzar un remontaje limpio;
anotarlo si hace falta.

- [ ] **Paso 7: suite completa**

Orden: `npm run build` (encadena lint, tests, typecheck y build)
Esperado: verde de punta a punta.

- [ ] **Paso 8: el commit, uno solo**

Añadir **por nombre** los ficheros de esta migración. Nunca `git add -A`: hay otras sesiones
trabajando en el mismo árbol. Si algún fichero mezcla trabajo ajeno, dejarlo fuera y decírselo a
Isaias.

```bash
git add web/src/components/map web/src/pages/menu/inicio/OperationsMap.tsx \
  web/src/pages/menu/poste/PosteDetalle/PosteDetalleMap.tsx \
  web/src/pages/menu/ciudad/CiudadDetallePage.tsx \
  web/src/pages/menu/evento/EventoDetallePage.tsx \
  web/src/pages/menu/reportes/ReportRecorrido.tsx \
  web/src/pages/menu/reportes/ReportRecorrido.test.tsx \
  web/src/components/dialogs/upsert/CiudadSheet.tsx \
  web/src/components/dialogs/upsert/PosteSheet.tsx \
  web/src/components/dialogs/upsert/PosteSheet.test.tsx \
  web/src/index.css web/src/main.tsx web/package.json web/package-lock.json \
  api/docs/plans/2026-09-04-migracion-maplibre.md
```

- [ ] **Paso 9: la bitácora**

Escribir la entrada de la tarea en `~/.claude/bitacora/donefy/2026-W36.md`, releyendo el fichero
antes por si otra sesión ya abrió el encabezado del día.

---

## Riesgos conocidos

| Riesgo | Cómo se detecta | Qué hacer |
|---|---|---|
| Coordenadas invertidas | Un punto aparece en otro continente, o el clic rellena Lat/Lng cruzados | `mapGeo.ts` es el único sitio que las voltea, y sus tests lo vigilan. Si aparece, el fallo está en una pantalla que se saltó los componentes. |
| Las capas se pierden al cambiar de tema | Los puntos desaparecen al pasar de claro a oscuro | `key={resolvedTheme}` en el `<Map>` de `BaseMap` (Tarea 16, paso 6). |
| Los tests no arrancan por falta de WebGL | Error de contexto gráfico en vitest | Mockear `@vis.gl/react-maplibre` en cada test que monte un mapa, como en la Tarea 10, paso 6. |
| Bundle más pesado de lo aceptable | El número medido en la Tarea 16, paso 5 | Cargar las pantallas con mapa mediante `React.lazy`. |
| OpenFreeMap deja de estar disponible | Los mapas salen en blanco | El estilo es una URL en `mapStyle.ts`: se cambia en una línea. El stack es abierto y puede auto-hospedarse. |

## Fuera de alcance

- La paginación de `getDashboard`, que hoy trae las tablas enteras. Es un problema real y anotado,
  pero no lo arregla esta migración.
- Aprovechar lo que MapLibre trae y Leaflet no tenía: girar o inclinar el mapa, agrupar puntos
  cercanos, mapas de calor. Se podrá plantear después, sobre la base que deja este plan.
