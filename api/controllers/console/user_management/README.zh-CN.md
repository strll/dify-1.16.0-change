# 用户管理增量模块

该目录提供批量邀请、工作空间预分配、双向分配查询、失败记录导出和审计能力。模块使用独立表，API 启动时通过 `ext_user_management` 自动执行 `CREATE TABLE IF NOT EXISTS`，不要求手工 migration。

## 超级管理员授权

“超级管理员”是指有权看到并操作自定义“用户管理”页面的账号，不等同于工作空间的 `owner` 或 `admin`。只通过 SQL 直接修改 Dify 数据库中的 `user_management_permissions` 表授权。具体的 PostgreSQL 连接命令、授权、查询和撤销 SQL 见项目根目录 [README.md](../../../../README.md#用户管理超级管理员授权)。只有该表中对应邮箱的 `enabled=true` 才能访问 `/console/api/user-management/*`。

## Excel 格式

批量邀请使用 `邮箱,角色` 两列；工作空间分配使用 `用户邮箱,工作空间名称,工作空间角色` 三列。上传后先调用预览接口，确认后再提交。邮箱重复、格式错误和已存在关系会在结果中返回原因或状态；失败记录可导出为 `failed-imports.xlsx`。

未注册账号会写入预分配表并保持 `pending`。管理员再次访问用户管理页面时，模块会自动检查已注册账号并补写 `tenant_account_joins`。
