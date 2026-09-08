# 喝了么 🥤

朋友之间互相催喝水的社交 Web 应用（已具备账号密码登录、SQLite 持久化，可公网部署，见 DEPLOY.md）。互加好友 → 点名「催TA」喝水（损友文案），或自己喝水时"喊"勾选的水友一起干杯（这杯喊谁）→ 对方点「干了这杯」回敬 → 双向实时收到消息（主页横幅 + 消息流）；每日喝水计数（默认 8 杯可自改）；支持免打扰（默认 23:00-08:00 可调 + 手动开关）与消息清空。

## 运行

需要 Node.js ≥ 22.5（存储使用内置 node:sqlite），推荐 Node 24；零第三方依赖，无需 npm install。数据存于 data/data.db（SQLite），旧版 data.json 首次启动自动迁移。

**Windows 一键启动**：双击 `start.bat`（会自动打开浏览器，关闭窗口即停止服务）。

或命令行启动：

```bash
node server.js
# → 打开 http://localhost:3000
```

端口被占用时：`PORT=3001 node server.js`（Windows cmd 用 `set PORT=3001 && node server.js`）。

## 用手机/其他设备访问（同一 WiFi）

手机浏览器打开 `http://电脑IP:3000`——**不要**用 localhost（那是手机自己）。查电脑 IP：`ipconfig` 里的 IPv4 地址。

打不开时按顺序排查：
1. 手机与电脑连同一个 WiFi（公司/校园网若开"AP 隔离"则设备互不可见，需换网络或开热点）；
2. Windows 防火墙放行：管理员 cmd 执行
   `netsh advfirewall firewall add rule name="喝了么" dir=in action=allow protocol=TCP localport=3000`
   （或启动时弹窗选择"专用网络 → 允许访问"）。

> 每台设备身份独立存储：手机打开是全新注册页，正好注册第二个身份与电脑互玩；不同设备间就是真·跨设备实时互催。

## 双开试玩（推荐流程）

两个窗口可以都在**普通浏览器窗口**里开（不必用隐身窗口）——身份已按窗口隔离：

1. 打开两个浏览器窗口访问 `http://localhost:3000`；
2. 窗口 A 注册「老张」（主身份，存本机浏览器，关掉重开都还在）；
3. 窗口 B 点右上角「**换身份**」→ 确认后注册「小王」——这是**临时身份，只属于当前窗口**：刷新不丢（顶栏有黄色「临时」标识），关闭该窗口后自动回到主身份，不会覆盖窗口 A；
4. 之后继续下面的好友/催喝/回敬玩法，两个窗口随便刷新互不影响。
3. **加好友**：A 在「好友」页输入 B 的 6 位邀请码 → B 收到请求点「同意」；
4. **催喝**：A 在 B 的好友卡片点「催TA」→ B 的窗口**实时**收到催促（消息 Tab 红点 + 喝水页主按钮自动变成「回应模式」）；
5. **喝水喊水友**：A 自己点「咕咚」喝水前，可在喝水页"这杯喊谁"里勾选提醒对象（默认全选，可单独取消/全选/清空）→ 被喊的水友实时收到碰杯邀请「甲喝了一杯，喊你一起干杯」；没被勾选或刚喝过/免打扰中的水友只收安静动态；
6. **免打扰**：右上角 ⚙️ 可手动开启免打扰或调整时段（默认 23:00-08:00，支持跨零点）；生效期间你的水友催/喊你会被拦下并提示"免打扰中"（好友卡片同步显示），喝水动态仍会安静送达；
7. **回敬**：B 点消息里的「干了这杯」或直接点主按钮 → B 计数 +1，A 实时收到「🍻 干了一杯」主页横幅 + 等待行消失；
8. 消息页可**按类型筛选**（全部/催喝·碰杯/回敬/喝水动态），右上角可**清空消息**（只清你自己的视图，不影响对方记录）；
9. 好友卡片会显示**今日互动小记**（今日催过几次、已回敬几次）。
6. 观察规则：催完立刻再催会进入**冷却倒计时**；对方刚喝过会被提示「缓一缓」；每日催同一人上限 8 次；
7. 双方各自喝水，对方消息流出现「喝了今天第 N 杯」动态；数据存在 `data/data.json`，重启不丢。

