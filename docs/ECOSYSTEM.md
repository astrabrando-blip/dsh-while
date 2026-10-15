# DSH 插件发布规则核实

核实日期：2026-10-15。以官方文档为准；当前主分支文档不等于所有已安装版本的能力。

1. 包声明 `dsh.bundle.patch`，patch 按包名注册插件。无 bundle 声明时安装依赖不代表激活插件。
2. CLI 安装到具体 profile。公开的安装形式包括本地 checkout、GitHub 来源和预构建 tarball。while 为带 UI 的插件，应安装进已有 Web/Desktop 组合。
3. Git 安装若缺构建产物，需要 prepare；pnpm 的构建授权是执行安装脚本的权限。本版直接包含 JS，提供 tarball，不要求安装时重建。
4. peerDependencies 描述与宿主共享的依赖；独立开发测试需对应 devDependencies。不能依赖作者本机的符号链接。
5. 加载顺序依次是 bundle、profile patch、home patch、命令行 patch。后面的 config 替换整个对象，不是深合并。
6. 官方 README 推荐仓库添加 `dsh-plugin` topic。该标签帮助发现，不是官方审核或背书。
7. 未找到统一的官方“上架审核通过”流程。独立社区目录应分别查其收录规则，不把第三方目录称作官方市场。
8. DSH 为开发者预览，明确注明兼容版本和未验证项；GitHub 安装建议固定 commit。

官方依据：
- https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.zh.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/index.zh.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/README.zh.md

本版选择：独立 bundle + 已提交 JS + GitHub 源码仓库 + Release tgz；不默认发布 npm，不自动向第三方目录提交。
