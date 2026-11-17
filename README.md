# 行为特征分析与事件溯源平台

面向用户行为打点采集、事件参数规范、会话重放、热力图分析、特征工程提取与行为标签体系管理的本地化数据分析应用平台。

这是一个**纯前端**管理平台：Vue 3 + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 Vue 3 + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   ├── src/stores/           会话与筛选状态
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建：

```bash
cd frontend
npm run build
```

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 事件规范 | `eventspec` | 事件定义 | 事件编号、事件名称、事件类别 |
| 会话重放 | `session` | 会话记录 | 会话编号、用户标识、开始时间 |
| 热力分析 | `heatmap` | 热力方案 | 方案编号、目标页面、点击热力图 |
| 特征工程 | `feature` | 特征模板 | 模板编号、特征名称、特征类型 |
| 行动标签 | `action` | 标签规则 | 规则编号、标签名称、标签类别 |
| 路径分析 | `pathmap` | 路径模型 | 模型编号、起始页面、终止页面 |
| 事件溯源 | `eventtrace` | 事件链路 | 链路编号、事件链序列、链长度 |
| 时段分析 | `timewindow` | 时段配置 | 配置编号、时段名称、起始时分 |
| 设备分析 | `device` | 设备画像 | 画像编号、设备类型、操作系统 |
| 异常检测 | `anomaly` | 检测器 | 检测器编号、监控事件、异常模式 |
| 群组对比 | `cohortcmp` | 对比任务 | 任务编号、群组A、群组B |
| 漏斗诊断 | `funnel` | 诊断报告 | 报告编号、漏斗名称、步骤定义 |
| 浏览深度 | `scrollmap` | 深度分析 | 分析编号、页面名称、首屏占比 |
| 表单分析 | `formfield` | 表单诊断 | 诊断编号、表单名称、总字段数 |
| 点击流 | `clickstream` | 点击序列 | 序列编号、用户标识、起始时间 |
| 回访分析 | `retention` | 回访模式 | 模式编号、用户分群、首次访问窗口 |
| 数据视图 | `dataview` | 分析视图 | 视图编号、视图名称、数据源组合 |
| 参数字典 | `paramdef` | 参数定义 | 参数编号、参数名称、参数类型 |

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 想回到初始数据：清掉浏览器里 `behavior-event-trace-hub:entries` 这一项，或调用 `resetModule(模块)`。

## 页面热力浏览联合数据报告（heat-scroll 联合域）

热力分析（热力方案）与浏览深度（深度分析）合并出的增量联合报告，独立成域放在
`frontend/src/domain/heat-scroll/`，页面入口为侧边栏「页面热力浏览联合报告」（路由 `/heat-scroll`）。

- `types.ts`：联合报告领域模型。深度分段统一为 `number | null`，`null` 表示**未知/缺采**，
  数字 `0` 是**实测零值**；关键内容曝光率带 `measured | unknown` 标记，两者严格区分。
- `merge.ts`：纯函数合并。按原始输入的字段存在性判断——字段缺省复用旧版本值，
  显式 `null` 覆盖为未知，数字（含 0）采用实测值，任何路径都不会把未知补成 0。
- `service.ts`：增量重算、凭据并发锁、版本冲突仲裁（未知覆盖保留 / 缺失段延后发布）、
  归档与暂存、分段移除/补回。每个页面同一时刻只有一份现行报告，历史版本整份归档并保留未知标记。
- `store.ts` / `seed.ts`：独立 localStorage key（`behavior-event-trace-hub:heat-scroll-joint`）
  的持久化与结构化源数据。
- 调用链：`local-service.runAction` 在 `heatmap` / `scrollmap` 动作后经 `notifyJointDomain`
  触发联合域增量重算；落在浏览深度的更新只改受影响页面的深度曲线，热力方案沿用原版本。
- 验证：`make -C verify verify`，覆盖未知/零值区分、单次覆盖、并发拒绝凭据、跨模块局部更新、
  两种仲裁策略与「移除二屏→未知→补回仅该设备变化」共 18 项断言。

领域：数据工程
子方向：数据分析与数据应用
