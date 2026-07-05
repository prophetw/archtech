# 📷 image-browser

内网图片浏览器 — 内网机器装个 npm 包跑起来，手机扫码直接看图。

## 架构

```
[内网电脑 CLI] ←──WebSocket──→ [公网中继 Relay + Nginx] ←──WebSocket──→ [手机 Web Viewer]
    📂 扫描文件夹                  🔐 密钥鉴权 + 房间密码                 📱 扫码看图
```

## 安全模型（三层防护）

你的 relay 暴露在公网，但不会被人滥用：

```
                  公网 ←── 任何人都能连到这里
                   │
    ┌──────────────┼──────────────┐
    │  第1层：RELAY_SECRET       │  只有持有密钥的 CLI 才能创建房间
    │  第2层：房间随机密码        │  每间房自动生成6位密码，扫码获得
    │  第3层：失败锁定 + 速率限制  │  密码错10次锁定房间，Nginx 限制连接频率
    └─────────────────────────────┘
```

| 防护层 | 在哪里 | 防什么 |
|--------|--------|--------|
| RELAY_SECRET | relay + cli | 防止陌生人创建房间、占用资源 |
| 房间密码（6位 hex） | relay 自动生成 | 防止猜到 roomId 就能偷看图片 |
| 失败锁定（10次） | relay | 防止暴力破解房间密码 |
| Nginx 速率限制 | Nginx | 防止 CC/DoS 攻击 |
| 1小时自动过期 | relay | 防止遗忘清理，减少暴露面 |
| Host 断开即销毁 | relay | CLI 退出房间立刻没了 |
| 目录遍历防护 | cli | 只能看指定文件夹，不能 `../../../etc/passwd` |

**什么情况下别人还能看到？**
- 你泄露了 RELAY_SECRET（能创建房间）
- 你泄露了二维码截图（能加入已有房间）
- 你设置了弱 RELAY_SECRET 且攻击者同时猜中了 roomId 和房间密码（概率极低）

## 目录结构

```
image-browser/
├── packages/
│   ├── cli/            # npm 包：内网机器上跑
│   ├── relay/          # 中继服务器：公网部署
│   └── viewer/         # 手机端 Web 页面
├── package.json
└── README.md
```

---

## 部署指南

### 第一步：在公网服务器上部署 Relay

假设你的服务器 IP 是 `123.123.123.123`，域名是 `relay.your-domain.com`。

**1. 上传代码并安装依赖**

```bash
# 在服务器上
cd /opt
git clone <你的仓库>
cd image-browser/packages/relay

cp .env.example .env
# 编辑 .env，设置一个强随机密钥
# RELAY_SECRET=至少16位的随机字符串

npm install
npm run build
```

**2. 生成密钥**

```bash
# 用这个命令生成随机密钥
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# 输出类似: a1b2c3d4e5f6...（64位 hex）
```

**3. 用 PM2 保活**

```bash
npm install -g pm2
pm2 start dist/index.js --name image-browser-relay
pm2 save
pm2 startup
```

验证 relay 已启动：

```bash
curl http://127.0.0.1:3000/health
# → {"status":"ok","rooms":0,"uptime":12.3}
```

**4. 配置 Nginx 反代 + SSL**

```bash
# 复制 Nginx 配置
cp packages/relay/nginx.conf /etc/nginx/sites-available/image-browser

# 修改域名
sed -i 's/relay.your-domain.com/你的域名/g' /etc/nginx/sites-available/image-browser

# 修改 viewer 文件的路径（如果不一样的话）
# root /opt/image-browser/packages/viewer/dist;

# 启用站点
ln -s /etc/nginx/sites-available/image-browser /etc/nginx/sites-enabled/

# 检查配置
nginx -t

# 重载
nginx -s reload
```

**5. 申请 SSL 证书（Let's Encrypt 免费）**

```bash
# 先确保域名 DNS 已指向服务器 IP
apt install certbot python3-certbot-nginx
certbot --nginx -d relay.your-domain.com

# 证书会自动续期（certbot 加了 cron）
```

**6. 防火墙放行**

```bash
# 只需要 80 和 443，3000 不对外开放
ufw allow 80
ufw allow 443
ufw enable

# 云服务商控制台也要放行 80/443（TCP）
```

