/** Imagery tile sources and level-of-detail parameters. */
import { tileState } from './weather.js';

/* Imagery tiles: streamed level of detail, Google Earth style
   The globe is covered by Web Mercator XYZ tiles chosen per frame from a quadtree:
   a tile is split while it would cover more than SPLIT_PX on screen, so detail follows
   the camera from the whole planet down to street level. Each tile mesh is built
   relative to its own centre so close-up views do not jitter in float32. While a tile's
   own image loads, the nearest loaded ancestor is shown cropped, then cross-faded. */

export const TILE_SOURCES = {
  esriImagery: {
    url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
    minZ: 0, maxZ: 18
  },
  esriPlaces: {
    url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/${z}/${y}/${x}`,
    minZ: 2, maxZ: 18
  },
  esriRoads: {
    url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/${z}/${y}/${x}`,
    minZ: 6, maxZ: 18
  },
  /* CARTO's free basemaps now answer keyless requests with "API key required" tiles,
     so the dark style uses Esri's keyless dark gray canvas (detail to zoom 16). */
  esriDarkBase: {
    url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/${z}/${y}/${x}`,
    minZ: 0, maxZ: 16
  },
  esriDarkLabels: {
    url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/${z}/${y}/${x}`,
    minZ: 2, maxZ: 16
  }
};
const ESRI_CREDIT = 'Powered by Esri · Esri, Maxar, Earthstar Geographics, GIS User Community';
export const MAP_STYLES = {
  hybrid: { label: 'Hybrid', base: 'esriImagery', overlays: ['esriRoads', 'esriPlaces'], credit: ESRI_CREDIT },
  satellite: { label: 'Satellite', base: 'esriImagery', overlays: [], credit: ESRI_CREDIT },
  dark: { label: 'Dark', base: 'esriDarkBase', overlays: ['esriDarkLabels'], credit: 'Powered by Esri \u00b7 Esri, HERE, Garmin, \u00a9 OpenStreetMap contributors' }
};
export const STYLE_ORDER = ['hybrid', 'satellite', 'today', 'dark'];

/** Registers a tile source created at runtime (dated or time-stepped imagery). */
export function defineSource(id, def) {
  if (!TILE_SOURCES[id]) TILE_SOURCES[id] = def;
  return id;
}

/* NASA VIIRS (Suomi NPP) daily true colour, 375 m. Over India the afternoon pass is
   published around 11:00 UTC, so before 12:00 UTC the previous day is shown. */
function viirsDate() {
  const d = new Date();
  if (d.getUTCHours() < 12) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
function viirsSource() {
  const date = viirsDate();
  return defineSource(`viirs:${date}`, {
    url: (z, x, y) => `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/${date}/GoogleMapsCompatible_Level9/${z}/${y}/${x}.jpg`,
    minZ: 0, maxZ: 9
  });
}
export function styleBase() {
  const st = MAP_STYLES[tileState.style];
  return st.dynamicBase ? st.dynamicBase() : st.base;
}

/** Runs this module's start-up code; index.js calls every module's init in order. */
export function init() {
  MAP_STYLES.today = {
    label: 'NASA today', overlays: ['esriPlaces'],
    dynamicBase: () => viirsSource(),
    credit: () => `NASA GIBS \u00b7 VIIRS true colour ${viirsDate()} \u00b7 labels Esri`
  };
}
