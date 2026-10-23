# dsh-fnos

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件：在本机通过 DSH 远程管理 **飞牛 fnOS** 设备。

授权登录、文档目录树浏览、文件/文件夹 `@引用` 插入，全部在 DSH 界面里完成，不需要终端。

---

## 功能

| 功能 | 说明 |
|---|---|
| **授权登录** | 走 `trim-cli login` 的 OAuth 设备码流程，在插件详情页里点一下打开浏览器，粘回一次性授权码即可 |
| **文件/文件夹选择器** | 输入框左侧的飞牛图标，点开是 NAS 目录树；`Ctrl/Cmd + 点击` 直接以 `@文件名` 引用插入输入框 |
| **目录树后台缓存** | 每 20 秒轮转刷新并落盘，打开文件树走内存，实测 3–80 ms（冷启动 3.4 s） |
| **主题跟随** | 全部使用 `--dsw-alias-*` 主题变量 + 毛玻璃，能跟随 DSH 皮肤（含第三方主题） |
| **插件详情页配置** | 主机 / 端口 / 协议 / 跳过证书校验，写在插件自己的详情页里 |

---

## 安装

### 前置条件

- DSH `>= 0.2.0-rc.2`
- 一台可访问的 fnOS 设备（含海外版 FygoOS）

### 从源码安装（开发）

```bash
# 在 DSH profile 目录下
pnpm add link:/path/to/dsh-fnos
```

或在 DSH 的插件管理器里安装 `link:/path/to/dsh-fnos`。

启用后需要**重启一次 DSH**（宿主半边是 Node 模块，启动时装载）。

### 语言包

`locale/zh.json`、`locale/en.json` 提供插件显示名与描述。

---

## 使用

1. **设置 → 插件 → 飞牛 NAS → 点进详情页**
2. 填 **主机 / 端口 / 协议**（自签证书记得勾「跳过证书校验」）
3. 点 **登录飞牛 NAS** → 浏览器打开授权页 → 登录后把页面上的**一次性授权码**粘回来 → 点「完成登录」
4. 连接成功后，**输入框左侧**会出现飞牛图标（绿点 = 已连接）
5. 点图标打开目录树：
   - 点文件夹名 → 进入下一级
   - **`Ctrl / Cmd + 点击`** → 直接以 `@文件夹/` 引用插入
   - 点文件名 → 直接以 `@文件名` 引用插入
   - 顶部搜索框可按名字过滤当前目录

---

## 架构

插件由两个半边组成，通过 DSH 的 Cordis 插件系统装配。

### 宿主半边（`lib/entry.js` → `lib/impl.js`）

- `lib/entry.js`：稳定 shim。每次 `apply()` 用带时间戳的 URL 动态 `import('./impl.js?t=…')`，用来**击穿 Node 的 ESM 模块缓存** —— 改完代码在插件管理器里关一次再开就生效，不必重启 DSH。
- `lib/impl.js`：注册 HTTP 路由、`fnos_probe` 工具、目录缓存与后台刷新。
- `lib/auth.js`：授权状态机（`start` / `submit` / `cancel` / `verify` / `reconcile`）。

### 客户端半边（`lib/client.js`）

通过 `window.__ModuleLoader__.load({ id, factory })` 注册，占三个槽位：

| 槽位 | 用途 | key |
|---|---|---|
| `plugins.bundle.config` | 插件详情页里的配置 + 授权（主入口） | `dsh-fnos`（npm 包名） |
| `conversation.input.left` | 输入框左侧图标 + 目录树浮层 | — |
| `main` | 完整面板 | `dsh-fnos` |

### HTTP 路由

> ⚠️ 刻意**不**挂在 `/plugins/<id>/` 下 —— 声明 `dsh.client` 之后 `clientModules` 会占用该命名空间分发前端产物，子路径会被截走（表现为空 404 / 405）。

| 路由 | 说明 |
|---|---|
| `GET /fnos/probe` | 插件装载状态与宿主服务可用性 |
| `GET /fnos/auth/status` | 授权状态（无活跃会话时会主动查真实凭据） |
| `POST /fnos/auth/start` | 启动登录，返回授权 URL |
| `POST /fnos/auth/submit` | 提交一次性授权码 |
| `POST /fnos/auth/cancel` | 取消 |
| `GET /fnos/files?path=` | 列目录（带缓存，`?fresh=1` 强制刷新） |

---

## 目录缓存设计