此时 relay 只监听 `127.0.0.1:3000`，外部流量全部经 Nginx 代理。

### 第二步：构建 Viewer 页面

```bash
cd packages/viewer
npm install
npm run build
# 输出到 packages/viewer/dist/
```

静态文件由 Nginx 直接提供（不经过 Node），效率更高。

### 第三步：内网电脑使用 CLI

```bash
cd packages/cli
npm install

# 设置环境变量
export RELAY_URL=https://relay.your-domain.com
export RELAY_SECRET=你的密钥（和 relay 端 .env 里的一致）

# 在图片文件夹里运行
npm run dev -- ./我的图片文件夹
```

终端输出：

```
📂 目录: /home/me/我的图片文件夹
🔗 中继: https://relay.your-domain.com
🏠 房间: img_a1b2c3d4_1751683200000

🖼️  发现 42 张图片

  ████████████████████████████████
  ██  ██    ██  ████  ██    ████
  ██  ██    ██  ████  ██    ████     ← 二维码
  ...

🔑 房间密码: 3f7a2c
📱 扫码或访问: https://relay.your-domain.com?room=img_a1b2c3d4_1751683200000&password=3f7a2c

👀 等待手机连接... (Ctrl+C 退出)
```

### 第四步：手机扫码看图

1. 用手机相机或微信扫码 → 自动打开浏览器
2. 页面自动填入房间 ID 和密码
3. 点"连接" → 看到图片网格
4. 点击任意图片 → 全屏大图
5. CLI 端 Ctrl+C 退出 → 房间立即销毁

---

## 部署架构图

```
                         你的公网服务器
  ┌──────────────────────────────────────────────┐
  │                                              │
  │   Nginx (:443)                               │
  │   ├── /          → viewer/dist (静态HTML)     │
  │   ├── /health    → 127.0.0.1:3000 (仅本地)   │
  │   └── /socket.io/ → 127.0.0.1:3000 (WS代理)  │
  │                      │                       │
  │                 Node.js (:3000)               │
  │                 仅监听 127.0.0.1              │
  │                 RELAY_SECRET=xxx              │
  │                 Socket.IO 房间管理            │
  │                                              │
  └────────────────────┬─────────────────────────┘
                       │
          ┌────────────┴────────────┐
          │                         │
    内网电脑 CLI              手机浏览器
    RELAY_SECRET=xxx          扫码获得 room+password
    创建房间 + 监听文件        viewer:join(room, password)
    出站 WebSocket → :443     出站 WebSocket → :443
```

---

## 环境变量参考

### Relay

| 变量 | 必填 | 说明 |
|------|------|------|
| `RELAY_SECRET` | ✅ | 密钥，CLI 必须持有同样值才能创建房间 |
| `PORT` | ❌ | 监听端口，默认 3000 |

### CLI

| 变量 | 必填 | 说明 |
|------|------|------|
| `RELAY_URL` | ✅ | 中继服务器完整 URL，如 `https://relay.your-domain.com` |
| `RELAY_SECRET` | ✅ | 密钥，必须和 relay 端一致 |

---

## 日常运维

```bash
# 查看 relay 状态
pm2 status

# 查看日志
pm2 logs image-browser-relay
tail -f /var/log/nginx/image-browser-access.log

# 重启 relay
pm2 restart image-browser-relay

# SSL 证书续期（自动的，手动测试用）
certbot renew --dry-run
```

---

## 常见问题

**Q: 手机连不上？**
- 确认手机用 4G/5G（不走内网 WiFi）能访问 `https://你的域名`
- 确认云服务商防火墙放行了 443
- `curl -I https://你的域名` 看是否返回 200

**Q: 二维码扫出来打不开？**
- 确认 RELAY_URL 是 `https://` 开头
- 确认域名 DNS 已解析

**Q: 怎么换密钥？**
- 两边同时改 RELAY_SECRET 为同一个新值，重启 relay 即可
- 旧房间不受影响（已创建的用旧密码，过期自然消失）

**Q: 能同时开多个房间吗？**
- 可以。每台内网机器各跑一个 CLI，各自有独立的 roomId 和密码
- relay 是无状态的，多房间互不干扰
