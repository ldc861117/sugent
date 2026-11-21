import { BrowserWindow, globalShortcut, ipcMain, screen } from "electron";
import fs from "node:fs";
import path from "node:path";

export type CompanionDockEdge = "bottom" | "left" | "right" | "free";
export type CompanionFacing = "left" | "right";

export interface CompanionStateSnapshot {
  supported: boolean;
  visible: boolean;
  expanded: boolean;
  dockEdge?: CompanionDockEdge;
  facing?: CompanionFacing;
}

export interface CompanionControllerOptions {
  dataDir: string;
  companionUrl: string;
  preloadPath: string;
  onOpenMain: (hash?: string) => void;
}

const COMPACT_W = 156;
const COMPACT_H = 168;
const EXPANDED_W = 430;
const EXPANDED_H = 350;
const SNAP_THRESHOLD = 48;

export class SugentCompanionController {
  private win: BrowserWindow | undefined;
  private visible = true;
  private expanded = false;
  private dockEdge: CompanionDockEdge = "bottom";
  private pos: { x: number; y: number } | undefined;
  private readonly statePath: string;
  private shortcutRegistered = "";

  constructor(private readonly opts: CompanionControllerOptions) {
    this.statePath = path.join(opts.dataDir, "companion-state.json");
    this.loadPosition();
    this.registerIpc();
    this.registerShortcut();
  }

