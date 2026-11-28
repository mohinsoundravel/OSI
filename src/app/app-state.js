/**
 * Mutable UI state shared between modules (ES module bindings are read-only to importers).
 * Values are set by the module that owns each one when it loads.
 */
export const appState = {
  briefDirty: undefined,
  events: undefined,
  flightSnapshot: undefined,
  lastTap: undefined,
  notifyEnabled: undefined,
  pickMode: undefined,
  selectedRef: undefined,
  selectorTargetOpacity: undefined,
  shipSnapshot: undefined,
  spots: undefined,
  tagsDirty: undefined,
  unread: undefined,
  zones: undefined
};
