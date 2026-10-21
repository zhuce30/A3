# 工程说明

## 实现范围

A3 的业务代码主要位于 `OpenMAIC/app/a3/`、`OpenMAIC/components/a3/` 和 `backend/apps/`。课堂生成与互动能力基于 OpenMAIC；视频制作相关工具保留 OpenMontage 的上游实现与声明。

当前功能包括认证、画像采集、诊断、学习路径、周期计划、今日任务、课程知识库、资源包、课堂辅导、测评、错题复习、报告、教师干预和个人笔记。源码中提供独立接口与验证入口，外部模型能力需要额外配置。

## 前后端职责

Next.js 负责页面、交互与部分服务端桥接；Django 保存业务数据、执行权限检查并提供学习接口。学生进度、资源包、测评结果和教师任务通过后端持久化，前端展示依赖接口返回。

前端请求处理可从 [api-client.ts](../OpenMAIC/lib/a3/api-client.ts) 查看，后端入口位于 [urls.py](../backend/config/urls.py)。

## 检索为什么保留多条路径

课程问题既包含明确术语，也包含语义表达和概念关系。向量检索用于语义召回，BM25 用于术语匹配，Wiki 与图谱提供结构化证据。查询路由根据问题与可用索引选择路径，缺少语义模型或索引时保留降级结果与原因。

检索片段需要携带资料标识和位置，便于将回答与原文对照。入口见 [deep_retrieval.py](../backend/apps/knowledge_base/deep_retrieval.py) 与 [retriever.py](../backend/domains/knowledge_base/retriever.py)。

## 验证器的能力边界

[verification.py](../backend/apps/compat/verification.py) 返回引用、陈述检查结果和安全状态。现有基础规则使用词语重合判断支持关系，因此可能漏判否定、数值与因果矛盾，也不能据此宣称问答准确率。

后续改进需要用标注样例区分“支持”“矛盾”和“证据不足”，并单独统计错误答案被判为已验证的比例。没有实测数据时，不报告准确率或学习效果提升。

## 为什么资源生成使用后台任务

课堂、资源包、视频和导出可能需要较长时间，外部服务也可能超时。项目将这些操作记录为任务与产物，页面可以查询进度和结果；失败或降级保留状态，便于重新处理和定位原因。

PPTX 由 OpenMAIC 课堂前端完成导出，再将结果写回 A3。Django 负责记录与访问控制，不替代课堂导出逻辑。接口边界见 [OpenMAIC 接入说明](A3_OpenMAIC页面分工与接入边界.md)。

## 课程知识与个人记忆的边界

课程 RAG 与个人笔记记忆分开处理。个人笔记记忆需要经过确认，并校验所有者、生效状态、暂停、过期和删除状态；课堂与面对面辅导不读取该记忆。

## 如何检查改动

前端使用 TypeScript、ESLint、Vitest 和 Playwright；后端使用 Django checks、测试与 management commands。基础演示流程通过 `validate_demo_flow` 检查，检索与安全规则通过 `evaluate_demo_retrieval` 输出结果。

具体命令见 [README](../README.md#验证与评测)。涉及学习流程的修改，应同时核对页面行为、接口返回和数据回流；只有截图变化不足以证明功能完成。
