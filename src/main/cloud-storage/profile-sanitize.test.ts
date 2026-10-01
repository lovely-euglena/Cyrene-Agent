import { describe, expect, it } from "vitest";
import { sanitizeCloudStorageProfile } from "./profile-sanitize";

describe("sanitizeCloudStorageProfile", () => {
  it("保留白名单字段（含秘密字段）", () => {
    const profile = sanitizeCloudStorageProfile({
      id: "p1",
      name: "  NAS  ",
      protocol: "sftp",
      host: " 192.168.1.10 ",
      port: 22,
      username: "cyrene",
      rootPath: "/data",
      authType: "privateKey",
      privateKeyPath: "C:\\keys\\id_ed25519",
      passphrase: " secret ",
    });
    expect(profile).toMatchObject({
      id: "p1",
      name: "NAS",
      protocol: "sftp",
      host: "192.168.1.10",
      port: 22,
      authType: "privateKey",
      privateKeyPath: "C:\\keys\\id_ed25519",
    });
    // 秘密字段不 trim（口令可能含前后空格）
    expect(profile?.passphrase).toBe(" secret ");
  });

  it("协议不在白名单 / 非对象输入返回 null", () => {
    expect(sanitizeCloudStorageProfile({ protocol: "smb" })).toBeNull();
    expect(sanitizeCloudStorageProfile({})).toBeNull();
    expect(sanitizeCloudStorageProfile(null)).toBeNull();
    expect(sanitizeCloudStorageProfile("sftp")).toBeNull();
  });

  it("未知字段被丢弃，超长文本截断", () => {
    const profile = sanitizeCloudStorageProfile({
      protocol: "s3",
      bucket: "b",
      endpoint: "https://s3.example.com",
      pathStyle: true,
      evil: "rm -rf",
      region: "x".repeat(500),
    });
    expect(profile).not.toHaveProperty("evil");
    expect(String(profile?.region).length).toBe(100);
    expect(profile?.pathStyle).toBe(true);
  });

  it("空秘密视作缺省（更新时保留旧值），端口越界丢弃", () => {
    const profile = sanitizeCloudStorageProfile({
      protocol: "webdav",
      baseUrl: "https://dav.example.com",
      password: "",
      accessKeyId: "",
      port: 70000,
      tlsMode: "bogus",
      authType: "bogus",
      webdavAuthType: "bogus",
    });
    expect(profile?.password).toBeUndefined();
    expect(profile?.accessKeyId).toBeUndefined();
    expect(profile?.port).toBeUndefined();
    expect(profile?.tlsMode).toBeUndefined();
    expect(profile?.authType).toBeUndefined();
    expect(profile?.webdavAuthType).toBeUndefined();
  });
});
