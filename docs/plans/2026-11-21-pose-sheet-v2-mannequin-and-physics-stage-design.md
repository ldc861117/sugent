# Sugent 个人 Agent 形象与动态 v2 设计规格（3×2 全身雕塑素体 + 弹簧物理舞台）

> **日期**：2026-11-21  
> **状态**：Draft — Pending User Review  
> **范围**：素体白模 v2（`mannequin-pose-sheet-v2.png` + `clay-atelier` + `sugent-core` v2）/ 零依赖 3×2 自动切分对齐引擎（`src/sugent/avatar-pose-rig.ts`）/ Canvas 弹簧物理与局部微动舞台（`ui/components/companion-stage.js`）/ 形象工坊与桌面悬浮搭档升级

---

## 0. 商业策略自省四问（AGENTS.md 门禁）

1. **付费锚点（Why Pay & Moat）**  
   2.5 头身 3×2 雕塑素体、`Clay Atelier` / `Sugent Core v2` 内置皮肤、零依赖 3×2 自动切分引擎与离线主权导入属于**开源引流与体验识别度基座**，帮用户一眼区分 Sugent 与传统大厂千篇一律的对话气泡或廉价贴纸助手；**多端跨设备形象包加密同步**、与防社死 30s 冷静撤回 / Universal Dropzone 联动的**桌面实时态联动能力**则放大 Sugent 独有的私密主权与跨生态体验壁垒。
2. **合规与分发（Distribution & ToS Risk）**  
   全套切分、去底与物理舞台均基于 Node 原生 `zlib`/Buffer 及浏览器原生 Canvas 2D，不引入任何未签名第三方二进制、Native Addon 或逆向接口；通过 `ProviderRegistry` 与标准 Gemini `:generateContent`（兼容 OpenAI `/chat/completions` 回退）调起用户自配模型，不影响 macOS 公证与 Windows 签名。
3. **离线退路（Sovereignty Fallback）**  
   即使处于 `mode: "none"` 且零云端生图密钥，内置 `sugent-core`（v2 曜石旗舰）与 `clay-atelier`（陶白素体）直接可用；且本地图片导入同时支持 **3×2 六姿态表** 与 **单张全身立绘（`layout: "single"`）**，断网单机仍可完成装配、特写裁切与物理舞台交互。
4. **一人公司运维杠杆（OPC Ops Leverage）**  
   采用「单次 Gemini `3:2` 整板生图 → 纯端侧自动切分/基线对齐/派生特写 → 端侧 Canvas 实时物理驱动」流水线，后端零有状态算力节点、零人工修图介入，运维成本趋近于零。

---

## 1. 问题诊断、目标与非目标

### 1.1 为什么彻底推翻 v1（`visor_v1`）
- **形态被原版骨架锁死**：v1 沿用 AnyModelBot 的「圆角方头 + 左右耳罩 + 棒棒糖天线 + 留空黑护目镜」四件套，本质只是给旧卡通大头换材质，难以表现拟人动物（如风衣柴犬管家）、完整人偶或克制现代插画。
- **动态停留在剪纸贴纸感**：v1 通过 `CSS transform: scale()` 整图果冻回弹、耳罩旋转与头顶 `z z z` / `!` / 爱心气泡表达状态，缺乏地面真实重力感，小人缩放像漂浮贴纸。

### 1.2 v2 核心设计目标
1. **全身微缩雕塑感**：采用 **2.5 头身、3/4 微侧视角** 的完整身体素体，以哑光高岭土白瓷定稿，自带完整手部动作与站/坐/伏案/蜷缩姿态叙事。
2. **跨风格零约束表达**：3×2 姿态板只锁定「网格站位、2.5 头身剪影比例、动作意图与地面基线」，彻底取消天线/耳罩/空心护目镜限制。
3. **脚底钉地 + 弹簧物理舞台**：以 3 条连续水平柔体带驱动局部呼吸与视线转头（脚底固定在 `y = 88%`），配合拎起摆锤晃动、屏幕边缘 48px 磁吸停靠与左缘自动镜像翻转。
4. **双尺度清晰**：桌面悬浮窗与工坊大舞台跑完整 `CompanionStage`；主窗口 `≤48px` 侧边栏与聊天气泡自动切为 `256×256` 头肩特写 `portrait.png`。

