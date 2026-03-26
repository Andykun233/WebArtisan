# WebArtisan

WebArtisan 是一个面向咖啡烘焙的实时曲线面板（前端单页应用），用于通过 WiFi/WebSocket 读取设备温度并记录烘焙过程。

当前版本重点：
- 仅保留 `WiFi(WebSocket)` 连接方式（已移除 BLE / 串口 / SPP UI）。
- 支持导入背景曲线、实时 BT/ET/RoR 图表、事件打点、DTR（发展率）显示。
- 支持导出 `ALOG / CSV / JSON` 三种格式。
- 支持界面语言切换（`简体中文 / English`），并自动本地记忆语言设置。
- 支持 iOS/移动端的 PWA 安装与离线壳缓存（需满足 HTTPS 条件，见下文）。

## 功能一览

### 实时温度与曲线

- Bean Temp (BT) / Env Temp (ET) 实时显示
- BT RoR 与 ET RoR 显示（可在设置中分别开关）
- 图表坐标轴优化：
  - 时间轴在 `10 分钟`内保持固定；超过后自动延展
  - 温度轴在 `300°C` 内保持固定；超过后自动延展

### 烘焙事件与阶段

- 支持常用事件打点（入豆、回温点、脱水结束、一爆开始/结束、二爆开始/结束、下豆）
- 发展率 DTR：点击“一爆开始”后开始显示

### 设置面板

- 采样时间可选 `1~5 秒`，默认 `3 秒`
- BT/ET 温度互换
- 显示/隐藏 BT RoR
- 显示/隐藏 ET RoR
- 语言切换：`简体中文 / English`（保存在浏览器本地）

### 曲线导入与导出

- 导入支持：`.json` / `.alog` / `.csv`
- 导出可选：`.alog` / `.csv` / `.json`
- “清除”按钮支持二级操作：
  - 清除背景曲线
  - 清除目前曲线（带二次确认）

## 技术栈

- `React 18` + `TypeScript`
- `Vite 5`
- `Recharts`
- `Tailwind CSS`（编译为本地静态资源）
- Service Worker + Web App Manifest（PWA）

## 本地开发

### 环境要求

- Node.js `18+`（建议 LTS）

### 安装与启动

```bash
npm install
npm run dev
```

默认开发地址：`http://127.0.0.1:5173`

> 当前 `vite.config.ts` 明确为 `https: false`，即开发环境默认 HTTP。

### 构建与预览

```bash
npm run build
npm run preview
```

构建产物目录：`dist/`

## 设备连接（WiFi/WebSocket）

点击界面中的 `WiFi` 按钮后，输入设备 IP（只输入 IP 即可），应用会固定拼接成：

```text
ws://<IP>:80/ws
```

例如输入 `192.168.1.159`，最终连接地址是：

```text
ws://192.168.1.159:80/ws
```

### 连接协议说明

- 页面是 `http://` 时：可以连 `ws://`
- 页面是 `https://` 时：浏览器禁止连 `ws://`（Mixed Content）
  - 需要改为 `wss://`，或
  - 在前端与设备间加反向代理（外部 `wss://`，内部转发 `ws://设备IP:80/ws`）

## 与 Artisan WebSocket 的兼容说明

应用按 Artisan 常见方式向设备轮询数据（约每秒一次）：

```json
{"command":"getData","id":12345,"machine":0}
```

并从返回 JSON 中提取温度字段（常见键位如 BT/ET、Bean/Environment、temp2/temp1 等）。

若你的硬件返回字段不一致，请在 `services/websocketService.ts` 的解析映射里补充键名。

## 导入/导出格式

### 导出格式

- `.csv`：首行为元信息 JSON，第二行为表头，后续为逐点数据（含时间、BT、ET、RoR、事件 token）
- `.json`：包含 `dataList`、`eventList`、`phaseList` 等结构化字段
- `.alog`：生成 Artisan 兼容的 Python-literal 风格文本（含 `timex/temp1/temp2/computed`）

### 导入格式

- `.json` / `.alog` / `.csv` / `.txt`（兼容 iOS 上部分文件类型映射场景）
- 支持多种常见 Artisan 字段命名（如 `timex/temp1/temp2`、`dataList/eventList` 等）
- 后缀匹配不区分大小写（如 `.ALOG` 也可解析）
- 导入后会重新计算 RoR 以统一显示效果

## 字体与本地化

- 所有界面字体均从本地静态文件加载，不依赖在线字体服务
- 已本地化字体：
  - `Space Grotesk`（英文 UI）
  - `JetBrains Mono`（数值与等宽信息）
  - `Noto Sans CJK SC`（中文 UI）
