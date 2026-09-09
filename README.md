# 喝了么 🥤

朋友之间互相**催喝水**的社交小应用：互加好友 → 点名「催TA」→ 对方点「干了这杯」回敬；自己喝水时还能"喊"水友一起干杯。每日喝水计数、免打扰、消息筛选等，一套完整的"社交喝水"玩法。

- 形态：移动端优先的 **H5 网页**（手机/电脑浏览器都能用）
- 后端：**Node.js 零第三方依赖**（HTTP/静态/API/实时推送全内置）
- 存储：**SQLite**（Node ≥ 22.5 内置 `node:sqlite`，无需安装任何数据库）
- 实时：SSE 长连接，好友动作秒级到达

---

## 一、新手 5 分钟跑起来

### 1. 安装 Node.js

需要 **Node.js ≥ 22.5**（推荐 24 LTS）。检查是否已装：

```bash
node -v
```

没有就下载安装（一路默认下一步即可）：

- Windows：https://nodejs.org/zh-cn/download 下载 **LTS 版** `.msi`
- macOS：同上选 `.pkg`，或用 `brew install node`
- Linux(Ubuntu)：
  ```bash
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y nodejs
  ```

安装后重开终端，`node -v` 能看到版本号即可。项目**无需 `npm install`**（没有任何第三方依赖）。

### 2. 获取代码

```bash
git clone https://github.com/Ruiiiii-rain/driiiink.git
cd driiiink
```

（没有 Git 也可以直接下载仓库的 ZIP 并解压。）

### 3. 启动

**Windows：** 双击项目根目录的 `start.bat`——自动启动服务并打开浏览器。

**任何系统（命令行）：**

```bash
node server.js
```

看到类似输出即成功：

```
🥤 喝了么 已启动
   本机访问: http://localhost:3000
```

然后浏览器打开 **http://localhost:3000**。

> 第一次启动会自动创建数据库 `data/data.db`（空库）；如果你是从旧版 JSON 升级，会自动迁移并留档。

### 4. 注册账号玩起来

1. 打开页面 → 输入**昵称**、**密码（至少 6 位）**、挑一个饮品头像 → 「开始喝水」；
2. 进入主页 = 一个大水杯：**每喝一杯点一下（杯子或「干杯」按钮），杯里的手绘水位就涨一格**；
3. 目标默认每天 8 杯，点右上角「N/8 杯」可以改。

---

## 二、两个人怎么玩（最重要！）

两个玩家 = **同一个服务 + 两个浏览器身份**（因为好友关系都存服务端）。

### 方式 A：同一台电脑双窗口（自测最方便）

1. 开两个浏览器窗口访问 `http://localhost:3000`；
2. 窗口 A 注册「老张」；
3. 窗口 B 点右上角「**换身份**」→ 注册「小王」（这是**临时身份**：只属于该窗口，刷新不丢、带「临时」标签；关闭窗口后回到主身份）；
4. 互相加好友：老张在「好友」页输入小王的 6 位**邀请码**（在对方喝水页可复制）→ 小王「同意」；
5. 开始互催：老张点小王卡片上的「催TA」→ 小王窗口**实时**弹出 → 小王点「干了这杯」回敬 → 老张主页弹横幅。

### 方式 B：两台设备（手机 + 电脑，同一 WiFi）

1. 电脑查 IP：命令行执行 `ipconfig`（Windows）或 `ifconfig`（macOS），记下 IPv4（如 `192.168.1.5`）；
2. 手机浏览器打开 `http://电脑IP:3000`——**不要用 localhost**（那是手机自己）；
3. 手机注册新账号 → 用电脑的邀请码加好友 → 互催。

> 手机打不开？→ 看下文「常见问题」第 3 条（防火墙/网络隔离）。

> 注意：两人要**同时保持页面打开**才能实时收到对方动作（网页的实时性限制）；关掉页面的人，回来后会看到消息补齐。

---

## 三、功能导览

| 功能 | 在哪 | 说明 |
|---|---|---|
| 喝水打卡 | 喝水页大杯子 | 点杯子/干杯按钮，手绘水位按进度切档上涨 |
| 催TA | 好友卡片按钮 | 随机损友文案提醒对方喝水（有冷却/上限防骚扰） |
| 这杯喊谁 | 喝水页勾选区 | 自己喝水时可选择"喊"哪些水友，不勾=安静喝水 |
| 回敬 | 消息里「干了这杯」或主按钮 | 被催/被喊后回敬，对方实时收到"干了一杯" |
| 主页横幅 | 喝水页顶部 | 有人回敬你时弹出，点「去看看」直达消息 |
| 免打扰 | 右上角设置 ⚙️ | 默认 23:00-08:00 或手动开启；期间水友催/喊会被拦下 |
| 消息管理 | 消息页 | 按类型筛选（催喝/回敬/动态）、未读红点、一键清空（只清自己） |
| 每日目标 | 喝水页右上角数字 | 默认 8 杯，1-20 可改，水位与刻度随目标自动适配 |
| 账号 | 注册/登录页 | 昵称+密码；昵称唯一；登录态 30 天有效 |

### 防打扰规则（默认值，可用环境变量覆盖）

| 规则 | 默认 | 环境变量 |
|---|---|---|
| 对同一水友**手动催喝**冷却 | 10 分钟 | `REMIND_COOLDOWN_MS` |
| 对方刚喝过禁催窗口 | 15 分钟 | `REMIND_JUST_DRANK_MS` |
| 每日催同一水友上限 | 8 次 | `REMIND_DAILY_LIMIT` |

想放开规则测试：