### 1.3 明确非目标（Non-Goals）
- 不引入 Three.js / WebGL / Spine 等重型渲染或骨骼库，保持零外部前端依赖与低内存占用。
- 不使用 4×4（16 格）连续动画精灵表（当前文生图模型在 16 格下五官漂移与单格分辨率不足风险过高）。
- 不做全局乱跑挡住 IDE 与文档编辑区的自由漫游 Shimeji；坚持**桌面锚点停靠 + 完整姿态剧场**。
- 不删除旧版 6 个 AnyModelBot 毛绒角色，也不破坏现有 `test/phase3.unit.test.ts`、`test/design-system.unit.test.ts` 与 `test/i18n.unit.test.ts` 既有契约。

---

## 2. Creative Direction Brief 与 3×2 素体六姿态规范

### 2.1 美学定调（Creative Direction Brief）
- **核心情绪（Feeling & Thesis）**：桌面一角的微缩雕塑陪跑者——平时安静耐看、不抢代码窗口视线；一经唤起或拖拽，立刻展现出真实重量与细腻动作反馈。
- **材质世界（Inspiration World）**：哑光高岭土白瓷（Matte Bisque Porcelain）微缩可动人偶，关节仅以极细暖灰凹线暗示结构，影棚顶侧柔和漫射光。
- **品味护栏（Taste Guardrails）**：
  - **保留**：2.5 头身清晰手部/四肢剪影、3/4 微侧立体感、干净纯平影棚底色（`#F4F5F7`）、统一地面接触投影。
  - **排斥**：低龄 Q 版卡通大头、左右外突耳罩、棒棒糖天线、生硬框线/编号文字、塑料高光反光与廉价贴纸特效。

### 2.2 3×2 标准姿态板协议（`mannequin-pose-sheet-v2.png`）
- **原生画幅**：**`1536×1024`**（`3:2` 横版，3 列 × 2 行），每格正好为 **`512×512`** 独立方格。
- **视觉规范**：纯平 `#F4F5F7` 影棚背景，**零黑色格线、零边框、零文字标签或序号**；人物不能越出所属单元格安全边距；除 `sleep` 蜷缩态外，各姿态主体视觉体积一致，脚底/坐臀支撑点落在同一地面水平线附近。

| 格位 | 状态 Key | 动作意图与剪影要求 | 归一化高度倍率 | 典型触发场景 |
| :--- | :--- | :--- | :--- | :--- |
| `(0, 0)` | `idle` | 坐姿待命：自然坐于低墩或桌面边缘，双脚微垂放松 | `0.86` | 空闲待命、刚打开桌面搭档 |
| `(1, 0)` | `listening` | 倾听前倾：上身微向前倾、微侧首专注朝向用户方向 | `0.92` | 输入框键入中、文件拖入悬停 |
| `(2, 0)` | `thinking` | 托腮沉思：一手轻托下巴或执笔停顿，视线略抬斜上方 | `0.95` | 模型推理思考、`thinking` 阶段 |
| `(0, 1)` | `working` | 伏案干活：身体微前倾，双手操作面前微型悬浮面板或工具 | `0.90` | 正在生成回复、执行工具或流水线 |
| `(1, 1)` | `waiting` | 起身挥手：站立起身，单手明显举起挥动，引起注意 | `1.00` | 待用户拍板审批、`waiting`、30s 冷静撤回倒计时 |
| `(2, 1)` | `sleep` | 蜷缩打盹：就地坐卧抱膝或伏手小憩，整体收拢低重心 | `0.72` | 长时间无操作进入低功耗休眠 |

