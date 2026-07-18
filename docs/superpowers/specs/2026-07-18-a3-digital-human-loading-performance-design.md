# A3 数字人加载性能优化设计

## 1. 背景与问题

面对面辅导页使用 Three.js、`@pixiv/three-vrm` 和本地 VRM 教师模型。生产模型 `teacher.vrm` 当前为 16,496,824 字节，包含 25 张 PNG 贴图、3 个 mesh、16 个 primitive，以及 `VRMC_vrm`、`VRMC_springBone`、`VRMC_materials_mtoon` 扩展。

当前生产响应为 `Cache-Control: public, max-age=0`、`CF-Cache-Status: DYNAMIC`。用户首次进入需要下载完整模型，后续进入仍会重新校验；模型下载后还要动态加载 Three.js/VRM 代码、解析网格与贴图、创建骨骼和表情、同步预热 30 帧弹簧骨骼。加载期间显示简陋 primitive，用户会误以为数字人损坏。

## 2. 目标

- 将生产 VRM 传输体积控制到 5 MB 以内，目标 3-5 MB。
- 保留 humanoid、表情、口型、MToon 材质、spring bone 和现有 VRMA 动作能力。
- 首次进入先显示可识别的静态教师形象，不能展示方块人。
- VRM 首次显示不等待 VRMA 动作和 spring bone 预热完成。
- 同一版本模型在浏览器中使用一年强缓存，Cloudflare 可缓存 `.vrm` 与 `.vrma`。
- 页面离开再返回时，避免重复下载和不必要的动态模块初始化。
- WebGL 不可用或模型加载失败时，保留明确的静态降级状态。

## 3. 不在本批范围

- 不更换数字人角色设计、服装或面部风格。
- 不引入云端数字人视频流服务。
- 不修改实时辅导 provider、语音识别和大模型回答逻辑。
- 不制作高模/低模两套角色的运行时 LOD 系统。

## 4. 方案选择

采用“单个压缩 VRM + 版本化缓存 + 提前预加载 + 静态占位”的方案。

不采用仅延迟加载，因为它只是把等待从页面打开推迟到点击开始；不采用双模型 LOD，因为当前角色只有一套源资产，会增加制作、动作兼容和回归成本。

## 5. 资产优化

新增可复现的模型优化脚本，输入原始 `teacher.vrm`，输出带内容版本的优化模型。优化包括：

- 将大尺寸颜色贴图转换为 WebP，并按可见质量限制分辨率。
- 法线、遮罩等不适合有损压缩的贴图保留无损编码或使用高质量 WebP。
- 对几何数据启用 meshopt 压缩；不删除蒙皮、morph target、关节和表情所需属性。
- 清理未引用资源，但不删除 VRM 扩展。
- 输出后自动检查 `VRMC_vrm`、`VRMC_springBone`、`VRMC_materials_mtoon` 扩展仍存在。
- 保留未优化源文件作为构建输入和回滚资产，生产页面只引用优化文件。

优化脚本必须输出体积报告，并在超过 5 MB 或缺失 VRM 扩展时失败。

## 6. 加载流程

```text
进入 AI 学习区域或鼠标接近“面对面辅导”入口
-> 预加载数字人动态 chunk
-> 预取版本化 VRM 模型
-> 打开面对面辅导页
-> 立即显示静态教师图
-> 初始化 WebGL
-> 从缓存/网络加载并解析 VRM
-> VRM 就绪后替换静态图并立即显示 rest pose
-> 异步加载 idle/wait/explain/nod 动作
-> 浏览器空闲时分批预热 spring bone
-> 动作就绪后无布局跳动地切换
```

页面只在数字人可见且文档处于前台时运行动画。`devicePixelRatio` 上限按设备能力调整，移动端和低性能设备使用 1-1.5，普通桌面上限 1.5，高性能设备最多 2。

## 7. 缓存策略

模型 URL 使用内容版本，例如：

```text
/a3/assets/teacher-avatar/teacher.optimized.vrm?v=<content-hash>
```

Next/Caddy 对版本化 `.vrm`、`.vrma` 和静态教师 WebP 返回：

```text
Cache-Control: public, max-age=31536000, immutable
```

部署文档增加 Cloudflare Cache Rule：匹配 `/a3/assets/teacher-avatar/*`，允许缓存 `.vrm`、`.vrma`、`.webp`，缓存键包含完整查询参数。发布新模型必须更新内容 hash，不能覆盖同一版本 URL。

## 8. UI 状态

- `loading_chunk`：显示静态教师图和轻量加载指示。
- `loading_model`：静态教师图保持可见，展示“正在准备数字助教”。
- `vrm_ready`：教师模型已显示，动作可继续后台加载。
- `actions_ready`：教师模型与动作全部就绪。
- `static_fallback`：WebGL 或资产失败，继续使用静态教师图并显示可读原因。

所有状态保持固定舞台尺寸，不改变页面布局。primitive 仅保留为开发诊断手段，不再向生产用户展示。

## 9. 可观测性

组件通过 `performance.mark` 记录：chunk 就绪、模型响应完成、VRM 首帧、动作就绪。页面仅在开发环境显示诊断信息；生产可通过浏览器 Performance API 和测试采集，不上传用户隐私数据。

## 10. 验收标准

- 优化模型不超过 5 MB。
- VRM 扩展、表情、口型和四个 VRMA 动作回归通过。
- 生产模型响应包含一年 immutable 缓存头。
- 第二次进入页面不再完整下载 16.5 MB 模型。
- 任何加载阶段都不显示方块人或空白画布。
- 桌面与移动端截图无布局跳动、遮挡和溢出。
- 现有数字人单元测试、TypeScript、lint 和 Playwright 页面测试通过。

## 11. 回滚

保留旧模型和旧版本常量。若优化模型加载、表情或动作回归失败，只需将模型版本常量切回旧 URL；缓存采用版本化地址，不需要清理用户缓存。
