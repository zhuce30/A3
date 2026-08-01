# A3 多导师数字人资产接入设计

日期：2026-08-01

## 1. 背景与目标

A3 当前已经具备导师人格、数字人资产目录、管理员绑定、学生偏好选择和运行时模型回退能力，但四种导师人格默认共用 `teacher.vrm`。本次新增三个由项目作者创建的 VRM 1.0 模型，需要沿用现有架构接入系统，使不同教学风格具有可辨识的导师形象，同时不破坏已有管理员配置和 Agent 接口。

本次目标：

- 将三个新 VRM 注册为真实的 `TutorAvatarAsset` 数据，而不是在前端写死路径。
- 为启发追问、例题实战和基础补强三种导师人格提供不同的默认形象。
- 保留管理员重新绑定、禁用资产和运行时回退能力。
- 只发布运行所需的 `.vrm`，不把 `.vroid` 编辑源文件纳入 Git 和生产镜像。
- 不修改导师 Agent、语音、课堂 handoff 或公开 API 契约。

## 2. 资产定义

| 资产 ID | 展示名称 | 公共路径 | 默认用途 |
|---|---|---|---|
| `teacher-default-v1` | 默认导师 | `/a3/assets/teacher-avatar/teacher.vrm` | 结构讲解、全局回退 |
| `teacher-insight-v1` | 启思导师 | `/a3/assets/teacher-avatar/teacher2.vrm` | 启发追问 |
| `teacher-practice-v1` | 知行导师 | `/a3/assets/teacher-avatar/teacher3.vrm` | 例题实战 |
| `teacher-foundation-v1` | 明理导师 | `/a3/assets/teacher-avatar/teacher4.vrm` | 基础补强 |

三个新模型均为 VRM 1.0，包含 54 个人形骨骼、标准口型和表情预设，可复用现有 VRMA 动画与数字人渲染器。实现时必须记录文件 SHA-256、文件大小、作者、来源、许可范围和模型结构检查结果。

## 3. 数据与绑定策略

新增 Django 数据迁移，以幂等方式创建三个 `TutorAvatarAsset`。资产使用稳定 ID，不以数据库主键或文件名作为业务标识。

迁移按以下规则设置初始绑定：

- `socratic-guide` 绑定 `teacher-insight-v1`。
- `practice-coach` 绑定 `teacher-practice-v1`。
- `foundation-coach` 绑定 `teacher-foundation-v1`。
- `structured-teacher` 保持 `teacher-default-v1`。

为避免覆盖生产环境已有配置，只有同时满足以下条件时才调整人格绑定：

1. 当前仍绑定 `teacher-default-v1`。
2. `updated_by` 为空，表示没有管理员修改证据。

不删除旧资产，不更改默认资产唯一约束。反向迁移只恢复由本迁移仍然持有的新绑定并删除未被其他配置引用的新资产；若资产已经被管理员重新使用，则保留数据，避免破坏外键关系。

## 4. 前后端行为

管理员导师管理接口继续从 `TutorAvatarAsset` 表序列化资产目录。新增资产启用后自动进入现有资产下拉框，无需新增接口或前端静态列表。

学生选择的是导师人格而不是裸模型文件。人格解析结果继续返回：

- `avatarAssetId`
- `avatarPublicPath`
- `voiceProfileId`
- `allowedWorkflows`

面对面辅导、AI 课堂和 OpenMAIC handoff 继续消费同一份人格快照。数字人运行时按资产 ID 和公共路径切换模型；加载失败、资产被禁用、路径不安全或目录读取失败时，回退到 `teacher-default-v1`。

本次不新增模型预加载。每个模型约 16 MB，仍采用动态导入、进入视口后加载和单模型运行时缓存，避免首页或导师选择页同时下载四个模型。

## 5. 授权与仓库策略

- 提交 `teacher2.vrm`、`teacher3.vrm`、`teacher4.vrm`。
- 不提交 `teacher2.vroid`、`teacher3.vroid`、`teacher4.vroid`。
- 更新资产目录 README，记录作者、用途、许可和重新导出流程。
- 发布前运行现有清理流程或等价校验，确保模型元数据不包含本地绝对路径、联系方式、API key 或非必要缩略图数据。
- 当前模型元数据限制为作者使用、个人非营利、禁止再分发和禁止修改；生产用途限定为 A3 项目展示、比赛和项目原型，不在系统中提供模型原文件下载入口。

## 6. 错误处理与兼容性

- 数据迁移使用 `update_or_create` 或等价幂等逻辑，重复部署不会产生重复资产。
- 不安全公共路径不进入管理员接口，也不能成为有效人格绑定。
- 禁用资产不能绑定到已启用人格。
- 当前选择的模型加载失败时，仅回退当前渲染实例，不改写用户偏好或数据库绑定。
- 旧会话中保存的导师快照继续有效；若引用的资产不可用，运行时回退默认模型。
- 不改变现有 API 字段和 Agent 工作流，因此不需要前端环境变量或新的服务器密钥。

## 7. 验证范围

后端验证：

- 数据迁移创建三个资产并生成正确的 SHA-256、文件大小和公共路径。
- 未修改配置获得新的默认绑定。
- 管理员修改过的配置不被迁移覆盖。
- 管理接口序列化四个安全资产。
- 禁用、不安全和缺失资产继续触发现有回退规则。

前端验证：

- 资产路径白名单接受三个新 VRM。
- 人格切换后数字人运行时加载对应资产。
- 同一资产不重复加载，不同资产能够切换。
- 模型请求失败时回退默认模型。
- 管理员下拉框展示四个资产，学生端不暴露文件路径或授权元数据。

基础验证：

```powershell
cd D:\Download\A3\OpenMAIC
npx.cmd tsc --noEmit
pnpm.cmd vitest run tests/a3-digital-human-avatar-assets.test.ts tests/a3-admin-tutors-behavior.test.ts tests/a3-tutor-persona-selector.test.ts

cd D:\Download\A3
backend\.venv\Scripts\python.exe backend\manage.py check
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.learning.tests.test_tutor_persona_operations backend.apps.profiles.tests.test_tutor_preferences backend.apps.system.tests.test_admin_tutors
```

## 8. 完成标准

- 三个新角色出现在管理员导师资产选择中。
- 三个目标人格在没有管理员覆盖时使用各自的新模型。
- 学生选择导师后，辅导和课堂使用相同导师快照。
- 任一新模型加载失败不会导致课堂或辅导页面失效。
- `.vroid` 文件未进入 Git，前后端接口和 Agent 契约保持不变。
