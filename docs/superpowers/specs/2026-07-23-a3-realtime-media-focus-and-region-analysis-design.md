# A3 实时辅导媒体聚焦与区域分析设计

## 1. 背景

`/a3/coaching` 已具备数字人主舞台、摄像头预览、屏幕共享预览、单帧截图分析和实时辅导接口。当前问题不是缺少一套新页面，而是现有右上角预览框过小，学生难以确认作业、课件或屏幕内容是否清晰，也无法精确指定需要 AI 分析的区域。

本设计只增强现有实时辅导舞台：点击摄像头或屏幕预览后平滑覆盖主舞台，在聚焦画面中选择目标框或手动画框，再复用现有视觉帧分析链路。页面标题、右侧资料栏、底部通话控制条和实时 Agent 接口保持不变。

相关基线：

- `docs/A3_实时视频通话式面对面辅导设计方案.md`
- `docs/superpowers/specs/2026-07-18-a3-digital-human-loading-performance-design.md`
- `OpenMAIC/components/a3/features/coaching/realtime-coaching-call.tsx`
- `OpenMAIC/components/a3/features/coaching/use-realtime-coaching.ts`
- `OpenMAIC/app/api/a3/coaching/realtime/frame/route.ts`

Figma 局部交互参考：

- <https://www.figma.com/design/iu4BQaDG8KTKbLdT7iZCW1?node-id=2-2>

## 2. 目标

1. 在不重做页面的前提下，让摄像头和屏幕共享预览可以点击聚焦到现有主舞台。
2. 聚焦和返回过程流畅，不重新申请媒体权限，不重建 `MediaStream`，不重新加载 VRM。
3. 数字人不移动、不缩放、不卸载，避免 WebGL Canvas 改变尺寸导致 `renderer.setSize`、相机投影重算和明显卡顿。
4. 聚焦画面支持浏览器端低频目标检测、点击检测框锁定和手动画框修正。
5. 只在用户明确点击分析时上传一张裁剪帧，不持续上传摄像头或屏幕视频。
6. 复用现有 `/api/a3/coaching/realtime/frame` 和视觉 Agent 链路，保持旧的整帧截图请求兼容。
7. 检测能力不可用时，仍能通过手动画框或整帧截图完成辅导。

## 3. 非目标

- 不重新设计 `/a3/coaching` 的整体布局。
- 不把数字人移到右上角，也不创建第二个数字人 Canvas。
- 不在 8G VPS 上持续运行 YOLO 或处理实时视频流。
- 不做持续人脸识别、身份识别、情绪判断或学生行为评分。
- 不自动上传连续视频、音频或未经用户确认的画面。
- 不修改实时语音 provider、知识库检索、VerifierAgent 或 SafetyAgent 的主契约。
- 不把通用 COCO 类别中的 `book` 直接宣称为“作业”，没有可靠证据时只能标记为“可能的文档区域”。

## 4. 核心方案

### 4.1 舞台分层

现有视频表面保持单一定位容器，内部按层组织：

```text
Layer 0  数字人主舞台
Layer 1  摄像头与屏幕共享媒体层
Layer 2  目标框、手动画框和选中态
Layer 3  状态标签、返回、全屏和分析命令
Layer 4  现有底部通话控制条
```

数字人始终挂载在 Layer 0，尺寸和父容器不变。媒体层在默认状态位于右上角预览槽；进入聚焦后，同一个媒体节点通过 FLIP/shared-element 过渡覆盖主舞台。媒体退出后回到原槽位。

不通过模态框或新路由放大，不让页面网格、右侧栏和底部控制条参与重排。

### 4.2 持久媒体节点

摄像头和屏幕共享各保留一个持久 `<video>` 节点：

- `srcObject` 只在媒体流开始、停止或 track 替换时更新。
- 聚焦切换只改变包裹媒体节点的视觉状态，不卸载 `<video>`。
- `cameraVideoRef` 和 `screenVideoRef` 始终指向同一节点。
- 切换过程中不调用 `getUserMedia`、`getDisplayMedia` 或 `play()` 重建流程。
- 关闭媒体时，如果该媒体正在聚焦，先退出聚焦，再停止 track。

