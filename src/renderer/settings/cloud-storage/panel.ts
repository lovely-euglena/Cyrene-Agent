// 云存储设置面板：档案列表 + 添加/编辑表单 + 测试连接。
//
// 连接与凭据都在 cyrene-native --storage-host（DPAPI 加密落盘），本页只做
// 档案 CRUD 与状态展示（cloud-storage:* IPC）；秘密字段只写不读。

import type { CloudStorageProfileView } from "../../../shared/cloud-storage";
import { showConfirm } from "../shared/modal";
import { t } from "../i18n";
import {
  cloudStorageAddButton,
  cloudStorageAllowInvalidCert,
  cloudStorageAuthType,
  cloudStorageCancelButton,
  cloudStorageEditor,
  cloudStorageEditorTitle,
  cloudStorageHost,
  cloudStorageList,
  cloudStorageName,
  cloudStoragePassive,
  cloudStoragePassphrase,
  cloudStoragePassword,
  cloudStoragePort,
  cloudStoragePrivateKey,
  cloudStorageProtocol,
  cloudStorageRoot,
  cloudStorageS3AccessKey,
  cloudStorageS3Bucket,
  cloudStorageS3Endpoint,
  cloudStorageS3PathStyle,
  cloudStorageS3Prefix,
  cloudStorageS3Region,
  cloudStorageS3SecretKey,
  cloudStorageSaveButton,
  cloudStorageStatus,
  cloudStorageTestButton,
  cloudStorageTlsMode,
  cloudStorageUsername,
  cloudStorageWebdavAllowInvalidCert,
  cloudStorageWebdavAuthType,
  cloudStorageWebdavPassword,
  cloudStorageWebdavRoot,
  cloudStorageWebdavUrl,
  cloudStorageWebdavUsername,
} from "./dom";

let editingId: string | null = null;
let profiles: CloudStorageProfileView[] = [];

