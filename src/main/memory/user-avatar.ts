// 用户头像选择/落盘：Electron 设置页（渲染进程 IPC）与 native 设置窗
// （.NET cmd 事件）共用同一实现——弹系统文件框 → 复制到 userData/avatar.png
// → 写 user-profile.avatarPath。
//
// 调用方负责广播（USER_AVATAR_CHANGED / USER_PROFILE_CHANGED）与 native 快照重推。

import { dialog } from "electron";
import * as fs from "fs";
import * as path from "path";
import { getAvatarPath, saveUserProfile, type UserProfile } from "../settings-store";

export interface PickedAvatar {
  avatarPath: string;
  profile: UserProfile;
}

/**
 * 弹文件框选头像并保存；用户取消返回 null。
 * 复制目标固定为 getAvatarPath()（avatar.png）——与渲染页 getAvatar 读取路径一致。
 */
export async function pickAndSaveUserAvatar(): Promise<PickedAvatar | null> {
  const result = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "bmp"] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;

  const srcPath = result.filePaths[0];
  const avatarPath = getAvatarPath();
  fs.mkdirSync(path.dirname(avatarPath), { recursive: true });
  fs.copyFileSync(srcPath, avatarPath);
  const profile = saveUserProfile({ avatarPath });
  return { avatarPath, profile };
}