# Unidownload 品牌资源

全部资源由两个矢量源生成，不手工导出，也不要直接改 PNG/ICO。

| 文件 | 用途 |
|---|---|
| `unidownload-mark.svg` | 主标志：U 环 + 同色向下箭头（深绿 `#233c2e`，全平色、透明底），可以直接放在任意背景上 |
| `unidownload-icon.svg` | 应用图标：深绿圆角方砖 `#233c2e` 上放薄荷 `#d0efb5` 的 U 与箭头 |
| `unidownload-mark-{16,24,32,48,64,128,256,512}.png` | 透明主标志位图 |
| `unidownload-icon-{16,24,32,48,64,128,256,512}.png` | 应用图标位图 |
| `unidownload.ico` | Windows 图标，含 16/24/32/48/64/128/256 七个尺寸 |

主标志没有白色镂空：改为「U 环 + 同色箭头」两个独立形状，箭头位于 U 的内腔里。小尺寸（16/24）优先使用 `icon-*`，信息量更大。

## 重新生成

```powershell
$env:ELECTRON_RUN_AS_NODE = $null
npm run brand
```

生成走已装的 Electron（隐藏窗口把 SVG 画到 canvas 再导出 PNG），ICO 目录用 Node Buffer 拼装，不额外装依赖、不联网。

## 检查

```powershell
npm run check:brand
```

检查：SVG 是真实矢量且不内嵌位图、每个 PNG 的签名与 IHDR 尺寸、ICO 目录项数/偏移/载荷边界、窗口标题与图标接线，以及 `package.name` / `persist:linkswift` / userData 路径未被改名（改名会让旧配置、登录态和续传记录失联）。

## 使用约定

- 名称固定为 **Unidownload**；中文名与口号未定，不要自行添加。
- 小尺寸优先用 `icon-16/24/32`，主标志在浅色底上使用 `mark-*`。
- 图标在 16px 下仍可辨 U 与箭头；改动箭头宽度或 U 的内腔后要重新看 16/24/32。