### 2.3 内置开箱形象与跨物种解锁
- **`sugent-core`（v2 曜石旗舰，默认激活）**：基于 3×2 陶白素体实机精雕并人工定稿——深炭黑哑光陶瓷外壳 + 克制温润浅金/青绿微光线 + 手持微型终端道具。
- **`clay-atelier`（陶白素体，内置可用）**：官方 `mannequin-pose-sheet-v2.png` 本身直接装配成可用的极简白瓷雕塑皮肤，开箱即有两套 3×2 全身雕塑形象。
- **旧版兼容**：原有 6 个 `visor_v1` 毛绒角色（`blue` / `yellow` / `green` / `red` / `purple` / `orange`）保留在画廊尾部，不删除历史资源。
- **提示词解锁规则**：`buildPoseSheetGenerationPrompt(stylePrompt)` 仅锁定「3×2 无边框网格、2.5 头身 3/4 视角、六格动作语义与 `#F4F5F7` 纯平背景」，开放任何材质、服饰、拟人动物、复古像素或水墨角色自由表达。

---

## 3. 纯 Node 零依赖 3×2 自动切分对齐引擎（`src/sugent/avatar-pose-rig.ts`）

### 3.1 模块隔离与数据契约
为确保长期零冲突与职责单一，新建独立模块 `src/sugent/avatar-pose-rig.ts`，与旧版方头切分器 `src/sugent/avatar-rig.ts` 彻底解耦：

- `AvatarPoseKey`：`"idle" | "listening" | "thinking" | "working" | "waiting" | "sleep"`（固定格序）。
- `PoseCellMetrics`：记录每格切分归一化后的前景包围盒（`bbox: [x, y, w, h]`）、脚底基线（`baselineY: 0.88`）、柔体分割比例（`headEndY` / `torsoEndY`）与像素覆盖率（`coverage`）。
- `PoseSheetRigMetadata`：含 `grid: [3, 2]`、`cellSize: 384`、`sheetSize: [1152, 768]`、`portraitSize: 256`、`layoutMode: "grid_3x2" | "single"` 与 `cells: Record<AvatarPoseKey, PoseCellMetrics>`。
- `AvatarPackManifest`（在 `src/sugent/avatar-rig.ts` 中向后兼容扩展）：
  - `schemaVersion?: "visor_v1" | "pose_sheet_v2"`（旧包缺省按 `"visor_v1"` 处理）
  - `poseSheetUrl?: string`（`1152×768` 透明 PNG）
  - `portraitUrl?: string`（`256×256` 头肩特写透明 PNG）
  - `poseMeta?: PoseSheetRigMetadata`
  - `accentColor?: string`（微光环与状态环主色，十六进制色值）

### 3.2 五步零依赖处理流水线（`rigPoseSheetImageBuffer`）
1. **图像解码**：复用原生 PNG zlib 解码器，遇到 Gemini 返回 JPEG/WebP 时回退 `sips` / `python3 PIL` 转为 RGBA。
2. **白瓷保护型影棚去底**：
   - 从四角及四条外缘采样背景色，计算各像素背景色差；
   - 执行 **四角 BFS + Sobel 边缘梯度屏障**：梯度高且亮度边界清晰的白瓷本体像素强制保护，防止高岭土白瓷与白色高光被误抠穿，边缘自动做 1.5px 抗锯齿柔边与浅灰残留去溢（defringe）。
3. **3×2 智能边界拆格**：
   - 当输入为 `layout: "grid_3x2"`（默认）时，按 3 列 × 2 行切出 6 格；若邻格切分线命中前景连通像素，向局部最小 Alpha 缝隙微调 ±6% 切缝宽度，避免手臂或道具被生硬腰斩；
   - 同时支持 `layout: "single"`：允许离线导入任意单张全身立绘，经去底、居中与脚底基线对齐后自动复制填充六格，零成本接入完整物理舞台。
