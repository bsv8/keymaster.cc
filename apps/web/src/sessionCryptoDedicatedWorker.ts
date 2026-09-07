// AppView Dedicated Worker 入口。
//
// 必须由应用源码直接引用，交给 Vite 编译成真正的 Worker bundle；不能让
// Vite 从 workspace package 内的 new URL("...ts") 复制未编译源码。
import "@keymaster/plugin-vault/session-crypto-worker";
