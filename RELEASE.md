# Prompt Studio Desktop v1.2.2 Windows 发布说明

## 插件是否通用

`extension` 是适用于 Windows Chrome / Edge 的 Chromium 扩展。

## Windows

优先使用安装包：

- `Prompt Studio Desktop Setup 1.2.2.exe`

便携版（推荐）：

- `Prompt Studio Desktop-1.2.2-portable-win.zip`

解压后目录结构如下：

```
Prompt Studio Desktop-1.2.2-portable-win/
├── desktop/
│   └── Prompt Studio Desktop.exe   ← 双击运行
├── extension/                      ← 浏览器插件
└── skills/                         ← Agent Skills
    └── prompt-studio/
        ├── SKILL.md
        └── REFERENCE.md
```

桌面端内置了本地后端，不需要额外安装 Python。

数据会写入软件同目录的 `studio-data` 文件夹，迁移时只需复制该文件夹即可。

删除策略：

- 普通删除只删除记录，不删除图片/视频文件
- 图片/视频提示词详情里的 `删除+素材` 会同时删除未被其他提示词引用的本地素材
- 设置里的 `清理未引用素材` 会删除 `studio-data/uploads` 下没有被任何提示词引用的文件

浏览器插件安装：

1. 打开 Chrome / Edge 扩展管理页。
2. 开启开发者模式。
3. 选择本包里的 `extension` 文件夹加载。

## Agent Skills

`skills/prompt-studio/` 内含让 AI agent 读写 Prompt Studio 的技能文件。
将 `SKILL.md` 内容加入 agent 的 system prompt 即可，无需额外安装工具。