- 语言切换覆盖主界面、设置、弹窗、提示文案和图表图例/标签

## PWA 与离线说明

### 添加到主屏幕

- iOS Safari 打开站点后，使用“分享 -> 添加到主屏幕”

### 离线可用前提

- 需要先在线完整访问一次，让 Service Worker 缓存应用壳资源
- **PWA/Service Worker 只在 HTTPS（或 localhost）下可靠生效**
  - 如果你使用普通 HTTP 域名，离线能力通常不可用

### 更新版本后强制刷新

如果发布新版本后仍加载旧资源，可按顺序处理：
- 关闭主屏应用并重新打开
- 浏览器强制刷新（清缓存）
- 清理旧 Service Worker 与站点缓存后再访问

## 部署（静态站点）

WebArtisan 是纯前端项目，生产部署只需要上传 `dist/` 内容。

### 通用步骤

1. 本地执行：

```bash
npm install
npm run build
```

2. 将 `dist/` 目录中的文件上传到站点根目录（不是上传源码目录）
3. 确保 `index.html` 与 `/assets/*` 来自**同一次构建**（避免 hash 不一致）

### 宝塔 / Kangle / EasyPanel 注意点

- 这是静态前端项目，不依赖 PHP 运行时
- 如果面板必须选择 PHP 版本，可任选一个稳定版本，但与项目逻辑无关
- 建议将 `/assets/*` 配置为静态文件直出
- 若出现 `ERR_INCOMPLETE_CHUNKED_ENCODING`：
  - 暂时关闭 gzip / brotli 观察是否恢复
  - 检查是否被中间层截断 chunked 响应
  - 检查大文件传输超时、连接复用、缓存代理设置
  - 清理 CDN/面板缓存后重试

## Nginx 反代 WebSocket（HTTPS 页面访问本地设备示例）

当网页是 HTTPS，但设备只支持 `ws://` 时，可用反代桥接：

```nginx
location /ws/ {
    proxy_pass http://192.168.1.159:80/ws;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "Upgrade";
    proxy_read_timeout 3600s;
}
```

前端改连：`wss://你的域名/ws/`

## 常见问题（FAQ）

### 1) `Failed to construct 'WebSocket': An insecure WebSocket connection may not be initiated from a page loaded over HTTPS.`

原因：HTTPS 页面不能连接 `ws://`。  
解决：改用 `wss://`，或把页面改为 HTTP（仅内网测试场景），或使用反代桥接。

### 2) `WebSocket Closed 1006`

常见原因：
- 路径不对（例如缺少 `/ws`）
- 端口不对
- 设备无响应或跨网段不可达

已验证过的典型地址格式：`ws://设备IP:80/ws`

### 3) `net::ERR_INCOMPLETE_CHUNKED_ENCODING 200 (OK)`

这通常是服务器/面板/CDN 传输链路问题，不是前端业务代码错误。重点排查：
- 静态资源是否完整、是否被代理截断
- gzip/chunked 配置是否异常
- 旧缓存是否引用了不存在的 hash 文件

### 4) 添加到主屏幕后，飞行模式打不开

先确认：
- 首次是否在线完整加载过页面
- 部署是否在 HTTPS（非 localhost）
- Service Worker 是否注册成功并缓存到资源

## 目录结构

```text
.
├── App.tsx
├── components/
│   ├── RoastChart.tsx
│   └── StatCard.tsx
├── services/
│   └── websocketService.ts
├── public/
│   ├── sw.js
│   ├── manifest.webmanifest
│   ├── offline.html
│   ├── fonts/
│   │   ├── jetbrains-mono-400.ttf
│   │   ├── jetbrains-mono-600.ttf
│   │   ├── jetbrains-mono-700.ttf
│   │   ├── space-grotesk-400.ttf
│   │   ├── space-grotesk-500.ttf
│   │   ├── space-grotesk-600.ttf
│   │   ├── space-grotesk-700.ttf
│   │   ├── noto-sans-cjk-sc-400.otf
│   │   └── noto-sans-cjk-sc-700.otf
│   └── icons/
├── index.tsx
├── index.html
├── styles.css
└── vite.config.ts
```

## 开发备注

- 已移除 Google Gemini 相关服务集成（当前代码库无 Gemini 依赖）
- 字体与静态资源均为本地文件，不依赖外链字体 CDN
- 语言切换配置与文案在 `App.tsx` 中维护，图表文案在 `components/RoastChart.tsx` 中维护
- 字体文件位于 `public/fonts/`
- 如需扩展硬件协议，优先修改：`services/websocketService.ts`
