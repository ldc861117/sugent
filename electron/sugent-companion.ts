import { BrowserWindow, Menu, globalShortcut, ipcMain, screen } from "electron";
import fs from "node:fs";
import path from "node:path";
import { t } from "../src/i18n/index.js";

export type CompanionDockEdge = "bottom" | "left" | "right" | "free";
export type CompanionFacing = "left" | "right";
export type CompanionDockMode = "screen" | "main_window";

export interface CompanionHandoffPayload {
  hash?: string;
  draftText?: string;
  source?: string;
}

export interface CompanionPointerPayload {
  lookX: number;
  lookY: number;
  distPx: number;
  near: boolean;
}

export interface CompanionContextMenuOptions {
  quiet?: boolean;
  dockMode?: CompanionDockMode;
}

export interface CompanionStateSnapshot {
  supported: boolean;
  visible: boolean;
  expanded: boolean;
  dockEdge?: CompanionDockEdge;
  facing?: CompanionFacing;
  dockMode?: CompanionDockMode;
}

export interface CompanionControllerOptions {
  dataDir: string;
  companionUrl: string;
  preloadPath: string;
  onOpenMain: (hash?: string) => void;
  getMainWindow?: () => BrowserWindow | undefined;
  onHandoffToMain?: (payload: CompanionHandoffPayload) => void;
}