4. **中位身高对齐与 `y = 88%` 钉地归一化**：
   - 计算前 5 格有效身高的中位数作为参考站姿尺度（`waiting = 1.00`，`sleep` 保留低重心倍率）；
   - 将每格按双线性重采样装配至 **`1152×768`（每格 `384×384`）** 透明 PNG（`poses.png`）：水平重心严格居中 `x = 50%`，脚底/坐臀支撑点统一对齐 `y = 88%`。
5. **头肩特写裁切与异常兜底**：
   - 优先从 `idle`（失败回退 `listening` / 首个有效格）截取前景顶部 `52%` 正方区域居中放大为 **`256×256` 透明特写 PNG（`portrait.png`）**；
   - 若某格覆盖率 `< 4%`（空格/生图残缺）或 `> 92%`（去底异常），记录 `warnings` 并自动用相邻有效格复制兜底，杜绝前端渲染空白格。

---

## 4. 弹簧物理与局部微动舞台引擎（`ui/components/companion-stage.js`）

彻底移除旧版 `.bot-face` 在大尺寸下的果冻整图缩放及 `z z z` / `!` / 爱心粒子，由纯原生 Canvas 2D 驱动四层协同：

### 4.1 脚底钉地的「连续柔体切片微动」
对当前姿态的 `384×384` 纹理按每 2px 水平条带连续平滑采样绘制（非三段硬切方块，无接缝撕裂），并依据 `poseMeta` 划分为三个平滑权重区间：**头肩带（`0–44%`）/ 躯干带（`44–74%`）/ 下肢带（`74–100%`）**：
- **局部呼吸**：正弦权重主要落在躯干带与肩颈过渡区，**`y = 88%` 脚底像素位移恒为 `0`**，消除浮空感。
- **指针视线偏转**：鼠标靠近或移动时，仅头肩带做极克制的水平微移（`±4px`）与轻微偏转（`±3.5°`），下盘保持沉稳。
- **分姿态微节拍**：
  - `idle`：3.8s 慢速舒缓呼吸，下肢带极轻微垂足轻晃；
  - `listening`：上身微前倾 `3°` 与极轻关注点头；
  - `thinking`：头肩带 `3.8s` 周期缓慢倾侧推演；
  - `working`：躯干与上肢前倾区做小幅度连续节奏微动；
  - `waiting`：每 `2.6s` 一次礼貌轻跃招手脉冲；
  - `sleep`：`4.6s` 深呼吸循环，画面自动降低高光对比度进入休眠态。

### 4.2 弹簧物理拖拽、边缘停靠与自动面向
- **拎起摆锤物理（Pick Up & Pendulum）**：鼠标按住拖起桌宠时，角色触发离地抬升（`lift = 1`），脚底接触阴影缩小虚化；根据横向拖拽速度驱动弹簧阻尼摆角方程（限制在 **`±22°`** 内），呈现真实的微缩手办垂吊摆动感。
- **48px 边缘磁吸与落位缓冲（Edge Docking）**：松手时若距主屏幕工作区底部、左侧或右侧边缘 `≤48px`，触发 `SugentCompanionController` 磁吸吸附并持久化停靠边 `dockEdge`（`"bottom" | "left" | "right" | "free"`），同时在 Canvas 内播放一次重力下落与 `scaleY: 0.92 → 1.0` 弹性落稳缓冲。
- **自动朝向工作区**：当停靠于屏幕左缘或左半区时，主进程通过 IPC 通知渲染器将 `facing` 设为 `"right"`（角色镜像翻转面向桌面中心），确保永远面向你的工作内容。

### 4.3 260ms 三段式姿态转场与极简雕塑光语
- **260ms 三段式转场（Anticipation → Swap → Follow-through）**：
  - `0–70ms`：蓄力预备微蹲（压扁至 `scaleY: 0.94`，横宽补偿 `1.04`）；
  - `70–160ms`：微跃起离地并执行新旧姿态 Alpha 交叉过渡；
  - `160–260ms`：弹簧超调回落并牢牢落稳在 `y = 88%`。