  private loadPosition(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.statePath, "utf8")) as {
        x?: number; y?: number; visible?: boolean; dockEdge?: CompanionDockEdge;
      };
      if (typeof raw.x === "number" && typeof raw.y === "number") this.pos = { x: raw.x, y: raw.y };
      if (typeof raw.visible === "boolean") this.visible = raw.visible;
      if (raw.dockEdge && ["bottom", "left", "right", "free"].includes(raw.dockEdge)) this.dockEdge = raw.dockEdge;
    } catch {
      /* ignore first boot */
    }
  }

  private saveState(): void {
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      fs.writeFileSync(this.statePath, JSON.stringify({ ...this.pos, visible: this.visible, dockEdge: this.dockEdge }, null, 2), "utf8");
    } catch {
      /* ignore */
    }
  }

  private defaultCompactBounds(): { x: number; y: number } {
    const wa = screen.getPrimaryDisplay().workArea;
    return {
      x: Math.round(wa.x + wa.width - COMPACT_W - 28),
      y: Math.round(wa.y + wa.height - COMPACT_H - 28),
    };
  }

  private computeFacing(): CompanionFacing {
    if (this.dockEdge === "left") return "right";
    if (this.dockEdge === "right") return "left";
    const wa = screen.getPrimaryDisplay().workArea;
    const anchor = this.pos ?? this.defaultCompactBounds();
    return anchor.x + COMPACT_W * 0.5 < wa.x + wa.width * 0.5 ? "right" : "left";
  }

  private sendContext(): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.webContents.send("companion:context", { dockEdge: this.dockEdge, facing: this.computeFacing() });
  }

  private snapAfterDrag(): void {
    if (!this.win || this.win.isDestroyed() || this.expanded) return;
    const cur = this.win.getBounds();
    const wa = screen.getDisplayMatching(cur).workArea;
    const dLeft = Math.abs(cur.x - wa.x);
    const dRight = Math.abs(wa.x + wa.width - cur.width - cur.x);
    const dBottom = Math.abs(wa.y + wa.height - cur.height - cur.y);
    let x = cur.x;
    let y = cur.y;
    let edge: CompanionDockEdge = "free";
    const minDist = Math.min(dLeft, dRight, dBottom);
    if (minDist <= SNAP_THRESHOLD) {
      if (minDist === dLeft) { x = wa.x + 8; edge = "left"; }
      else if (minDist === dRight) { x = wa.x + wa.width - cur.width - 8; edge = "right"; }
      else { y = wa.y + wa.height - cur.height - 8; edge = "bottom"; }
    }
    this.dockEdge = edge;
    this.pos = { x: Math.round(x), y: Math.round(y) };
    this.win.setPosition(this.pos.x, this.pos.y);
    this.saveState();
    this.sendContext();
  }

  private registerIpc(): void {
    ipcMain.removeAllListeners("companion:resize");
    ipcMain.removeAllListeners("companion:move-by");
    ipcMain.removeAllListeners("companion:drag-end");
    ipcMain.removeAllListeners("companion:open-main");
    ipcMain.removeAllListeners("companion:hide");
    ipcMain.on("companion:resize", (_e, p: { width?: number; height?: number }) => {
      this.applyResize(Number(p?.width) || COMPACT_W, Number(p?.height) || COMPACT_H);
    });
    ipcMain.on("companion:move-by", (_e, d: { dx?: number; dy?: number }) => {
      this.moveBy(Number(d?.dx) || 0, Number(d?.dy) || 0);
    });
    ipcMain.on("companion:drag-end", () => {
      this.snapAfterDrag();
    });
    ipcMain.on("companion:open-main", (_e, hash: string) => {
      this.opts.onOpenMain(hash);
    });
    ipcMain.on("companion:hide", () => {
      this.toggle(false);
    });
  }

  private registerShortcut(): void {
    for (const acc of ["Alt+Space", "CommandOrControl+Shift+Space"]) {
      try {
        if (globalShortcut.register(acc, () => this.showQuickBar())) {
          this.shortcutRegistered = acc;
          break;
        }
      } catch {
        /* try fallback shortcut */
      }
    }
  }

  private ensureWindow(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const anchor = this.pos ?? this.defaultCompactBounds();
    this.win = new BrowserWindow({
      width: COMPACT_W,
      height: COMPACT_H,
      x: anchor.x,
      y: anchor.y,
      frame: false,
      transparent: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: this.opts.preloadPath,
      },
    });
    if (process.platform === "darwin") {
      this.win.setAlwaysOnTop(true, "floating");
      this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }
    this.win.on("closed", () => {
      this.win = undefined;
    });
    this.win.webContents.on("did-finish-load", () => {
      this.sendContext();
    });
    void this.win.loadURL(this.opts.companionUrl);
    return this.win;
  }

  private applyResize(width: number, height: number): void {
    if (!this.win || this.win.isDestroyed()) return;
    const w = Math.max(COMPACT_W, Math.min(EXPANDED_W, Math.round(width)));
    const h = Math.max(COMPACT_H, Math.min(EXPANDED_H, Math.round(height)));
    this.expanded = w > COMPACT_W + 20 || h > COMPACT_H + 20;
    const cur = this.win.getBounds();
    const anchor = this.pos ?? { x: cur.x + cur.width - COMPACT_W, y: cur.y + cur.height - COMPACT_H };
    const wa = screen.getDisplayMatching(cur).workArea;
    const rawX = this.computeFacing() === "right" ? anchor.x : anchor.x + COMPACT_W - w;
    const nextX = Math.max(wa.x + 8, Math.min(wa.x + wa.width - w - 8, rawX));
    const nextY = Math.max(wa.y + 8, Math.min(wa.y + wa.height - h - 8, anchor.y + COMPACT_H - h));
    this.win.setBounds({ x: Math.round(nextX), y: Math.round(nextY), width: w, height: h });
  }

  private moveBy(dx: number, dy: number): void {
    if (!this.win || this.win.isDestroyed() || this.expanded) return;
    const cur = this.win.getBounds();
    const wa = screen.getDisplayMatching(cur).workArea;
    const x = Math.max(wa.x + 4, Math.min(wa.x + wa.width - cur.width - 4, Math.round(cur.x + dx)));
    const y = Math.max(wa.y + 4, Math.min(wa.y + wa.height - cur.height - 4, Math.round(cur.y + dy)));
    this.pos = { x, y };
    this.win.setPosition(x, y);
    this.saveState();
  }

  initVisible(): void {
    if (this.visible) this.toggle(true);
  }

  state(): CompanionStateSnapshot {
    return {
      supported: true,
      visible: this.visible,
      expanded: this.expanded,
      dockEdge: this.dockEdge,
      facing: this.computeFacing(),
    };
  }

  toggle(nextVisible?: boolean): CompanionStateSnapshot {
    this.visible = typeof nextVisible === "boolean" ? nextVisible : !this.visible;
    if (this.visible) {
      const w = this.ensureWindow();
      w.showInactive();
    } else if (this.win && !this.win.isDestroyed()) {
      this.expanded = false;
      this.win.hide();
    }
    this.saveState();
    return this.state();
  }

  showQuickBar(): CompanionStateSnapshot {
    const w = this.ensureWindow();
    this.visible = true;
    w.show();
    w.focus();
    w.webContents.send("companion:toggle-quick-bar");
    this.saveState();
    return this.state();
  }

  destroy(): void {
    if (this.shortcutRegistered) globalShortcut.unregister(this.shortcutRegistered);
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = undefined;
  }
}