### 4.3 动画策略

项目已经包含 `motion/react`。媒体包裹层使用持久节点的 layout/FLIP 动画，数字人不参与 shared-element 动画。

动效参数：

```text
duration: 240-280 ms
ease: cubic-bezier(0.22, 1, 0.36, 1)
animated properties: transform, opacity, border-radius, shadow
avoid per-frame animation: width, height, top, left
```

状态改变可以触发一次布局计算，但逐帧过渡由 transform 完成。标签、按钮和检测框不随视频内容缩放，动画期间由独立覆盖层淡入淡出。

`prefers-reduced-motion: reduce` 时取消位移动画，仅使用短时淡入淡出。

### 4.4 数字人性能策略

现有 Three.js 舞台通过 `requestAnimationFrame` 渲染，并在尺寸变化时调用 `renderer.setSize` 和更新相机。为避免聚焦切换造成卡顿：

1. 数字人根容器和 Canvas 的实际尺寸始终不变。
2. 媒体进入聚焦时，数字人仍留在原位，由媒体层覆盖。
3. 媒体动画完成且完全遮挡数字人后，可以暂停数字人的 RAF 渲染，但不销毁 renderer、scene、VRM、mixer、贴图或动作。
4. 返回前先恢复数字人 RAF，等待至少一帧，再执行媒体退出动画。
5. 如果暂停能力实现风险高，第一版允许数字人在底层继续渲染；不得为了节省渲染而卸载组件。

这一策略把“首次加载”和“舞台切换”分离，切换不会重复下载或解析模型。

## 5. 交互状态

### 5.1 媒体聚焦状态

```ts
type RealtimeFocusedMedia = 'camera' | 'screen' | null;
```

| 状态 | 主舞台 | 右上角预览 | 行为 |
|---|---|---|---|
| `null` | 数字人 | 摄像头、屏幕 | 点击有效媒体进入聚焦 |
| `camera` | 摄像头覆盖数字人 | 屏幕保留缩略图 | 再点摄像头或按 Escape 返回 |
| `screen` | 屏幕覆盖数字人 | 摄像头保留缩略图 | 再点屏幕或按 Escape 返回 |

未启用的媒体预览保持现有“未开启”状态，不响应聚焦。

### 5.2 输入方式

- 单击预览：进入或退出聚焦。
- 键盘 Enter/Space：与单击等价。
- Escape：退出聚焦或取消当前框选。
- 双击媒体或点击全屏图标：调用浏览器 Fullscreen API。
- 全屏退出：保留当前聚焦源和框选，不停止媒体流。
- 切换摄像头与屏幕：当前选区清空，检测器切换输入源。

预览按钮使用 `aria-pressed` 表达聚焦状态，提供明确的 `aria-label`。焦点返回触发操作的预览按钮。

## 6. 区域选择

### 6.1 选区数据

选区统一保存为相对原始视频帧的归一化坐标：

```ts
type A3NormalizedRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
  label?: string;
  confidence?: number;
  method: 'object_detection' | 'document_proposal' | 'manual' | 'full_frame';
};
```

`x/y/width/height` 范围为 `0..1`。坐标必须以原始 `videoWidth/videoHeight` 为基准，不能直接保存 DOM 像素。

### 6.2 显示坐标映射

摄像头聚焦可使用 `object-cover`，屏幕共享应使用 `object-contain`，保证课件文字不被裁掉。坐标工具必须处理：

- `object-cover` 的左右或上下裁切。
- `object-contain` 的黑边和无效点击区域。
- DOM 尺寸与 `videoWidth/videoHeight` 不一致。
- 高 DPR 显示。
- 选区越界、最小尺寸和反向拖拽。
- 未来摄像头镜像显示与原始帧非镜像裁剪的转换。

检测框、手动画框和最终 Canvas 裁剪必须复用同一套坐标转换函数。

### 6.3 点击锁定

检测器返回多个候选框时：