```bash
# Git Bash / macOS / Linux
REMIND_COOLDOWN_MS=0 REMIND_JUST_DRANK_MS=0 node server.js

# Windows cmd（两行）
set REMIND_COOLDOWN_MS=0
set REMIND_JUST_DRANK_MS=0
node server.js
```

> 自己喝水触发的"喊人"不受以上三条限制（只受"对方刚喝过/免打扰"约束）。

---

## 四、给别人/公网部署

见 **`DEPLOY.md`**（服务器部署、HTTPS、备案、备份、安全清单）。代码已具备：账号密码、登录 token 过期、注册/登录限流、SQLite 事务存储。

---

## 五、给协作者：开发工作流

```bash
git clone https://github.com/Ruiiiii-rain/driiiink.git
cd driiiink
node server.js          # 本地起服务开发调试
```

提交规范：

```bash
git pull origin main          # 动手前先拉最新
# …改代码…
node --check server.js        # 语法自检（改了哪个文件就 check 哪个）
node test/regression.mjs      # 提交前务必跑回归（自动起隔离实例，不影响你的本地数据）
node test/account.mjs         # 改了账号相关再加跑这条
git add .
git commit -m "说明你改了什么"
git push origin main
```

协作须知：

- `data/` 目录已被 `.gitignore` 排除——**各自电脑的数据互相独立**，不会误提交隐私；
- 避免多人同时改同一个文件；冲突时先 `git pull` 再解决，解决不了把报错发群里；
- 端口被占用：`PORT=3001 node server.js`（Windows：`set PORT=3001 && node server.js`）再访问 `http://localhost:3001`。

全部测试（三套，共 67 项断言，隔离实例运行）：

```bash
node test/regression.mjs   # 全功能回归 34 项
node test/mvp.mjs          # MVP 用户旅程 23 项（正式规则 + SSE 实时）
node test/account.mjs      # 账号链路 10 项
```

---

## 六、文件结构

```
driiiink/
├─ server.js            # 全部后端：静态服务 + REST API + SSE + SQLite（单文件）
├─ package.json         # 供 PaaS 识别 Node 项目（零依赖，无 node_modules）
├─ start.bat            # Windows 双击启动
├─ public/              # 前端（无构建，直接改直接刷新）
│  ├─ index.html        #   页面结构（注册/登录 + 三 Tab + 设置）
│  ├─ app.js            #   逻辑（SSE、好友/催喝/消息/免打扰）
│  ├─ styles.css        #   样式（喜茶风黑白纸感 + 手绘素材）
│  └─ images/           #   手绘素材：13 张水位杯图、Tab 图标、饮品头像、UI 图标
├─ data/                # 运行时生成（SQLite 库，已被 git 忽略）
├─ test/                # 三套自动化测试
├─ tools/               # 手绘素材处理工具（抠白底/裁剪）
├─ README.md            # 本文件
└─ DEPLOY.md            # 公网部署指南
```

---

## 七、常见问题（FAQ）

**1. 提示 `node:sqlite` ExperimentalWarning？**
正常。这是 Node 内置 SQLite 的实验性提示，不影响使用；升级 Node 24 后提示会消失。

**2. 端口 3000 被占用？**
`PORT=3001 node server.js`，然后访问 http://localhost:3001。

**3. 手机打不开 `http://电脑IP:3000`？**
依次排查：① 手机与电脑同一 WiFi；② Windows 防火墙放行（管理员 cmd 执行 `netsh advfirewall firewall add rule name="喝了么" dir=in action=allow protocol=TCP localport=3000`）；③ 公司/校园网开了"AP 隔离/访客隔离"则设备互不可见，换普通 WiFi 或手机开热点让电脑连。

**4. 忘记密码？**
当前没有找回功能（demo 阶段）：换昵称重新注册即可。旧版无密码测试号也无法登录（服务端会提示），请重新注册。

**5. 数据存在哪、会丢吗？**
全部在 `data/data.db`（SQLite）。**只要你别删它**，重启服务数据都在；代码更新不影响数据。想备份：复制这个文件即可（建议停服时复制）。

**6. 为什么我催 TA 没反应/按钮置灰？**
看按钮文案：冷却倒计时中 / TA 刚喝过(15 分钟内) / TA 免打扰中 / 今日催满 8 次——都是防打扰规则，不是 Bug。

**7. 关掉页面后还收得到吗？**
收不到实时推送（网页限制），但对方动作都会记录；下次打开页面消息自动补齐、水位按服务端数据渲染。

**8. 多人同时用一个号？**
每台设备/窗口独立身份，别共用账号；双人玩法请各注册各的（见"两个人怎么玩"）。

---

## 八、里程碑

- [x] M0 能喝：注册 + 喝水计数 + 三 Tab
- [x] M1+M2：SSE 实时 + 双向好友 + 催喝/回敬闭环 + 损友文案池 + 消息流
- [x] 扩展：这杯喊谁、免打扰、消息筛选/清空、互动小记、邀请链接、饮品头像体系
- [x] M3 打磨：SQLite 正式版 + 账号密码/登录 + 限流 + 手绘 UI + 三套测试
- [ ] 公网部署 / 小程序形态（规划中）

## 技术备注

- 后端为单进程 Node 服务：静态资源、REST API、SSE 实时推送、SQLite 事务存储全部内置，**无任何 npm 依赖**；
- 注册/登录有基础限流（每 IP 每小时 30 次、全局每日 300 号，环境变量可调）；
- 生产部署前请阅读 `DEPLOY.md` 的安全清单（HTTPS、TRUST_PROXY、备份）。
