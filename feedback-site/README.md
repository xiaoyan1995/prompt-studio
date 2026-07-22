# Prompt Studio Desktop 反馈网站

这是一个独立的反馈收集站点，不参与桌面端的业务数据和 `studio-data`。

## 启动

需要 Node.js 18 或更高版本。双击 `dev-start.bat`，或在本目录执行：

```text
npm start
```

用户提交页：`http://127.0.0.1:8788/`

管理页：`http://127.0.0.1:8788/admin.html`

首次启动时会在 `data/admin-token.txt` 生成管理令牌，并在终端显示一次。正式部署时建议设置环境变量 `FEEDBACK_ADMIN_TOKEN`，不要把令牌提交到代码仓库。

## 数据位置

- 反馈记录：`data/issues/`
- 附件：`data/uploads/`
- 管理令牌：`data/admin-token.txt`

备份时需要一起备份 `data`。`.gitignore` 已忽略真实反馈数据。

## 部署

将整个 `feedback-site` 目录放到服务器，执行 `npm start`。反向代理到 `8788` 端口即可。建议在反向代理层启用 HTTPS，并限制管理页访问来源。

测试：

```text
npm test
```

附件只接受图片、MP4/WebM、纯文本、JSON、PDF 和日志文件；单个附件最多 8 MB，单次最多 5 个，合计最多 24 MB。
