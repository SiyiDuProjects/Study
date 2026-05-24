# 中韩课堂字幕器

一个面向手机和 iPad 的本机优先 PWA，用于韩语课堂实时中文字幕和课后完整中韩逐字稿保存。

## 功能

- 实时麦克风输入，使用 `gpt-realtime-translate` 做韩语到中文翻译。
- 同一会话启用 `gpt-realtime-whisper`，保存韩文源语言转录。
- 字幕器主屏以大号中文为核心，上一两句弱化显示，韩文默认隐藏。
- 课后记录保存在浏览器 IndexedDB，可导出 Markdown。
- 不保存课堂音频，不做云同步、摘要、复习卡或复杂笔记编辑。

## 本地运行

```bash
npm.cmd install
npm.cmd run dev
```

打开本机地址后，在设置里输入 OpenAI API key，允许麦克风权限，然后点击“开始”。

## 重要安全说明

当前实现按个人私用原型处理，浏览器会使用 Realtime WebSocket 的 `openai-insecure-api-key.*` 子协议连接 OpenAI。不要公开部署这个版本，也不要把 API key 提交到仓库。

更适合长期使用的版本应该增加一个轻量后端：标准 API key 只放在服务端，前端只拿短期 client secret。

## 脚本

```bash
npm.cmd run dev       # 开发服务器
npm.cmd run build     # 类型检查 + 构建
npm.cmd run test      # 单元测试
```

## GitHub 连接

当前机器已安装 GitHub CLI，但本机 `gh` token 失效。重新登录后可以执行：

```bash
gh auth login -h github.com
gh repo create korean-class-subtitler --private --source=. --remote=origin --push
```