```
读：内存 Map（毫秒级）
写：每 20 秒轮转刷新 10 条 + 整表覆盖落盘 .cache/dirtree.json
策略：stale-while-revalidate —— 过期但有旧值也先返回，后台再补
上限：400 条，超出按最久未更新淘汰
```

为什么不直接每次实时拉：`trim-cli` 每次调用都要分配真终端（`spawnTerminal`），单次 1–3 秒。缓存后打开文件树的实测对比：

| 场景 | 耗时 |
|---|---|
| 冷启动（实时调 NAS） | 3366 ms |
| 缓存命中 | 3–81 ms |
| DSH 重启后（从磁盘恢复） | 9–67 ms |

---

## 开发踩坑记录

这些都是实际调试中撞出来的，改代码前建议先读一遍。

1. **Loader 行的 `name` 必须等于包名**。`dsh-client-modules` 只把浏览器半边挂在「说明符恰为包名」的那一行上，用别名会导致**宿主正常、界面静默消失**。
2. **`id` 不能与官方 `@tnnevol/dsh-fnos` 冲突**，否则你的行根本不会创建（表现为所有路由 404）。
3. **`ctx.setInterval` 不可用** —— `timer` 不在插件 `inject` 里，会抛 `cannot get property "timer" without inject`。用全局 `setInterval` + `ctx.effect` 清理。
4. **普通 `spawn` 拿不到 `trim-cli` 的 stdout**（Windows 实测为空），必须用 `ctx.subprocess.spawnTerminal` 分配真终端。
5. **`insertReference` 支持零宽 span**，不需要先打 `/` 做锚点。官方自己的 `insertFileReferences` 就是 `{ start: at, end: at }`。
6. **组件不能直接引用 `apply` 的 `ctx`** —— 组件在模块作用域，要通过 `register({ inject: (sessionId) => ({ ctx, sessionId }) })` 传进去。
7. **`handle.done` 不能用来判断登录成败**。`trim-cli` 授权成功后**不打印成功文案**、直接静默退出（exit=0），唯一可信的是 `system info` 能否取到设备数据。
8. **PTY 会把授权 URL 按终端宽度折行**。匹配前必须先去换行（`\r\n|\r|\n`），否则只能拿到第一段（约 140 字符），导致授权页报「参数异常」。

---

## 已知限制

- **海外版 FygoOS 固件**：授权页点「授权」后返回「参数异常」。原因是该固件的 OAuth 授权端点不识别 `trim-cli` 的 `client_id`，属设备侧问题，插件无法绕过。国内版 fnOS 无此问题。
- **部分命令走另一套地址**：`file usage` 等会连服务端下发的 `xxx:15667`，与配置的 `:5667` 不一致时会报错。`file ls` 系列不受影响。
- 目前只实现了**只读**能力（浏览/选取）。写操作（上传/删除/移动）尚未暴露为工具。

---

## 目录结构

```
dsh-fnos/
├── lib/
│   ├── entry.js          # 宿主入口 shim（ESM 缓存击穿）
│   ├── impl.js           # 宿主主逻辑：路由 / 工具 / 缓存
│   ├── auth.js           # 授权状态机
│   └── client.js         # 客户端半边（UI）
├── bin/                  # 各平台预编译 trim-cli
├── locale/               # zh / en 语言包
├── entries/              # 技能条目文档
├── reference/            # trim-cli 命令参考
├── scripts/              # 技能脚本
├── cordis.patch.yml      # 插件装载补丁
├── SKILL.md              # 技能描述
├── manifest.json
└── icon.png
```

---

## 关于 `bin/` 里的二进制

`bin/` 下是 fnOS 官方的 `trim-cli` 预编译产物（六个平台各一份，共约 41 MB），随插件一同分发以便开箱可用。

**这些不是本项目的产物**，版权归飞牛 fnOS 所有，使用须遵守飞牛的相关条款与许可。本项目的 MIT 许可只覆盖自己编写的代码，即 `lib/`、`cordis.patch.yml`、`locale/`、`entries/`、`reference/`、`scripts/`、`README.md` 等文件。

如果要在自己的分发中替换或去掉这些二进制：删掉 `bin/`，并把 `trim-cli` 放到 PATH 即可（`lib/impl.js` 的 `cliPath()` 会优先用包内路径）。

---

## License

MIT —— 仅覆盖本项目自有代码；`bin/` 下的二进制见上一节。
