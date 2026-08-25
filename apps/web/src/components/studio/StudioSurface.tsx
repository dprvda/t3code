/**
 * The studio screens render as full-viewport layers above the developer
 * workspace. The workspace's floating sidebar toggle shares the same stacking
 * level, so while a studio screen is mounted we hide it — it controls a
 * sidebar the viewer cannot see. The style is removed on unmount.
 */
export function HideWorkspaceChrome() {
  return <style>{`[data-sidebar-control]{visibility:hidden}`}</style>;
}