- **交互事件节拍**：
  - **Universal Dropzone 文件投喂**：文件拖入悬停时身形向光标倾斜、脚底点亮单圈磁吸圆环；松手触发接住轻蹲与单圈细涟漪（彻底去掉彩纸粒子）；
  - **任务完成 / 失败**：完成播一记干脆落稳 + 细光晕脉冲；报错播 `320ms` 阻尼水平短震 + 克制琥珀色描边提示；
  - **30s 冷静撤回窗**：存在待外发冷静窗时切至 `waiting` 招手姿，并在脚底投影圈绘制精确的环形剩余倒计时弧；
  - **双击互动**：桌宠紧缩态双击可循环切换一个彩蛋姿态展示或快速唤起微指令条。
- **极简雕塑光语（零卡通气泡）**：仅保留随身体起伏缩放的软性接触投影、`working` 态前方微弱屏反光、`thinking` 态身侧 3 颗缓慢绕轨微光点，以及 `waiting` / 冷静撤回时的地面呼吸细环。

### 4.4 双尺度职责与低功耗控制
- **桌面悬浮窗与形象工坊舞台**：运行完整 60fps `CompanionStage`；页面隐藏或无指针/状态变化持续超过 `10s` 后自动降频为低功耗轻呼吸帧率；严格遵守 `prefers-reduced-motion`（关闭摇摆与微跃，仅保留平静渐变切换）。
- **主窗口小尺寸渲染（`≤48px` 侧栏 / 对话气泡 / 设置列表）**：`ui/components/avatar.js` 在识别到 `schemaVersion === "pose_sheet_v2"` 且 `size <= 48` 时，直接渲染清晰高对比度的 `portraitUrl`（`256×256` 头肩特写）配合 1.5px 极细状态外环；`size > 48` 时无缝托管给 `CompanionStage`。

---

## 5. 后端服务、Electron 主进程与前端工坊边界

- **`src/sugent/avatar-studio.ts`**：
  - 新增 `buildPoseSheetGenerationPrompt(stylePrompt)`，引用 `ui/design/bots/mannequin-pose-sheet-v2.png` 发起 `aspectRatio: "3:2"` 生成（兼容 Gemini `:generateContent` 与 OpenAI `/chat/completions` 回退）；
  - `generateFromBlank` 支持依据素体版本分派 `pose_sheet_v2` 装配管线，`importFromImage` 接受 `layout?: "grid_3x2" | "single"` 两种离线导入模式；
  - 静态资产接口 `GET /amb/api/steward/avatars/asset` 新增 `kind = "poses" | "portrait" | "mannequin"`，保留既有 `sprite` / `source` / `blank`。
- **`electron/sugent-companion.ts` & `electron/companion-preload.cjs`**：
  - 紧缩浮窗尺寸微调为 **`156×168`**（适配全身 2.5 头身及投影呼吸余量），展开最大 `430×350`，并根据停靠边 `dockEdge` **智能向屏幕内侧展开**（停在左侧时向右展开，停在右侧时向左展开）；
  - 持久化 `{ x, y, visible, dockEdge }`，并通过 `companion:context` IPC 向前端同步 `{ dockEdge, facing, dragging }`。
- **`ui/components/avatar-studio.js` & 本地化词条**：
  - 对 `pose_sheet_v2` 形象隐藏旧版护目镜眼型选择器；突出「6 姿态实时舞台 + 模拟拖拽/投喂/撤回互动」试演区，升级灵感预设为跨风格/跨物种示例（如：**陶白雕塑、博朗钛银机师、风衣柴犬管家、复古像素学徒**），并支持 `3×2 姿态板 / 单张全身立绘` 双模式本地导入；
  - 全部新增 UI 文案与 CSS 严格纳入 `ui/locales/{zh-CN,en}/steward.js` 与 Token 系统，保证 `test/design-system.unit.test.ts` 与 `test/i18n.unit.test.ts` 零报错。

