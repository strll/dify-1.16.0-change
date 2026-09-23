# 用户管理增量模块

该目录提供批量邀请、工作空间预分配、双向分配查询、失败记录导出和审计能力。模块使用独立表，API 启动时通过 `ext_user_management` 自动执行 `CREATE TABLE IF NOT EXISTS`，不要求手工 migration。

## 首次授权

进入 API 容器或源码环境执行：

```powershell
flask user-management-permission grant <邮箱>
```

撤销权限：

```powershell
flask user-management-permission revoke <邮箱>
```

只有该表中 `enabled=true` 的邮箱可以调用 `/console/api/user-management/*`。

## Excel 格式

批量邀请使用 `邮箱,角色` 两列；工作空间分配使用 `用户邮箱,工作空间名称,工作空间角色` 三列。上传后先调用预览接口，确认后再提交。邮箱重复、格式错误和已存在关系会在结果中返回原因或状态；失败记录可导出为 `failed-imports.xlsx`。

未注册账号会写入预分配表并保持 `pending`。管理员再次访问用户管理页面时，模块会自动检查已注册账号并补写 `tenant_account_joins`。