## 防打扰规则（正式默认值，可用环境变量覆盖）

| 规则 | 默认 | 环境变量 |
|---|---|---|
| 对同一水友手动催喝冷却 | 10 分钟 | `REMIND_COOLDOWN_MS` |
| 对方刚喝过禁催窗口 | 15 分钟 | `REMIND_JUST_DRANK_MS` |
| 每日催同一水友上限 | 8 次 | `REMIND_DAILY_LIMIT` |

> 演示时想放开测试：`REMIND_COOLDOWN_MS=0 REMIND_JUST_DRANK_MS=0 node server.js`（Git Bash）；
> Windows cmd：`set REMIND_COOLDOWN_MS=0 && set REMIND_JUST_DRANK_MS=0 && node server.js`。
> 喝水自动"喊人"邀请不受这三条限制（只受"对方刚喝过/免打扰"约束）。

## 测试

```bash
node test/regression.mjs   # 全功能回归 34 项（隔离实例，不影响正式数据）
node test/mvp.mjs          # MVP 验收 23 项：完整用户旅程 + SSE 实时断言（正式规则）
node test/account.mjs      # 账号链路 10 项：密码注册/登录/重名/过期/持久化
```

## 文件结构

```
server.js            # 静态服务 + REST API + SSE 实时推送（零依赖）
start.bat            # Windows 双击启动
test/regression.mjs  # 回归测试
data/data.json       # 运行时自动生成的数据文件
public/index.html    # 单页结构（注册 + 三 Tab + 设置弹层）
public/app.js        # 前端逻辑（SSE、好友/催喝/消息流/免打扰）
public/styles.css    # 移动端优先样式
喝了么-项目初稿.md    # 产品初稿（PRD）
```

## API

| 方法/路径 | 说明 |
|---|---|
| `POST /api/register` `{nickname, password?, avatar}` | 注册（重名 409），返回 `{user, token}` |
| `POST /api/login` `{nickname, password}` | 密码登录，返回 `{user, token}` |
| `GET /api/me` | 我的信息 + 今日杯数 + 待回敬催喝列表 |
| `PATCH /api/me` `{dailyGoal}` | 修改每日目标（1-20） |
| `POST /api/drinks` `{via: 'self'\|'reply', remindId?}` | 打卡 / 回敬 |
| `POST /api/friend/request` `{code}` | 按邀请码发起加好友（反向 pending 自动转正） |
| `GET /api/friend/requests` | 待处理请求（incoming/outgoing） |
| `POST /api/friend/reply` `{id, accept}` | 同意/忽略请求 |
| `GET /api/friends` | 好友列表（含今日杯数/上次喝水/可催状态） |
| `POST /api/reminds` `{toId}` | 催喝（随机损友文案 + 规则校验） |
| `GET /api/feed` | 我的消息流（催喝/回敬/喝水动态/系统 + 未读数） |
| `POST /api/feed/read` | 全部标记已读 |
| `GET /api/events?token=` | SSE 长连接，实时事件推送 |
| `GET /api/health` | 探活 |

## 里程碑

- [x] M0 能喝：注册身份 + 喝水计数 + 三 Tab 骨架
- [x] M1+M2 合并：SSE 实时推送 + 双向好友 + 催喝/回敬闭环 + 损友文案池 + 消息流/未读红点
- [x] 扩展功能：喝水"这杯喊谁"勾选、免打扰（时段+手动）、消息类型筛选/清空、好友互动小记、邀请链接
- [x] M3 打磨：正式防打扰规则、一键启动、回归测试固化、README 收口（正式可用 demo）
- [ ] UI 视觉改版（用户手绘 icon，待功能全部完善后）

> 注：曾尝试在扣子（Coze）云端开发（项目 https://www.coze.cn/p/7682612459215224874 ），因账号积分不足，改走本机零积分开发路线；云端 M0 结果仅作参考。