---

## 6. 文件变更范围、实机验证计划与风险兜底

### 6.1 计划涉及文件（零侵入宿主要求）
| 类别 | 文件路径 | 职责说明 |
| :--- | :--- | :--- |
| 新增资产 | `ui/design/bots/mannequin-pose-sheet-v2.png`、`sugent-core-v2-poses.png`、`sugent-core-v2-portrait.png` | 经实机 Gemini 生成并逐格人工验视定稿的 3×2 白瓷素体及曜石旗舰资产 |
| 新增核心 | `src/sugent/avatar-pose-rig.ts` | 纯 Node 零依赖 3×2 / 单图去底、对齐、基线归一化与特写裁切引擎 |
| 新增舞台 | `ui/components/companion-stage.js` | Canvas 2D 三段柔体微动、弹簧摆锤物理、260ms 转场与极简光语引擎 |
| 扩展适配 | `src/sugent/avatar-rig.ts`、`src/sugent/avatar-studio.ts`、`src/sugent/index.ts`、`src/web/server.ts` | `pose_sheet_v2` Schema 扩展、3:2 生成协议、`layout` 双模式导入与资产路由 |
| 桌面宿主 | `electron/sugent-companion.ts`、`electron/companion-preload.cjs`、`ui/companion.js`、`ui/css/companion.css` | 156×168 浮窗、48px 边缘停靠、左缘自动镜像与物理拖放接通 |
| 工坊与主窗 | `ui/components/avatar.js`、`ui/components/avatar-studio.js`、`ui/locales/{zh-CN,en}/steward.js`、`ui/css/sugent.css` | 双尺度渲染分发、3×2 工坊 UI 重构与双语词条同步 |
| 测试门禁 | `test/sugent-avatar-studio.unit.test.ts`、`scripts/verify-sugent.mjs`、`scripts/verify-avatar-pipeline.mjs` | 3×2 切分、单图导入、基线对齐、Web API 与 Gemini 实机验证脚本 |

### 6.2 实机生图与全量测试验收标准
1. **实机 Gemini 管线验证（`.env` `gemini-3.1-flash-image-preview`）**：
   - 生成并人工逐格验视定稿 `mannequin-pose-sheet-v2.png`（6 格无格线、无残肢、白瓷质感自然）；
   - 基于定稿素体实跑至少 **3 套差异化主题**（新版 `sugent-core` v2 曜石旗舰 + 跨物种「风衣柴犬管家」+ 极客「复古微缩宇航员/像素风」），通过图像检视逐一确认去底无穿透、六格脚底基线一致、`portrait.png` 五官居中清晰；
   - 将人工验收定稿后的陶白素体与曜石旗舰资产直接装配为内置 `clay-atelier` 与 `sugent-core`。
2. **自动化测试与静态门禁（100% 通过）**：
   - `npm run typecheck` 与 `npm run build` 0 错误；
   - `npx vitest run test/design-system.unit.test.ts test/i18n.unit.test.ts test/phase3.unit.test.ts test/sugent-avatar-studio.unit.test.ts` 全部通过；
   - `npm run test:sugent` 与 `npm run verify:sugent`（含 `docs:check`）全部通过。

### 6.3 关键风险与自动兜底
- **模型偶发绘制分割线或格边距偏心**：切分器增加外圈 Alpha 连通域微调防裁肢逻辑与高对比细黑线剥离阈值，极端空缺格自动复制邻近有效格并向前端透出轻提示。
- **高岭土白瓷/浅色服装去底被抠穿**：通过 Sobel 边缘梯度屏障 + 外缘 4 角连通域限制（仅移除与外背景连通区域，绝不误删内部闭合高光）。
- **无图形浏览器头部的 CI/单测环境**：后端切分、协议双路回退与 Web API 均具备完全隔离的确定性单测覆盖；`CompanionStage` 在无 Canvas 上下文的精简测试下平滑降级为静态特写/精灵显示。
