# 安装

三种方式，按推荐度排序。全部**不需要** clone、不需要构建 —— 仓库里 `lib/` 已经是可直接运行的代码。

---

## 方式一：从 Release 的 tgz 安装（推荐）

最确定：版本固定、不依赖 git、不跑任何安装脚本。

```bash
pnpm add https://github.com/MeetoHub/dsh-fnos/releases/download/v0.1.0/dsh-fnos-0.1.0.tgz
```

或者在 DSH 里把上面这个 URL 直接粘给插件管理器：

```
plugin_manager  install_bundle  target = https://github.com/MeetoHub/dsh-fnos/releases/download/v0.1.0/dsh-fnos-0.1.0.tgz
```

---

## 方式二：从 GitHub 仓库地址安装

复制浏览器地址栏那条链接就能用（已实测三种写法都成立）：

| 写法 | 例子 |
|---|---|
| 浏览器地址栏原样 | `https://github.com/MeetoHub/dsh-fnos` |
| GitHub 简写 | `MeetoHub/dsh-fnos` |
| npm git 协议 | `github:MeetoHub/dsh-fnos` |

```
plugin_manager  install_bundle  target = github:MeetoHub/dsh-fnos
```

**注意代价**：这种方式会完整拉取仓库（含 `bin/` 下 41 MB 的 trim-cli 二进制），比方式一慢。要固定版本可以加 ref：

```
github:MeetoHub/dsh-fnos#v0.1.0
```

> ### ⚠️ 装完之后：任何远程 URL 依赖都会拖慢后续安装
>
> 用 `https://…/dsh-fnos-x.y.z.tgz` 这种**远程 URL** 装进 profile 后，它就成了
> 一条"每次都要联网校验"的依赖。此后你安装**任何其它插件**，pnpm 都会重新解析
> 整张依赖图并再次请求这个地址。
>
> 若该地址不可达（部分网络对 GitHub releases 会超时 ~21 秒），症状是
> **「插件安装中…」一直转圈、新插件装不上**——而且几乎不可能联想到是 fnos 引起的。
>
> **自查**：
>
> ```bash
> grep 'https\?://' "$DSH_PROFILE_DIR/package.json"
> ```
>
> 有输出就说明存在远程依赖。改成下面任一种即可消除：
>
> ```bash
> # 开发态：本地软链，不联网
> plugin_manager  install_bundle  target = /path/to/dsh-fnos
>
> # 离线：tgz 下到本地后按文件路径装
> plugin_manager  install_bundle  target = file:/path/to/dsh-fnos-0.2.2.tgz
> ```

---

## 方式三：从 npm 安装

```bash
pnpm add dsh-fnos
```

> 尚未发布到 npm registry。发布后这条最简单，只需包名。

---

## 安装后

1. **重启 DSH**（首次安装新包需要重新加载模块）
2. 打开插件管理，确认能看到 **飞牛 NAS** 这个条目（标题来自 `locale/zh.json` 的 `meta.title`）
3. 点进插件详情页 → 在页面里填设备地址（形如 `192.168.1.10` 或 `nas.local`）→ 点「授权登录」
4. 授权完成后，输入框左侧会出现飞牛图标，按 `/` 或 Ctrl+点击 即可引用 NAS 上的文件

---

## 前置条件

| 项 | 要求 |
|---|---|
| DSH | `>= 0.2.0-rc.2`（见 `package.json` 的 `dsh.engines.dsh`） |
| Node | `>= 22` |
| fnOS 设备 | 开启 OpenAPI 访问，端口默认 `5667`（HTTPS） |
| 网络 | 本机能访问到设备；自签证书会被自动容忍 |

> **关于 `trim-cli`**：本插件的一切能力都建立在调用 fnOS 官方 CLI `trim-cli` 之上。
> 包内 `bin/` 已附带六个平台的预编译产物（共约 41 MB），装完即可用，无需单独安装。
> 如果要用自己的版本，查找顺序是：`FNO_TRIM_CLI` 环境变量 → 包内 `bin/` → 系统 `PATH`。
> 详见 README 的「关于 `bin/` 里的二进制」。

---

## 开发态安装（本地改代码）

源码开发和上面三种不同 —— 用**链接**而不是安装包，改完无需重装：

```bash
cd "$DSH_PROFILE_DIR"
pnpm add link:/path/to/dsh-fnos
```

改宿主侧代码后在插件管理器里关一次再开（HMR 重载）；改 `lib/client.js` 后刷新页面即可。

两种形态的区别：

| 形态 | 依赖写法 | 更新方式 |
|---|---|---|
| 开发 | `dsh-fnos: link:G:/fnos` | 改文件即生效 |
| 使用 | `dsh-fnos: 0.1.0` / git / tgz | 重装或升级版本 |

---

## 卸载

```
plugin_manager  remove_bundle  target = dsh-fnos
```

---

## 常见问题

**装完看不到图标？**
先确认重启过 DSH。首次安装新包必须重启，仅刷新页面不够。

**提示 `dsh.engines.dsh` 不满足？**
DSH 版本太旧，升级到 `0.2.0-rc.2` 以上。

**授权一直失败？**
海外版（FygoOS）的 OAuth 端点会拒绝 `trim-cli` 的 `client_id`，这是设备侧限制，插件无法绕过。国内版飞牛正常。