1. 默认只绘制置信度超过阈值的前几个框，避免画面杂乱。
2. 指针悬停时突出当前框。
3. 点击框后进入 locked 状态，框停止随后续检测结果漂移。
4. 只保留一个主选区；再次点击其他框会替换。
5. 选中后显示简短标签和“分析选中区域”命令。
6. 用户可以拖动边缘调整，调整后 `method` 变为 `manual`。

### 6.4 手动画框

手动画框是正式能力，不是错误兜底：

- 用户开启框选工具后，在聚焦画面拖拽形成矩形。
- 小于最小面积的误触不产生选区。
- 可移动、缩放或清除选区。
- 选区不能覆盖底部控制条和媒体以外区域。
- 检测器未加载、低性能设备或屏幕内容无法识别时仍可用。

## 7. 浏览器端检测

### 7.1 运行位置

检测只在浏览器执行，服务器不接收连续帧。目标检测在独立经典 Web Worker 中运行，主线程把缩放后的 `ImageBitmap` 作为 transferable 传入，只接收归一化检测结果。文档四边形候选由 OpenCV.js 低频执行，失败时不影响目标检测和手动画框。

推理策略：

- 只有聚焦媒体且用户开启“识别目标”时加载模型。
- 默认 3 FPS，上限 5 FPS；上一帧未完成时丢弃新帧，不排队。
- 输入缩放到 320 或 416 像素级，不使用原始 1080p/4K 帧推理。
- MediaPipe 优先尝试 GPU delegate，失败后回退 CPU/WASM；两者均不可用时禁用自动检测。
- 页面隐藏、媒体暂停、退出聚焦或选区锁定后停止推理。
- 模型、WASM 和权重按需加载并使用版本化缓存，不进入首屏 JavaScript。

### 7.2 检测边界

第一版自动检测关注教学场景中可解释的通用类别：

- `person`
- `book`
- `laptop`
- `cell phone`
- `monitor/tv`
- 可验证的文档矩形候选

通用目标模型不能可靠识别“这是一份作业”。文档区域只能显示为“可能的文档区域”，最终由学生点击确认。屏幕共享优先提出内容区或文档矩形，不在屏幕画面中运行人脸检测。

实现采用可替换的 `DetectorAdapter`，首个运行时为 `@mediapipe/tasks-vision@0.10.35` 的 EfficientDet-Lite0 INT8，目标类别限制为 `person/book/laptop/cell phone/tv`。模型来自 MediaPipe 官方静态资源，大小 4,602,795 字节，SHA-256 为 `0720bf247bd76e6594ea28fa9c6f7c5242be774818997dbbeffc4da460c723bb`。`@mediapipe/tasks-vision` 与 `@techstark/opencv-js` 均为 Apache-2.0；模型二进制由构建准备脚本下载并校验，不直接写入 Git。

Next/Turbopack 不直接编译 TypeScript Worker，因此 `prepare:a3-browser-vision` 使用 esbuild 生成固定同源路径的经典 IIFE Worker。经典 Worker 是必要约束：当前 MediaPipe WASM loader 依赖 `importScripts` 注册全局 `ModuleFactory`。模型、Worker、WASM 与 OpenCV.js 都使用版本化同源 URL，并在用户点击“识别目标”前保持未加载。

## 8. 截图与接口

### 8.1 客户端裁剪

用户点击分析后：

```text
选定 camera/screen
-> 读取对应持久 video 节点
-> 把归一化选区映射到原始视频帧
-> Canvas 只绘制该区域
-> 限制最长边和 JPEG 质量
-> POST 现有 frame API
```

没有选区时保留整帧行为。屏幕和摄像头不再由“屏幕优先”隐式决定，调用方必须传入当前聚焦源或明确的源。

### 8.2 向后兼容请求

现有字段继续有效：

```json
{
  "coachingSessionId": "...",
  "imageDataUrl": "data:image/jpeg;base64,...",
  "source": "screen",
  "prompt": "请分析选中区域",
  "fast": true
}
```

新增可选字段：

```json
{
  "region": {
    "x": 0.18,
    "y": 0.24,
    "width": 0.56,
    "height": 0.38,
    "label": "可能的文档区域",
    "confidence": 0.86,
    "method": "document_proposal"
  }
}
```