const COMPACT_W = 156;
const COMPACT_H = 168;
const EXPANDED_W = 430;
const EXPANDED_H = 460;
const SNAP_THRESHOLD = 48;
const GAZE_ACTIVE_MS = 33;
const GAZE_IDLE_MS = 150;
const GAZE_IDLE_AFTER_MS = 2000;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export class SugentCompanionController {
  private win: BrowserWindow | undefined;
  private visible = true;
  private expanded = false;
  private dockEdge: CompanionDockEdge = "bottom";
  private dockMode: CompanionDockMode = "screen";
  private pos: { x: number; y: number } | undefined;
  private readonly statePath: string;
  private shortcutRegistered = "";
  private gazeTimer: ReturnType<typeof setTimeout> | undefined;
  private lastCursorScreen: { x: number; y: number } | undefined;
  private lastCursorMoveAt = 0;
  private lastSentPointer: CompanionPointerPayload | undefined;
  private settleTimer: ReturnType<typeof setInterval> | undefined;
  private trackedMainWin: BrowserWindow | undefined;
  private mainWinListeners: Array<[string, () => void]> = [];
  private destroyed = false;

  constructor(private readonly opts: CompanionControllerOptions) {
    this.statePath = path.join(opts.dataDir, "companion-state.json");
    this.loadPosition();
    this.registerIpc();
    this.registerShortcut();
    this.bindMainWindow(this.opts.getMainWindow?.());
  }

  private loadPosition(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.statePath, "utf8")) as {
        x?: number; y?: number; visible?: boolean; dockEdge?: CompanionDockEdge; dockMode?: CompanionDockMode;
      };
      if (typeof raw.x === "number" && typeof raw.y === "number") this.pos = { x: raw.x, y: raw.y };
      if (typeof raw.visible === "boolean") this.visible = raw.visible;
      if (raw.dockEdge && ["bottom", "left", "right", "free"].includes(raw.dockEdge)) this.dockEdge = raw.dockEdge;
      if (raw.dockMode === "screen" || raw.dockMode === "main_window") this.dockMode = raw.dockMode;
    } catch {
      /* ignore first boot */
    }
  }

  private saveState(): void {
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      fs.writeFileSync(
        this.statePath,
        JSON.stringify({ ...this.pos, visible: this.visible, dockEdge: this.dockEdge, dockMode: this.dockMode }, null, 2),
        "utf8",
      );
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

  private activeMainWindow(): BrowserWindow | undefined {
    const mw = this.opts.getMainWindow?.();
    if (!mw || mw.isDestroyed() || !mw.isVisible() || mw.isMinimized()) return undefined;
    return mw;
  }

  private mainWindowDockAnchor(mw: BrowserWindow): { x: number; y: number } {
    const mb = mw.getBounds();
    const wa = screen.getDisplayMatching(mb).workArea;
    const x = Math.round(clamp(mb.x + mb.width + 8, wa.x + 8, wa.x + wa.width - COMPACT_W - 8));
    const y = Math.round(clamp(mb.y + mb.height - COMPACT_H - 12, wa.y + 8, wa.y + wa.height - COMPACT_H - 8));
    return { x, y };
  }

  private currentCompactAnchor(): { x: number; y: number } {
    if (this.dockMode === "main_window") {
      const mw = this.activeMainWindow();
      if (mw) return this.mainWindowDockAnchor(mw);
    }
    return this.pos ?? this.defaultCompactBounds();
  }

  private computeFacing(): CompanionFacing {
    if (this.dockMode === "main_window") {
      const mw = this.activeMainWindow();
      if (mw) {
        const mb = mw.getBounds();
        const anchor = this.mainWindowDockAnchor(mw);
        return anchor.x + COMPACT_W * 0.5 < mb.x + mb.width * 0.5 ? "right" : "left";
      }
    }
    if (this.dockEdge === "left") return "right";
    if (this.dockEdge === "right") return "left";
    const wa = screen.getPrimaryDisplay().workArea;
    const anchor = this.pos ?? this.defaultCompactBounds();
    return anchor.x + COMPACT_W * 0.5 < wa.x + wa.width * 0.5 ? "right" : "left";
  }

  private sendContext(): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.webContents.send("companion:context", {
      dockEdge: this.dockEdge,
      facing: this.computeFacing(),
      dockMode: this.dockMode,
    });
  }

  private stopSettleAnim(): void {
    if (this.settleTimer) {
      clearInterval(this.settleTimer);
      this.settleTimer = undefined;
    }
  }

  private moveCompactTo(target: { x: number; y: number }, animate: boolean): void {
    if (!this.win || this.win.isDestroyed() || !this.visible || this.expanded) return;
    this.stopSettleAnim();
    const cur = this.win.getBounds();
    if (!animate || Math.hypot(target.x - cur.x, target.y - cur.y) < 4) {
      this.win.setPosition(target.x, target.y);
      return;
    }
    const sx = cur.x;
    const sy = cur.y;
    const steps = 6;
    let step = 0;
    this.settleTimer = setInterval(() => {
      if (!this.win || this.win.isDestroyed() || !this.visible || this.expanded) {
        this.stopSettleAnim();
        return;
      }
      step += 1;
      const p = 1 - Math.pow(1 - step / steps, 2);
      this.win.setPosition(Math.round(sx + (target.x - sx) * p), Math.round(sy + (target.y - sy) * p));
      if (step >= steps) this.stopSettleAnim();
    }, 18);
  }

  private syncToMainWindow(animate = false): void {
    if (this.dockMode !== "main_window") return;
    const mw = this.activeMainWindow();
    if (!mw) {
      this.settleToScreenPos(true);
      return;
    }
    this.moveCompactTo(this.mainWindowDockAnchor(mw), animate);
    this.sendContext();
  }

  private settleToScreenPos(animate = true): void {
    const target = this.pos ?? this.defaultCompactBounds();
    this.moveCompactTo(target, animate);
    this.sendContext();
  }

  private unbindMainWindow(): void {
    if (this.trackedMainWin && !this.trackedMainWin.isDestroyed()) {
      for (const [ev, fn] of this.mainWinListeners) {
        this.trackedMainWin.removeListener(ev as never, fn);
      }
    }
    this.mainWinListeners = [];
    this.trackedMainWin = undefined;
  }

  bindMainWindow(mw?: BrowserWindow): void {
    const target = mw ?? this.opts.getMainWindow?.();
    if (!target || target.isDestroyed()) return;
    if (this.trackedMainWin === target) return;
    this.unbindMainWindow();
    this.trackedMainWin = target;
    const onMoveOrResize = () => {
      if (this.dockMode === "main_window") this.syncToMainWindow(false);
    };
    const onShowOrRestore = () => {
      if (this.dockMode === "main_window") this.syncToMainWindow(true);
    };
    const onAway = () => {
      if (this.dockMode === "main_window") this.settleToScreenPos(true);
    };
    const onClosed = () => {
      this.unbindMainWindow();
      if (this.dockMode === "main_window") this.settleToScreenPos(true);
    };
    const entries: Array<[string, () => void]> = [
      ["move", onMoveOrResize],
      ["resize", onMoveOrResize],
      ["show", onShowOrRestore],
      ["restore", onShowOrRestore],
      ["minimize", onAway],
      ["hide", onAway],
      ["closed", onClosed],
    ];
    for (const [ev, fn] of entries) target.on(ev as never, fn);
    this.mainWinListeners = entries;
    if (this.dockMode === "main_window") this.syncToMainWindow(true);
  }

  private snapAfterDrag(): void {
    if (!this.win || this.win.isDestroyed() || this.expanded) return;
    this.stopSettleAnim();
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
    this.dockMode = "screen";
    this.dockEdge = edge;
    this.pos = { x: Math.round(x), y: Math.round(y) };
    this.win.setPosition(this.pos.x, this.pos.y);
    this.saveState();
    this.sendContext();
  }

  private unregisterIpc(): void {
    for (const ch of [
      "companion:resize",
      "companion:move-by",
      "companion:drag-end",
      "companion:open-main",
      "companion:hide",
      "companion:set-dock-mode",
      "companion:handoff",
      "companion:show-context-menu",
    ]) {
      ipcMain.removeAllListeners(ch);
    }
  }

  private registerIpc(): void {
    this.unregisterIpc();
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
    ipcMain.on("companion:set-dock-mode", (_e, mode: unknown) => {
      this.setDockMode(mode === "main_window" ? "main_window" : "screen");
    });
    ipcMain.on("companion:handoff", (_e, payload: CompanionHandoffPayload) => {
      this.handoffToMain(payload);
    });
    ipcMain.on("companion:show-context-menu", (_e, opts?: CompanionContextMenuOptions) => {
      this.showContextMenu(opts);
    });
  }

  setDockMode(mode: CompanionDockMode): CompanionStateSnapshot {
    this.dockMode = mode === "main_window" ? "main_window" : "screen";
    this.bindMainWindow(this.opts.getMainWindow?.());
    if (this.dockMode === "main_window") this.syncToMainWindow(true);
    else this.settleToScreenPos(true);
    this.saveState();
    this.sendContext();
    return this.state();
  }

  handoffToMain(payload?: CompanionHandoffPayload): void {
    const normalized: CompanionHandoffPayload = {
      hash: typeof payload?.hash === "string" && payload.hash.trim() ? payload.hash.trim() : "#/chat/default",
      ...(typeof payload?.draftText === "string" ? { draftText: payload.draftText } : {}),
      ...(typeof payload?.source === "string" ? { source: payload.source } : {}),
    };
    if (this.opts.onHandoffToMain) {
      this.opts.onHandoffToMain(normalized);
      return;
    }
    this.opts.onOpenMain(normalized.hash);
    const mw = this.opts.getMainWindow?.();
    if (!mw || mw.isDestroyed()) return;
    const js = `window.__sugentCompanionHandoff?.(${JSON.stringify(normalized)})`;
    const run = () => {
      if (!mw.isDestroyed()) void mw.webContents.executeJavaScript(js).catch(() => {});
    };
    if (mw.webContents.isLoading()) mw.webContents.once("did-finish-load", run);
    else run();
  }

  showContextMenu(opts?: CompanionContextMenuOptions): void {
    if (!this.win || this.win.isDestroyed()) return;
    const isMainDock = (opts?.dockMode ?? this.dockMode) === "main_window";
    const isQuiet = Boolean(opts?.quiet);
    const menu = Menu.buildFromTemplate([
      { label: t("desktop.companionMenuQuickBar"), click: () => this.showQuickBar() },
      { label: t("desktop.companionMenuOpenMain"), click: () => this.opts.onOpenMain("#/chat/default") },
      { label: t("desktop.companionMenuStewardHub"), click: () => this.opts.onOpenMain("#/steward") },
      { type: "separator" },
      {
        label: isMainDock ? t("desktop.companionMenuDockScreen") : t("desktop.companionMenuDockMain"),
        click: () => this.setDockMode(isMainDock ? "screen" : "main_window"),
      },
      { label: t("desktop.companionMenuStudio"), click: () => this.opts.onOpenMain("#/studio") },
      {
        label: isQuiet ? t("desktop.companionMenuQuietOff") : t("desktop.companionMenuQuietOn"),
        click: () => this.pushSignal({ kind: "toggle_quiet", at: Date.now() }),
      },
      { type: "separator" },
      { label: t("desktop.companionMenuHide"), click: () => this.toggle(false) },
    ]);
    menu.popup({ window: this.win });
  }

  pushSignal(payload: Record<string, unknown>): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.webContents.send("companion:signal", payload);
  }

  private shouldPollGaze(): boolean {
    return !this.destroyed && this.visible && !this.expanded && Boolean(this.win && !this.win.isDestroyed());
  }

  private stopGazePoller(): void {
    if (this.gazeTimer) {
      clearTimeout(this.gazeTimer);
      this.gazeTimer = undefined;
    }
  }

  private syncGazePoller(): void {
    if (!this.shouldPollGaze()) {
      this.stopGazePoller();
      return;
    }
    if (!this.gazeTimer) {
      this.lastCursorMoveAt = Date.now();
      this.gazeTimer = setTimeout(() => this.pollGazeTick(), GAZE_ACTIVE_MS);
    }
  }

  private pollGazeTick(): void {
    this.gazeTimer = undefined;
    if (!this.shouldPollGaze() || !this.win || this.win.isDestroyed()) return;
    const now = Date.now();
    try {
      const pt = screen.getCursorScreenPoint();
      const moved =
        !this.lastCursorScreen ||
        Math.abs(pt.x - this.lastCursorScreen.x) >= 1 ||
        Math.abs(pt.y - this.lastCursorScreen.y) >= 1;
      if (moved) {
        this.lastCursorScreen = { x: pt.x, y: pt.y };
        this.lastCursorMoveAt = now;
      }
      const b = this.win.getBounds();
      const hx = b.x + b.width * 0.5;
      const hy = b.y + b.height * 0.34;
      const dx = pt.x - hx;
      const dy = pt.y - hy;
      const distPx = Math.round(Math.hypot(dx, dy));
      const lookX = Math.round(clamp(dx / 360, -1, 1) * 1000) / 1000;
      const lookY = Math.round(clamp(dy / 260, -1, 1) * 1000) / 1000;
      const near = distPx < 180;
      const prev = this.lastSentPointer;
      if (!prev || prev.lookX !== lookX || prev.lookY !== lookY || prev.distPx !== distPx || prev.near !== near) {
        this.lastSentPointer = { lookX, lookY, distPx, near };
        this.win.webContents.send("companion:pointer", this.lastSentPointer);
      }
    } catch {
      /* ignore transient display/window boundary errors */
    }
    if (this.shouldPollGaze()) {
      const delay = now - this.lastCursorMoveAt > GAZE_IDLE_AFTER_MS ? GAZE_IDLE_MS : GAZE_ACTIVE_MS;
      this.gazeTimer = setTimeout(() => this.pollGazeTick(), delay);
    }
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
    const anchor = this.currentCompactAnchor();
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
      this.stopGazePoller();
      this.stopSettleAnim();
      this.win = undefined;
    });
    this.win.webContents.on("did-finish-load", () => {
      this.sendContext();
      this.syncGazePoller();
    });
    void this.win.loadURL(this.currentUrl || this.opts.companionUrl);
    return this.win;
  }

  private applyResize(width: number, height: number): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.stopSettleAnim();
    const w = Math.max(COMPACT_W, Math.min(EXPANDED_W, Math.round(width)));
    const h = Math.max(COMPACT_H, Math.min(EXPANDED_H, Math.round(height)));
    this.expanded = w > COMPACT_W + 20 || h > COMPACT_H + 20;
    const cur = this.win.getBounds();
    const anchor = this.currentCompactAnchor();
    const wa = screen.getDisplayMatching(cur).workArea;
    const rawX = this.computeFacing() === "right" ? anchor.x : anchor.x + COMPACT_W - w;
    const nextX = Math.max(wa.x + 8, Math.min(wa.x + wa.width - w - 8, rawX));
    const nextY = Math.max(wa.y + 8, Math.min(wa.y + wa.height - h - 8, anchor.y + COMPACT_H - h));
    this.win.setBounds({ x: Math.round(nextX), y: Math.round(nextY), width: w, height: h });
    this.syncGazePoller();
  }

  private moveBy(dx: number, dy: number): void {
    if (!this.win || this.win.isDestroyed() || this.expanded) return;
    this.stopSettleAnim();
    const cur = this.win.getBounds();
    const wa = screen.getDisplayMatching(cur).workArea;
    const x = Math.max(wa.x + 4, Math.min(wa.x + wa.width - cur.width - 4, Math.round(cur.x + dx)));
    const y = Math.max(wa.y + 4, Math.min(wa.y + wa.height - cur.height - 4, Math.round(cur.y + dy)));
    this.pos = { x, y };
    this.win.setPosition(x, y);
    this.saveState();
  }

  private currentUrl?: string;

  updateUrl(nextUrl: string): void {
    const trimmed = nextUrl.trim();
    if (!trimmed) return;
    this.currentUrl = trimmed;
    if (this.win && !this.win.isDestroyed()) {
      void this.win.loadURL(trimmed);
    }
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
      dockMode: this.dockMode,
    };
  }

  toggle(nextVisible?: boolean): CompanionStateSnapshot {
    this.visible = typeof nextVisible === "boolean" ? nextVisible : !this.visible;
    if (this.visible) {
      this.bindMainWindow(this.opts.getMainWindow?.());
      const w = this.ensureWindow();
      w.showInactive();
      if (this.dockMode === "main_window") this.syncToMainWindow(false);
      this.syncGazePoller();
    } else {
      this.expanded = false;
      this.stopGazePoller();
      this.stopSettleAnim();
      if (this.win && !this.win.isDestroyed()) this.win.hide();
    }
    this.saveState();
    return this.state();
  }

  showQuickBar(): CompanionStateSnapshot {
    this.bindMainWindow(this.opts.getMainWindow?.());
    const w = this.ensureWindow();
    this.visible = true;
    w.show();
    w.focus();
    w.webContents.send("companion:toggle-quick-bar");
    this.syncGazePoller();
    this.saveState();
    return this.state();
  }

  destroy(): void {
    this.destroyed = true;
    this.stopGazePoller();
    this.stopSettleAnim();
    this.unbindMainWindow();
    this.unregisterIpc();
    if (this.shortcutRegistered) globalShortcut.unregister(this.shortcutRegistered);
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = undefined;
  }
}
