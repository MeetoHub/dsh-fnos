# 开发与发布流程

本仓库**唯一主线即公开版本**。不存在"私有版 → 洗一遍 → 公开"的同步环节 —— 因为那类流程只要漏一次就会泄露（本项目曾因此把内网地址带进了公开历史）。

规矩很简单：**敏感的东西从不进 git，而不是进了再删。**

---

## 一、目录三分区

```
dsh-fnos/
├── lib/  bin/  locale/  entries/  reference/  scripts/
│                          ← 公开区：任何文件都可以被看到
├── docs/                  ← 对外文档
├── .local/                ← 私有区（.gitignore 已排除，永不入库）
│   ├── device.json        ← 你自己的 NAS 地址 / 端口
│   ├── notes/             ← 内部调试笔记、截图
│   └── tokens/            ← 任何凭据
└── .github/workflows/     ← CI
```

`.local/` 从第一天起就不被 git 看见，所以**没有"忘了脱敏"这种失误**。

真实设备信息怎么用？在插件界面里填一次即可（存浏览器 `localStorage`），不需要写进代码。

---

## 二、日常开发循环

```bash
# 1. 改代码
vim lib/client.js

# 2. 语法自检
node --check lib/client.js

# 3. 让 DSH 装载新代码（不用重启）
#    在 DSH 里：plugin_manager set_plugin(include:dsh-fnos-remote, false → true)

# 4. 客户端 UI 改动刷新页面（F5）即可

# 5. 提交（pre-commit 会自动扫敏感内容）
git add -A
git commit -m "feat: xxx"

# 6. 推送
git push
```

**注意**：只有**首次安装**插件需要重启 DSH；之后宿主侧改动用上面的 toggle，客户端改动用 F5。

---

## 三、分支与版本

个人项目，保持简单：

| 分支 | 用途 |
|---|---|
| `master` | 稳定线，随时可发布 |
| `feat/xxx`、`fix/xxx` | 较大的改动，完成后合回 master |

版本遵循 [语义化版本](https://semver.org/lang/zh-CN/)：

- `0.1.0 → 0.1.1` 修 bug
- `0.1.1 → 0.2.0` 加功能（向下兼容）
- `0.2.0 → 1.0.0` 破坏性变更

`package.json` 的 `version` 是**唯一真相**，tag 必须与之一致（CI 会校验）。

---

## 四、发布

```bash
# 1. 改版本号
npm version patch --no-git-tag-version   # 或 minor / major

# 2. 提交
git add package.json
git commit -m "chore: release v0.1.1"
git push

# 3. 打 tag 并推送 —— 这一步触发发布流水线
git tag v0.1.1
git push origin v0.1.1
```

`.github/workflows/release.yml` 会自动：

1. 校验 `tag` 与 `package.json` 版本一致
2. `node --check` 全部源码
3. **发布前再扫一遍**敏感内容（当前树 + 全历史）
4. `npm pack` 打包并检查产物
5. 创建 GitHub Release（自动生成变更说明）
6. 把 `.tgz` 附到 Release 上 —— 别人可以直接装：

```bash
pnpm add https://github.com/MeetoHub/dsh-fnos/releases/download/v0.1.1/dsh-fnos-0.1.1.tgz
```

变更说明由 GitHub 按 commit 自动生成，所以 **commit 信息请写清楚**（推荐 Conventional Commits：`feat:` / `fix:` / `docs:` / `chore:`）。

---

## 五、三道安全防线

| 防线 | 位置 | 触发时机 | 拦截内容 |
|---|---|---|---|
| ① 本地 hook | `scripts/hooks/pre-commit` | 每次 `git commit` | 内网地址 / 本机路径 / 邮箱 / 各类密钥 |
| ② CI 扫描 | `.github/workflows/secret-scan.yml` | 每次 push / PR | gitleaks 全历史 + 自定义规则（当前树 + 全历史） |
| ③ 发布复检 | `release.yml` | 每次打 tag | 同上，发布前最后一道 |

### 启用本地 hook（新克隆必做一次）

```bash
git config core.hooksPath scripts/hooks
```

hook 随仓库版本化，改规则只需改 `scripts/precommit-scan.mjs`。

### 命中被拦怎么办

```bash
# 看具体命中什么
node scripts/precommit-scan.mjs
```

- **真敏感** → 移到 `.local/`，然后 `git rm --cached` 掉已暂存的那份
- **误报** → 往 `scripts/precommit-scan.mjs` 的 `ALLOW` 里加**精确**的放行规则，不要放宽 `DENY`

### 万一已经提交了

**关键认知：强推清不掉旧对象。** GitHub 会保留不可达对象，旧 SHA 仍能匿名拉取 raw 文件。

正确处理顺序：

```bash
# 1. 立刻止血：把仓库转私有（匿名访问立即 404）
gh repo edit <owner>/<repo> --visibility private --accept-visibility-change-consequences

# 2. 重写历史
pip install git-filter-repo
git filter-repo --replace-text rules.txt --force   # 会移除 origin，需重新加回
git remote add origin <url>
git push --force origin master

# 3. 彻底清除：删库重建（这是唯一可靠方式）
#    网页 Settings → Danger Zone → Delete，或用有 delete_repo 权限的 token
#    然后 gh repo create 同名仓库重新推送

# 4. 没有 delete_repo 权限时的等效做法：改名挪走 + 原名重建
gh api -X PATCH repos/<owner>/<repo> -f name=<repo>-archive -f private=true
gh repo create <owner>/<repo> --public --source=. --push
```

---

## 六、随包的第三方二进制

`bin/` 下是 fnOS 官方的 `trim-cli` 预编译产物（约 41 MB），**不是本项目代码**。MIT 只覆盖自有代码，二进制的版权与许可归飞牛所有。替换或去掉它们只需把 `trim-cli` 放到 `PATH`（`lib/impl.js` 的 `cliPath()` 会优先用包内路径）。

---

## 七、速查

| 我想… | 命令 |
|---|---|
| 语法自检 | `node --check lib/client.js` |
| 扫敏感内容 | `node scripts/precommit-scan.mjs`（暂存区）/ `--all` / `--history` |
| 让 DSH 重载插件 | 插件管理器里关一次再开 |
| 发版 | 改 version → commit → `git tag vX.Y.Z` → push tag |
| 看发布结果 | `gh release list` |
| 查看 CI 失败原因 | `gh run list` / `gh run view <id> --log-failed` |
