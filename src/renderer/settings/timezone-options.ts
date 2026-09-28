// 用户时区白名单（渲染进程入口）：实现已迁至 src/shared/timezone-options.ts
// 供主进程（native 设置窗快照/校验）与渲染进程共享同一份选项。
export * from "../../shared/timezone-options";