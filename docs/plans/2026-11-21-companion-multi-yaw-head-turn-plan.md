# 桌面浮宠 3×3 多朝向真·扭头序列帧与近场眼神微动实施方案

> 日期：2026-11-21
> 状态：已与用户对齐（采用方案 A + B 结合）

## 商业策略自省四问（Pre-Plan Commercial Reflection Gate）

1. **付费锚点（Why Pay & Moat）**：属于**开源体验引流 + 商业定制增值**双轮能力。真实三维透视多朝向扭头序列帧 + 零畸变刚体微动让桌面浮宠摆脱廉价 2D 贴图拉伸感，放大 Sugent 跨模型、跨物种定制的个人数字分身品牌辨识度。
2. **合规与分发（Distribution & ToS Risk）**：纯本地 TypeScript PNG 编解码切图与 HTML5 Canvas 2D 刚体合成，无任何第三方闭源 SDK、无硬编码密钥，100% 兼容 macOS 公证与 Windows 签名分发。
3. **离线退路（Sovereignty Fallback）**：内置 `sugent-core` 与 `clay-atelier` 全套离线 `3×3` 高清资产，同时保留离线本地导入（自动兼容 `3×3`、`3×2` 与单张立绘），断网或 `mode: "none"` 免登录态下 100% 自洽可用。
4. **一人公司运维杠杆（OPC Ops Leverage）**：全部切图、下肢重心锚定、发光眼点检测与近场扭头状态机均在端侧零依赖闭环执行，云端零状态、零额外运维成本。

---

## 一、问题根因与重设计原则

1. **旧版缺陷根因**：
   - `ui/components/companion-stage.js` 原 `drawPoseWithBands` 对单张静态 2D 位图按 2px 扫描线做水平错切（`headShiftX` + `torsoFollow` + `nearLean`），无法产生三维偏航角（Yaw）的五官透视变化，只会将脖子与躯干拉扯成橡皮泥扭曲状；跨侧时的 `turnScaleX` 整身镜像则像翻纸牌。
   - 全屏无差别实时映射鼠标坐标导致用户在屏幕远处正常办公时，浮宠也在持续扭动身体，干扰视线。
2. **A + B 重设计原则**：
   - **彻底废除扫描线水平错切与整身翻转**：躯干与双腿稳坐锁死，仅保留极克制的呼吸起伏；颈部采用刚体分层羽化合成。
   - **A 层（3×3 多朝向真·扭头序列帧）**：姿态板升级为 `3×3`（1:1 正方形，`1152×1152`，单格 `384×384`，向下兼容 `3×2` 与单图）。首行专放同一对称坐姿下的 3 个真实三维透视朝向帧：`idle_left`（左看 -35°）↔ `idle`（正脸直视 0°）↔ `idle_right`（右看 +35°），切图器按坐姿下半身重心对齐，消除转头时手脚跳动。
   - **B 层（近场感知触发 + 刚体微歪头与球面眼神微动）**：远处办公时安静保持朝内待命帧；仅当鼠标进入近场（`< 260px`）时按方位顺滑切帧（跨左右必经 `idle` 正脸帧过渡 `85ms`），并在正脸/近距离叠加 `≤ ±3.2°` 刚体绕颈微歪头、`±1.8px` 微俯仰，以及发光眼点角色的球面眼珠微追踪与自然眨眼。

---

## 二、涉及文件与改动清单

1. **`src/sugent/avatar-pose-rig.ts`**：
   - 新增 `POSE_KEYS_3X3`（`idle_left`, `idle`, `idle_right`, `listening`, `thinking`, `working`, `waiting`, `ack`, `sleep`）与 `PoseSheetLayoutMode = "grid_3x3" | "grid_3x2" | "single"`，保留 `POSE_KEYS` 兼容导出。
   - 支持 `3×3` 分隔线抑制、双轴三等分接缝搜索与 `1152×1152` 标准切图；对首行坐姿三帧共享统一缩放比并按**下半身重心 `lowerCx`** 对齐，确保扭头切帧时躯干与双腿像素级稳定。
   - 自动检测颈部最窄处 `headEndY`，并对具备高对比对称发光眼点的角色（如 `sugent-core`）提取可选 `eyeSpots`（双目坐标、半径、底色与发光色）。
2. **`src/sugent/avatar-studio.ts` & `scripts/generate-v2-mannequin-assets.mjs`**：
   - 升级 Gemini 生成提示词与默认比例为 `1:1` `3×3` 九宫格（同时兼容导入 `3×3` / `3×2` / `single`）。
   - 实机重新生成 `ui/design/bots/mannequin-pose-sheet-v2.png`、`clay-atelier-poses.png`（及 `portrait.png`）、`sugent-core-v2-poses.png`（及 `portrait.png`），并刷新 `CANONICAL_POSE_SHEET_META`。
3. **`ui/components/companion-stage.js`**：
   - 删除 `drawPoseWithBands` 扫描线水平错切与 `updateAutoTurn` 整身翻转。
   - 实现 `drawRigidSculpturePose`（刚体下身呼吸 + 颈部羽化刚体头部微歪头/微俯仰 + 可选 `eyeSpots` 球面眼神追踪与眨眼 + 头部高光微偏移）与 `updateHeadTurn`（近场 `< 260px` 迟滞防抖三向扭头序列机，跨左右经正脸中继帧过渡；`done`/`hello` 信号联动 `ack` 回应帧）。
4. **`ui/components/avatar-studio.js` & `ui/locales/{zh-CN,en}/steward.js`**：
   - 工坊导入布局选项新增 `3×3` 九宫格（默认），同步更新中英文双语文案。
5. **`test/sugent-avatar-studio.unit.test.ts`**：
   - 新增 `3×3` 切图对齐、下半身重心稳定、发光眼点检测与 `3×2` 向后兼容单测。

---

## 三、验证门禁

1. 视觉检视：用 `read_file` 逐一核验新生成的 `mannequin-pose-sheet-v2.png`、`clay-atelier-poses.png`、`sugent-core-v2-poses.png` 首行左/中/右扭头透视与基准线对齐。
2. 自动化门禁：`npm run typecheck`、`npx vitest run test/design-system.unit.test.ts test/i18n.unit.test.ts test/sugent-avatar-studio.unit.test.ts`、`npm run test:sugent`、`npm run verify:sugent` 100% 通过。
