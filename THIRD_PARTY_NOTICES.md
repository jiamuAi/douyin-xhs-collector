# 第三方软件与署名

项目自己的代码遵循根目录的 [MIT 许可证](LICENSE)。下列代码、实现参考和标识分别保留各自的版权及许可。

| 组件 | 用途与分发方式 | 随仓库提供的许可 |
| --- | --- | --- |
| Go 运行时、标准库及其随附组件 | 安装包内的本机更新助手使用 Go 编译。 | 安装包的 `说明/licenses/` 目录随附 Go 和随工具链分发的 `golang.org/x` 组件许可。[Go 许可原文](https://go.dev/LICENSE) |
| ExcelJS 4.4.0 | 本机生成 .xlsx。使用 npm 发行包中的 `dist/exceljs.min.js`，随扩展分发，点击导出 Excel 时加载。 | [ExcelJS 的 MIT 许可](插件/vendor/LICENSE-exceljs.txt) · [浏览器包中各组件的版权与许可声明](插件/vendor/exceljs-bundled-NOTICES.txt) |
| qrcode-generator 1.4.4 | 在本机生成飞书授权二维码。使用 npm 发行包中的 `qrcode.js`。 | [Kazuhiko Arase 的 MIT 许可](插件/vendor/qrcode-LICENSE.txt) |
| Lark/Feishu 官方 CLI、Node SDK | 飞书设备授权、应用配置与权限预填的实现参考。运行扩展无须安装这些工具。 | [CLI 声明](插件/vendor/larksuite-cli-LICENSE.txt) · [Node SDK 声明](插件/vendor/larksuite-node-sdk-LICENSE.txt) |

ExcelJS 浏览器包还包含 JSZip、pako、core-js、Node 浏览器兼容组件等。打包组件的声明保留原文，其中 JSZip 按上游提供的 MIT 选项分发。ExcelJS 和二维码库的上游发行包及源码可在各自项目核对。[ExcelJS 4.4.0](https://registry.npmjs.org/exceljs/4.4.0) · [ExcelJS 源码](https://github.com/exceljs/exceljs/tree/v4.4.0) · [qrcode-generator 1.4.4](https://registry.npmjs.org/qrcode-generator/1.4.4) · [二维码库源码](https://github.com/kazuhikoarase/qrcode-generator)

本版两份随包脚本与上述 npm tarball 内的对应文件已逐字节比对。SHA-256 如下。

| 仓库文件 | SHA-256 |
| --- | --- |
| `插件/vendor/exceljs.min.js` | `7e49da68588e250dbb8bba190d2caa8ab3787cc0284bda1d8b2f805c4df742c9` |
| `插件/vendor/qrcode.js` | `18ae399f81182bc9de916e9c77b195df20cc58d6f2d55a62b085a299f1bf1780` |

设备授权流程与应用权限预填采用飞书官方项目公开的实现方式。[Lark CLI 设备授权](https://github.com/larksuite/cli/blob/main/internal/auth/device_flow.go) · [Lark Node SDK 应用配置](https://github.com/larksuite/node-sdk/tree/main/scene/registration)

抖音、小红书、飞书、Chrome 及相关标识属于各自权利人，项目名称和界面图标用于说明支持的平台。代码许可不授予这些标识的商标使用许可，也不授予导出作品、头像或媒体的转载授权。项目图标融合了两家内容平台的视觉特征。本次开源准备未核验相关品牌图形的单独授权。README 中的截图使用虚构作品与账号。
