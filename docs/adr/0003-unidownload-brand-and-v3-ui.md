# 0003 Unidownload 名称与第三版界面

日期：2026-10-18
状态：已实施（界面与品牌），真实网盘验收部分完成，见 `docs/plans/2026-10-18-unidownload-acceptance.md`

## 背景

用户认可现有功能，要求参照 Gopeed 重新设计 UI。用户认可第三版后，选定「Unidownload」并认可 Logo 概念，要求交接到新会话开始实施。

## 决定

- 产品名称为 **Unidownload**，保持该拼写。PanPort、UniDown 只是候选，中文名和口号未确定。
- 以 `docs/design/gopeed-ui-v3.html` 及同名前缀的 light/dark/detail 截图为基准。V1/V2 仅供比较。
- 使用深绿、薄荷色、灰白底；保留窄主导航、状态/四网盘筛选、任务区、右侧详情、独立设置与深浅主题。
- 用户明确不要任务前方的文件/文件夹类型图标列。V3 已删除，不要重新加回。导航、操作、状态图标保留。
- Logo 为 U 与向下下载箭头结合。用户认可 `docs/design/unidownload-logo-concept.png`，它是生成的品牌展示 PNG，含字标和桌面图标示意，不是正式 SVG/透明图标。
- 在现有 Electron 渲染层实施，复用 `window.linkswift` 与共享协议。Gopeed 是视觉参考，不迁移 Flutter/Go，不添加其 BT/扩展等功能。
- 保留真实四网盘能力边界：UC 会话登录态、迅雷应用内登录、授权转存后手动选文件取链，以及百度适用的转存。UC/迅雷在当前代码仍有 experimental 标记，不因 UI 更新擅自删除。

## 否掉的方案

- 只给旧布局换颜色；把设置继续挤进任务区域。
- 直接移植 Gopeed 界面文件，或为这次改版先换整个框架。
- 将取到链接、已投递或手动处理提示当作真实下载完成。

## 后果

原型任务/速度/交互均是演示。正式实现要使用真实 IPC 结果、多文件进度与错误，并保持下载恢复。更改内部包名、应用标识或 userData 前必须验证配置和会话兼容，避免新名称导致丢失历史记录。实施细则见 `docs/plans/2026-10-18-unidownload-ui-implementation.md`。

## 实施记录（2026-10-18 接续会话）

- 可见更名只改窗口标题、renderer 品牌、README 与图标；`package.name`、`persist:linkswift`、`app.getPath('userData')`、IPC 名、settings/jobs/aria2 路径均未动，也未加 `productName` 或 `app.setName`。重启验证旧任务原样载入。
- 品牌资源在 `resources/brand/`：真实矢量 SVG（U + 向下箭头，深绿 `#233c2e`、薄荷 `#d0efb5`）、16–512 透明 PNG、16–256 的 ICO，由 `npm run brand` 重建、`npm run check:brand` 检查。
- 界面按 V3 落地并修掉三处行为缺陷：深色主题类挂错元素、已完成任务按当前设置误标出口、任务事件重渲染丢焦点/滚动。
- 真实下载结果：UC 49 文件与外部 aria2 完成并落盘校验；百度缺登录会话、迅雷助手菜单需人工点击，均记录为阻塞而非通过。
