export type ClassroomPanelState = {
  historyOpen: boolean;
  drawerOpen: boolean;
};

export function classroomPanelDefaults(width: number): ClassroomPanelState {
  if (width >= 1600) return { historyOpen: true, drawerOpen: true };
  if (width >= 1280) return { historyOpen: true, drawerOpen: false };
  return { historyOpen: false, drawerOpen: false };
}