const GROUP_PROTOCOLS: Record<string, string[]> = {
  host: ["ftp", "ftps", "sftp"],
  "ftp-auth": ["ftp", "ftps"],
  ftps: ["ftps"],
  sftp: ["sftp"],
  webdav: ["webdav"],
  s3: ["s3"],
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function setStatus(message: string, kind: "info" | "ok" | "error" = "info"): void {
  if (!cloudStorageStatus) return;
  cloudStorageStatus.textContent = message;
  cloudStorageStatus.classList.toggle("is-error", kind === "error");
  cloudStorageStatus.classList.toggle("is-ok", kind === "ok");
}

function protocolLabel(protocol: string): string {
  switch (protocol) {
    case "ftp": return "FTP";
    case "ftps": return "FTPS";
    case "sftp": return "SFTP";
    case "webdav": return "WebDAV";
    case "s3": return "S3";
    default: return protocol.toUpperCase();
  }
}

function targetOf(profile: CloudStorageProfileView): string {
  if (profile.protocol === "webdav") return profile.baseUrl ?? "";
  if (profile.protocol === "s3") {
    return `${profile.bucket ?? ""}${profile.endpoint ? ` @ ${profile.endpoint}` : "（AWS）"}`;
  }
  return `${profile.host ?? ""}${profile.port ? `:${profile.port}` : ""}`;
}

function actionButton(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn-secondary";
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function renderList(): void {
  if (!cloudStorageList) return;
  cloudStorageList.innerHTML = "";
  if (profiles.length === 0) {
    const empty = document.createElement("p");
    empty.className = "tts-hint";
    empty.textContent = t("panel.cloudStorage.empty");
    cloudStorageList.appendChild(empty);
    return;
  }

  for (const profile of profiles) {
    const row = document.createElement("div");
    row.className = "setting-row cloud-storage-item";

    const main = document.createElement("div");
    main.className = "cloud-storage-item__main";
    const title = document.createElement("strong");
    title.textContent = profile.name;
    const badge = document.createElement("span");
    badge.className = "cloud-storage-badge";
    badge.textContent = protocolLabel(profile.protocol);
    const target = document.createElement("p");
    target.className = "tts-hint";
    const credential = profile.hasPassword || profile.hasAccessKey
      ? ` · ${t("panel.cloudStorage.credentialSaved")}`
      : "";
    target.textContent = `${targetOf(profile)}${profile.rootPath ? ` · ${profile.rootPath}` : ""}${credential}`;
    main.append(title, badge, target);

    const actions = document.createElement("div");
    actions.className = "cloud-storage-actions";
    actions.append(
      actionButton(t("panel.cloudStorage.test"), () => void testProfile(profile)),
      actionButton(t("panel.cloudStorage.edit"), () => openEditor(profile)),
      actionButton(t("panel.cloudStorage.delete"), () => void deleteProfile(profile)),
    );

    row.append(main, actions);
    cloudStorageList.appendChild(row);
  }
}

function updateGroups(protocol: string): void {
  document.querySelectorAll<HTMLElement>("[data-cs-group]").forEach((group) => {
    const groupName = group.dataset.csGroup ?? "";
    const visible = (GROUP_PROTOCOLS[groupName] ?? []).includes(protocol);
    group.classList.toggle("is-hidden", !visible);
  });
}

function clearEditor(): void {
  const textInputs = [
    cloudStorageName, cloudStorageHost, cloudStoragePort, cloudStorageUsername, cloudStorageRoot,
    cloudStoragePassword, cloudStoragePrivateKey, cloudStoragePassphrase,
    cloudStorageWebdavUrl, cloudStorageWebdavUsername, cloudStorageWebdavPassword, cloudStorageWebdavRoot,
    cloudStorageS3Bucket, cloudStorageS3Endpoint, cloudStorageS3Region, cloudStorageS3AccessKey,
    cloudStorageS3SecretKey, cloudStorageS3Prefix,
  ];
  for (const input of textInputs) {
    if (input) input.value = "";
  }
  // 「留空保持不变」占位符只属于秘密字段，编辑态按需设置；其它 placeholder 保持 HTML/i18n 原文
  for (const secret of [cloudStoragePassword, cloudStoragePassphrase, cloudStorageWebdavPassword, cloudStorageS3AccessKey, cloudStorageS3SecretKey]) {
    if (secret) secret.placeholder = "";
  }
  if (cloudStoragePassive) cloudStoragePassive.checked = true;
  if (cloudStorageAllowInvalidCert) cloudStorageAllowInvalidCert.checked = false;
  if (cloudStorageWebdavAllowInvalidCert) cloudStorageWebdavAllowInvalidCert.checked = false;
  if (cloudStorageS3PathStyle) cloudStorageS3PathStyle.checked = false;
  if (cloudStorageTlsMode) cloudStorageTlsMode.value = "explicit";
  if (cloudStorageAuthType) cloudStorageAuthType.value = "password";
  if (cloudStorageWebdavAuthType) cloudStorageWebdavAuthType.value = "basic";
}

function openEditor(profile?: CloudStorageProfileView): void {
  editingId = profile?.id ?? null;
  clearEditor();
  if (cloudStorageEditorTitle) {
    cloudStorageEditorTitle.textContent = profile
      ? t("panel.cloudStorage.editTitle")
      : t("panel.cloudStorage.addTitle");
  }

  if (profile) {
    const protocol = profile.protocol;
    if (cloudStorageProtocol) cloudStorageProtocol.value = protocol;
    if (cloudStorageName) cloudStorageName.value = profile.name ?? "";
    if (protocol === "ftp" || protocol === "ftps" || protocol === "sftp") {
      if (cloudStorageHost) cloudStorageHost.value = profile.host ?? "";
      if (cloudStoragePort) cloudStoragePort.value = profile.port ? String(profile.port) : "";
      if (cloudStorageUsername) cloudStorageUsername.value = profile.username ?? "";
      if (cloudStorageRoot) cloudStorageRoot.value = profile.rootPath ?? "";
      if (protocol === "sftp") {
        if (cloudStorageAuthType) cloudStorageAuthType.value = profile.authType ?? "password";
        if (cloudStoragePrivateKey) cloudStoragePrivateKey.value = profile.privateKeyPath ?? "";
        if (cloudStoragePassword && profile.hasPassword) {
          cloudStoragePassword.placeholder = t("panel.cloudStorage.keepSecret");
        }
        if (cloudStoragePassphrase && profile.hasPassphrase) {
          cloudStoragePassphrase.placeholder = t("panel.cloudStorage.keepSecret");
        }
      } else {
        if (cloudStoragePassword && profile.hasPassword) {
          cloudStoragePassword.placeholder = t("panel.cloudStorage.keepSecret");
        }
        if (cloudStoragePassive) cloudStoragePassive.checked = profile.passive !== false;
        if (protocol === "ftps") {
          if (cloudStorageTlsMode) cloudStorageTlsMode.value = profile.tlsMode === "implicit" ? "implicit" : "explicit";
          if (cloudStorageAllowInvalidCert) cloudStorageAllowInvalidCert.checked = profile.allowInvalidCert === true;
        }
      }
    } else if (protocol === "webdav") {
      if (cloudStorageWebdavUrl) cloudStorageWebdavUrl.value = profile.baseUrl ?? "";
      if (cloudStorageWebdavUsername) cloudStorageWebdavUsername.value = profile.username ?? "";
      if (cloudStorageWebdavRoot) cloudStorageWebdavRoot.value = profile.rootPath ?? "";
      if (cloudStorageWebdavAuthType) cloudStorageWebdavAuthType.value = profile.webdavAuthType ?? "basic";
      if (cloudStorageWebdavAllowInvalidCert) cloudStorageWebdavAllowInvalidCert.checked = profile.allowInvalidCert === true;
      if (cloudStorageWebdavPassword && profile.hasPassword) {
        cloudStorageWebdavPassword.placeholder = t("panel.cloudStorage.keepSecret");
      }
    } else if (protocol === "s3") {
      if (cloudStorageS3Bucket) cloudStorageS3Bucket.value = profile.bucket ?? "";
      if (cloudStorageS3Endpoint) cloudStorageS3Endpoint.value = profile.endpoint ?? "";
      if (cloudStorageS3Region) cloudStorageS3Region.value = profile.region ?? "";
      if (cloudStorageS3Prefix) cloudStorageS3Prefix.value = profile.rootPath ?? "";
      if (cloudStorageS3PathStyle) cloudStorageS3PathStyle.checked = profile.pathStyle === true;
      if (cloudStorageS3AccessKey && profile.hasAccessKey) {
        cloudStorageS3AccessKey.placeholder = t("panel.cloudStorage.keepSecret");
        cloudStorageS3SecretKey.placeholder = t("panel.cloudStorage.keepSecret");
      }
    }
  }

  updateGroups(cloudStorageProtocol?.value ?? "sftp");
  cloudStorageEditor?.classList.remove("is-hidden");
  setStatus("");
}

function collectDraft(): Record<string, unknown> | null {
  const protocol = cloudStorageProtocol?.value ?? "sftp";
  const draft: Record<string, unknown> = {
    id: editingId ?? undefined,
    name: cloudStorageName?.value.trim() || undefined,
    protocol,
  };
  const put = (key: string, value: string | number | boolean | undefined): void => {
    if (value !== undefined && value !== "") draft[key] = value;
  };
  const portValue = Number(cloudStoragePort?.value);
  const port = Number.isFinite(portValue) && portValue > 0 ? Math.round(portValue) : undefined;

  if (protocol === "ftp" || protocol === "ftps" || protocol === "sftp") {
    put("host", cloudStorageHost?.value.trim());
    put("port", port);
    put("username", cloudStorageUsername?.value.trim());
    put("rootPath", cloudStorageRoot?.value.trim());
    if (protocol === "sftp") {
      put("authType", cloudStorageAuthType?.value);
      put("password", cloudStoragePassword?.value || undefined);
      put("privateKeyPath", cloudStoragePrivateKey?.value.trim());
      put("passphrase", cloudStoragePassphrase?.value || undefined);
    } else {
      put("password", cloudStoragePassword?.value || undefined);
      put("passive", cloudStoragePassive?.checked);
      if (protocol === "ftps") {
        put("tlsMode", cloudStorageTlsMode?.value);
        put("allowInvalidCert", cloudStorageAllowInvalidCert?.checked);
      }
    }
  } else if (protocol === "webdav") {
    put("baseUrl", cloudStorageWebdavUrl?.value.trim());
    put("username", cloudStorageWebdavUsername?.value.trim());
    put("password", cloudStorageWebdavPassword?.value || undefined);
    put("webdavAuthType", cloudStorageWebdavAuthType?.value);
    put("rootPath", cloudStorageWebdavRoot?.value.trim());
    put("allowInvalidCert", cloudStorageWebdavAllowInvalidCert?.checked);
  } else if (protocol === "s3") {
    put("bucket", cloudStorageS3Bucket?.value.trim());
    put("endpoint", cloudStorageS3Endpoint?.value.trim());
    put("region", cloudStorageS3Region?.value.trim());
    put("rootPath", cloudStorageS3Prefix?.value.trim());
    put("pathStyle", cloudStorageS3PathStyle?.checked);
    put("accessKeyId", cloudStorageS3AccessKey?.value || undefined);
    put("secretAccessKey", cloudStorageS3SecretKey?.value || undefined);
  } else {
    return null;
  }
  return draft;
}

async function reload(): Promise<void> {
  try {
    profiles = (await window.settings?.cloudStorageProfiles?.()) ?? [];
    renderList();
  } catch (error) {
    profiles = [];
    renderList();
    setStatus(`${t("panel.cloudStorage.loadFailed")}：${errorMessage(error)}`, "error");
  }
}

async function testById(profileId: string): Promise<void> {
  setStatus(t("panel.cloudStorage.testing"));
  try {
    const result = await window.settings?.cloudStorageTestProfile?.(profileId);
    setStatus(t("panel.cloudStorage.testOk", { latency: result?.latencyMs ?? "?" }), "ok");
  } catch (error) {
    setStatus(`${t("panel.cloudStorage.testFailed")}：${errorMessage(error)}`, "error");
  }
}

async function testProfile(profile: CloudStorageProfileView): Promise<void> {
  await testById(profile.id);
}

async function saveProfile(testAfter: boolean): Promise<void> {
  const draft = collectDraft();
  if (!draft) {
    setStatus(t("panel.cloudStorage.invalidProtocol"), "error");
    return;
  }
  setStatus(t("panel.cloudStorage.saving"));
  try {
    const saved = await window.settings?.cloudStorageSaveProfile?.(draft);
    editingId = saved?.id ?? editingId;
    setStatus(t("panel.cloudStorage.saved"), "ok");
    await reload();
    if (testAfter && editingId) await testById(editingId);
  } catch (error) {
    setStatus(`${t("panel.cloudStorage.saveFailed")}：${errorMessage(error)}`, "error");
  }
}

async function deleteProfile(profile: CloudStorageProfileView): Promise<void> {
  const confirmed = await showConfirm({
    tone: "warning",
    title: t("panel.cloudStorage.delete"),
    message: t("panel.cloudStorage.deleteConfirm", { name: profile.name }),
    confirmText: t("panel.cloudStorage.delete"),
    cancelText: "取消",
    dangerous: true,
  });
  if (!confirmed) return;
  try {
    await window.settings?.cloudStorageRemoveProfile?.(profile.id);
    if (editingId === profile.id) closeEditor();
    await reload();
    setStatus(t("panel.cloudStorage.deleted"), "ok");
  } catch (error) {
    setStatus(`${t("panel.cloudStorage.deleteFailed")}：${errorMessage(error)}`, "error");
  }
}

function closeEditor(): void {
  editingId = null;
  cloudStorageEditor?.classList.add("is-hidden");
  setStatus("");
}

cloudStorageAddButton?.addEventListener("click", () => openEditor());
cloudStorageProtocol?.addEventListener("change", () => updateGroups(cloudStorageProtocol.value));
cloudStorageSaveButton?.addEventListener("click", () => void saveProfile(false));
cloudStorageTestButton?.addEventListener("click", () => void saveProfile(true));
cloudStorageCancelButton?.addEventListener("click", () => closeEditor());

/** 切到云存储 section 时调用。 */
export async function loadCloudStoragePanel(): Promise<void> {
  await reload();
}
