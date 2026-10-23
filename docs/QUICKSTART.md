# 三步装好（给第一次用的人）

一句话：**装插件 → 重启一次 → 填个地址点登录**。装完不用配置任何东西，技能和 CLI 都是自动的。

---

## 第 1 步：装

在 DSH 的输入框里发这句话（也可以直接交给 DSH 的 Agent）。

**Windows 电脑用这条**（绝大多数人）：

```
plugin_manager  install_bundle  target = https://github.com/MeetoHub/dsh-fnos/releases/latest/download/dsh-fnos-windows-x64.tgz
```

**Mac 用这条**（Apple 芯片）：

```
plugin_manager  install_bundle  target = https://github.com/MeetoHub/dsh-fnos/releases/latest/download/dsh-fnos-darwin-arm64.tgz
```

**不确定的话用这条**（会大一些，但任何系统都能用）：

```
plugin_manager  install_bundle  target = https://github.com/MeetoHub/dsh-fnos/releases/latest/download/dsh-fnos.tgz
```

等它显示安装完成。Windows 那条只有 3.1 MB，一般半分钟就好了。

---

## ⚠️ 最容易犯的错：粘错地址

**下面这个地址装不上**（它是仓库网页，不是安装包）：

```
❌ https://github.com/MeetoHub/dsh-fnos          ← 浏览器地址栏那个
❌ https://github.com/MeetoHub/dsh-fnos.git      ← 加了 .git 也不行
```

**要粘的是 `.tgz` 结尾的下载链接**（见上面第 1 步），或者用仓库简写语法：

```
✅ https://github.com/MeetoHub/dsh-fnos/releases/latest/download/dsh-fnos-windows-x64.tgz
✅ github:MeetoHub/dsh-fnos                      ← 注意没有 https://，是 github: 开头
```

判断方法：**结尾是 `.tgz`，或者开头是 `github:`**。两者都不是，就一定装不上。

如果装的时候只显示「无输出」「安装失败」，九成是地址错。

---

## 第 2 步：重启 DSH

**完全退出 DSH，再重新打开。**

> 这一步不能省。不是刷新页面，是退出程序再启动。

---

## 第 3 步：连你的 NAS

1. 左边点 **插件**
2. 找到 **飞牛 NAS**，点进去
3. 点 **自动发现** —— 几秒后它会列出你家网络里的飞牛设备，点一下那个地址就填好了
   - 如果没发现任何设备，就手动填主机地址，比如 `192.168.1.10`
4. 点 **登录飞牛 NAS** —— 会自动弹出浏览器
5. 在浏览器里登录你的飞牛账号，点同意，页面会给一串授权码，复制它
6. 回到 DSH 粘进输入框，点 **完成登录**

看到「✅ 已连接飞牛 NAS」就成了。

---

## 怎么用

在对话输入框**左边**会出现一个飞牛图标：

- 点它 → 打开你 NAS 的文件夹
- 点文件夹能进去，还能往上返回
- **按住 Ctrl 点文件** → 文件名自动变成 `@文件名` 加进你的话里

比如：「帮我把 @封面-终稿.psd 转成 png」——DSH 就知道你说的是 NAS 上那个文件。

---

## 装不上怎么办

**装完看不到图标**
没重启。真的退出 DSH 再打开一次。

**授权页显示「参数异常」**
你的设备是海外版 FygoOS 固件，它的授权接口不认官方 CLI，这是设备那边的限制，插件绕不过。国内版飞牛没这个问题。

**不知道 NAS 的地址**
在飞牛的管理界面里能看到；或者路由器后台的设备列表里找。

---

## 装了会不会影响我别的插件

不会。唯一要注意的是：**别用「下载链接」的方式反复重装**。如果你以后发现装别的插件时一直转圈，用下面这条命令检查一下有没有残留的远程依赖：

```bash
grep 'https\?://' "$DSH_PROFILE_DIR/package.json"
```

有输出就说明埋了雷，把插件卸掉重装一次即可（或者改用本地文件安装）。

---

需要更细的说明看 [INSTALL.md](INSTALL.md)；想知道它内部怎么实现的看 [DEVELOPMENT.md](DEVELOPMENT.md) 和 [PITFALLS.md](PITFALLS.md)。