Next route 验证字段范围、字符串长度和枚举值，并把选区元数据写入现有 `visualEvidence`。真正发送给视觉模型的是客户端裁剪后的图片。Django coaching session 接口、Agent 调度和响应字段不变。

## 9. 隐私与安全

- 默认不开启持续检测。
- 自动检测帧只在浏览器内存中存在，不写入 IndexedDB 或本地文件。
- 只有用户点击“分析选中区域”或“分析整帧”时才上传单帧。
- UI 明确区分“本地识别框”和“已发送给 AI 分析”。
- 不根据人脸推断身份、年龄、情绪、注意力或考试行为。
- 检测模型地址必须同源或来自明确允许的静态资源域，不允许任意远程模型 URL。
- 不在日志中记录图像 data URL、Canvas 内容或本地媒体设备标识。

## 10. 错误与降级

| 场景 | 用户结果 |
|---|---|
| 媒体未开启 | 预览保持未开启，不进入聚焦 |
| 视频 metadata 未就绪 | 显示“画面正在准备”，不发送空帧 |
| Fullscreen API 不可用 | 保留主舞台聚焦，不影响分析 |
| Worker/模型加载失败 | 显示自动识别不可用，手动画框仍可用 |
| WebGPU 不可用 | 尝试 WASM；仍失败则手动画框 |
| 检测超时 | 丢弃该帧，不累积任务，不影响通话 |
| 选区映射无效 | 阻止上传并要求重新框选 |
| frame API 超时 | 保留选区，允许只重试分析 |
| 屏幕共享停止 | 自动退出屏幕聚焦并清除其选区 |

## 11. 可观测性

仅记录不含图像内容的浏览器性能指标：

- 聚焦动画开始、结束和取消。
- 动画持续时间与 reduced-motion 状态。
- 检测模型加载时长、后端类型和失败原因。
- 推理耗时的滚动中位数，不记录检测图片。
- 选区来源 `manual/object_detection/document_proposal/full_frame`。
- frame 请求耗时沿用现有视觉分析状态。

生产界面不展示开发性能面板，测试可以通过 Performance API 读取标记。

## 12. 验收标准

### 12.1 交互

- 点击已开启的摄像头或屏幕缩略窗后，媒体在 240-280ms 内覆盖主舞台。
- 再次点击、Escape 和返回按钮均可恢复原布局。
- 聚焦切换不重新申请权限，不停止或重建 MediaStream。
- 数字人 Canvas DOM 节点在进入和退出聚焦后保持同一实例。
- 桌面和移动端不出现控制条遮挡、右侧栏重排或文字溢出。

### 12.2 性能

- 聚焦切换不改变数字人 Canvas 的 `clientWidth/clientHeight`。
- 聚焦过程中不重新请求 VRM、VRMA 或贴图。
- 自动检测关闭时不加载检测模型。
- 检测开启时主线程保持可交互，Worker 不堆积帧。
- 退出聚焦、锁定选区和页面隐藏后推理停止。

### 12.3 分析

- 摄像头和屏幕可以明确指定分析来源。
- 选区映射、裁剪和显示使用同一归一化坐标。
- 点击检测框和手动画框都能生成有效裁剪帧。
- 没有选区时旧的整帧分析继续工作。
- frame route 正确验证并持久化可选区域元数据。
- 自动检测不可用时，手动画框和整帧分析仍可完成。

## 13. 发布顺序

1. 先发布媒体聚焦、返回、全屏和持久视频节点，不启用自动检测。
2. 发布手动画框和区域裁剪，验证现有 Agent 链路不变。
3. 完成浏览器检测模型的许可证、体积和性能验收后，再开放“识别目标”。
4. 生产回归稳定后，才考虑默认提示检测能力；默认仍不持续运行。

## 14. 回滚

- 媒体聚焦可以独立回滚为现有右上角静态预览，不影响通话和截图分析。
- 区域字段是可选字段，移除前端框选后旧 frame 请求仍有效。
- 检测器通过 adapter 隔离，可停止加载模型而保留手动画框。
- 数字人暂停优化出现恢复异常时，关闭暂停能力，让数字人在被覆盖期间继续渲染，不卸载组件。
