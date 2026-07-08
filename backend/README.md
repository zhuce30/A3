# A3 智学引擎后端

后端采用 Django + Django REST Framework + MySQL 作为主业务框架，承载登录注册、身份选择、学习画像、学习数据和后续业务接口。知识库与 RAG 逻辑保留在 `domains/knowledge_base`，通过 Django app 和 management command 对外暴露，避免把模型构建逻辑写进路由层。

## 目录结构

```text
backend/
├── apps/
│   ├── accounts/          # 用户、登录注册、会话
│   ├── profiles/          # 学生画像、引导流程信息
│   └── knowledge_base/    # 知识库 API 和管理命令
├── config/                # Django settings、urls、celery
├── core/                  # 路径、运行时、模型缓存配置
├── domains/
│   └── knowledge_base/    # LlamaIndex + FAISS 高内聚领域逻辑
├── scripts/               # 兼容命令行脚本
├── knowledge_base/        # 生成的本地向量库与构建报告
├── manage.py
├── main.py                # 旧 FastAPI 入口，暂保留兼容
└── requirements.txt
```

## 环境准备

```powershell
cd D:\Download\A3
.\backend\.venv\Scripts\Activate.ps1
pip install -r .\backend\requirements.txt
copy .\backend\.env.example .\backend\.env
```

按本机 MySQL 修改 `backend/.env`，默认数据库名为 `a3_learning`。

如果数据库还没创建，可以先在 MySQL 中执行：

```powershell
mysql -u root -p < .\backend\scripts\init_mysql_database.sql
```

前端直连 Django 后端，OpenMAIC 需要配置：

```powershell
NEXT_PUBLIC_A3_API_BASE_URL=http://localhost:8000
```

## Django 数据库

```powershell
python .\backend\manage.py makemigrations accounts profiles
python .\backend\manage.py migrate
python .\backend\manage.py runserver 127.0.0.1:8000
```

主要接口：

```text
POST /api/auth/register/
POST /api/auth/login/
POST /api/auth/token/
POST /api/auth/logout/
GET  /api/auth/me/
GET  /api/profiles/me/
PATCH /api/profiles/me/
POST /api/profiles/learning-profile/
POST /api/profile/extract/
POST /api/profile/update/
POST /api/path/generate/
POST /api/recommend/
POST /api/verify/answer/
POST /api/assess/grade/
GET  /api/demo/status/
POST /api/demo/validate/
POST /api/demo/evaluate/
GET  /api/v1/qa/interact/?q=根轨迹
GET  /api/v1/progress/track/
GET  /api/kb/search/?q=根轨迹&top_k=5
```

## 知识库命令

旧 `.ppt` 需要先转为 `.pptx`：

```powershell
python .\backend\manage.py convert_legacy_presentations --source-root .\data\PPT
```

构建本地知识库：

```powershell
python .\backend\manage.py build_knowledge_base --data-root .\data --limit-files 20
```

查询本地知识库：

```powershell
python .\backend\manage.py query_knowledge_base "什么是根轨迹" --top-k 5
```

## 竞赛演示数据

建议使用后端虚拟环境运行演示命令，确保知识库解析和 BM25 检索依赖一致：

```powershell
.\backend\.venv\Scripts\python.exe .\backend\manage.py seed_demo_data
```

命令会幂等创建：

```text
学生账号：13800000001 / Demo@123456
教师账号：13800000002 / Demo@123456
```

并准备画像、学习路径、测评记录、错题、通知、收藏和知识库演示标记。前端可直接进入 `/a3/demo-flow` 或 `/a3/recommendations` 展示完整闭环。

## 竞赛评测指标

运行内置评测集，输出知识库检索、VerifierAgent 和 SafetyAgent 的可复现指标：

```powershell
.\backend\.venv\Scripts\python.exe .\backend\manage.py evaluate_demo_retrieval --top-k 3
```

也可以输出 JSON 文件，直接用于技术文档或 PPT：

```powershell
.\backend\.venv\Scripts\python.exe .\backend\manage.py evaluate_demo_retrieval --top-k 3 --json --output .\backend\tmp\demo_retrieval_metrics.json
```

当前演示数据集示例结果：

```text
retrievalHitRate: 100.0%
retrievalTop1HitRate: 93.3%
retrievalTop3HitRate: 100.0%
retrievalTop5HitRate: 100.0%
verifiedCoverage: 100.0%
safetyRefusalRate: 100.0%
missingEvidenceRefusalRate: 0.0%
```

## 赛前演示验收

上台前建议运行一次完整验收，自动检查演示账号、画像、学习路径、推荐、验证问答、进度和系统健康：

```powershell
.\backend\.venv\Scripts\python.exe .\backend\manage.py validate_demo_flow
```

如果要给 CI 或脚本使用 JSON 输出：

```powershell
.\backend\.venv\Scripts\python.exe .\backend\manage.py validate_demo_flow --json
```

需要失败时返回非零退出码：

```powershell
.\backend\.venv\Scripts\python.exe .\backend\manage.py validate_demo_flow --strict
```

本地演示环境中，`DEBUG=1` 和开发验证码属于允许项；验收命令会在 `systemHealth.detail.warnings` 中记录它们，但不会阻断演示。正式部署时再关闭 `DJANGO_DEBUG`，并接入真实短信服务或统一认证服务。

## Docker 一键演示

项目根目录提供统一编排，包含 MySQL、Redis、Django 后端、Celery worker 和 OpenMAIC 前端：

```powershell
cd D:\Download\A3
docker compose up --build
```

启动后访问：

```text
前端：http://localhost:3000/a3/demo-flow
后端：http://localhost:8000/api/auth/me/
```

首次启动后端容器会自动执行：

```text
python manage.py migrate --noinput
python manage.py seed_demo_data
```

默认演示账号仍为：

```text
学生账号：13800000001 / Demo@123456
教师账号：13800000002 / Demo@123456
```

## 说明

- 第一阶段向量库仍使用 LlamaIndex + FAISS，默认嵌入模型为 `BAAI/bge-small-zh-v1.5`。
- `/api/auth/token/` 提供 Bearer Token 兼容层；现有 Session 登录仍可继续使用。
- VerifierAgent 返回 `claims` 字段，支持句级引用验证展示。
- SafetyAgent 默认使用本地规则；配置 `A3_SAFETY_LLM_API_KEY` 后会启用可选 LLM 二次安全判断。
- `main.py` 中的 FastAPI 入口暂时保留，便于兼容此前的调试方式；比赛主后端建议以后统一走 Django。
- 大模型、多智能体、个性化路径规划接口可以继续在 Django app 中扩展，底层调用模型服务或 OpenMAIC 编排层。
